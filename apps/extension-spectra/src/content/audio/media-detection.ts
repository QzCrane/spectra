// goal: pure playback-state projection over the event-driven MediaRegistry

import { getActiveMediaRegistry } from '../core/media-registry';

export function isAnyMediaPlaying(): boolean {
	const registry = getActiveMediaRegistry();
	if (!registry) return false;
	return registry.hasPlayingMedia();
}

export function hasMediaElements(): boolean {
	return (getActiveMediaRegistry()?.size ?? 0) > 0;
}
