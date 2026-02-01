// goal: manages tab capture lifecycle and state from the content script context
// ban: direct WebAudio manipulation is prohibited in the content script

import type { NexusMessenger, AudioConfig } from '@nexus/kernel';
import { Actions } from '@nexus/contracts';
import { safeSend, isExtensionContextValid } from '../core/context-guard';
import { logger } from '../../shared/logger';

const log = logger.content;
let isCaptureActive = false;
let isPending = false;
let updateTimer: ReturnType<typeof setTimeout> | null = null;
let messenger: NexusMessenger | null = null;

const notifyInjector = (active: boolean) => window.postMessage({ type: 'SPECTRA_CAPTURE_STATE', active }, '*');

// goal: factory for managing capture state (now simplified singleton-like)
export function createCaptureManager(msg: NexusMessenger) {
	messenger = msg;

	return {
		isActive: () => isCaptureActive,
		isPending: () => isPending,
		setActive: (active: boolean) => {
			if (isCaptureActive !== active) {
				isCaptureActive = active;
				notifyInjector(active);
			}
			isPending = false;
		},
		handleMessage,
		request,
		syncConfig
	};
}

function request(enabled: boolean, config: AudioConfig): void {
	if (isPending) {
		log.debug('Capture skip: pending');
		return;
	}
	if (!isExtensionContextValid()) {
		log.debug('Capture skip: context invalid');
		return;
	}

	isPending = true;
	log.capture(`Requesting: ${enabled ? 'ON' : 'OFF'}`);

	safeSend(() => messenger!.send('CAPTURE_TOGGLE', { enabled, config }))
		.then((r) => {
			log.capture(`Response:`, r);
			if (isCaptureActive !== enabled) {
				isCaptureActive = enabled;
				notifyInjector(enabled);
			}
		})
		.catch((e) => log.error('Capture failed:', e))
		.finally(() => setTimeout(() => { isPending = false; }, 500));
}

function handleMessage(msg: { action?: string; payload?: { enabled?: boolean }; enabled?: boolean }): boolean {
	if (msg.action === Actions.CAPTURE_STATE_CHANGE) {
		const enabled = msg.payload?.enabled ?? msg.enabled ?? false;
		log.capture(`State update: ${enabled}`);
		if (isCaptureActive !== enabled) {
			isCaptureActive = enabled;
			notifyInjector(enabled);
		}
		isPending = false;
		return true;
	}
	return false;
}

function syncConfig(config: AudioConfig): void {
	if (!isCaptureActive || !isExtensionContextValid() || !messenger) return;
	safeSend(() => messenger!.send('CAPTURE_UPDATE_CONFIG', { config })).catch(() => { });
}

export type CaptureManager = ReturnType<typeof createCaptureManager>;
