// goal: persistence logic for per-domain audio settings using 'siteSettings' key

import { AudioConfig, DEFAULT_AUDIO_CONFIG } from '../messages/protocol.js';

const KEY = 'siteSettings';
type SiteSettingsMap = Record<string, AudioConfig>;

// eff: retrieves config merged with defaults for the given domain
export async function getAudioConfig(domain: string): Promise<AudioConfig> {
	const result = await chrome.storage.local.get(KEY);
	const settings: SiteSettingsMap = result[KEY] || {};
	return settings[domain] ? { ...DEFAULT_AUDIO_CONFIG, ...settings[domain] } : { ...DEFAULT_AUDIO_CONFIG };
}

// eff: partially update or create domain settings merged with defaults
export async function setAudioConfig(domain: string, config: Partial<AudioConfig>): Promise<void> {
	const result = await chrome.storage.local.get(KEY);
	const settings: SiteSettingsMap = result[KEY] || {};
	settings[domain] = { ...DEFAULT_AUDIO_CONFIG, ...settings[domain], ...config };
	await chrome.storage.local.set({ [KEY]: settings });
}

export async function removeAudioConfig(domain: string): Promise<void> {
	const result = await chrome.storage.local.get(KEY);
	const settings: SiteSettingsMap = result[KEY] || {};
	delete settings[domain];
	await chrome.storage.local.set({ [KEY]: settings });
}
