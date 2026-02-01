// goal: execute and synchronize remote control commands
import { Actions } from '@nexus/contracts';

export type RemoteCommand =
	| 'volume_up' | 'volume_down' | 'volume_max' | 'volume_100' | 'mute'
	| 'play_pause' | 'seek_forward' | 'seek_backward' | 'seek_forward_30' | 'seek_backward_30'
	| 'speed_up' | 'speed_down' | 'speed_reset' | 'fullscreen' | 'pip';

type StateCallback = (tabId: number, state: RemoteState) => void;

export interface RemoteState {
	volume: number; muted: boolean; playing: boolean; speed: number;
	tabTitle?: string; tabDomain?: string; tabFavIcon?: string;
}

let cb: StateCallback | null = null;
const favCache = new Map<string, string>();

export function setStateCallback(fn: StateCallback | null): void { cb = fn; }

// eff: reuse msg objects where possible? difficult with dynamic args. Optimizing dispatch.
export async function executeCommand(cmd: RemoteCommand, tid: number): Promise<void> {
	/* eslint-disable @typescript-eslint/no-unused-vars */
	switch (cmd) {
		case 'volume_up': await send(tid, Actions.AUDIO_SET_CONFIG, { config: { volumeDelta: 10, muted: false } }); break;
		case 'volume_down': await send(tid, Actions.AUDIO_SET_CONFIG, { config: { volumeDelta: -10, muted: false } }); break;
		case 'volume_max': await send(tid, Actions.AUDIO_SET_CONFIG, { config: { volume: 800, muted: false } }); break;
		case 'volume_100': await send(tid, Actions.AUDIO_SET_CONFIG, { config: { volume: 100, muted: false } }); break;
		case 'mute': await send(tid, Actions.AUDIO_SET_CONFIG, { config: { toggleMute: true } }); break;
		case 'play_pause': await send(tid, Actions.MEDIA_TOGGLE_PLAY); break;
		case 'seek_forward': await send(tid, Actions.VIDEO_SEEK, { delta: 10 }); break;
		case 'seek_backward': await send(tid, Actions.VIDEO_SEEK, { delta: -10 }); break;
		case 'seek_forward_30': await send(tid, Actions.VIDEO_SEEK, { delta: 30 }); break;
		case 'seek_backward_30': await send(tid, Actions.VIDEO_SEEK, { delta: -30 }); break;
		case 'speed_up': await send(tid, Actions.MEDIA_SET_SPEED, { delta: 0.25 }); break;
		case 'speed_down': await send(tid, Actions.MEDIA_SET_SPEED, { delta: -0.25 }); break;
		case 'speed_reset': await send(tid, Actions.MEDIA_SET_SPEED, { speed: 1 }); break;
		case 'fullscreen': await send(tid, Actions.VIDEO_FULLSCREEN); break;
		case 'pip': await send(tid, Actions.MEDIA_TOGGLE_PIP); break;
	}
	await syncState(tid);
}

// eff: aggregated state sync with caching
export async function syncState(tid: number): Promise<void> {
	if (!cb) return;
	try {
		const [aRes, mRes, tab] = await Promise.all([
			send(tid, Actions.AUDIO_GET_STATUS) as Promise<{ config?: { volume?: number; muted?: boolean }; isPlaying?: boolean } | undefined>,
			send(tid, Actions.MEDIA_GET_STATE) as Promise<{ playing?: boolean; speed?: number } | undefined>,
			chrome.tabs.get(tid).catch(() => undefined)
		]);

		let dom = '', fav = '';
		if (tab?.url) {
			try { dom = new URL(tab.url).hostname; } catch { }
			if (tab.favIconUrl) fav = await getFav(tab.favIconUrl);
		}

		cb(tid, {
			volume: aRes?.config?.volume ?? 100,
			muted: aRes?.config?.muted ?? false,
			playing: mRes?.playing ?? aRes?.isPlaying ?? false,
			speed: mRes?.speed ?? 1,
			tabTitle: tab?.title || '',
			tabDomain: dom,
			tabFavIcon: fav,
		});
	} catch { }
}

function send(tid: number, act: string, pl?: unknown) {
	return chrome.tabs.sendMessage(tid, pl ? { action: act, payload: pl } : { action: act });
}

async function getFav(url: string): Promise<string> {
	if (!url || url.length < 5) return '';
	if (url.startsWith('data:')) return url;
	const c = favCache.get(url);
	if (c) return c;

	try {
		const r = await fetch(url);
		const b = await r.blob();
		return new Promise(res => {
			const rd = new FileReader();
			rd.onloadend = () => {
				const d = rd.result as string;
				favCache.set(url, d);
				if (favCache.size > 100) {
					const k = favCache.keys().next().value;
					if (k) favCache.delete(k);
				}
				res(d);
			};
			rd.onerror = () => res('');
			rd.readAsDataURL(b);
		});
	} catch { return ''; }
}
