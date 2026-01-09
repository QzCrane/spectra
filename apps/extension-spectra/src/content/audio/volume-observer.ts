import { logger } from '../../shared/logger';

const log = logger.content;

export type ElementState = {
	volume: number;
	muted: boolean;
	settingByPlugin: boolean;
	// guard: true if this element has processed at least one volumechange after initial setup
	hasReceivedUserEvent: boolean;
};

const monitoredElements = new WeakSet<HTMLMediaElement>();
const elementStates = new WeakMap<HTMLMediaElement, ElementState>();

export function getElementState(media: HTMLMediaElement): ElementState {
	return elementStates.get(media) || { volume: media.volume, muted: media.muted, settingByPlugin: false, hasReceivedUserEvent: false };
}

export function setElementState(media: HTMLMediaElement, state: Partial<ElementState>): void {
	const current = elementStates.get(media) || { volume: media.volume, muted: media.muted, settingByPlugin: false, hasReceivedUserEvent: false };
	elementStates.set(media, { ...current, ...state });
}

export function isMonitored(media: HTMLMediaElement): boolean {
	return monitoredElements.has(media);
}

export function markMonitored(media: HTMLMediaElement): void {
	monitoredElements.add(media);
}

export interface MonitorContext {
	getUserInteracted: () => boolean;
	isSyncEnabled: () => boolean;
	getTargetVolume: () => number;
	getTargetMuted: () => boolean;
	onNativeVolumeChange: (volume: number, muted: boolean) => void;
}

export function setupVolumeMonitor(media: HTMLMediaElement, ctx: MonitorContext): void {
	if (!elementStates.has(media)) {
		elementStates.set(media, { volume: media.volume, muted: media.muted, settingByPlugin: false, hasReceivedUserEvent: false });
	}

	media.addEventListener('volumechange', (event) => {
		const state = elementStates.get(media)!;
		if (state.settingByPlugin) return;

		// rule: if user hasn't interacted with plugin, ignore native volume changes entirely
		// EXCEPTION: if the event is a trusted user interaction (e.g. manual slider drag), allow it
		if (!ctx.getUserInteracted() && !event.isTrusted) return;

		const newVol = media.volume, newMuted = media.muted;

		// rule: precise diff detection to support smooth "Direct Take"
		const targetVol = ctx.getTargetVolume();
		const targetMuted = ctx.getTargetMuted();
		const volDiff = Math.abs(newVol - targetVol);
		const muteDiff = newMuted !== targetMuted;

		// rule: Advanced Mode (WebAudio/Capture boost) still needs to sync native 0-100% changes
		// note: in this mode, we compare against lastKnownVolume (element's own state), not targetVolume
		if (!ctx.isSyncEnabled()) {
			// Detect implicit unmute: user dragged volume from 0 to non-zero
			const implicitUnmute = state.muted && !newMuted && newVol > 0;

			if (newMuted !== state.muted || implicitUnmute) {
				log.debug(`[DOM] Advanced Mode Mute: ${newMuted} (implicit=${implicitUnmute})`);
				ctx.onNativeVolumeChange(-1, newMuted);
			}

			// rule: sync volume changes within 0-100% range even in Advanced Mode
			// epsilon: 0.005 to capture discrete steps on native sliders (often 0.01)
			const volChanged = Math.abs(newVol - state.volume) > 0.005;
			if (volChanged) {
				log.debug(`[DOM] Advanced Mode Volume: ${(newVol * 100).toFixed(0)}%`);
				ctx.onNativeVolumeChange(newVol, newMuted);
			}

			elementStates.set(media, { ...state, volume: newVol, muted: newMuted });
			return;
		}

		// rule: NATIVE_LITE sync with stricter mute protection
		// theory: first volumechange after element setup is often page-init (default muted videos)
		// mute sync requires: 1) user interacted with plugin, OR 2) element already received a user-initiated change
		// this prevents sites like bilibili (default-muted) from hijacking plugin state on page load
		const allowMuteSync = ctx.getUserInteracted() || state.hasReceivedUserEvent;

		if (volDiff > 0.005) {
			log.debug(`[DOM] Native Volume: ${(newVol * 100).toFixed(0)}%`);
			// rule: sync volume, but preserve plugin's mute state if mute sync is blocked
			const mutedToSync = allowMuteSync ? newMuted : targetMuted;
			ctx.onNativeVolumeChange(newVol, mutedToSync);
			// note: after a volume change from user, future mute syncs are allowed for this element
			elementStates.set(media, { ...state, volume: newVol, muted: newMuted, hasReceivedUserEvent: true });
		} else if (muteDiff && allowMuteSync) {
			log.debug(`[DOM] Native Mute: ${newMuted}`);
			ctx.onNativeVolumeChange(-1, newMuted);
			elementStates.set(media, { ...state, volume: newVol, muted: newMuted, hasReceivedUserEvent: true });
		} else {
			// note: update local state without triggering sync
			elementStates.set(media, { ...state, volume: newVol, muted: newMuted });
		}
	});
}
