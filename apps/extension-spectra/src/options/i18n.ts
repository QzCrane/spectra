// goal: manages internationalization for the options page, including language persistence and dynamic text injection

import { DICT } from './i18n-dict';
import { safeStorageGet, safeStorageSet } from '../shared/safe-storage';

let currentLang = 'en-US';
let onLangChangeCallbacks: (() => void)[] = [];

export async function initI18n(): Promise<void> {
	try {
		const result = await safeStorageGet<{ globalSettings?: { language?: string } }>(['globalSettings'], {});
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
				const result = await safeStorageGet<{ globalSettings?: { language?: string } }>(['globalSettings'], {});
				await safeStorageSet({
					globalSettings: { ...result.globalSettings, language: currentLang }
				});
			} catch { }
			applyI18n();
			onLangChangeCallbacks.forEach(cb => cb());
		});
	}

	applyI18n();
}

function applyI18n(): void {
	const dict = DICT[currentLang] ?? DICT['en-US'];
	if (!dict) return;

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
	const dict = DICT[currentLang] ?? DICT['en-US'];
	return dict?.[key] ?? key;
}

export function getCurrentLang(): string { return currentLang; }

export function onLangChange(callback: () => void): void { onLangChangeCallbacks.push(callback); }

export { getActionName } from './i18n-actions';
