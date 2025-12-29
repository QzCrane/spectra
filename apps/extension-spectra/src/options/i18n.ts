// goal: manages internationalization for the options page, including language persistence and dynamic text injection

import { DICT } from './i18n-dict';

let currentLang = 'en-US';
let onLangChangeCallbacks: (() => void)[] = [];

// eff: loads the preferred language from global settings, binds the selector, and performs the initial text injection
export async function initI18n(): Promise<void> {
	try {
		const result = await chrome.storage.local.get('globalSettings');
		currentLang = result.globalSettings?.language ?? 'en-US';
	} catch {
		currentLang = 'en-US';
	}

	const select = document.getElementById('lang-select') as HTMLSelectElement | null;
	if (select) {
		select.value = currentLang;
		select.addEventListener('change', async () => {
			currentLang = select.value;
			try {
				const result = await chrome.storage.local.get('globalSettings');
				await chrome.storage.local.set({
					globalSettings: { ...result.globalSettings, language: currentLang }
				});
			} catch { /* ignore */ }
			applyI18n();
			// note: notify dynamic modules (like the slots editor) to re-render in the new language
			onLangChangeCallbacks.forEach(cb => cb());
		});
	}

	applyI18n();
}

// eff: traverses the DOM for elements with 'data-i18n' attributes and injects the corresponding dictionary value
function applyI18n(): void {
	const dict = DICT[currentLang] ?? DICT['en-US'];
	if (!dict) return;

	// note: handle textContent translations
	document.querySelectorAll('[data-i18n]').forEach(el => {
		const key = el.getAttribute('data-i18n');
		if (key && dict[key]) {
			el.textContent = dict[key];
		}
	});

	// note: handle placeholder translations for input elements
	document.querySelectorAll<HTMLInputElement>('[data-i18n-placeholder]').forEach(el => {
		const key = el.getAttribute('data-i18n-placeholder');
		if (key && dict[key]) {
			el.placeholder = dict[key];
		}
	});
}

// post: returns the translated string for a given key, defaulting to the key itself if no match is found
export function t(key: string): string {
	const dict = DICT[currentLang] ?? DICT['en-US'];
	return dict?.[key] ?? key;
}

export function getCurrentLang(): string {
	return currentLang;
}

// eff: registers a callback to be executed whenever the user changes the active interface language
export function onLangChange(callback: () => void): void {
	onLangChangeCallbacks.push(callback);
}

export { getActionName } from './i18n-actions';
