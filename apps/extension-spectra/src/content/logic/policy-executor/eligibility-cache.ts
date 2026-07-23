// goal: learn one bounded direct/capture route for each site, never for each video instance

import {
	createSiteRouteFingerprint,
	type MediaRoute,
	type RegistryAddResult,
	type RegistryQueryResult,
} from '@nexus/contracts';
import {
	markRegistryDomainProbed,
	queryRegistryDomain,
} from '../../../shared/registry-client';
import type { CorsStatus } from './types';

export interface EligibilityCachePort {
	query(domain: string, fingerprint: string): Promise<RegistryQueryResult>;
	mark(
		domain: string,
		fingerprint: string,
		route: MediaRoute,
		options?: { force?: boolean },
	): Promise<RegistryAddResult>;
}

const registryPort: EligibilityCachePort = {
	query: queryRegistryDomain,
	mark: markRegistryDomainProbed,
};

export interface SiteEligibilityCache {
	resolve(liveStatus: CorsStatus): Promise<CorsStatus>;
	recordActual(
		actualMode: 'bypass' | 'webaudio' | 'capture',
		phase: 'idle' | 'starting' | 'active' | 'stopping' | 'error',
	): Promise<void>;
}

interface SiteDecision {
	cachedStatus: CorsStatus;
	lastPersistedStatus: CorsStatus;
	manualStatus: Exclude<CorsStatus, 'PENDING'> | null;
	hydrated: Promise<void>;
}

function routeToStatus(route: MediaRoute): Exclude<CorsStatus, 'PENDING'> {
	return route === 'capture' ? 'RESTRICTED' : 'SAFE';
}

function statusToRoute(status: Exclude<CorsStatus, 'PENDING'>): MediaRoute {
	return status === 'RESTRICTED' ? 'capture' : 'direct';
}

export function createSiteEligibilityCache(
	domain: string,
	port: EligibilityCachePort = registryPort,
): SiteEligibilityCache {
	const fingerprint = createSiteRouteFingerprint(domain);
	if (!fingerprint) throw new Error('Invalid site eligibility domain');
	const decision: SiteDecision = {
		cachedStatus: 'PENDING',
		lastPersistedStatus: 'PENDING',
		manualStatus: null,
		hydrated: Promise.resolve(),
	};
	decision.hydrated = port.query(domain, fingerprint)
		.then(({ entry }) => {
			if (!entry) return;
			decision.cachedStatus = routeToStatus(entry.route);
			decision.lastPersistedStatus = decision.cachedStatus;
			if (entry.source === 'user') decision.manualStatus = decision.cachedStatus;
		})
		.catch(() => undefined);

	const persist = async (
		currentDecision: SiteDecision,
		status: Exclude<CorsStatus, 'PENDING'>,
		options: { force?: boolean } = {},
	): Promise<void> => {
		if (currentDecision.lastPersistedStatus === status) return;
		// rule: a user-pinned route is authoritative for mode selection
		// (resolve), but an acknowledged Capture success proves the pinned
		// `direct` route is wrong and must be corrected. Only Capture forces
		// the overwrite; WebAudio success still respects a user-pinned Capture.
		if (currentDecision.manualStatus && !options.force) return;
		// Snapshot the in-memory decision so a failed persist can fully roll
		// back. `cachedStatus`/`manualStatus` may have been advanced optimistically
		// by the caller (recordActual); without rollback the in-memory view would
		// diverge from the un-persisted storage state across SW restarts.
		const savedCached = currentDecision.cachedStatus;
		const savedManual = currentDecision.manualStatus;
		currentDecision.lastPersistedStatus = status;
		await port.mark(domain, fingerprint, statusToRoute(status), options).then((result) => {
			if (result.entry.source === 'user') {
				currentDecision.manualStatus = routeToStatus(result.entry.route);
				currentDecision.cachedStatus = currentDecision.manualStatus;
			} else if (options.force) {
				// A forced mark overwrites a user-pinned `direct` entry with an
				// automatic `capture` entry. Clear `manualStatus` so the next
				// `resolve` in this document honors the corrected auto route
				// instead of the stale user pin.
				currentDecision.manualStatus = null;
				currentDecision.cachedStatus = status;
			}
		}).catch(() => {
			// Full rollback: persisting failed, so the in-memory decision must
			// not pretend the new status is committed. Reverting to the snapshot
			// keeps cached/manual/lastPersisted aligned with storage truth.
			currentDecision.cachedStatus = savedCached;
			currentDecision.manualStatus = savedManual;
			currentDecision.lastPersistedStatus = 'PENDING';
		});
	};

	return {
		async resolve(liveStatus) {
			await decision.hydrated;
			if (decision.manualStatus) return decision.manualStatus;
			// Current-document evidence corrects the automatic site route. The
			// persisted decision is only used while the current document is unknown.
			if (liveStatus !== 'PENDING') {
			decision.cachedStatus = liveStatus;
			void persist(decision, liveStatus).catch(() => undefined);
			return liveStatus;
		}
		return decision.cachedStatus;
	},
		async recordActual(actualMode, phase) {
			await decision.hydrated;
			if (phase !== 'active') return;
			const status = actualMode === 'capture'
				? 'RESTRICTED'
				: actualMode === 'webaudio'
					? 'SAFE'
					: null;
			if (!status) return;
			if (decision.manualStatus === status) return;
			// This records the acknowledged site route, never a media-instance event.
			// Capture is the last-resort full-output path: when Capture is
			// acknowledged active, the pinned `direct` route is provably wrong
			// (native CORS failed) and must be corrected so the next document
			// skips the futile native attempt. WebAudio success never overwrites a
			// user-pinned Capture choice.
			decision.cachedStatus = status;
			await persist(decision, status, { force: actualMode === 'capture' });
		},
	};
}
