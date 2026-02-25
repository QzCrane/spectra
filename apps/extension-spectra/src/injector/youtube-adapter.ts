// goal: YouTube API integration for MAIN world (content script cannot access yt API)
// theory: YouTube player API only accessible in MAIN world, use postMessage bridge

let ytPlayer: any = null;

export function initYouTubeAdapter(): void {
	// rule: wait for movie_player to be available before attaching listeners
	const checkInterval = setInterval(() => {
		const yt = document.querySelector('#movie_player') as any;
		if (yt && typeof yt.addEventListener === 'function') {
			clearInterval(checkInterval);
			attachPlayerListeners(yt);
		}
	}, 1000);

	window.addEventListener('message', (event) => {
		if (!event.data) return;
		const { type, speed, volume, muted } = event.data;

		switch (type) {
			case 'SPECTRA_YT_SPEED': handleYtSpeed(speed); break;
			case 'SPECTRA_YT_VOLUME': handleYtVolume(volume, muted); break;
		}
	});
}

function attachPlayerListeners(yt: any): void {
	ytPlayer = yt;
	// note: YouTube player API events are strings, not standard DOM events
	yt.addEventListener('onVolumeChange', (state: { volume: number; muted: boolean }) => {
		// rule: report actual player state BACK to content script as an "authoritative" native change
		window.postMessage({
			type: 'SPECTRA_YT_SYNC_BACK',
			volume: state.volume,
			muted: state.muted
		}, '*');
	});

	yt.addEventListener('onPlaybackRateChange', (rate: number) => {
		window.postMessage({
			type: 'SPECTRA_YT_SYNC_BACK',
			speed: rate
		}, '*');
	});
}

function handleYtSpeed(rate: number): void {
	const yt = ytPlayer || document.querySelector('#movie_player') as any;
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
	const yt = ytPlayer || document.querySelector('#movie_player') as any;
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
