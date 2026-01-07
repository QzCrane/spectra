/**
 * SPECTRA Content Script - Message Handler
 * 
 * Handles messages from Popup/Background
 * RULE: All config changes go through policyExecutor.updateConfig to ensure single source of truth
 */

import type { AudioConfig } from '@nexus/kernel';
import { Actions } from '@nexus/contracts';

import { PolicyExecutor, PolicyExecutorState } from './policy-executor';
import { CaptureManager } from '../audio/capture-manager';
import { SettingsManager } from '../core/settings-manager';
import { hasMediaElements, isAnyMediaPlaying, getPausedAt } from '../audio/dom-volume';
import { safeSend } from '../core/context-guard';
import { handleMediaMessage } from './media-message-handler';
import { executeHotkeyAction } from '../input/hotkey-actions';

export interface MessageHandlerDeps {
	state: PolicyExecutorState;
	policyExecutor: PolicyExecutor;
	captureManager: CaptureManager;
	settingsManager: SettingsManager;
	getVisualizerData: () => number[] | null;
}

/**
 * Create Message Handler
 * CRITICAL: Use deps.state directly (not destructured copy) to ensure real-time config access
 */
export function createMessageHandler(deps: MessageHandlerDeps): (
	message: unknown,
	sender: chrome.runtime.MessageSender,
	sendResponse: (response?: unknown) => void
) => boolean | undefined {
	// CRITICAL: Keep reference to deps, not destructured state, to ensure real-time access
	const { policyExecutor, captureManager, settingsManager, getVisualizerData } = deps;

	return (message, _sender, sendResponse) => {
		const msg = message as { action?: string; payload?: unknown; config?: AudioConfig; command?: string; settings?: unknown };
		if (!msg?.action) return false;

		switch (msg.action) {
			case Actions.AUDIO_SET_CONFIG: {
				const payload = msg.payload as { config: Partial<AudioConfig> & { volumeDelta?: number; toggleMute?: boolean; isNativeSync?: boolean } };
				const configChanges = { ...payload.config };
				const isNativeSync = payload.config.isNativeSync;

				// Handle volume delta (Remote/Global Hotkeys)
				// CRITICAL: Read from deps.state.config to get real-time value
				if (payload.config.volumeDelta !== undefined) {
					const currentVol = deps.state.config.volume;
					configChanges.volume = Math.max(0, Math.min(800, currentVol + payload.config.volumeDelta));
					delete (configChanges as any).volumeDelta;
				}

				// Handle mute toggle (Remote/Global Hotkeys)
				if (payload.config.toggleMute) {
					configChanges.muted = !deps.state.config.muted;
					delete (configChanges as any).toggleMute;
				}

				delete (configChanges as any).isNativeSync;

				policyExecutor.updateConfig(configChanges, { isNativeSync });
				sendResponse({
					success: true,
					state: {
						config: deps.state.config,
						hasAudio: hasMediaElements(),
						isPlaying: isAnyMediaPlaying(),
						mode: deps.state.activeMode,
						userInteracted: deps.state.userHasInteracted,
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
					config: deps.state.config,
					hasAudio: hasMediaElements(),
					isPlaying,
					mode: deps.state.activeMode,
					userInteracted: deps.state.userHasInteracted,
					pausedAt: getPausedAt(),
				});
				break;
			}

			case Actions.AUDIO_GET_VISUALIZER: {
				sendResponse({ buffer: getVisualizerData() });
				break;
			}

			case Actions.CAPTURE_STATE_CHANGE: {
				const payload = msg.payload as { enabled?: boolean; fromTab?: number };
				if (payload.enabled !== undefined) {
					captureManager.setActive(payload.enabled);
					if (!payload.enabled && deps.state.activeMode === 'CAPTURE') {
						policyExecutor.applyState();
					}
				}
				sendResponse({ success: true });
				break;
			}

			case Actions.SETTINGS_UPDATE: {
				const newSettings = msg.settings ?? msg.payload;
				if (newSettings && typeof newSettings === 'object') {
					settingsManager.update(newSettings as Record<string, unknown>);
					policyExecutor.applyState();
				}
				sendResponse({ success: true });
				break;
			}

			case Actions.SETTINGS_GET: {
				sendResponse({ settings: settingsManager.get() });
				break;
			}

			case Actions.SHORTCUT_TRIGGER: {
				// goal: handle global chrome keyboard shortcuts sent from background script
				// rule: all actions (including volume) use executeHotkeyAction which calls updateConfig with showOSD
				const payload = msg.payload as { command: string };
				executeHotkeyAction(payload.command as import('@nexus/contracts').HotkeyAction);
				sendResponse({ success: true });
				break;
			}




			default: {
				// delegate playback messages to the specialized handler
				if (handleMediaMessage(msg.action!, msg.payload, sendResponse)) {
					return true;
				}
				return false;
			}
		}
		return true;
	};
}
