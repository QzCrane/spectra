// goal: request/response protocol definitions for all Nexus messaging actions

import type { AudioConfig, AudioState, AudioMode } from '../audio.contracts.js';
import type { GlobalSettings } from '../settings.contracts.js';

export interface NexusMessages {
	// Audio Control
	'AUDIO_GET_STATUS': {
		req: void;
		res: { config: AudioConfig; hasAudio: boolean; isPlaying: boolean; mode: AudioMode; userInteracted: boolean };
	};
	'AUDIO_SET_CONFIG': {
		req: { config: Partial<AudioConfig> };
		res: { success: boolean; state?: { config: AudioConfig; hasAudio: boolean; isPlaying: boolean; mode: AudioMode; userInteracted: boolean } };
	};
	'AUDIO_GET_VISUALIZER': { req: void; res: { buffer: number[] | null } };

	// Capture Mode
	'CAPTURE_TOGGLE': { req: { enabled: boolean; config?: AudioConfig; tabId?: number }; res: { status: 'processing' | 'error'; error?: string } };
	'CAPTURE_GET_STATE': { req: { tabId?: number }; res: boolean };
	'CAPTURE_UPDATE_CONFIG': { req: { tabId?: number; config: AudioConfig }; res: void };
	'CAPTURE_STATE_CHANGE': { req: { tabId?: number; enabled: boolean }; res: void };

	// Global Settings
	'SETTINGS_UPDATE': { req: { settings: Partial<GlobalSettings> }; res: { success: boolean } };
	'SETTINGS_GET': { req: void; res: GlobalSettings };

	// Badge/Status
	'BADGE_UPDATE': { req: { tabId?: number; volume: number; muted: boolean; isCapture: boolean; userInteracted?: boolean }; res: void };
	'BADGE_CLEAR': { req: { tabId?: number }; res: void };

	// UI Sync
	'UI_SYNC': { req: { config: AudioConfig; mode?: AudioMode; isCaptureActive?: boolean }; res: void };

	// Shortcut
	'SHORTCUT_TRIGGER': { req: { command: 'volume_up' | 'volume_down' | 'toggle_mute'; config?: AudioConfig }; res: void };

	// Domain Registry
	'REGISTRY_ADD_DOMAIN': { req: { domain: string }; res: { success: boolean; reason?: string } };
	'REGISTRY_REMOVE_DOMAIN': { req: { domain: string }; res: { success: boolean } };
	'REGISTRY_QUERY_DOMAIN': { req: { domain: string }; res: { entry: import('../registry.contracts.js').DomainEntry | null } };
	'REGISTRY_MARK_PROBED': { req: { domain: string; restricted: boolean }; res: { success: boolean; reason?: string } };

	// Media Control
	'MEDIA_TOGGLE_PLAY': { req: void; res: { playing: boolean } };
	'MEDIA_TOGGLE_PIP': { req: void; res: { active: boolean } };
	'MEDIA_SET_SPEED': { req: { speed: number; preservePitch?: boolean }; res: { speed: number; preservePitch: boolean } };
	'MEDIA_GET_STATE': { req: void; res: { playing: boolean; speed: number; pipActive: boolean; preservePitch: boolean } };

	// Video Transformation
	'VIDEO_ROTATE': { req: void; res: { rotation: number } };
	'VIDEO_MIRROR': { req: void; res: { mirrored: boolean } };
	'VIDEO_SCREENSHOT': { req: void; res: { dataUrl: string | null } };
	'VIDEO_FULLSCREEN': { req: void; res: { active: boolean } };
	'VIDEO_CROP': { req: void; res: { cropped: boolean } };
	'VIDEO_SEEK': { req: { delta: number }; res: { currentTime: number } };

	// Visual Filters
	'VIDEO_SET_FILTER': { req: { brightness?: number; contrast?: number; saturate?: number; grayscale?: boolean; invert?: boolean }; res: { applied: boolean } };
	'VIDEO_RESET_FILTER': { req: void; res: { reset: boolean } };
	'VIDEO_DIM_BACKGROUND': { req: { enabled?: boolean; opacity?: number }; res: { active: boolean; opacity: number } };

	// AB Looping
	'VIDEO_AB_SET_A': { req: void; res: { pointA: number | null } };
	'VIDEO_AB_SET_B': { req: void; res: { pointB: number | null; looping: boolean } };
	'VIDEO_AB_CLEAR': { req: void; res: { cleared: boolean } };
	'VIDEO_AB_GET_STATE': { req: void; res: { pointA: number | null; pointB: number | null; looping: boolean } };

	// Markers
	'VIDEO_MARKER_ADD': { req: { label?: string }; res: { id: string; time: number; label: string } };
	'VIDEO_MARKER_REMOVE': { req: { id: string }; res: { removed: boolean } };
	'VIDEO_MARKER_JUMP': { req: { id: string }; res: { jumped: boolean; time: number } };
	'VIDEO_MARKER_LIST': { req: void; res: { markers: Array<{ id: string; time: number; label: string }> } };

	// Tab/Global State Reports
	'TAB_REPORT_MEDIA': { req: { hasMediaElement: boolean; userInteracted?: boolean }; res: void };
	'TAB_GET_VISIBLE_TABS': { req: void; res: { tabs: number[] } };

	// Remote Control
	'REMOTE_GET_SESSION': { req: void; res: { sessionId: string | null; peerId: string | null; connected: boolean } };
	'REMOTE_CREATE_SESSION': { req: void; res: { sessionId: string; peerId: string } };
	'REMOTE_CLOSE_SESSION': { req: void; res: { closed: boolean } };
	'REMOTE_COMMAND': { req: { command: 'volume_up' | 'volume_down' | 'mute' | 'play_pause' | 'next' | 'prev' }; res: { executed: boolean } };

	// Lifecycle
	'INJECT_CONTENT_SCRIPT': { req: { tabId: number }; res: { success: boolean } };

	// User Scripts
	'USER_SCRIPT_EXECUTE': { req: { script: string }; res: { success: boolean; error?: string } };

	// HALO Tools
	'HALO_GET_STATUS': { req: void; res: { hostname: string; activeTools: string[] } };
	'HALO_TOOL_ACTIVATE': { req: { toolId: string }; res: { success: boolean; toolId?: string; error?: string } };
	'HALO_TOOL_DEACTIVATE': { req: { toolId: string }; res: { success: boolean } };
	'HALO_RULER_START': { req: void; res: { success: boolean } };
	'HALO_RULER_CANCEL': { req: void; res: { success: boolean } };
	'HALO_RULER_RESULT': { req: { data: any }; res: void };
	'HALO_SCROLL_TO_HEADING': { req: { index: number }; res: { success: boolean; error?: string } };
	'HALO_CLIPBOARD_ADD': { req: { text: string; sourceUrl?: string; sourceTitle?: string }; res: void };
}

export type NexusAction = keyof NexusMessages;
export type NexusRequest<A extends NexusAction> = NexusMessages[A]['req'];
export type NexusResponse<A extends NexusAction> = NexusMessages[A]['res'];
