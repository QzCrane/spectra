// goal: manages global extension settings within the content script context

import { isSpectraEventEnvelope } from '@nexus/contracts';
import type { ContentOSDMessages } from '../../shared/i18n/content-osd';
import { safeSend, isExtensionContextValid } from './context-guard';
import { sendSpectraRequest } from '../../shared/spectra-client';

export interface ContentGlobalSettings {
	osdEnabled: boolean;
	visualizerEnabled: boolean;
	lang: string;
	osdMessages: ContentOSDMessages;
}

export const DEFAULT_CONTENT_SETTINGS: ContentGlobalSettings = {
	osdEnabled: true,
	visualizerEnabled: true,
	lang: 'en-US',
	osdMessages: {
		muted: 'MUTE',
		corsAutoAdded: '🔧 Auto-added {domain} to capture list',
		corsAddedSafe: '✓ Added {domain} to safe list',
		corsCorrectedSafe: '✓ Corrected {domain} to safe',
	},
};

function mergeSettings(
	current: ContentGlobalSettings,
	patch: Partial<ContentGlobalSettings>,
): ContentGlobalSettings {
	const messages = patch.osdMessages;
	const validMessages = messages
		&& (['muted', 'corsAutoAdded', 'corsAddedSafe', 'corsCorrectedSafe'] as const)
			.every((key) => typeof messages[key] === 'string' && messages[key].length > 0);
	return {
		...current,
		...patch,
		osdMessages: validMessages && messages
			? { ...messages }
			: current.osdMessages,
	};
}

// eff: Singleton-like pattern for content script
export function createSettingsManager() {
	let settings: ContentGlobalSettings = { ...DEFAULT_CONTENT_SETTINGS };
	let hasV2Settings = false;

	return {
		get: () => settings,
		acceptsLegacyUpdates: () => !hasV2Settings,
		update: (p: Partial<ContentGlobalSettings>) => { settings = mergeSettings(settings, p); },

		load: async () => {
			if (!isExtensionContextValid()) return;
			const response = await safeSend(() => sendSpectraRequest('spectra.content.settings.get', {}));
			if (response?.ok) {
				hasV2Settings = true;
				settings = mergeSettings(settings, response.data);
			}
		},

		handleMessage: (message: unknown) => {
			if (isSpectraEventEnvelope(message) && message.type === 'spectra.content.settings.changed') {
				hasV2Settings = true;
				settings = mergeSettings(settings, message.payload);
				return true;
			}
			return false;
		}
	};
}

export type SettingsManager = ReturnType<typeof createSettingsManager>;
