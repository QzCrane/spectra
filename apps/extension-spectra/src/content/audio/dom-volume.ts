// goal: Sync DOM media volume with plugin state
// role: manages DOM-based volume control with event-based monitoring

import { createLogger } from '../../shared/logger';
import { getElementState, isMonitored, markMonitored, setupVolumeMonitor, type MonitorContext } from './volume-observer';
import { isYouTube, setYouTubeVolume } from '../adapters/youtube-adapter';
import { applyToMedia } from '../utils/media-utils';

const log = createLogger('DOMVolume');

let targetVolume = 1, targetMuted = false;
let syncEnabled = true, userInteracted = false;
let onNativeVolumeChange: ((v: number, m: boolean) => void) | null = null;
let onNativeSpeedChange: ((s: number) => void) | null = null;

export const markUserInteracted = () => { userInteracted = true; };
export const hasUserInteracted = () => userInteracted;
export const setNativeVolumeCallback = (cb: (v: number, m: boolean) => void) => { onNativeVolumeChange = cb; };
export const setNativeSpeedCallback = (cb: (s: number) => void) => { onNativeSpeedChange = cb; };

// eff: Static context object to avoid closure allocation per element
const ctx: MonitorContext = {
	getUserInteracted: () => userInteracted,
	isSyncEnabled: () => syncEnabled,
	getTargetVolume: () => targetVolume,
	getTargetMuted: () => targetMuted,
	onNativeVolumeChange: (v, m) => onNativeVolumeChange?.(v, m),
	onNativeSpeedChange: (s) => onNativeSpeedChange?.(s),
};

function ensureMonitoring(): void {
	applyToMedia(m => {
		if (!isMonitored(m)) { setupVolumeMonitor(m, ctx); markMonitored(m); }
	});
}

export function setDomVolume(vol: number, muted: boolean): void {
	ensureMonitoring();
	const normalizedVol = vol > 1 ? vol / 100 : vol;

	if (Math.abs(targetVolume - normalizedVol) < 0.005 && targetMuted === muted) return;

	targetVolume = normalizedVol;
	targetMuted = muted;

	if (isYouTube()) setYouTubeVolume(vol, muted);

	let applied = 0;
	applyToMedia(m => {
		if (Math.abs(m.volume - normalizedVol) < 0.005 && m.muted === muted) return;
		const s = getElementState(m);
		s.volume = normalizedVol; s.muted = muted; s.settingByPlugin = true;
		try { m.volume = normalizedVol; m.muted = muted; applied++; } catch { }
		setTimeout(() => { s.settingByPlugin = false; }, 100);
	});

	if (applied) log.debug(`[DOM] Vol Applied: ${(normalizedVol * 100) | 0}% -> ${applied}`);
}

export function releaseVolumeLock(): void {
	syncEnabled = false; targetVolume = 1; targetMuted = false;
	ensureMonitoring();

	applyToMedia(m => {
		const s = getElementState(m);
		s.settingByPlugin = true;
		try { m.volume = 1; m.muted = false; } catch { }
		setTimeout(() => { s.settingByPlugin = false; }, 100);
	});
}

export function enableVolumeLock(vol: number, muted: boolean): void {
	syncEnabled = true;
	setDomVolume(vol, muted);
}

export const enableDirectTake = () => { syncEnabled = false; };
