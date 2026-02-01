/**
 * // goal: Sync DOM media volume with plugin state
 */

import { logger } from '../../shared/logger';
import { getElementState, isMonitored, markMonitored, setupVolumeMonitor, type MonitorContext } from './volume-observer';

const log = logger.content;
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
	// eff: live collection
	const videos = document.getElementsByTagName('video');
	const audio = document.getElementsByTagName('audio');

	for (let i = 0, l = videos.length; i < l; i++) {
		const m = videos[i]!;
		if (!isMonitored(m)) { setupVolumeMonitor(m, ctx); markMonitored(m); }
	}
	for (let i = 0, l = audio.length; i < l; i++) {
		const m = audio[i]!;
		if (!isMonitored(m)) { setupVolumeMonitor(m, ctx); markMonitored(m); }
	}
}

export function setDomVolume(vol: number, muted: boolean): void {
	ensureMonitoring();

	if (Math.abs(targetVolume - vol) < 0.005 && targetMuted === muted) return;

	targetVolume = vol;
	targetMuted = muted;

	const videos = document.getElementsByTagName('video');
	const audio = document.getElementsByTagName('audio');
	let applied = 0;

	const apply = (m: HTMLMediaElement) => {
		if (Math.abs(m.volume - vol) < 0.005 && m.muted === muted) return;

		const s = getElementState(m);
		s.volume = vol; s.muted = muted; s.settingByPlugin = true;

		try { m.volume = vol; m.muted = muted; applied++; } catch { }

		// eff: clear flag asynchronously
		setTimeout(() => { s.settingByPlugin = false; }, 100);
	};

	for (let i = 0, l = videos.length; i < l; i++) apply(videos[i]!);
	for (let i = 0, l = audio.length; i < l; i++) apply(audio[i]!);

	if (applied) log.debug(`[DOM] Vol Applied: ${(vol * 100) | 0}% -> ${applied}`);
}

export function releaseVolumeLock(): void {
	syncEnabled = false; targetVolume = 1; targetMuted = false;
	ensureMonitoring();

	const unlock = (m: HTMLMediaElement) => {
		const s = getElementState(m);
		s.settingByPlugin = true;
		try { m.volume = 1; m.muted = false; } catch { }
		setTimeout(() => { s.settingByPlugin = false; }, 100);
	};

	const videos = document.getElementsByTagName('video');
	const audio = document.getElementsByTagName('audio');
	for (let i = 0, l = videos.length; i < l; i++) unlock(videos[i]!);
	for (let i = 0, l = audio.length; i < l; i++) unlock(audio[i]!);
}

export function enableVolumeLock(vol: number, muted: boolean): void {
	syncEnabled = true;
	setDomVolume(vol, muted);
}

export const enableDirectTake = () => { syncEnabled = false; };
export { isAnyMediaPlaying, hasMediaElements } from './media-detection';
export { getPausedAt } from '../utils/pause-tracker';
