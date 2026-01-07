// goal: handles messages for retrieving and updating audio configurations with session/preset separation
// rule: AUDIO_SET_CONFIG syncs to tab session only; domain presets must be saved explicitly via btnSave

import { Actions } from '@nexus/contracts';
import { router, storage, captureStates } from '../state';
import { swLog } from '../../shared/logger';

// eff: registers listeners for AUDIO_GET_STATUS, AUDIO_SET_CONFIG, and UI_SYNC actions
export function registerAudioHandlers(): void {
	router.on(Actions.AUDIO_GET_STATUS, async (_, sender) => {
		const tabId = sender.tab?.id;
		const url = sender.tab?.url || '';

		let domain = '';
		try {
			domain = new URL(url).hostname;
		} catch { }

		// Priority: tab session config > domain preset > global default
		let config = null;
		if (tabId) {
			try {
				config = await storage.tabSession.get(tabId);
			} catch {
				// note: session storage may not be available, fallback to domain preset
			}
		}
		if (!config) {
			config = await storage.getAudioConfig(domain);
		}

		const isCapture = tabId ? (captureStates.get(tabId) ?? false) : false;

		// post: returns baseline configuration; runtime playback state is refined by the content script
		return {
			config,
			hasAudio: true,
			isPlaying: false,
			mode: isCapture ? 'CAPTURE' : 'NATIVE_WEBAUDIO',
			userInteracted: false
		};
	});

	// eff: syncs config to tab session only (not domain preset)
	router.on(Actions.AUDIO_SET_CONFIG, async (req, sender) => {
		const tabId = sender.tab?.id;
		if (!tabId) return { success: false };

		if (req.config) {
			// rule: remove transient control fields (toggleMute, volumeDelta) before persisting
			const cleanConfig = { ...req.config };
			delete (cleanConfig as any).toggleMute;
			delete (cleanConfig as any).volumeDelta;

			// note: only save to tab session, NOT to domain preset
			try {
				await storage.tabSession.set(tabId, cleanConfig);
			} catch {
				// note: session storage may fail, continue without persistence
			}
		}
		return { success: true };
	});

	// eff: forwards UI_SYNC from Content Script to all extension pages (Popup)
	// rule: this is critical for real-time UI sync when volume changes from native controls, hotkeys, etc.
	router.on(Actions.UI_SYNC, (req, sender) => {
		const tabId = sender.tab?.id;
		if (!tabId) return;

		// note: broadcast to all extension pages (Popup will filter by tabId)
		chrome.runtime.sendMessage({
			action: Actions.UI_SYNC,
			payload: {
				...req,
				tabId, // include tabId so Popup can filter
			}
		}).catch(() => { }); // silent fail if no listeners
	});
}
