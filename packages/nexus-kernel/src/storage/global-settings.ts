// goal: persistence for global application settings using 'globalSettings' key

import { GlobalSettings, DEFAULT_GLOBAL_SETTINGS } from '../messages/protocol.js';

const KEY = 'globalSettings';

// eff: retrieves settings merged with defaults
export async function getGlobalSettings(): Promise<GlobalSettings> {
	const result = await chrome.storage.local.get(KEY);
	return result[KEY] ? { ...DEFAULT_GLOBAL_SETTINGS, ...result[KEY] } : { ...DEFAULT_GLOBAL_SETTINGS };
}

// eff: updates settings by merging with current values
export async function setGlobalSettings(settings: Partial<GlobalSettings>): Promise<void> {
	const current = await getGlobalSettings();
	await chrome.storage.local.set({ [KEY]: { ...current, ...settings } });
}
