// goal: handles global chrome keyboard shortcuts (manifest commands and custom slots)
// rule: standard commands are mapped directly; custom slots (slot_1-16) use user-defined mappings

import type { AudioConfig, HotkeySettings, HotkeyAction } from '@nexus/contracts';
import { Actions, DEFAULT_AUDIO_CONFIG, DEFAULT_HOTKEY_SETTINGS } from '@nexus/contracts';
import { storage } from './state';
import { swLog } from '../shared/logger';

// configCache: memory cache for domain-specific audio settings to prevent race conditions during rapid key presses
const configCache = new Map<string, AudioConfig>();
// slotMapping: active mapping of manifest slot IDs to functional hotkey actions
let slotMapping: Record<string, HotkeyAction> = { ...DEFAULT_HOTKEY_SETTINGS.slots };

// eff: retrieves audio configuration with memory-first caching
async function getConfigWithCache(domain: string): Promise<AudioConfig> {
	const cached = configCache.get(domain);
	if (cached) return cached;
	const stored = await storage.getAudioConfig(domain);
	configCache.set(domain, stored);
	return stored;
}

// eff: updates both memory cache and persistent storage for a domain
function setConfigWithCache(domain: string, config: AudioConfig): void {
	configCache.set(domain, config);
	storage.setAudioConfig(domain, config).catch(() => { });
}

// eff: synchronizes slotMapping from local storage
async function loadSlotMapping(): Promise<void> {
	try {
		const result = await chrome.storage.local.get('hotkeySettings');
		if (result.hotkeySettings?.slots) {
			slotMapping = result.hotkeySettings.slots;
		}
	} catch { }
}

// eff: initializes global listeners for chrome.commands and storage-based hotkey updates
export function setupShortcutListeners(): void {
	loadSlotMapping();

	chrome.storage.onChanged.addListener((changes) => {
		if (changes.hotkeySettings?.newValue?.slots) {
			slotMapping = changes.hotkeySettings.newValue.slots;
		}
	});

	chrome.commands.onCommand.addListener(async (command) => {
		swLog.debug(`Shortcut command: ${command}`);

		const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
		if (!tab?.id || !tab.url) return;

		let domain = '';
		try {
			domain = new URL(tab.url).hostname;
		} catch {
			return;
		}

		let action: HotkeyAction | undefined;
		if (command.startsWith('slot_')) {
			action = slotMapping[command];
			if (!action || action === 'none') return;
		} else {
			action = resolveDirectCommand(command);
		}

		if (!action) return;

		await executeAction(action, tab.id, domain);
	});
}

// goal: maps literal manifest command names to unified HotkeyActions
function resolveDirectCommand(command: string): HotkeyAction | undefined {
	const map: Record<string, HotkeyAction> = {
		volume_up: 'volume_up',
		volume_down: 'volume_down',
		toggle_mute: 'volume_mute',
		speed_up: 'speed_up',
	};
	return map[command];
}

// eff: resolves the hotkey action into either a background state update or a content script notification
async function executeAction(action: HotkeyAction, tabId: number, domain: string): Promise<void> {
	const oldConfig = await getConfigWithCache(domain);
	let newConfig: Partial<AudioConfig> = {};

	switch (action) {
		case 'volume_up':
			newConfig = { volume: Math.min(800, oldConfig.volume + 10) };
			break;
		case 'volume_down':
			newConfig = { volume: Math.max(0, oldConfig.volume - 10) };
			break;
		case 'volume_mute':
			newConfig = { muted: !oldConfig.muted };
			break;
		case 'speed_up':
		case 'speed_down':
		case 'speed_reset':
		case 'play_pause':
		case 'pip_toggle':
		case 'fullscreen_toggle':
			// rule: complex media/video operations are delegated to the content script handler
			try {
				await chrome.tabs.sendMessage(tabId, {
					action: Actions.SHORTCUT_TRIGGER,
					payload: { command: action }
				});
			} catch { }
			return;
		default:
			return;
	}

	const mergedConfig = { ...oldConfig, ...newConfig };
	setConfigWithCache(domain, mergedConfig);

	try {
		await chrome.tabs.sendMessage(tabId, {
			action: Actions.SHORTCUT_TRIGGER,
			payload: { command: action, config: mergedConfig }
		});
	} catch { }
}
