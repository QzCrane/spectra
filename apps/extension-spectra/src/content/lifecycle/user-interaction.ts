// goal: manages environmental triggers that affect audio processing, such as user interaction requirements and UI state tracking
// note: many browsers prohibit WebAudio initialization until a trust-building user gesture occurs

import { AudioMode, WebAudioController } from '@nexus/audio-engine';
import { logger } from '../../shared/logger';
import type { PolicyExecutorState } from '../types';
import type { PolicyExecutor } from '../policy-executor';

const log = logger.content;

// eff: binds temporary listeners to high-confidence interaction events (click, keypress) to trigger AudioContext.resume()
export function setupUserGestureListeners(
	state: PolicyExecutorState,
	audioController: WebAudioController,
	policyExecutor: PolicyExecutor
): void {
	let corsProbed = false;

	const handleUserGestureUnlock = () => {
		// eff: mark user interaction for subsequent policy calculations
		state.userHasInteracted = true;

		// rule: trigger CORS detection once on first user interaction
		if (!corsProbed) {
			corsProbed = true;
			policyExecutor.probeCors();
		}

		// rule: only attempts unlock if currently in a mode that relies on browser-side Web Audio nodes
		if (state.activeMode === AudioMode.NATIVE_WEBAUDIO && !audioController.isReady()) {
			log.debug('User gesture detected, retrying WebAudio init.');
		}

		// eff: always re-apply state on first interaction to trigger proper mode initialization
		policyExecutor.applyState();
	};

	const interactionEvents = ['click', 'keydown', 'touchstart', 'mousedown'];
	interactionEvents.forEach(event => {
		document.addEventListener(event, handleUserGestureUnlock, { once: true, passive: true });
	});
}

// eff: monitors the presence of the extension popup to optimize visualizer calculations and background reporting frequency
export function setupPopupConnectionListener(state: PolicyExecutorState): void {
	chrome.runtime.onConnect.addListener((port) => {
		if (port.name === 'popup-connection') {
			state.isPopupOpen = true;
			port.onDisconnect.addListener(() => {
				state.isPopupOpen = false;
			});
		}
	});
}
