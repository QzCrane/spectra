// goal: persist the last acknowledged, refresh-restorable control fields for one tab
// note: chrome.storage.session keeps the projection across document/worker replacement, never tab closure

import {
	DEFAULT_AUDIO_CONFIG,
	isAudioConfig,
	isControlSessionPatch,
	resolveAudioVolume,
	type AudioConfig,
	type ControlSessionPatch,
	type TabSessionIdentity,
} from '@nexus/contracts';
import { createKeyedSerializedQueue } from './serialized-queue.js';

const TAB_SESSION_PREFIX = 'tab_session_';
const TAB_SESSION_VERSION = 2 as const;
const STORAGE_WRITE_DEBOUNCE_MS = 250;
const MAX_WRITE_RETRIES = 5;

interface StoredTabControlSession {
	version: typeof TAB_SESSION_VERSION;
	identity: TabSessionIdentity;
	patch: ControlSessionPatch;
	updatedAt: number;
}

interface LegacyStoredAudioSession {
	identity: TabSessionIdentity;
	config: AudioConfig;
	updatedAt: number;
}

interface NormalizedStoredSession {
	session: StoredTabControlSession;
	migrated: boolean;
}

const pendingWrites = new Map<number, StoredTabControlSession>();
const writeTimers = new Map<number, ReturnType<typeof setTimeout>>();
const writeRetries = new Map<number, number>();
const serialized = createKeyedSerializedQueue<number>();

function keyFor(tabId: number): string {
	return `${TAB_SESSION_PREFIX}${tabId}`;
}

function clonePatch(patch: ControlSessionPatch): ControlSessionPatch {
	return structuredClone(patch);
}

function clearWriteTimer(tabId: number): void {
	const timer = writeTimers.get(tabId);
	if (timer !== undefined) clearTimeout(timer);
	writeTimers.delete(tabId);
}

function scheduleWrite(tabId: number): void {
	clearWriteTimer(tabId);
	writeTimers.set(tabId, setTimeout(() => {
		writeTimers.delete(tabId);
		void flushTabControlSession(tabId).catch(() => undefined);
	}, STORAGE_WRITE_DEBOUNCE_MS));
}

async function readStoredValue(tabId: number): Promise<unknown> {
	if (pendingWrites.has(tabId)) return pendingWrites.get(tabId);
	const key = keyFor(tabId);
	return (await chrome.storage.session.get(key))[key] as unknown;
}

async function flushTabControlSessionInternal(tabId: number): Promise<void> {
	clearWriteTimer(tabId);
	const pending = pendingWrites.get(tabId);
	if (!pending) return;
	try {
		await chrome.storage.session.set({ [keyFor(tabId)]: pending });
		if (pendingWrites.get(tabId) === pending) pendingWrites.delete(tabId);
		writeRetries.delete(tabId);
	} catch (error) {
		const retries = (writeRetries.get(tabId) ?? 0) + 1;
		if (retries > MAX_WRITE_RETRIES) {
			writeRetries.delete(tabId);
			pendingWrites.delete(tabId);
			console.warn(`[tab-session] giving up on tab ${tabId} after ${MAX_WRITE_RETRIES} failed writes`);
			throw error;
		}
		writeRetries.set(tabId, retries);
		scheduleWrite(tabId);
		throw error;
	}
}

function isTabSessionIdentity(value: unknown): value is TabSessionIdentity {
	if (!value || typeof value !== 'object') return false;
	const identity = value as Partial<TabSessionIdentity>;
	if (!Number.isInteger(identity.tabId) || Number(identity.tabId) <= 0
		|| typeof identity.documentId !== 'string' || identity.documentId.length === 0
		|| identity.documentId.length > 256 || typeof identity.origin !== 'string') return false;
	try {
		return new URL(identity.origin).origin === identity.origin && identity.origin !== 'null';
	} catch {
		return false;
	}
}

function isStoredTabControlSession(value: unknown): value is StoredTabControlSession {
	if (!value || typeof value !== 'object') return false;
	const record = value as Partial<StoredTabControlSession>;
	return record.version === TAB_SESSION_VERSION
		&& isTabSessionIdentity(record.identity)
		&& isControlSessionPatch(record.patch)
		&& typeof record.updatedAt === 'number'
		&& Number.isFinite(record.updatedAt);
}

function isLegacyStoredAudioSession(value: unknown): value is LegacyStoredAudioSession {
	if (!value || typeof value !== 'object') return false;
	const record = value as Partial<LegacyStoredAudioSession>;
	return isTabSessionIdentity(record.identity)
		&& isAudioConfig(record.config)
		&& typeof record.updatedAt === 'number'
		&& Number.isFinite(record.updatedAt);
}

function normalizeStoredSession(value: unknown): NormalizedStoredSession | null {
	if (isStoredTabControlSession(value)) return { session: value, migrated: false };
	if (!isLegacyStoredAudioSession(value)) return null;
	return {
		migrated: true,
		session: {
			version: TAB_SESSION_VERSION,
			identity: value.identity,
			patch: audioConfigToControlSessionPatch(value.config),
			updatedAt: value.updatedAt,
		},
	};
}

function identitiesMatch(left: TabSessionIdentity, right: TabSessionIdentity): boolean {
	return left.tabId === right.tabId
		&& left.documentId === right.documentId
		&& left.origin === right.origin;
}

function originsMatch(left: TabSessionIdentity, right: TabSessionIdentity): boolean {
	return left.tabId === right.tabId && left.origin === right.origin;
}

async function clearStoredSession(tabId: number): Promise<void> {
	clearWriteTimer(tabId);
	pendingWrites.delete(tabId);
	writeRetries.delete(tabId);
	await chrome.storage.session.remove(keyFor(tabId));
}

export function audioConfigPatchToControlSessionPatch(
	config: Partial<AudioConfig>,
): ControlSessionPatch {
	const patch: ControlSessionPatch = {};
	if (config.enabled !== undefined) patch.audioEnabled = config.enabled;
	const legacyVolumeOnly = config.volume !== undefined
		&& config.volumeBase === undefined
		&& config.boost === undefined;
	if (legacyVolumeOnly) {
		const volume = resolveAudioVolume({ volume: config.volume ?? DEFAULT_AUDIO_CONFIG.volume });
		patch.volumeBase = volume.volumeBase;
		patch.boost = volume.boost;
	} else {
		if (config.volumeBase !== undefined) patch.volumeBase = config.volumeBase;
		if (config.boost !== undefined) patch.boost = config.boost;
	}
	if (config.muted !== undefined) patch.mediaMuted = config.muted;
	if (config.speed !== undefined) patch.speed = config.speed;
	if (config.preservePitch !== undefined) patch.preservePitch = config.preservePitch;
	if (config.eqValues !== undefined) patch.eqValues = [...config.eqValues];
	if (config.bass !== undefined) patch.bass = config.bass;
	if (config.compressor !== undefined) patch.compressor = config.compressor;
	if (config.mono !== undefined) patch.mono = config.mono;
	if (config.pan !== undefined) patch.pan = config.pan;
	if (config.delay !== undefined) patch.delay = config.delay;
	return patch;
}

export function audioConfigToControlSessionPatch(config: AudioConfig): ControlSessionPatch {
	return audioConfigPatchToControlSessionPatch(config);
}

export function controlSessionPatchToAudioConfig(
	patch: ControlSessionPatch,
	baseline: AudioConfig = DEFAULT_AUDIO_CONFIG,
): AudioConfig {
	const next: AudioConfig = {
		...baseline,
		eqValues: [...baseline.eqValues],
	};
	if (patch.audioEnabled !== undefined) next.enabled = patch.audioEnabled;
	if (patch.mediaMuted !== undefined) next.muted = patch.mediaMuted;
	if (patch.speed !== undefined) next.speed = patch.speed;
	if (patch.preservePitch !== undefined) next.preservePitch = patch.preservePitch;
	if (patch.eqValues !== undefined) next.eqValues = [...patch.eqValues];
	if (patch.bass !== undefined) next.bass = patch.bass;
	if (patch.compressor !== undefined) next.compressor = patch.compressor;
	if (patch.mono !== undefined) next.mono = patch.mono;
	if (patch.pan !== undefined) next.pan = patch.pan;
	if (patch.delay !== undefined) next.delay = patch.delay;
	const volume = resolveAudioVolume({
		volume: baseline.volume,
		volumeBase: patch.volumeBase ?? baseline.volumeBase,
		boost: patch.boost ?? baseline.boost,
	});
	next.volumeBase = volume.volumeBase;
	next.boost = volume.boost;
	next.volume = volume.effectiveVolume;
	return next;
}

// Reads are identity-bound and side-effect free except for an in-place v1
// AudioConfig migration. A mismatched document cannot claim or rebind state.
export async function getTabControlSession(
	tabId: number,
	identity?: TabSessionIdentity,
): Promise<ControlSessionPatch | null> {
	return serialized(tabId, async () => {
		const raw = await readStoredValue(tabId);
		if (raw === undefined) return null;
		const normalized = normalizeStoredSession(raw);
		if (!normalized) {
			await clearStoredSession(tabId);
			return null;
		}
		if (identity && !identitiesMatch(normalized.session.identity, identity)) return null;
		if (normalized.migrated) {
			pendingWrites.set(tabId, normalized.session);
			scheduleWrite(tabId);
		}
		return clonePatch(normalized.session.patch);
	});
}

// Merges only fields whose executor has acknowledged an actual value. Storage
// remains a projection; the coordinator owns actual state and write ordering.
export async function mergeTabControlSession(
	tabId: number,
	patch: ControlSessionPatch,
	identity: TabSessionIdentity,
): Promise<void> {
	if (Object.keys(patch).length === 0) return;
	if (!isControlSessionPatch(patch)) throw new Error('Invalid tab control session patch');
	if (!isTabSessionIdentity(identity) || identity.tabId !== tabId) {
		throw new Error('Invalid tab control session identity');
	}
	await serialized(tabId, async () => {
		const normalized = normalizeStoredSession(await readStoredValue(tabId));
		const current = normalized && identitiesMatch(normalized.session.identity, identity)
			? normalized.session.patch
			: {};
		const merged = { ...clonePatch(current), ...clonePatch(patch) };
		if (!isControlSessionPatch(merged)) throw new Error('Invalid merged tab control session');
		pendingWrites.set(tabId, {
			version: TAB_SESSION_VERSION,
			identity,
			patch: merged,
			updatedAt: Date.now(),
		});
		scheduleWrite(tabId);
	});
}

// Carries one acknowledged projection across a same-origin full document
// replacement. Cross-origin navigation is the explicit retirement boundary.
export async function rebindTabControlSession(
	tabId: number,
	identity: TabSessionIdentity,
): Promise<ControlSessionPatch | null> {
	if (!isTabSessionIdentity(identity) || identity.tabId !== tabId) return null;
	return serialized(tabId, async () => {
		const raw = await readStoredValue(tabId);
		if (raw === undefined) return null;
		const normalized = normalizeStoredSession(raw);
		if (!normalized || !originsMatch(normalized.session.identity, identity)) {
			await clearStoredSession(tabId);
			return null;
		}

		const session = normalized.session;
		if (normalized.migrated || !identitiesMatch(session.identity, identity)) {
			pendingWrites.set(tabId, {
				...session,
				identity,
				updatedAt: Date.now(),
			});
			scheduleWrite(tabId);
		}
		return clonePatch(session.patch);
	});
}

export async function removeTabControlSession(tabId: number): Promise<void> {
	await serialized(tabId, () => clearStoredSession(tabId));
}

export async function flushTabControlSession(tabId?: number): Promise<void> {
	if (tabId !== undefined) {
		await serialized(tabId, () => flushTabControlSessionInternal(tabId));
		return;
	}
	await Promise.all([...pendingWrites.keys()].map((pendingTabId) => (
		serialized(pendingTabId, () => flushTabControlSessionInternal(pendingTabId))
	)));
}

export async function hasTabControlSession(
	tabId: number,
	identity?: TabSessionIdentity,
): Promise<boolean> {
	return (await getTabControlSession(tabId, identity)) !== null;
}
