// goal: routes media and video-related messages from the background script to specialized content handlers

import { Actions } from '@nexus/contracts';
import { togglePlay, togglePip, getMediaState, seekVideo } from './media-control';
import { rotateVideo, toggleMirror, takeScreenshot, toggleFullscreen, toggleCrop } from '../video/video-transform';
import { setVideoFilter, resetVideoFilter, toggleDimBackground } from '../video/video-filter';
import { setPointA, setPointB, clearABLoop, getABState } from '../video/ab-loop';
import { addMarker, removeMarker, jumpToMarker, listMarkers } from '../video/time-marker';

type MsgPayload = { delta?: number; brightness?: number; contrast?: number; saturate?: number; grayscale?: boolean; invert?: boolean } | undefined;

// eff: executes media/video actions based on the provided Action type and dispatches results via sendResponse
// post: returns true if the action was recognized and handled within this module
export function handleMediaMessage(
	action: string,
	payload: unknown,
	sendResponse: (response?: unknown) => void
): boolean {
	const p = payload as MsgPayload;

	switch (action) {
		case Actions.MEDIA_TOGGLE_PLAY: {
			const playing = togglePlay();
			sendResponse({ playing });
			return true;
		}

		case Actions.MEDIA_TOGGLE_PIP: {
			togglePip().then(active => sendResponse({ active }));
			return true;
		}

		// note: MEDIA_SET_SPEED is handled in message-handler.ts via unified config flow

		case Actions.MEDIA_GET_STATE: {
			sendResponse(getMediaState());
			return true;
		}

		case Actions.VIDEO_ROTATE: {
			const rotation = rotateVideo();
			sendResponse({ rotation });
			return true;
		}

		case Actions.VIDEO_MIRROR: {
			const mirrored = toggleMirror();
			sendResponse({ mirrored });
			return true;
		}

		case Actions.VIDEO_SCREENSHOT: {
			const dataUrl = takeScreenshot();
			sendResponse({ dataUrl });
			return true;
		}

		case Actions.VIDEO_FULLSCREEN: {
			toggleFullscreen().then(active => sendResponse({ active }));
			return true;
		}

		case Actions.VIDEO_CROP: {
			const cropped = toggleCrop();
			sendResponse({ cropped });
			return true;
		}

		case Actions.VIDEO_SEEK: {
			const currentTime = seekVideo(p?.delta ?? 0);
			sendResponse({ currentTime });
			return true;
		}

		case Actions.VIDEO_SET_FILTER: {
			const applied = setVideoFilter(p ?? {});
			sendResponse({ applied });
			return true;
		}

		case Actions.VIDEO_RESET_FILTER: {
			const reset = resetVideoFilter();
			sendResponse({ reset });
			return true;
		}

		case Actions.VIDEO_DIM_BACKGROUND: {
			const dp = payload as { enabled?: boolean; opacity?: number } | undefined;
			const result = toggleDimBackground(dp);
			sendResponse(result);
			return true;
		}

		case Actions.VIDEO_AB_SET_A: {
			const pointA = setPointA();
			sendResponse({ pointA });
			return true;
		}

		case Actions.VIDEO_AB_SET_B: {
			const result = setPointB();
			sendResponse(result);
			return true;
		}

		case Actions.VIDEO_AB_CLEAR: {
			const cleared = clearABLoop();
			sendResponse({ cleared });
			return true;
		}

		case Actions.VIDEO_AB_GET_STATE: {
			sendResponse(getABState());
			return true;
		}

		case Actions.VIDEO_MARKER_ADD: {
			const mp = payload as { label?: string } | undefined;
			const marker = addMarker(mp?.label);
			if (marker) sendResponse(marker);
			else sendResponse({ id: '', time: 0, label: '' });
			return true;
		}

		case Actions.VIDEO_MARKER_REMOVE: {
			const mp = payload as { id: string } | undefined;
			const removed = removeMarker(mp?.id ?? '');
			sendResponse({ removed });
			return true;
		}

		case Actions.VIDEO_MARKER_JUMP: {
			const mp = payload as { id: string } | undefined;
			const result = jumpToMarker(mp?.id ?? '');
			sendResponse(result);
			return true;
		}

		case Actions.VIDEO_MARKER_LIST: {
			sendResponse({ markers: listMarkers() });
			return true;
		}

		default:
			return false;
	}
}
