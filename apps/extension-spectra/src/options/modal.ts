// goal: manages the lifecycle and event logic for the hotkey editing modal

import type { HotkeyBinding, KeyCombo, HotkeyAction } from '@nexus/contracts';
import { DEFAULT_MODIFIERS } from '@nexus/contracts';
import { formatKeyCombo, formatParams, parseParams } from './formatters';

let currentBinding: HotkeyBinding | null = null;
let onSaveCallback: ((binding: HotkeyBinding) => void) | null = null;
let recordedKey: KeyCombo = { code: '', modifiers: { ...DEFAULT_MODIFIERS } };

const modal = document.getElementById('edit-modal')!;
const keyInput = document.getElementById('edit-key') as HTMLInputElement;
const actionSelect = document.getElementById('edit-action') as HTMLSelectElement;
const paramsContainer = document.getElementById('params-container')!;
const paramsInput = document.getElementById('edit-params') as HTMLInputElement;
const cancelBtn = document.getElementById('modal-cancel')!;
const saveBtn = document.getElementById('modal-save')!;
const closeBtn = modal.querySelector('.modal-close')!;
const backdrop = modal.querySelector('.modal-backdrop')!;

// eff: initializes the modal singleton and attaches static event listeners
export function initModal(): void {
	populateActionSelect();
	closeBtn.addEventListener('click', closeModal);
	backdrop.addEventListener('click', closeModal);
	cancelBtn.addEventListener('click', closeModal);
	saveBtn.addEventListener('click', handleSave);
	keyInput.addEventListener('keydown', handleKeyRecord);
	keyInput.addEventListener('focus', () => keyInput.placeholder = 'Press keys...');
	keyInput.addEventListener('blur', () => keyInput.placeholder = 'Click and press keys...');
	actionSelect.addEventListener('change', handleActionChange);
}

// eff: opens the configuration modal, initializing it with existing binding data or sensible defaults for new entries
export function openModal(binding: HotkeyBinding | null, onSave: (b: HotkeyBinding) => void): void {
	currentBinding = binding ? { ...binding } : {
		id: `binding_${Date.now()}`,
		enabled: true,
		key: { code: '', modifiers: { ...DEFAULT_MODIFIERS } },
		action: 'none' as HotkeyAction,
	};
	onSaveCallback = onSave;
	recordedKey = { ...currentBinding.key };
	keyInput.value = binding ? formatKeyCombo(binding.key) : '';
	actionSelect.value = currentBinding.action;
	handleActionChange();
	if (currentBinding.params) {
		paramsInput.value = formatParams(currentBinding.action, currentBinding.params);
	} else {
		paramsInput.value = '';
	}
	modal.classList.remove('hidden');
}

export function closeModal(): void {
	modal.classList.add('hidden');
	currentBinding = null;
	onSaveCallback = null;
}

// eff: captures raw keyboard events into a KeyCombo object while blocking default browser interventions
function handleKeyRecord(e: KeyboardEvent): void {
	e.preventDefault();
	e.stopPropagation();
	// rule: ignore standalone modifier presses to allow users to build combinations like Ctrl+Shift+K
	if (['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) return;
	recordedKey = {
		code: e.code,
		modifiers: { ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey, meta: e.metaKey }
	};
	keyInput.value = formatKeyCombo(recordedKey);
}

// eff: toggles the visibility of the parameters input field based on whether the selected action requires additional data (e.g. Speed set)
function handleActionChange(): void {
	const action = actionSelect.value as HotkeyAction;
	const needsParams = ['speed_set', 'volume_set', 'run_js', 'open_url'].includes(action);
	paramsContainer.classList.toggle('hidden', !needsParams);
	if (needsParams) {
		const label = document.getElementById('params-label')!;
		switch (action) {
			case 'speed_set': label.textContent = 'Speed (0.1-16)'; break;
			case 'volume_set': label.textContent = 'Volume (0-800)'; break;
			case 'run_js': label.textContent = 'JavaScript Code'; break;
			case 'open_url': label.textContent = 'URL'; break;
		}
	}
}

// post: validates the recorded key and executes the save callback with the final HotkeyBinding configuration
function handleSave(): void {
	if (!currentBinding || !onSaveCallback) return;
	if (!recordedKey.code) return;
	const action = actionSelect.value as HotkeyAction;
	currentBinding.key = { ...recordedKey };
	currentBinding.action = action;
	currentBinding.params = parseParams(action, paramsInput.value);
	onSaveCallback(currentBinding);
	closeModal();
}

function populateActionSelect(): void {
	const groups: Record<string, HotkeyAction[]> = {
		'Playback': ['play_pause', 'seek_forward_5s', 'seek_forward_10s', 'seek_forward_30s', 'seek_backward_5s', 'seek_backward_10s', 'seek_backward_30s', 'seek_frame_forward', 'seek_frame_backward'],
		'Speed': ['speed_up', 'speed_down', 'speed_reset', 'speed_set'],
		'Volume': ['volume_up', 'volume_down', 'volume_mute', 'volume_set'],
		'Audio': ['audio_reset', 'gain_up', 'gain_down', 'pitch_up', 'pitch_down', 'pitch_reset', 'delay_up', 'delay_down', 'delay_reset', 'pan_left', 'pan_right', 'pan_reset', 'mono_toggle', 'capture_toggle'],
		'Video': ['fullscreen_toggle', 'pip_toggle', 'rotate_cw', 'rotate_ccw', 'mirror_toggle', 'screenshot', 'dim_background'],
		'Markers': ['marker_add', 'marker_jump_prev', 'marker_jump_next', 'ab_set_a', 'ab_set_b', 'ab_clear', 'ab_skip', 'loop_toggle'],
		'FX': ['fx_toggle', 'fx_reset'],
		'Tab': ['tab_pin', 'tab_mute'],
		'Other': ['show_info', 'open_popup', 'open_options', 'run_js', 'open_url', 'none'],
	};
	for (const [groupName, actions] of Object.entries(groups)) {
		const optgroup = document.createElement('optgroup');
		optgroup.label = groupName;
		for (const action of actions) {
			const option = document.createElement('option');
			option.value = action;
			option.textContent = action.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
			optgroup.appendChild(option);
		}
		actionSelect.appendChild(optgroup);
	}
}

export { formatKeyCombo } from './formatters';
