import { logger } from '../../shared/logger';

const log = logger.content;

export type ElementState = {
	volume: number;
	muted: boolean;
	settingByPlugin: boolean;
};

const monitoredElements = new WeakSet<HTMLMediaElement>();
const elementStates = new WeakMap<HTMLMediaElement, ElementState>();

export function getElementState(media: HTMLMediaElement): ElementState {
	return elementStates.get(media) || { volume: media.volume, muted: media.muted, settingByPlugin: false };
}

export function setElementState(media: HTMLMediaElement, state: Partial<ElementState>): void {
	const current = elementStates.get(media) || { volume: media.volume, muted: media.muted, settingByPlugin: false };
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
		elementStates.set(media, { volume: media.volume, muted: media.muted, settingByPlugin: false });
	}

	media.addEventListener('volumechange', (event) => {
		const state = elementStates.get(media);
		if (state?.settingByPlugin) return;

		// rule: if user hasn't interacted with plugin, ignore native volume changes entirely
		// EXCEPTION: if the event is a trusted user interaction (e.g. manual slider drag), allow it
		if (!ctx.getUserInteracted() && !event.isTrusted) return;

		const lastState = state || { volume: media.volume, muted: media.muted };
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
			const implicitUnmute = lastState.muted && !newMuted && newVol > 0;

			if (newMuted !== lastState.muted || implicitUnmute) {
				log.debug(`[DOM] Advanced Mode Mute: ${newMuted} (implicit=${implicitUnmute})`);
				ctx.onNativeVolumeChange(-1, newMuted);
			}

			// rule: sync volume changes within 0-100% range even in Advanced Mode
			// epsilon: 0.005 to capture discrete steps on native sliders (often 0.01)
			const volChanged = Math.abs(newVol - lastState.volume) > 0.005;
			if (volChanged) {
				log.debug(`[DOM] Advanced Mode Volume: ${(newVol * 100).toFixed(0)}%`);
				ctx.onNativeVolumeChange(newVol, newMuted);
			}

			elementStates.set(media, { volume: newVol, muted: newMuted, settingByPlugin: false });
			return;
		}

		// rule: NATIVE_LITE full sync
		if (volDiff > 0.005 || muteDiff) {
			log.debug(`[DOM] Native Volume: ${(newVol * 100).toFixed(0)}% (Muted: ${newMuted})`);
			ctx.onNativeVolumeChange(newVol, newMuted);
		}

		elementStates.set(media, { volume: newVol, muted: newMuted, settingByPlugin: false });
	});
}
