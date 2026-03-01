// goal: YouTube API integration for MAIN world (content script cannot access yt API)
// theory: YouTube player API only accessible in MAIN world, use postMessage bridge

let ytPlayer: any = null;
let currentTargetSpeed = 1;

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
			case 'SPECTRA_YT_SPEED':
				currentTargetSpeed = speed;
				handleYtSpeed(speed);
				break;
			case 'SPECTRA_YT_VOLUME':
				handleYtVolume(volume, muted);
				break;
		}
	});

	// intercept SPA transitions natively in MAIN world to ensure immediate application
	window.addEventListener('yt-page-data-updated', () => {
		if (currentTargetSpeed !== 1) {
			handleYtSpeed(currentTargetSpeed);
		}
	});

	// rule: Invincible physical DOM trap. When YouTube changes video src natively (SPA), 
	// the browser bypasses all JS setters and silently forces 1.0x, firing ratechange.
	// This captures that rogue reset and violently throws the speed back into place.
	document.addEventListener('ratechange', (e) => {
		const v = e.target as HTMLVideoElement;
		if (v && v.tagName === 'VIDEO' && currentTargetSpeed !== 1) {
			if (Math.abs(v.playbackRate - currentTargetSpeed) > 0.005) {
				v.playbackRate = currentTargetSpeed;
			}
		}
	}, true);
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
		const state = yt.getPlayerState ? yt.getPlayerState() : 1;
		const isAd = document.querySelector('.ad-showing') !== null || (typeof yt.getAdState === 'function' && yt.getAdState() === 1);

		// rule: if video is buffering (3), unstarted (-1), cued (5), or playing an ad, 
		// rate changes are 100% programmatic (internal API resets).
		// We explicitly ignore these to protect the user's target speed.
		if (isAd || state === -1 || state === 3 || state === 5) {
			if (currentTargetSpeed !== rate) {
				// Re-assert our target speed to counteract the reset
				yt.setPlaybackRate(currentTargetSpeed);
			}
			return;
		}

		// Otherwise, it’s highly likely a genuine UI click from the user (state is 1 or 2).
		currentTargetSpeed = rate;
		window.postMessage({ type: 'SPECTRA_YT_SYNC_BACK', speed: rate }, '*');
	});
}

function handleYtSpeed(rate: number): void {
	const yt = ytPlayer || document.querySelector('#movie_player') as any;
	if (!yt || typeof yt.setPlaybackRate !== 'function') return;

	try {
		yt.setPlaybackRate(rate);

		// fix: Force sync underlying physical video elements immediately.
		// YouTube's API often caches the speed during navigation while the new `<video>` tag resets natively to 1.
		const videos = document.getElementsByTagName('video');
		for (let i = 0; i < videos.length; i++) {
			const v = videos[i];
			if (v && Math.abs(v.playbackRate - rate) > 0.005) {
				v.playbackRate = rate;
			}
		}

		window.postMessage({ type: 'SPECTRA_YT_SPEED_OK', speed: rate }, '*');
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
