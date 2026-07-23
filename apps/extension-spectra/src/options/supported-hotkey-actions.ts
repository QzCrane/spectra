// goal: keeps the editor aligned with actions that have a concrete runtime handler

import {
	HOTKEY_ACTIONS,
	HOTKEY_ACTION_DESCRIPTORS,
	isSlotHotkeyAction as isContractSlotHotkeyAction,
	type HotkeyAction,
} from '@nexus/contracts';

export const LEGACY_UNSUPPORTED_ACTIONS = new Set<HotkeyAction>(
	HOTKEY_ACTIONS.filter((action) => HOTKEY_ACTION_DESCRIPTORS[action].availability === 'disabled-legacy'),
);

const HOTKEY_GROUPS: ReadonlyArray<readonly [string, readonly HotkeyAction[]]> = [
	['hotkey_group_playback', ['play_pause', 'seek_forward_5s', 'seek_forward_10s', 'seek_forward_30s', 'seek_backward_5s', 'seek_backward_10s', 'seek_backward_30s', 'seek_frame_forward', 'seek_frame_backward']],
	['hotkey_group_speed', ['speed_up', 'speed_down', 'speed_reset', 'speed_set']],
	['hotkey_group_volume', ['volume_up', 'volume_down', 'volume_mute', 'volume_set']],
	['hotkey_group_audio', ['audio_reset', 'gain_up', 'gain_down', 'delay_up', 'delay_down', 'delay_reset', 'pan_left', 'pan_right', 'pan_reset', 'mono_toggle', 'capture_toggle']],
	['hotkey_group_video', ['fullscreen_toggle', 'pip_toggle', 'rotate_cw', 'rotate_ccw', 'mirror_toggle', 'screenshot', 'dim_background']],
	['hotkey_group_markers', ['marker_add', 'marker_jump_prev', 'marker_jump_next', 'ab_set_a', 'ab_set_b', 'ab_clear', 'ab_skip', 'loop_toggle']],
	['hotkey_group_fx', ['fx_toggle', 'fx_reset']],
	['hotkey_group_tab', ['tab_pin', 'tab_mute']],
	['hotkey_group_other', ['show_info', 'open_popup', 'open_options', 'run_js', 'open_url', 'none']],
] as const;

export const EDITABLE_HOTKEY_GROUPS: ReadonlyArray<readonly [string, readonly HotkeyAction[]]> =
	HOTKEY_GROUPS.map(([label, actions]) => [
		label,
		actions.filter((action) => HOTKEY_ACTION_DESCRIPTORS[action].availability !== 'disabled-legacy'),
	] as const);

export const EDITABLE_HOTKEY_ACTIONS = new Set<HotkeyAction>(
	EDITABLE_HOTKEY_GROUPS.flatMap(([, actions]) => actions),
);

// Chrome command slots persist only an action name, so actions that require a
// parameter would otherwise be displayed as selectable but execute as no-ops.
export const PARAMETER_REQUIRED_HOTKEY_ACTIONS = new Set<HotkeyAction>(
	HOTKEY_ACTIONS.filter((action) => HOTKEY_ACTION_DESCRIPTORS[action].parameter !== 'none'),
);

export const SLOT_HOTKEY_ACTIONS = new Set<HotkeyAction>(
	[...EDITABLE_HOTKEY_ACTIONS].filter(
		(action) => isContractSlotHotkeyAction(action),
	),
);

export function isEditableHotkeyAction(action: HotkeyAction): boolean {
	return EDITABLE_HOTKEY_ACTIONS.has(action);
}

export function isSlotHotkeyAction(action: HotkeyAction): boolean {
	return isContractSlotHotkeyAction(action);
}
