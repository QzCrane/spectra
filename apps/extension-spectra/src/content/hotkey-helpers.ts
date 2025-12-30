// goal: helper utilities for translating content-script hotkey interactions into background-layer commands

import type { HotkeyAction, HotkeyParams, AudioConfig } from '@nexus/contracts';
import { Actions } from '@nexus/contracts';
import { listMarkers } from './time-marker';
import { showToast } from './toast';

// cachedConfig: volatile memory cache for rapidly changing audio parameters (e.g., volume scrolling)
let cachedConfig: Partial<AudioConfig> = { volume: 100, muted: false };

export function setCachedConfig(config: Partial<AudioConfig>): void {
	cachedConfig = { ...cachedConfig, ...config };
}

// eff: calculates new volume/mute states and dispatches AUDIO_SET_CONFIG to the background service worker
export function sendVolumeAction(action: HotkeyAction, params?: HotkeyParams): void {
	const step = params?.step ?? 10;
	let newConfig: Partial<AudioConfig> = {};

	switch (action) {
		case 'volume_up':
			// inv: cap volume at 800% to prevent extreme digital clipping
			newConfig = { volume: Math.min(800, (cachedConfig.volume ?? 100) + step) };
			break;
		case 'volume_down':
			newConfig = { volume: Math.max(0, (cachedConfig.volume ?? 100) - step) };
			break;
		case 'volume_mute':
			newConfig = { muted: !cachedConfig.muted };
			break;
		case 'volume_set':
			if (params?.volume !== undefined) newConfig = { volume: params.volume };
			break;
	}

	chrome.runtime.sendMessage({
		action: Actions.AUDIO_SET_CONFIG,
		payload: newConfig
	});
}

// eff: resets all domain-specific audio processing (EQ, gain, compression) to baseline values
export function sendAudioReset(): void {
	chrome.runtime.sendMessage({
		action: Actions.AUDIO_SET_CONFIG,
		payload: { volume: 100, muted: false, eq: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0], bass: 0, compressor: 0 }
	});
}

export function sendCaptureToggle(): void {
	chrome.runtime.sendMessage({ action: Actions.CAPTURE_TOGGLE });
}

// goal: navigate the video playhead to the nearest user-defined marker
// eff: updates HTMLVideoElement.currentTime and displays a confirmation toast
export function jumpMarker(forward: boolean): void {
	const markers = listMarkers();
	if (!markers.length) return;
	const video = document.querySelector('video');
	if (!video) return;
	const currentTime = video.currentTime;

	if (forward) {
		const next = markers.find(m => m.time > currentTime + 0.5);
		if (next) {
			video.currentTime = next.time;
			showToast(`Jump to ${next.label}`);
		}
	} else {
		const prev = [...markers].reverse().find(m => m.time < currentTime - 0.5);
		if (prev) {
			video.currentTime = prev.time;
			showToast(`Jump to ${prev.label}`);
		}
	}
}

// eff: toggles the native 'loop' attribute on the primary video element
export function toggleLoop(): void {
	const video = document.querySelector('video');
	if (video) {
		video.loop = !video.loop;
		showToast(video.loop ? 'Loop ON' : 'Loop OFF');
	}
}

// eff: dispatches browser-level tab management commands (pin, mute) to the background
export function sendTabAction(action: HotkeyAction): void {
	chrome.runtime.sendMessage({ action: action === 'tab_pin' ? 'TAB_PIN' : 'TAB_MUTE' });
}
