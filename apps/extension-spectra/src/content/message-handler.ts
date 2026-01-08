/**
 * SPECTRA Content Script - Message Handler
 * 
 * Handles messages from Popup/Background
 */

import type { AudioConfig } from '@nexus/kernel';
import { Actions } from '@nexus/contracts';

import { PolicyExecutor, PolicyExecutorState } from './policy-executor';
import { CaptureManager } from './capture-manager';
import { SettingsManager } from './settings-manager';
import { hasMediaElements, isAnyMediaPlaying, getPausedAt } from './dom-volume';
import { safeSend } from './context-guard';
import { handleMediaMessage } from './media-message-handler';

export interface MessageHandlerDeps {
	state: PolicyExecutorState;
	policyExecutor: PolicyExecutor;
	captureManager: CaptureManager;
	settingsManager: SettingsManager;
	getVisualizerData: () => number[] | null;
}

/**
 * Create Message Handler
 */
export function createMessageHandler(deps: MessageHandlerDeps): (
	message: unknown,
	sender: chrome.runtime.MessageSender,
	sendResponse: (response?: unknown) => void
) => boolean | undefined {
	const { state, policyExecutor, captureManager, settingsManager, getVisualizerData } = deps;

	return (message, _sender, sendResponse) => {
		const msg = message as { action?: string; payload?: unknown; config?: AudioConfig; command?: string; settings?: unknown };
		if (!msg?.action) return false;

		switch (msg.action) {
			case Actions.AUDIO_SET_CONFIG: {
				const payload = msg.payload as { config: Partial<AudioConfig> & { volumeDelta?: number; toggleMute?: boolean } };
				const configChanges = { ...payload.config };

				// Handle volume delta (Remote)
				if (payload.config.volumeDelta !== undefined) {
					const currentVol = state.config.volume;
					configChanges.volume = Math.max(0, Math.min(800, currentVol + payload.config.volumeDelta));
					delete (configChanges as any).volumeDelta;
				}

				// Handle mute toggle (Remote)
				if (payload.config.toggleMute) {
					configChanges.muted = !state.config.muted;
					delete (configChanges as any).toggleMute;
				}

				policyExecutor.updateConfig(configChanges);
				sendResponse({
					success: true,
					state: {
						config: state.config,
						hasAudio: hasMediaElements(),
						isPlaying: isAnyMediaPlaying(),
						mode: state.activeMode,
						userInteracted: state.userHasInteracted,
					}
				});
				break;
			}

			case Actions.AUDIO_GET_STATUS: {
				// Always apply state to trigger CORS check
				policyExecutor.applyState();

				// isAnyMediaPlaying updates pausedAt automatically
				const isPlaying = isAnyMediaPlaying();

				sendResponse({
					config: state.config,
					hasAudio: hasMediaElements(),
					isPlaying,
					mode: state.activeMode,
					userInteracted: state.userHasInteracted,
					pausedAt: getPausedAt(),
				});
				break;
			}

			case Actions.AUDIO_GET_VISUALIZER: {
				sendResponse({ buffer: getVisualizerData() });
				break;
			}

			case Actions.SHORTCUT_TRIGGER: {
				const payload = msg.payload as { command?: string; config?: AudioConfig } | undefined;
				if (payload?.config) {
					// Only force unmute on volume change, not on toggle mute
					const shouldUnmute = payload.command !== 'toggle_mute';
					policyExecutor.updateConfig(payload.config, { showOSD: true, unMute: shouldUnmute });
				}
				sendResponse({ success: true });
				break;
			}

			case Actions.CAPTURE_STATE_CHANGE: {
				captureManager.handleMessage(msg as { action?: string; payload?: { enabled?: boolean }; enabled?: boolean });
				policyExecutor.applyState();
				policyExecutor.updateBadge();

				// Notify Popup (if from background auto-update)
				safeSend(() => new Promise<void>((resolve, reject) => {
					chrome.runtime.sendMessage({
						action: Actions.CAPTURE_STATE_CHANGE,
						payload: { enabled: captureManager.isActive() }
					}, {}, (response: any) => {
						if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
						else resolve(response);
					});
				})).catch(() => { });

				sendResponse({ success: true });
				break;
			}

			case Actions.GLOBAL_SETTINGS_UPDATE: {
				settingsManager.handleMessage(msg as { action?: string; settings?: { osdEnabled?: boolean; visualizerEnabled?: boolean; lang?: string } });
				// Critical: Setting change counts as user interaction
				state.userHasInteracted = true;
				// Re-apply state and sync badge
				policyExecutor.applyState();
				policyExecutor.updateBadge();
				sendResponse({ success: true });
				break;
			}

			// ========== Media/Video Control (Delegated) ==========
			default:
				if (handleMediaMessage(msg.action, msg.payload, sendResponse)) {
					return true;
				}
		}

		return true; // Async response
	};
}
