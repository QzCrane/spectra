// goal: manages global extension settings within the content script context

import type { NexusMessenger } from '@nexus/kernel';
import { Actions } from '@nexus/contracts';
import { safeSend, isExtensionContextValid } from './context-guard';

export interface ContentGlobalSettings {
	osdEnabled: boolean;
	visualizerEnabled: boolean;
	lang: string;
}

export const DEFAULT_CONTENT_SETTINGS: ContentGlobalSettings = {
	osdEnabled: true,
	visualizerEnabled: true,
	lang: 'en-US',
};

// eff: Singleton-like pattern for content script
export function createSettingsManager(messenger: NexusMessenger) {
	let settings: ContentGlobalSettings = { ...DEFAULT_CONTENT_SETTINGS };

	return {
		get: () => settings,
		update: (p: Partial<ContentGlobalSettings>) => { settings = { ...settings, ...p }; },

		load: async () => {
			if (!isExtensionContextValid()) return;
			const loaded = await safeSend(() => messenger.send('SETTINGS_GET'));
			if (loaded) settings = { ...settings, ...loaded };
		},

		handleMessage: (msg: { action?: string; settings?: Partial<ContentGlobalSettings> }) => {
			if (msg.action === Actions.GLOBAL_SETTINGS_UPDATE && msg.settings) {
				settings = { ...settings, ...msg.settings };
				return true;
			}
			return false;
		}
	};
}

export type SettingsManager = ReturnType<typeof createSettingsManager>;
