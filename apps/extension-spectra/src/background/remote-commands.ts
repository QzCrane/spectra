// goal: execute and synchronize remote control commands (volume, playback, seek) via RPC

import { Actions } from '@nexus/contracts';

export type RemoteCommand =
	| 'volume_up' | 'volume_down' | 'volume_max' | 'volume_100' | 'mute'
	| 'play_pause' | 'seek_forward' | 'seek_backward' | 'seek_forward_30' | 'seek_backward_30'
	| 'speed_up' | 'speed_down' | 'speed_reset' | 'fullscreen' | 'pip';

type StateCallback = (tabId: number, state: RemoteState) => void;

export interface RemoteState {
	volume: number;
	muted: boolean;
	playing: boolean;
	speed: number;
	tabTitle?: string;
	tabDomain?: string;
	tabFavIcon?: string;
}

let stateCallback: StateCallback | null = null;

export function setStateCallback(cb: StateCallback | null): void {
	stateCallback = cb;
}

// eff: executes the requested command on the target tab and triggers a state sync
export async function executeCommand(cmd: RemoteCommand, tabId: number): Promise<void> {
	let response: unknown;

	switch (cmd) {
		case 'volume_up':
			response = await sendToTab(tabId, { action: Actions.AUDIO_SET_CONFIG, payload: { config: { volumeDelta: 10, muted: false } } });
			break;
		case 'volume_down':
			response = await sendToTab(tabId, { action: Actions.AUDIO_SET_CONFIG, payload: { config: { volumeDelta: -10, muted: false } } });
			break;
		case 'volume_max':
			response = await sendToTab(tabId, { action: Actions.AUDIO_SET_CONFIG, payload: { config: { volume: 800, muted: false } } });
			break;
		case 'volume_100':
			response = await sendToTab(tabId, { action: Actions.AUDIO_SET_CONFIG, payload: { config: { volume: 100, muted: false } } });
			break;
		case 'mute':
			response = await sendToTab(tabId, { action: Actions.AUDIO_SET_CONFIG, payload: { config: { toggleMute: true } } });
			break;

		case 'play_pause':
			await sendToTab(tabId, { action: Actions.MEDIA_TOGGLE_PLAY });
			break;

		case 'seek_forward':
			await sendToTab(tabId, { action: Actions.VIDEO_SEEK, payload: { delta: 10 } });
			break;
		case 'seek_backward':
			await sendToTab(tabId, { action: Actions.VIDEO_SEEK, payload: { delta: -10 } });
			break;
		case 'seek_forward_30':
			await sendToTab(tabId, { action: Actions.VIDEO_SEEK, payload: { delta: 30 } });
			break;
		case 'seek_backward_30':
			await sendToTab(tabId, { action: Actions.VIDEO_SEEK, payload: { delta: -30 } });
			break;

		case 'speed_up':
			await sendToTab(tabId, { action: Actions.MEDIA_SET_SPEED, payload: { delta: 0.25 } });
			break;
		case 'speed_down':
			await sendToTab(tabId, { action: Actions.MEDIA_SET_SPEED, payload: { delta: -0.25 } });
			break;
		case 'speed_reset':
			await sendToTab(tabId, { action: Actions.MEDIA_SET_SPEED, payload: { speed: 1 } });
			break;

		case 'fullscreen':
			await sendToTab(tabId, { action: Actions.VIDEO_FULLSCREEN });
			break;
		case 'pip':
			await sendToTab(tabId, { action: Actions.MEDIA_TOGGLE_PIP });
			break;
	}

	await syncState(tabId);
}

// goal: aggregates audio, media, and tab metadata to broadcast an updated RemoteState
export async function syncState(tabId: number): Promise<void> {
	if (!stateCallback) return;

	try {
		const audioRes = await sendToTab(tabId, { action: Actions.AUDIO_GET_STATUS }) as { config?: { volume?: number; muted?: boolean }; isPlaying?: boolean } | undefined;
		const mediaRes = await sendToTab(tabId, { action: Actions.MEDIA_GET_STATE }) as { playing?: boolean; speed?: number } | undefined;

		let tabTitle = '';
		let tabDomain = '';
		let tabFavIcon = '';
		try {
			const tab = await chrome.tabs.get(tabId);
			tabTitle = tab.title || '';
			tabDomain = tab.url ? new URL(tab.url).hostname : '';
			tabFavIcon = await fetchFaviconAsDataUrl(tab.favIconUrl || '');
		} catch { }

		const state: RemoteState = {
			volume: audioRes?.config?.volume ?? 100,
			muted: audioRes?.config?.muted ?? false,
			playing: mediaRes?.playing ?? audioRes?.isPlaying ?? false,
			speed: mediaRes?.speed ?? 1,
			tabTitle,
			tabDomain,
			tabFavIcon,
		};

		stateCallback(tabId, state);
	} catch (e) { }
}

function sendToTab(tabId: number, message: object): Promise<unknown> {
	return new Promise((resolve) => {
		chrome.tabs.sendMessage(tabId, message, {}, (response: unknown) => {
			resolve(response);
		});
	});
}

// eff: fetches favicon from URL and converts it to a Data URL (Base64) for cross-origin remote UI display
async function fetchFaviconAsDataUrl(url: string): Promise<string> {
	if (!url) return '';
	if (url.startsWith('data:')) return url;

	try {
		const response = await fetch(url);
		const blob = await response.blob();

		return new Promise((resolve) => {
			const reader = new FileReader();
			reader.onloadend = () => resolve(reader.result as string);
			reader.onerror = () => resolve('');
			reader.readAsDataURL(blob);
		});
	} catch (err) {
		return '';
	}
}
