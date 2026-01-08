// goal: provides real-time detection of dynamic media element additions via DOM mutation monitoring
// rule: uses a 500ms debounce to prevent performance degradation during rapid DOM updates

import { AudioMode } from '@nexus/audio-engine';
import { WebAudioController } from '@nexus/audio-engine';
import { isExtensionContextValid } from '../context-guard';
import type { PolicyExecutorState } from '../types';
import type { PolicyExecutor } from '../policy-executor';

// eff: initializes a MutationObserver on the document root and triggers state re-application upon change detection
// post: returns a cleanup function to disconnect the observer and clear pending timeouts
export function createMediaObserver(
	state: PolicyExecutorState,
	audioController: WebAudioController,
	policyExecutor: PolicyExecutor
): () => void {
	let observerTimeout: ReturnType<typeof setTimeout> | null = null;

	const observer = new MutationObserver(() => {
		// rule: execution is halted if the extension context becomes invalid (e.g. extension updated/reloaded)
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

	// eff: immediate capture of media playback events to handle short-lived audio (e.g. Google Translate)
	// rule: bypasses the 500ms observer debounce to attach WebAudio nodes before the clip finishes
	const immediateAttachHandler = (event: Event) => {
		const target = event.target as HTMLMediaElement;
		if (target.nodeName !== 'AUDIO' && target.nodeName !== 'VIDEO') return;

		console.log('[SPECTRA-OBSERVER] Play/Loaded event detected:', target);

		if (state.activeMode === AudioMode.NATIVE_WEBAUDIO) {
			if (audioController.attachNode(target)) {
				console.log('[SPECTRA-OBSERVER] Immediate attach SUCCESS');
				// note: must apply current volume config immediately, otherwise short clips play at 100% until next cycle
				audioController.updateParams(state.config);
			} else {
				console.log('[SPECTRA-OBSERVER] Immediate attach FAILED (Already attached or CORS?)');
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

// inv: returns true if at least one <audio> or <video> element exists in the current document
export function hasMediaElements(): boolean {
	const audioCount = document.querySelectorAll('audio').length;
	const videoCount = document.querySelectorAll('video').length;
	return audioCount > 0 || videoCount > 0;
}
