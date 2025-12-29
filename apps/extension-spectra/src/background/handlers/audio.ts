// goal: handles messages for retrieving and updating domain-specific audio configurations

import { router, storage, captureStates } from '../state';
import { swLog } from '../../shared/logger';

// eff: registers listeners for AUDIO_GET_STATUS and AUDIO_SET_CONFIG actions
export function registerAudioHandlers(): void {
	router.on('AUDIO_GET_STATUS', async (_, sender) => {
		const tabId = sender.tab?.id;
		const url = sender.tab?.url || '';

		let domain = '';
		try {
			domain = new URL(url).hostname;
		} catch { }

		const config = await storage.getAudioConfig(domain);
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

	router.on('AUDIO_SET_CONFIG', async (req, sender) => {
		const url = sender.tab?.url || '';
		let domain = '';
		try {
			domain = new URL(url).hostname;
		} catch { }

		if (domain && req.config) {
			// rule: remove transient control fields (toggleMute, volumeDelta) before persisting to storage
			const cleanConfig = { ...req.config };
			delete (cleanConfig as any).toggleMute;
			delete (cleanConfig as any).volumeDelta;

			await storage.setAudioConfig(domain, cleanConfig);
			swLog.debug(`[SW] Saved audio config for ${domain}`);
		}
		return { success: true };
	});
}
