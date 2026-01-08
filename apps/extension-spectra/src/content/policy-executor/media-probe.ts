// goal: identifies suitable media elements to trigger CORS probing via AudioContext attachment

// post: returns a media element that is actively playing with audible volume and meaningful duration
export function findProbeCandidate(): HTMLMediaElement | null {
	const elements = document.querySelectorAll('video, audio');

	for (const el of elements) {
		const media = el as HTMLMediaElement;

		// inv: skip elements that are already under management or have been previously probed in the current session
		if (media.dataset.vmProbed === 'true' || media.dataset.vmAttached === 'true') {
			continue;
		}

		// rule: candidate must be audible (>5% volume) and playing to ensure AnalyserNode can capture data
		const isPlaying = !media.paused && !media.ended;
		const hasAudio = !media.muted && media.volume > 0.05;
		// note: infinite duration (live streams) or elements > 5s are preferred; skip short looping previews
		const hasEnoughDuration = media.duration >= 5 || isNaN(media.duration);
		const isNotLoop = !media.loop;

		if (isPlaying && hasAudio && hasEnoughDuration && isNotLoop) {
			return media;
		}
	}

	return null;
}
