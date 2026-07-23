// goal: persist the per-tab fact that SPECTRA has successfully been used

import { createKeyedSerializedQueue } from '@nexus/kernel';

const BADGE_USAGE_PREFIX = 'spectra.badge.used.';
const usageCache = new Map<number, boolean>();
const persistedUsage = new Set<number>();
const serialized = createKeyedSerializedQueue<number>();

function key(tabId: number): string {
	return `${BADGE_USAGE_PREFIX}${tabId}`;
}

export async function hasBadgeUsage(tabId: number): Promise<boolean> {
	return serialized(tabId, async () => {
		const cached = usageCache.get(tabId);
		if (cached !== undefined) return cached;
		try {
			const used = (await chrome.storage.session.get(key(tabId)))[key(tabId)] === true;
			usageCache.set(tabId, used);
			if (used) persistedUsage.add(tabId);
			return used;
		} catch {
			usageCache.set(tabId, false);
			return false;
		}
	});
}

export async function markBadgeUsed(tabId: number): Promise<true> {
	return serialized(tabId, async (): Promise<true> => {
		usageCache.set(tabId, true);
		if (persistedUsage.has(tabId)) return true;
		try {
			await chrome.storage.session.set({ [key(tabId)]: true });
			persistedUsage.add(tabId);
		} catch {
			// Keep the current worker's monotonic usage fact. A later action retries
			// persistence because this tab was not added to persistedUsage.
			return true;
		}
		return true;
	});
}

// Tab closure is the sole lifecycle boundary that retires sticky usage.
export async function clearBadgeUsage(tabId: number): Promise<void> {
	await serialized(tabId, async () => {
		persistedUsage.delete(tabId);
		// A false tombstone prevents an unsuccessful removal from leaking usage if
		// Chrome reuses this tabId during the same worker lifetime.
		usageCache.set(tabId, false);
		try {
			await chrome.storage.session.remove(key(tabId));
			usageCache.delete(tabId);
		} catch {
			return;
		}
	});
}

export function resetBadgeUsageForTests(): void {
	usageCache.clear();
	persistedUsage.clear();
}
