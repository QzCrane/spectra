/**
 * SPECTRA Content Script - Message Handler
 *
 * Handles messages from Popup/Background.
 * All config changes go through policyExecutor.updateConfig.
 */

import {
	SPECTRA_PROTOCOL_VERSION,
	isSpectraEventEnvelope,
	isSpectraRequestEnvelope,
	rpcFailure,
	rpcSuccess,
	type AudioRuntimeStatus,
	type SpectraAudioMode,
} from '@nexus/contracts';

import type { PolicyExecutor, PolicyExecutorState } from './policy-executor';
import type { CaptureManager } from '../audio/capture-manager';
import type { SettingsManager } from '../core/settings-manager';
import { isAnyMediaPlaying, hasMediaElements } from '../audio/media-detection';
import { getPausedAt } from '../utils/pause-tracker';
import {
	handleSpectraContentCommand,
	isContentCommandType,
} from './spectra-command-handler';
import { shouldAcceptAudioSessionPhase } from '../../shared/audio-session-phase';
import { SPECTRA_SAME_DOCUMENT_NAVIGATION_EVENT } from '../core/lifecycle/navigation-observer';

export interface MessageHandlerDeps {
	state: PolicyExecutorState;
	policyExecutor?: PolicyExecutor;
	captureManager: CaptureManager;
	settingsManager: SettingsManager;
	getVisualizerData: () => Uint8Array | null;
	setVisualizerSubscribed: (subscribed: boolean) => Promise<boolean>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeMode(value: unknown): SpectraAudioMode {
	if (value === 'capture' || value === 'CAPTURE') return 'capture';
	if (value === 'webaudio' || value === 'NATIVE_WEBAUDIO') return 'webaudio';
	return 'bypass';
}

function createRuntimeStatus(deps: MessageHandlerDeps): AudioRuntimeStatus {
	return {
		config: {
			...deps.state.config,
			eqValues: [...deps.state.config.eqValues],
		},
		hasAudio: hasMediaElements(),
		isPlaying: isAnyMediaPlaying(),
		desiredMode: normalizeMode(deps.state.desiredMode),
		actualMode: deps.state.actualMode,
		phase: deps.state.phase,
		generation: deps.state.generation,
		userInteracted: deps.state.userHasInteracted,
		pausedAt: getPausedAt(),
		lastError: deps.state.lastError
			? { code: 'runtime_error', message: deps.state.lastError, retryable: true }
			: null,
	};
}

function applyCaptureEvent(deps: MessageHandlerDeps, message: unknown): boolean {
	if (!isSpectraEventEnvelope(message) || message.type !== 'spectra.audio.capture.changed') return false;
	const runtimeOwnsTransition = deps.captureManager.hasLocalRequest();
	deps.captureManager.handleMessage(message);
	const snapshot = message.payload;
	if (shouldAcceptAudioSessionPhase(
		deps.state.generation,
		deps.state.phase,
		snapshot.generation,
		snapshot.phase,
	)) {
		deps.state.generation = snapshot.generation;
		deps.state.phase = snapshot.phase;
		deps.state.actualMode = snapshot.actualMode;
		deps.state.lastError = snapshot.lastError?.message;
		if (!runtimeOwnsTransition
			&& snapshot.phase === 'idle'
			&& snapshot.actualMode === 'bypass'
			&& normalizeMode(deps.state.desiredMode) === 'webaudio') {
			// A typed Capture request can originate outside PolicyExecutor (for
			// example an acknowledged full-output transition). Once its processor is
			// actually idle, restore the already-desired WebAudio path. Transitions
			// initiated by ModeExecutor are excluded to avoid re-entering its own ACK.
			void deps.policyExecutor?.applyState({ modeIntent: true });
		}
	}
	return true;
}

function applyContentSettingsEvent(deps: MessageHandlerDeps, message: unknown): boolean {
	if (!isSpectraEventEnvelope(message) || message.type !== 'spectra.content.settings.changed') return false;
	deps.settingsManager.handleMessage(message);
	deps.policyExecutor?.applyState();
	return true;
}

function applyNavigationEvent(
	message: unknown,
	sender: chrome.runtime.MessageSender,
): boolean {
	if (!isSpectraEventEnvelope(message) || message.type !== 'spectra.navigation.changed') return false;
	if (sender.id !== chrome.runtime.id) return true;
	try {
		if (new URL(message.payload.url).href !== window.location.href) return true;
	} catch {
		return true;
	}
	window.dispatchEvent(new Event(SPECTRA_SAME_DOCUMENT_NAVIGATION_EVENT));
	return true;
}

// post: validates current v2 envelopes before action-specific code observes payloads.
// Upgrade compatibility is owned by Background: it dual-sends the three named
// one-release adapters to content contexts that still run the previous bundle.
export function createMessageHandler(deps: MessageHandlerDeps): (
	message: unknown,
	sender: chrome.runtime.MessageSender,
	sendResponse: (response?: unknown) => void
) => boolean | undefined {
	return (message, _sender, sendResponse) => {
		if (applyCaptureEvent(deps, message)) return false;
		if (applyContentSettingsEvent(deps, message)) return false;
		if (applyNavigationEvent(message, _sender)) return false;
		if (isRecord(message)
			&& message.protocolVersion === SPECTRA_PROTOCOL_VERSION
			&& typeof message.type === 'string'
			&& (message.type === 'spectra.audio.visualizer.get'
				|| message.type === 'spectra.audio.visualizer.subscription.set'
				|| message.type === 'spectra.hotkey.trigger'
				|| message.type.startsWith('spectra.media.')
				|| message.type.startsWith('spectra.video.'))) {
			if (!isSpectraRequestEnvelope(message) || !isContentCommandType(message.type)) {
				sendResponse(rpcFailure('invalid_request', 'Malformed content command'));
				return false;
			}
			if (_sender.id && _sender.id !== chrome.runtime.id) {
				sendResponse(rpcFailure('forbidden', 'Content command is extension-internal only'));
				return false;
			}
			return handleSpectraContentCommand(message, deps, sendResponse);
		}
		if (isRecord(message)
			&& message.protocolVersion === SPECTRA_PROTOCOL_VERSION
			&& typeof message.type === 'string'
			&& message.type.startsWith('spectra.audio.runtime.')) {
			if (!isSpectraRequestEnvelope(message)
				|| (message.type !== 'spectra.audio.runtime.get'
					&& message.type !== 'spectra.audio.runtime.configure')) {
				sendResponse(rpcFailure('invalid_request', 'Malformed audio runtime request'));
				return false;
			}
			if (_sender.id && _sender.id !== chrome.runtime.id) {
				sendResponse(rpcFailure('forbidden', 'Audio runtime RPC is extension-internal only'));
				return false;
			}
			if (message.type === 'spectra.audio.runtime.configure') {
				if (!deps.policyExecutor) {
					sendResponse(rpcFailure('runtime_booting', 'Audio runtime is still starting', true));
					return false;
				}
				let persistence: ReturnType<PolicyExecutor['updateConfig']>;
				try {
					persistence = deps.policyExecutor.updateConfig(message.payload.config);
				} catch (error) {
					sendResponse(rpcFailure(
						'audio_config_persist_failed',
						error instanceof Error ? error.message : String(error),
						true,
					));
					return false;
				}
				void persistence.then(
					(result) => {
						if (!result.ok) {
							sendResponse(result);
							return;
						}
						sendResponse(rpcSuccess(createRuntimeStatus(deps)));
					},
					(error) => sendResponse(rpcFailure(
						'audio_config_persist_failed',
						error instanceof Error ? error.message : String(error),
						true,
					)),
				);
				return true;
			}
			sendResponse(rpcSuccess(createRuntimeStatus(deps)));
			return false;
		}
		return false;
	};
}
