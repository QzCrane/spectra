// goal: manages environmental triggers that affect audio processing
// note: many browsers prohibit WebAudio initialization until a trust-building user gesture occurs

import { AudioMode, WebAudioController } from '@nexus/audio-engine';
import { logger } from '../../../shared/logger';
import type { PolicyExecutorState } from '../../types';
import type { PolicyExecutor } from '../../logic/policy-executor';

const log = logger.content;

// eff: Statically allocated listener to avoid repeated closure creation
let listenerCtx: { state: PolicyExecutorState; ctrl: WebAudioController; exec: PolicyExecutor; cleanup: () => void } | null = null;

function handleGesture() {
	if (!listenerCtx) return;
	const context = listenerCtx;
	const { state, ctrl, exec } = context;
	state.hasGesture = true;
	context.cleanup();

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
	const evts = ['click', 'keydown', 'touchstart', 'mousedown'];
	const cleanup = () => {
		for (const e of evts) {
			document.removeEventListener(e, handleGesture);
		}
		if (listenerCtx?.cleanup === cleanup) listenerCtx = null;
	};
	listenerCtx = { state, ctrl: audioController, exec: policyExecutor, cleanup };
	for (const event of evts) document.addEventListener(event, handleGesture, { passive: true });
	return cleanup;
}

export function setupPopupConnectionListener(state: PolicyExecutorState): () => void {
	if (typeof chrome === 'undefined' || !chrome.runtime?.onConnect) return () => { };

	const listener = (port: chrome.runtime.Port) => {
		if (port.name === 'popup-connection') {
			state.isPopupOpen = true;
			port.onDisconnect.addListener(() => { state.isPopupOpen = false; });
		}
	};
	chrome.runtime.onConnect.addListener(listener);
	return () => chrome.runtime.onConnect.removeListener(listener);
}
