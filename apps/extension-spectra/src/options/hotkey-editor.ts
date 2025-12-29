// goal: manages the global hotkey configuration interface, including CRUD operations for key bindings and toggle master switch

import type { HotkeyBinding, SiteHotkeyConfig } from '@nexus/contracts';
import { DEFAULT_MODIFIERS, PRESET_BINDINGS } from '@nexus/contracts';
import { openModal, formatKeyCombo } from './modal';

const listContainer = document.getElementById('hotkeys-list')!;
const emptyState = document.getElementById('hotkeys-empty')!;
const enabledToggle = document.getElementById('hotkeys-enabled') as HTMLInputElement;
const addBtn = document.getElementById('hotkeys-add')!;
const resetBtn = document.getElementById('hotkeys-reset')!;

// note: using SiteHotkeyConfig structure for legacy global bindings list; this module is currently inactive in the main bundle
let settings: SiteHotkeyConfig = { enabled: true, bindings: [] };

// eff: initializes the hotkey editor by fetching saved settings and binding static UI controls
export async function initHotkeyEditor(): Promise<void> {
	await loadSettings();
	renderList();

	enabledToggle.addEventListener('change', handleToggleEnabled);
	addBtn.addEventListener('click', handleAdd);
	resetBtn.addEventListener('click', handleReset);
}

// eff: retrieves settings from chrome.storage, falling back to PRESET_BINDINGS if the user has no custom config
async function loadSettings(): Promise<void> {
	const result = await chrome.storage.local.get('hotkeySettings');
	if (result.hotkeySettings) {
		settings = result.hotkeySettings;
	} else {
		settings = { enabled: true, bindings: [...PRESET_BINDINGS] };
	}
	enabledToggle.checked = settings.enabled;
}

async function saveSettings(): Promise<void> {
	await chrome.storage.local.set({ hotkeySettings: settings });
	console.log('[SPECTRA] Hotkey settings saved');
}

// eff: reconstructs the DOM list of hotkey bindings based on the current in-memory settings
function renderList(): void {
	listContainer.innerHTML = '';

	if (settings.bindings.length === 0) {
		emptyState.classList.remove('hidden');
		return;
	}

	emptyState.classList.add('hidden');

	settings.bindings.forEach((binding, index) => {
		const item = createHotkeyItem(binding, index);
		listContainer.appendChild(item);
	});
}

// eff: generates a single hotkey entry element with attached event listeners for enabling, editing, or deletion
function createHotkeyItem(binding: HotkeyBinding, index: number): HTMLElement {
	const item = document.createElement('div');
	item.className = `hotkey-item${binding.enabled ? '' : ' disabled'}`;
	item.dataset.index = String(index);

	item.innerHTML = `
		<input type="checkbox" class="hotkey-enable" ${binding.enabled ? 'checked' : ''} />
		<div class="hotkey-key">${formatKeyCombo(binding.key)}</div>
		<div class="hotkey-action">${formatActionName(binding.action)}</div>
		<div class="hotkey-actions">
			<button class="edit" title="Edit">✏️</button>
			<button class="delete" title="Delete">🗑️</button>
		</div>
	`;

	const checkbox = item.querySelector('.hotkey-enable') as HTMLInputElement;
	checkbox.addEventListener('change', () => {
		binding.enabled = checkbox.checked;
		item.classList.toggle('disabled', !binding.enabled);
		saveSettings();
	});

	const editBtn = item.querySelector('.edit')!;
	editBtn.addEventListener('click', () => {
		openModal(binding, (updated) => {
			settings.bindings[index] = updated;
			saveSettings();
			renderList();
		});
	});

	const deleteBtn = item.querySelector('.delete')!;
	deleteBtn.addEventListener('click', () => {
		settings.bindings.splice(index, 1);
		saveSettings();
		renderList();
	});

	return item;
}

function handleToggleEnabled(): void {
	settings.enabled = enabledToggle.checked;
	saveSettings();
}

// eff: opens the creation modal with a fresh binding template and appends the result to the global settings
function handleAdd(): void {
	const newBinding: HotkeyBinding = {
		id: `custom-${Date.now()}`,
		enabled: true,
		key: { code: '', modifiers: { ...DEFAULT_MODIFIERS } },
		action: 'none',
	};

	openModal(newBinding, (updated) => {
		settings.bindings.push(updated);
		saveSettings();
		renderList();
	});
}

// post: overwrites all custom bindings with the hardcoded PRESET_BINDINGS after user confirmation
async function handleReset(): Promise<void> {
	if (!confirm('Reset all hotkeys to defaults?')) return;

	settings = { enabled: true, bindings: [...PRESET_BINDINGS] };
	await saveSettings();
	enabledToggle.checked = true;
	renderList();
}

function formatActionName(action: string): string {
	return action
		.replace(/_/g, ' ')
		.replace(/\b\w/g, c => c.toUpperCase());
}
