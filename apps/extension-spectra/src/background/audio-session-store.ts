// goal: persist acknowledged per-document audio snapshots across service-worker restarts

import {
	DEFAULT_AUDIO_CONFIG,
	isAudioSessionSnapshot,
	resolveAudioVolume,
	SPECTRA_PROTOCOL_VERSION,
	type AudioConfig,
	type AudioSessionPhase,
	type AudioSessionSnapshot,
	type SpectraAudioMode,
	type SpectraEventEnvelope,
	type TabSessionIdentity,
} from '@nexus/contracts';
import { createKeyedSerializedQueue } from '@nexus/kernel';
import { shouldAcceptAudioSessionPhase } from '../shared/audio-session-phase';
import { swLog } from '../shared/logger';

const KEY_PREFIX = 'spectra_audio_session_';
const STORAGE_WRITE_DEBOUNCE_MS = 250;
const MAX_WRITE_RETRIES = 5;
const snapshots = new Map<number, AudioSessionSnapshot>();
const serialized = createKeyedSerializedQueue<number>();
const invalidatedDocuments = new Map<number, Set<string>>();
const pendingWrites = new Map<number, AudioSessionSnapshot>();
const writeTimers = new Map<number, ReturnType<typeof setTimeout>>();
const retryCounts = new Map<number, number>();

export class StaleAudioSessionError extends Error {
	constructor() {
		super('Audio session update belongs to an invalidated document');
		this.name = 'StaleAudioSessionError';
	}
}

function key(tabId: number): string {
	return `${KEY_PREFIX}${tabId}`;
}

export function identityFromSender(sender: chrome.runtime.MessageSender): TabSessionIdentity | null {
	const tabId = sender.tab?.id;
	const sourceUrl = sender.url ?? sender.tab?.url;
	if (!tabId || !sourceUrl) return null;
	try {
		const origin = new URL(sourceUrl).origin;
		if (origin === 'null') return null;
		if (sender.url && sender.tab?.url) {
			const currentOrigin = new URL(sender.tab.url).origin;
			if (currentOrigin !== 'null' && currentOrigin !== origin) return null;
		}
		return { tabId, documentId: sender.documentId ?? `legacy:${origin}`, origin };
	} catch {
		return null;
	}
}

function clearWriteTimer(tabId: number): void {
	const timer = writeTimers.get(tabId);
	if (timer !== undefined) clearTimeout(timer);
	writeTimers.delete(tabId);
}

function scheduleWrite(tabId: number, snapshot: AudioSessionSnapshot, delay = STORAGE_WRITE_DEBOUNCE_MS): void {
	pendingWrites.set(tabId, snapshot);
	clearWriteTimer(tabId);
	writeTimers.set(tabId, setTimeout(() => {
		writeTimers.delete(tabId);
		void flushAudioSessions(tabId).catch(() => undefined);
	}, delay));
}

async function flushAudioSessionInternal(tabId: number): Promise<void> {
	clearWriteTimer(tabId);
	const pending = pendingWrites.get(tabId);
	if (!pending) {
		retryCounts.delete(tabId);
		return;
	}
	try {
		await chrome.storage.session.set({ [key(tabId)]: pending });
		if (pendingWrites.get(tabId) === pending) pendingWrites.delete(tabId);
		retryCounts.delete(tabId);
	} catch (error) {
		const retries = (retryCounts.get(tabId) ?? 0) + 1;
		if (retries > MAX_WRITE_RETRIES) {
			swLog.warn(
				`[AudioSession] Storage write failed after ${MAX_WRITE_RETRIES} retries, dropping snapshot for tab ${tabId}`,
				error,
			);
			pendingWrites.delete(tabId);
			retryCounts.delete(tabId);
			return;
		}
		retryCounts.set(tabId, retries);
		const backoffDelay = STORAGE_WRITE_DEBOUNCE_MS * 2 ** (retries - 1);
		scheduleWrite(tabId, pending, backoffDelay);
		throw error;
	}
}

function invalidateDocument(tabId: number, documentId: string): void {
	let invalidated = invalidatedDocuments.get(tabId);
	if (!invalidated) {
		invalidated = new Set();
		invalidatedDocuments.set(tabId, invalidated);
	}
	invalidated.add(documentId);
}

function normalizeMode(value: unknown, fallback: SpectraAudioMode): SpectraAudioMode {
	if (value === 'capture' || value === 'CAPTURE') return 'capture';
	if (value === 'webaudio' || value === 'NATIVE_WEBAUDIO') return 'webaudio';
	if (value === 'bypass' || value === 'NATIVE_LITE' || value === 'DISABLED') return 'bypass';
	return fallback;
}

function normalizePhase(value: unknown, mode: SpectraAudioMode): AudioSessionPhase {
	if (value === 'idle' || value === 'starting' || value === 'active'
		|| value === 'stopping' || value === 'error') return value;
	return mode === 'bypass' ? 'idle' : 'active';
}

function normalizeConfig(value: Partial<AudioConfig> | undefined): AudioConfig {
	const config: AudioConfig = {
		...DEFAULT_AUDIO_CONFIG,
		...value,
		eqValues: Array.isArray(value?.eqValues)
			? value.eqValues.slice(0, 10).map((item) => Math.max(-12, Math.min(12, item)))
			: [...DEFAULT_AUDIO_CONFIG.eqValues],
		delay: Math.max(0, Math.min(500, value?.delay ?? DEFAULT_AUDIO_CONFIG.delay)),
	};
	const legacyEffectiveOnly = value?.volume !== undefined
		&& value.volumeBase === undefined
		&& value.boost === undefined;
	const volume = legacyEffectiveOnly
		? resolveAudioVolume({ volume: Number(value?.volume) })
		: resolveAudioVolume(config);
	return {
		...config,
		volume: volume.effectiveVolume,
		volumeBase: volume.volumeBase,
		boost: volume.boost,
	};
}

async function broadcast(snapshot: AudioSessionSnapshot): Promise<void> {
	const event: SpectraEventEnvelope<'spectra.audio.session.changed'> = {
		protocolVersion: SPECTRA_PROTOCOL_VERSION,
		type: 'spectra.audio.session.changed',
		tabId: snapshot.tabId,
		documentId: snapshot.documentId,
		generation: snapshot.generation,
		payload: snapshot,
	};
	await chrome.runtime.sendMessage(event).catch(() => undefined);
}

export async function updateAudioSession(
	identity: TabSessionIdentity,
	update: {
		config?: Partial<AudioConfig>;
		desiredMode?: unknown;
		actualMode?: unknown;
		phase?: unknown;
		generation?: number;
		error?: string | null;
	},
): Promise<AudioSessionSnapshot> {
	return serialized(identity.tabId, async () => {
		if (invalidatedDocuments.get(identity.tabId)?.has(identity.documentId)) {
			throw new StaleAudioSessionError();
		}
		const previous = await readAudioSession(identity.tabId);
		const sameDocument = previous?.documentId === identity.documentId && previous.origin === identity.origin;
		if (previous && !sameDocument) invalidateDocument(identity.tabId, previous.documentId);
		const base = sameDocument ? previous : null;
		if (base && update.generation !== undefined && update.generation < base.generation) {
			return base;
		}
		const actualMode = normalizeMode(update.actualMode, base?.actualMode ?? 'bypass');
		const desiredMode = normalizeMode(update.desiredMode, base?.desiredMode ?? actualMode);
		const phase = normalizePhase(update.phase, actualMode);
		if (base && !shouldAcceptAudioSessionPhase(
			base.generation,
			base.phase,
			update.generation ?? base.generation,
			phase,
		)) {
			return base;
		}
		// A UI intent may be broadcast while a processor is starting/stopping. Keep
		// the last acknowledged config until the owner reports a stable/error phase;
		// otherwise AudioSessionSnapshot would relabel desired values as actual.
		const configUpdate = phase === 'starting' || phase === 'stopping'
			? base?.actualConfig ?? DEFAULT_AUDIO_CONFIG
			: update.config ?? base?.actualConfig;
		const actualConfig = normalizeConfig(configUpdate);
		const previousHash = base ? JSON.stringify(base.actualConfig) : '';
		const nextHash = JSON.stringify(actualConfig);
		const snapshot: AudioSessionSnapshot = {
			...identity,
			generation: Math.max(base?.generation ?? 0, update.generation ?? 0),
			desiredMode,
			actualMode,
			phase,
			configRevision: (base?.configRevision ?? 0) + (previousHash === nextHash ? 0 : 1),
			actualConfig,
			lastError: update.error === undefined
				? (base?.lastError ?? null)
				: update.error
					? { code: 'runtime_error', message: update.error, retryable: true }
					: null,
		};
		snapshots.set(identity.tabId, snapshot);
		scheduleWrite(identity.tabId, snapshot);
		await broadcast(snapshot);
		return snapshot;
	});
}

export async function getAudioSession(tabId: number): Promise<AudioSessionSnapshot | null> {
	return serialized(tabId, () => readAudioSession(tabId));
}

async function readAudioSession(tabId: number): Promise<AudioSessionSnapshot | null> {
	const cached = snapshots.get(tabId);
	if (cached) return cached;
	const result = await chrome.storage.session.get(key(tabId));
	const stored = result[key(tabId)] as unknown;
	if (!isAudioSessionSnapshot(stored)) return null;
	const normalized = { ...stored, actualConfig: normalizeConfig(stored.actualConfig) };
	snapshots.set(tabId, normalized);
	return normalized;
}

export async function removeAudioSession(tabId: number): Promise<void> {
	await serialized(tabId, async () => {
		const previous = await readAudioSession(tabId);
		if (previous) invalidateDocument(tabId, previous.documentId);
		snapshots.delete(tabId);
		clearWriteTimer(tabId);
		pendingWrites.delete(tabId);
		retryCounts.delete(tabId);
		await chrome.storage.session.remove(key(tabId));
	});
}

export function isAudioSessionIdentityInvalidated(identity: TabSessionIdentity): boolean {
	return invalidatedDocuments.get(identity.tabId)?.has(identity.documentId) === true;
}

// post: tab teardown releases the invalidation history as no document from that tab can reply again
export async function forgetAudioSession(tabId: number): Promise<void> {
	await serialized(tabId, async () => {
		snapshots.delete(tabId);
		invalidatedDocuments.delete(tabId);
		clearWriteTimer(tabId);
		pendingWrites.delete(tabId);
		retryCounts.delete(tabId);
		await chrome.storage.session.remove(key(tabId));
	});
}

export async function flushAudioSessions(tabId?: number): Promise<void> {
	if (tabId !== undefined) {
		await serialized(tabId, () => flushAudioSessionInternal(tabId));
		return;
	}
	await Promise.all([...pendingWrites.keys()].map((pendingTabId) => (
		serialized(pendingTabId, () => flushAudioSessionInternal(pendingTabId))
	)));
}
