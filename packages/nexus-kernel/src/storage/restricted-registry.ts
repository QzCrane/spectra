// goal: manages persistence for the restricted domain registry driven by CORS detection
// note: supports data migration from legacy string arrays to structured DomainEntry objects

import type { DomainEntry, DomainSource, RegistryResult } from '@nexus/contracts';

const KEY = 'restrictedRegistry';

// eff: migrates legacy string[] format to DomainEntry[]
function migrateOldFormat(rawData: unknown): DomainEntry[] {
	if (!Array.isArray(rawData) || !rawData.length) return [];
	if (typeof rawData[0] === 'object') return rawData as DomainEntry[];

	// eff: legacy string array conversion with O(n) scan
	if (typeof rawData[0] === 'string') {
		const now = Date.now();
		return (rawData as string[]).map((domain, i) => ({
			domain, source: 'user' as DomainSource, probed: false, addedAt: now - i,
		}));
	}
	return [];
}

// post: ensures registry is initialized in local storage
export async function initRegistry(): Promise<DomainEntry[]> {
	const result = await chrome.storage.local.get([KEY, 'userRegistry']);
	const rawData = result[KEY] || result['userRegistry'];

	if (rawData) {
		const entries = migrateOldFormat(rawData);
		await chrome.storage.local.set({ [KEY]: entries });
		return entries;
	}

	await chrome.storage.local.set({ [KEY]: [] });
	return [];
}

export async function getRegistry(): Promise<DomainEntry[]> {
	const result = await chrome.storage.local.get(KEY);
	return result[KEY] ? migrateOldFormat(result[KEY]) : initRegistry();
}

export async function isRestricted(domain: string): Promise<boolean> {
	const entries = await getRegistry();
	return entries.some(e => domain.includes(e.domain) || e.domain.includes(domain));
}

// eff: returns domain entry if found, otherwise null
export async function queryDomain(domain: string): Promise<DomainEntry | null> {
	const entries = await getRegistry();
	return entries.find(e => e.domain === domain || domain.includes(e.domain)) ?? null;
}

export async function addDomain(
	domain: string, source: DomainSource, restricted: boolean = true
): Promise<RegistryResult> {
	const entries = await getRegistry();
	const existing = entries.find(e => e.domain === domain || domain.includes(e.domain));

	if (existing) {
		existing.probed = true;
		existing.restricted = restricted;
		await chrome.storage.local.set({ [KEY]: entries });
		return { success: true, reason: 'updated', entry: existing };
	}

	const entry: DomainEntry = {
		domain, source, probed: true, restricted, addedAt: Date.now(),
	};
	entries.push(entry);
	await chrome.storage.local.set({ [KEY]: entries });
	return { success: true, entry };
}

export async function removeDomain(domain: string): Promise<RegistryResult> {
	const entries = await getRegistry();
	const filtered = entries.filter(e => e.domain !== domain);
	if (filtered.length === entries.length) return { success: false, reason: 'not_found' };
	await chrome.storage.local.set({ [KEY]: filtered });
	return { success: true };
}

// eff: record probing results; v3.7 caches both restricted and safe sites
export async function markProbed(domain: string, restricted: boolean): Promise<RegistryResult> {
	const entries = await getRegistry();
	const existing = entries.find(e => domain.includes(e.domain));

	if (existing) {
		existing.probed = true;
		existing.restricted = restricted;
		await chrome.storage.local.set({ [KEY]: entries });
		return { success: true, reason: 'updated', entry: existing };
	}

	return addDomain(domain, 'auto', restricted);
}

// @deprecated: use getRegistry() for full entry data
export async function getDomainList(): Promise<string[]> {
	return (await getRegistry()).map(e => e.domain);
}

// eff: manual override for registry list, usually triggered by user input
export async function setRegistry(domains: string[]): Promise<void> {
	const now = Date.now();
	const entries: DomainEntry[] = domains.map((domain, i) => ({
		domain, source: 'user' as DomainSource, probed: false, addedAt: now - i,
	}));
	await chrome.storage.local.set({ [KEY]: entries });
}
