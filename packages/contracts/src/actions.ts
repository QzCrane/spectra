// goal: single source of truth for message action names and constants

// Action name list
export const NEXUS_ACTIONS = [
	'AUDIO_GET_STATUS',
	'AUDIO_SET_CONFIG',
	'AUDIO_GET_VISUALIZER',
	'CAPTURE_TOGGLE',
	'CAPTURE_GET_STATE',
	'CAPTURE_UPDATE_CONFIG',
	'CAPTURE_STATE_CHANGE',
	'SETTINGS_UPDATE',
	'SETTINGS_GET',
	'BADGE_UPDATE',
	'BADGE_CLEAR',
	'UI_SYNC',
	'SHORTCUT_TRIGGER',
	'REGISTRY_ADD_DOMAIN',
	'REGISTRY_REMOVE_DOMAIN',
	'REGISTRY_QUERY_DOMAIN',
	'REGISTRY_MARK_PROBED',
	'MEDIA_TOGGLE_PLAY',
	'MEDIA_TOGGLE_PIP',
	'MEDIA_SET_SPEED',
	'MEDIA_GET_STATE',
	'VIDEO_ROTATE',
	'VIDEO_MIRROR',
	'VIDEO_SCREENSHOT',
	'VIDEO_FULLSCREEN',
	'VIDEO_CROP',
	'VIDEO_SEEK',
	'VIDEO_SET_FILTER',
	'VIDEO_RESET_FILTER',
	'VIDEO_DIM_BACKGROUND',
	'VIDEO_AB_SET_A',
	'VIDEO_AB_SET_B',
	'VIDEO_AB_CLEAR',
	'VIDEO_AB_GET_STATE',
	'VIDEO_MARKER_ADD',
	'VIDEO_MARKER_REMOVE',
	'VIDEO_MARKER_JUMP',
	'VIDEO_MARKER_LIST',
	'TAB_REPORT_MEDIA',
	'TAB_GET_VISIBLE_TABS',
	'GLOBAL_SETTINGS_UPDATE',
	'REMOTE_GET_SESSION',
	'REMOTE_CREATE_SESSION',
	'REMOTE_CLOSE_SESSION',
	'REMOTE_COMMAND',
	'INJECT_CONTENT_SCRIPT',
] as const;

export const OFFSCREEN_ACTIONS = [
	'OFFSCREEN_START',
	'OFFSCREEN_STOP',
	'OFFSCREEN_UPDATE_CONFIG',
	'OFFSCREEN_GET_VIZ',
] as const;

// Derived types
export type NexusActionName = typeof NEXUS_ACTIONS[number];
export type OffscreenActionName = typeof OFFSCREEN_ACTIONS[number];

type ActionMap<T extends readonly string[]> = { [K in T[number]]: K };

// eff: transform string array to key-pair identical object for runtime usage
function createActionMap<T extends readonly string[]>(actions: T): ActionMap<T> {
	const map = {} as ActionMap<T>;
	for (const action of actions) {
		(map as Record<string, string>)[action] = action;
	}
	return map;
}

export const Actions = createActionMap(NEXUS_ACTIONS);
export const OffscreenActions = createActionMap(OFFSCREEN_ACTIONS);
