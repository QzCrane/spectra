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
	const videos = Array.from(document.querySelectorAll('video'));
	if (!videos.length) return null;
	const visible = videos.filter(v => {
		const rect = v.getBoundingClientRect();
		return rect.width > 0 && rect.height > 0;
	});
	if (!visible.length) return videos[0] ?? null;
	visible.sort((a, b) => {
		const aRect = a.getBoundingClientRect();
		const bRect = b.getBoundingClientRect();
		return (bRect.width * bRect.height) - (aRect.width * aRect.height);
	});
	return visible[0] ?? null;
}

// eff: captures the current timestamp of the primary video and creates a labeled marker
export function addMarker(label?: string): TimeMarker | null {
	const video = getPrimaryVideo();
	if (!video) {
		log.warn('No video element found');
		return null;
	}

	const time = video.currentTime;
	const defaultLabel = label || `Mark @ ${formatTime(time)}`;
	const marker: TimeMarker = {
		id: generateId(),
		time,
		label: defaultLabel
	};

	markers.push(marker);
	// rule: markers are always kept chronologically sorted for UI consistency
	markers.sort((a, b) => a.time - b.time);
	log.info(`Added marker: ${marker.label} at ${formatTime(time)}`);
	return marker;
}

export function removeMarker(id: string): boolean {
	const index = markers.findIndex(m => m.id === id);
	if (index === -1) {
		log.warn(`Marker not found: ${id}`);
		return false;
	}

	const removed = markers.splice(index, 1)[0];
	if (removed) log.info(`Removed marker: ${removed.label}`);
	return true;
}

// eff: updates the primary video's playback head to the marker's timestamp
export function jumpToMarker(id: string): { jumped: boolean; time: number } {
	const video = getPrimaryVideo();
	const marker = markers.find(m => m.id === id);

	if (!video || !marker) {
		log.warn(!video ? 'No video element found' : `Marker not found: ${id}`);
		return { jumped: false, time: 0 };
	}

	video.currentTime = marker.time;
	log.info(`Jumped to marker: ${marker.label} (${formatTime(marker.time)})`);
	return { jumped: true, time: marker.time };
}

export function listMarkers(): TimeMarker[] {
	return [...markers];
}
