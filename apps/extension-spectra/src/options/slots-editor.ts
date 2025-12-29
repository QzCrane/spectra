// goal: manages the mapping between Chrome command 'slots' (from manifest.json) and SPECTRA hotkey actions

import type { HotkeySettings, HotkeyAction } from '@nexus/contracts';
import { HOTKEY_ACTIONS, DEFAULT_HOTKEY_SETTINGS } from '@nexus/contracts';
import { t, getActionName, getCurrentLang, onLangChange } from './i18n';

// note: PRESET_COMMANDS must match the specific shortcut keys defined in the manifest; they cannot be renamed but their actions can be changed
const PRESET_COMMANDS = ['volume_up', 'volume_down', 'toggle_mute', 'speed_up'];
const SLOT_COMMANDS = Array.from({ length: 16 }, (_, i) => `slot_${String(i + 1).padStart(2, '0')}`);

let settings: HotkeySettings = { ...DEFAULT_HOTKEY_SETTINGS };

// eff: initializes the slots editor by loading persistence state and establishing an i18n re-render listener
export async function initSlotsEditor(): Promise<void> {
	await loadSettings();
	renderSlots();
	onLangChange(renderSlots);
}

async function loadSettings(): Promise<void> {
	try {
		const result = await chrome.storage.local.get('hotkeySettings');
		if (result.hotkeySettings) {
			settings = { ...DEFAULT_HOTKEY_SETTINGS, ...result.hotkeySettings };
		}
	} catch { /* ignore */ }
}

async function saveSettings(): Promise<void> {
	await chrome.storage.local.set({ hotkeySettings: settings });
}

// eff: generates the UI list for both preset and generic command slots, populating them with localized action names
function renderSlots(): void {
	const container = document.getElementById('slots-list');
	if (!container) return;

	container.innerHTML = '';

	PRESET_COMMANDS.forEach(cmd => {
		const action = settings.slots[cmd] ?? 'none';
		const row = createSlotRow(cmd, action, true);
		container.appendChild(row);
	});

	SLOT_COMMANDS.forEach(cmd => {
		const action = settings.slots[cmd] ?? 'none';
		const row = createSlotRow(cmd, action, false);
		container.appendChild(row);
	});
}

// eff: creates a single configuration row with a command label and an action selector
function createSlotRow(command: string, action: HotkeyAction, readonly: boolean): HTMLElement {
	const row = document.createElement('div');
	row.className = 'slot-row';

	const nameEl = document.createElement('span');
	nameEl.className = 'slot-name';
	nameEl.textContent = formatCommandName(command);
	row.appendChild(nameEl);

	const select = document.createElement('select');
	select.className = 'slot-action-select';
	select.disabled = readonly;

	const noneOpt = document.createElement('option');
	noneOpt.value = 'none';
	noneOpt.textContent = t('slot_unbound');
	select.appendChild(noneOpt);

	HOTKEY_ACTIONS.filter(a => a !== 'none').forEach(a => {
		const opt = document.createElement('option');
		opt.value = a;
		opt.textContent = formatActionName(a);
		if (a === action) opt.selected = true;
		select.appendChild(opt);
	});

	if (action !== 'none') {
		select.value = action;
	}

	select.addEventListener('change', async () => {
		settings.slots[command] = select.value as HotkeyAction;
		await saveSettings();
	});

	row.appendChild(select);

	return row;
}

function formatCommandName(cmd: string): string {
	if (cmd.startsWith('slot_')) {
		return `Slot ${parseInt(cmd.slice(5))}`;
	}
	return cmd.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function formatActionName(action: string): string {
	return getActionName(action, getCurrentLang());
}
