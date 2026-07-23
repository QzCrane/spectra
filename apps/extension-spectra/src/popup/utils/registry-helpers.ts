// goal: provides utility functions for migrating, formatting, and parsing domain registry entries within the popup UI

import {
	createSiteRouteFingerprint,
	isDomainEntry,
	type DomainEntry,
	type DomainSource,
} from '@nexus/contracts';

const SOURCE_LABELS: Record<DomainSource, string> = {
	user: '',
	auto: '',
};

// post: returns a normalized array of DomainEntry objects, ensuring backward compatibility with legacy string-only storage formats
export function migrateRegistry(rawData: unknown): DomainEntry[] {
	if (!rawData) return [];
	if (Array.isArray(rawData) && rawData.every(isDomainEntry)) {
		return rawData;
	}
	// rule: convert legacy string[] registries into full DomainEntry objects with 'user' source
	if (Array.isArray(rawData) && rawData.every(d => typeof d === 'string')) {
		return (rawData as string[]).flatMap((domain, index) => {
			const fingerprint = createSiteRouteFingerprint(domain);
			return fingerprint ? [{
				domain: fingerprint.slice('site:'.length),
				fingerprint,
				route: 'capture' as const,
				source: 'user' as DomainSource,
				updatedAt: Date.now() - index,
			}] : [];
		});
	}
	return [];
}

export function formatEntry(e: DomainEntry): string {
	return `${SOURCE_LABELS[e.source] || ''} ${e.domain}`.trim();
}

// eff: strips UI-only decorators (emojis) and returns a clean DomainEntry object for persistence
export function parseEntry(line: string): DomainEntry {
	const cleaned = line.replace(/^[📋✏️🔍]\s*/, '').trim();
	const fingerprint = createSiteRouteFingerprint(cleaned);
	if (!fingerprint) throw new Error('Invalid registry domain');
	return {
		domain: fingerprint.slice('site:'.length),
		fingerprint,
		route: 'capture',
		source: 'user',
		updatedAt: Date.now(),
	};
}
