// goal: tracks silence duration by monitoring media pause timestamps for domain-agnostic pause retention logic

// pausedAt: epoch timestamp (ms) when all media stopped playing; null if any media is active
let pausedAt: number | null = null;

export function getPausedAt(): number | null {
	return pausedAt;
}

// eff: updates the global pause timestamp based on aggregate playback state
export function updatePausedAt(hasPlaying: boolean, hasElements: boolean): void {
	if (hasPlaying) {
		pausedAt = null;
	} else if (pausedAt === null && hasElements) {
		pausedAt = Date.now();
	} else if (!hasElements) {
		pausedAt = null;
	}
}
