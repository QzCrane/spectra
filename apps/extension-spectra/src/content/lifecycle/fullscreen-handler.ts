// goal: orchestrates capture state transitions during fullscreen requests to bypass browser-imposed restriction on capturing elements while entering fullscreen
// note: some browsers (e.g. Chrome) prohibit requestFullscreen() if the tab is being "captured" via tabCapture API; we briefly detach to allow the transition

import { AudioMode } from '@nexus/audio-engine';
import { logger } from '../../shared/logger';
import type { PolicyExecutorState } from '../types';
import type { CaptureManager } from '../capture-manager';

const log = logger.content;

interface FullscreenHandlerConfig {
	restoreDelayMs: number;
	enabled: boolean;
}

const DEFAULT_CONFIG: FullscreenHandlerConfig = {
	restoreDelayMs: 500,
	enabled: true,
};

// eff: sets up inter-process message listeners to coordinate capture suspension and restoration
// post: returns a cleanup function to remove event listeners and clear pending timers
export function setupFullscreenHandler(
	state: PolicyExecutorState,
	_policyExecutor: unknown,
	captureManager: CaptureManager,
	config: Partial<FullscreenHandlerConfig> = {}
): () => void {
	const cfg = { ...DEFAULT_CONFIG, ...config };
	if (!cfg.enabled) return () => { };

	let savedVolume: number | null = null;
	let restoreTimer: ReturnType<typeof setTimeout> | null = null;
	let pausedForFullscreen = false;
	let pauseCount = 0;  // inv: strictly increments to avoid race conditions with multiple rapid FS requests

	// eff: temporarily kills tab capture and saves current volume to satisfy browser "user interaction" requirements for FS
	function handlePause(): void {
		const isCapture = captureManager.isActive() || state.activeMode === AudioMode.CAPTURE;
		if (!isCapture) return;

		pauseCount++;
		const currentPause = pauseCount;

		if (restoreTimer) { clearTimeout(restoreTimer); restoreTimer = null; }

		if (!pausedForFullscreen) {
			savedVolume = state.config.volume;
			pausedForFullscreen = true;
			log.info(`[FS] Fullscreen request, saving volume ${savedVolume}%, disabling hijack`);
			captureManager.request(false, state.config);
		}

		// rule: if the transition isn't completed within 3s, automatically restore capture to ensure audio isn't permanently lost
		restoreTimer = setTimeout(() => {
			if (pauseCount !== currentPause) return;
			restoreTimer = null;
			if (pausedForFullscreen) {
				log.info('[FS] Fullscreen timeout, reviving hijack');
				restoreCapture();
			}
		}, 3000);
	}

	// eff: restores capture after a short delay to ensure the native fullscreen transition has visually stabilized
	function handleEntered(): void {
		if (!pausedForFullscreen) return;

		if (restoreTimer) { clearTimeout(restoreTimer); restoreTimer = null; }

		log.info('[FS] Fullscreen entered, restoring delayed');

		restoreTimer = setTimeout(() => {
			restoreTimer = null;
			restoreCapture();
		}, cfg.restoreDelayMs);
	}

	// eff: re-activates the tab capture session with the previously saved volume setting
	function restoreCapture(): void {
		if (!pausedForFullscreen) return;
		pausedForFullscreen = false;

		if (!state.config.enabled) {
			savedVolume = null;
			return;
		}

		const vol = savedVolume ?? state.config.volume;
		log.info(`[FS] Restoring hijack, volume ${vol}%`);
		state.userHasInteracted = true;
		captureManager.request(true, { ...state.config, volume: vol });
		savedVolume = null;
	}

	function handleMessage(event: MessageEvent): void {
		if (event.source !== window) return;
		switch (event.data?.type) {
			case 'SPECTRA_PAUSE_FOR_FULLSCREEN': handlePause(); break;
			case 'SPECTRA_FULLSCREEN_ENTERED': handleEntered(); break;
		}
	}

	window.addEventListener('message', handleMessage);
	log.debug('[FS] Fullscreen Handler enabled');

	return () => {
		window.removeEventListener('message', handleMessage);
		if (restoreTimer) clearTimeout(restoreTimer);
	};
}
