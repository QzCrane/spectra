// goal: routes audio processing commands to the appropriate execution layer (DOM, WebAudio, or Tab Capture) based on the active policy mode

import { AudioMode } from '@nexus/audio-engine';
import type { AudioConfig } from '@nexus/kernel';
import type { PolicyExecutorDeps, PolicyExecutorState } from './types';
import { setDomVolume, isAnyMediaPlaying, releaseVolumeLock, enableVolumeLock, setNativeVolumeCallback } from './dom-volume';
import { logger } from '../shared/logger';

const log = logger.content;

let currentState: PolicyExecutorState | null = null;
let currentDeps: PolicyExecutorDeps | null = null;
let currentUpdateBadge: (() => void) | null = null;
let currentBroadcastUI: (() => void) | null = null;

// eff: binds shared state and cross-module callbacks to the mode executor
export function initModeExecutorCallbacks(
	deps: PolicyExecutorDeps,
	state: PolicyExecutorState,
	updateBadge: () => void,
	broadcastUI: () => void
): void {
	currentState = state;
	currentDeps = deps;
	currentUpdateBadge = updateBadge;
	currentBroadcastUI = broadcastUI;

	// eff: registers a callback to handle native volume changes initiated by the website UI
	setNativeVolumeCallback((volume, muted) => {
		if (!currentState || !currentDeps) return;

		// note: volume < 0 signals a mute toggle without altering the numeric volume percentage
		if (volume < 0) {
			currentState.config.muted = muted;
			log.debug(`[SPECTRA] Native mute toggle: ${muted}`);
		} else {
			// rule: during NATIVE_LITE sync, only the numeric volume is updated; the 'muted' state remains under user control
			const configVolume = Math.round(volume * 100);
			currentState.config.volume = configVolume;
			log.debug(`[SPECTRA] Native volume sync: ${configVolume}%`);
		}

		currentUpdateBadge?.();
		currentBroadcastUI?.();

		// eff: persists the synchronized native state to storage to ensure UI consistency upon reopening
		currentDeps.messenger.send('AUDIO_SET_CONFIG', {
			config: currentState.config,
		}).catch(() => { });
	});
}

// post: returns true if the user has engaged with the page, making it safe to initialize AudioContext
export function hasUserGesture(state: PolicyExecutorState): boolean {
	if (state.userHasInteracted) return true;

	// rule: active media playback or navigator.userActivation signals implied user intent
	if (isAnyMediaPlaying()) return true;

	const userActivation = (navigator as Navigator & { userActivation?: { hasBeenActive: boolean } }).userActivation;
	if (userActivation?.hasBeenActive) return true;

	return false;
}

// eff: orchestrates audio modifications by dispatching to specialized controllers based on activeMode
export function executeMode(deps: PolicyExecutorDeps, state: PolicyExecutorState): void {
	const { audioController, captureManager } = deps;
	const mode = state.activeMode;
	const config = state.config;

	if (mode === AudioMode.CAPTURE) {
		if (captureManager.isActive()) {
			// note: capture mode targets the offscreen document; domestic volume locks are released
			releaseVolumeLock();
			captureManager.syncConfig(config);
		} else if (hasUserGesture(state)) {
			// log: requesting capture upgrade due to user interaction in capture-eligible mode
			log.capture('Strategy suggests CAPTURE and gesture detected, requesting...');
			captureManager.request(true, config);
			fallbackToDom(config);
		} else {
			fallbackToDom(config);
		}

	} else if (mode === AudioMode.NATIVE_LITE) {
		// mode: strictly uses DOM volume overrides and setter-redirection via 'enableVolumeLock'
		const domVol = config.muted ? 0 : Math.min(1, config.volume / 100);
		enableVolumeLock(domVol, config.muted);

	} else if (mode === AudioMode.NATIVE_WEBAUDIO) {
		if (hasUserGesture(state)) {
			if (!audioController.isReady()) {
				// note: direct user gesture is required to successfully resume an AudioContext
				audioController.initialize(true).then((success) => {
					if (success) {
						releaseVolumeLock();
						audioController.scanAndAttach();
						audioController.updateParams(config);
						// New: Broadcast to injector for WebAudio API hijacking
						window.postMessage({ type: 'SPECTRA_VOLUME_UPDATE', volume: config.volume }, '*');
					} else {
						log.debug('WebAudio init failed -> fallback to DOM');
						fallbackToDom(config);
					}
				});
			} else {
				releaseVolumeLock();
				audioController.scanAndAttach();
				audioController.updateParams(config);
				// New: Broadcast to injector for WebAudio API hijacking
				window.postMessage({ type: 'SPECTRA_VOLUME_UPDATE', volume: config.volume }, '*');
			}
		} else {
			fallbackToDom(config);
		}
	}
}

// eff: basic DOM-based volume control used as a baseline or fallback
// rule: numeric gain is capped at 100% as native HTMLMediaElement doesn't support boost
function fallbackToDom(config: AudioConfig): void {
	const domVol = config.muted ? 0 : Math.min(1, config.volume / 100);
	enableVolumeLock(domVol, config.muted);
}
