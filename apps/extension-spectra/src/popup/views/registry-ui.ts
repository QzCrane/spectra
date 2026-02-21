// goal: manages the domain registry UI, allowing users to categorize domains as either 'restricted' (needs capture) or 'safe'

import type { DomainEntry } from '@nexus/contracts';
import { $ } from '../utils/dom';
import type { I18NDict } from '../types';
import { safeStorageSet } from '../../shared/safe-storage';

type TabType = 'restricted' | 'safe';

interface RegistryUIElements {
	tabRestricted: HTMLButtonElement | null;
	tabSafe: HTMLButtonElement | null;
	filterInput: HTMLInputElement | null;
	listContainer: HTMLElement | null;
	newDomainInput: HTMLInputElement | null;
	btnAdd: HTMLButtonElement | null;
}

let currentTab: TabType = 'restricted';
let allEntries: DomainEntry[] = [];
let filterText = '';
let currentDict: I18NDict | null = null;

function getUIElements(): RegistryUIElements {
	return {
		tabRestricted: $<HTMLButtonElement>('tab-restricted'),
		tabSafe: $<HTMLButtonElement>('tab-safe'),
		filterInput: $<HTMLInputElement>('registry-filter'),
		listContainer: $<HTMLElement>('registry-list'),
		newDomainInput: $<HTMLInputElement>('registry-new-domain'),
		btnAdd: $<HTMLButtonElement>('btn-add-domain'),
	};
}

// eff: filters registry entries based on the current search text and active category tab, then reconstructs the list DOM
function renderList(ui: RegistryUIElements): void {
	if (!ui.listContainer) return;

	const filtered = allEntries.filter(e => {
		// rule: 'restricted' domains must have the restricted property truthy; 'safe' domains must have it falsy
		const matchTab = currentTab === 'restricted' ? e.restricted !== false : e.restricted === false;
		const matchFilter = !filterText || e.domain.toLowerCase().includes(filterText.toLowerCase());
		return matchTab && matchFilter;
	});

	if (filtered.length === 0) {
		const emptyMsg = currentTab === 'restricted'
			? (currentDict?.registryEmptyRestricted ?? 'No sites need capture')
			: (currentDict?.registryEmptySafe ?? 'No safe sites');
		ui.listContainer.innerHTML = `<div class="registry-empty">${emptyMsg}</div>`;
		return;
	}

	ui.listContainer.innerHTML = filtered.map(e => `
		<div class="registry-item" data-domain="${e.domain}">
			<span class="registry-item-domain">${e.domain}</span>
			<span class="registry-item-source">${e.source === 'auto' ? 'AUTO' : 'USER'}</span>
			<button class="registry-item-delete" title="${currentDict?.tipDelete || 'Delete'}">×</button>
		</div>
	`).join('');

	ui.listContainer.querySelectorAll('.registry-item-delete').forEach(btn => {
		btn.addEventListener('click', (e) => {
			const item = (e.target as HTMLElement).closest('.registry-item') as HTMLElement;
			const domain = item?.dataset.domain;
			if (domain) deleteDomain(domain, ui);
		});
	});
}

function deleteDomain(domain: string, ui: RegistryUIElements): void {
	allEntries = allEntries.filter(e => e.domain !== domain);
	saveAndRender(ui);
}

// eff: normalizes the domain input and adds it to the in-memory registry with a specific category tag
function addDomain(domain: string, ui: RegistryUIElements): void {
	const cleaned = domain.trim().toLowerCase();
	if (!cleaned) return;

	if (allEntries.some(e => e.domain === cleaned)) return;

	allEntries.push({
		domain: cleaned,
		source: 'user',
		restricted: currentTab === 'restricted',
		probed: false,
		addedAt: Date.now(),
	});

	saveAndRender(ui);

	if (ui.newDomainInput) ui.newDomainInput.value = '';
}

// goal: persists the latest registry state to local storage and updates the visible list
function saveAndRender(ui: RegistryUIElements): void {
	safeStorageSet({ restrictedRegistry: allEntries });
	renderList(ui);
}

function switchTab(tab: TabType, ui: RegistryUIElements): void {
	currentTab = tab;

	if (ui.tabRestricted) ui.tabRestricted.classList.toggle('active', tab === 'restricted');
	if (ui.tabSafe) ui.tabSafe.classList.toggle('active', tab === 'safe');

	renderList(ui);
}

// goal: bootstraps listeners for search input, category switching, and new domain addition
export function initRegistryUI(entries: DomainEntry[]): void {
	allEntries = entries;
	const ui = getUIElements();

	renderList(ui);

	ui.tabRestricted?.addEventListener('click', () => switchTab('restricted', ui));
	ui.tabSafe?.addEventListener('click', () => switchTab('safe', ui));

	ui.filterInput?.addEventListener('input', (e) => {
		filterText = (e.target as HTMLInputElement).value;
		renderList(ui);
	});

	ui.btnAdd?.addEventListener('click', () => {
		if (ui.newDomainInput) addDomain(ui.newDomainInput.value, ui);
	});

	ui.newDomainInput?.addEventListener('keydown', (e) => {
		if (e.key === 'Enter' && ui.newDomainInput) {
			addDomain(ui.newDomainInput.value, ui);
		}
	});
}

// post: updates the localized UI dictionary and triggers a list rerender to update tooltips and empty states
export function updateRegistryI18n(dict: I18NDict): void {
	currentDict = dict;
	const ui = getUIElements();
	renderList(ui);
}
