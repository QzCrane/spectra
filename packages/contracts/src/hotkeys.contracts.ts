// goal: contract for hotkey management including actions, bindings, and configurations

import type { ControlCapability } from './control.contracts.js';

// Bindable actions list
export const HOTKEY_ACTIONS = [
	'none',
	// Playback
	'play_pause',
	'seek_forward_5s',
	'seek_forward_10s',
	'seek_forward_30s',
	'seek_backward_5s',
	'seek_backward_10s',
	'seek_backward_30s',
	'seek_frame_forward',
	'seek_frame_backward',
	// Speed
	'speed_up',
	'speed_down',
	'speed_reset',
	'speed_set',
	// Volume
	'volume_up',
	'volume_down',
	'volume_mute',
	'volume_set',
	// Audio
	'audio_reset',
	'gain_up',
	'gain_down',
	'pitch_up',
	'pitch_down',
	'pitch_reset',
	'delay_up',
	'delay_down',
	'delay_reset',
	'pan_left',
	'pan_right',
	'pan_reset',
	'mono_toggle',
	'capture_toggle',
	// Video
	'fullscreen_toggle',
	'pip_toggle',
	'rotate_cw',
	'rotate_ccw',
	'mirror_toggle',
	'screenshot',
	'dim_background',
	// Markers & loops
	'marker_add',
	'marker_jump_prev',
	'marker_jump_next',
	'ab_set_a',
	'ab_set_b',
	'ab_clear',
	'ab_skip',
	'loop_toggle',
	// FX Filters
	'fx_toggle',
	'fx_reset',
	// Tab state
	'tab_pin',
	'tab_mute',
	// Misc
	'show_info',
	'open_popup',
	'open_options',
	'run_js',
	'open_url',
] as const;

export type HotkeyAction = typeof HOTKEY_ACTIONS[number];

export type HotkeyAvailability = 'enabled' | 'no-op' | 'disabled-legacy';
export type HotkeyRepeatPolicy = 'coalesce-20hz' | 'ignore-repeat' | 'single';
export type HotkeyParameterKind = 'none' | 'speed' | 'volume' | 'script' | 'url';
export type HotkeyFeedbackOwner = 'actual-osd' | 'handler-result' | 'listener-label' | 'none';

export interface HotkeyActionDescriptor {
	capability: ControlCapability | null;
	availability: HotkeyAvailability;
	repeatPolicy: HotkeyRepeatPolicy;
	requiresUserActivation: boolean;
	parameter: HotkeyParameterKind;
	feedbackOwner: HotkeyFeedbackOwner;
}

const descriptor = (
	capability: ControlCapability | null,
	feedbackOwner: HotkeyFeedbackOwner,
	repeatPolicy: HotkeyRepeatPolicy = 'ignore-repeat',
	requiresUserActivation = false,
	parameter: HotkeyParameterKind = 'none',
	availability: HotkeyAvailability = 'enabled',
): HotkeyActionDescriptor => ({
	capability,
	availability,
	repeatPolicy,
	requiresUserActivation,
	parameter,
	feedbackOwner,
});

// One executable disposition for every persisted action. Options, page
// listeners, Chrome command slots and migration tests consume this table so a
// shortcut cannot claim support while bypassing the canonical control planner.
export const HOTKEY_ACTION_DESCRIPTORS = {
	none: descriptor(null, 'none', 'ignore-repeat', false, 'none', 'no-op'),
	play_pause: descriptor('playback-toggle', 'listener-label', 'ignore-repeat', true),
	seek_forward_5s: descriptor('seek-relative', 'listener-label', 'coalesce-20hz'),
	seek_forward_10s: descriptor('seek-relative', 'listener-label', 'coalesce-20hz'),
	seek_forward_30s: descriptor('seek-relative', 'listener-label', 'coalesce-20hz'),
	seek_backward_5s: descriptor('seek-relative', 'listener-label', 'coalesce-20hz'),
	seek_backward_10s: descriptor('seek-relative', 'listener-label', 'coalesce-20hz'),
	seek_backward_30s: descriptor('seek-relative', 'listener-label', 'coalesce-20hz'),
	seek_frame_forward: descriptor('frame-step', 'listener-label', 'coalesce-20hz'),
	seek_frame_backward: descriptor('frame-step', 'listener-label', 'coalesce-20hz'),
	speed_up: descriptor('speed', 'actual-osd', 'coalesce-20hz'),
	speed_down: descriptor('speed', 'actual-osd', 'coalesce-20hz'),
	speed_reset: descriptor('speed', 'actual-osd'),
	speed_set: descriptor('speed', 'actual-osd', 'ignore-repeat', false, 'speed'),
	volume_up: descriptor('effective-volume', 'actual-osd', 'coalesce-20hz'),
	volume_down: descriptor('effective-volume', 'actual-osd', 'coalesce-20hz'),
	volume_mute: descriptor('mediaMuted', 'actual-osd'),
	volume_set: descriptor('effective-volume', 'actual-osd', 'ignore-repeat', false, 'volume'),
	audio_reset: descriptor('audio-reset', 'actual-osd'),
	gain_up: descriptor('effective-volume', 'actual-osd', 'coalesce-20hz'),
	gain_down: descriptor('effective-volume', 'actual-osd', 'coalesce-20hz'),
	pitch_up: descriptor(null, 'handler-result', 'ignore-repeat', false, 'none', 'disabled-legacy'),
	pitch_down: descriptor(null, 'handler-result', 'ignore-repeat', false, 'none', 'disabled-legacy'),
	pitch_reset: descriptor(null, 'handler-result', 'ignore-repeat', false, 'none', 'disabled-legacy'),
	delay_up: descriptor('delay', 'listener-label', 'coalesce-20hz'),
	delay_down: descriptor('delay', 'listener-label', 'coalesce-20hz'),
	delay_reset: descriptor('delay', 'listener-label'),
	pan_left: descriptor('pan', 'listener-label', 'coalesce-20hz'),
	pan_right: descriptor('pan', 'listener-label', 'coalesce-20hz'),
	pan_reset: descriptor('pan', 'listener-label'),
	mono_toggle: descriptor('mono', 'listener-label'),
	capture_toggle: descriptor(null, 'handler-result', 'ignore-repeat', false, 'none', 'disabled-legacy'),
	fullscreen_toggle: descriptor('fullscreen', 'listener-label', 'ignore-repeat', true),
	pip_toggle: descriptor('pip', 'listener-label', 'ignore-repeat', true),
	rotate_cw: descriptor('rotation', 'listener-label'),
	rotate_ccw: descriptor('rotation', 'listener-label'),
	mirror_toggle: descriptor('mirrored', 'listener-label'),
	screenshot: descriptor('screenshot', 'listener-label', 'single', true),
	dim_background: descriptor('dimEnabled', 'listener-label'),
	marker_add: descriptor('marker-add', 'handler-result'),
	marker_jump_prev: descriptor('marker-jump-previous', 'handler-result', 'coalesce-20hz'),
	marker_jump_next: descriptor('marker-jump-next', 'handler-result', 'coalesce-20hz'),
	ab_set_a: descriptor('ab-set-a', 'handler-result'),
	ab_set_b: descriptor('ab-set-b', 'handler-result'),
	ab_clear: descriptor('ab-clear', 'handler-result'),
	ab_skip: descriptor('ab-skip', 'handler-result', 'coalesce-20hz'),
	loop_toggle: descriptor('loop', 'listener-label'),
	fx_toggle: descriptor('video-effects-toggle', 'listener-label'),
	fx_reset: descriptor('video-effects-reset', 'listener-label'),
	tab_pin: descriptor('tabPinned', 'listener-label'),
	tab_mute: descriptor('tabMuted', 'listener-label'),
	show_info: descriptor('show-info', 'handler-result'),
	open_popup: descriptor('open-popup', 'none'),
	open_options: descriptor('open-options', 'none'),
	run_js: descriptor('run-user-script', 'none', 'ignore-repeat', false, 'script'),
	open_url: descriptor('open-url', 'none', 'ignore-repeat', false, 'url'),
} as const satisfies Record<HotkeyAction, HotkeyActionDescriptor>;

const HOTKEY_ACTION_SET: ReadonlySet<string> = new Set(HOTKEY_ACTIONS);

// Chrome command slots cannot persist action parameters. Keep this runtime
// predicate beside the exhaustive descriptor table so storage normalization,
// settings patches and command dispatch enforce exactly one boundary.
export function isSlotHotkeyAction(action: unknown): action is HotkeyAction {
	if (typeof action !== 'string' || !HOTKEY_ACTION_SET.has(action)) return false;
	const descriptor = HOTKEY_ACTION_DESCRIPTORS[action as HotkeyAction];
	return descriptor.availability !== 'disabled-legacy' && descriptor.parameter === 'none';
}

export interface KeyModifiers {
	ctrl: boolean;
	alt: boolean;
	shift: boolean;
	meta: boolean;
}

export interface KeyCombo {
	// code: KeyboardEvent.code
	code: string;
	modifiers: KeyModifiers;
}

export interface HotkeyBinding {
	id: string;
	enabled: boolean;
	key: KeyCombo;
	action: HotkeyAction;
	params?: HotkeyParams;
	conditions?: HotkeyConditions;
	disabledReason?: 'unsupported_action';
}

export interface HotkeyParams {
	// inv: speed range 0.1-16
	speed?: number;
	// inv: the only public effective-volume range is 0-800
	volume?: number;
	step?: number;
	script?: string;
	url?: string;
}

const HOTKEY_PARAM_KEYS: ReadonlySet<string> = new Set(['speed', 'volume', 'step', 'script', 'url']);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteInRange(value: unknown, minimum: number, maximum: number): value is number {
	return typeof value === 'number' && Number.isFinite(value)
		&& value >= minimum && value <= maximum;
}

function isHttpUrl(value: string): boolean {
	if (value.length === 0 || value.length > 8192) return false;
	try {
		const protocol = new URL(value).protocol;
		return protocol === 'http:' || protocol === 'https:';
	} catch {
		return false;
	}
}

// Settings can originate from storage written by an older extension. Validate
// action parameters at the contract boundary as well as in Options so a
// missing or malformed parameter cannot be acknowledged as a handled no-op.
export function isHotkeyParamsForAction(
	action: HotkeyAction,
	value: unknown,
): value is HotkeyParams | undefined {
	const required = HOTKEY_ACTION_DESCRIPTORS[action].parameter;
	if (value === undefined) return required === 'none';
	if (!isRecord(value) || !Object.keys(value).every((key) => HOTKEY_PARAM_KEYS.has(key))) return false;
	if (value.speed !== undefined && !isFiniteInRange(value.speed, 0.1, 16)) return false;
	if (value.volume !== undefined && !isFiniteInRange(value.volume, 0, 800)) return false;
	if (value.step !== undefined && !isFiniteInRange(value.step, 0.001, 800)) return false;
	if (value.script !== undefined && (
		typeof value.script !== 'string' || value.script.length === 0 || value.script.length > 100_000
	)) return false;
	if (value.url !== undefined && (typeof value.url !== 'string' || !isHttpUrl(value.url))) return false;
	if (required === 'speed') return value.speed !== undefined;
	if (required === 'volume') return value.volume !== undefined;
	if (required === 'script') return value.script !== undefined;
	if (required === 'url') return value.url !== undefined;
	return value.speed === undefined
		&& value.volume === undefined
		&& value.script === undefined
		&& value.url === undefined;
}

export interface HotkeyConditions {
	// domains: empty fits all (global)
	domains?: string[];
	requireMedia?: boolean;
}

// SlotMapping: chrome.commands names mapped to HotkeyActions
export type SlotMapping = Record<string, HotkeyAction>;

export interface SiteHotkeyConfig {
	enabled: boolean;
	bindings: HotkeyBinding[];
}

export interface HotkeySettings {
	slots: SlotMapping;
	sites: Record<string, SiteHotkeyConfig>;
	disabledLegacyBindings?: HotkeyBinding[];
}

export const DEFAULT_MODIFIERS: Readonly<KeyModifiers> = {
	ctrl: false, alt: false, shift: false, meta: false,
} as const;

// DEFAULT_SLOTS: maps manifest.json command names to actions
export const DEFAULT_SLOTS: SlotMapping = {
	volume_up: 'volume_up',
	volume_down: 'volume_down',
	toggle_mute: 'volume_mute',
	speed_up: 'speed_up',
};

export const DEFAULT_HOTKEY_SETTINGS: Readonly<HotkeySettings> = {
	slots: DEFAULT_SLOTS,
	sites: {},
} as const;

export { PRESET_BINDINGS } from './hotkeys.presets.js';
