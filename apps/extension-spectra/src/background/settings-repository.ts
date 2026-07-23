// goal: the only writer for SPECTRA global and hotkey settings

import {
	DEFAULT_GLOBAL_SETTINGS,
	DEFAULT_HOTKEY_SETTINGS,
	DEFAULT_AUDIO_CONFIG,
	HOTKEY_ACTIONS,
	HOTKEY_ACTION_DESCRIPTORS,
	isHotkeyParamsForAction,
	isSlotHotkeyAction,
	SPECTRA_SETTINGS_SCHEMA_VERSION,
	findBestHostnameMatch,
	normalizeHostname,
	resolveAudioVolume,
	type GlobalSettings,
	type AudioConfig,
	type AudioPresetValue,
	type HotkeyAction,
	type HotkeyBinding,
	type HotkeySettings,
	type HotkeySiteMutation,
	type SettingsPatch,
	type SettingsSnapshot,
	type SiteHotkeyConfig,
	type ThemeMode,
} from '@nexus/contracts';

const GLOBAL_KEY = 'globalSettings';
const HOTKEY_KEY = 'hotkeySettings';
const SITE_SETTINGS_KEY = 'siteSettings';
const GLOBAL_PRESETS_KEY = 'globalPresets';
const DEFAULT_PRESET_KEY = 'defaultPresetId';
const META_KEY = 'spectraSettingsMeta';
export const SETTINGS_WRITE_DEBOUNCE_MS = 250;
const MAX_PAUSE_RETENTION_SECONDS = 86_400;
const UNSUPPORTED_ACTIONS = new Set<HotkeyAction>(
	HOTKEY_ACTIONS.filter((action) => HOTKEY_ACTION_DESCRIPTORS[action].availability === 'disabled-legacy'),
);
const HOTKEY_ACTION_SET = new Set<string>(HOTKEY_ACTIONS);
const SUPPORTED_LANGUAGES = new Set<GlobalSettings['lang']>([
	'en-US', 'zh-CN', 'zh-TW', 'ja-JP', 'ko-KR', 'es-ES', 'ru-RU', 'de-DE', 'fr-FR',
]);
const THEME_MODES = new Set<GlobalSettings['themeMode']>(['light', 'dark', 'system']);
const MAX_SITE_HOTKEY_BINDINGS = 1000;
// note: must include EVERY field sanitizeAudioPatch handles below. Missing `preservePitch`
// here caused `audio-site` replace-mode saves to throw `Unknown audio setting: preservePitch`
// because state.config (a full AudioConfig) always carries preservePitch.
const AUDIO_CONFIG_KEYS = new Set<keyof AudioConfig>([
	'enabled', 'volume', 'volumeBase', 'boost', 'muted', 'compressor', 'mono', 'bass', 'eqValues', 'pan', 'delay', 'speed', 'preservePitch',
]);

interface SettingsMeta {
	schemaVersion: typeof SPECTRA_SETTINGS_SCHEMA_VERSION;
	revision: number;
	migratedAt: number;
	legacyThemeModeMissing?: boolean;
}

export interface SettingsStorageArea {
	get(keys: string | string[]): Promise<Record<string, unknown>>;
	set(items: Record<string, unknown>): Promise<void>;
}

export class SettingsRevisionConflictError extends Error {
	constructor(readonly currentRevision: number) {
		super(`Settings revision changed to ${currentRevision}`);
		this.name = 'SettingsRevisionConflictError';
	}
}

export class InvalidSettingsPatchError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'InvalidSettingsPatchError';
	}
}

function requireSite(
	sites: HotkeySettings['sites'],
	domain: string,
): SiteHotkeyConfig {
	const site = sites[domain];
	if (!site) throw new InvalidSettingsPatchError('Hotkey site does not exist');
	return site;
}

function applyHotkeySiteMutation(
	current: HotkeySettings,
	domain: string,
	mutation: HotkeySiteMutation,
): HotkeySettings {
	const sites = { ...current.sites };
	let disabledLegacyBindings = [...(current.disabledLegacyBindings ?? [])];

	switch (mutation.type) {
		case 'ensure-site':
			if (!sites[domain]) sites[domain] = { enabled: mutation.enabled, bindings: [] };
			break;
		case 'delete-site':
			delete sites[domain];
			break;
		case 'set-enabled': {
			const site = requireSite(sites, domain);
			sites[domain] = { ...site, enabled: mutation.enabled };
			break;
		}
		case 'upsert-binding': {
			const site = requireSite(sites, domain);
			disabledLegacyBindings = disabledLegacyBindings.filter(({ id }) => id !== mutation.binding.id);
			const sanitized = sanitizeSite(
				{ enabled: site.enabled, bindings: [mutation.binding] },
				disabledLegacyBindings,
			).bindings[0];
			if (!sanitized) throw new InvalidSettingsPatchError('Invalid hotkey binding');

			const bindings: HotkeyBinding[] = [];
			let replaced = false;
			for (const binding of site.bindings) {
				if (binding.id !== sanitized.id) {
					bindings.push(binding);
				} else if (!replaced) {
					bindings.push(sanitized);
					replaced = true;
				}
			}
			if (!replaced) {
				if (bindings.length >= MAX_SITE_HOTKEY_BINDINGS) {
					throw new InvalidSettingsPatchError('Hotkey site binding limit reached');
				}
				bindings.push(sanitized);
			}
			sites[domain] = { ...site, bindings };
			break;
		}
		case 'remove-binding': {
			const site = requireSite(sites, domain);
			sites[domain] = {
				...site,
				bindings: site.bindings.filter(({ id }) => id !== mutation.bindingId),
			};
			disabledLegacyBindings = disabledLegacyBindings.filter(({ id }) => id !== mutation.bindingId);
			break;
		}
	}

	return { ...current, sites, disabledLegacyBindings };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function cloneDefaultHotkeys(): HotkeySettings {
	return {
		slots: { ...DEFAULT_HOTKEY_SETTINGS.slots },
		sites: {},
		disabledLegacyBindings: [],
	};
}

function normalizeGlobalSettings(raw: unknown, preferLegacyAliases: boolean): GlobalSettings {
	const source = isRecord(raw) ? raw : {};
	const legacyLanguage = source.language;
	const langCandidate = preferLegacyAliases && typeof legacyLanguage === 'string'
		? legacyLanguage
		: source.lang;
	const themeCandidate = source.themeMode ?? source.theme;
	const pause = typeof source.pauseRetentionSeconds === 'number' && Number.isFinite(source.pauseRetentionSeconds)
		? Math.round(source.pauseRetentionSeconds)
		: DEFAULT_GLOBAL_SETTINGS.pauseRetentionSeconds;

	return {
		osdEnabled: typeof source.osdEnabled === 'boolean' ? source.osdEnabled : DEFAULT_GLOBAL_SETTINGS.osdEnabled,
		visualizerEnabled: typeof source.visualizerEnabled === 'boolean'
			? source.visualizerEnabled
			: DEFAULT_GLOBAL_SETTINGS.visualizerEnabled,
		lang: typeof langCandidate === 'string' && SUPPORTED_LANGUAGES.has(langCandidate as GlobalSettings['lang'])
			? langCandidate as GlobalSettings['lang']
			: DEFAULT_GLOBAL_SETTINGS.lang,
		themeMode: typeof themeCandidate === 'string' && THEME_MODES.has(themeCandidate as GlobalSettings['themeMode'])
			? themeCandidate as GlobalSettings['themeMode']
			: DEFAULT_GLOBAL_SETTINGS.themeMode,
		pauseRetentionSeconds: Math.max(0, Math.min(MAX_PAUSE_RETENTION_SECONDS, pause)),
	};
}

function sanitizeBinding(value: unknown): HotkeyBinding | null {
	if (!isRecord(value) || typeof value.id !== 'string' || value.id.length === 0 || value.id.length > 128) return null;
	if (typeof value.enabled !== 'boolean' || typeof value.action !== 'string' || !HOTKEY_ACTION_SET.has(value.action)) return null;
	if (!isRecord(value.key) || typeof value.key.code !== 'string' || !isRecord(value.key.modifiers)) return null;
	const modifiers = value.key.modifiers;
	if (typeof modifiers.ctrl !== 'boolean' || typeof modifiers.alt !== 'boolean'
		|| typeof modifiers.shift !== 'boolean' || typeof modifiers.meta !== 'boolean') return null;

	const binding: HotkeyBinding = {
		id: value.id,
		enabled: value.enabled,
		key: {
			code: value.key.code.slice(0, 64),
			modifiers: {
				ctrl: modifiers.ctrl,
				alt: modifiers.alt,
				shift: modifiers.shift,
				meta: modifiers.meta,
			},
		},
		action: value.action as HotkeyAction,
	};
	if (!isHotkeyParamsForAction(binding.action, value.params)) return null;
	if (value.params) binding.params = { ...value.params };
	if (isRecord(value.conditions)) binding.conditions = { ...value.conditions };
	if (value.disabledReason === 'unsupported_action') binding.disabledReason = value.disabledReason;
	return binding;
}

function sanitizeSite(value: unknown, disabledLegacy: HotkeyBinding[]): SiteHotkeyConfig {
	const source = isRecord(value) ? value : {};
	const bindings = Array.isArray(source.bindings)
		? source.bindings.map(sanitizeBinding).filter((binding): binding is HotkeyBinding => !!binding)
		: [];
	for (const binding of bindings) {
		if (UNSUPPORTED_ACTIONS.has(binding.action) || binding.disabledReason === 'unsupported_action') {
			binding.enabled = false;
			binding.disabledReason = 'unsupported_action';
			if (!disabledLegacy.some((legacy) => legacy.id === binding.id)) {
				disabledLegacy.push({ ...binding, key: { ...binding.key, modifiers: { ...binding.key.modifiers } } });
			}
		}
	}
	return { enabled: source.enabled === true, bindings };
}

// post: normalization collisions retain every distinct legacy binding instead of
// allowing a differently-cased/trailing-dot domain key to replace the whole site.
function mergeHotkeySites(left: SiteHotkeyConfig | undefined, right: SiteHotkeyConfig): SiteHotkeyConfig {
	if (!left) return right;
	const bindings = new Map(left.bindings.map((binding) => [binding.id, binding]));
	for (const binding of right.bindings) bindings.set(binding.id, binding);
	return {
		enabled: left.enabled || right.enabled,
		bindings: [...bindings.values()],
	};
}

function normalizeHotkeySettings(raw: unknown): HotkeySettings {
	const source = isRecord(raw) ? raw : {};
	const normalized = cloneDefaultHotkeys();
	if (isRecord(source.slots)) {
		for (const [command, action] of Object.entries(source.slots)) {
			if (isSlotHotkeyAction(action)) normalized.slots[command] = action;
		}
	}

	const disabledLegacy = Array.isArray(source.disabledLegacyBindings)
		? source.disabledLegacyBindings.map(sanitizeBinding).filter((binding): binding is HotkeyBinding => !!binding)
		: [];
	if (isRecord(source.sites)) {
		for (const [rawDomain, site] of Object.entries(source.sites)) {
			const domain = normalizeHostname(rawDomain);
			if (!domain) continue;
			normalized.sites[domain] = mergeHotkeySites(
				normalized.sites[domain],
				sanitizeSite(site, disabledLegacy),
			);
		}
	}
	normalized.disabledLegacyBindings = disabledLegacy;
	return normalized;
}

function normalizeSiteSettings(raw: unknown): Record<string, unknown> | null {
	if (!isRecord(raw)) return null;
	const normalized: Record<string, unknown> = {};
	for (const [rawDomain, value] of Object.entries(raw)) {
		const domain = normalizeHostname(rawDomain) ?? rawDomain;
		if (!isRecord(value)) {
			normalized[domain] = value;
			continue;
		}
		const delay = typeof value.delay === 'number' && Number.isFinite(value.delay)
			? Math.max(0, Math.min(500, value.delay))
			: value.delay;
		normalized[domain] = {
			...(isRecord(normalized[domain]) ? normalized[domain] : {}),
			...value,
			...(delay === undefined ? {} : { delay }),
		};
	}
	return normalized;
}

function comparePresetNames(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

type PresetRecord = Record<string, unknown> & {
	config: Record<string, unknown>;
	meta: Record<string, unknown>;
};

function isPresetRecord(value: unknown): value is PresetRecord {
	return isRecord(value) && isRecord(value.config) && isRecord(value.meta);
}

function choosePresetFallback(globalPresets: Record<string, unknown>): string | null {
	return Object.keys(globalPresets)
		.filter((name) => isPresetRecord(globalPresets[name]))
		.sort(comparePresetNames)[0] ?? null;
}

function hasLegacyDefaultFlag(value: unknown): boolean {
	if (!isRecord(value)) return false;
	if (value.isDefault === true) return true;
	return isRecord(value.meta) && value.meta.isDefault === true;
}

function syncDefaultPresetFlags(globalPresets: Record<string, unknown>, defaultPresetId: string | null): void {
	for (const [name, entry] of Object.entries(globalPresets)) {
		if (!isPresetRecord(entry)) continue;
		globalPresets[name] = {
			...entry,
			meta: { ...entry.meta, isDefault: name === defaultPresetId },
		};
	}
}

function normalizePresetState(
	rawPresets: unknown,
	rawDefaultPresetId: unknown,
	hasCanonicalDefault: boolean,
): { globalPresets: Record<string, unknown>; defaultPresetId: string | null } {
	const source = isRecord(rawPresets) ? rawPresets : {};
	const globalPresets: Record<string, unknown> = {};
	for (const [name, value] of Object.entries(source)) {
		if (!isRecord(value)) {
			globalPresets[name] = value;
			continue;
		}
		const config = isRecord(value.config) ? value.config : null;
		const delay = typeof config?.delay === 'number' && Number.isFinite(config.delay)
			? Math.max(0, Math.min(500, config.delay))
			: config?.delay;
		globalPresets[name] = {
			...value,
			...(config ? { config: { ...config, ...(delay === undefined ? {} : { delay }) } } : {}),
			...(isRecord(value.meta) ? { meta: { ...value.meta } } : {}),
		};
	}

	let defaultPresetId: string | null = null;
	if (hasCanonicalDefault) {
		if (rawDefaultPresetId === null) {
			defaultPresetId = null;
		} else if (typeof rawDefaultPresetId === 'string' && isPresetRecord(globalPresets[rawDefaultPresetId])) {
			defaultPresetId = rawDefaultPresetId;
		} else {
			defaultPresetId = Object.keys(globalPresets)
				.filter((name) => isPresetRecord(globalPresets[name]) && hasLegacyDefaultFlag(globalPresets[name]))
				.sort(comparePresetNames)[0] ?? null;
		}
	} else {
		defaultPresetId = Object.keys(globalPresets)
			.filter((name) => isPresetRecord(globalPresets[name]) && hasLegacyDefaultFlag(globalPresets[name]))
			.sort(comparePresetNames)[0] ?? null;
	}
	syncDefaultPresetFlags(globalPresets, defaultPresetId);
	return { globalPresets, defaultPresetId };
}

function sanitizeAudioPatch(value: Partial<AudioConfig>): Partial<AudioConfig> {
	const patch: Partial<AudioConfig> = {};
	for (const key of Object.keys(value)) {
		if (!AUDIO_CONFIG_KEYS.has(key as keyof AudioConfig)) {
			throw new InvalidSettingsPatchError(`Unknown audio setting: ${key}`);
		}
	}
	for (const key of ['enabled', 'muted', 'compressor', 'mono', 'bass'] as const) {
		if (value[key] !== undefined) {
			if (typeof value[key] !== 'boolean') throw new InvalidSettingsPatchError(`${key} must be boolean`);
			patch[key] = value[key];
		}
	}
	if (value.volume !== undefined) {
		if (!Number.isFinite(value.volume) || value.volume < 0 || value.volume > 800) {
			throw new InvalidSettingsPatchError('volume must be between 0 and 800');
		}
		patch.volume = value.volume;
	}
	if (value.volumeBase !== undefined) {
		if (!Number.isFinite(value.volumeBase) || value.volumeBase < 0 || value.volumeBase > 100) {
			throw new InvalidSettingsPatchError('volumeBase must be between 0 and 100');
		}
		patch.volumeBase = value.volumeBase;
	}
	if (value.boost !== undefined) {
		if (!Number.isFinite(value.boost) || value.boost < 1 || value.boost > 8) {
			throw new InvalidSettingsPatchError('boost must be between 1 and 8');
		}
		patch.boost = value.boost;
	}
	if (patch.volumeBase !== undefined || patch.boost !== undefined) {
		patch.volume = resolveAudioVolume({
			volume: patch.volume ?? 100,
			volumeBase: patch.volumeBase,
			boost: patch.boost,
		}).effectiveVolume;
	} else if (patch.volume !== undefined) {
		const migrated = resolveAudioVolume({ volume: patch.volume });
		patch.volumeBase = migrated.volumeBase;
		patch.boost = migrated.boost;
	}
	if (value.pan !== undefined) {
		if (!Number.isFinite(value.pan) || value.pan < -1 || value.pan > 1) {
			throw new InvalidSettingsPatchError('pan must be between -1 and 1');
		}
		patch.pan = value.pan;
	}
	if (value.delay !== undefined) {
		if (!Number.isFinite(value.delay) || value.delay < 0 || value.delay > 500) {
			throw new InvalidSettingsPatchError('delay must be between 0 and 500');
		}
		patch.delay = value.delay;
	}
	if (value.speed !== undefined) {
		if (!Number.isFinite(value.speed) || value.speed < 0.1 || value.speed > 16) {
			throw new InvalidSettingsPatchError('speed must be between 0.1 and 16');
		}
		patch.speed = value.speed;
	}
	if (value.preservePitch !== undefined) {
		if (typeof value.preservePitch !== 'boolean') {
			throw new InvalidSettingsPatchError('preservePitch must be a boolean');
		}
		patch.preservePitch = value.preservePitch;
	}
	if (value.eqValues !== undefined) {
		if (value.eqValues.length !== 10 || value.eqValues.some((item) => !Number.isFinite(item) || item < -12 || item > 12)) {
			throw new InvalidSettingsPatchError('eqValues must contain ten values between -12 and 12');
		}
		patch.eqValues = [...value.eqValues];
	}
	return patch;
}

function snapshotAudioPatch(value: unknown): Partial<AudioConfig> {
	if (!isRecord(value)) return {};
	const patch: Partial<AudioConfig> = {};
	for (const key of ['enabled', 'muted', 'compressor', 'mono', 'bass', 'preservePitch'] as const) {
		if (typeof value[key] === 'boolean') patch[key] = value[key];
	}
	if (typeof value.volume === 'number' && Number.isFinite(value.volume)
		&& value.volume >= 0 && value.volume <= 800) patch.volume = value.volume;
	if (typeof value.volumeBase === 'number' && Number.isFinite(value.volumeBase)
		&& value.volumeBase >= 0 && value.volumeBase <= 100) patch.volumeBase = value.volumeBase;
	if (typeof value.boost === 'number' && Number.isFinite(value.boost)
		&& value.boost >= 1 && value.boost <= 8) patch.boost = value.boost;
	if (patch.volumeBase === undefined && patch.boost === undefined && patch.volume !== undefined) {
		const migrated = resolveAudioVolume({ volume: patch.volume });
		patch.volumeBase = migrated.volumeBase;
		patch.boost = migrated.boost;
	} else if (patch.volumeBase !== undefined || patch.boost !== undefined) {
		const canonical = resolveAudioVolume({
			volume: patch.volume ?? 100,
			volumeBase: patch.volumeBase,
			boost: patch.boost,
		});
		patch.volumeBase = canonical.volumeBase;
		patch.boost = canonical.boost;
		patch.volume = canonical.effectiveVolume;
	}
	if (typeof value.pan === 'number' && Number.isFinite(value.pan)
		&& value.pan >= -1 && value.pan <= 1) patch.pan = value.pan;
	if (typeof value.delay === 'number' && Number.isFinite(value.delay)) {
		patch.delay = Math.max(0, Math.min(500, value.delay));
	}
	if (typeof value.speed === 'number' && Number.isFinite(value.speed)
		&& value.speed >= 0.1 && value.speed <= 16) patch.speed = value.speed;
	if (Array.isArray(value.eqValues)
		&& value.eqValues.length === 10
		&& value.eqValues.every((item) => typeof item === 'number'
			&& Number.isFinite(item) && item >= -12 && item <= 12)) {
		patch.eqValues = [...value.eqValues];
	}
	return patch;
}

function isSnapshotPresetName(name: string): boolean {
	return name.trim().length > 0
		&& name.length <= 128
		&& name !== '__proto__'
		&& name !== 'constructor'
		&& name !== 'prototype'
		&& [...name].every((character) => {
			const codePoint = character.codePointAt(0) ?? 0;
			return codePoint > 31 && codePoint !== 127;
		});
}

function createSettingsSnapshot(
	revision: number,
	globalSettings: GlobalSettings,
	hotkeySettings: HotkeySettings,
	rawSites: unknown,
	rawPresets: unknown,
	rawDefaultPresetId: unknown,
): SettingsSnapshot {
	const audioSites: SettingsSnapshot['audioSites'] = {};
	if (isRecord(rawSites)) {
		for (const [rawDomain, value] of Object.entries(rawSites)) {
			const domain = normalizeHostname(rawDomain);
			if (domain && isRecord(value)) audioSites[domain] = snapshotAudioPatch(value);
		}
	}

	const audioPresets: Record<string, AudioPresetValue> = {};
	if (isRecord(rawPresets)) {
		for (const [name, value] of Object.entries(rawPresets)) {
			if (!isSnapshotPresetName(name) || !isPresetRecord(value)) continue;
			const createdAt = typeof value.meta.createdAt === 'number'
				&& Number.isSafeInteger(value.meta.createdAt)
				&& value.meta.createdAt >= 0
				? value.meta.createdAt
				: 0;
			audioPresets[name] = {
				config: snapshotAudioPatch(value.config),
				meta: {
					type: 'global',
					name,
					createdAt,
					isDefault: rawDefaultPresetId === name,
				},
			};
		}
	}
	const defaultPresetId = typeof rawDefaultPresetId === 'string'
		&& Object.hasOwn(audioPresets, rawDefaultPresetId)
		? rawDefaultPresetId
		: null;

	return {
		schemaVersion: SPECTRA_SETTINGS_SCHEMA_VERSION,
		revision,
		globalSettings,
		hotkeySettings,
		audioSites,
		audioPresets,
		defaultPresetId,
	};
}

function parseMeta(raw: unknown): SettingsMeta | null {
	if (!isRecord(raw)
		|| raw.schemaVersion !== SPECTRA_SETTINGS_SCHEMA_VERSION
		|| typeof raw.revision !== 'number'
		|| !Number.isInteger(raw.revision)
		|| raw.revision < 0) return null;
	return {
		schemaVersion: SPECTRA_SETTINGS_SCHEMA_VERSION,
		revision: raw.revision,
		migratedAt: typeof raw.migratedAt === 'number' ? raw.migratedAt : Date.now(),
		legacyThemeModeMissing: raw.legacyThemeModeMissing === true,
	};
}

export class SettingsRepository {
	private operationQueue: Promise<void> = Promise.resolve();
	private pendingWrite: Record<string, unknown> | null = null;
	private writeTimer: ReturnType<typeof setTimeout> | null = null;

	constructor(private readonly storageArea?: SettingsStorageArea) {}

	private get local(): SettingsStorageArea {
		return this.storageArea ?? chrome.storage.local;
	}

	initialize(): Promise<SettingsSnapshot> {
		return this.serialized(() => this.readState());
	}

	getSnapshot(): Promise<SettingsSnapshot> {
		return this.serialized(() => this.readState());
	}

	resolveAudioConfig(hostname: string): Promise<AudioConfig> {
		return this.serialized(async () => {
			const snapshot = await this.readState();
			const match = findBestHostnameMatch(
				hostname,
				Object.entries(snapshot.audioSites),
				([domain]) => domain,
			);
			// fallback: when no site-specific config matches, apply the user's
			// chosen default global preset so new sites inherit that baseline
			// instead of the silent DEFAULT_AUDIO_CONFIG. Site entries still win
			// because they are the explicit per-domain authority.
			let patch = match?.[1];
			if (!patch && snapshot.defaultPresetId) {
				const presetEntry = snapshot.audioPresets[snapshot.defaultPresetId];
				if (presetEntry?.config) patch = presetEntry.config;
			}
			return {
				...DEFAULT_AUDIO_CONFIG,
				...patch,
				eqValues: patch?.eqValues
					? [...patch.eqValues]
					: [...DEFAULT_AUDIO_CONFIG.eqValues],
			};
		});
	}

	flush(): Promise<void> {
		return this.serialized(() => this.flushPendingWrite());
	}

	applyPatch(patch: SettingsPatch, expectedRevision?: number): Promise<SettingsSnapshot> {
		return this.serialized(async () => {
			const current = await this.readState();
			if (expectedRevision !== undefined && expectedRevision !== current.revision) {
				throw new SettingsRevisionConflictError(current.revision);
			}
			if (patch.scope === 'legacy-theme') {
				return this.consumeLegacyTheme(current, patch.candidate);
			}

			const result = await this.readValues([
				GLOBAL_KEY,
				HOTKEY_KEY,
				SITE_SETTINGS_KEY,
				GLOBAL_PRESETS_KEY,
				DEFAULT_PRESET_KEY,
				META_KEY,
			]);
			const rawGlobal = isRecord(result[GLOBAL_KEY]) ? result[GLOBAL_KEY] : {};
			const rawHotkeys = isRecord(result[HOTKEY_KEY]) ? result[HOTKEY_KEY] : {};
			const siteSettings = isRecord(result[SITE_SETTINGS_KEY]) ? { ...result[SITE_SETTINGS_KEY] } : {};
			const presetState = normalizePresetState(
				result[GLOBAL_PRESETS_KEY],
				result[DEFAULT_PRESET_KEY],
				Object.hasOwn(result, DEFAULT_PRESET_KEY),
			);
			const globalPresets = presetState.globalPresets;
			let defaultPresetId = presetState.defaultPresetId;
			let globalSettings = current.globalSettings;
			let hotkeySettings = current.hotkeySettings;

			switch (patch.scope) {
				case 'global':
					globalSettings = this.applyGlobalPatch(globalSettings, patch.changes);
					break;
				case 'hotkey-slots': {
					const slots = { ...hotkeySettings.slots };
					for (const [command, action] of Object.entries(patch.changes)) {
						if (!command || command.length > 128) throw new InvalidSettingsPatchError('Invalid shortcut slot');
						if (action === null) delete slots[command];
						else if (isSlotHotkeyAction(action)) slots[command] = action;
						else throw new InvalidSettingsPatchError(`Unsupported hotkey action: ${action}`);
					}
					hotkeySettings = { ...hotkeySettings, slots };
					break;
				}
				case 'hotkey-site': {
					const domain = normalizeHostname(patch.domain);
					if (!domain) throw new InvalidSettingsPatchError('Invalid site hostname');
					const sites = { ...hotkeySettings.sites };
					if (patch.value === null) delete sites[domain];
					else {
						const disabledLegacy = [...(hotkeySettings.disabledLegacyBindings ?? [])];
						sites[domain] = sanitizeSite(patch.value, disabledLegacy);
						hotkeySettings = { ...hotkeySettings, disabledLegacyBindings: disabledLegacy };
					}
					hotkeySettings = { ...hotkeySettings, sites };
					break;
				}
				case 'hotkey-site-mutation': {
					const domain = normalizeHostname(patch.domain);
					if (!domain) throw new InvalidSettingsPatchError('Invalid site hostname');
					hotkeySettings = applyHotkeySiteMutation(hotkeySettings, domain, patch.mutation);
					break;
				}
				case 'audio-site': {
					const domain = normalizeHostname(patch.domain);
					if (!domain) throw new InvalidSettingsPatchError('Invalid audio settings hostname');
					if (patch.value === null) {
						delete siteSettings[domain];
						break;
					}
					const changes = sanitizeAudioPatch(patch.value);
					const existing = isRecord(siteSettings[domain]) ? siteSettings[domain] : {};
					if (patch.mode === 'replace') {
						const unknown = Object.fromEntries(
							Object.entries(existing).filter(([key]) => !AUDIO_CONFIG_KEYS.has(key as keyof AudioConfig)),
						);
						siteSettings[domain] = { ...unknown, ...DEFAULT_AUDIO_CONFIG, ...changes };
					} else {
						siteSettings[domain] = { ...existing, ...changes };
					}
					break;
				}
				case 'audio-preset': {
					if (patch.value === null) {
						delete globalPresets[patch.name];
						if (defaultPresetId === patch.name) defaultPresetId = choosePresetFallback(globalPresets);
						break;
					}
					const rawExisting = globalPresets[patch.name];
					const existing: Record<string, unknown> = isRecord(rawExisting) ? rawExisting : {};
					const existingConfig = isRecord(existing.config) ? existing.config : {};
					const existingMeta = isRecord(existing.meta) ? existing.meta : {};
					globalPresets[patch.name] = {
						...existing,
						...patch.value,
						config: { ...existingConfig, ...sanitizeAudioPatch(patch.value.config) },
						meta: { ...existingMeta, ...patch.value.meta, isDefault: defaultPresetId === patch.name },
					};
					break;
				}
				case 'default-preset': {
					if (patch.value !== null && !isPresetRecord(globalPresets[patch.value])) {
						throw new InvalidSettingsPatchError('Default preset does not exist');
					}
					defaultPresetId = patch.value;
					for (const [name, entry] of Object.entries(globalPresets)) {
						if (!isRecord(entry)) continue;
						const meta = isRecord(entry.meta) ? entry.meta : {};
						globalPresets[name] = { ...entry, meta: { ...meta, isDefault: name === defaultPresetId } };
					}
					break;
				}
				default:
					throw new InvalidSettingsPatchError('Unknown settings patch scope');
			}
			syncDefaultPresetFlags(globalPresets, defaultPresetId);

			const revision = current.revision + 1;
			const previousMeta = parseMeta(result[META_KEY]);
			const meta: SettingsMeta = {
				schemaVersion: SPECTRA_SETTINGS_SCHEMA_VERSION,
				revision,
				migratedAt: previousMeta?.migratedAt ?? Date.now(),
				legacyThemeModeMissing: patch.scope === 'global'
					&& patch.changes.themeMode !== undefined
					? false
					: previousMeta?.legacyThemeModeMissing,
			};
			this.scheduleWrite({
				[GLOBAL_KEY]: { ...rawGlobal, ...globalSettings },
				[HOTKEY_KEY]: { ...rawHotkeys, ...hotkeySettings },
				[SITE_SETTINGS_KEY]: siteSettings,
				[GLOBAL_PRESETS_KEY]: globalPresets,
				[DEFAULT_PRESET_KEY]: defaultPresetId,
				[META_KEY]: meta,
			});
			return createSettingsSnapshot(
				revision,
				globalSettings,
				hotkeySettings,
				siteSettings,
				globalPresets,
				defaultPresetId,
			);
		});
	}

	// post: atomically consumes the one-release legacy theme eligibility. A
	// normal v2 theme patch always wins because it disables this path first.
	private async consumeLegacyTheme(
		current: SettingsSnapshot,
		candidate: ThemeMode | null,
	): Promise<SettingsSnapshot> {
		if (candidate !== null && !THEME_MODES.has(candidate)) {
			throw new InvalidSettingsPatchError('Unsupported legacy theme mode');
		}
		const result = await this.readValues([GLOBAL_KEY, META_KEY]);
		const previousMeta = parseMeta(result[META_KEY]);
		if (!previousMeta?.legacyThemeModeMissing) return current;
		if (candidate === null) {
			this.scheduleWrite({
				[META_KEY]: { ...previousMeta, legacyThemeModeMissing: false },
			});
			return current;
		}

		const rawGlobal = isRecord(result[GLOBAL_KEY]) ? result[GLOBAL_KEY] : {};
		const globalSettings = this.applyGlobalPatch(current.globalSettings, { themeMode: candidate });
		const revision = current.revision + 1;
		this.scheduleWrite({
			[GLOBAL_KEY]: { ...rawGlobal, ...globalSettings },
			[META_KEY]: {
				...previousMeta,
				revision,
				legacyThemeModeMissing: false,
			},
		});
		return { ...current, revision, globalSettings };
	}

	private applyGlobalPatch(current: GlobalSettings, changes: Partial<GlobalSettings>): GlobalSettings {
		const next = { ...current };
		if (changes.osdEnabled !== undefined) {
			if (typeof changes.osdEnabled !== 'boolean') throw new InvalidSettingsPatchError('osdEnabled must be boolean');
			next.osdEnabled = changes.osdEnabled;
		}
		if (changes.visualizerEnabled !== undefined) {
			if (typeof changes.visualizerEnabled !== 'boolean') throw new InvalidSettingsPatchError('visualizerEnabled must be boolean');
			next.visualizerEnabled = changes.visualizerEnabled;
		}
		if (changes.lang !== undefined) {
			if (!SUPPORTED_LANGUAGES.has(changes.lang)) throw new InvalidSettingsPatchError('Unsupported language');
			next.lang = changes.lang;
		}
		if (changes.themeMode !== undefined) {
			if (!THEME_MODES.has(changes.themeMode)) throw new InvalidSettingsPatchError('Unsupported theme mode');
			next.themeMode = changes.themeMode;
		}
		if (changes.pauseRetentionSeconds !== undefined) {
			if (!Number.isInteger(changes.pauseRetentionSeconds) || changes.pauseRetentionSeconds < 0) {
				throw new InvalidSettingsPatchError('pauseRetentionSeconds must be a non-negative integer');
			}
			next.pauseRetentionSeconds = Math.min(MAX_PAUSE_RETENTION_SECONDS, changes.pauseRetentionSeconds);
		}
		return next;
	}

	private async readState(): Promise<SettingsSnapshot> {
		const result = await this.readValues([
			GLOBAL_KEY,
			HOTKEY_KEY,
			SITE_SETTINGS_KEY,
			GLOBAL_PRESETS_KEY,
			DEFAULT_PRESET_KEY,
			META_KEY,
		]);
		let meta = parseMeta(result[META_KEY]);
		const requiresMigration = meta === null;
		const globalSettings = normalizeGlobalSettings(result[GLOBAL_KEY], requiresMigration);
		const hotkeySettings = normalizeHotkeySettings(result[HOTKEY_KEY]);
		const normalizedSiteSettings = normalizeSiteSettings(result[SITE_SETTINGS_KEY]) ?? {};
		const normalizedPresets = normalizePresetState(
			result[GLOBAL_PRESETS_KEY],
			result[DEFAULT_PRESET_KEY],
			Object.hasOwn(result, DEFAULT_PRESET_KEY),
		);

		if (requiresMigration) {
			const rawGlobal = isRecord(result[GLOBAL_KEY]) ? result[GLOBAL_KEY] : {};
			const rawHotkeys = isRecord(result[HOTKEY_KEY]) ? result[HOTKEY_KEY] : {};
			const migratedValues: Record<string, unknown> = {
				[GLOBAL_KEY]: { ...rawGlobal, ...globalSettings },
				[HOTKEY_KEY]: { ...rawHotkeys, ...hotkeySettings },
				[GLOBAL_PRESETS_KEY]: normalizedPresets.globalPresets,
				[DEFAULT_PRESET_KEY]: normalizedPresets.defaultPresetId,
			};
			if (Object.keys(normalizedSiteSettings).length > 0) {
				migratedValues[SITE_SETTINGS_KEY] = normalizedSiteSettings;
			}

			// Two-phase migration: persist and read back data before marking schema v2 complete.
			await this.local.set(migratedValues);
			const verified = await this.local.get([
				GLOBAL_KEY,
				HOTKEY_KEY,
				GLOBAL_PRESETS_KEY,
				DEFAULT_PRESET_KEY,
				...(Object.keys(normalizedSiteSettings).length > 0 ? [SITE_SETTINGS_KEY] : []),
			]);
			if (!isRecord(verified[GLOBAL_KEY]) || !isRecord(verified[HOTKEY_KEY])) {
				throw new Error('Settings migration verification failed');
			}
			if (!isRecord(verified[GLOBAL_PRESETS_KEY])
				|| verified[DEFAULT_PRESET_KEY] !== normalizedPresets.defaultPresetId
				|| (Object.keys(normalizedSiteSettings).length > 0 && !isRecord(verified[SITE_SETTINGS_KEY]))) {
				throw new Error('Settings migration verification failed');
			}
			meta = {
				schemaVersion: SPECTRA_SETTINGS_SCHEMA_VERSION,
				revision: 0,
				migratedAt: Date.now(),
				legacyThemeModeMissing: !Object.hasOwn(rawGlobal, 'themeMode'),
			};
			await this.local.set({ [META_KEY]: meta });
		}
		if (!meta) throw new Error('Settings metadata was not initialized');

		return createSettingsSnapshot(
			meta.revision,
			globalSettings,
			hotkeySettings,
			normalizedSiteSettings,
			normalizedPresets.globalPresets,
			normalizedPresets.defaultPresetId,
		);
	}

	private async readValues(keys: string[]): Promise<Record<string, unknown>> {
		const result = await this.local.get(keys);
		if (!this.pendingWrite) return result;
		for (const storageKey of keys) {
			if (Object.hasOwn(this.pendingWrite, storageKey)) {
				result[storageKey] = this.pendingWrite[storageKey];
			}
		}
		return result;
	}

	private scheduleWrite(values: Record<string, unknown>): void {
		this.pendingWrite = { ...(this.pendingWrite ?? {}), ...values };
		this.armWriteTimer();
	}

	private armWriteTimer(): void {
		if (this.writeTimer !== null) clearTimeout(this.writeTimer);
		this.writeTimer = setTimeout(() => {
			this.writeTimer = null;
			void this.flush().catch(() => undefined);
		}, SETTINGS_WRITE_DEBOUNCE_MS);
	}

	private async flushPendingWrite(): Promise<void> {
		if (this.writeTimer !== null) {
			clearTimeout(this.writeTimer);
			this.writeTimer = null;
		}
		const pending = this.pendingWrite;
		if (!pending) return;
		this.pendingWrite = null;
		try {
			await this.local.set(pending);
		} catch (error) {
			this.pendingWrite = { ...pending, ...(this.pendingWrite ?? {}) };
			this.armWriteTimer();
			throw error;
		}
	}

	private serialized<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.operationQueue.then(operation, operation);
		this.operationQueue = result.then(() => undefined, () => undefined);
		return result;
	}
}

export const settingsRepository = new SettingsRepository();
