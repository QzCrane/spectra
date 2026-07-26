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
const TAB_SESSION_VERSION = 3 as const;
const PREVIOUS_TAB_SESSION_VERSION = 2 as const;
const MAX_WRITE_ATTEMPTS = 3;

export interface TabControlSessionIdentity extends TabSessionIdentity {
	resourceUrl: string;
}

export type TabControlSessionScope = 'origin' | 'resource';

interface StoredTabControlSession {
	version: typeof TAB_SESSION_VERSION;
	identity: TabControlSessionIdentity;
	patch: ControlSessionPatch;
	portablePatch: ControlSessionPatch;
	updatedAt: number;
}

interface PreviousStoredTabControlSession {
	version: typeof PREVIOUS_TAB_SESSION_VERSION;
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
	identity: TabSessionIdentity;
	resourceUrl: string | null;
	patch: ControlSessionPatch;
	portablePatch: ControlSessionPatch;
	updatedAt: number;
	migration: 'none' | 'v2' | 'audio-config';
}

const serialized = createKeyedSerializedQueue<number>();

function keyFor(tabId: number): string {
	return `${TAB_SESSION_PREFIX}${tabId}`;
}

function clonePatch(patch: ControlSessionPatch): ControlSessionPatch {
	return structuredClone(patch);
}

async function readStoredValue(tabId: number): Promise<unknown> {
	const key = keyFor(tabId);
	return (await chrome.storage.session.get(key))[key] as unknown;
}

async function writeStoredSession(tabId: number, session: StoredTabControlSession): Promise<void> {
	let lastError: unknown;
	for (let attempt = 1; attempt <= MAX_WRITE_ATTEMPTS; attempt += 1) {
		try {
			await chrome.storage.session.set({ [keyFor(tabId)]: session });
			return;
		} catch (error) {
			lastError = error;
		}
	}
	console.warn(`[tab-session] failed to persist tab ${tabId} after ${MAX_WRITE_ATTEMPTS} attempts`);
	throw lastError;
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

function normalizeResourceUrl(value: unknown, origin: string): string | null {
	if (typeof value !== 'string' || value.length === 0 || value.length > 8_192) return null;
	try {
		const url = new URL(value);
		if ((url.protocol !== 'http:' && url.protocol !== 'https:')
			|| url.origin !== origin) return null;
		return url.href;
	} catch {
		return null;
	}
}

function isTabControlSessionIdentity(value: unknown): value is TabControlSessionIdentity {
	if (!isTabSessionIdentity(value)) return false;
	const identity = value as TabSessionIdentity & { resourceUrl?: unknown };
	return normalizeResourceUrl(identity.resourceUrl, identity.origin) === identity.resourceUrl;
}

function isPortableControlSessionPatch(value: unknown): value is ControlSessionPatch {
	return value !== null
		&& typeof value === 'object'
		&& (Object.keys(value).length === 0 || isControlSessionPatch(value));
}

function isStoredTabControlSession(value: unknown): value is StoredTabControlSession {
	if (!value || typeof value !== 'object') return false;
	const record = value as Partial<StoredTabControlSession>;
	return record.version === TAB_SESSION_VERSION
		&& isTabControlSessionIdentity(record.identity)
		&& isControlSessionPatch(record.patch)
		&& isPortableControlSessionPatch(record.portablePatch)
		&& typeof record.updatedAt === 'number'
		&& Number.isFinite(record.updatedAt);
}

function isPreviousStoredTabControlSession(value: unknown): value is PreviousStoredTabControlSession {
	if (!value || typeof value !== 'object') return false;
	const record = value as Partial<PreviousStoredTabControlSession>;
	return record.version === PREVIOUS_TAB_SESSION_VERSION
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
	if (isStoredTabControlSession(value)) {
		return {
			identity: value.identity,
			resourceUrl: value.identity.resourceUrl,
			patch: value.patch,
			portablePatch: value.portablePatch,
			updatedAt: value.updatedAt,
			migration: 'none',
		};
	}
	if (isPreviousStoredTabControlSession(value)) {
		return {
			identity: value.identity,
			resourceUrl: null,
			patch: value.patch,
			portablePatch: {},
			updatedAt: value.updatedAt,
			migration: 'v2',
		};
	}
	if (!isLegacyStoredAudioSession(value)) return null;
	return {
		identity: value.identity,
		resourceUrl: null,
		patch: audioConfigToControlSessionPatch(value.config),
		portablePatch: {},
		updatedAt: value.updatedAt,
		migration: 'audio-config',
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

export function createTabControlSessionIdentity(
	tabId: number,
	documentId: string,
	resourceUrl: string,
): TabControlSessionIdentity {
	let url: URL;
	try {
		url = new URL(resourceUrl);
	} catch {
		throw new Error('Invalid tab control session resource URL');
	}
	const identity: TabControlSessionIdentity = {
		tabId,
		documentId,
		origin: url.origin,
		resourceUrl: url.href,
	};
	if (!isTabControlSessionIdentity(identity)) {
		throw new Error('Invalid tab control session identity');
	}
	return identity;
}

async function clearStoredSession(tabId: number): Promise<void> {
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

// Reads are identity-bound and side-effect free except for an in-place legacy
// migration when the caller proves the current resource. A mismatched document
// cannot claim or rebind state.
export async function getTabControlSession(
	tabId: number,
	identity?: TabSessionIdentity | TabControlSessionIdentity,
): Promise<ControlSessionPatch | null> {
	return serialized(tabId, async () => {
		const raw = await readStoredValue(tabId);
		if (raw === undefined) return null;
		const normalized = normalizeStoredSession(raw);
		if (!normalized) {
			await clearStoredSession(tabId);
			return null;
		}
		if (identity && !identitiesMatch(normalized.identity, identity)) return null;
		if (normalized.migration !== 'none' && isTabControlSessionIdentity(identity)) {
			await writeStoredSession(tabId, {
				version: TAB_SESSION_VERSION,
				identity,
				patch: normalized.patch,
				portablePatch: normalized.portablePatch,
				updatedAt: normalized.updatedAt,
			});
		}
		return clonePatch(normalized.patch);
	});
}

// The delta contains only fields acknowledged by the current transaction and
// therefore owns their propagation scope. The coordinator may also provide its
// complete current-resource projection so a first explicit field update can
// preserve restored actual state without promoting every restored field across
// resources. Both projections become durable through one physical write.
export async function mergeTabControlSession(
	tabId: number,
	patch: ControlSessionPatch,
	identity: TabControlSessionIdentity,
	scope: TabControlSessionScope = 'origin',
	currentResourcePatch?: ControlSessionPatch,
): Promise<void> {
	if (Object.keys(patch).length === 0) return;
	if (!isControlSessionPatch(patch)) throw new Error('Invalid tab control session patch');
	if (currentResourcePatch && !isControlSessionPatch(currentResourcePatch)) {
		throw new Error('Invalid current-resource tab control session patch');
	}
	if (!isTabControlSessionIdentity(identity) || identity.tabId !== tabId) {
		throw new Error('Invalid tab control session identity');
	}
	await serialized(tabId, async () => {
		const normalized = normalizeStoredSession(await readStoredValue(tabId));
		const current = normalized && identitiesMatch(normalized.identity, identity)
			? normalized.patch
			: {};
		const currentPortable = normalized && identitiesMatch(normalized.identity, identity)
			? normalized.portablePatch
			: {};
		const resourceBase = currentResourcePatch
			? clonePatch(currentResourcePatch)
			: clonePatch(current);
		const merged = { ...resourceBase, ...clonePatch(patch) };
		if (!isControlSessionPatch(merged)) throw new Error('Invalid merged tab control session');
		const portablePatch = clonePatch(currentPortable);
		if (scope === 'origin') {
			Object.assign(portablePatch, clonePatch(patch));
		} else {
			for (const field of Object.keys(patch)) {
				Reflect.deleteProperty(portablePatch, field);
			}
		}
		if (!isPortableControlSessionPatch(portablePatch)) {
			throw new Error('Invalid portable tab control session patch');
		}
		await writeStoredSession(tabId, {
			version: TAB_SESSION_VERSION,
			identity,
			patch: merged,
			portablePatch,
			updatedAt: Date.now(),
		});
	});
}

// Carries the complete projection across the same document or exact-resource
// reload, and only explicit origin-portable fields into another same-origin
// resource. Cross-origin navigation retires both scopes.
export async function rebindTabControlSession(
	tabId: number,
	identity: TabControlSessionIdentity,
): Promise<ControlSessionPatch | null> {
	if (!isTabControlSessionIdentity(identity) || identity.tabId !== tabId) return null;
	return serialized(tabId, async () => {
		const raw = await readStoredValue(tabId);
		if (raw === undefined) return null;
		const normalized = normalizeStoredSession(raw);
		const sameDocument = normalized
			? identitiesMatch(normalized.identity, identity)
			: false;
		const sameOrigin = normalized
			? originsMatch(normalized.identity, identity)
			: false;
		const exactResourceReload = sameOrigin
			&& normalized?.resourceUrl === identity.resourceUrl;
		if (!normalized || !sameOrigin) {
			await clearStoredSession(tabId);
			return null;
		}
		const patch = sameDocument || exactResourceReload
			? normalized.patch
			: normalized.portablePatch;
		if (Object.keys(patch).length === 0) {
			await clearStoredSession(tabId);
			return null;
		}

		if (normalized.migration !== 'none'
			|| !identitiesMatch(normalized.identity, identity)
			|| normalized.resourceUrl !== identity.resourceUrl
			|| patch !== normalized.patch) {
			await writeStoredSession(tabId, {
				version: TAB_SESSION_VERSION,
				identity,
				patch,
				portablePatch: normalized.portablePatch,
				updatedAt: Date.now(),
			});
		}
		return clonePatch(patch);
	});
}

export async function removeTabControlSession(tabId: number): Promise<void> {
	await serialized(tabId, () => clearStoredSession(tabId));
}

export async function flushTabControlSession(tabId?: number): Promise<void> {
	if (tabId !== undefined) await serialized(tabId, async () => undefined);
	else await serialized.drain();
}

export async function hasTabControlSession(
	tabId: number,
	identity?: TabSessionIdentity | TabControlSessionIdentity,
): Promise<boolean> {
	return (await getTabControlSession(tabId, identity)) !== null;
}
