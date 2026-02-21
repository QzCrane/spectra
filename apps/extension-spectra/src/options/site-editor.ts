// goal: handles the per-site hotkey configuration interface, allowing domain-specific overrides for global shortcuts

import type { HotkeySettings, HotkeyBinding } from '@nexus/contracts';
import { DEFAULT_HOTKEY_SETTINGS, DEFAULT_MODIFIERS } from '@nexus/contracts';
import { openModal } from './modal';
import { safeStorageGet, safeStorageSet } from '../shared/safe-storage';

let settings: HotkeySettings = { ...DEFAULT_HOTKEY_SETTINGS };
let selectedSite: string | null = null;

// eff: initializes the site editor by loading saved configurations and populating the domain selector
export async function initSiteEditor(): Promise<void> {
	await loadSettings();
	renderSiteSelector();
	bindEvents();
}

async function loadSettings(): Promise<void> {
	try {
		const result = await safeStorageGet<{ hotkeySettings?: HotkeySettings }>(['hotkeySettings'], {});
		if (result.hotkeySettings) settings = { ...DEFAULT_HOTKEY_SETTINGS, ...result.hotkeySettings };
	} catch { }
}

async function saveSettings(): Promise<void> {
	await safeStorageSet({ hotkeySettings: settings });
}

// eff: updates the domain dropdown with all currently configured websites from the user's settings
function renderSiteSelector(): void {
	const select = document.getElementById('site-select') as HTMLSelectElement | null;
	if (!select) return;
	while (select.options.length > 1) select.remove(1);
	Object.keys(settings.sites).forEach(domain => {
		const opt = document.createElement('option');
		opt.value = domain;
		opt.textContent = domain;
		select.appendChild(opt);
	});
}

function bindEvents(): void {
	const select = document.getElementById('site-select') as HTMLSelectElement | null;
	select?.addEventListener('change', () => select.value ? selectSite(select.value) : hideSiteConfig());

	// note: new manual domain input handler
	const siteInput = document.getElementById('site-input') as HTMLInputElement | null;
	const addBtn = document.getElementById('site-add-btn');

	addBtn?.addEventListener('click', () => addSiteFromInput(siteInput?.value));
	siteInput?.addEventListener('keydown', (e) => {
		if (e.key === 'Enter') addSiteFromInput(siteInput.value);
	});

	const enabledCb = document.getElementById('site-enabled') as HTMLInputElement | null;
	enabledCb?.addEventListener('change', async () => {
		if (selectedSite && settings.sites[selectedSite]) {
			settings.sites[selectedSite]!.enabled = enabledCb.checked;
			await saveSettings();
		}
	});

	document.getElementById('site-delete')?.addEventListener('click', deleteSite);
	document.getElementById('site-add-binding')?.addEventListener('click', () => {
		if (!selectedSite) return;
		openModal(null, (binding) => {
			const site = settings.sites[selectedSite!];
			if (site) { site.bindings.push(binding); saveSettings(); renderBindings(); }
		});
	});
}

// eff: validates and adds a new site from manual domain input
async function addSiteFromInput(rawDomain: string | undefined): Promise<void> {
	if (!rawDomain) return;

	// note: normalize domain - strip protocol, path, whitespace
	let domain = rawDomain.trim().toLowerCase();
	domain = domain.replace(/^https?:\/\//, '').replace(/\/.*$/, '');

	if (!domain || domain.includes(' ')) {
		alert('Invalid domain format');
		return;
	}

	if (settings.sites[domain]) {
		alert('Site already exists');
		return;
	}

	settings.sites[domain] = { enabled: false, bindings: [] };
	await saveSettings();
	renderSiteSelector();

	// note: auto-select the newly added site
	const select = document.getElementById('site-select') as HTMLSelectElement | null;
	if (select) { select.value = domain; selectSite(domain); }

	// note: clear input field
	const input = document.getElementById('site-input') as HTMLInputElement | null;
	if (input) input.value = '';
}

// eff: displays the configuration sub-panel for the chosen domain and populates its current key bindings
function selectSite(domain: string): void {
	selectedSite = domain;
	const config = settings.sites[domain];
	if (!config) return;
	document.getElementById('site-config')?.classList.remove('hidden');
	document.getElementById('site-empty')?.classList.add('hidden');
	const domainEl = document.getElementById('site-domain');
	if (domainEl) domainEl.textContent = domain;
	const enabledCb = document.getElementById('site-enabled') as HTMLInputElement | null;
	if (enabledCb) enabledCb.checked = config.enabled;
	renderBindings();
}

function hideSiteConfig(): void {
	selectedSite = null;
	document.getElementById('site-config')?.classList.add('hidden');
	document.getElementById('site-empty')?.classList.remove('hidden');
}


async function deleteSite(): Promise<void> {
	if (!selectedSite || !confirm(`Delete configuration for ${selectedSite}?`)) return;
	delete settings.sites[selectedSite];
	await saveSettings();
	renderSiteSelector();
	hideSiteConfig();
}

// Note: renderBindings and createBindingRow handle the visual representation of individual hotkey assignments
function renderBindings(): void {
	const container = document.getElementById('site-bindings-list');
	if (!container || !selectedSite) return;
	const config = settings.sites[selectedSite];
	if (!config) return;
	container.innerHTML = '';
	config.bindings.forEach((binding, index) => {
		const row = createBindingRow(binding, index);
		container.appendChild(row);
	});
}

function createBindingRow(binding: HotkeyBinding, index: number): HTMLElement {
	const row = document.createElement('div');
	row.className = 'binding-row';

	const keyEl = document.createElement('span');
	keyEl.className = 'binding-key';
	keyEl.textContent = formatKeyCombo(binding.key);
	row.appendChild(keyEl);

	const actionEl = document.createElement('span');
	actionEl.className = 'binding-action';
	actionEl.textContent = binding.action.replace(/_/g, ' ');
	row.appendChild(actionEl);

	const editBtn = document.createElement('button');
	editBtn.className = 'btn btn-small';
	editBtn.textContent = '✏️';
	editBtn.addEventListener('click', () => {
		openModal(binding, (updated) => {
			const site = settings.sites[selectedSite!];
			if (site) { site.bindings[index] = updated; saveSettings(); renderBindings(); }
		});
	});
	row.appendChild(editBtn);

	const delBtn = document.createElement('button');
	delBtn.className = 'btn btn-small btn-danger';
	delBtn.textContent = '🗑️';
	delBtn.addEventListener('click', async () => {
		const site = settings.sites[selectedSite!];
		if (site) { site.bindings.splice(index, 1); await saveSettings(); renderBindings(); }
	});
	row.appendChild(delBtn);

	return row;
}

function formatKeyCombo(key: { code: string; modifiers: typeof DEFAULT_MODIFIERS }): string {
	const parts: string[] = [];
	if (key.modifiers.ctrl) parts.push('Ctrl');
	if (key.modifiers.alt) parts.push('Alt');
	if (key.modifiers.shift) parts.push('Shift');
	if (key.modifiers.meta) parts.push('Meta');
	parts.push(key.code.replace('Key', '').replace('Digit', ''));
	return parts.join('+');
}
