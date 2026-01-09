// goal: manages environmental triggers that affect audio processing, such as user interaction requirements and UI state tracking
// note: many browsers prohibit WebAudio initialization until a trust-building user gesture occurs

import { AudioMode, WebAudioController } from '@nexus/audio-engine';
import { logger } from '../../../shared/logger';
import type { PolicyExecutorState } from '../../types';
import type { PolicyExecutor } from '../../logic/policy-executor';

const log = logger.content;

// eff: binds temporary listeners to high-confidence interaction events (click, keypress) to trigger AudioContext.resume()
export function setupUserGestureListeners(
	state: PolicyExecutorState,
	audioController: WebAudioController,
	policyExecutor: PolicyExecutor
): void {
	let corsProbed = false;

	const handleUserGestureUnlock = () => {
		// eff: unlock AudioContext and CORS probing for subsequent policy calculations
		state.hasGesture = true;

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
// note: when popup opens, sync current DOM volume to state for immediate UI consistency
export function setupPopupConnectionListener(
	state: PolicyExecutorState,
	onPopupOpen?: () => void
): void {
	chrome.runtime.onConnect.addListener((port) => {
		if (port.name === 'popup-connection') {
			state.isPopupOpen = true;

			// eff: sync current DOM volume to state when popup opens (for immediate UI display)
			syncDomVolumeToState(state);

			// note: trigger any additional popup-open logic (e.g., applyState for visual sync)
			onPopupOpen?.();

			port.onDisconnect.addListener(() => {
				state.isPopupOpen = false;
			});
		}
	});
}

// eff: reads current DOM volume and syncs to state if not already interacted
// rule: only sync volume (for UI display), NEVER sync muted state from DOM
// theory: sites like bilibili have default-muted videos that should not pollute plugin state
function syncDomVolumeToState(state: PolicyExecutorState): void {
	const media = document.querySelector('video, audio') as HTMLMediaElement | null;
	if (!media) return;

	// rule: only sync volume if user hasn't explicitly set it via plugin
	// note: we intentionally skip syncing muted state to prevent default-muted sites from hijacking plugin state
	if (!state.userHasInteracted) {
		const currentVol = Math.round(media.volume * 100);
		// note: update ONLY volume for UI display, preserve plugin's muted state
		state.config.volume = currentVol;
	}
}
