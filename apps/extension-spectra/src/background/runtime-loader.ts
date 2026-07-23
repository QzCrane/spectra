// goal: single-flight, document-scoped loader for the optional heavy content runtime

import {
	SPECTRA_CONTENT_RUNTIME_REVISION,
	SPECTRA_PROTOCOL_VERSION,
	CONTROL_ALGORITHM_POLICIES,
	HOTKEY_ACTION_DESCRIPTORS,
	findBestHostnameMatch,
	isDefaultAudioConfig,
	normalizeHostname,
	resolveAudioVolume,
	isSpectraRequestEnvelope,
	rpcFailure,
	rpcSuccess,
	type ContentRuntimeLeaseReason,
	type ContentRuntimeReadyResult,
	type ContentRuntimeSourceOwnership,
	type ControlField,
	type ControlPatch,
	type ControlSessionPatch,
	type MediaTarget,
	type HotkeySettings,
	type AudioConfig,
} from '@nexus/contracts';
import { sendSpectraTabRequest } from '../shared/spectra-client';
import { swLog } from '../shared/logger';
import { injectMainBridges } from './main-runtime-manager';
import { settingsRepository } from './settings-repository';
import { storage } from './state';
import { markBadgeUsedForTab } from './handlers/badge';

// Heavy SPA startup can legitimately spend several seconds restoring settings
// and discovering media before the runtime publishes READY. Keep the handshake
// bounded, but do not classify a normal cold start as a failed injection.
const READY_TIMEOUT_MS = 15_000;

interface RuntimeWaiter {
	resolve(result: ContentRuntimeReadyResult): void;
	reject(error: Error): void;
	timeoutId: ReturnType<typeof setTimeout>;
}

const readyDocuments = new Map<string, ContentRuntimeReadyResult>();
const loadingDocuments = new Map<string, Promise<ContentRuntimeReadyResult>>();
const disposingDocuments = new Map<string, Promise<void>>();
const waiters = new Map<string, RuntimeWaiter>();
const leases = new Map<string, Set<string>>();
const disposeTimers = new Map<string, ReturnType<typeof setTimeout>>();
const hotkeyLeases = new Map<string, string>();
const documentInitializations = new Map<string, Promise<void>>();
let initialized = false;

const RUNTIME_HANDOFF_GRACE_MS = 250;

function runtimeKey(tabId: number, documentId: string): string {
	return `${tabId}:${documentId}`;
}

function runtimeLeaseKey(reason: ContentRuntimeLeaseReason, capability: string): string {
	return `${reason}:${capability}`;
}

function enabledSiteHotkeyCapability(
	url: string | undefined,
	settings: HotkeySettings,
): string | null {
	if (!url) return null;
	let hostname: string | null = null;
	try { hostname = normalizeHostname(new URL(url).hostname); } catch { return null; }
	if (!hostname) return null;
	const match = findBestHostnameMatch(
		hostname,
		Object.entries(settings.sites),
		([domain]) => domain,
	);
	if (!match) return null;
	const [domain, site] = match;
	const enabled = site.enabled && site.bindings.some((binding) => (
		binding.enabled
		&& !binding.disabledReason
		&& HOTKEY_ACTION_DESCRIPTORS[binding.action].availability === 'enabled'
	));
	return enabled ? `site:${domain}` : null;
}

export async function reconcileHotkeyRuntimeLease(
	tabId: number,
	documentId: string,
	url: string | undefined,
	settings?: HotkeySettings,
): Promise<void> {
	const key = runtimeKey(tabId, documentId);
	const hotkeys = settings ?? (await settingsRepository.getSnapshot()).hotkeySettings;
	const capability = enabledSiteHotkeyCapability(url, hotkeys);
	const previous = hotkeyLeases.get(key);
	if (previous === capability) return;
	if (previous) {
		hotkeyLeases.delete(key);
		releaseContentRuntimeLease(tabId, documentId, 'hotkey', previous);
	}
	if (!capability) return;
	await ensureContentRuntime(tabId, documentId, 'hotkey', capability);
	hotkeyLeases.set(key, capability);
}

export async function reconcileAllHotkeyRuntimeLeases(settings: HotkeySettings): Promise<void> {
	const tabs = await chrome.tabs.query({});
	await Promise.allSettled(tabs.map(async (tab) => {
		if (!tab.id || !tab.url) return;
		const documentId = await currentTopDocumentId(tab.id);
		await reconcileHotkeyRuntimeLease(tab.id, documentId, tab.url, settings);
	}));
}

function sourceLeaseCapability(kind: 'marker' | 'ab', target: MediaTarget): string {
	return `owner:${kind}:${target.mediaId.slice(0, 64)}:${target.sourceRevision}`;
}

function acquireRuntimeLease(
	key: string,
	reason: ContentRuntimeLeaseReason,
	capability: string,
): void {
	const timer = disposeTimers.get(key);
	if (timer) clearTimeout(timer);
	disposeTimers.delete(key);
	const active = leases.get(key) ?? new Set<string>();
	active.add(runtimeLeaseKey(reason, capability));
	leases.set(key, active);
}

export function retainSourceRuntimeLease(
	tabId: number,
	target: MediaTarget,
	kind: 'marker' | 'ab',
): void {
	acquireRuntimeLease(
		runtimeKey(tabId, target.documentId),
		'control',
		sourceLeaseCapability(kind, target),
	);
}

export function releaseSourceRuntimeLease(
	tabId: number,
	target: MediaTarget,
	kind: 'marker' | 'ab',
): void {
	releaseContentRuntimeLease(
		tabId,
		target.documentId,
		'control',
		sourceLeaseCapability(kind, target),
	);
}

function recoverSourceRuntimeLeases(
	tabId: number,
	documentId: string,
	ownedSources: readonly ContentRuntimeSourceOwnership[],
): void {
	for (const owned of ownedSources) {
		if (owned.target.documentId !== documentId) continue;
		if (owned.markerCount > 0) retainSourceRuntimeLease(tabId, owned.target, 'marker');
		if (owned.abActive) retainSourceRuntimeLease(tabId, owned.target, 'ab');
	}
}

async function disposeDocumentRuntime(
	tabId: number,
	documentId: string,
	key: string,
): Promise<void> {
	if ((leases.get(key)?.size ?? 0) > 0) return;
	const ready = readyDocuments.get(key);
	if (!ready) return;
	const response = await sendSpectraTabRequest(
		tabId,
		'spectra.content.runtime.release',
		{ runtimeRevision: ready.runtimeRevision },
		{ documentId },
	).catch(() => null);
	// A missing RELEASE ACK is an ambiguous outcome: the document may already
	// have disposed the runtime even though the response was lost. Never keep a
	// READY cache entry after that boundary. The next consumer probes the
	// document and either reuses a still-live runtime or performs a fresh
	// injection, so a transient messaging failure cannot hand out a dead host.
	if (readyDocuments.get(key)?.runtimeRevision === ready.runtimeRevision) {
		readyDocuments.delete(key);
	}
	if (response && !response.ok) {
		swLog.warn(`[Runtime] release was not acknowledged: ${response.error.code}`);
	}
}

function beginDocumentRuntimeDisposal(
	tabId: number,
	documentId: string,
	key: string,
): Promise<void> {
	const existing = disposingDocuments.get(key);
	if (existing) return existing;
	const operation = disposeDocumentRuntime(tabId, documentId, key)
		.finally(() => {
			if (disposingDocuments.get(key) === operation) disposingDocuments.delete(key);
		});
	disposingDocuments.set(key, operation);
	return operation;
}

export function releaseContentRuntimeLease(
	tabId: number,
	documentId: string,
	reason: ContentRuntimeLeaseReason,
	capability: string,
): void {
	const key = runtimeKey(tabId, documentId);
	const active = leases.get(key);
	if (!active?.delete(runtimeLeaseKey(reason, capability))) return;
	if (active && active.size > 0) return;
	leases.delete(key);
	const previous = disposeTimers.get(key);
	if (previous) clearTimeout(previous);
	disposeTimers.set(key, setTimeout(() => {
		disposeTimers.delete(key);
		void beginDocumentRuntimeDisposal(tabId, documentId, key)
			.catch((error) => swLog.warn(`[Runtime] release failed: ${String(error)}`));
	}, RUNTIME_HANDOFF_GRACE_MS));
}

function senderIdentity(sender: chrome.runtime.MessageSender): { tabId: number; documentId: string } | null {
	const tabId = sender.tab?.id;
	if (!tabId || !sender.documentId) return null;
	return { tabId, documentId: sender.documentId };
}

async function currentTopDocument(tabId: number): Promise<{ documentId: string; url: string }> {
	const frame = await chrome.webNavigation.getFrame({ tabId, frameId: 0 });
	if (!frame?.documentId) throw new Error('The tab has no current top-level document');
	if (!frame.url) throw new Error('The tab has no current top-level URL');
	return { documentId: frame.documentId, url: frame.url };
}

async function currentTopDocumentId(tabId: number): Promise<string> {
	return (await currentTopDocument(tabId)).documentId;
}

async function resolveDocumentId(tabId: number, requested?: string): Promise<string> {
	const current = await currentTopDocumentId(tabId);
	if (requested && requested !== current) throw new Error('The requested document is stale');
	return current;
}

type DocumentRestore = (tabId: number, documentId: string, url: string | undefined) => Promise<void>;
let restoreDocumentForInitialization: DocumentRestore = (...args) => restoreIfConfigured(...args);

function beginDocumentInitialization(
	tabId: number,
	documentId: string,
	url: string | undefined,
): Promise<void> {
	const key = runtimeKey(tabId, documentId);
	const existing = documentInitializations.get(key);
	if (existing) return existing;
	const operation = Promise.resolve()
		.then(() => restoreDocumentForInitialization(tabId, documentId, url))
		.catch((error) => {
			// Initialization is an ordering barrier, not a permanent availability
			// gate. A failed restore is reported once and explicit user control may
			// proceed against the current document afterwards.
			swLog.warn(`[Runtime] document restore failed: ${String(error)}`);
		});
	documentInitializations.set(key, operation);
	return operation;
}

// post: explicit control and initial snapshot reads observe one completed
// restore decision for the current document. Restore-originated writes bypass
// this function in the coordinator, preventing a self-wait cycle.
export async function awaitDocumentInitialization(
	tabId: number,
	documentId?: string,
): Promise<void> {
	// Direct unit consumers of the coordinator do not initialize the MV3 loader.
	// Production does so first in background/index.ts.
	if (!initialized) return;
	const current = await currentTopDocument(tabId);
	if (documentId && documentId !== current.documentId) {
		throw new Error('The requested initialization document is stale');
	}
	await beginDocumentInitialization(tabId, current.documentId, current.url);
}

async function probeRuntime(tabId: number, documentId: string): Promise<ContentRuntimeReadyResult | null> {
	const response = await sendSpectraTabRequest(
		tabId,
		'spectra.content.runtime.status',
		{},
		{ documentId },
	).catch(() => null);
	if (!response?.ok
		|| !response.data.ready
		|| response.data.runtimeRevision !== SPECTRA_CONTENT_RUNTIME_REVISION) return null;
	recoverSourceRuntimeLeases(tabId, documentId, response.data.ownedSources);
	return {
		documentId,
		runtimeRevision: response.data.runtimeRevision,
		ready: true,
	};
}

function createReadyWaiter(key: string): Promise<ContentRuntimeReadyResult> {
	return new Promise((resolve, reject) => {
		const timeoutId = setTimeout(() => {
			waiters.delete(key);
			reject(new Error('Content runtime READY handshake timed out'));
		}, READY_TIMEOUT_MS);
		waiters.set(key, { resolve, reject, timeoutId });
	});
}

function commitReady(tabId: number, documentId: string, runtimeRevision: string): ContentRuntimeReadyResult {
	const key = runtimeKey(tabId, documentId);
	const result: ContentRuntimeReadyResult = { documentId, runtimeRevision, ready: true };
	readyDocuments.set(key, result);
	const waiter = waiters.get(key);
	if (waiter) {
		clearTimeout(waiter.timeoutId);
		waiters.delete(key);
		waiter.resolve(result);
	}
	return result;
}

function forgetDocument(tabId: number, documentId?: string): void {
	const prefix = `${tabId}:`;
	for (const key of [...readyDocuments.keys()]) {
		if (key.startsWith(prefix) && (!documentId || key === runtimeKey(tabId, documentId))) {
			readyDocuments.delete(key);
		}
	}
	for (const [key, waiter] of [...waiters.entries()]) {
		if (!key.startsWith(prefix) || documentId && key !== runtimeKey(tabId, documentId)) continue;
		clearTimeout(waiter.timeoutId);
		waiters.delete(key);
		waiter.reject(new Error('Content runtime document was released'));
	}
	for (const key of [...loadingDocuments.keys()]) {
		if (key.startsWith(prefix) && (!documentId || key === runtimeKey(tabId, documentId))) {
			loadingDocuments.delete(key);
		}
	}
	for (const key of [...disposingDocuments.keys()]) {
		if (key.startsWith(prefix) && (!documentId || key === runtimeKey(tabId, documentId))) {
			disposingDocuments.delete(key);
		}
	}
	for (const key of [...leases.keys()]) {
		if (key.startsWith(prefix) && (!documentId || key === runtimeKey(tabId, documentId))) {
			leases.delete(key);
		}
	}
	for (const [key, timer] of [...disposeTimers.entries()]) {
		if (!key.startsWith(prefix) || documentId && key !== runtimeKey(tabId, documentId)) continue;
		clearTimeout(timer);
		disposeTimers.delete(key);
	}
	for (const key of [...hotkeyLeases.keys()]) {
		if (key.startsWith(prefix) && (!documentId || key === runtimeKey(tabId, documentId))) {
			hotkeyLeases.delete(key);
		}
	}
	for (const key of [...documentInitializations.keys()]) {
		if (key.startsWith(prefix) && (!documentId || key === runtimeKey(tabId, documentId))) {
			documentInitializations.delete(key);
		}
	}
}

async function loadRuntime(tabId: number, documentId: string): Promise<ContentRuntimeReadyResult> {
	const key = runtimeKey(tabId, documentId);
	const waitForReady = createReadyWaiter(key);
	try {
		const waitForInjection = chrome.scripting.executeScript({
			target: { tabId, documentIds: [documentId] },
			files: ['content-runtime.js'],
			world: 'ISOLATED',
		});
		const first = await Promise.race([
			waitForReady.then((result) => ({ kind: 'ready' as const, result })),
			waitForInjection.then(() => ({ kind: 'injected' as const })),
		]);
		return first.kind === 'ready' ? first.result : await waitForReady;
	} catch (error) {
		const waiter = waiters.get(key);
		if (waiter) {
			clearTimeout(waiter.timeoutId);
			waiters.delete(key);
		}
		throw error;
	}
}

async function ensureReadyDocument(
	tabId: number,
	documentId: string,
): Promise<ContentRuntimeReadyResult> {
	const key = runtimeKey(tabId, documentId);
	const pending = loadingDocuments.get(key);
	if (pending) return pending;
	const loading = (async () => {
		const known = readyDocuments.get(key);
		if (known?.runtimeRevision === SPECTRA_CONTENT_RUNTIME_REVISION) return known;

		const probed = await probeRuntime(tabId, documentId);
		if (probed) {
			readyDocuments.set(key, probed);
			return probed;
		}
		return loadRuntime(tabId, documentId);
	})()
		.finally(() => loadingDocuments.delete(key));
	loadingDocuments.set(key, loading);
	return loading;
}

export async function ensureContentRuntime(
	tabId: number,
	documentId: string | undefined,
	reason: ContentRuntimeLeaseReason,
	capability: string,
): Promise<ContentRuntimeReadyResult> {
	const currentDocumentId = await resolveDocumentId(tabId, documentId);
	const key = runtimeKey(tabId, currentDocumentId);
	acquireRuntimeLease(key, reason, capability);
	try {
		// A lease acquired while the last consumer is awaiting its RELEASE ACK
		// must reload after that handshake. Returning the old READY entry would
		// otherwise hand a new caller a runtime that is being torn down.
		await disposingDocuments.get(key);
		return await ensureReadyDocument(tabId, currentDocumentId);
	} catch (error) {
		releaseContentRuntimeLease(tabId, currentDocumentId, reason, capability);
		throw error;
	}
}

async function restoreIfConfigured(tabId: number, documentId: string, url: string | undefined): Promise<void> {
	if (!url) return;
	let hostname = '';
	let origin = '';
	try {
		const parsed = new URL(url);
		hostname = parsed.hostname;
		origin = parsed.origin;
	} catch { return; }
	if (origin === 'null') return;
	const restore = await resolveDocumentRestorePlan(tabId, documentId, hostname, origin);
	if (Object.keys(restore.patch).length === 0) return;
	// Replaying a same-origin tab session must preserve its existing usage fact:
	// native-only page interaction stays badge-free, while an earlier SPECTRA
	// action is already sticky in badge-usage storage. A configured site/global
	// preset is itself active extension behavior and therefore starts usage.
	if (restore.source === 'preset') await markBadgeUsedForTab(tabId);
	const capability = `settings:${hostname}`;
	await ensureContentRuntime(tabId, documentId, 'restore', capability);
	try {
		const { submitControlRequest } = await import('./control-coordinator');
		for (const group of splitDocumentRestorePatch(restore.patch)) {
			await submitControlRequest({
				tabId,
				source: 'restore',
				requestedCoverage: group.requestedCoverage,
				target: null,
				patch: group.patch,
			});
		}
	} finally {
		releaseContentRuntimeLease(tabId, documentId, 'restore', capability);
	}
}

export function initializeContentRuntimeLoader(): void {
	if (initialized) return;
	initialized = true;
	void settingsRepository.getSnapshot()
		.then((snapshot) => reconcileAllHotkeyRuntimeLeases(snapshot.hotkeySettings))
		.catch((error) => swLog.warn(`[Runtime] startup hotkey projection failed: ${String(error)}`));

	chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
		if (!message || typeof message !== 'object') return false;
		const candidate = message as { protocolVersion?: unknown; type?: unknown };
		const isRuntimeMessage = candidate.type === 'spectra.content.bootstrap.hello'
			|| candidate.type === 'spectra.content.runtime.ensure'
			|| candidate.type === 'spectra.content.runtime.ready'
			|| candidate.type === 'spectra.content.runtime.release';
		if (candidate.protocolVersion !== SPECTRA_PROTOCOL_VERSION || !isRuntimeMessage) return false;
		if (sender.id && sender.id !== chrome.runtime.id) {
			sendResponse(rpcFailure('forbidden', 'Content runtime RPC is extension-internal only'));
			return false;
		}
		if (!isSpectraRequestEnvelope(message)
			|| (message.type !== 'spectra.content.bootstrap.hello'
				&& message.type !== 'spectra.content.runtime.ensure'
				&& message.type !== 'spectra.content.runtime.ready'
				&& message.type !== 'spectra.content.runtime.release')) {
			sendResponse(rpcFailure('invalid_request', 'Malformed content runtime request'));
			return false;
		}

		if (message.type === 'spectra.content.bootstrap.hello') {
			const identity = senderIdentity(sender);
			if (!identity) {
				sendResponse(rpcFailure('forbidden', 'Bootstrap HELLO requires a document identity'));
				return false;
			}
			// rule: SCTRL-001/004 — the manifest registers the minimal ISOLATED
			// bootstrap and the two closed MAIN-world bridges. This recovery path
			// re-injects fullscreen V1 and exact-element page-media V2 idempotently on
			// every new document, delegated exclusively to
			// main-runtime-manager (sole owner of the MAIN-world injection literal).
			// This ensures the bridges are present from the very first event the
			// page dispatches.
			void injectMainBridges(identity.tabId).catch((error: unknown) => {
				swLog.warn(
					`[Runtime] MAIN bridge injection failed for tab ${identity.tabId}: `
					+ `${error instanceof Error ? error.message : String(error)}`,
				);
			});
			const initialization = beginDocumentInitialization(
				identity.tabId,
				identity.documentId,
				sender.url ?? sender.tab?.url,
			);
			const hotkeyProjection = reconcileHotkeyRuntimeLease(
				identity.tabId,
				identity.documentId,
				sender.url ?? sender.tab?.url,
			);
			void Promise.allSettled([initialization, hotkeyProjection]).then((results) => {
				for (const result of results) {
					if (result.status === 'rejected') swLog.warn(`[Runtime] bootstrap projection failed: ${String(result.reason)}`);
				}
			});
			void initialization.then(() => {
				const known = readyDocuments.get(runtimeKey(identity.tabId, identity.documentId));
				sendResponse(rpcSuccess({
					accepted: true as const,
					runtimeRevision: known?.runtimeRevision ?? null,
				}));
			}, (error) => sendResponse(rpcFailure(
				'content_initialization_failed',
				error instanceof Error ? error.message : String(error),
				true,
			)));
			return true;
		}

		if (message.type === 'spectra.content.runtime.ensure') {
			void ensureContentRuntime(
				message.payload.tabId,
				message.payload.documentId,
				message.payload.reason,
				message.payload.capability ?? message.requestId,
			).then(
				(result) => sendResponse(rpcSuccess(result)),
				(error) => sendResponse(rpcFailure(
					'content_runtime_load_failed',
					error instanceof Error ? error.message : String(error),
					true,
				)),
			);
			return true;
		}

		if (message.type === 'spectra.content.runtime.release'
			&& message.payload.tabId !== undefined
			&& message.payload.documentId !== undefined
			&& message.payload.reason !== undefined
			&& message.payload.capability !== undefined) {
			if (sender.tab) {
				sendResponse(rpcFailure('forbidden', 'A document cannot release another runtime consumer'));
				return false;
			}
			releaseContentRuntimeLease(
				message.payload.tabId,
				message.payload.documentId,
				message.payload.reason,
				message.payload.capability,
			);
			sendResponse(rpcSuccess({ accepted: true as const }));
			return false;
		}

		const identity = senderIdentity(sender);
		if (!identity) {
			sendResponse(rpcFailure('forbidden', 'Runtime lifecycle requires a document identity'));
			return false;
		}
		if (message.type === 'spectra.content.runtime.ready') {
			if (message.payload.runtimeRevision !== SPECTRA_CONTENT_RUNTIME_REVISION) {
				sendResponse(rpcFailure('runtime_revision_mismatch', 'Unexpected content runtime revision'));
				return false;
			}
			void currentTopDocumentId(identity.tabId).then(
				(currentDocumentId) => {
					if (currentDocumentId !== identity.documentId) {
						sendResponse(rpcFailure('stale_document', 'Runtime READY belongs to a stale document'));
						return;
					}
					commitReady(identity.tabId, identity.documentId, message.payload.runtimeRevision);
					sendResponse(rpcSuccess({ accepted: true as const }));
				},
				(error) => sendResponse(rpcFailure(
					'runtime_identity_unavailable',
					error instanceof Error ? error.message : String(error),
					true,
				)),
			);
			return true;
		}

		forgetDocument(identity.tabId, identity.documentId);
		sendResponse(rpcSuccess({ accepted: true as const }));
		return false;
	});

	chrome.tabs.onRemoved.addListener((tabId) => forgetDocument(tabId));
	chrome.webNavigation.onCommitted.addListener((details) => {
		if (details.frameId === 0) forgetDocument(details.tabId);
	});
	const reconcileSameDocument = (details: {
		frameId: number;
		tabId: number;
		documentId: string;
		url: string;
	}): void => {
		if (details.frameId !== 0) return;
		void Promise.allSettled([
			reconcileHotkeyRuntimeLease(details.tabId, details.documentId, details.url),
		]);
	};
	chrome.webNavigation.onHistoryStateUpdated.addListener(reconcileSameDocument);
	chrome.webNavigation.onReferenceFragmentUpdated.addListener(reconcileSameDocument);
	// Full navigations normally acquire their hotkey lease from the manifest
	// bootstrap HELLO. DOMContentLoaded is an independent retry boundary for the
	// cases where that document-start message races service-worker startup.
	chrome.webNavigation.onDOMContentLoaded.addListener(reconcileSameDocument);
}

// Test-only reset for module-scoped MV3 state. It is tree-shaken from the
// production entry because background imports only the initializer/ensure API.
export function resetContentRuntimeLoaderForTests(): void {
	for (const waiter of waiters.values()) {
		clearTimeout(waiter.timeoutId);
		waiter.reject(new Error('Content runtime loader test reset'));
	}
	readyDocuments.clear();
	loadingDocuments.clear();
	disposingDocuments.clear();
	waiters.clear();
	leases.clear();
	for (const timer of disposeTimers.values()) clearTimeout(timer);
	disposeTimers.clear();
	hotkeyLeases.clear();
	documentInitializations.clear();
	restoreDocumentForInitialization = (...args) => restoreIfConfigured(...args);
	initialized = false;
}

function presetRestorePatch(config: AudioConfig): ControlSessionPatch {
	if (isDefaultAudioConfig(config)) return {};
	const volume = resolveAudioVolume(config);
	return {
		...(config.enabled ? {
			volumeBase: volume.volumeBase,
			mediaMuted: config.muted,
			speed: config.speed,
			preservePitch: config.preservePitch,
		} : {}),
		audioEnabled: config.enabled,
		boost: config.enabled ? volume.boost : 1,
		eqValues: config.enabled ? [...config.eqValues] : [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
		bass: config.enabled && config.bass,
		compressor: config.enabled && config.compressor,
		mono: config.enabled && config.mono,
		pan: config.enabled ? config.pan : 0,
		delay: config.enabled ? config.delay : 0,
	};
}

function splitDocumentRestorePatch(patch: ControlSessionPatch): Array<{
	requestedCoverage: 'active-target' | 'full';
	patch: ControlPatch;
}> {
	const media: ControlPatch = {};
	const video: ControlPatch = {};
	const full: ControlPatch = {};
	for (const [rawField, value] of Object.entries(patch)) {
		const field = rawField as ControlField;
		const policy = CONTROL_ALGORITHM_POLICIES[field];
		const target = policy.scope === 'active-video'
			? video
			: policy.scope === 'document'
				|| policy.orderedStrategies.some((strategy) => (
					strategy === 'media-webaudio' || strategy === 'capture'
				))
				? full
				: media;
		(target as Record<string, unknown>)[field] = structuredClone(value);
	}
	return [
		...(Object.keys(media).length > 0
			? [{ requestedCoverage: 'active-target' as const, patch: media }]
			: []),
		...(Object.keys(video).length > 0
			? [{ requestedCoverage: 'active-target' as const, patch: video }]
			: []),
		...(Object.keys(full).length > 0
			? [{ requestedCoverage: 'full' as const, patch: full }]
			: []),
	];
}

async function resolveDocumentRestorePlan(
	tabId: number,
	documentId: string,
	hostname: string,
	origin: string,
): Promise<{ patch: ControlSessionPatch; source: 'session' | 'preset' }> {
	const sessionPatch = await storage.tabSession.rebind(tabId, { tabId, documentId, origin });
	if (sessionPatch) return { patch: sessionPatch, source: 'session' };
	return {
		patch: presetRestorePatch(await settingsRepository.resolveAudioConfig(hostname)),
		source: 'preset',
	};
}

export const runtimeLoaderTestApi = {
	setDocumentRestore(restore: DocumentRestore): void {
		restoreDocumentForInitialization = restore;
	},
	resolveDocumentRestorePlan,
	splitDocumentRestorePatch,
};
