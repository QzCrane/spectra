// goal: manages tab capture lifecycle and state from the content script context
// ban: direct WebAudio manipulation is prohibited in the content script; all processing is delegated to the offscreen worker

import type { NexusMessenger, AudioConfig } from '@nexus/kernel';
import { Actions } from '@nexus/contracts';
import { safeSend, isExtensionContextValid } from '../core/context-guard';
import { logger } from '../../shared/logger';

const log = logger.content;

// goal: factory for managing capture state, requests, and configuration synchronization
export function createCaptureManager(messenger: NexusMessenger) {
	let isCaptureActive = false;
	let isPending = false;

	// eff: broadcasts capture state to injector (MAIN world) for fullscreen handling
	function notifyInjector(active: boolean): void {
		window.postMessage({ type: 'SPECTRA_CAPTURE_STATE', active }, '*');
	}

	return {
		isActive(): boolean {
			return isCaptureActive;
		},

		setActive(active: boolean): void {
			if (isCaptureActive !== active) {
				isCaptureActive = active;
				notifyInjector(active);
			}
			isPending = false;
		},

		isPending(): boolean {
			return isPending;
		},

		// eff: sends a CAPTURE_TOGGLE request to the background service worker
		// rule: suppresses requests if a toggle is already pending or if the extension context is invalidated
		request(enabled: boolean, config: AudioConfig): void {
			if (isPending) {
				log.debug('Capture request skipped: pending');
				return;
			}
			if (!isExtensionContextValid()) {
				log.debug('Capture request skipped: context invalid');
				return;
			}

			isPending = true;
			log.capture(`Requesting Capture: ${enabled ? 'ON' : 'OFF'}`);

			safeSend(() => messenger.send('CAPTURE_TOGGLE', { enabled, config }))
				.then((response) => {
					log.capture(`Capture response:`, response);
					if (isCaptureActive !== enabled) {
						isCaptureActive = enabled;
						notifyInjector(enabled);
					}
				})
				.catch((e) => {
					log.error('Capture request failed:', e);
				})
				.finally(() => {
					// note: use a 500ms debounce to match the background capture lock
					setTimeout(() => {
						isPending = false;
					}, 500);
				});
		},

		// eff: synchronizes local capture state with broadcasted background updates
		handleMessage(message: { action?: string; payload?: { enabled?: boolean }; enabled?: boolean }): boolean {
			if (message.action === Actions.CAPTURE_STATE_CHANGE) {
				const enabled = message.payload?.enabled ?? message.enabled ?? false;
				log.capture(`State change received: ${enabled ? 'ON' : 'OFF'}`);
				if (isCaptureActive !== enabled) {
					isCaptureActive = enabled;
					notifyInjector(enabled);
				}
				isPending = false;
				return true;
			}
			return false;
		},

		// goal: sends high-frequency audio parameter updates (EQ, volume) to the active capture session
		syncConfig(config: AudioConfig): void {
			if (!isCaptureActive || !isExtensionContextValid()) return;

			// note: uses a dedicated update action to bypass background toggle locks
			safeSend(() => messenger.send('CAPTURE_UPDATE_CONFIG', { config })).catch(() => { });
		},
	};
}

export type CaptureManager = ReturnType<typeof createCaptureManager>;
