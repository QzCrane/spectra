// goal: build deterministic, per-locale compressed catalogs outside runtime bundles

import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { HOTKEY_ACTIONS } from '../../../packages/contracts/src/hotkeys.contracts';
import { I18N } from '../src/popup/constants/i18n';
import type { I18NDict } from '../src/popup/types';
import { DICT } from '../src/options/i18n-dict';
import { getActionName } from '../src/options/i18n-actions';
import { SUPPORTED_SPECTRA_LANGUAGES, sourceLanguage } from '../src/shared/i18n/catalog';

const VALUE_MARKER = '__SPECTRA_I18N_VALUE__';

export interface EncodedLocaleCatalog {
	popup: Record<string, string>;
	options: Record<string, string>;
	actions: Record<string, string>;
}

export type EncodedLocaleSectionAsset = Record<string, string> | string[];

export interface EncodedLocaleAssetCatalog {
	popup: EncodedLocaleSectionAsset;
	options: EncodedLocaleSectionAsset;
	actions: EncodedLocaleSectionAsset;
}

function encodePopupDictionary(dictionary: I18NDict): Record<string, string> {
	const encoded: Record<string, string> = {};
	for (const [key, value] of Object.entries(dictionary)) {
		encoded[key] = typeof value === 'function' ? value(VALUE_MARKER) : value;
	}
	return encoded;
}

export function createLocaleCatalogs(): Record<string, EncodedLocaleCatalog> {
	const englishPopup = I18N['en-US'];
	const englishOptions = DICT['en-US'] ?? {};
	if (!englishPopup) throw new Error('English popup catalog is missing');

	const catalogs: Record<string, EncodedLocaleCatalog> = {};
	for (const language of SUPPORTED_SPECTRA_LANGUAGES) {
		const source = sourceLanguage(language);
		const popup = { ...englishPopup, ...(I18N[source] ?? {}) } as I18NDict;
		const options = { ...englishOptions, ...(DICT[source] ?? {}) };
		const actions = Object.fromEntries(
			HOTKEY_ACTIONS.map((action) => [action, getActionName(action, source)]),
		);
		catalogs[language] = { popup: encodePopupDictionary(popup), options, actions };
	}
	return catalogs;
}

// Production property mangling must preserve every key read from the generated
// gzip catalogs. Derive the boundary from the complete catalog instead of
// maintaining a second hand-written list that can drift when i18n grows.
export function collectLocaleCatalogPropertyNames(): Set<string> {
	const names = new Set<string>();
	for (const catalog of Object.values(createLocaleCatalogs())) {
		for (const [section, values] of Object.entries(catalog)) {
			names.add(section);
			for (const key of Object.keys(values)) names.add(key);
		}
	}
	return names;
}

// English is the on-disk fallback baseline. Other locale assets only need the
// values that differ from it; the runtime rehydrates the complete schema after
// validating both files. This avoids storing the same fallback strings nine times.
export function createLocaleAssetCatalogs(): Record<string, EncodedLocaleAssetCatalog> {
	const catalogs = createLocaleCatalogs();
	const english = catalogs['en-US'];
	if (!english) throw new Error('English locale catalog is missing');
	return Object.fromEntries(Object.entries(catalogs).map(([language, catalog]) => {
		if (language === 'en-US') return [language, catalog];
		const asset = Object.fromEntries(
			(Object.keys(catalog) as Array<keyof EncodedLocaleCatalog>).map((section) => [
				section,
				encodeLocaleSection(catalog[section], english[section]),
			]),
		) as EncodedLocaleAssetCatalog;
		return [language, asset];
	}));
}

function encodeLocaleSection(
	localized: Record<string, string>,
	english: Record<string, string>,
): EncodedLocaleSectionAsset {
	const keys = Object.keys(english);
	const changed = keys.flatMap((key, index) => (
		localized[key] !== english[key] ? [[index, localized[key]] as const] : []
	));
	// Dense arrays omit every repeated key. Sparse sections use English-key indexes
	// so partially translated locales do not pay for null placeholders.
	if (changed.length / keys.length > 0.7) return keys.map((key) => localized[key] ?? english[key] ?? '');
	return Object.fromEntries(changed.map(([index, value]) => [index, value ?? '']));
}

export function writeI18nAssets(distDir: string): void {
	const outputDir = resolve(distDir, 'i18n');
	mkdirSync(outputDir, { recursive: true });
	for (const [language, catalog] of Object.entries(createLocaleAssetCatalogs())) {
		const json = JSON.stringify(catalog);
		const compressed = gzipSync(json, { level: 9, mtime: 0 });
		writeFileSync(resolve(outputDir, `${language}.json.gz`), compressed);
	}
}

export { VALUE_MARKER };
