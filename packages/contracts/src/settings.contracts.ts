// goal: defines contracts for persistent settings and the storage abstraction layer

import { normalizeHostname } from './domain.contracts.js';
import { isAudioConfigPatch, type AudioConfig } from './audio.contracts.js';
import {
	HOTKEY_ACTIONS,
	isHotkeyParamsForAction,
	isSpectraDefaultHotkeyKeyCombo,
	isSlotHotkeyAction,
	type HotkeyAction,
	type HotkeyBinding,
	type HotkeyConditions,
	type HotkeySettings,
	type KeyCombo,
	type KeyModifiers,
	type SiteHotkeyConfig,
} from './hotkeys.contracts.js';

export const SPECTRA_SETTINGS_SCHEMA_VERSION = 2 as const;

export type ThemeMode = 'light' | 'dark' | 'system';

export interface GlobalSettings {
  // osdEnabled: UI feedback overlay on volume/speed change
  osdEnabled: boolean;
  visualizerEnabled: boolean;
  lang: SupportedLanguage;
  themeMode: ThemeMode;
  // pauseRetentionSeconds: how long a paused tab stays in the UI list, 0=persistent
  pauseRetentionSeconds: number;
}

export type SupportedLanguage =
  | 'en-US'
  | 'zh-CN'
  | 'zh-TW'
  | 'ja-JP'
  | 'ko-KR'
  | 'es-ES'
  | 'ru-RU'
  | 'de-DE'
  | 'fr-FR';

export const DEFAULT_GLOBAL_SETTINGS: Readonly<GlobalSettings> = {
  osdEnabled: true,
  visualizerEnabled: true,
  lang: 'en-US',
  themeMode: 'system',
  pauseRetentionSeconds: 60
} as const;

export interface SettingsSnapshot {
	schemaVersion: typeof SPECTRA_SETTINGS_SCHEMA_VERSION;
	revision: number;
	globalSettings: GlobalSettings;
	hotkeySettings: HotkeySettings;
	audioSites: Record<string, Partial<AudioConfig>>;
	audioPresets: Record<string, AudioPresetValue>;
	defaultPresetId: string | null;
}

export interface AudioPresetMeta {
	type: 'global';
	name: string;
	createdAt: number;
	isDefault?: boolean;
}

export interface AudioPresetValue {
	config: Partial<AudioConfig>;
	meta: AudioPresetMeta;
}

export type HotkeySiteMutation =
	| { type: 'ensure-site'; enabled: boolean }
	| { type: 'delete-site' }
	| { type: 'set-enabled'; enabled: boolean }
	| { type: 'upsert-binding'; binding: HotkeyBinding }
	| { type: 'remove-binding'; bindingId: string };

export type SettingsPatch =
	| { scope: 'global'; changes: Partial<GlobalSettings> }
	| { scope: 'legacy-theme'; candidate: ThemeMode | null }
	| { scope: 'hotkey-slots'; changes: Record<string, HotkeyAction | null> }
	// note: retained for the one-release compatibility adapter; new editors use atomic mutations below.
	| { scope: 'hotkey-site'; domain: string; value: SiteHotkeyConfig | null }
	| { scope: 'hotkey-site-mutation'; domain: string; mutation: HotkeySiteMutation }
	| {
		scope: 'audio-site';
		domain: string;
		value: Partial<AudioConfig> | null;
		mode?: 'merge' | 'replace';
	}
	| { scope: 'audio-preset'; name: string; value: AudioPresetValue | null }
	| { scope: 'default-preset'; value: string | null };

export interface SettingsPatchRequest {
	expectedRevision: number;
	patch: SettingsPatch;
}

// note: one-release adapter contract. The background owns the eligibility bit;
// extension pages may only offer the legacy localStorage value as a candidate.
const SUPPORTED_LANGUAGE_SET = new Set<SupportedLanguage>([
	'en-US',
	'zh-CN',
	'zh-TW',
	'ja-JP',
	'ko-KR',
	'es-ES',
	'ru-RU',
	'de-DE',
	'fr-FR',
]);
const THEME_MODE_SET = new Set<ThemeMode>(['light', 'dark', 'system']);
const HOTKEY_ACTION_SET = new Set<string>(HOTKEY_ACTIONS);
const GLOBAL_SETTINGS_KEYS = new Set<keyof GlobalSettings>([
	'osdEnabled',
	'visualizerEnabled',
	'lang',
	'themeMode',
	'pauseRetentionSeconds',
]);
const SETTINGS_SNAPSHOT_KEYS = new Set<keyof SettingsSnapshot>([
	'schemaVersion',
	'revision',
	'globalSettings',
	'hotkeySettings',
	'audioSites',
	'audioPresets',
	'defaultPresetId',
]);
const HOTKEY_SETTINGS_KEYS = new Set<keyof HotkeySettings>([
	'slots',
	'sites',
	'disabledLegacyBindings',
]);
const SITE_HOTKEY_KEYS = new Set<keyof SiteHotkeyConfig>(['enabled', 'bindings']);
const HOTKEY_BINDING_KEYS = new Set<keyof HotkeyBinding>([
	'id',
	'enabled',
	'key',
	'action',
	'params',
	'conditions',
	'disabledReason',
]);
const KEY_COMBO_KEYS = new Set<keyof KeyCombo>(['code', 'modifiers']);
const KEY_MODIFIER_KEYS = new Set<keyof KeyModifiers>(['ctrl', 'alt', 'shift', 'meta']);
const HOTKEY_CONDITION_KEYS = new Set<keyof HotkeyConditions>(['domains', 'requireMedia']);
const SETTINGS_PATCH_REQUEST_KEYS = new Set<keyof SettingsPatchRequest>(['expectedRevision', 'patch']);
const LEGACY_THEME_PATCH_KEYS = new Set(['scope', 'candidate']);
const GLOBAL_PATCH_KEYS = new Set(['scope', 'changes']);
const HOTKEY_SLOTS_PATCH_KEYS = new Set(['scope', 'changes']);
const HOTKEY_SITE_PATCH_KEYS = new Set(['scope', 'domain', 'value']);
const HOTKEY_SITE_MUTATION_PATCH_KEYS = new Set(['scope', 'domain', 'mutation']);
const HOTKEY_SITE_ENSURE_MUTATION_KEYS = new Set(['type', 'enabled']);
const HOTKEY_SITE_DELETE_MUTATION_KEYS = new Set(['type']);
const HOTKEY_SITE_ENABLED_MUTATION_KEYS = new Set(['type', 'enabled']);
const HOTKEY_SITE_UPSERT_MUTATION_KEYS = new Set(['type', 'binding']);
const HOTKEY_SITE_REMOVE_MUTATION_KEYS = new Set(['type', 'bindingId']);
const AUDIO_SITE_PATCH_KEYS = new Set(['scope', 'domain', 'value', 'mode']);
const AUDIO_PRESET_PATCH_KEYS = new Set(['scope', 'name', 'value']);
const DEFAULT_PRESET_PATCH_KEYS = new Set(['scope', 'value']);
const AUDIO_PRESET_VALUE_KEYS = new Set<keyof AudioPresetValue>(['config', 'meta']);
const AUDIO_PRESET_META_KEYS = new Set<keyof AudioPresetMeta>(['type', 'name', 'createdAt', 'isDefault']);
const MAX_PAUSE_RETENTION_SECONDS = 86_400;
const MAX_HOTKEY_BINDINGS = 1000;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
	return Object.keys(value).every((key) => allowed.has(key));
}

function isNonNegativeInteger(value: unknown): value is number {
	return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function isPresetName(value: unknown): value is string {
	return typeof value === 'string'
		&& value.trim().length > 0
		&& value.length <= 128
		&& [...value].every((character) => {
			const codePoint = character.codePointAt(0) ?? 0;
			return codePoint > 31 && codePoint !== 127;
		})
		&& value !== '__proto__'
		&& value !== 'constructor'
		&& value !== 'prototype';
}

function isAudioPresetValue(value: unknown, name: string): value is AudioPresetValue {
	if (!isRecord(value) || !hasOnlyKeys(value, AUDIO_PRESET_VALUE_KEYS) || !isAudioConfigPatch(value.config)) {
		return false;
	}
	const meta = value.meta;
	if (!isRecord(meta) || !hasOnlyKeys(meta, AUDIO_PRESET_META_KEYS)) return false;
	return meta.type === 'global'
		&& meta.name === name
		&& isPresetName(meta.name)
		&& typeof meta.createdAt === 'number'
		&& Number.isSafeInteger(meta.createdAt)
		&& meta.createdAt >= 0
		&& (meta.isDefault === undefined || typeof meta.isDefault === 'boolean');
}

function isAudioSites(value: unknown): value is Record<string, Partial<AudioConfig>> {
	if (!isRecord(value) || Object.keys(value).length > 10_000) return false;
	return Object.entries(value).every(([domain, config]) => (
		normalizeHostname(domain) === domain && isAudioConfigPatch(config)
	));
}

function isAudioPresets(value: unknown): value is Record<string, AudioPresetValue> {
	if (!isRecord(value) || Object.keys(value).length > 10_000) return false;
	return Object.entries(value).every(([name, preset]) => (
		isPresetName(name) && isAudioPresetValue(preset, name)
	));
}

function isKeyModifiers(value: unknown): value is KeyModifiers {
	if (!isRecord(value) || !hasOnlyKeys(value, KEY_MODIFIER_KEYS)) return false;
	return typeof value.ctrl === 'boolean'
		&& typeof value.alt === 'boolean'
		&& typeof value.shift === 'boolean'
		&& typeof value.meta === 'boolean';
}

function isKeyCombo(value: unknown): value is KeyCombo {
	if (!isRecord(value) || !hasOnlyKeys(value, KEY_COMBO_KEYS)) return false;
	return typeof value.code === 'string'
		&& value.code.length > 0
		&& value.code.length <= 64
		&& isKeyModifiers(value.modifiers);
}

function isHotkeyConditions(value: unknown): value is HotkeyConditions {
	if (!isRecord(value) || !hasOnlyKeys(value, HOTKEY_CONDITION_KEYS)) return false;
	if (value.requireMedia !== undefined && typeof value.requireMedia !== 'boolean') return false;
	return value.domains === undefined
		|| (Array.isArray(value.domains)
			&& value.domains.length <= 100
			&& value.domains.every((domain) => typeof domain === 'string' && normalizeHostname(domain) !== null));
}

function isHotkeyBindingShape(value: unknown): value is HotkeyBinding {
	if (!isRecord(value) || !hasOnlyKeys(value, HOTKEY_BINDING_KEYS)) return false;
	if (typeof value.id !== 'string' || value.id.length === 0 || value.id.length > 128) return false;
	if (typeof value.enabled !== 'boolean' || typeof value.action !== 'string' || !HOTKEY_ACTION_SET.has(value.action)) return false;
	if (!isKeyCombo(value.key)) return false;
	const action = value.action as HotkeyAction;
	if (!isHotkeyParamsForAction(action, value.params)) return false;
	if (value.conditions !== undefined && !isHotkeyConditions(value.conditions)) return false;
	return value.disabledReason === undefined
		|| value.disabledReason === 'unsupported_action'
		|| value.disabledReason === 'reserved_default_chord';
}

// Persisted snapshots may retain an old site binding on a built-in chord only
// as explicit disabled migration evidence. A reserved reason on any other
// chord is stale and therefore not a valid projection.
function isHotkeyBinding(value: unknown): value is HotkeyBinding {
	if (!isHotkeyBindingShape(value)) return false;
	if (isSpectraDefaultHotkeyKeyCombo(value.key)) {
		return !value.enabled && value.disabledReason === 'reserved_default_chord';
	}
	return value.disabledReason !== 'reserved_default_chord';
}

function isUpsertHotkeyBinding(value: unknown): value is HotkeyBinding {
	return isHotkeyBindingShape(value)
		&& !isSpectraDefaultHotkeyKeyCombo(value.key)
		&& value.disabledReason !== 'reserved_default_chord';
}

function isHotkeyBindingId(value: unknown): value is string {
	return typeof value === 'string' && value.length > 0 && value.length <= 128;
}

function isHotkeySiteMutation(value: unknown): value is HotkeySiteMutation {
	if (!isRecord(value)) return false;
	if (value.type === 'ensure-site') {
		return hasOnlyKeys(value, HOTKEY_SITE_ENSURE_MUTATION_KEYS)
			&& typeof value.enabled === 'boolean';
	}
	if (value.type === 'delete-site') {
		return hasOnlyKeys(value, HOTKEY_SITE_DELETE_MUTATION_KEYS);
	}
	if (value.type === 'set-enabled') {
		return hasOnlyKeys(value, HOTKEY_SITE_ENABLED_MUTATION_KEYS)
			&& typeof value.enabled === 'boolean';
	}
	if (value.type === 'upsert-binding') {
		return hasOnlyKeys(value, HOTKEY_SITE_UPSERT_MUTATION_KEYS)
			&& isUpsertHotkeyBinding(value.binding);
	}
	if (value.type === 'remove-binding') {
		return hasOnlyKeys(value, HOTKEY_SITE_REMOVE_MUTATION_KEYS)
			&& isHotkeyBindingId(value.bindingId);
	}
	return false;
}

function isSiteHotkeyConfig(value: unknown): value is SiteHotkeyConfig {
	if (!isRecord(value) || !hasOnlyKeys(value, SITE_HOTKEY_KEYS)) return false;
	return typeof value.enabled === 'boolean'
		&& Array.isArray(value.bindings)
		&& value.bindings.length <= MAX_HOTKEY_BINDINGS
		&& value.bindings.every(isHotkeyBinding);
}

export function isHotkeySettings(value: unknown): value is HotkeySettings {
	if (!isRecord(value) || !hasOnlyKeys(value, HOTKEY_SETTINGS_KEYS)) return false;
	if (!isRecord(value.slots) || Object.keys(value.slots).length > 128) return false;
	if (!Object.entries(value.slots).every(([slot, action]) => (
		slot.length > 0
		&& slot.length <= 128
		&& isSlotHotkeyAction(action)
	))) return false;
	if (!isRecord(value.sites) || Object.keys(value.sites).length > 1000) return false;
	if (!Object.entries(value.sites).every(([domain, site]) => (
		normalizeHostname(domain) === domain && isSiteHotkeyConfig(site)
	))) return false;
	return value.disabledLegacyBindings === undefined
		|| (Array.isArray(value.disabledLegacyBindings)
			&& value.disabledLegacyBindings.length <= MAX_HOTKEY_BINDINGS
			&& value.disabledLegacyBindings.every(isHotkeyBinding));
}

export function isGlobalSettings(value: unknown): value is GlobalSettings {
	if (!isRecord(value) || !hasOnlyKeys(value, GLOBAL_SETTINGS_KEYS)) return false;
	return typeof value.osdEnabled === 'boolean'
		&& typeof value.visualizerEnabled === 'boolean'
		&& typeof value.lang === 'string'
		&& SUPPORTED_LANGUAGE_SET.has(value.lang as SupportedLanguage)
		&& typeof value.themeMode === 'string'
		&& THEME_MODE_SET.has(value.themeMode as ThemeMode)
		&& isNonNegativeInteger(value.pauseRetentionSeconds)
		&& value.pauseRetentionSeconds <= MAX_PAUSE_RETENTION_SECONDS;
}

// post: validates the full revisioned snapshot returned by the background repository
export function isSettingsSnapshot(value: unknown): value is SettingsSnapshot {
	if (!isRecord(value) || !hasOnlyKeys(value, SETTINGS_SNAPSHOT_KEYS)) return false;
	return value.schemaVersion === SPECTRA_SETTINGS_SCHEMA_VERSION
		&& isNonNegativeInteger(value.revision)
		&& isGlobalSettings(value.globalSettings)
		&& isHotkeySettings(value.hotkeySettings)
		&& isAudioSites(value.audioSites)
		&& isAudioPresets(value.audioPresets)
		&& (value.defaultPresetId === null || (
			typeof value.defaultPresetId === 'string'
			&& Object.hasOwn(value.audioPresets, value.defaultPresetId)
		));
}

// post: rejects malformed or over-broad field patches before repository mutation
export function isSettingsPatchRequest(value: unknown): value is SettingsPatchRequest {
	if (!isRecord(value)
		|| !hasOnlyKeys(value, SETTINGS_PATCH_REQUEST_KEYS)
		|| !isNonNegativeInteger(value.expectedRevision)
		|| !isRecord(value.patch)) return false;
	const patch = value.patch;
	if (patch.scope === 'legacy-theme') {
		return hasOnlyKeys(patch, LEGACY_THEME_PATCH_KEYS)
			&& (patch.candidate === null || (
				typeof patch.candidate === 'string'
				&& THEME_MODE_SET.has(patch.candidate as ThemeMode)
			));
	}
	if (patch.scope === 'global') {
		if (!hasOnlyKeys(patch, GLOBAL_PATCH_KEYS) || !isRecord(patch.changes)) return false;
		return hasOnlyKeys(patch.changes, GLOBAL_SETTINGS_KEYS)
			&& Object.entries(patch.changes).every(([key, item]) => {
				if (key === 'osdEnabled' || key === 'visualizerEnabled') return typeof item === 'boolean';
				if (key === 'pauseRetentionSeconds') {
					return isNonNegativeInteger(item) && item <= MAX_PAUSE_RETENTION_SECONDS;
				}
				if (key === 'lang') return typeof item === 'string' && SUPPORTED_LANGUAGE_SET.has(item as SupportedLanguage);
				return typeof item === 'string' && THEME_MODE_SET.has(item as ThemeMode);
			});
	}
	if (patch.scope === 'hotkey-slots') {
		if (!hasOnlyKeys(patch, HOTKEY_SLOTS_PATCH_KEYS) || !isRecord(patch.changes)) return false;
		return Object.keys(patch.changes).length <= 128
			&& Object.entries(patch.changes).every(([slot, action]) => (
				slot.length > 0
				&& slot.length <= 128
				&& (action === null || isSlotHotkeyAction(action))
			));
	}
	if (patch.scope === 'hotkey-site') {
		return hasOnlyKeys(patch, HOTKEY_SITE_PATCH_KEYS)
			&& typeof patch.domain === 'string'
			&& normalizeHostname(patch.domain) !== null
			&& (patch.value === null || isSiteHotkeyConfig(patch.value));
	}
	if (patch.scope === 'hotkey-site-mutation') {
		return hasOnlyKeys(patch, HOTKEY_SITE_MUTATION_PATCH_KEYS)
			&& typeof patch.domain === 'string'
			&& normalizeHostname(patch.domain) !== null
			&& isHotkeySiteMutation(patch.mutation);
	}
	if (patch.scope === 'audio-site') {
		return hasOnlyKeys(patch, AUDIO_SITE_PATCH_KEYS)
			&& typeof patch.domain === 'string'
			&& normalizeHostname(patch.domain) !== null
			&& (patch.mode === undefined || patch.mode === 'merge' || patch.mode === 'replace')
			&& (patch.value === null || isAudioConfigPatch(patch.value));
	}
	if (patch.scope === 'audio-preset') {
		return hasOnlyKeys(patch, AUDIO_PRESET_PATCH_KEYS)
			&& isPresetName(patch.name)
			&& (patch.value === null || isAudioPresetValue(patch.value, patch.name));
	}
	if (patch.scope === 'default-preset') {
		return hasOnlyKeys(patch, DEFAULT_PRESET_PATCH_KEYS)
		&& (patch.value === null || isPresetName(patch.value));
	}
	return false;
}
