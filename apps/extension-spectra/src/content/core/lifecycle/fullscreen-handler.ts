// goal: orchestrates audio state transitions during fullscreen requests
// reason: createMediaElementSource() permanently binds to HTMLMediaElement, causing Chrome pipeline deadlock

import { AudioMode, type AudioModeType } from '@nexus/audio-engine';
import { logger } from '../../../shared/logger';
import type { PolicyExecutorState } from '../../types';
import type { CaptureManager } from '../../audio/capture-manager';
import type { PolicyExecutor } from '../../logic/policy-executor/types';

const log = logger.content;

// eff: Module-level state to avoid per-invocation closures
let restoreTimer: ReturnType<typeof setTimeout> | null = null;
let savedVolume: number | null = null;
let savedMode: AudioModeType | null = null;
let pausedForFullscreen = false;
let pauseCount = 0;

interface HandlerContext {
	state: PolicyExecutorState;
	audioController: PolicyExecutor; // Type mismatch in original? Assuming execute interface
	captureManager: CaptureManager;
	delay: number;
}

let ctx: HandlerContext | null = null;

function handlePause() {
	if (!ctx) return;
	const { state, captureManager } = ctx;

	const isCapture = captureManager.isActive() || state.activeMode === AudioMode.CAPTURE;
	const isWebAudio = state.activeMode === AudioMode.NATIVE_WEBAUDIO;

	if (!isCapture && !isWebAudio) {
		window.postMessage({ type: 'SPECTRA_PAUSE_CONFIRMED' }, '*');
		return;
	}

	pauseCount++;
	const currentPause = pauseCount;
	if (restoreTimer) { clearTimeout(restoreTimer); restoreTimer = null; }

	if (!pausedForFullscreen) {
		savedVolume = state.config.volume;
		savedMode = state.activeMode as AudioModeType | null;
		pausedForFullscreen = true;

		if (isCapture) {
			log.info(`[FS] Pausing CAPTURE (saved vol: ${savedVolume}%)`);
			captureManager.request(false, state.config);
		} else if (isWebAudio) {
			log.info(`[FS] Pausing WEBAUDIO`);
		}
	}

	window.postMessage({ type: 'SPECTRA_PAUSE_CONFIRMED' }, '*');

	restoreTimer = setTimeout(() => {
		if (pauseCount !== currentPause) return;
		restoreTimer = null;
		if (pausedForFullscreen) {
			log.info('[FS] Timeout, restoring audio');
			restoreAudio();
		}
	}, 3000);
}

function restoreAudio() {
	if (!ctx || !pausedForFullscreen) return;
	const { state, captureManager, audioController } = ctx;

	pausedForFullscreen = false;
	const mode = savedMode;
	savedMode = null;

	if (!state.config.enabled) { savedVolume = null; return; }

	const vol = savedVolume ?? state.config.volume;
	state.userHasInteracted = true;
	savedVolume = null;

	if (mode === AudioMode.CAPTURE) {
		log.info(`[FS] Restore CAPTURE ${vol}%`);
		captureManager.request(true, { ...state.config, volume: vol });
	} else {
		log.info(`[FS] Restore WEBAUDIO`);
	}

	setTimeout(() => ctx?.audioController.applyState(), 100);
}

function handleEntered() {
	if (!pausedForFullscreen || !ctx) return;
	if (restoreTimer) { clearTimeout(restoreTimer); restoreTimer = null; }
	log.info('[FS] Entered, scheduled restore');
	restoreTimer = setTimeout(() => { restoreTimer = null; restoreAudio(); }, ctx.delay);
}

function handleMessage(e: MessageEvent) {
	if (e.source !== window) return;
	if (e.data?.type === 'SPECTRA_PAUSE_FOR_FULLSCREEN') handlePause();
	else if (e.data?.type === 'SPECTRA_FULLSCREEN_ENTERED') handleEntered();
}

export function setupFullscreenHandler(
	state: PolicyExecutorState,
	executor: PolicyExecutor,
	captureManager: CaptureManager,
	config: { restoreDelayMs?: number; enabled?: boolean } = {}
): () => void {
	if (config.enabled === false) return () => { };

	ctx = {
		state,
		audioController: executor,
		captureManager,
		delay: config.restoreDelayMs ?? 500
	};

	window.addEventListener('message', handleMessage);
	log.debug('[FS] Handler enabled');

	return () => {
		window.removeEventListener('message', handleMessage);
		if (restoreTimer) clearTimeout(restoreTimer);
		ctx = null;
	};
}
