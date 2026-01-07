/**
 * // goal: Sync DOM media volume with plugin state
 * // rule: Native site volume change takes precedence unless locked
 */

import { logger } from '../../shared/logger';
import { getElementState, setElementState, isMonitored, markMonitored, setupVolumeMonitor } from './volume-observer';

const log = logger.content;
let targetVolume = 1, targetMuted = false;
let syncEnabled = true;
let onNativeVolumeChange: ((volume: number, muted: boolean) => void) | null = null;
// inv: tracks if user has interacted with plugin. If false, native volume changes are ignored.
let userInteracted = false;

export function markUserInteracted(): void {
	userInteracted = true;
}

export function hasUserInteracted(): boolean {
	return userInteracted;
}

export function setNativeVolumeCallback(cb: (volume: number, muted: boolean) => void): void {
	onNativeVolumeChange = cb;
}

/**
 * // goal: ensure all media elements are monitored regardless of plugin state
 */
function ensureMonitoring(): void {
	const els = document.querySelectorAll('video, audio');
	els.forEach((el) => {
		const m = el as HTMLMediaElement;
		if (!isMonitored(m)) {
			setupVolumeMonitor(m, {
				getUserInteracted: () => userInteracted,
				isSyncEnabled: () => syncEnabled,
				getTargetVolume: () => targetVolume,
				getTargetMuted: () => targetMuted,
				onNativeVolumeChange: (v, m) => onNativeVolumeChange?.(v, m),
			});
			markMonitored(m);
		}
	});
}

/**
 * // eff: Apply volume to all media elements
 */
export function setDomVolume(volume: number, muted: boolean): void {
	// rule: always ensure monitoring is active before potential early returns
	ensureMonitoring();

	// rule: idempotent check - skip if no change
	if (Math.abs(targetVolume - volume) < 0.005 && targetMuted === muted) {
		return;
	}

	targetVolume = volume;
	targetMuted = muted;
	const els = document.querySelectorAll('video, audio');
	let applied = 0;

	els.forEach((el) => {
		const m = el as HTMLMediaElement;
		const diff = Math.abs(m.volume - volume) > 0.005 || m.muted !== muted;

		if (diff) {
			const state = getElementState(m);
			state.volume = volume;
			state.muted = muted;
			state.settingByPlugin = true;
			setElementState(m, state);

			try { m.volume = volume; m.muted = muted; applied++; } catch { /* ignore */ }

			setTimeout(() => {
				setElementState(m, { settingByPlugin: false });
			}, 100);
		}
	});

	if (applied > 0) log.debug(`[DOM] Volume Applied: ${(volume * 100).toFixed(0)}% -> ${applied}/${els.length}`);
}

/**
 * // goal: Release control to user (Advanced Mode)
 */
export function releaseVolumeLock(): void {
	syncEnabled = false;
	targetVolume = 1;
	targetMuted = false;

	ensureMonitoring();

	document.querySelectorAll('video, audio').forEach((el) => {
		const m = el as HTMLMediaElement;
		setElementState(m, { settingByPlugin: true });
		try { m.volume = 1; m.muted = false; } catch { }
		setTimeout(() => setElementState(m, { settingByPlugin: false }), 100);
	});
}

/**
 * // goal: Restore control (Native Lite)
 */
export function enableVolumeLock(volume: number, muted: boolean): void {
	syncEnabled = true;
	setDomVolume(volume, muted);
}

export function enableDirectTake(): void {
	syncEnabled = false;
}

export { isAnyMediaPlaying, hasMediaElements } from './media-detection';
export { getPausedAt } from '../utils/pause-tracker';
