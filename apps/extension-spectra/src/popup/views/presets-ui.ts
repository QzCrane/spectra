// goal: enhanced presets management with apply, search, global presets, default preset, and preview
// features: apply preset, global vs site-specific, search/filter, set as default, preview config

import type { AudioConfig } from '@nexus/kernel';
import { DEFAULT_AUDIO_CONFIG } from '@nexus/kernel';
import type { I18NDict } from '../types';
import { safeStorageGet, safeStorageSet, safeStorageRemove } from '../../shared/safe-storage';

// perf: preset types for global vs site-specific
export type PresetType = 'site' | 'global';

export interface PresetMeta {
	type: PresetType;
	name: string;
	createdAt: number;
	isDefault?: boolean;
}

export interface PresetEntry {
	config: Partial<AudioConfig>;
	meta: PresetMeta;
}

export type PresetsStorage = {
	siteSettings?: Record<string, Partial<AudioConfig>>;
	globalPresets?: Record<string, PresetEntry>;
	defaultPresetId?: string | null;
};

// perf: module-level state
let listEl: HTMLElement | null = null;
let emptyEl: HTMLElement | null = null;
let clearBtn: HTMLButtonElement | null = null;
let searchInput: HTMLInputElement | null = null;
let currentDict: I18NDict | null = null;
let currentDomain: string = '';
let onApplyPreset: ((config: Partial<AudioConfig>) => void) | null = null;

// eff: initializes the presets UI with search, filters, and action handlers
// note: domain and applyHandler are optional - when not provided, preset application is disabled
export function initPresetsUI(
	domain?: string,
	applyHandler?: (config: Partial<AudioConfig>) => void
): void {
	listEl = document.getElementById('presets-list');
	emptyEl = document.getElementById('presets-empty');
	clearBtn = document.getElementById('btn-clear-presets') as HTMLButtonElement | null;
	searchInput = document.getElementById('preset-search') as HTMLInputElement | null;

	currentDomain = domain || '';
	onApplyPreset = applyHandler || null;

	if (clearBtn) clearBtn.onclick = handleClearAll;
	if (searchInput) {
		searchInput.oninput = () => refreshPresetsList();
		searchInput.placeholder = currentDict?.presetSearchPlaceholder || 'Search presets...';
	}

	// eff: auto-refresh on storage changes
	chrome.storage.onChanged.addListener((changes, area) => {
		if (area === 'local' && (changes.siteSettings || changes.globalPresets)) {
			refreshPresetsList();
		}
	});

	refreshPresetsList();
}

// eff: refreshes the preset list with search filtering
async function refreshPresetsList(): Promise<void> {
	if (!listEl || !emptyEl) return;

	const { sitePresets, globalPresets, defaultId } = await loadAllPresets();
	const searchTerm = searchInput?.value.toLowerCase() || '';

	// perf: filter presets by search term
	const filteredSites = Object.entries(sitePresets).filter(([domain]) =>
		domain.toLowerCase().includes(searchTerm)
	);
	const filteredGlobals = Object.entries(globalPresets).filter(([name]) =>
		name.toLowerCase().includes(searchTerm)
	);

	const hasPresets = filteredSites.length > 0 || filteredGlobals.length > 0;

	listEl.innerHTML = '';

	if (!hasPresets) {
		listEl.style.display = 'none';
		emptyEl.style.display = 'block';
		if (clearBtn) clearBtn.style.display = 'none';
		return;
	}

	listEl.style.display = 'block';
	emptyEl.style.display = 'none';
	if (clearBtn) clearBtn.style.display = 'inline-block';

	// eff: render global presets section
	if (filteredGlobals.length > 0) {
		const globalHeader = createSectionHeader(currentDict?.presetGlobalSection || 'Global Presets');
		listEl.appendChild(globalHeader);

		filteredGlobals.forEach(([name, entry]) => {
			const item = createPresetItem(name, entry.config, 'global', entry.meta.isDefault);
			listEl!.appendChild(item);
		});
	}

	// eff: render site-specific presets section
	if (filteredSites.length > 0) {
		const siteHeader = createSectionHeader(currentDict?.presetSiteSection || 'Site Presets');
		listEl!.appendChild(siteHeader);

		filteredSites.forEach(([domain, config]) => {
			const isCurrentSite = domain === currentDomain;
			const item = createPresetItem(domain, config, 'site', false, isCurrentSite);
			listEl!.appendChild(item);
		});
	}
}

// post: creates a section header element
function createSectionHeader(text: string): HTMLElement {
	const header = document.createElement('div');
	header.className = 'preset-section-header';
	header.textContent = text;
	return header;
}

// post: creates a preset item with actions (apply, preview, set default, delete)
function createPresetItem(
	id: string,
	config: Partial<AudioConfig>,
	type: PresetType,
	isDefault: boolean = false,
	isCurrentSite: boolean = false
): HTMLElement {
	const item = document.createElement('div');
	item.className = `preset-item ${type} ${isCurrentSite ? 'current' : ''}`;

	// info: left side - name, badges, summary
	const infoEl = document.createElement('div');
	infoEl.className = 'preset-info';

	const nameEl = document.createElement('div');
	nameEl.className = 'preset-name';

	const nameText = document.createElement('span');
	nameText.textContent = id;
	nameEl.appendChild(nameText);

	if (isDefault) {
		const defaultBadge = document.createElement('span');
		defaultBadge.className = 'preset-badge default';
		defaultBadge.textContent = currentDict?.presetDefaultBadge || 'DEFAULT';
		nameEl.appendChild(defaultBadge);
	}

	if (isCurrentSite) {
		const currentBadge = document.createElement('span');
		currentBadge.className = 'preset-badge current';
		currentBadge.textContent = currentDict?.presetCurrentBadge || 'CURRENT';
		nameEl.appendChild(currentBadge);
	}

	const summaryEl = document.createElement('div');
	summaryEl.className = 'preset-summary';
	summaryEl.appendChild(createSummaryNodes(config));

	infoEl.appendChild(nameEl);
	infoEl.appendChild(summaryEl);

	// eff: right side - action buttons
	const actionsEl = document.createElement('div');
	actionsEl.className = 'preset-actions';

	// apply button
	const applyBtn = document.createElement('button');
	applyBtn.className = 'btn-preset-action apply';
	applyBtn.innerHTML = '✓';
	applyBtn.title = currentDict?.presetApplyTooltip || 'Apply';
	applyBtn.onclick = (e) => {
		e.stopPropagation();
		handleApplyPreset(id, type, config);
	};

	// preview button
	const previewBtn = document.createElement('button');
	previewBtn.className = 'btn-preset-action preview';
	previewBtn.innerHTML = '👁';
	previewBtn.title = currentDict?.presetPreviewTooltip || 'Preview';
	previewBtn.onclick = (e) => {
		e.stopPropagation();
		showPresetPreview(id, config);
	};

	// set default button (global presets only)
	const defaultBtn = document.createElement('button');
	defaultBtn.className = `btn-preset-action default ${isDefault ? 'active' : ''}`;
	defaultBtn.innerHTML = '★';
	defaultBtn.title = isDefault
		? (currentDict?.presetRemoveDefaultTooltip || 'Remove default')
		: (currentDict?.presetSetDefaultTooltip || 'Set as default');
	defaultBtn.onclick = (e) => {
		e.stopPropagation();
		handleSetDefaultPreset(id, type, !isDefault);
	};

	// delete button
	const deleteBtn = document.createElement('button');
	deleteBtn.className = 'btn-preset-action delete';
	deleteBtn.innerHTML = '✕';
	deleteBtn.title = currentDict?.presetDeleteTooltip || 'Delete';
	deleteBtn.onclick = (e) => {
		e.stopPropagation();
		handleDeletePreset(id, type);
	};

	actionsEl.appendChild(applyBtn);
	actionsEl.appendChild(previewBtn);
	if (type === 'global') actionsEl.appendChild(defaultBtn);
	actionsEl.appendChild(deleteBtn);

	item.appendChild(infoEl);
	item.appendChild(actionsEl);

	return item;
}

// post: creates summary nodes with highlighted volume and speed
function createSummaryNodes(config: Partial<AudioConfig>): DocumentFragment {
	const fragment = document.createDocumentFragment();

	// eff: add volume with highlight
	if (config.volume !== undefined) {
		const volSpan = document.createElement('span');
		volSpan.className = 'vol-highlight';
		volSpan.textContent = `${config.volume}%`;
		fragment.appendChild(volSpan);
	}

	// eff: add speed with highlight
	if (config.speed !== undefined && config.speed !== 1.0) {
		if (fragment.childNodes.length > 0) {
			fragment.appendChild(document.createTextNode(' | '));
		}
		const spdSpan = document.createElement('span');
		spdSpan.className = 'spd-highlight';
		spdSpan.textContent = `${config.speed}x`;
		fragment.appendChild(spdSpan);
	}

	// eff: add other effects
	const effects: string[] = [];
	if (config.compressor) effects.push('Comp');
	if (config.bass) effects.push('Bass');
	if (config.mono) effects.push('Mono');
	if (config.pan !== undefined && config.pan !== 0) effects.push(`Pan:${config.pan > 0 ? 'R' : 'L'}`);

	if (effects.length > 0) {
		if (fragment.childNodes.length > 0) {
			fragment.appendChild(document.createTextNode(' | '));
		}
		fragment.appendChild(document.createTextNode(effects.join(' | ')));
	}

	if (fragment.childNodes.length === 0) {
		fragment.appendChild(document.createTextNode('Default'));
	}

	return fragment;
}

// eff: applies preset config to current site
async function handleApplyPreset(id: string, type: PresetType, config: Partial<AudioConfig>): Promise<void> {
	if (onApplyPreset) {
		onApplyPreset(config);
	}

	// eff: if global preset applied, also save to current site
	if (type === 'global' && currentDomain) {
		const result = await safeStorageGet<PresetsStorage>(['siteSettings'], {});
		const settings = result.siteSettings || {};
		settings[currentDomain] = config;
		await safeStorageSet({ siteSettings: settings });
	}

	// feedback: visual confirmation
	showToast(currentDict?.presetAppliedToast?.(id) || `Applied: ${id}`);
}

// eff: shows preset details in a modal/preview panel
function showPresetPreview(id: string, config: Partial<AudioConfig>): void {
	const modal = document.createElement('div');
	modal.className = 'preset-preview-modal';

	const content = document.createElement('div');
	content.className = 'preset-preview-content';

	const header = document.createElement('h3');
	header.textContent = id;

	const details = document.createElement('pre');
	details.textContent = JSON.stringify(config, null, 2);

	const closeBtn = document.createElement('button');
	closeBtn.textContent = currentDict?.btnClose || 'Close';
	closeBtn.onclick = () => modal.remove();

	content.appendChild(header);
	content.appendChild(details);
	content.appendChild(closeBtn);
	modal.appendChild(content);

	modal.onclick = (e) => {
		if (e.target === modal) modal.remove();
	};

	document.body.appendChild(modal);
}

// eff: sets or removes a global preset as default
async function handleSetDefaultPreset(id: string, type: PresetType, setAsDefault: boolean): Promise<void> {
	if (type !== 'global') return;

	const result = await safeStorageGet<PresetsStorage>(['defaultPresetId'], {});
	await safeStorageSet({ defaultPresetId: setAsDefault ? id : null });

	refreshPresetsList();
}

// eff: deletes a preset
async function handleDeletePreset(id: string, type: PresetType): Promise<void> {
	if (type === 'site') {
		const result = await safeStorageGet<PresetsStorage>(['siteSettings'], {});
		const settings = result.siteSettings || {};
		delete settings[id];
		await safeStorageSet({ siteSettings: settings });
	} else {
		const result = await safeStorageGet<PresetsStorage>(['globalPresets'], {});
		const presets = result.globalPresets || {};
		delete presets[id];
		await safeStorageSet({ globalPresets: presets });

		// eff: if deleting default preset, clear default
		const defaultResult = await safeStorageGet<PresetsStorage>(['defaultPresetId'], {});
		if (defaultResult.defaultPresetId === id) {
			await safeStorageSet({ defaultPresetId: null });
		}
	}

	refreshPresetsList();
}

async function handleClearAll(): Promise<void> {
	await safeStorageRemove(['siteSettings', 'globalPresets', 'defaultPresetId']);
	refreshPresetsList();
}

// eff: loads all presets from storage
async function loadAllPresets(): Promise<{
	sitePresets: Record<string, Partial<AudioConfig>>;
	globalPresets: Record<string, PresetEntry>;
	defaultId: string | null;
}> {
	const result = await safeStorageGet<PresetsStorage>(
		['siteSettings', 'globalPresets', 'defaultPresetId'],
		{}
	);

	return {
		sitePresets: result.siteSettings || {},
		globalPresets: result.globalPresets || {},
		defaultId: result.defaultPresetId || null
	};
}

// eff: gets the default preset config for new sites
export async function getDefaultPreset(): Promise<Partial<AudioConfig> | null> {
	const { globalPresets, defaultId } = await loadAllPresets();
	if (!defaultId || !globalPresets[defaultId]) return null;
	return globalPresets[defaultId].config;
}

// eff: saves current config as a global preset
export async function saveGlobalPreset(name: string, config: Partial<AudioConfig>): Promise<void> {
	const result = await safeStorageGet<PresetsStorage>(['globalPresets'], {});
	const presets = result.globalPresets || {};

	presets[name] = {
		config,
		meta: {
			type: 'global',
			name,
			createdAt: Date.now()
		}
	};

	await safeStorageSet({ globalPresets: presets });
}

// goal: shows a transient toast notification
function showToast(message: string): void {
	const toast = document.createElement('div');
	toast.className = 'preset-toast';
	toast.textContent = message;
	document.body.appendChild(toast);

	setTimeout(() => {
		toast.classList.add('fade-out');
		setTimeout(() => toast.remove(), 300);
	}, 2000);
}

// goal: updates i18n dictionary
export function updatePresetsI18n(dict: I18NDict): void {
	currentDict = dict;
	if (searchInput) {
		searchInput.placeholder = dict.presetSearchPlaceholder || 'Search presets...';
	}
	refreshPresetsList();
}
