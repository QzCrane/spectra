// goal: centralized media element utilities - eliminates code duplication
// role: provides optimized DOM queries for video/audio elements

// eff: O(N) single-pass, zero-alloc primary video detection
export function getPrimaryVideo(): HTMLVideoElement | null {
	const v = document.getElementsByTagName('video');
	let best: HTMLVideoElement | null = null;
	let maxA = 0;

	for (let i = 0, l = v.length; i < l; i++) {
		const el = v[i];
		if (!el) continue;
		const rect = el.getBoundingClientRect();
		const a = rect.width * rect.height;
		if (a > maxA) { maxA = a; best = el; }
	}
	return best || (v.length > 0 ? v[0]! : null);
}

// eff: O(N) single-pass, zero-alloc primary media detection (video + audio)
export function getPrimaryMedia(): HTMLMediaElement | null {
	const v = document.getElementsByTagName('video');
	const a = document.getElementsByTagName('audio');
	let best: HTMLMediaElement | null = null;
	let maxA = 0;

	for (let i = 0, l = v.length; i < l; i++) {
		const el = v[i];
		if (!el) continue;
		const rect = el.getBoundingClientRect();
		const area = rect.width * rect.height;
		if (area > maxA) { maxA = area; best = el; }
	}
	for (let i = 0, l = a.length; i < l; i++) {
		const el = a[i];
		if (!el) continue;
		const rect = el.getBoundingClientRect();
		const area = rect.width * rect.height;
		if (area > maxA) { maxA = area; best = el; }
	}
	return best;
}

// eff: iterator for all media elements - avoids array allocation
export function* iterateMedia(includeAudio = true): Generator<HTMLMediaElement> {
	const v = document.getElementsByTagName('video');
	for (let i = 0, l = v.length; i < l; i++) {
		const el = v[i];
		if (el) yield el;
	}
	if (includeAudio) {
		const a = document.getElementsByTagName('audio');
		for (let i = 0, l = a.length; i < l; i++) {
			const el = a[i];
			if (el) yield el;
		}
	}
}

// eff: fast existence check
export function hasMediaElements(): boolean {
	return document.getElementsByTagName('video').length > 0 ||
		document.getElementsByTagName('audio').length > 0;
}

// eff: check if any media is playing
export function isAnyMediaPlaying(): boolean {
	for (const m of iterateMedia()) {
		if (!m.paused && m.currentTime > 0) return true;
	}
	return false;
}

// eff: apply callback to all media elements with state management
export function applyToMedia(
	fn: (m: HTMLMediaElement) => void,
	includeAudio = true
): void {
	for (const m of iterateMedia(includeAudio)) fn(m);
}
