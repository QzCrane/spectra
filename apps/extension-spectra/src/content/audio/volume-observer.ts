import { createLogger } from '../../shared/logger';

const log = createLogger('VolumeObserver');

// perf: packed state - bit flags for boolean fields
// bit 0: muted, bit 1: settingByPlugin, bit 2: hasReceivedUserEvent
export type ElementState = {
	volume: number;
	muted: boolean;
	speed: number;
	settingByPlugin: boolean;
	hasReceivedUserEvent: boolean;
	_flags: number;
};

// perf: flag constants
const FLAG_MUTED = 1;
const FLAG_SETTING_BY_PLUGIN = 2;
const FLAG_HAS_RECEIVED_USER_EVENT = 4;

// perf: inline flag operations
const setFlag = (f: number, flag: number, v: boolean): number => v ? f | flag : f & ~flag;
const hasFlag = (f: number, flag: number): boolean => (f & flag) !== 0;

// perf: WeakMap for O(1) state
const elementStates = new WeakMap<HTMLMediaElement, ElementState>();
const monitoredElements = new WeakSet<HTMLMediaElement>();

// perf: throttle state - packed into single object per element
const throttleStates = new WeakMap<HTMLMediaElement, { rafId: number; lastVol: number; lastSpeed: number }>();

// perf: frozen constants
const VOL_THRESHOLD = 0.005;
const SPEED_THRESHOLD = 0.005;

// perf: inline default state creation
const createState = (m: HTMLMediaElement): ElementState => ({
	volume: m.volume,
	muted: m.muted,
	speed: m.playbackRate,
	settingByPlugin: false,
	hasReceivedUserEvent: false,
	_flags: (m.muted ? FLAG_MUTED : 0)
});

export function getElementState(media: HTMLMediaElement): ElementState {
	let s = elementStates.get(media);
	if (!s) {
		s = createState(media);
		elementStates.set(media, s);
	}
	return s;
}

export function setElementState(media: HTMLMediaElement, p: Partial<ElementState>): void {
	const s = getElementState(media);
	if (p.volume !== undefined) s.volume = p.volume;
	if (p.muted !== undefined) {
		s.muted = p.muted;
		s._flags = setFlag(s._flags, FLAG_MUTED, p.muted);
	}
	if (p.speed !== undefined) s.speed = p.speed;
	if (p.settingByPlugin !== undefined) {
		s.settingByPlugin = p.settingByPlugin;
		s._flags = setFlag(s._flags, FLAG_SETTING_BY_PLUGIN, p.settingByPlugin);
	}
	if (p.hasReceivedUserEvent !== undefined) {
		s.hasReceivedUserEvent = p.hasReceivedUserEvent;
		s._flags = setFlag(s._flags, FLAG_HAS_RECEIVED_USER_EVENT, p.hasReceivedUserEvent);
	}
}

export const isMonitored = (media: HTMLMediaElement) => monitoredElements.has(media);
export const markMonitored = (media: HTMLMediaElement) => monitoredElements.add(media);

export interface MonitorContext {
	getUserInteracted: () => boolean;
	isSyncEnabled: () => boolean;
	getTargetVolume: () => number;
	getTargetMuted: () => boolean;
	onNativeVolumeChange: (volume: number, muted: boolean) => void;
	onNativeSpeedChange?: (speed: number) => void;
}

// perf: inline absolute value
const fastAbs = (x: number): number => x > 0 ? x : -x;

export function setupVolumeMonitor(media: HTMLMediaElement, ctx: MonitorContext): void {
	const s = getElementState(media);

	// perf: get or create throttle state
	let throttle = throttleStates.get(media);
	if (!throttle) {
		throttle = { rafId: 0, lastVol: media.volume, lastSpeed: media.playbackRate };
		throttleStates.set(media, throttle);
	}

	// eff: emptied handler - reset state
	media.addEventListener('emptied', () => {
		s.speed = 1;
		s.volume = media.volume;
		s.muted = media.muted;
		s._flags = setFlag(s._flags, FLAG_MUTED, media.muted);
		if (throttle) {
			throttle.lastVol = media.volume;
			throttle.lastSpeed = 1;
		}
	});

	// perf: volumechange with RAF throttling
	media.addEventListener('volumechange', e => {
		if (hasFlag(s._flags, FLAG_SETTING_BY_PLUGIN)) return;
		if (throttle.rafId !== 0) return;

		throttle.rafId = requestAnimationFrame(() => {
			throttle.rafId = 0;

			if (!ctx.getUserInteracted() && !e.isTrusted) return;

			const nv = media.volume;
			const nm = media.muted;
			const volDiff = fastAbs(nv - ctx.getTargetVolume());
			const muteDiff = nm !== ctx.getTargetMuted();

			if (!ctx.isSyncEnabled()) {
				// Advanced mode
				const wasMuted = hasFlag(s._flags, FLAG_MUTED);
				if (wasMuted && !nm && nv > 0) {
					log.debug('[DOM] Adv Unmute');
					ctx.onNativeVolumeChange(-1, nm);
				} else if (fastAbs(nv - s.volume) > VOL_THRESHOLD) {
					log.debug(`[DOM] Adv Vol: ${(nv * 100) | 0}%`);
					ctx.onNativeVolumeChange(nv, nm);
				}
				s.volume = nv;
				s.muted = nm;
				s._flags = setFlag(s._flags, FLAG_MUTED, nm);
				return;
			}

			// Sync mode
			const allowMute = ctx.getUserInteracted() || hasFlag(s._flags, FLAG_HAS_RECEIVED_USER_EVENT);
			if (volDiff > VOL_THRESHOLD) {
				log.debug(`[DOM] Vol: ${(nv * 100) | 0}%`);
				ctx.onNativeVolumeChange(nv, allowMute ? nm : ctx.getTargetMuted());
				s.volume = nv;
				s.muted = nm;
				s._flags = setFlag(s._flags, FLAG_MUTED, nm);
				s._flags = setFlag(s._flags, FLAG_HAS_RECEIVED_USER_EVENT, true);
				s.hasReceivedUserEvent = true;
			} else if (muteDiff && allowMute) {
				log.debug(`[DOM] Mute: ${nm}`);
				ctx.onNativeVolumeChange(-1, nm);
				s.volume = nv;
				s.muted = nm;
				s._flags = setFlag(s._flags, FLAG_MUTED, nm);
				s._flags = setFlag(s._flags, FLAG_HAS_RECEIVED_USER_EVENT, true);
				s.hasReceivedUserEvent = true;
			} else {
				s.volume = nv;
				s.muted = nm;
				s._flags = setFlag(s._flags, FLAG_MUTED, nm);
			}
		});
	});

	// perf: ratechange with RAF throttling
	media.addEventListener('ratechange', () => {
		if (hasFlag(s._flags, FLAG_SETTING_BY_PLUGIN)) return;

		if (throttle.rafId !== 0) {
			throttle.lastSpeed = media.playbackRate;
			return;
		}

		throttle.rafId = requestAnimationFrame(() => {
			throttle.rafId = 0;
			const ns = media.playbackRate;
			if (fastAbs(ns - s.speed) > SPEED_THRESHOLD) {
				log.debug(`[DOM] Rate: ${ns}`);
				ctx.onNativeSpeedChange?.(ns);
				s.speed = ns;
			}
		});
	});
}
