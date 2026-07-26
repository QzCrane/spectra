// goal: serialize tab-capture transitions and publish only offscreen-acknowledged state

import {
	Actions,
	DEFAULT_AUDIO_CONFIG,
	SPECTRA_PROTOCOL_VERSION,
	isOffscreenHostEvent,
	isSpectraRequestEnvelope,
	resolveAudioVolume,
	rpcFailure,
	rpcSuccess,
	type AudioCaptureState,
	type AudioConfig,
	type AudioProcessorConfig,
	type AudioSessionSnapshot,
	type SpectraEventEnvelope,
	type SpectraAudioMode,
	type TabSessionIdentity,
} from '@nexus/contracts';
import { audioGraphSignature } from '@nexus/audio-engine';
import { router, captureStates } from '../state';
import {
	acquireOffscreenLease,
	reconcileOffscreenHost,
	releaseOffscreenLease,
	rollbackOffscreenLeaseAcquisition,
	sendOffscreenMessage,
	sendOffscreenMessageIfPresent,
} from '../offscreen-coordinator';
import { swLog } from '../../shared/logger';
import {
	getAudioSession,
	identityFromSender,
	isAudioSessionIdentityInvalidated,
	updateAudioSession,
} from '../audio-session-store';
import { updateBadgeFromSession } from './badge';

interface CaptureRuntimeState {
	generation: number;
	controlRevision: number;
	phase: 'idle' | 'starting' | 'active' | 'stopping' | 'error';
	active: boolean;
	lastError?: string;
	actualConfig?: AudioConfig;
	identity?: TabSessionIdentity;
}

function actualConfigFromProcessor(
	requested: AudioConfig,
	processor: AudioProcessorConfig,
): AudioConfig {
	const volumeBase = resolveAudioVolume(requested).volumeBase;
	return {
		...requested,
		volumeBase,
		boost: processor.boostGain,
		volume: Math.round(volumeBase * processor.boostGain * 100) / 100,
		bass: processor.bass,
		eqValues: [...processor.eqValues],
		compressor: processor.compressor,
		mono: processor.mono,
		pan: processor.pan,
		delay: processor.delay,
	};
}

const sessions = new Map<number, CaptureRuntimeState>();
const transitions = new Map<number, Promise<unknown>>();
const OFFSCREEN_ACK_TIMEOUT_MS = 15_000;
const OFFSCREEN_CANCEL_TIMEOUT_MS = 2_000;
const ORPHAN_STOP_RETRY_DELAYS_MS = [25, 75] as const;
let captureReadiness: Promise<void> = Promise.resolve();

function beginCaptureReconciliation(): Promise<void> {
	const reconciliation = reconcileCaptureStates();
	captureReadiness = reconciliation;
	void reconciliation.catch((error) => {
		swLog.warn('Unable to reconcile the offscreen capture host', error);
	});
	return reconciliation;
}

export async function ensureCaptureStatesReconciled(): Promise<void> {
	const current = captureReadiness;
	try {
		await current;
	} catch {
		// A failed live-host handshake remains fail-closed, but it must not brick
		// capture until the next service-worker restart. The first later operation
		// owns one new bounded reconciliation; concurrent callers share it.
		if (captureReadiness === current) beginCaptureReconciliation();
		await captureReadiness;
	}
}

function isStaleContentSender(sender: chrome.runtime.MessageSender): boolean {
	if (!sender.tab) return false;
	const identity = identityFromSender(sender);
	return !identity || isAudioSessionIdentityInvalidated(identity);
}

function getSession(tabId: number): CaptureRuntimeState {
	let session = sessions.get(tabId);
	if (!session) {
		session = { generation: 0, controlRevision: 0, phase: 'idle', active: false };
		sessions.set(tabId, session);
	}
	return session;
}

function toCaptureState(tabId: number, state = getSession(tabId)): AudioCaptureState {
	return {
		tabId,
		generation: state.generation,
		phase: state.phase,
		active: state.active,
		actualMode: state.active ? 'capture' : 'bypass',
		...(state.active && state.actualConfig
			? { actualConfig: { ...state.actualConfig, eqValues: [...state.actualConfig.eqValues] } }
			: {}),
		lastError: state.lastError
			? { code: 'capture_error', message: state.lastError, retryable: true }
			: null,
	};
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
		promise.then(
			(value) => { clearTimeout(timer); resolve(value); },
			(error) => { clearTimeout(timer); reject(error); },
		);
	});
}

function getMediaStreamId(tabId: number): Promise<string> {
	return new Promise((resolve, reject) => {
		chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }, (streamId) => {
			if (chrome.runtime.lastError) {
				reject(new Error(chrome.runtime.lastError.message || 'Tab capture failed'));
			} else if (!streamId) {
				reject(new Error('No stream ID returned'));
			} else {
				resolve(streamId);
			}
		});
	});
}

// note: one-release adapter for extension pages and content contexts that were
// already loaded with the v1 capture envelope during an extension update.
function broadcastLegacyCaptureStateForOneRelease(
	tabId: number,
	payload: Record<string, unknown>,
): void {
	chrome.tabs.sendMessage(tabId, { action: Actions.CAPTURE_STATE_CHANGE, payload }).catch(() => { });
	chrome.runtime.sendMessage({ action: Actions.CAPTURE_STATE_CHANGE, payload }).catch(() => { });
}

function publishCaptureState(tabId: number, state: CaptureRuntimeState): void {
	captureStates.set(tabId, state.active);
	const payload = {
		tabId,
		enabled: state.active,
		actualMode: state.active ? 'capture' : 'bypass',
		phase: state.phase,
		generation: state.generation,
		error: state.lastError,
	};
	broadcastLegacyCaptureStateForOneRelease(tabId, payload);
	const event: SpectraEventEnvelope<'spectra.audio.capture.changed'> = {
		protocolVersion: SPECTRA_PROTOCOL_VERSION,
		type: 'spectra.audio.capture.changed',
		tabId,
		generation: state.generation,
		payload: toCaptureState(tabId, state),
	};
	chrome.tabs.sendMessage(tabId, event).catch(() => { });
	chrome.runtime.sendMessage(event).catch(() => { });
}

async function commitCaptureSnapshot(
	tabId: number,
	state: CaptureRuntimeState,
	update: {
		actualMode?: SpectraAudioMode;
		phase: CaptureRuntimeState['phase'];
		config?: AudioConfig;
		error?: string | null;
	},
): Promise<AudioSessionSnapshot | null> {
	const current = await getAudioSession(tabId);
	const identity = state.identity ?? current;
	if (!identity) return null;
	if (current
		&& (current.documentId !== identity.documentId || current.origin !== identity.origin)) {
		// A late ACK from a torn-down document must never replace the new document's snapshot.
		return null;
	}
	if (isAudioSessionIdentityInvalidated(identity)) {
		// rule: a stale document identity (e.g., from a capture session whose tab
		// navigated or was closed before OFFSCREEN_AUDIO_ENDED arrived) must not
		// reach updateAudioSession, which would throw StaleAudioSessionError and
		// escape as an unhandled rejection through the void serializeTransition
		// caller in registerOffscreenAudioLifecycleListener.
		return null;
	}
	return updateAudioSession(identity, {
		config: update.config,
		desiredMode: current?.desiredMode
			?? (update.actualMode === 'capture' ? 'capture' : 'bypass'),
		actualMode: update.actualMode,
		phase: update.phase,
		generation: state.generation,
		error: update.error,
	});
}

// post: the authoritative snapshot event is emitted before the compatibility
// capture event, so UI consumers can never observe an ACK as a predicted mode.
async function publishAcknowledgedCaptureState(
	tabId: number,
	state: CaptureRuntimeState,
	update: Parameters<typeof commitCaptureSnapshot>[2],
): Promise<void> {
	const snapshot = await commitCaptureSnapshot(tabId, state, update);
	if (snapshot) await updateBadgeFromSession(snapshot, false);
	publishCaptureState(tabId, state);
}

function serializeTransition<T>(tabId: number, operation: () => Promise<T>): Promise<T> {
	const previous = transitions.get(tabId) ?? Promise.resolve();
	const next = previous.catch(() => undefined).then(async () => {
		await ensureCaptureStatesReconciled();
		return operation();
	});
	transitions.set(tabId, next);
	void next.finally(() => {
		if (transitions.get(tabId) === next) transitions.delete(tabId);
	});
	return next;
}

async function cancelFailedStart(
	tabId: number,
	generation: number,
	stopCommitted: boolean,
): Promise<void> {
	try {
		await withTimeout(
			Promise.resolve(sendOffscreenMessageIfPresent({
				type: 'OFFSCREEN_AUDIO_CANCEL_START',
				tabId,
				generation,
				stopCommitted,
			})),
			OFFSCREEN_CANCEL_TIMEOUT_MS,
			'Offscreen audio processor did not acknowledge startup cancellation',
		);
	} catch (error) {
		swLog.warn(`Tab ${tabId}: unable to confirm failed capture cancellation`, error);
	}
}

async function startCapture(
	tabId: number,
	config: AudioConfig,
	requestedGeneration?: number,
	identity?: TabSessionIdentity,
) {
	const state = getSession(tabId);
	if (identity) state.identity = identity;
	if (requestedGeneration !== undefined && requestedGeneration < state.generation) {
		return {
			status: 'processing' as const,
			phase: state.phase,
			active: state.active,
			generation: state.generation,
		};
	}
	if (state.active
		&& state.phase === 'active'
		&& requestedGeneration !== undefined
		&& requestedGeneration <= state.generation) {
		return { status: 'processing' as const, phase: state.phase, active: true, generation: state.generation };
	}
	const wasActive = state.active;
	// A STOP/CANCEL tombstone is intentionally permanent in the offscreen host.
	// Retrying a failed or idle same-generation START must advance beyond it.
	let generation = requestedGeneration === undefined || requestedGeneration === state.generation
		? state.generation + 1
		: requestedGeneration;
	const controlRevision = state.controlRevision + 1;
	state.generation = generation;
	state.phase = 'starting';
	state.lastError = undefined;
	publishCaptureState(tabId, state);

	let acquiredLease = false;
	try {
		acquiredLease = await acquireOffscreenLease(`audio:${tabId}`);
		const streamId = await getMediaStreamId(tabId);
		const startHost = (startGeneration: number) => withTimeout(
			sendOffscreenMessage({
				type: 'OFFSCREEN_AUDIO_START',
				tabId,
				streamId,
				config,
				generation: startGeneration,
				controlRevision,
			}),
			OFFSCREEN_ACK_TIMEOUT_MS,
			'Offscreen audio processor did not acknowledge startup',
		);
		let result = await startHost(generation);
		if (!result?.ok
			&& result?.error?.code === 'stale_capture_intent'
			&& result.generation >= generation) {
			// An idle offscreen document can outlive the worker/document that minted
			// its STOP tombstone. Adopt that authoritative generation and retry once
			// inside this serialized transaction; repeated user input must never be
			// required to count up to an otherwise invisible tombstone.
			generation = result.generation + 1;
			state.generation = generation;
			result = await startHost(generation);
		}

		if (state.generation !== generation) {
			return { status: 'processing' as const, phase: state.phase, generation: state.generation };
		}
		if (result?.ok && result.phase === 'active' && result.generation > generation
			&& audioGraphSignature(result.normalizedActualConfig) === result.graphSignature) {
			// The host is authoritative after a worker restart. Preserve its processor
			// and lease instead of treating a lower-generation retry as startup failure.
			state.generation = result.generation;
			state.controlRevision = result.controlRevision;
			state.active = true;
			state.phase = 'active';
			state.actualConfig = actualConfigFromProcessor(config, result.normalizedActualConfig);
			await publishAcknowledgedCaptureState(tabId, state, {
				actualMode: 'capture',
				phase: 'active',
				config: state.actualConfig,
				error: null,
			});
			return {
				status: 'processing' as const,
				phase: 'active' as const,
				active: true,
				generation: result.generation,
			};
		}
		if (!result?.ok
			|| result.phase !== 'active'
			|| result.generation !== generation
			|| result.controlRevision !== controlRevision
			|| result.contextState !== 'running'
			|| audioGraphSignature(result.normalizedActualConfig) !== result.graphSignature) {
			throw new Error(result?.error?.message || 'Offscreen audio processor rejected startup');
		}

		state.active = true;
		state.controlRevision = result.controlRevision;
		state.phase = 'active';
		state.actualConfig = actualConfigFromProcessor(config, result.normalizedActualConfig);
		await publishAcknowledgedCaptureState(tabId, state, {
			actualMode: 'capture',
			phase: 'active',
			config: state.actualConfig,
			error: null,
		});
		swLog.capture(`Tab ${tabId}: capture active (generation ${generation})`);
		return { status: 'processing' as const, phase: 'active' as const, active: true, generation };
	} catch (error) {
		// runtime.sendMessage cannot cancel an in-flight offscreen handler. Leave an
		// explicit generation tombstone so delayed getUserMedia()/resume() work is
		// disposed instead of committing after the lease is rolled back.
		await cancelFailedStart(tabId, generation, !wasActive);
		if (state.generation === generation) {
			state.active = wasActive;
			state.phase = 'error';
			state.lastError = error instanceof Error ? error.message : String(error);
			await publishAcknowledgedCaptureState(tabId, state, {
				actualMode: state.active ? 'capture' : undefined,
				phase: 'error',
				error: state.lastError,
			});
		}
		rollbackOffscreenLeaseAcquisition(`audio:${tabId}`, acquiredLease);
		return {
			status: 'error' as const,
			phase: 'error' as const,
			active: state.active,
			generation,
			error: state.lastError,
		};
	}
}

async function stopCapture(
	tabId: number,
	requestedGeneration?: number,
	identity?: TabSessionIdentity,
) {
	const state = getSession(tabId);
	if (identity) state.identity = identity;
	if (requestedGeneration !== undefined && requestedGeneration < state.generation) {
		return {
			status: 'processing' as const,
			phase: state.phase,
			active: state.active,
			generation: state.generation,
		};
	}
	const generation = requestedGeneration ?? state.generation + 1;
	state.generation = generation;
	state.phase = 'stopping';
	state.lastError = undefined;
	publishCaptureState(tabId, state);

	let releaseLease = false;
	try {
		const result = await withTimeout(
			sendOffscreenMessageIfPresent({ type: 'OFFSCREEN_AUDIO_STOP', tabId, generation }),
			OFFSCREEN_ACK_TIMEOUT_MS,
			'Offscreen audio processor did not acknowledge shutdown',
		);
		if (!result) {
			state.active = false;
			state.phase = 'idle';
			state.actualConfig = undefined;
			releaseLease = true;
			await publishAcknowledgedCaptureState(tabId, state, {
				actualMode: 'bypass',
				phase: 'idle',
				config: { ...DEFAULT_AUDIO_CONFIG, eqValues: [...DEFAULT_AUDIO_CONFIG.eqValues] },
				error: null,
			});
			return { status: 'processing' as const, phase: 'idle' as const, active: false, generation };
		}
		if (state.generation !== generation) {
			return { status: 'processing' as const, phase: state.phase, generation: state.generation };
		}
		if (result?.ok && result.phase === 'active' && result.generation > generation
			&& audioGraphSignature(result.normalizedActualConfig) === result.graphSignature) {
			await acquireOffscreenLease(`audio:${tabId}`);
			state.generation = result.generation;
			state.controlRevision = result.controlRevision;
			state.active = true;
			state.phase = 'error';
			state.actualConfig = actualConfigFromProcessor(
				state.actualConfig ?? DEFAULT_AUDIO_CONFIG,
				result.normalizedActualConfig,
			);
			state.lastError = 'A newer capture processor is still active';
			await publishAcknowledgedCaptureState(tabId, state, {
				actualMode: 'capture',
				phase: 'error',
				error: state.lastError,
			});
			return {
				status: 'error' as const,
				phase: 'error' as const,
				active: true,
				generation: result.generation,
				error: state.lastError,
			};
		}
		if (!result?.ok || result.phase !== 'idle' || result.generation !== generation) {
			throw new Error(result?.error?.message || 'Offscreen audio processor rejected shutdown');
		}
		state.active = false;
		state.controlRevision = result.controlRevision;
		state.phase = 'idle';
		state.actualConfig = undefined;
		releaseLease = true;
		await publishAcknowledgedCaptureState(tabId, state, {
			actualMode: 'bypass',
			phase: 'idle',
			config: { ...DEFAULT_AUDIO_CONFIG, eqValues: [...DEFAULT_AUDIO_CONFIG.eqValues] },
			error: null,
		});
		return { status: 'processing' as const, phase: 'idle' as const, active: false, generation };
	} catch (error) {
		if (state.generation === generation) {
			// A failed stop does not prove that the processor stopped. Preserve the
			// acknowledged active state and its lease so callers can safely retry.
			state.phase = 'error';
			state.lastError = error instanceof Error ? error.message : String(error);
			await publishAcknowledgedCaptureState(tabId, state, {
				actualMode: state.active ? 'capture' : undefined,
				phase: 'error',
				error: state.lastError,
			});
		}
		return {
			status: 'error' as const,
			phase: state.phase,
			active: state.active,
			generation,
			error: state.lastError,
		};
	} finally {
		if (releaseLease) releaseOffscreenLease(`audio:${tabId}`);
	}
}

async function updateCaptureConfig(
	tabId: number,
	config: AudioConfig,
	requestedGeneration: number,
	identity?: TabSessionIdentity,
): Promise<{ ok: boolean; generation: number; error?: string }> {
	return serializeTransition(tabId, async () => {
		const state = getSession(tabId);
		if (identity) state.identity = identity;
		if (requestedGeneration < state.generation) {
			return { ok: false, generation: state.generation, error: 'Stale capture configuration update' };
		}
		if (!state.active) {
			return { ok: false, generation: state.generation, error: 'Capture is not active' };
		}
		try {
			const controlRevision = state.controlRevision + 1;
			const result = await sendOffscreenMessage({
				type: 'OFFSCREEN_AUDIO_UPDATE',
				tabId,
				generation: requestedGeneration,
				controlRevision,
				config,
			});
			if (!result?.ok
				|| result.phase !== 'active'
				|| result.generation !== requestedGeneration
				|| result.controlRevision !== controlRevision
				|| result.contextState !== 'running'
				|| audioGraphSignature(result.normalizedActualConfig) !== result.graphSignature) {
				state.lastError = result?.error?.message || 'Capture configuration update failed';
				await publishAcknowledgedCaptureState(tabId, state, {
					actualMode: state.active ? 'capture' : undefined,
					phase: state.phase,
					error: state.lastError,
				});
				return { ok: false, generation: state.generation, error: state.lastError };
			}
			state.generation = requestedGeneration;
			state.controlRevision = result.controlRevision;
			state.actualConfig = actualConfigFromProcessor(config, result.normalizedActualConfig);
			state.lastError = undefined;
			await commitCaptureSnapshot(tabId, state, {
				actualMode: 'capture',
				phase: 'active',
				config: state.actualConfig,
				error: null,
			});
			return { ok: true, generation: state.generation };
		} catch (error) {
			state.lastError = error instanceof Error ? error.message : String(error);
			await publishAcknowledgedCaptureState(tabId, state, {
				actualMode: state.active ? 'capture' : undefined,
				phase: state.phase,
				error: state.lastError,
			});
			return { ok: false, generation: state.generation, error: state.lastError };
		}
	});
}

function registerCaptureV2Listener(): void {
	chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
		if (!message || typeof message !== 'object') return false;
		const candidate = message as { protocolVersion?: unknown; type?: unknown };
		if (candidate.protocolVersion !== SPECTRA_PROTOCOL_VERSION
			|| typeof candidate.type !== 'string'
			|| !candidate.type.startsWith('spectra.audio.capture.')) return false;
		if (sender.id && sender.id !== chrome.runtime.id) {
			sendResponse(rpcFailure('forbidden', 'Capture RPC is extension-internal only'));
			return false;
		}
		if (!isSpectraRequestEnvelope(message)
			|| (message.type !== 'spectra.audio.capture.set'
				&& message.type !== 'spectra.audio.capture.config')) {
			sendResponse(rpcFailure('invalid_request', 'Malformed capture request'));
			return false;
		}
		const senderTabId = sender.tab?.id;
		const tabId = senderTabId ?? message.tabId;
		if (!tabId || (senderTabId !== undefined && message.tabId !== undefined && message.tabId !== senderTabId)) {
			sendResponse(rpcFailure('forbidden', 'Capture request requires a fixed target tab'));
			return false;
		}
		if ((senderTabId !== undefined && isStaleContentSender(sender)) || message.generation === undefined) {
			sendResponse(rpcFailure('stale_document', 'Capture request belongs to a stale document', true));
			return false;
		}
		const generation = message.generation;
		const identity = senderTabId === undefined ? undefined : identityFromSender(sender) ?? undefined;

		const operation = async (): Promise<AudioCaptureState> => {
			if (message.type === 'spectra.audio.capture.set') {
				await serializeTransition(tabId, async () => message.payload.enabled
					? startCapture(tabId, message.payload.config, generation, identity)
					: stopCapture(tabId, generation, identity));
				return toCaptureState(tabId);
			}
			const result = await updateCaptureConfig(tabId, message.payload.config, generation, identity);
			if (!result.ok) {
				const state = getSession(tabId);
				state.lastError = result.error;
			}
			return toCaptureState(tabId);
		};

		void operation()
			.then((state) => sendResponse(rpcSuccess(state)))
			.catch((error) => sendResponse(rpcFailure(
				'capture_unavailable',
				error instanceof Error ? error.message : String(error),
				true,
			)));
		return true;
	});
}

function registerOffscreenAudioLifecycleListener(): void {
	chrome.runtime.onMessage.addListener((message: unknown, sender) => {
		if (!isOffscreenHostEvent(message) || message.type !== 'OFFSCREEN_AUDIO_ENDED') return false;
		if (sender.id !== chrome.runtime.id || sender.tab
			|| (sender.url !== undefined && sender.url !== chrome.runtime.getURL('offscreen.html'))) return false;

		const { tabId, generation } = message;
		void serializeTransition(tabId, async () => {
			const state = getSession(tabId);
			if (generation < state.generation && state.active) return;
			state.generation = Math.max(state.generation, generation);
			state.active = false;
			state.phase = 'error';
			state.lastError = 'The tab capture stream ended unexpectedly';
			try {
				await publishAcknowledgedCaptureState(tabId, state, {
					actualMode: 'bypass',
					phase: 'error',
					config: { ...DEFAULT_AUDIO_CONFIG, eqValues: [...DEFAULT_AUDIO_CONFIG.eqValues] },
					error: state.lastError,
				});
			} catch (error) {
				// rule: publishAcknowledgedCaptureState may reject if the audio
				// session store throws (e.g., StaleAudioSessionError when the tab
				// navigated before OFFSCREEN_AUDIO_ENDED arrived). The lease must
				// still be released so the offscreen host can drop the processor;
				// without this catch the rejection escaped via `void` and surfaced
				// as `Uncaught (in promise) StaleAudioSessionError`.
				swLog.warn(`Tab ${tabId}: unable to publish capture-ended state`, error);
			} finally {
				releaseOffscreenLease(`audio:${tabId}`);
			}
		});
		return false;
	});
}

export function registerCaptureHandlers(): void {
	registerCaptureV2Listener();
	registerOffscreenAudioLifecycleListener();
	router.on(Actions.CAPTURE_TOGGLE, async (request, sender) => {
		const tabId = request.tabId ?? sender.tab?.id;
		if (!tabId) return { status: 'error' as const, error: 'No tab ID' };
		if (isStaleContentSender(sender)) {
			return { status: 'error' as const, phase: 'error' as const, active: false, error: 'Stale document' };
		}
		return serializeTransition(tabId, async () => {
			const identity = identityFromSender(sender) ?? undefined;
			if (request.enabled) {
				return startCapture(
					tabId,
					request.config as AudioConfig,
					'generation' in request ? Number(request.generation) : undefined,
					identity,
				);
			}
			return stopCapture(
				tabId,
				'generation' in request ? Number(request.generation) : undefined,
				identity,
			);
		});
	});

	router.on(Actions.CAPTURE_GET_STATE, async (request, sender) => {
		const tabId = request.tabId ?? sender.tab?.id;
		return tabId ? getSession(tabId).active : false;
	});

	router.on(Actions.CAPTURE_UPDATE_CONFIG, async (request, sender) => {
		const tabId = request.tabId ?? sender.tab?.id;
		if (!tabId) return { ok: false, generation: 0, error: 'No tab ID' };
		if (isStaleContentSender(sender)) {
			return { ok: false, generation: 0, error: 'Stale document' };
		}
		const state = getSession(tabId);
		const requestedGeneration = 'generation' in request ? Number(request.generation) : state.generation;
		return updateCaptureConfig(
			tabId,
			request.config,
			requestedGeneration,
			identityFromSender(sender) ?? undefined,
		);
	});

	beginCaptureReconciliation();
}

async function stopRecoveredOrphan(tabId: number, hostGeneration: number): Promise<void> {
	let stopGeneration = hostGeneration + 1;
	let lastError: unknown = new Error('Offscreen audio processor did not acknowledge shutdown');
	for (let attempt = 0; attempt <= ORPHAN_STOP_RETRY_DELAYS_MS.length; attempt += 1) {
		try {
			const result = await withTimeout(
				Promise.resolve(sendOffscreenMessageIfPresent({
					type: 'OFFSCREEN_AUDIO_STOP',
					tabId,
					generation: stopGeneration,
				})),
				OFFSCREEN_ACK_TIMEOUT_MS,
				'Offscreen audio processor did not acknowledge orphan shutdown',
			);
			if (result?.ok && result.phase === 'idle' && result.generation >= stopGeneration) {
				releaseOffscreenLease(`audio:${tabId}`);
				return;
			}
			if (result?.ok && result.phase === 'active' && result.generation >= stopGeneration) {
				stopGeneration = result.generation + 1;
			}
			lastError = new Error(result?.error?.message
				?? `Offscreen host did not confirm tab ${tabId} was idle`);
		} catch (error) {
			lastError = error;
		}

		const retryDelay = ORPHAN_STOP_RETRY_DELAYS_MS[attempt];
		if (retryDelay !== undefined) {
			await new Promise<void>((resolve) => setTimeout(resolve, retryDelay));
		}
	}

	// Keep the recovered lease: an unacknowledged STOP does not prove the host
	// released its processor, and dropping ownership could close/recreate over it.
	const detail = lastError instanceof Error ? lastError.message : String(lastError);
	throw new Error(`Unable to stop recovered capture for closed tab ${tabId}: ${detail}`, {
		cause: lastError,
	});
}

export async function reconcileCaptureStates(): Promise<void> {
	const host = await reconcileOffscreenHost();
	let openTabs: Set<number> | null = null;
	try {
		openTabs = new Set((await chrome.tabs.query({})).flatMap((tab) => (
			tab.id === undefined ? [] : [tab.id]
		)));
	} catch {
		// If tab enumeration is unavailable, preserve host processors rather than
		// destroying a valid capture based on an unverifiable assumption.
	}
	const recoveredTabs = new Set(host.audioTabs.map(({ tabId }) => tabId));
	for (const audio of host.audioTabs) {
		if (openTabs && !openTabs.has(audio.tabId)) {
			await stopRecoveredOrphan(audio.tabId, audio.generation);
			continue;
		}

		const snapshot = await getAudioSession(audio.tabId).catch(() => null);
		const state = getSession(audio.tabId);
		if (snapshot) state.identity = snapshot;
		state.generation = Math.max(audio.generation, snapshot?.generation ?? 0);
		state.controlRevision = audio.controlRevision ?? 0;
		state.phase = 'active';
		state.active = true;
		state.actualConfig = audio.normalizedActualConfig
			? actualConfigFromProcessor(snapshot?.actualConfig ?? DEFAULT_AUDIO_CONFIG, audio.normalizedActualConfig)
			: snapshot?.actualConfig;
		state.lastError = undefined;
		captureStates.set(audio.tabId, true);
		await publishAcknowledgedCaptureState(audio.tabId, state, {
			actualMode: 'capture',
			phase: 'active',
			config: state.actualConfig,
			error: null,
		});
	}

	if (openTabs) {
		await Promise.all([...openTabs].map(async (tabId) => {
			if (recoveredTabs.has(tabId)) return;
			const snapshot = await getAudioSession(tabId).catch(() => null);
			if (snapshot?.actualMode !== 'capture') return;
			const state = getSession(tabId);
			state.identity = snapshot;
			state.generation = snapshot.generation + 1;
			state.phase = 'error';
			state.active = false;
			state.lastError = 'The capture processor was lost while the service worker restarted';
			captureStates.set(tabId, false);
			await publishAcknowledgedCaptureState(tabId, state, {
				actualMode: 'bypass',
				phase: 'error',
				config: { ...DEFAULT_AUDIO_CONFIG, eqValues: [...DEFAULT_AUDIO_CONFIG.eqValues] },
				error: state.lastError,
			});
		}));
	}
}

export async function handleCaptureToggle(tabId: number, enabled: boolean): Promise<void> {
	await serializeTransition(tabId, async () => {
		if (enabled) return;
		await stopCapture(tabId);
	});
}

// post: navigation/close cleanup is ordered in the same per-tab transition queue;
// a new document cannot acquire capture and then be erased by late old-document cleanup.
export function teardownCaptureState(tabId: number): Promise<boolean> {
	return serializeTransition(tabId, async () => {
		const result = await stopCapture(tabId);
		if (result.status === 'error' && result.active) return false;
		sessions.delete(tabId);
		captureStates.delete(tabId);
		return true;
	});
}

export function cleanupCaptureState(tabId: number): void {
	if (getSession(tabId).active) return;
	sessions.delete(tabId);
	transitions.delete(tabId);
	releaseOffscreenLease(`audio:${tabId}`);
}
