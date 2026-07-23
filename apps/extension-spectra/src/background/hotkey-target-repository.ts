// goal: owns the session-scoped global hotkey target and removes stale tab identities

import type { HotkeyTargetState } from '@nexus/contracts';
import { createSerializedQueue } from '@nexus/kernel';

const HOTKEY_TARGET_KEY = 'hotkeyTargetTabId';

export interface HotkeyTargetStoragePort {
	get(): Promise<unknown>;
	set(tabId: number): Promise<void>;
	remove(): Promise<void>;
}

export interface HotkeyTargetTabsPort {
	get(tabId: number): Promise<unknown>;
}

function isPositiveInteger(value: unknown): value is number {
	return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

export class HotkeyTargetRepository {
	private serialized = createSerializedQueue();

	constructor(
		private readonly targetStorage: HotkeyTargetStoragePort,
		private readonly tabs: HotkeyTargetTabsPort,
	) {}

	get(): Promise<HotkeyTargetState> {
		return this.serialized(async () => {
			const stored = await this.targetStorage.get();
			if (!isPositiveInteger(stored)) {
				if (stored !== undefined && stored !== null) await this.targetStorage.remove();
				return { tabId: null };
			}
			try {
				await this.tabs.get(stored);
				return { tabId: stored };
			} catch {
				await this.targetStorage.remove();
				return { tabId: null };
			}
		});
	}

	set(tabId: number | null): Promise<HotkeyTargetState> {
		return this.serialized(async () => {
			if (tabId === null) {
				await this.targetStorage.remove();
				return { tabId: null };
			}
			if (!isPositiveInteger(tabId)) throw new Error('Hotkey target tabId must be a positive integer');
			await this.tabs.get(tabId);
			await this.targetStorage.set(tabId);
			return { tabId };
		});
	}

	clearIfMatches(tabId: number): Promise<void> {
		return this.serialized(async () => {
			const stored = await this.targetStorage.get();
			if (stored === tabId) await this.targetStorage.remove();
		});
	}
}

const sessionStorage: HotkeyTargetStoragePort = {
	async get() {
		const result = await chrome.storage.session.get(HOTKEY_TARGET_KEY);
		return result[HOTKEY_TARGET_KEY];
	},
	async set(tabId) {
		await chrome.storage.session.set({ [HOTKEY_TARGET_KEY]: tabId });
	},
	async remove() {
		await chrome.storage.session.remove(HOTKEY_TARGET_KEY);
	},
};

export const hotkeyTargetRepository = new HotkeyTargetRepository(sessionStorage, {
	get: (tabId) => chrome.tabs.get(tabId),
});
