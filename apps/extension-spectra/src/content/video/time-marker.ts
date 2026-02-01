// goal: manages transient in-page time markers for quick navigation within video elements

import { createLogger } from '../../shared/logger';

const log = createLogger('Marker');

interface TimeMarker {
	id: string;
	time: number;
	label: string;
}

// markers: volatile list of user-defined timestamps; reset on page reload
const markers: TimeMarker[] = [];

function generateId(): string {
	return `m_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

function formatTime(seconds: number): string {
	const m = Math.floor(seconds / 60);
	const s = Math.floor(seconds % 60);
	return `${m}:${s.toString().padStart(2, '0')}`;
}

// post: returns the largest visible video element on the page, or the first available video as fallback
function getPrimaryVideo(): HTMLVideoElement | null {
	const v = document.getElementsByTagName('video');
	let best: HTMLVideoElement | null = null;
	let maxA = 0;
	// eff: Safe live collection iteration
	for (let i = 0, l = v.length; i < l; i++) {
		const el = v[i];
		if (!el) continue;
		const r = el.getBoundingClientRect();
		const a = r.width * r.height;
		if (a > maxA) { maxA = a; best = el; }
	}
	// eff: Safe return
	return best || (v.length > 0 ? v[0]! : null);
}

// eff: captures timestamps
export function addMarker(label?: string): TimeMarker | null {
	const v = getPrimaryVideo();
	if (!v) { log.warn('No video'); return null; }

	const t = v.currentTime;
	const m: TimeMarker = { id: generateId(), time: t, label: label || `Mark @ ${formatTime(t)}` };

	markers.push(m);
	markers.sort((a, b) => a.time - b.time);
	log.info(`Added: ${m.label}`);
	return m;
}

export function removeMarker(id: string): boolean {
	const i = markers.findIndex(m => m.id === id);
	if (i === -1) return false;
	markers.splice(i, 1);
	log.info(`Del: ${id}`);
	return true;
}

// eff: updates playback head
export function jumpToMarker(id: string): { jumped: boolean; time: number } {
	const v = getPrimaryVideo();
	const m = markers.find(mark => mark.id === id);

	if (!v || !m) { log.warn(!v ? 'No video' : 'No mark'); return { jumped: false, time: 0 }; }

	v.currentTime = m.time;
	log.info(`Jump: ${m.label}`);
	return { jumped: true, time: m.time };
}

export function listMarkers(): TimeMarker[] {
	return [...markers];
}
