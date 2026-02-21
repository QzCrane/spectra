// goal: provides real-time detection of dynamic media element additions via DOM mutation monitoring
// rule: uses a 500ms debounce to prevent performance degradation during rapid DOM updates

import { AudioMode } from '@nexus/audio-engine';
import { WebAudioController } from '@nexus/audio-engine';
import { isExtensionContextValid } from '../context-guard';
import { debounce, createEventListener, createCleanupManager } from '../../utils/timing';
import { hasMediaElements as hasMedia } from '../../utils/media-utils';
import type { PolicyExecutorState } from '../../types';
import type { PolicyExecutor } from '../../logic/policy-executor';

export const hasMediaElements = hasMedia;

export function createMediaObserver(
	state: PolicyExecutorState,
	audioController: WebAudioController,
	policyExecutor: PolicyExecutor
): () => void {
	const cleanup = createCleanupManager();

	const debouncedApply = debounce(() => {
		if (state.activeMode === AudioMode.NATIVE_WEBAUDIO) audioController.scanAndAttach();
		policyExecutor.applyState();
	}, 500);

	const observer = new MutationObserver(() => {
		if (!isExtensionContextValid()) return;
		debouncedApply();
	});

	observer.observe(document.documentElement, { childList: true, subtree: true });
	cleanup.add(() => observer.disconnect());

	const immediateAttachHandler = (e: Event) => {
		const t = e.target as HTMLElement;
		if (t.nodeName !== 'AUDIO' && t.nodeName !== 'VIDEO') return;

		if (state.activeMode === AudioMode.NATIVE_WEBAUDIO) {
			if (audioController.attachNode(t as HTMLMediaElement)) {
				audioController.updateParams(state.config);
			}
		}
		policyExecutor.applyState();
	};

	cleanup.add(createEventListener(document, 'play', immediateAttachHandler, true));
	cleanup.add(createEventListener(document, 'loadeddata', immediateAttachHandler, true));
	cleanup.add(debouncedApply.cancel);

	return cleanup.dispose;
}
