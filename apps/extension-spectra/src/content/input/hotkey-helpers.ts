// goal: helper utilities for translating content-script hotkey interactions
import type { HotkeyAction, HotkeyParams, AudioConfig } from '@nexus/contracts';
import { Actions } from '@nexus/contracts';
import { listMarkers } from '../video/time-marker';
import { showToast } from '../ui/toast';

let getConfigFn: (() => AudioConfig) | null = null;
let updateConfigFn: ((changes: Partial<AudioConfig>, options?: { showOSD?: boolean; unMute?: boolean }) => void) | null = null;

export function setConfigGetter(getter: () => AudioConfig): void { getConfigFn = getter; }
export function setConfigUpdater(updater: (changes: Partial<AudioConfig>, options?: { showOSD?: boolean; unMute?: boolean }) => void): void { updateConfigFn = updater; }

function getConfig(): AudioConfig {
	return getConfigFn ? getConfigFn() : { volume: 100, muted: false } as AudioConfig;
}

export function sendVolumeAction(action: HotkeyAction, params?: HotkeyParams): void {
	const step = params?.step ?? 10;
	const c = getConfig();
	let ch: Partial<AudioConfig> = {};

	switch (action) {
		case 'volume_up': ch = { volume: Math.min(800, (c.volume ?? 100) + step) }; break;
		case 'volume_down': ch = { volume: Math.max(0, (c.volume ?? 100) - step) }; break;
		case 'volume_mute': ch = { muted: !c.muted }; break;
		case 'volume_set': if (params?.volume !== undefined) ch = { volume: params.volume }; break;
	}

	if (updateConfigFn) updateConfigFn(ch, { showOSD: true });
}

export function sendAudioReset(): void {
	updateConfigFn?.(
		{ volume: 100, muted: false, eqValues: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0], bass: false, compressor: false },
		{ showOSD: true }
	);
}

export function sendCaptureToggle(): void {
	chrome.runtime.sendMessage({ action: Actions.CAPTURE_TOGGLE });
}

export function jumpMarker(fwd: boolean): void {
	const m = listMarkers();
	if (!m.length) return;
	const v = document.getElementsByTagName('video')[0];
	if (!v) return;
	const t = v.currentTime;

	if (fwd) {
		const next = m.find(x => x && x.time > t + 0.5);
		if (next) { v.currentTime = next.time; showToast(`Jump to ${next.label}`); }
	} else {
		for (let i = m.length - 1; i >= 0; i--) {
			const mk = m[i];
			if (mk && mk.time < t - 0.5) { v.currentTime = mk.time; showToast(`Jump to ${mk.label}`); return; }
		}
	}
}

export function toggleLoop(): void {
	const v = document.getElementsByTagName('video')[0];
	if (v) {
		v.loop = !v.loop;
		showToast(v.loop ? 'Loop ON' : 'Loop OFF');
	}
}

export function sendTabAction(action: HotkeyAction): void {
	chrome.runtime.sendMessage({ action: action === 'tab_pin' ? 'TAB_PIN' : 'TAB_MUTE' });
}
