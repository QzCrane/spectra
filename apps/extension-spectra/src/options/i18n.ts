// goal: manages internationalization for the options page, including language persistence and dynamic text injection

import type { SupportedLanguage } from '@nexus/contracts';
import { getSettingsSnapshot, patchSettings } from '../shared/settings-client';
import { getActionName, getOptionsDictionary, loadLocaleCatalog } from '../shared/i18n/catalog';

let currentLang: SupportedLanguage = 'en-US';
const onLangChangeCallbacks: (() => void)[] = [];

export async function initI18n(): Promise<void> {
	try {
		currentLang = (await getSettingsSnapshot()).globalSettings.lang;
	} catch {
		currentLang = 'en-US';
	}
	await loadLocaleCatalog(currentLang);

	const select = document.getElementById('lang-select') as HTMLSelectElement | null;
	if (select) {
		select.value = currentLang;
		select.addEventListener('change', async () => {
			currentLang = select.value as SupportedLanguage;
			try {
				const snapshot = await patchSettings({ scope: 'global', changes: { lang: currentLang } });
				currentLang = snapshot.globalSettings.lang;
			} catch { }
			await loadLocaleCatalog(currentLang);
			applyI18n();
			onLangChangeCallbacks.forEach(cb => cb());
		});
	}

	applyI18n();
}

function applyI18n(): void {
	const dict = getOptionsDictionary(currentLang);
	document.documentElement.lang = currentLang;

	document.querySelectorAll('[data-i18n]').forEach(el => {
		const key = el.getAttribute('data-i18n');
		if (key && dict[key]) el.textContent = dict[key];
	});

	document.querySelectorAll<HTMLInputElement>('[data-i18n-placeholder]').forEach(el => {
		const key = el.getAttribute('data-i18n-placeholder');
		if (key && dict[key]) el.placeholder = dict[key];
	});
}

export function t(key: string): string {
	return getOptionsDictionary(currentLang)[key] ?? key;
}

export function tf(key: string, values: Readonly<Record<string, string | number>>): string {
	let message = t(key);
	for (const [name, value] of Object.entries(values)) {
		message = message.replaceAll(`{${name}}`, String(value));
	}
	return message;
}

export function getCurrentLang(): string { return currentLang; }

export function onLangChange(callback: () => void): void { onLangChangeCallbacks.push(callback); }

export { getActionName };
