// goal: provides a centralized registry to store and retrieve tab-specific audio configurations and their respective update handlers

import type { AudioConfig } from '@nexus/kernel';

export interface CardRegistration {
	config: AudioConfig;
	update: (changes: Partial<AudioConfig>) => void;
	getConfig: () => AudioConfig;
}

const cardRegistry = new Map<number, CardRegistration>();

// eff: registers a tab's current state and its update function, enabling settings in the side panel to trigger re-renders in the main card
export function registerCard(
	tabId: number,
	config: AudioConfig,
	update: (changes: Partial<AudioConfig>) => void,
	getConfig: () => AudioConfig
): void {
	cardRegistry.set(tabId, { config, update, getConfig });
}

export function getCardRegistration(tabId: number): CardRegistration | undefined {
	return cardRegistry.get(tabId);
}

export function updateCardConfig(tabId: number, config: AudioConfig): void {
	const reg = cardRegistry.get(tabId);
	if (reg) {
		reg.config = config;
	}
}

export function getRegisteredConfig(tabId: number): AudioConfig | undefined {
	return cardRegistry.get(tabId)?.config;
}
