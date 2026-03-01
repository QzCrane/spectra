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
import { isAnyMediaPlaying, hasMediaElements } from '../audio/media-detection';
import { getPausedAt } from '../utils/pause-tracker';
import { safeSend } from '../core/context-guard';
import { handleMediaMessage } from './media-message-handler';
import { executeHotkeyAction } from '../input/hotkey-actions';

export interface MessageHandlerDeps {
	state: PolicyExecutorState;
	policyExecutor: PolicyExecutor;
	captureManager: CaptureManager;
	settingsManager: SettingsManager;
	getVisualizerData: () => Uint8Array | null;
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
	return (message, _sender, sendResponse) => {
		const msg = message as { action?: string; payload?: unknown; config?: AudioConfig; command?: string; settings?: unknown };
		if (!msg?.action) return false;

		const { policyExecutor, captureManager, settingsManager, getVisualizerData } = deps;

		// Pinnacle: ANY message from the popup (or anyone) to a booting script marks it as 'interacted'
		// since the user is obviously trying to control it.
		if (msg.action === Actions.AUDIO_GET_STATUS) {
			deps.state.userHasInteracted = true;
		}

		// Pinnacle: if the executor isn't ready yet, some messages can wait or return a safe 'booting' state
		if (!policyExecutor) {
			if (msg.action === Actions.AUDIO_GET_STATUS) {
				sendResponse({
					config: deps.state.config,
					hasAudio: hasMediaElements(),
					isPlaying: false,
					mode: 'BOOTING',
					userInteracted: deps.state.userHasInteracted,
				});
				return true;
			}
			return false;
		}

		switch (msg.action) {
			case Actions.AUDIO_SET_CONFIG: {
				const payload = msg.payload as { config: Partial<AudioConfig> & { volumeDelta?: number; toggleMute?: boolean; isNativeSync?: boolean } };
				const configChanges = { ...payload.config };
				const isNativeSync = payload.config.isNativeSync;
	
				// Handle volume delta (Remote/Global Hotkeys)
				// CRITICAL: Read from deps.state.config to get real-time value
				const hasVolumeDelta = payload.config.volumeDelta !== undefined;
				if (hasVolumeDelta) {
					const currentVol = deps.state.config.volume;
					configChanges.volume = Math.max(0, Math.min(800, currentVol + payload.config.volumeDelta!));
					delete (configChanges as any).volumeDelta;
				}
	
				// Handle mute toggle (Remote/Global Hotkeys)
				if (payload.config.toggleMute) {
					configChanges.muted = !deps.state.config.muted;
					delete (configChanges as any).toggleMute;
				}
	
				delete (configChanges as any).isNativeSync;
	
				// note: show OSD for remote control commands (volumeDelta/toggleMute indicate remote/hotkey)
				const isRemoteCommand = hasVolumeDelta || payload.config.toggleMute !== undefined;
				// fix: volume delta commands should auto-unmute (user is actively adjusting volume)
				policyExecutor.updateConfig(configChanges, { isNativeSync, showOSD: isRemoteCommand, unMute: hasVolumeDelta });
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
				const vizData = getVisualizerData();
				sendResponse({ buffer: vizData ? vizData.buffer : null });
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




			case Actions.MEDIA_SET_SPEED: {
				// note: speed control now uses unified config flow through policyExecutor
				const sp = msg.payload as { speed?: number; delta?: number; preservePitch?: boolean } | undefined;
				let newSpeed: number;
				if (sp?.delta !== undefined) {
					newSpeed = Math.max(0.1, Math.min(16, (deps.state.config.speed || 1) + sp.delta));
				} else {
					newSpeed = Math.max(0.1, Math.min(16, sp?.speed ?? 1));
				}
				policyExecutor.updateConfig({ speed: newSpeed }, { showOSD: true });
				sendResponse({ speed: newSpeed, preservePitch: sp?.preservePitch ?? true });
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
