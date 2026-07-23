// goal: defines the one-entry-per-site processing-route registry

import { normalizeHostname } from './domain.contracts.js';

export type DomainSource = 'user' | 'auto';
export type MediaRoute = 'direct' | 'capture';

export interface DomainEntry {
	domain: string;
	// `site:*` is the persisted identity. `media:v1:*` remains accepted only so
	// existing installations can collapse legacy per-video records during read.
	fingerprint: string;
	route: MediaRoute;
	source: DomainSource;
	updatedAt: number;
}

// RegistryStorage also accepts legacy arrays during the one-release migration.
export type RegistryStorage = DomainEntry[] | string[];

export interface RegistryResult {
	success: boolean;
	reason?: string;
	entry?: DomainEntry;
}

export interface RegistrySnapshot {
	entries: DomainEntry[];
}

export interface RegistryAddResult extends RegistrySnapshot {
	entry: DomainEntry;
	created: boolean;
}

export interface RegistryRemoveResult extends RegistrySnapshot {
	removed: boolean;
}

export interface RegistryQueryResult {
	entry: DomainEntry | null;
}

export interface HotkeyTargetState {
	tabId: number | null;
}

const DOMAIN_ENTRY_KEYS = new Set(['domain', 'fingerprint', 'route', 'source', 'updatedAt']);
const MEDIA_FINGERPRINT_PATTERN = /^media:v1:[a-f0-9]{16}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
	return Object.keys(value).every((key) => allowed.has(key));
}

export function createSiteRouteFingerprint(domain: string): string | null {
	const normalized = normalizeHostname(domain);
	return normalized ? `site:${normalized}` : null;
}

export function isMediaRouteFingerprint(value: unknown): value is string {
	if (typeof value !== 'string') return false;
	if (MEDIA_FINGERPRINT_PATTERN.test(value)) return true;
	if (!value.startsWith('site:')) return false;
	const domain = value.slice('site:'.length);
	return normalizeHostname(domain) === domain;
}

// post: accepts only normalized, serializable entries safe to cross an extension boundary
export function isDomainEntry(value: unknown): value is DomainEntry {
	if (!isRecord(value) || !hasOnlyKeys(value, DOMAIN_ENTRY_KEYS)) return false;
	return typeof value.domain === 'string'
		&& normalizeHostname(value.domain) === value.domain
		&& isMediaRouteFingerprint(value.fingerprint)
		&& (!value.fingerprint.startsWith('site:')
			|| value.fingerprint === createSiteRouteFingerprint(value.domain))
		&& (value.route === 'direct' || value.route === 'capture')
		&& (value.source === 'user' || value.source === 'auto')
		&& typeof value.updatedAt === 'number'
		&& Number.isSafeInteger(value.updatedAt)
		&& value.updatedAt >= 0;
}

export function isRegistryEntries(value: unknown): value is DomainEntry[] {
	return Array.isArray(value)
		&& value.length <= 10_000
		&& value.every(isDomainEntry)
		&& new Set(value.map((entry) => entry.fingerprint)).size === value.length;
}
