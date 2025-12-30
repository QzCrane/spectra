// goal: persistence for hotkey configurations using 'hotkeySettings' key

import type { HotkeySettings } from '@nexus/contracts';
import { DEFAULT_HOTKEY_SETTINGS, DEFAULT_SLOTS } from '@nexus/contracts';

const KEY = 'hotkeySettings';

// eff: retrieves hotkey settings merged with defaults
export async function getHotkeySettings(): Promise<HotkeySettings> {
	const result = await chrome.storage.local.get(KEY);
	if (!result[KEY]) {
		return { ...DEFAULT_HOTKEY_SETTINGS };
	}
	return { ...DEFAULT_HOTKEY_SETTINGS, ...result[KEY] };
}

// eff: updates hotkey settings by merging with current values
export async function setHotkeySettings(settings: Partial<HotkeySettings>): Promise<void> {
	const current = await getHotkeySettings();
	await chrome.storage.local.set({ [KEY]: { ...current, ...settings } });
}

// eff: resets hotkey settings to factory defaults
export async function resetHotkeySettings(): Promise<void> {
	await chrome.storage.local.set({
		[KEY]: {
			slots: { ...DEFAULT_SLOTS },
			sites: {},
		}
	});
}
