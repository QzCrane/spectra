// goal: orchestrates audio state transitions during fullscreen requests
// note: Both CAPTURE and WEBAUDIO modes need pause/resume during fullscreen
// reason: createMediaElementSource() permanently binds to HTMLMediaElement, causing Chrome pipeline deadlock

import { AudioMode, type AudioModeType } from '@nexus/audio-engine';
import { logger } from '../../../shared/logger';
import type { PolicyExecutorState } from '../../types';
import type { CaptureManager } from '../../audio/capture-manager';
import type { PolicyExecutor } from '../../logic/policy-executor/types';

const log = logger.content;

interface FullscreenHandlerConfig {
	restoreDelayMs: number;
	enabled: boolean;
}

const DEFAULT_CONFIG: FullscreenHandlerConfig = {
	restoreDelayMs: 500,
	enabled: true,
};

// eff: sets up fullscreen transition handlers for CAPTURE mode only
// post: returns a cleanup function to remove event listeners and clear pending timers
export function setupFullscreenHandler(
	state: PolicyExecutorState,
	policyExecutor: PolicyExecutor,
	captureManager: CaptureManager,
	config: Partial<FullscreenHandlerConfig> = {}
): () => void {
	const cfg = { ...DEFAULT_CONFIG, ...config };
	if (!cfg.enabled) return () => { };

	let savedVolume: number | null = null;
	// inv: tracks original mode before fullscreen pause for correct restore behavior
	let savedMode: AudioModeType | null = null;
	let restoreTimer: ReturnType<typeof setTimeout> | null = null;
	let pausedForFullscreen = false;
	let pauseCount = 0;

	// eff: temporarily pauses enhanced audio modes to allow clean fullscreen transition
	function handlePause(): void {
		const isCapture = captureManager.isActive() || state.activeMode === AudioMode.CAPTURE;
		const isWebAudio = state.activeMode === AudioMode.NATIVE_WEBAUDIO;

		// rule: Both CAPTURE and WEBAUDIO modes need pause during fullscreen
		if (!isCapture && !isWebAudio) {
			window.postMessage({ type: 'SPECTRA_PAUSE_CONFIRMED' }, '*');
			return;
		}

		pauseCount++;
		const currentPause = pauseCount;

		if (restoreTimer) { clearTimeout(restoreTimer); restoreTimer = null; }

		if (!pausedForFullscreen) {
			savedVolume = state.config.volume;
			savedMode = state.activeMode as AudioModeType | null; // save original mode for restore
			pausedForFullscreen = true;

			if (isCapture) {
				log.info(`[FS] Fullscreen request, saving volume ${savedVolume}%, pausing CAPTURE`);
				captureManager.request(false, state.config);
			} else if (isWebAudio) {
				log.info(`[FS] Fullscreen request, saving volume ${savedVolume}%, pausing WEBAUDIO`);
				// note: WEBAUDIO will auto-restore via applyState after fullscreen
			}
		}

		window.postMessage({ type: 'SPECTRA_PAUSE_CONFIRMED' }, '*');

		// rule: auto-restore after 3s timeout to prevent permanent audio loss
		restoreTimer = setTimeout(() => {
			if (pauseCount !== currentPause) return;
			restoreTimer = null;
			if (pausedForFullscreen) {
				log.info('[FS] Fullscreen timeout, reviving capture');
				restoreAudio();
			}
		}, 3000);
	}

	// eff: restores audio after fullscreen transition completes
	function handleEntered(): void {
		if (!pausedForFullscreen) return;

		if (restoreTimer) { clearTimeout(restoreTimer); restoreTimer = null; }

		log.info('[FS] Fullscreen entered, restoring delayed');

		restoreTimer = setTimeout(() => {
			restoreTimer = null;
			restoreAudio();
		}, cfg.restoreDelayMs);
	}

	// eff: re-activates audio mode based on what was paused (CAPTURE or WEBAUDIO)
	function restoreAudio(): void {
		if (!pausedForFullscreen) return;
		pausedForFullscreen = false;

		const modeToRestore = savedMode;
		savedMode = null;

		if (!state.config.enabled) {
			savedVolume = null;
			return;
		}

		const vol = savedVolume ?? state.config.volume;
		state.userHasInteracted = true;
		savedVolume = null;

		// rule: only request CAPTURE if we were in CAPTURE mode before fullscreen
		if (modeToRestore === AudioMode.CAPTURE) {
			log.info(`[FS] Restoring CAPTURE, volume ${vol}%`);
			captureManager.request(true, { ...state.config, volume: vol });
		} else {
			// note: WEBAUDIO mode - just trigger applyState to reinitialize WebAudio pipeline
			log.info(`[FS] Restoring WEBAUDIO, volume ${vol}%`);
		}

		// eff: always trigger applyState to ensure proper mode execution
		setTimeout(() => policyExecutor.applyState(), 100);
	}

	function handleMessage(event: MessageEvent): void {
		if (event.source !== window) return;
		switch (event.data?.type) {
			case 'SPECTRA_PAUSE_FOR_FULLSCREEN': handlePause(); break;
			case 'SPECTRA_FULLSCREEN_ENTERED': handleEntered(); break;
		}
	}

	window.addEventListener('message', handleMessage);
	log.debug('[FS] Fullscreen Handler enabled (CAPTURE only)');

	return () => {
		window.removeEventListener('message', handleMessage);
		if (restoreTimer) clearTimeout(restoreTimer);
	};
}
