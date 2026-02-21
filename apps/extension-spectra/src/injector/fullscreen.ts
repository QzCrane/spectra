// goal: handle fullscreen conflicts with audio capture/WebAudio
// theory: CAPTURE and WEBAUDIO modes conflict with Chrome's fullscreen pipeline

// inv: tracks content script capture/WebAudio state
let isCaptureActive = false;
let isWebAudioActive = false;

export function initFullscreenInterceptor(): void {
	const originalRequestFullscreen = Element.prototype.requestFullscreen;
	// @ts-ignore
	const originalWebkitRequestFullscreen = Element.prototype.webkitRequestFullscreen;

	document.addEventListener('fullscreenchange', () => {
		if (document.fullscreenElement) {
			window.postMessage({ type: 'SPECTRA_FULLSCREEN_ENTERED' }, '*');
		}
	});

	Element.prototype.requestFullscreen = async function (options?: FullscreenOptions) {
		await prepareFullscreen();
		return originalRequestFullscreen.call(this, options);
	};

	if (originalWebkitRequestFullscreen) {
		// @ts-ignore
		Element.prototype.webkitRequestFullscreen = async function (options) {
			await prepareFullscreen();
			return originalWebkitRequestFullscreen.call(this, options);
		};
	}
}

// eff: pauses enhanced audio before fullscreen to avoid pipeline deadlock
async function prepareFullscreen(): Promise<void> {
	if (isCaptureActive || isWebAudioActive) {
		window.postMessage({ type: 'SPECTRA_PAUSE_FOR_FULLSCREEN' }, '*');
		setAllMediaVolume(1);
		await waitForPauseConfirm();
	}
}

function setAllMediaVolume(vol: number) {
	document.querySelectorAll('video, audio').forEach((el) => {
		try {
			(el as HTMLMediaElement).volume = vol;
			(el as HTMLMediaElement).muted = false;
		} catch { }
	});
}

const waitForPauseConfirm = () => new Promise<void>(resolve => {
	const timer = setTimeout(resolve, 200);
	const handler = (e: MessageEvent) => {
		if (e.data?.type === 'SPECTRA_PAUSE_CONFIRMED') {
			clearTimeout(timer);
			window.removeEventListener('message', handler);
			resolve();
		}
	};
	window.addEventListener('message', handler);
});

// eff: sync state from content script
export function updateCaptureState(active: boolean) { isCaptureActive = active; }
export function updateWebAudioState(active: boolean) { isWebAudioActive = active; }
