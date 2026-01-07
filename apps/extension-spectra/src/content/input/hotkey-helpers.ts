// goal: helper utilities for translating content-script hotkey interactions into background-layer commands
// rule: updateConfigFn callback ensures changes go through Content Script's single source of truth

import type { HotkeyAction, HotkeyParams, AudioConfig } from '@nexus/contracts';
import { Actions } from '@nexus/contracts';
import { listMarkers } from '../video/time-marker';
import { showToast } from '../ui/toast';

// getConfigFn: callback to retrieve real-time config from Content Script main state
let getConfigFn: (() => AudioConfig) | null = null;

// updateConfigFn: callback to update config through Content Script's policyExecutor
let updateConfigFn: ((changes: Partial<AudioConfig>, options?: { showOSD?: boolean; unMute?: boolean }) => void) | null = null;

// eff: initializes the config getter callback - MUST be called during content script init
export function setConfigGetter(getter: () => AudioConfig): void {
	getConfigFn = getter;
}

// eff: initializes the config updater callback - ensures all changes go through single source of truth
export function setConfigUpdater(updater: (changes: Partial<AudioConfig>, options?: { showOSD?: boolean; unMute?: boolean }) => void): void {
	updateConfigFn = updater;
}

function getConfig(): AudioConfig {
	if (!getConfigFn) {
		// fallback: should never happen if properly initialized
		return { volume: 100, muted: false } as AudioConfig;
	}
	return getConfigFn();
}

// eff: calculates new volume/mute states and updates through Content Script's unified state
export function sendVolumeAction(action: HotkeyAction, params?: HotkeyParams): void {
	const step = params?.step ?? 10;
	const config = getConfig();
	let changes: Partial<AudioConfig> = {};

	switch (action) {
		case 'volume_up':
			// inv: cap volume at 800% to prevent extreme digital clipping
			changes = { volume: Math.min(800, (config.volume ?? 100) + step) };
			break;
		case 'volume_down':
			changes = { volume: Math.max(0, (config.volume ?? 100) - step) };
			break;
		case 'volume_mute':
			changes = { muted: !config.muted };
			break;
		case 'volume_set':
			if (params?.volume !== undefined) changes = { volume: params.volume };
			break;
	}

	// rule: use unified update path through Content Script, not direct to Background
	if (updateConfigFn) {
		updateConfigFn(changes, { showOSD: true });
	}
}

// eff: resets all domain-specific audio processing (EQ, gain, compression) to baseline values
export function sendAudioReset(): void {
	if (updateConfigFn) {
		updateConfigFn(
			{ volume: 100, muted: false, eqValues: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0], bass: false, compressor: false },
			{ showOSD: true }
		);
	}
}

export function sendCaptureToggle(): void {
	// note: capture toggle still needs Background coordination
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
