// goal: load only the active locale while keeping all dictionaries out of UI bundles

import type { SupportedLanguage } from '@nexus/contracts';
import type { I18NDict } from '../../popup/types';

export type OptionsI18nDict = Record<string, string>;

export interface SpectraLocaleSchema {
	popup: I18NDict;
	options: OptionsI18nDict;
	actions: Record<string, string>;
}

interface EncodedLocaleCatalog {
	popup: Record<string, string>;
	options: Record<string, string>;
	actions: Record<string, string>;
}

type EncodedLocaleSectionAsset = Record<string, string> | string[];

interface EncodedLocaleAssetCatalog {
	popup: EncodedLocaleSectionAsset;
	options: EncodedLocaleSectionAsset;
	actions: EncodedLocaleSectionAsset;
}

type RuntimeLocaleCatalog = SpectraLocaleSchema;

export const SUPPORTED_SPECTRA_LANGUAGES = [
	'en-US',
	'zh-CN',
	'zh-TW',
	'ja-JP',
	'ko-KR',
	'es-ES',
	'ru-RU',
	'de-DE',
	'fr-FR',
] as const satisfies readonly SupportedLanguage[];

const VALUE_MARKER = '__SPECTRA_I18N_VALUE__';
const FUNCTION_KEYS = [
	'autoAddedToast',
	'presetAppliedToast',
	'corsAddedSafe',
	'corsCorrectedSafe',
] as const satisfies ReadonlyArray<keyof I18NDict>;
const cache = new Map<SupportedLanguage, RuntimeLocaleCatalog>();
const assetCache = new Map<SupportedLanguage, EncodedLocaleAssetCatalog>();
let activeLanguage: SupportedLanguage | null = null;
let activeCatalog: RuntimeLocaleCatalog | null = null;

function normalizeLanguage(language: string): SupportedLanguage {
	return SUPPORTED_SPECTRA_LANGUAGES.includes(language as SupportedLanguage)
		? language as SupportedLanguage
		: 'en-US';
}

export function sourceLanguage(language: SupportedLanguage): SupportedLanguage {
	return language;
}

function isStringRecord(value: unknown): value is Record<string, string> {
	return typeof value === 'object'
		&& value !== null
		&& !Array.isArray(value)
		&& Object.values(value).every((item) => typeof item === 'string');
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function parseCatalog(value: unknown): EncodedLocaleAssetCatalog {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new Error('Locale catalog is not an object');
	}
	const record = value as Record<string, unknown>;
	if (Object.keys(record).length !== 3
		|| !Object.hasOwn(record, 'popup')
		|| !Object.hasOwn(record, 'options')
		|| !Object.hasOwn(record, 'actions')
		|| !(isStringRecord(record.popup) || isStringArray(record.popup))
		|| !(isStringRecord(record.options) || isStringArray(record.options))
		|| !(isStringRecord(record.actions) || isStringArray(record.actions))) {
		throw new Error('Locale catalog has an invalid schema');
	}
	return { popup: record.popup, options: record.options, actions: record.actions };
}

function requireEnglishCatalog(asset: EncodedLocaleAssetCatalog): EncodedLocaleCatalog {
	if (Array.isArray(asset.popup) || Array.isArray(asset.options) || Array.isArray(asset.actions)) {
		throw new Error('English locale catalog must contain named keys');
	}
	return asset as EncodedLocaleCatalog;
}

function decodeLocaleSection(
	asset: EncodedLocaleSectionAsset,
	english: Record<string, string>,
): Record<string, string> {
	const keys = Object.keys(english);
	if (Array.isArray(asset)) {
		if (asset.length !== keys.length) throw new Error('Locale catalog has an invalid dense section');
		return Object.fromEntries(keys.map((key, index) => [key, asset[index] ?? '']));
	}
	const decoded: Record<string, string> = {};
	for (const [rawIndex, value] of Object.entries(asset)) {
		if (!/^(?:0|[1-9]\d*)$/u.test(rawIndex)) {
			throw new Error('Locale catalog has a non-numeric delta key');
		}
		const key = keys[Number(rawIndex)];
		if (!key) throw new Error('Locale catalog delta index is out of range');
		decoded[key] = value;
	}
	return decoded;
}

function hydratePopup(encoded: Record<string, string>): I18NDict {
	const dictionary = { ...encoded } as unknown as I18NDict;
	for (const key of FUNCTION_KEYS) {
		const template = encoded[key];
		if (typeof template !== 'string') throw new Error(`Locale catalog is missing ${key}`);
		dictionary[key] = ((value: string) => template.replaceAll(VALUE_MARKER, value)) as never;
	}
	return dictionary;
}

async function fetchLocaleAsset(language: SupportedLanguage): Promise<EncodedLocaleAssetCatalog> {
	const cached = assetCache.get(language);
	if (cached) return cached;
	const response = await fetch(chrome.runtime.getURL(`i18n/${language}.json.gz`));
	if (!response.ok || !response.body) throw new Error(`Unable to load locale ${language}`);
	const decompressed = response.body.pipeThrough(new DecompressionStream('gzip'));
	const encoded = parseCatalog(JSON.parse(await new Response(decompressed).text()));
	assetCache.set(language, encoded);
	return encoded;
}

async function fetchCatalog(language: SupportedLanguage): Promise<RuntimeLocaleCatalog> {
	const cached = cache.get(language);
	if (cached) return cached;
	const english = requireEnglishCatalog(await fetchLocaleAsset('en-US'));
	const localized = language === 'en-US' ? english : await fetchLocaleAsset(language);
	const encoded = language === 'en-US' ? english : {
		popup: { ...english.popup, ...decodeLocaleSection(localized.popup, english.popup) },
		options: { ...english.options, ...decodeLocaleSection(localized.options, english.options) },
		actions: { ...english.actions, ...decodeLocaleSection(localized.actions, english.actions) },
	};
	const catalog = {
		popup: hydratePopup(encoded.popup),
		options: encoded.options,
		actions: encoded.actions,
	};
	cache.set(language, catalog);
	return catalog;
}

// post: switches atomically to a validated current-language catalog, with English fallback
export async function loadLocaleCatalog(language: string): Promise<void> {
	const normalized = normalizeLanguage(language);
	try {
		activeCatalog = await fetchCatalog(normalized);
		activeLanguage = normalized;
	} catch (error) {
		if (normalized === 'en-US') throw error;
		activeCatalog = await fetchCatalog('en-US');
		// Keep the requested language as the active lookup key. Callers continue
		// reading through that key while the validated English catalog supplies the
		// fallback values for this load attempt.
		activeLanguage = normalized;
	}
}

function requireCatalog(language: string): RuntimeLocaleCatalog {
	const normalized = normalizeLanguage(language);
	if (!activeCatalog || activeLanguage !== normalized) {
		throw new Error(`Locale ${normalized} must be loaded before use`);
	}
	return activeCatalog;
}

export function getPopupDictionary(language: string): I18NDict {
	return requireCatalog(language).popup;
}

export function getOptionsDictionary(language: string): OptionsI18nDict {
	return requireCatalog(language).options;
}

export function getActionName(action: string, language: string): string {
	return requireCatalog(language).actions[action] ?? action.replace(/_/g, ' ');
}
