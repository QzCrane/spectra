// goal: contract for hotkey management including actions, bindings, and configurations

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
}

export interface HotkeyParams {
	// inv: speed range 0.1-16
	speed?: number;
	// inv: volume range 0-800
	volume?: number;
	step?: number;
	script?: string;
	url?: string;
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
