// goal: routes global hotkey actions to their respective functional handlers (media, video, audio, etc.)

import type { HotkeyAction, HotkeyParams } from '@nexus/contracts';
import { createLogger } from '../../shared/logger';
import { togglePlay, togglePip, setSpeed, adjustSpeed, seekVideo } from '../logic/media-control';
import { rotateVideo, toggleMirror, takeScreenshot, toggleFullscreen } from '../video/video-transform';
import { resetVideoFilter, toggleDimBackground } from '../video/video-filter';
import { addMarker } from '../video/time-marker';
import { setPointA, setPointB, clearABLoop } from '../video/ab-loop';
import { showToast } from '../ui/toast';
import {
	sendVolumeAction,
	sendAudioReset,
	sendCaptureToggle,
	jumpMarker,
	toggleLoop,
	sendTabAction,
} from './hotkey-helpers';

export { setConfigGetter, setConfigUpdater } from './hotkey-helpers';

const log = createLogger('HotkeyActions');

// eff: executes the requested action by delegating to specialized module handlers
export function executeHotkeyAction(action: HotkeyAction, params?: HotkeyParams): void {
	log.debug(`Executing action: ${action}`, params);

	switch (action) {
		case 'play_pause': togglePlay(); break;
		case 'seek_forward_5s': seekVideo(5); break;
		case 'seek_forward_10s': seekVideo(10); break;
		case 'seek_forward_30s': seekVideo(30); break;
		case 'seek_backward_5s': seekVideo(-5); break;
		case 'seek_backward_10s': seekVideo(-10); break;
		case 'seek_backward_30s': seekVideo(-30); break;
		case 'seek_frame_forward': seekVideo(1 / 30); break;
		case 'seek_frame_backward': seekVideo(-1 / 30); break;

		case 'speed_up': adjustSpeed(params?.step ?? 0.1); break;
		case 'speed_down': adjustSpeed(-(params?.step ?? 0.1)); break;
		case 'speed_reset': setSpeed(1); break;
		case 'speed_set': if (params?.speed) setSpeed(params.speed); break;

		case 'volume_up':
		case 'volume_down':
		case 'volume_mute':
		case 'volume_set':
			sendVolumeAction(action, params);
			break;

		case 'audio_reset': sendAudioReset(); break;
		case 'capture_toggle': sendCaptureToggle(); break;

		case 'fullscreen_toggle': toggleFullscreen(); break;
		case 'pip_toggle': togglePip(); break;
		case 'rotate_cw':
		case 'rotate_ccw': rotateVideo(); break;
		case 'mirror_toggle': toggleMirror(); break;
		case 'screenshot': takeScreenshot(); break;
		case 'dim_background': toggleDimBackground(); break;

		case 'marker_add': addMarker(); showToast('Marker added'); break;
		case 'marker_jump_prev': jumpMarker(false); break;
		case 'marker_jump_next': jumpMarker(true); break;
		case 'ab_set_a': setPointA(); showToast('Point A set'); break;
		case 'ab_set_b': setPointB(); showToast('Point B set'); break;
		case 'ab_clear': clearABLoop(); showToast('AB loop cleared'); break;
		case 'loop_toggle': toggleLoop(); break;

		case 'fx_reset': resetVideoFilter(); break;

		case 'tab_pin':
		case 'tab_mute': sendTabAction(action); break;

		case 'open_options':
			chrome.runtime.sendMessage({ action: 'OPEN_OPTIONS' });
			break;
		case 'run_js':
			if (params?.script) {
				// note: delegate to background for secure userScripts API execution
				(async () => {
					try {
						const response = await chrome.runtime.sendMessage({
							action: 'USER_SCRIPT_EXECUTE',
							payload: { script: params.script }
						}) as { success: boolean; error?: string } | undefined;
						if (response && !response.success) {
							log.warn('User script execution failed:', response.error);
							showToast(response.error || 'Script execution failed');
						}
					} catch (e) {
						log.error('User script message failed:', e);
					}
				})();
			}
			break;
		case 'open_url':
			if (params?.url) window.open(params.url, '_blank');
			break;
		case 'open_popup':
		case 'none':
		default:
			break;
	}
}
