// goal: contract for hotkey management including actions, bindings, and configurations

import type { AudioVolumeState } from './audio.contracts.js';
import type {
	ControlApplyAck,
	ControlCapability,
} from './control.contracts.js';
import {
	SPECTRA_DEFAULT_HOTKEY_ACTIONS,
	resolveSpectraDefaultHotkeyAction,
} from './spectra.bootstrap.js';

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
} as const satisfies Record<string, HotkeyActionDescriptor>;

export type HotkeyAction = keyof typeof HOTKEY_ACTION_DESCRIPTORS;

// The descriptor table is the sole persisted-action key owner. Object.keys
// preserves its declaration order, so the historical public list API remains
// stable without a second hand-maintained action vocabulary.
export const HOTKEY_ACTIONS: readonly HotkeyAction[] = Object.freeze(
	Object.keys(HOTKEY_ACTION_DESCRIPTORS) as HotkeyAction[],
);

export type SpectraHotkeyActualFeedback =
	| { kind: 'volume'; value: number; volumeState: AudioVolumeState }
	| { kind: 'speed'; value: number };

export function resolveSpectraHotkeyActualFeedback(
	action: HotkeyAction,
	acknowledgement: unknown,
): SpectraHotkeyActualFeedback | undefined {
	if (HOTKEY_ACTION_DESCRIPTORS[action].feedbackOwner !== 'actual-osd'
		|| typeof acknowledgement !== 'object'
		|| acknowledgement === null) return undefined;
	const candidate = acknowledgement as Partial<
		Pick<ControlApplyAck, 'fields' | 'audioVolume'>
	>;
	if (action.startsWith('speed_')) {
		const speed = candidate.fields?.speed?.actual;
		return typeof speed === 'number' ? { kind: 'speed', value: speed } : undefined;
	}
	const audioVolume = candidate.audioVolume;
	return audioVolume ? {
		kind: 'volume',
		value: audioVolume.effectiveVolume,
		volumeState: audioVolume.volumeState,
	} : undefined;
}

const HOTKEY_ACTION_SET: ReadonlySet<string> = new Set(HOTKEY_ACTIONS);
const DEFAULT_HOTKEY_ACTION_SET: ReadonlySet<string> = new Set(SPECTRA_DEFAULT_HOTKEY_ACTIONS);

// Chrome command slots expose neither physical keyup nor action parameters.
// Keep this runtime predicate beside the exhaustive descriptor table so
// storage normalization, settings patches and command dispatch enforce one
// capability boundary: held/coalesced actions belong to page KeyboardEvents.
export function isSlotHotkeyAction(action: unknown): action is HotkeyAction {
	if (typeof action !== 'string' || !HOTKEY_ACTION_SET.has(action)) return false;
	const descriptor = HOTKEY_ACTION_DESCRIPTORS[action as HotkeyAction];
	return descriptor.availability !== 'disabled-legacy'
		&& !DEFAULT_HOTKEY_ACTION_SET.has(action)
		&& descriptor.parameter === 'none'
		&& descriptor.repeatPolicy !== 'coalesce-20hz';
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

// The bootstrap resolver owns the only built-in chord table. Settings,
// persistence and Options project KeyCombo into that resolver instead of
// copying the five reserved combinations into another layer.
export function isSpectraDefaultHotkeyKeyCombo(key: KeyCombo): boolean {
	return resolveSpectraDefaultHotkeyAction({
		code: key.code,
		altKey: key.modifiers.alt,
		ctrlKey: key.modifiers.ctrl,
		shiftKey: key.modifiers.shift,
		metaKey: key.modifiers.meta,
	}) !== null;
}

export interface HotkeyBinding {
	id: string;
	enabled: boolean;
	key: KeyCombo;
	action: HotkeyAction;
	params?: HotkeyParams;
	conditions?: HotkeyConditions;
	disabledReason?: 'unsupported_action' | 'reserved_default_chord';
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

export const DEFAULT_HOTKEY_SETTINGS: Readonly<HotkeySettings> = {
	// The five shipped defaults are page-owned so websites can win conflicts.
	slots: {},
	sites: {},
} as const;
