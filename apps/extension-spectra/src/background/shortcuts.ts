// goal: handles global chrome keyboard shortcuts (manifest commands and custom slots)
// rule: standard commands are mapped directly; custom slots (slot_1-16) use user-defined mappings

import type { HotkeySettings, HotkeyAction } from '@nexus/contracts';
import { Actions, DEFAULT_HOTKEY_SETTINGS } from '@nexus/contracts';
import { swLog } from '../shared/logger';
import { safeStorageGet } from '../shared/safe-storage';

// slotMapping: active mapping of manifest slot IDs to functional hotkey actions
let slotMapping: Record<string, HotkeyAction> = { ...DEFAULT_HOTKEY_SETTINGS.slots };


// eff: synchronizes slotMapping from local storage
async function loadSlotMapping(): Promise<void> {
	try {
		const result = await safeStorageGet<{ hotkeySettings?: HotkeySettings }>(['hotkeySettings'], {});
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

// eff: forwards the hotkey action to the content script for execution
// rule: content script handles all state updates using its real-time config, ensuring UI sync
async function executeAction(action: HotkeyAction, tabId: number, _domain: string): Promise<void> {
	try {
		await chrome.tabs.sendMessage(tabId, {
			action: Actions.SHORTCUT_TRIGGER,
			payload: { command: action }
		});
	} catch { }
}
