// goal: provides utility functions for migrating, formatting, and parsing domain registry entries within the popup UI

import type { DomainEntry, DomainSource } from '@nexus/contracts';

const SOURCE_LABELS: Record<DomainSource, string> = {
	user: '',
	auto: '',
};

// post: returns a normalized array of DomainEntry objects, ensuring backward compatibility with legacy string-only storage formats
export function migrateRegistry(rawData: unknown): DomainEntry[] {
	if (!rawData) return [];
	if (Array.isArray(rawData) && rawData.length > 0 && typeof rawData[0] === 'object') {
		return rawData as DomainEntry[];
	}
	// rule: convert legacy string[] registries into full DomainEntry objects with 'user' source
	if (Array.isArray(rawData) && rawData.every(d => typeof d === 'string')) {
		return (rawData as string[]).map((domain, i) => ({
			domain, source: 'user' as DomainSource, probed: false, addedAt: Date.now() - i,
		}));
	}
	return [];
}

export function formatEntry(e: DomainEntry): string {
	return `${SOURCE_LABELS[e.source] || ''} ${e.domain}`.trim();
}

// eff: strips UI-only decorators (emojis) and returns a clean DomainEntry object for persistence
export function parseEntry(line: string): DomainEntry {
	const cleaned = line.replace(/^[📋✏️🔍]\s*/, '').trim();
	return { domain: cleaned, source: 'user', probed: false, addedAt: Date.now() };
}
