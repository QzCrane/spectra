// goal: handles messages for retrieving and updating global extension settings

import { router, storage } from '../state';
import { Actions } from '@nexus/contracts';

// eff: registers listeners for SETTINGS_GET and SETTINGS_UPDATE actions
export function registerSettingsHandlers(): void {
	router.on('SETTINGS_GET', async () => {
		return storage.getGlobalSettings();
	});

	router.on('SETTINGS_UPDATE', async (req) => {
		await storage.setGlobalSettings(req.settings);

		// eff: broadcasts the updated settings to all open tabs to ensure cross-tab UI consistency
		const tabs = await chrome.tabs.query({});
		for (const tab of tabs) {
			if (tab.id) {
				chrome.tabs.sendMessage(tab.id, {
					action: Actions.GLOBAL_SETTINGS_UPDATE,
					settings: req.settings
				}).catch(() => { });
			}
		}

		return { success: true };
	});
}

