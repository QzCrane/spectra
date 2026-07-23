// goal: project the single MediaRegistry into DOM-volume and shared-WebAudio ownership

import { AudioMode, WebAudioController } from '@nexus/audio-engine';
import type { PolicyExecutor } from '../../logic/policy-executor';
import type { PolicyExecutorState } from '../../types';
import { debounce } from '../../utils/timing';
import { getActiveMediaRegistry } from '../media-registry';

export function hasMediaElements(): boolean {
	const registry = getActiveMediaRegistry();
	return (registry?.size ?? 0) > 0;
}

export function createMediaObserver(
	state: PolicyExecutorState,
	audioController: WebAudioController,
	policyExecutor: PolicyExecutor,
): () => void {
	const registry = getActiveMediaRegistry();
	if (!registry) throw new Error('The document media registry is unavailable');
	const disposers = new Map<string, () => void>();
	const reconcilePolicy = debounce(() => policyExecutor.applyState(), 50);

	const register = (mediaId: string, element: HTMLMediaElement): void => {
		if (disposers.has(mediaId)) return;
		// The registry and NativeMediaExecutor already own all media events and
		// standard-property writes. This projection owns only the optional audio
		// graph attachment, so native/bypass registration stays side-effect-free.
		disposers.set(mediaId, () => undefined);
		if (state.activeMode === AudioMode.NATIVE_WEBAUDIO) audioController.attachNode(element);
	};

	const unregister = (mediaId: string): void => {
		disposers.get(mediaId)?.();
		disposers.delete(mediaId);
	};

	for (const { element, target } of registry.list()) register(target.mediaId, element);
	const unsubscribe = registry.subscribe((target, event, element) => {
		if (event === 'registered') {
			register(target.mediaId, element);
			reconcilePolicy();
			return;
		}
		if (event === 'removed') {
			unregister(target.mediaId);
			audioController.detachNode(element);
			reconcilePolicy();
			return;
		}
		if (event === 'loadedmetadata' || event === 'play') {
			if (state.activeMode === AudioMode.NATIVE_WEBAUDIO) audioController.attachNode(element);
			reconcilePolicy();
		}
	});

	return () => {
		unsubscribe();
		reconcilePolicy.cancel();
		for (const dispose of disposers.values()) dispose();
		disposers.clear();
	};
}
