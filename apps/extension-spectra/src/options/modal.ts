// goal: manages the lifecycle and event logic for the hotkey editing modal

import type { HotkeyBinding, KeyCombo, HotkeyAction } from '@nexus/contracts';
import { DEFAULT_MODIFIERS, isSpectraDefaultHotkeyKeyCombo } from '@nexus/contracts';
import { formatKeyCombo, formatParams, parseParams } from './formatters';
import { EDITABLE_HOTKEY_GROUPS, isEditableHotkeyAction } from './supported-hotkey-actions';
import { getActionName, getCurrentLang, t } from './i18n';

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
const reservedHotkeyWarning = document.getElementById('reserved-hotkey-warning');
const legacyWarning = document.getElementById('legacy-action-warning');
let previouslyFocused: HTMLElement | null = null;

// eff: initializes the modal singleton and attaches static event listeners
export function initModal(): void {
	populateActionSelect();
	closeBtn.addEventListener('click', closeModal);
	backdrop.addEventListener('click', closeModal);
	cancelBtn.addEventListener('click', closeModal);
	saveBtn.addEventListener('click', handleSave);
	keyInput.addEventListener('keydown', handleKeyRecord);
	keyInput.addEventListener('focus', () => keyInput.placeholder = t('modal_key_focus'));
	keyInput.addEventListener('blur', () => keyInput.placeholder = t('modal_key_idle'));
	keyInput.placeholder = t('modal_key_idle');
	actionSelect.addEventListener('change', handleActionChange);
	document.addEventListener('keydown', handleModalKeydown);
	setModalVisibility(false);
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
	recordedKey = {
		...currentBinding.key,
		modifiers: { ...currentBinding.key.modifiers },
	};
	populateActionSelect();
	ensureLegacyActionOption(currentBinding.action);
	keyInput.value = binding ? formatKeyCombo(binding.key) : '';
	renderReservedHotkeyWarning();
	actionSelect.value = currentBinding.action;
	handleActionChange();
	if (currentBinding.params) {
		paramsInput.value = formatParams(currentBinding.action, currentBinding.params);
	} else {
		paramsInput.value = '';
	}
	previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
	setModalVisibility(true);
	requestAnimationFrame(() => keyInput.focus());
}

export function closeModal(): void {
	if (modal.hidden) return;
	const restoreFocus = previouslyFocused;
	setModalVisibility(false);
	currentBinding = null;
	onSaveCallback = null;
	previouslyFocused = null;
	restoreFocus?.focus();
}

function setModalVisibility(open: boolean): void {
	modal.hidden = !open;
	modal.classList.toggle('hidden', !open);
	modal.setAttribute('aria-hidden', String(!open));
	if (open) modal.removeAttribute('inert');
	else modal.setAttribute('inert', '');
}

function handleModalKeydown(event: KeyboardEvent): void {
	if (modal.hidden) return;
	if (event.key === 'Escape') {
		event.preventDefault();
		closeModal();
		return;
	}
	if (event.key !== 'Tab') return;

	const focusable = Array.from(modal.querySelectorAll<HTMLElement>(
		'button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
	)).filter(element => !element.hidden && element.getClientRects().length > 0);
	if (focusable.length === 0) return;
	const first = focusable[0]!;
	const last = focusable[focusable.length - 1]!;
	if (event.shiftKey && document.activeElement === first) {
		event.preventDefault();
		last.focus();
	} else if (!event.shiftKey && document.activeElement === last) {
		event.preventDefault();
		first.focus();
	}
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
	renderReservedHotkeyWarning();
	updateSaveAvailability();
}

// eff: toggles the visibility of the parameters input field based on whether the selected action requires additional data (e.g. Speed set)
function handleActionChange(): void {
	const action = actionSelect.value as HotkeyAction;
	const needsParams = ['speed_set', 'volume_set', 'run_js', 'open_url'].includes(action);
	paramsContainer.classList.toggle('hidden', !needsParams);
	paramsContainer.toggleAttribute('hidden', !needsParams);
	const editable = isEditableHotkeyAction(action);
	updateSaveAvailability();
	if (legacyWarning) {
		legacyWarning.hidden = editable;
		legacyWarning.textContent = editable
			? ''
			: t('modal_legacy_warning');
	}
	if (needsParams) {
		const label = document.getElementById('params-label')!;
		switch (action) {
			case 'speed_set': label.textContent = t('modal_param_speed'); break;
			case 'volume_set': label.textContent = t('modal_param_volume'); break;
			case 'run_js': label.textContent = t('modal_param_javascript'); break;
			case 'open_url': label.textContent = t('modal_param_url'); break;
		}
	}
}

// post: validates the recorded key and executes the save callback with the final HotkeyBinding configuration
function handleSave(): void {
	if (!currentBinding || !onSaveCallback) return;
	if (!recordedKey.code) return;
	if (renderReservedHotkeyWarning()) return;
	const action = actionSelect.value as HotkeyAction;
	if (!isEditableHotkeyAction(action)) return;
	const parsedParams = parseParams(action, paramsInput.value);
	if (['speed_set', 'volume_set', 'run_js', 'open_url'].includes(action) && !parsedParams) {
		paramsInput.setCustomValidity(t('modal_invalid_params'));
		paramsInput.reportValidity();
		return;
	}
	paramsInput.setCustomValidity('');
	currentBinding.key = { ...recordedKey };
	currentBinding.action = action;
	currentBinding.params = parsedParams;
	currentBinding.enabled = true;
	delete currentBinding.disabledReason;
	onSaveCallback(currentBinding);
	closeModal();
}

function renderReservedHotkeyWarning(): boolean {
	const reserved = Boolean(recordedKey.code)
		&& isSpectraDefaultHotkeyKeyCombo(recordedKey);
	keyInput.setAttribute('aria-invalid', String(reserved));
	if (reservedHotkeyWarning) {
		reservedHotkeyWarning.hidden = !reserved;
		reservedHotkeyWarning.textContent = reserved
			? t('modal_reserved_default_hotkey')
			: '';
	}
	return reserved;
}

function updateSaveAvailability(): void {
	const action = actionSelect.value as HotkeyAction;
	(saveBtn as HTMLButtonElement).disabled = !isEditableHotkeyAction(action)
		|| isSpectraDefaultHotkeyKeyCombo(recordedKey);
}

function populateActionSelect(): void {
	actionSelect.textContent = '';
	for (const [groupName, actions] of EDITABLE_HOTKEY_GROUPS) {
		const optgroup = document.createElement('optgroup');
		optgroup.label = t(groupName);
		for (const action of actions) {
			const option = document.createElement('option');
			option.value = action;
			option.textContent = getActionName(action, getCurrentLang());
			optgroup.appendChild(option);
		}
		actionSelect.appendChild(optgroup);
	}
}

function ensureLegacyActionOption(action: HotkeyAction): void {
	actionSelect.querySelector('[data-legacy-action]')?.remove();
	if (isEditableHotkeyAction(action)) return;

	const option = document.createElement('option');
	option.value = action;
	option.textContent = `${getActionName(action, getCurrentLang())} — ${t('modal_unavailable')}`;
	option.dataset.legacyAction = 'true';
	option.disabled = true;
	actionSelect.prepend(option);
}

export { formatKeyCombo } from './formatters';
