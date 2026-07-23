// goal: handles the per-site hotkey configuration interface, allowing domain-specific overrides for global shortcuts

import type { HotkeyBinding, HotkeySettings, HotkeySiteMutation } from '@nexus/contracts';
import { DEFAULT_HOTKEY_SETTINGS, DEFAULT_MODIFIERS, normalizeHostname } from '@nexus/contracts';
import { openModal } from './modal';
import { getSettingsSnapshot, patchSettings } from '../shared/settings-client';
import { getActionName, getCurrentLang, onLangChange, t, tf } from './i18n';

let settings: HotkeySettings = { ...DEFAULT_HOTKEY_SETTINGS };
let selectedSite: string | null = null;

// eff: initializes the site editor by loading saved configurations and populating the domain selector
export async function initSiteEditor(): Promise<void> {
	await loadSettings();
	renderLegacyWarning();
	renderSiteSelector();
	bindEvents();
	onLangChange(() => {
		renderLegacyWarning();
		renderBindings();
	});
}

function renderLegacyWarning(): void {
	const warning = document.getElementById('legacy-hotkeys-warning');
	if (!warning) return;
	const count = settings.disabledLegacyBindings?.length ?? 0;
	warning.hidden = count === 0;
	warning.textContent = count === 0
		? ''
		: count === 1 ? t('legacy_pitch_one') : tf('legacy_pitch_many', { count });
}

async function loadSettings(forceRefresh = false): Promise<void> {
	try {
		const snapshot = await getSettingsSnapshot(forceRefresh);
		settings = {
			...snapshot.hotkeySettings,
			slots: { ...snapshot.hotkeySettings.slots },
			sites: { ...snapshot.hotkeySettings.sites },
		};
	} catch { }
}

async function mutateSite(domain: string, mutation: HotkeySiteMutation): Promise<void> {
	const snapshot = await patchSettings({
		scope: 'hotkey-site-mutation',
		domain,
		mutation,
	});
	settings = snapshot.hotkeySettings;
}

async function recoverEditorState(): Promise<void> {
	await loadSettings(true);
	renderLegacyWarning();
	renderSiteSelector();
	if (selectedSite && settings.sites[selectedSite]) selectSite(selectedSite);
	else hideSiteConfig();
}

async function applyBindingMutation(domain: string, mutation: HotkeySiteMutation): Promise<void> {
	try {
		await mutateSite(domain, mutation);
		if (selectedSite === domain) {
			selectSite(domain);
			renderLegacyWarning();
		}
	} catch {
		await recoverEditorState();
	}
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
	if (selectedSite && settings.sites[selectedSite]) select.value = selectedSite;
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
		if (!selectedSite || !settings.sites[selectedSite]) return;
		const domain = selectedSite;
		try {
			await mutateSite(domain, { type: 'set-enabled', enabled: enabledCb.checked });
			if (selectedSite === domain) selectSite(domain);
		} catch {
			await recoverEditorState();
		}
	});

	document.getElementById('site-delete')?.addEventListener('click', deleteSite);
	document.getElementById('site-add-binding')?.addEventListener('click', () => {
		if (!selectedSite) return;
		const domain = selectedSite;
		openModal(null, (binding) => {
			void applyBindingMutation(domain, { type: 'upsert-binding', binding });
		});
	});
}

// eff: validates and adds a new site from manual domain input
async function addSiteFromInput(rawDomain: string | undefined): Promise<void> {
	if (!rawDomain) return;

	// note: normalize domain - strip protocol, path, whitespace
	const domain = normalizeHostname(rawDomain);

	if (!domain) {
		alert(t('invalid_domain'));
		return;
	}

	await loadSettings(true);
	if (settings.sites[domain]) {
		alert(t('site_exists'));
		return;
	}

	try {
		await mutateSite(domain, { type: 'ensure-site', enabled: false });
	} catch {
		await recoverEditorState();
		return;
	}
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
	setSiteConfigVisibility(true);
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
	setSiteConfigVisibility(false);
}

function setSiteConfigVisibility(visible: boolean): void {
	const config = document.getElementById('site-config');
	if (!config) return;
	config.hidden = !visible;
	config.setAttribute('aria-hidden', String(!visible));
	config.toggleAttribute('inert', !visible);
}


async function deleteSite(): Promise<void> {
	if (!selectedSite || !confirm(tf('delete_site_confirm', { domain: selectedSite }))) return;
	const deletedDomain = selectedSite;
	try {
		await mutateSite(deletedDomain, { type: 'delete-site' });
	} catch {
		await recoverEditorState();
		return;
	}
	renderSiteSelector();
	hideSiteConfig();
}

// Note: renderBindings and createBindingRow handle the visual representation of individual hotkey assignments
function renderBindings(): void {
	const container = document.getElementById('site-bindings-list');
	if (!container || !selectedSite) return;
	const config = settings.sites[selectedSite];
	if (!config) return;
	container.replaceChildren();
	const domain = selectedSite;
	config.bindings.forEach((binding) => {
		const row = createBindingRow(domain, binding);
		container.appendChild(row);
	});
}

function createBindingRow(domain: string, binding: HotkeyBinding): HTMLElement {
	const row = document.createElement('div');
	row.className = 'binding-row';

	const keyEl = document.createElement('span');
	keyEl.className = 'binding-key';
	keyEl.textContent = formatKeyCombo(binding.key);
	row.appendChild(keyEl);

	const actionEl = document.createElement('span');
	actionEl.className = 'binding-action';
	const actionName = getActionName(binding.action, getCurrentLang());
	actionEl.textContent = actionName;
	row.appendChild(actionEl);

	const editBtn = document.createElement('button');
	editBtn.className = 'btn btn-small';
	editBtn.textContent = '✏️';
	editBtn.type = 'button';
	editBtn.setAttribute('aria-label', tf('edit_hotkey_aria', { action: actionName }));
	editBtn.addEventListener('click', () => {
		openModal(binding, (updated) => {
			void applyBindingMutation(domain, { type: 'upsert-binding', binding: updated });
		});
	});
	row.appendChild(editBtn);

	const delBtn = document.createElement('button');
	delBtn.className = 'btn btn-small btn-danger';
	delBtn.textContent = '🗑️';
	delBtn.type = 'button';
	delBtn.setAttribute('aria-label', tf('delete_hotkey_aria', { action: actionName }));
	delBtn.addEventListener('click', async () => {
		await applyBindingMutation(domain, { type: 'remove-binding', bindingId: binding.id });
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
