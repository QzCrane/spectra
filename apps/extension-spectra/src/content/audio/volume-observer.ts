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

export function isMonitored(media: HTMLMediaElement): boolean {
	return monitoredElements.has(media);
}

export function markMonitored(media: HTMLMediaElement): void {
	monitoredElements.add(media);
}

export function setSettingByPlugin(media: HTMLMediaElement, value: boolean): void {
	const s = getElementState(media);
	s.settingByPlugin = value;
	s._flags = setFlag(s._flags, FLAG_SETTING_BY_PLUGIN, value);
}

const fastAbs = (n: number): number => n < 0 ? -n : n;

export type MonitorContext = {
	getTargetVolume: () => number;
	getTargetMuted: () => boolean;
	getUserInteracted: () => boolean;
	isSyncEnabled: () => boolean;
	onNativeVolumeChange: (volume: number, muted: boolean) => void;
	onNativeSpeedChange: (speed: number) => void;
};

export function setupVolumeMonitor(media: HTMLMediaElement, ctx: MonitorContext): void {
	const s = getElementState(media);
	const throttle = { rafId: 0, lastVol: media.volume, lastSpeed: media.playbackRate };
	throttleStates.set(media, throttle);

	// rule: initial state sync if element already has weird values (e.g. from previous session)
	if (fastAbs(media.volume - ctx.getTargetVolume()) > 0.3) {
		log.debug('[DOM] Initial volume mismatch, reporting...');
		ctx.onNativeVolumeChange(media.volume, media.muted);
	}

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
		if (throttle.rafId !== 0) return;

		throttle.rafId = requestAnimationFrame(() => {
			throttle.rafId = 0;
			const ns = media.playbackRate;
			// note: we don't have getTargetSpeed in ctx currently, but we can compare to state
			// for now let's just trigger callback
			ctx.onNativeSpeedChange(ns);
			s.speed = ns;
		});
	});
}
