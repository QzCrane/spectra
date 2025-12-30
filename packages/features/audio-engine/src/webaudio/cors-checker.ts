// goal: CORS status detector using AnalyserNode data analysis (zero sum = restricted)
// note: v3.11 strategy - 500ms startup delay, 500ms check interval, 6s total observation window

import { corsLogger as corsLog } from '@nexus/kernel';

export type CorsCheckCallback = (restricted: boolean) => void;

// eff: filters out background/preview/ad videos that shouldn't trigger CORS registration
// rule: must have audio tracks, be unmuted, not looping, and exceed size/duration thresholds
function isMainVideo(el: HTMLMediaElement): boolean {
	const audioTracks = (el as HTMLVideoElement & { audioTracks?: { length: number } }).audioTracks;
	if (audioTracks && audioTracks.length === 0) {
		return false;
	}

	if (el.muted) {
		return false;
	}

	if (el.loop) {
		return false;
	}

	const src = el.src || el.currentSrc || '';
	const previewKeywords = ['preview', 'thumb', 'poster', 'cover', 'banner', 'ad', 'logo'];
	if (previewKeywords.some(kw => src.toLowerCase().includes(kw))) {
		return false;
	}

	if (el instanceof HTMLVideoElement) {
		if (el.videoWidth > 0 && el.videoWidth < 200) return false;
		if (el.videoHeight > 0 && el.videoHeight < 150) return false;

		const rect = el.getBoundingClientRect();
		if (rect.width < 200 || rect.height < 150) return false;
	}

	if (el.duration > 0 && el.duration < 30 && el.volume < 0.3) {
		return false;
	}

	return true;
}

const hasActiveAudio = isMainVideo;

// eff: schedules a finite observation window to determine CORS status; onResult(true) = RESTRICTED
export function scheduleCorsCheck(
	analyser: AnalyserNode,
	el: HTMLMediaElement,
	onResult: CorsCheckCallback
): void {
	const observeTimeout = 6000;
	const observeInterval = 500;
	const startDelay = 500;
	let settled = false;
	let observeTimer: ReturnType<typeof setInterval> | null = null;
	let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
	const hostname = window.location.hostname;

	corsLog.start(hostname, el);

	const cleanup = () => {
		if (observeTimer) clearInterval(observeTimer);
		if (timeoutTimer) clearTimeout(timeoutTimer);
	};

	const hasAudioData = (): boolean => {
		const data = new Uint8Array(analyser.frequencyBinCount);
		analyser.getByteFrequencyData(data);
		const sum = data.reduce((a, b) => a + b, 0);
		if (sum > 0) corsLog.log(`📊 ${hostname}: Data detected (sum=${sum})`);
		return sum > 0;
	};

	const startObserving = () => {
		// inv: wait for playback and unmuting before starting observation
		if (el.paused || el.muted) {
			corsLog.waiting();
			const onReady = () => {
				el.removeEventListener('play', onReady);
				el.removeEventListener('volumechange', onReady);
				if (settled) return;
				corsLog.resumed();
				startObserving();
			};
			el.addEventListener('play', onReady, { once: true });
			el.addEventListener('volumechange', onReady, { once: true });
			return;
		}

		corsLog.log(`🔍 ${hostname}: Starting observation (${observeTimeout / 1000}s window)`);

		observeTimer = setInterval(() => {
			if (settled) { cleanup(); return; }
			if (el.paused || el.muted) return;

			if (hasAudioData()) {
				// rule: only commit result for elements identified as main content
				if (!isMainVideo(el)) {
					corsLog.log(`⚠️ ${hostname}: Data detected but element is likely a preview; ignoring`);
					return;
				}
				settled = true;
				cleanup();
				corsLog.safe();
				onResult(false);
			}
		}, observeInterval);

		timeoutTimer = setTimeout(() => {
			if (settled) { cleanup(); return; }
			cleanup();

			if (!hasActiveAudio(el)) {
				corsLog.log(`⏸️ ${hostname}: Timeout reached but no active audio tracks; maintaining PENDING`);
				return;
			}

			settled = true;
			corsLog.log(`❌ ${hostname}: Observation timeout; marking RESTRICTED`);
			onResult(true);
		}, observeTimeout);
	};

	setTimeout(startObserving, startDelay);
}

