// goal: manages global extension settings within the content script context and ensures synchronization with the background worker

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

// post: returns a settings manager instance with load and message handling capabilities
export function createSettingsManager(messenger: NexusMessenger) {
	let settings: ContentGlobalSettings = { ...DEFAULT_CONTENT_SETTINGS };

	return {
		get(): ContentGlobalSettings {
			return settings;
		},

		update(partial: Partial<ContentGlobalSettings>): void {
			settings = { ...settings, ...partial };
		},

		// eff: fetches initial settings from the background; assumes default if context is invalidated
		async load(): Promise<void> {
			if (!isExtensionContextValid()) return;

			const loaded = await safeSend(() => messenger.send('SETTINGS_GET'));
			if (loaded) {
				settings = { ...settings, ...loaded };
			}
		},

		// goal: intercepts GLOBAL_SETTINGS_UPDATE broadcasts to update the local cache in real-time
		handleMessage(message: { action?: string; settings?: Partial<ContentGlobalSettings> }): boolean {
			if (message.action === Actions.GLOBAL_SETTINGS_UPDATE) {
				if (message.settings) {
					settings = { ...settings, ...message.settings };
				}
				return true;
			}
			return false;
		},
	};
}

export type SettingsManager = ReturnType<typeof createSettingsManager>;
