// goal: manages environmental triggers that affect audio processing
// note: many browsers prohibit WebAudio initialization until a trust-building user gesture occurs

import { AudioMode, WebAudioController } from '@nexus/audio-engine';
import { logger } from '../../../shared/logger';
import { getPrimaryMedia } from '../../utils/media-utils';
import { getSiteBridge } from '../../logic/site-bridge/registry';
import type { PolicyExecutorState } from '../../types';
import type { PolicyExecutor } from '../../logic/policy-executor';

const log = logger.content;

// eff: Statically allocated listener to avoid repeated closure creation
let listenerCtx: { state: PolicyExecutorState; ctrl: WebAudioController; exec: PolicyExecutor; probed: boolean } | null = null;

function handleGesture() {
	if (!listenerCtx) return;
	const { state, ctrl, exec } = listenerCtx;
	state.hasGesture = true;
	state.userHasInteracted = true;

	if (!listenerCtx.probed) {
		listenerCtx.probed = true;
		exec.probeCors();
	}

	if (state.activeMode === AudioMode.NATIVE_WEBAUDIO && !ctrl.isReady()) {
		log.debug('[Interact] Retry WebAudio init');
	}

	exec.applyState();
}

export function setupUserGestureListeners(
	state: PolicyExecutorState,
	audioController: WebAudioController,
	policyExecutor: PolicyExecutor
): () => void {
	listenerCtx = { state, ctrl: audioController, exec: policyExecutor, probed: false };
	const evts = ['click', 'keydown', 'touchstart', 'mousedown'];

	for (const e of evts) {
		document.addEventListener(e, handleGesture, { once: true, passive: true });
	}

	return () => {
		for (const e of evts) {
			document.removeEventListener(e, handleGesture);
		}
		listenerCtx = null;
	};
}

export function setupPopupConnectionListener(state: PolicyExecutorState, onPopupOpen?: () => void): void {
	if (typeof chrome === 'undefined' || !chrome.runtime?.onConnect) return;

	chrome.runtime.onConnect.addListener((port) => {
		if (port.name === 'popup-connection') {
			state.isPopupOpen = true;
			state.userHasInteracted = true;
			syncDomVolumeToState(state);
			onPopupOpen?.();
			port.onDisconnect.addListener(() => { state.isPopupOpen = false; });
		}
	});
}

function syncDomVolumeToState(state: PolicyExecutorState): void {
	const bridge = getSiteBridge();
	if (!bridge.canPullInitialState()) return;

	const media = getPrimaryMedia();
	if (!media) return;

	if (!state.userHasInteracted) {
		state.config.volume = (media.volume * 100) | 0;
	}
}
