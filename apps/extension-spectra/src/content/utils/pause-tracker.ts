// goal: tracks silence duration by monitoring media pause timestamps for domain-agnostic pause retention logic

// pausedAt: epoch timestamp (ms) when all media stopped playing; null if any media is active
let pausedAt: number | null = null;

// pauseTracked: WeakSet to avoid redundant event listener attachment while preventing memory leaks
const pauseTracked = new WeakSet<HTMLMediaElement>();

export function getPausedAt(): number | null {
	return pausedAt;
}

// eff: updates the global pause timestamp based on aggregate playback state
export function updatePausedAt(hasPlaying: boolean, hasElements: boolean): void {
	if (hasPlaying) {
		pausedAt = null;
	} else if (pausedAt === null && hasElements) {
		pausedAt = Date.now();
	}
}

export function needsTracking(media: HTMLMediaElement): boolean {
	return !pauseTracked.has(media);
}

export function markTracked(media: HTMLMediaElement): void {
	pauseTracked.add(media);
}

// eff: attaches 'pause' and 'play' listeners to a media element to maintain the global silence duration state
export function setupPauseTracking(media: HTMLMediaElement, isAnyPlayingFn: () => boolean): void {
	media.addEventListener('pause', () => {
		if (!isAnyPlayingFn()) {
			pausedAt = Date.now();
		}
	});

	media.addEventListener('play', () => {
		pausedAt = null;
	});

	markTracked(media);
}
