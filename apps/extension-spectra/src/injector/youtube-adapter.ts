// goal: YouTube API integration for MAIN world (content script cannot access yt API)
// theory: YouTube player API only accessible in MAIN world, use postMessage bridge

export function initYouTubeAdapter(): void {
	window.addEventListener('message', (event) => {
		if (!event.data) return;
		const { type, speed, volume, muted } = event.data;

		switch (type) {
			case 'SPECTRA_YT_SPEED': handleYtSpeed(speed); break;
			case 'SPECTRA_YT_VOLUME': handleYtVolume(volume, muted); break;
		}
	});
}

function handleYtSpeed(rate: number): void {
	const yt = document.querySelector('#movie_player') as any;
	if (!yt || typeof yt.setPlaybackRate !== 'function') return;

	try {
		if (Math.abs(yt.getPlaybackRate() - rate) > 0.005) {
			yt.setPlaybackRate(rate);
			window.postMessage({ type: 'SPECTRA_YT_SPEED_OK', speed: rate }, '*');
		}
	} catch (e) {
		window.postMessage({ type: 'SPECTRA_YT_FAIL', feature: 'speed', error: String(e) }, '*');
	}
}

function handleYtVolume(volume: number, muted: boolean): void {
	const yt = document.querySelector('#movie_player') as any;
	if (!yt || typeof yt.setVolume !== 'function') return;

	try {
		if (Math.abs(yt.getVolume() - volume) > 1) {
			yt.setVolume(volume);
		}
		const currentlyMuted = yt.isMuted();
		if (currentlyMuted !== muted) {
			muted ? yt.mute() : yt.unMute();
		}
		window.postMessage({ type: 'SPECTRA_YT_VOLUME_OK', volume, muted }, '*');
	} catch (e) {
		window.postMessage({ type: 'SPECTRA_YT_FAIL', feature: 'volume', error: String(e) }, '*');
	}
}
