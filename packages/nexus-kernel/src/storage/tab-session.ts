// goal: manages tab-level session configs that persist across page refresh but not across tabs
// note: uses chrome.storage.session with tabId-prefixed keys

import { AudioConfig, DEFAULT_AUDIO_CONFIG } from '../messages/protocol.js';

const TAB_SESSION_PREFIX = 'tab_session_';

// eff: retrieves session config for a specific tab, returns null if no session exists
export async function getTabSessionConfig(tabId: number): Promise<AudioConfig | null> {
	const key = `${TAB_SESSION_PREFIX}${tabId}`;
	const result = await chrome.storage.session.get(key);
	return result[key] || null;
}

// eff: saves session config for a specific tab
export async function setTabSessionConfig(tabId: number, config: Partial<AudioConfig>): Promise<void> {
	const key = `${TAB_SESSION_PREFIX}${tabId}`;
	const result = await chrome.storage.session.get(key);
	const existing = result[key] || { ...DEFAULT_AUDIO_CONFIG };
	await chrome.storage.session.set({ [key]: { ...existing, ...config } });
}

// eff: removes session config when tab is closed
export async function removeTabSessionConfig(tabId: number): Promise<void> {
	const key = `${TAB_SESSION_PREFIX}${tabId}`;
	await chrome.storage.session.remove(key);
}

// eff: checks if a tab has an active session config
export async function hasTabSessionConfig(tabId: number): Promise<boolean> {
	const key = `${TAB_SESSION_PREFIX}${tabId}`;
	const result = await chrome.storage.session.get(key);
	return !!result[key];
}
