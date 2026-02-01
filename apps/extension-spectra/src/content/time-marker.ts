// goal: manages transient in-page time markers for quick navigation

import { createLogger } from '../shared/logger';

const log = createLogger('Marker');

interface TimeMarker { id: string; time: number; label: string; }
const markers: TimeMarker[] = [];

// eff: Fast ID generation
const generateId = () => `m_${Date.now().toString(36)}_${(Math.random() * 1e9 | 0).toString(36)}`;

// eff: Bitwise truncation for integer math
function formatTime(sec: number): string {
	const m = (sec / 60) | 0;
	const s = (sec % 60) | 0;
	return `${m}:${s < 10 ? '0' : ''}${s}`;
}

// eff: O(N) Zero-Alloc
function getPrimaryVideo(): HTMLVideoElement | null {
	const videos = document.getElementsByTagName('video');
	let best: HTMLVideoElement | null = null;
	let maxArea = 0;

	for (let i = 0, len = videos.length; i < len; i++) {
		const v = videos[i];
		if (!v) continue;
		const rect = v.getBoundingClientRect();
		const area = rect.width * rect.height;
		if (area > maxArea) {
			maxArea = area;
			best = v;
		}
	}
	return best || videos[0] || null;
}

export function addMarker(label?: string): TimeMarker | null {
	const video = getPrimaryVideo();
	if (!video) return null;

	const time = video.currentTime;
	const marker: TimeMarker = { id: generateId(), time, label: label || `Mark @ ${formatTime(time)}` };

	markers.push(marker);
	markers.sort((a, b) => a.time - b.time);

	log.info(`Added: ${marker.label}`);
	return marker;
}

export function removeMarker(id: string): boolean {
	const i = markers.findIndex(m => m.id === id);
	if (i === -1) return false;
	markers.splice(i, 1);
	return true;
}

export function jumpToMarker(id: string): { jumped: boolean; time: number } {
	const video = getPrimaryVideo();
	const marker = markers.find(m => m.id === id);

	if (!video || !marker) return { jumped: false, time: 0 };

	video.currentTime = marker.time;
	log.info(`Jumped to: ${marker.label}`);
	return { jumped: true, time: marker.time };
}

export function listMarkers(): TimeMarker[] {
	return [...markers];
}
