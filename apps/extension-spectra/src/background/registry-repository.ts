// goal: provides one serialized owner for site-level route records and migration

import {
	createSiteRouteFingerprint,
	isMediaRouteFingerprint,
	normalizeHostname,
	type DomainEntry,
	type DomainSource,
	type MediaRoute,
	type RegistryAddResult,
	type RegistryQueryResult,
	type RegistryRemoveResult,
	type RegistryResult,
	type RegistrySnapshot,
} from '@nexus/contracts';
import { createSerializedQueue } from '@nexus/kernel';
import { storage } from './state';

export interface RegistryStoragePort {
	get(): Promise<DomainEntry[]>;
	query(domain: string, fingerprint: string): Promise<DomainEntry | null>;
	add(
		domain: string,
		source: DomainSource,
		route?: MediaRoute,
		fingerprint?: string,
		options?: { force?: boolean },
	): Promise<RegistryResult>;
	remove(fingerprint: string): Promise<RegistryResult>;
	markProbed(
		domain: string,
		fingerprint: string,
		route: MediaRoute,
		options?: { force?: boolean },
	): Promise<RegistryResult>;
}

function normalizeEntry(value: DomainEntry): DomainEntry | null {
	const domain = normalizeHostname(value.domain);
	if (!domain
		|| (value.source !== 'user' && value.source !== 'auto')
		|| (value.route !== 'direct' && value.route !== 'capture')
		|| !isMediaRouteFingerprint(value.fingerprint)
		|| (value.fingerprint.startsWith('site:')
			&& value.fingerprint !== createSiteRouteFingerprint(domain))
		|| !Number.isSafeInteger(value.updatedAt)
		|| value.updatedAt < 0) {
		return null;
	}
	const entry: DomainEntry = {
		domain,
		fingerprint: value.fingerprint,
		route: value.route,
		source: value.source,
		updatedAt: value.updatedAt,
	};
	return entry;
}

// post: folds legacy media-instance routes into one stable site route per hostname.
// User entries outrank automatic observations; otherwise latest evidence wins.
export function normalizeRegistryEntries(entries: readonly DomainEntry[]): DomainEntry[] {
	const normalized = new Map<string, DomainEntry>();
	for (const value of entries) {
		const entry = normalizeEntry(value);
		if (!entry) continue;
		const fingerprint = createSiteRouteFingerprint(entry.domain);
		if (!fingerprint) continue;
		const siteEntry: DomainEntry = { ...entry, fingerprint };
		const previous = normalized.get(siteEntry.domain);
		if (!previous
			|| (siteEntry.source === 'user' && previous.source !== 'user')
			|| (siteEntry.source === previous.source && siteEntry.updatedAt >= previous.updatedAt)) {
			normalized.set(siteEntry.domain, siteEntry);
		}
	}
	return [...normalized.values()].sort((left, right) => left.domain.localeCompare(right.domain));
}

export class RegistryRepository {
	private serialized = createSerializedQueue();

	constructor(private readonly registry: RegistryStoragePort) {}

	private async readSnapshot(): Promise<RegistrySnapshot> {
		return { entries: normalizeRegistryEntries(await this.registry.get()) };
	}

	getSnapshot(): Promise<RegistrySnapshot> {
		return this.serialized(() => this.readSnapshot());
	}

	add(
		domain: string,
		source: DomainSource,
		route: MediaRoute,
		options: { force?: boolean } = {},
	): Promise<RegistryAddResult> {
		return this.serialized(async () => {
			const normalizedDomain = normalizeHostname(domain);
			if (!normalizedDomain) throw new Error('Invalid registry domain');
			const before = normalizeRegistryEntries(await this.registry.get());
			const result = await this.registry.add(normalizedDomain, source, route, undefined, options);
			if (!result.success) throw new Error(`Registry add failed: ${result.reason ?? 'unknown'}`);
			const snapshot = await this.readSnapshot();
			const entry = result.entry
				? snapshot.entries.find((candidate) => candidate.fingerprint === result.entry?.fingerprint)
				: undefined;
			if (!entry) throw new Error('Registry add did not persist an entry');
			return {
				...snapshot,
				entry,
				created: !before.some((candidate) => candidate.fingerprint === entry.fingerprint),
			};
		});
	}

	remove(fingerprint: string): Promise<RegistryRemoveResult> {
		return this.serialized(async () => {
			const result = await this.registry.remove(fingerprint);
			const snapshot = await this.readSnapshot();
			return { ...snapshot, removed: result.success };
		});
	}

	query(domain: string, fingerprint: string): Promise<RegistryQueryResult> {
		return this.serialized(async () => {
			const normalizedDomain = normalizeHostname(domain);
			if (!normalizedDomain) throw new Error('Invalid registry domain');
			if (!isMediaRouteFingerprint(fingerprint)) throw new Error('Invalid registry fingerprint');
			const siteFingerprint = createSiteRouteFingerprint(normalizedDomain);
			if (!siteFingerprint) throw new Error('Invalid registry domain');
			const entry = await this.registry.query(normalizedDomain, siteFingerprint);
			const normalized = entry ? normalizeRegistryEntries([entry]) : [];
			return { entry: normalized[0] ?? null };
		});
	}

	markProbed(
		domain: string,
		fingerprint: string,
		route: MediaRoute,
		options: { force?: boolean } = {},
	): Promise<RegistryAddResult> {
		return this.serialized(async () => {
			const normalizedDomain = normalizeHostname(domain);
			if (!normalizedDomain) throw new Error('Invalid registry domain');
			if (!isMediaRouteFingerprint(fingerprint)) throw new Error('Invalid registry fingerprint');
			const siteFingerprint = createSiteRouteFingerprint(normalizedDomain);
			if (!siteFingerprint) throw new Error('Invalid registry domain');
			const before = normalizeRegistryEntries(await this.registry.get());
			const result = await this.registry.markProbed(normalizedDomain, fingerprint, route, options);
			if (!result.success) throw new Error(`Registry probe update failed: ${result.reason ?? 'unknown'}`);
			const snapshot = await this.readSnapshot();
			const entry = snapshot.entries.find((candidate) => candidate.fingerprint === siteFingerprint);
			if (!entry) throw new Error('Registry probe update did not persist an entry');
			return {
				...snapshot,
				entry,
				created: !before.some((candidate) => candidate.fingerprint === siteFingerprint),
			};
		});
	}
}

export const registryRepository = new RegistryRepository(storage.registry);
