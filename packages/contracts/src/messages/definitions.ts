// goal: request/response protocol definitions for all Nexus messaging actions

import type { AudioConfig, AudioMode, SpectraAudioMode, AudioSessionPhase } from '../audio.contracts.js';
import type { GlobalSettings } from '../settings.contracts.js';
import type { HotkeyAction } from '../hotkeys.contracts.js';
import type { RemotePublicSession } from '../remote.contracts.js';

export interface NexusMessages {
	// Audio Control
	'AUDIO_GET_STATUS': {
		req: undefined;
		res: { config: AudioConfig; hasAudio: boolean; isPlaying: boolean; mode: AudioMode | SpectraAudioMode; userInteracted: boolean; desiredMode?: AudioMode | SpectraAudioMode | null; phase?: AudioSessionPhase; generation?: number; lastError?: string; pausedAt?: number | null };
	};
	'AUDIO_SET_CONFIG': {
		req: { config: Partial<AudioConfig> & { volumeDelta?: number; toggleMute?: boolean; isNativeSync?: boolean } };
		res: { success: boolean; state?: { config: AudioConfig; hasAudio: boolean; isPlaying: boolean; mode: AudioMode | SpectraAudioMode; userInteracted: boolean } };
	};
	'AUDIO_GET_VISUALIZER': { req: undefined; res: { buffer: number[] | null } };

	// Capture Mode
	'CAPTURE_TOGGLE': { req: { enabled: boolean; config?: AudioConfig; tabId?: number; generation?: number }; res: { status: 'processing' | 'error'; phase?: AudioSessionPhase; active?: boolean; generation?: number; error?: string } };
	'CAPTURE_GET_STATE': { req: { tabId?: number }; res: boolean };
	'CAPTURE_UPDATE_CONFIG': {
		req: { tabId?: number; config: AudioConfig; generation?: number };
		res: { ok: boolean; generation: number; error?: string };
	};
	'CAPTURE_STATE_CHANGE': { req: { tabId?: number; enabled: boolean; phase?: AudioSessionPhase; generation?: number; error?: string }; res: undefined };

	// Global Settings
	'SETTINGS_UPDATE': { req: { settings: Partial<GlobalSettings> }; res: { success: boolean } };
	'SETTINGS_GET': { req: undefined; res: GlobalSettings };
	'GLOBAL_SETTINGS_UPDATE': { req: { settings: Partial<GlobalSettings> }; res: undefined };

	// Badge/Status
	'BADGE_UPDATE': { req: { tabId?: number; volume: number; muted: boolean; enabled?: boolean; isCapture: boolean; userInteracted?: boolean }; res: undefined };
	'BADGE_CLEAR': { req: { tabId?: number }; res: undefined };

	// UI Sync
	'UI_SYNC': { req: { config: AudioConfig; mode?: AudioMode | SpectraAudioMode; desiredMode?: AudioMode | SpectraAudioMode | null; phase?: AudioSessionPhase; generation?: number; lastError?: string; isCaptureActive?: boolean; isRestricted?: boolean }; res: undefined };

	// Shortcut
	'SHORTCUT_TRIGGER': { req: { command: HotkeyAction; config?: AudioConfig }; res: undefined };

	// Domain Registry
	'REGISTRY_ADD_DOMAIN': { req: { domain: string }; res: { success: boolean; reason?: string } };
	'REGISTRY_REMOVE_DOMAIN': { req: { domain: string }; res: { success: boolean } };
	'REGISTRY_QUERY_DOMAIN': { req: { domain: string }; res: { entry: import('../registry.contracts.js').DomainEntry | null } };
	'REGISTRY_MARK_PROBED': { req: { domain: string; restricted: boolean }; res: { success: boolean; reason?: string } };

	// Media Control
	'MEDIA_TOGGLE_PLAY': { req: undefined; res: { playing: boolean } };
	'MEDIA_TOGGLE_PIP': { req: undefined; res: { active: boolean } };
	'MEDIA_SET_SPEED': { req: { speed?: number; delta?: number; preservePitch?: boolean }; res: { speed: number; preservePitch: boolean } };
	'MEDIA_GET_STATE': { req: undefined; res: { playing: boolean; speed: number; pipActive: boolean; preservePitch: boolean } };

	// Video Transformation
	'VIDEO_ROTATE': { req: undefined; res: { rotation: number } };
	'VIDEO_MIRROR': { req: undefined; res: { mirrored: boolean } };
	'VIDEO_SCREENSHOT': { req: undefined; res: { dataUrl: string | null } };
	'VIDEO_FULLSCREEN': { req: undefined; res: { active: boolean } };
	'VIDEO_CROP': { req: undefined; res: { cropped: boolean } };
	'VIDEO_SEEK': { req: { delta: number }; res: { currentTime: number } };

	// Visual Filters
	'VIDEO_SET_FILTER': { req: { brightness?: number; contrast?: number; saturate?: number; grayscale?: boolean; invert?: boolean }; res: { applied: boolean } };
	'VIDEO_RESET_FILTER': { req: undefined; res: { reset: boolean } };
	'VIDEO_DIM_BACKGROUND': { req: { enabled?: boolean; opacity?: number }; res: { active: boolean; opacity: number } };

	// AB Looping
	'VIDEO_AB_SET_A': { req: undefined; res: { pointA: number | null } };
	'VIDEO_AB_SET_B': { req: undefined; res: { pointB: number | null; looping: boolean } };
	'VIDEO_AB_CLEAR': { req: undefined; res: { cleared: boolean } };
	'VIDEO_AB_GET_STATE': { req: undefined; res: { pointA: number | null; pointB: number | null; looping: boolean } };

	// Markers
	'VIDEO_MARKER_ADD': { req: { label?: string }; res: { id: string; time: number; label: string } };
	'VIDEO_MARKER_REMOVE': { req: { id: string }; res: { removed: boolean } };
	'VIDEO_MARKER_JUMP': { req: { id: string }; res: { jumped: boolean; time: number } };
	'VIDEO_MARKER_LIST': { req: undefined; res: { markers: Array<{ id: string; time: number; label: string }> } };

	// Tab/Global State Reports
	'TAB_REPORT_MEDIA': { req: { hasMediaElement: boolean; userInteracted?: boolean }; res: undefined };
	'TAB_GET_VISIBLE_TABS': { req: undefined; res: { tabs: number[] } };
	/** @deprecated v1 adapter; new callers use spectra.tab.pinned.toggle */
	'TAB_PIN': { req: undefined; res: { pinned: boolean } };
	/** @deprecated v1 adapter; new callers use spectra.tab.muted.toggle */
	'TAB_MUTE': { req: undefined; res: { muted: boolean } };
	/** @deprecated v1 adapter; new callers use spectra.ui.open */
	'OPEN_OPTIONS': { req: undefined; res: { opened: true } };
	/** @deprecated v1 adapter; new callers use spectra.ui.open */
	'OPEN_POPUP': { req: undefined; res: { opened: true } };

	// Remote Control
	'REMOTE_GET_SESSION': { req: { tabId: number }; res: { session: RemotePublicSession | null; connected: boolean; error?: string } };
	'REMOTE_CREATE_SESSION': { req: { tabId: number }; res: { success: boolean; session?: RemotePublicSession; error?: string } };
	'REMOTE_CLOSE_SESSION': { req: { tabId: number; sessionId: string }; res: { success: boolean; error?: string } };

	// Lifecycle
	'INJECT_CONTENT_SCRIPT': { req: { tabId: number }; res: { success: boolean } };

	// User Scripts
	'USER_SCRIPT_EXECUTE': { req: { script: string }; res: { success: boolean; error?: string } };

	// HALO Tools
	'HALO_GET_STATUS': { req: undefined; res: { hostname: string; activeTools: string[] } };
	'HALO_TOOL_ACTIVATE': { req: { toolId: string }; res: { success: boolean; toolId?: string; error?: string } };
	'HALO_TOOL_DEACTIVATE': { req: { toolId: string }; res: { success: boolean } };
	'HALO_RULER_START': { req: undefined; res: { success: boolean } };
	'HALO_RULER_CANCEL': { req: undefined; res: { success: boolean } };
	'HALO_RULER_RESULT': { req: { data: unknown }; res: undefined };
	'HALO_SCROLL_TO_HEADING': { req: { index: number }; res: { success: boolean; error?: string } };
	'HALO_CLIPBOARD_ADD': { req: { text: string; sourceUrl?: string; sourceTitle?: string }; res: undefined };
}

export type NexusAction = keyof NexusMessages;
export type NexusRequest<A extends NexusAction> = NexusMessages[A]['req'];
type NexusNoResponse = ReturnType<() => void>;
export type NexusResponse<A extends NexusAction> = NexusMessages[A]['res'] extends undefined
	? NexusNoResponse
	: NexusMessages[A]['res'];
