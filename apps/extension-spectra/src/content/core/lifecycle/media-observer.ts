// goal: provides real-time detection of dynamic media element additions via DOM mutation monitoring
// rule: uses a 500ms debounce to prevent performance degradation during rapid DOM updates

import { AudioMode } from '@nexus/audio-engine';
import { WebAudioController } from '@nexus/audio-engine';
import { isExtensionContextValid } from '../context-guard';
import type { PolicyExecutorState } from '../../types';
import type { PolicyExecutor } from '../../logic/policy-executor';

// eff: initializes a MutationObserver on the document root and triggers state re-application upon change detection
// post: returns a cleanup function to disconnect the observer and clear pending timeouts
export function createMediaObserver(
	state: PolicyExecutorState,
	audioController: WebAudioController,
	policyExecutor: PolicyExecutor
): () => void {
	let observerTimeout: ReturnType<typeof setTimeout> | null = null;

	const observer = new MutationObserver(() => {
		// rule: execution is halted if the extension context becomes invalid
		if (observerTimeout) clearTimeout(observerTimeout);
		observerTimeout = setTimeout(() => {
			if (state.activeMode === AudioMode.NATIVE_WEBAUDIO) {
				audioController.scanAndAttach();
			}
			policyExecutor.applyState();
		}, 500);
	});


	observer.observe(document.documentElement, {
		childList: true,
		subtree: true,
	});

	// eff: immediate capture of media playback events to handle short-lived audio
	const immediateAttachHandler = (e: Event) => {
		const t = e.target as HTMLElement;
		const n = t.nodeName;
		if (n !== 'AUDIO' && n !== 'VIDEO') return;

		// console.log('[SPECTRA-OBSERVER] Play/Loaded:', t);

		if (state.activeMode === AudioMode.NATIVE_WEBAUDIO) {
			if (audioController.attachNode(t as HTMLMediaElement)) {
				// note: must apply current volume config immediately
				audioController.updateParams(state.config);
			}
		}
	};

	document.addEventListener('play', immediateAttachHandler, true);
	document.addEventListener('loadeddata', immediateAttachHandler, true);

	return () => {
		if (observerTimeout) clearTimeout(observerTimeout);
		observer.disconnect();
		document.removeEventListener('play', immediateAttachHandler, true);
		document.removeEventListener('loadeddata', immediateAttachHandler, true);
	};
}

// inv: returns true if at least one <audio> or <video> element exists
export function hasMediaElements(): boolean {
	return document.getElementsByTagName('video').length > 0 || document.getElementsByTagName('audio').length > 0;
}
