// goal: persists one direct/capture route per site, never per video instance
// note: folds legacy media fingerprints into their site behavior record

import type {
	DomainEntry,
	DomainSource,
	MediaRoute,
	RegistryResult,
} from '@nexus/contracts';
import {
	createSiteRouteFingerprint,
	findBestHostnameMatch,
	isDomainEntry,
	isMediaRouteFingerprint,
	normalizeHostname,
} from '@nexus/contracts';
import { createSerializedQueue } from './serialized-queue.js';

const KEY = 'mediaRouteRegistry';
const LEGACY_KEY = 'restrictedRegistry';

interface LegacyDomainEntry {
	domain: string;
	source?: DomainSource;
	probed?: boolean;
	restricted?: boolean;
	addedAt?: number;
}

// rule: one background-owned storage queue prevents concurrent route updates
// from losing an entry while chrome.storage.local is read-modify-written.
const serialized = createSerializedQueue();

function normalizeEntries(entries: readonly DomainEntry[]): DomainEntry[] {
	const normalized = new Map<string, DomainEntry>();
	for (const value of entries) {
		if (!isDomainEntry(value)) continue;
		const domain = normalizeHostname(value.domain);
		const fingerprint = domain ? createSiteRouteFingerprint(domain) : null;
		if (!domain || !fingerprint) continue;
		const entry: DomainEntry = { ...value, domain, fingerprint };
		const previous = normalized.get(domain);
		if (!previous
			|| (entry.source === 'user' && previous.source !== 'user')
			|| (entry.source === previous.source && entry.updatedAt >= previous.updatedAt)) {
			normalized.set(domain, entry);
		}
	}
	return [...normalized.values()].sort((left, right) => left.domain.localeCompare(right.domain));
}

function isLegacyEntry(value: unknown): value is LegacyDomainEntry {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
	const candidate = value as Record<string, unknown>;
	return typeof candidate.domain === 'string'
		&& (candidate.source === undefined || candidate.source === 'user' || candidate.source === 'auto')
		&& (candidate.restricted === undefined || typeof candidate.restricted === 'boolean')
		&& (candidate.addedAt === undefined || Number.isSafeInteger(candidate.addedAt));
}

function looksLikeCurrentEntry(value: unknown): boolean {
	return Boolean(value
		&& typeof value === 'object'
		&& !Array.isArray(value)
		&& ('fingerprint' in value || 'route' in value || 'updatedAt' in value));
}

// eff: converts legacy and v1 media decisions into one site-level route.
// User decisions take precedence; automatic entries collapse by latest evidence.
function migrateOldFormat(rawData: unknown): DomainEntry[] {
	if (!Array.isArray(rawData) || rawData.length === 0) return [];
	if (rawData.every(isDomainEntry)) return normalizeEntries(rawData);
	if (rawData.some(looksLikeCurrentEntry)) return normalizeEntries(rawData.filter(isDomainEntry));

	const now = Date.now();
	const migrated: DomainEntry[] = [];
	for (const [index, raw] of rawData.entries()) {
		const legacy: LegacyDomainEntry | null = typeof raw === 'string'
			? { domain: raw, source: 'user', restricted: true }
			: isLegacyEntry(raw)
				? raw
				: null;
		if (!legacy) continue;
		const domain = normalizeHostname(legacy.domain);
		const fingerprint = domain ? createSiteRouteFingerprint(domain) : null;
		if (!domain || !fingerprint) continue;
		migrated.push({
			domain,
			fingerprint,
			route: legacy.restricted === false ? 'direct' : 'capture',
			source: legacy.source === 'auto' ? 'auto' : 'user',
			updatedAt: typeof legacy.addedAt === 'number' && legacy.addedAt >= 0
				? legacy.addedAt
				: now - index,
		});
	}
	return normalizeEntries(migrated);
}

export async function initRegistry(): Promise<DomainEntry[]> {
	const result = await chrome.storage.local.get([KEY, LEGACY_KEY, 'userRegistry']);
	const rawData = result[KEY] ?? result[LEGACY_KEY] ?? result.userRegistry;
	const entries = migrateOldFormat(rawData);
	// Direct migration: write the new key first, then delete legacy keys so every
	// subsequent read is a single-key lookup. No read-time compat path remains.
	// Sequential await (not Promise.all) prevents data loss if set fails but
	// remove succeeds — legacy keys must survive until the new key is confirmed.
	const stale: string[] = [];
	if (result[LEGACY_KEY] !== undefined) stale.push(LEGACY_KEY);
	if (result.userRegistry !== undefined) stale.push('userRegistry');
	await chrome.storage.local.set({ [KEY]: entries });
	if (stale.length > 0) {
		await chrome.storage.local.remove(stale);
	}
	return entries;
}

export async function getRegistry(): Promise<DomainEntry[]> {
	const result = await chrome.storage.local.get(KEY);
	if (result[KEY] === undefined) return initRegistry();
	const entries = migrateOldFormat(result[KEY]);
	if (!Array.isArray(result[KEY]) || JSON.stringify(entries) !== JSON.stringify(result[KEY])) {
		await chrome.storage.local.set({ [KEY]: entries });
	}
	return entries;
}

export async function isRestricted(domain: string): Promise<boolean> {
	const normalized = normalizeHostname(domain);
	if (!normalized) return false;
	const fallback = createSiteRouteFingerprint(normalized);
	const entry = fallback ? await queryDomain(normalized, fallback) : null;
	return entry?.route === 'capture';
}

export async function queryDomain(domain: string, fingerprint: string): Promise<DomainEntry | null> {
	const normalizedDomain = normalizeHostname(domain);
	if (!normalizedDomain || !isMediaRouteFingerprint(fingerprint)) return null;
	const entries = await getRegistry();
	return findBestHostnameMatch(normalizedDomain, entries, (entry) => entry.domain);
}

async function addOrUpdateDomain(
	normalizedDomain: string,
	source: DomainSource,
	route: MediaRoute,
	options: { force?: boolean } = {},
): Promise<RegistryResult> {
	const fingerprint = createSiteRouteFingerprint(normalizedDomain);
	if (!fingerprint) return { success: false, reason: 'invalid_route_identity' };
	const entries = await getRegistry();
	const existing = entries.find((entry) => entry.fingerprint === fingerprint);
	if (existing) {
		// Automatic observations never overwrite a route pinned by the user.
		// `force` is reserved for the acknowledged-correction path: when
		// Capture is acknowledged active on a user-pinned `direct` route, the
		// pinned route is provably wrong (native CORS failed) and must be
		// corrected so the next document skips the futile native attempt.
		if (source === 'auto' && existing.source === 'user' && !options.force) {
			return { success: true, reason: 'user_override', entry: existing };
		}
		existing.domain = normalizedDomain;
		existing.source = source;
		existing.route = route;
		existing.updatedAt = Date.now();
		await chrome.storage.local.set({ [KEY]: entries });
		return { success: true, reason: 'updated', entry: existing };
	}

	const entry: DomainEntry = {
		domain: normalizedDomain,
		fingerprint,
		route,
		source,
		updatedAt: Date.now(),
	};
	entries.push(entry);
	await chrome.storage.local.set({ [KEY]: entries });
	return { success: true, entry };
}

export async function addDomain(
	domain: string,
	source: DomainSource,
	route: MediaRoute = 'capture',
	_fingerprint?: string,
	options: { force?: boolean } = {},
): Promise<RegistryResult> {
	const normalizedDomain = normalizeHostname(domain);
	if (!normalizedDomain || !createSiteRouteFingerprint(normalizedDomain)) {
		return { success: false, reason: 'invalid_route_identity' };
	}
	return serialized(() => addOrUpdateDomain(normalizedDomain, source, route, options));
}

export async function removeDomain(fingerprint: string): Promise<RegistryResult> {
	if (!isMediaRouteFingerprint(fingerprint)) return { success: false, reason: 'invalid_fingerprint' };
	return serialized(async () => {
		const entries = await getRegistry();
		const filtered = entries.filter((entry) => entry.fingerprint !== fingerprint);
		if (filtered.length === entries.length) return { success: false, reason: 'not_found' };
		await chrome.storage.local.set({ [KEY]: filtered });
		return { success: true };
	});
}

export async function markProbed(
	domain: string,
	fingerprint: string,
	route: MediaRoute,
	options: { force?: boolean } = {},
): Promise<RegistryResult> {
	if (!isMediaRouteFingerprint(fingerprint)) return { success: false, reason: 'invalid_fingerprint' };
	return addDomain(domain, 'auto', route, fingerprint, options);
}

// @deprecated: retained for one release while old consumers move to fingerprints.
export async function getDomainList(): Promise<string[]> {
	return [...new Set((await getRegistry()).map((entry) => entry.domain))];
}

// eff: legacy bulk values become user-pinned, on-demand Capture site fallbacks.
export async function setRegistry(domains: string[]): Promise<void> {
	const now = Date.now();
	const entries: DomainEntry[] = [];
	const seen = new Set<string>();
	for (const [index, value] of domains.entries()) {
		const domain = normalizeHostname(value);
		const fingerprint = domain ? createSiteRouteFingerprint(domain) : null;
		if (!domain || !fingerprint || seen.has(fingerprint)) continue;
		seen.add(fingerprint);
		entries.push({
			domain,
			fingerprint,
			route: 'capture',
			source: 'user',
			updatedAt: now - index,
		});
	}
	await chrome.storage.local.set({ [KEY]: entries });
}
