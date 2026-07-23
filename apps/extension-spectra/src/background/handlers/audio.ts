// goal: handles messages for retrieving and updating audio configurations with session/preset separation
// rule: AUDIO_SET_CONFIG syncs to tab session only; domain presets must be saved explicitly via btnSave

import {
	Actions,
	SPECTRA_PROTOCOL_VERSION,
	isSpectraRequestEnvelope,
	normalizeHostname,
	rpcFailure,
	rpcSuccess,
	type AudioConfig,
	type AudioSessionSnapshot,
	type TabSessionIdentity,
	type VisualizerBatchPayload,
} from '@nexus/contracts';
import {
	audioConfigPatchToControlSessionPatch,
	audioConfigToControlSessionPatch,
	controlSessionPatchToAudioConfig,
} from '@nexus/kernel';
import { router, storage, captureStates } from '../state';
import {
	flushAudioSessions,
	getAudioSession,
	identityFromSender,
	updateAudioSession,
} from '../audio-session-store';
import { sendOffscreenMessageIfPresent } from '../offscreen-coordinator';
import { settingsRepository } from '../settings-repository';
import { updateBadgeFromSession } from './badge';
import { sendSpectraTabRequest } from '../spectra-tab-client';
import { swLog } from '../../shared/logger';
import {
	advanceVisualizerSubscriberLeases,
	nextVisualizerSubscriberExpiry,
	planVisualizerSubscriberLease,
	removeVisualizerTab,
	visualizerSubscriberUnion,
	type VisualizerSubscriberLeases,
} from '../visualizer-subscriber-registry';

const sessionIdentityFromSender = identityFromSender;

async function resolveAudioConfigForSender(sender: chrome.runtime.MessageSender): Promise<AudioConfig> {
	const tabId = sender.tab?.id;
	const identity = sessionIdentityFromSender(sender);
	const domain = normalizeHostname(sender.url ?? sender.tab?.url ?? '') ?? '';
	let config: AudioConfig | null = null;
	if (tabId && identity) {
		try {
			const session = await storage.tabSession.get(tabId, identity);
			if (session) config = controlSessionPatchToAudioConfig(session);
		} catch { }
	}
	return config ?? settingsRepository.resolveAudioConfig(domain);
}

function senderMatchesEnvelope(
	sender: chrome.runtime.MessageSender,
	message: { tabId?: number; documentId?: string },
): boolean {
	const identity = sessionIdentityFromSender(sender);
	if (!identity) return message.documentId === undefined;
	return (message.tabId === undefined || message.tabId === identity.tabId)
		&& (message.documentId === undefined || message.documentId === identity.documentId);
}

function currentContentIdentityFromSender(
	sender: chrome.runtime.MessageSender,
): TabSessionIdentity | null {
	// session.current is v2-only and must identify one concrete content document.
	// Popup/offscreen callers have no tab, while pre-documentId senders cannot
	// safely distinguish a navigation boundary.
	if (sender.id !== chrome.runtime.id || !sender.tab?.id || !sender.documentId || !sender.url) {
		return null;
	}
	const identity = sessionIdentityFromSender(sender);
	return identity?.documentId === sender.documentId ? identity : null;
}

function snapshotMatchesIdentity(
	snapshot: AudioSessionSnapshot,
	identity: TabSessionIdentity,
): boolean {
	return snapshot.tabId === identity.tabId
		&& snapshot.documentId === identity.documentId
		&& snapshot.origin === identity.origin;
}

function normalizeVisualizerFrame(value: unknown): number[] | null {
	if (value instanceof ArrayBuffer) value = Array.from(new Uint8Array(value));
	if (!Array.isArray(value) || value.length > 4096) return null;
	if (!value.every((sample) => Number.isInteger(sample) && sample >= 0 && sample <= 255)) return null;
	return value as number[];
}

let subscribedPageTabs = new Set<number>();
let subscribedCaptureKey: string | null = null;
const visualizerSubscribers: VisualizerSubscriberLeases = new Map();
let visualizerExpiryTimer: ReturnType<typeof setTimeout> | null = null;
let visualizerExpiryAt: number | null = null;
let visualizerQueue: Promise<void> = Promise.resolve();

async function updateVisualizerSubscriptions(
	pageTabIds: number[],
	captureTabIds: number[],
): Promise<void> {
	// Content retains analyser intent across a WebAudio -> Capture handoff so it
	// can reattach if the existing processor returns to the page. That intent is
	// observational only: it never creates, keeps alive, or tears down a processor.
	const nextContentTabs = new Set(pageTabIds);
	for (const tabId of captureTabIds) {
		// A processor already captured before Popup opened is sampled entirely
		// offscreen and needs no new content analyser intent.
		if (subscribedPageTabs.has(tabId)) nextContentTabs.add(tabId);
	}
	const removedPageTabs = [...subscribedPageTabs].filter((tabId) => !nextContentTabs.has(tabId));
	const addedPageTabs = [...nextContentTabs].filter((tabId) => !subscribedPageTabs.has(tabId));
	const pageResults = await Promise.all([
		...removedPageTabs.map(async (tabId) => {
			const response = await sendSpectraTabRequest(
			tabId,
			'spectra.audio.visualizer.subscription.set',
			{ subscribed: false },
			).catch(() => null);
			return {
				tabId,
				action: 'remove' as const,
				accepted: response === null || (response.ok === true && response.data.subscribed === false),
			};
		}),
		...addedPageTabs.map(async (tabId) => {
			const response = await sendSpectraTabRequest(
			tabId,
			'spectra.audio.visualizer.subscription.set',
			{ subscribed: true },
			).catch(() => null);
			return {
				tabId,
				action: 'add' as const,
				accepted: response?.ok === true && response.data.subscribed === true,
			};
		}),
	]);
	// Page subscriptions are independent observation targets. One restricted,
	// navigating, or not-yet-ready tab must not suppress frames from every other
	// card in the same Popup batch. Track only acknowledgements so failed adds or
	// removals are retried on the next heartbeat without rolling back healthy tabs.
	const reconciledPageTabs = new Set(subscribedPageTabs);
	for (const result of pageResults) {
		if (!result.accepted) continue;
		if (result.action === 'add') reconciledPageTabs.add(result.tabId);
		else reconciledPageTabs.delete(result.tabId);
	}
	subscribedPageTabs = reconciledPageTabs;

	const captureKey = [...captureTabIds].sort((left, right) => left - right).join(',');
	if (captureKey !== subscribedCaptureKey) {
		const response = await sendOffscreenMessageIfPresent({
			type: 'OFFSCREEN_AUDIO_SET_VIZ_SUBSCRIPTIONS',
			tabIds: captureTabIds,
		}).catch(() => null);
		if (captureTabIds.length > 0 && (!response
			|| [...response.subscribedTabIds].sort((left, right) => left - right).join(',') !== captureKey)) {
			// Preserve the last acknowledged key so the next heartbeat retries the
			// offscreen reconciliation. Page-backed frames remain independently usable.
			return;
		}
		subscribedCaptureKey = captureKey;
	}
}

// note: one-release adapter for old popup contexts. Current content publishes
// acknowledged v2 session snapshots and current popup contexts consume them.
function broadcastLegacyUiSyncForOneRelease(
	tabId: number,
	payload: Record<string, unknown>,
): void {
	chrome.runtime.sendMessage({
		action: Actions.UI_SYNC,
		payload: { ...payload, tabId },
	}).catch(() => { });
}

function replaceVisualizerSubscribers(candidate: VisualizerSubscriberLeases): void {
	visualizerSubscribers.clear();
	for (const [subscriberId, subscriber] of candidate) {
		visualizerSubscribers.set(subscriberId, subscriber);
	}
}

function scheduleVisualizerLeaseExpiry(): void {
	const next = nextVisualizerSubscriberExpiry(visualizerSubscribers);
	if (next === null) {
		if (visualizerExpiryTimer) clearTimeout(visualizerExpiryTimer);
		visualizerExpiryTimer = null;
		visualizerExpiryAt = null;
		return;
	}
	// Keeping an already-earlier timer avoids a clear/set pair on every 15 Hz
	// heartbeat. At most one timer exists, and it wakes no more than once per TTL.
	if (visualizerExpiryTimer && visualizerExpiryAt !== null && visualizerExpiryAt <= next) return;
	if (visualizerExpiryTimer) clearTimeout(visualizerExpiryTimer);
	visualizerExpiryAt = next;
	visualizerExpiryTimer = setTimeout(() => {
		visualizerExpiryTimer = null;
		visualizerExpiryAt = null;
		const operation = visualizerQueue.then(async () => {
			const candidate = advanceVisualizerSubscriberLeases(visualizerSubscribers, Date.now());
			if (candidate === visualizerSubscribers) {
				scheduleVisualizerLeaseExpiry();
				return;
			}
			const union = visualizerSubscriberUnion(candidate);
			await updateVisualizerSubscriptions(
				union.filter((tabId) => captureStates.get(tabId) !== true),
				union.filter((tabId) => captureStates.get(tabId) === true),
			);
			replaceVisualizerSubscribers(candidate);
			scheduleVisualizerLeaseExpiry();
		});
		visualizerQueue = operation.then(() => undefined, () => {
			// A failed release does not revive the consumer. The next real request
			// reconciles the desired union, while the bounded tombstone remains.
			const candidate = advanceVisualizerSubscriberLeases(visualizerSubscribers, Date.now());
			replaceVisualizerSubscribers(candidate);
			scheduleVisualizerLeaseExpiry();
		});
	}, Math.max(0, next - Date.now()));
}

async function getVisualizerBatchNow(payload: VisualizerBatchPayload): Promise<{
	subscriberId: string;
	generation: number;
	frames: Record<string, number[] | null>;
}> {
	const plan = planVisualizerSubscriberLease(visualizerSubscribers, payload, Date.now());
	if (!plan.accepted && plan.candidate === visualizerSubscribers) {
		return {
			subscriberId: payload.subscriberId,
			generation: plan.responseGeneration,
			frames: {},
		};
	}
	const candidateSubscribers = plan.candidate;
	const unionTabIds = visualizerSubscriberUnion(candidateSubscribers);
	const unionCaptureTabIds = unionTabIds.filter((tabId) => captureStates.get(tabId) === true);
	const unionPageTabIds = unionTabIds.filter((tabId) => captureStates.get(tabId) !== true);
	await updateVisualizerSubscriptions(unionPageTabIds, unionCaptureTabIds);
	replaceVisualizerSubscribers(candidateSubscribers);
	scheduleVisualizerLeaseExpiry();
	if (!plan.accepted) {
		return {
			subscriberId: payload.subscriberId,
			generation: plan.responseGeneration,
			frames: {},
		};
	}

	const { tabIds } = payload;
	const frames: Record<string, number[] | null> = Object.fromEntries(
		tabIds.map((tabId) => [String(tabId), null]),
	);
	const captureTabIds = tabIds.filter((tabId) => captureStates.get(tabId) === true);
	const pageTabIds = tabIds.filter((tabId) => captureStates.get(tabId) !== true);
	if (captureTabIds.length > 0) {
		const result = await sendOffscreenMessageIfPresent({
			type: 'OFFSCREEN_AUDIO_GET_VIZ_BATCH',
			tabIds: captureTabIds,
		}).catch(() => undefined);
		for (const tabId of captureTabIds) {
			frames[String(tabId)] = normalizeVisualizerFrame(result?.frames?.[String(tabId)]);
		}
	}

	await Promise.all(pageTabIds.map(async (tabId) => {
		const response = await sendSpectraTabRequest(
			tabId,
			'spectra.audio.visualizer.get',
			{},
		).catch(() => null);
		const buffer = response?.ok ? response.data.buffer : null;
		frames[String(tabId)] = normalizeVisualizerFrame(buffer);
	}));

	return { subscriberId: payload.subscriberId, generation: payload.generation, frames };
}

function getVisualizerBatch(payload: VisualizerBatchPayload): Promise<{
	subscriberId: string;
	generation: number;
	frames: Record<string, number[] | null>;
}> {
	const result = visualizerQueue.then(() => getVisualizerBatchNow(payload));
	visualizerQueue = result.then(() => undefined, () => undefined);
	return result;
}

function releaseDisconnectedVisualizerSubscriber(subscriberId: string): void {
	const operation = visualizerQueue.then(async () => {
		// Each Popup uses a random page-lifetime id. A maximal tombstone makes a
		// delayed unload batch unable to resurrect a disconnected subscriber even
		// if the Port closed before its first request reached the worker.
		const plan = planVisualizerSubscriberLease(visualizerSubscribers, {
			subscriberId,
			generation: Number.MAX_SAFE_INTEGER,
			tabIds: [],
		}, Date.now());
		const candidate = plan.candidate;
		const union = visualizerSubscriberUnion(candidate);
		await updateVisualizerSubscriptions(
			union.filter((tabId) => captureStates.get(tabId) !== true),
			union.filter((tabId) => captureStates.get(tabId) === true),
		).catch(() => false);
		replaceVisualizerSubscribers(candidate);
		scheduleVisualizerLeaseExpiry();
	});
	visualizerQueue = operation.then(() => undefined, () => undefined);
}

export function registerAudioV2Listener(): void {
	chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
		if (!message || typeof message !== 'object') return false;
		const candidate = message as { protocolVersion?: unknown; type?: unknown };
		const isBackgroundAudioType = candidate.type === 'spectra.audio.config.get'
			|| candidate.type === 'spectra.audio.config.set'
			|| candidate.type === 'spectra.audio.session.get'
			|| candidate.type === 'spectra.audio.session.current'
			|| candidate.type === 'spectra.audio.session.publish'
			|| candidate.type === 'spectra.audio.session.flush'
			|| candidate.type === 'spectra.audio.visualizer.batch';
		if (candidate.protocolVersion !== SPECTRA_PROTOCOL_VERSION
			|| typeof candidate.type !== 'string'
			|| !isBackgroundAudioType) return false;
		if (sender.id && sender.id !== chrome.runtime.id) {
			sendResponse(rpcFailure('forbidden', 'Audio session RPC is extension-internal only'));
			return false;
		}
		if (!isSpectraRequestEnvelope(message)
			|| (message.type !== 'spectra.audio.config.get'
				&& message.type !== 'spectra.audio.config.set'
				&& message.type !== 'spectra.audio.session.get'
				&& message.type !== 'spectra.audio.session.current'
				&& message.type !== 'spectra.audio.session.publish'
				&& message.type !== 'spectra.audio.session.flush'
				&& message.type !== 'spectra.audio.visualizer.batch')) {
			sendResponse(rpcFailure('invalid_request', 'Malformed audio session request'));
			return false;
		}
		const currentIdentity = message.type === 'spectra.audio.session.current'
			? currentContentIdentityFromSender(sender)
			: null;
		if (message.type === 'spectra.audio.session.current' && !currentIdentity) {
			sendResponse(rpcFailure(
				'forbidden',
				'Current audio session requires an extension content-document sender',
			));
			return false;
		}
		if (!senderMatchesEnvelope(sender, message)) {
			sendResponse(rpcFailure('forbidden', 'Audio request identity does not match its sender'));
			return false;
		}
		const operation = async () => {
			if (message.type === 'spectra.audio.config.get') {
				const identity = sessionIdentityFromSender(sender);
				if (!identity) throw new Error('Audio configuration requires a document identity');
				return resolveAudioConfigForSender(sender);
			}
			if (message.type === 'spectra.audio.config.set') {
				const identity = sessionIdentityFromSender(sender);
				if (!identity) throw new Error('Audio configuration requires a document identity');
				await storage.tabSession.merge(
					identity.tabId,
					audioConfigToControlSessionPatch(message.payload.config),
					identity,
				);
				return { saved: true as const };
			}
			if (message.type === 'spectra.audio.session.get') {
				return getAudioSession(message.payload.tabId);
			}
			if (message.type === 'spectra.audio.session.current') {
				if (!currentIdentity) throw new Error('Current audio session identity was lost');
				const snapshot = await getAudioSession(currentIdentity.tabId);
				return snapshot && snapshotMatchesIdentity(snapshot, currentIdentity)
					? snapshot
					: null;
			}
			if (message.type === 'spectra.audio.session.publish') {
				const identity = sessionIdentityFromSender(sender);
				if (!identity || message.generation === undefined) {
					throw new Error('Audio session publish requires a document identity and generation');
				}
				const snapshot = await updateAudioSession(identity, {
					config: message.payload.config,
					desiredMode: message.payload.desiredMode,
					actualMode: message.payload.actualMode,
					phase: message.payload.phase,
					generation: message.generation,
					error: message.payload.lastError,
				});
				await updateBadgeFromSession(snapshot, message.payload.userInteracted);
				return snapshot;
			}
			if (message.type === 'spectra.audio.session.flush') {
				const tabId = message.tabId ?? sender.tab?.id;
				if (!tabId) throw new Error('Audio session flush requires a tab identity');
				await Promise.all([
					storage.tabSession.flush(tabId),
					flushAudioSessions(tabId),
				]);
				return { flushed: true as const };
			}
			return getVisualizerBatch(message.payload);
		};
		void operation()
			.then((result) => sendResponse(rpcSuccess(result)))
			.catch((error) => sendResponse(rpcFailure(
				'audio_unavailable',
				error instanceof Error ? error.message : String(error),
				true,
			)));
		return true;
	});
}

// eff: registers listeners for AUDIO_GET_STATUS, AUDIO_SET_CONFIG, and UI_SYNC actions
export function registerAudioHandlers(): void {
	registerAudioV2Listener();
	chrome.runtime.onConnect.addListener((port) => {
		const prefix = 'spectra-visualizer:';
		if ((port.sender?.id && port.sender.id !== chrome.runtime.id)
			|| !port.name.startsWith(prefix)) return;
		const subscriberId = port.name.slice(prefix.length);
		if (!/^popup-[a-z0-9-]{1,100}$/iu.test(subscriberId)) return;
		port.onDisconnect.addListener(() => {
			releaseDisconnectedVisualizerSubscriber(subscriberId);
		});
	});
	chrome.webNavigation.onCommitted.addListener((details) => {
		if (details.frameId !== 0) return;
		// A top-level navigation replaces the content document while preserving
		// tabId. Serialize invalidation behind any active batch so the next popup
		// heartbeat replays the analyser lease into the new document.
		const invalidation = visualizerQueue.then(
			() => { subscribedPageTabs.delete(details.tabId); },
			() => { subscribedPageTabs.delete(details.tabId); },
		);
		visualizerQueue = invalidation.then(() => undefined, () => undefined);
	});
	chrome.tabs.onRemoved.addListener((tabId) => {
		const candidate = removeVisualizerTab(visualizerSubscribers, tabId);
		if (candidate === visualizerSubscribers) return;
		replaceVisualizerSubscribers(candidate);
		const union = visualizerSubscriberUnion(visualizerSubscribers);
		void updateVisualizerSubscriptions(
			union.filter((candidate) => captureStates.get(candidate) !== true),
			union.filter((candidate) => captureStates.get(candidate) === true),
		);
		scheduleVisualizerLeaseExpiry();
	});
	router.on(Actions.AUDIO_GET_STATUS, async (_, sender) => {
		const tabId = sender.tab?.id;
		const config = await resolveAudioConfigForSender(sender);

		const isCapture = tabId ? (captureStates.get(tabId) ?? false) : false;

		// post: returns baseline configuration; runtime playback state is refined by the content script
		return { config, hasAudio: true, isPlaying: false, mode: isCapture ? 'CAPTURE' : 'NATIVE_WEBAUDIO', userInteracted: false };
	});

	// eff: syncs config to tab session only (not domain preset)
	router.on(Actions.AUDIO_SET_CONFIG, async (req, sender) => {
		const tabId = sender.tab?.id;
		const identity = sessionIdentityFromSender(sender);
		if (!tabId || !identity) return { success: false };

		if (req.config) {
			type RuntimeAudioPatch = Partial<AudioConfig> & { toggleMute?: boolean; volumeDelta?: number; isNativeSync?: boolean };
			const {
				toggleMute: _toggleMute,
				volumeDelta: _volumeDelta,
				isNativeSync: _isNativeSync,
				...persistentConfig
			} = req.config as RuntimeAudioPatch;
			// rule: log storage write failure — the previous empty catch silently swallowed
			// quota/unavailable errors while the handler returned success:true, so the user's
			// audio config silently reverted to the prior value on next content script load.
			try {
				await storage.tabSession.merge(
					tabId,
					audioConfigPatchToControlSessionPatch(persistentConfig),
					identity,
				);
			} catch (error) {
				swLog.warn('audio: tabSession.merge failed; config not persisted', {
					tabId,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}
		return { success: true };
	});

	// eff: forwards UI_SYNC from Content Script to all extension pages (Popup)
	// rule: this is critical for real-time UI sync when volume changes from native controls, hotkeys, etc.
	router.on(Actions.UI_SYNC, async (req, sender) => {
		const tabId = sender.tab?.id;
		if (!tabId) return;
		const identity = sessionIdentityFromSender(sender);
		const runtime = req as typeof req & {
			desiredMode?: unknown;
			phase?: unknown;
			generation?: number;
			lastError?: string;
		};
		if (identity) {
			await updateAudioSession(identity, {
				config: req.config,
				desiredMode: runtime.desiredMode,
				actualMode: req.mode,
				phase: runtime.phase,
				generation: runtime.generation,
				error: runtime.lastError ?? null,
			});
		}

		broadcastLegacyUiSyncForOneRelease(tabId, req);
	});
}
