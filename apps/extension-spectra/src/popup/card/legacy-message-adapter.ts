// goal: isolate the one-release v1 popup event adapter from the v2 runtime path

import { Actions, type AudioConfig } from '@nexus/contracts';
import { cleanConfig, type CardInternalState } from './types';

interface LegacyAdapterParams {
	tabId: number;
	state: CardInternalState;
	render: () => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function applyLegacyCardMessage(
	rawMessage: unknown,
	sender: chrome.runtime.MessageSender,
	params: LegacyAdapterParams,
): boolean {
	if (!isRecord(rawMessage)) return false;
	const msg = rawMessage as {
		action?: string;
		payload?: unknown;
		config?: AudioConfig;
	};
	const payload = isRecord(msg.payload) ? msg.payload : {};
	const isFromTargetTab = sender.tab?.id === params.tabId || payload.tabId === params.tabId;

	if (msg.action === Actions.UI_SYNC && isFromTargetTab) {
		const config = isRecord(payload.config) ? payload.config as Partial<AudioConfig> : msg.config;
		if (config) {
			const cleanedConfig = cleanConfig(config);
			if (params.state.draggingField === 'volume') {
				const {
					volume: _volume,
					volumeBase: _volumeBase,
					boost: _boost,
					muted: _muted,
					...otherConfig
				} = cleanedConfig;
				params.state.config = { ...params.state.config, ...otherConfig };
			} else {
				params.state.config = cleanedConfig;
			}
		}
		if (typeof payload.isRestricted === 'boolean') {
			params.state.isRestrictedSite = payload.isRestricted;
		}
		params.render();
		return true;
	}

	return false;
}
