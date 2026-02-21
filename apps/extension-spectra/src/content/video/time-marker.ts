// goal: manages transient in-page time markers for quick navigation within video elements

import { createLogger } from '../../shared/logger';
import { getPrimaryVideo } from '../utils/media-utils';

const log = createLogger('Marker');

interface TimeMarker {
	id: string;
	time: number;
	label: string;
}

const markers: TimeMarker[] = [];

function generateId(): string {
	return `m_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

function formatTime(seconds: number): string {
	const m = Math.floor(seconds / 60);
	const s = Math.floor(seconds % 60);
	return `${m}:${s.toString().padStart(2, '0')}`;
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
