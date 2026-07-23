// goal: pure generation-aware visualizer consumer leases with bounded tombstones

import type { VisualizerBatchPayload } from '@nexus/contracts';

export const VISUALIZER_SUBSCRIBER_TTL_MS = 5_000;
export const VISUALIZER_SUBSCRIBER_TOMBSTONE_TTL_MS = 30_000;

export interface VisualizerSubscriberLease {
	generation: number;
	tabIds: Set<number>;
	expiresAt: number;
	state: 'active' | 'tombstone';
}

export type VisualizerSubscriberLeases = Map<string, VisualizerSubscriberLease>;

export interface VisualizerSubscriberPlan {
	accepted: boolean;
	responseGeneration: number;
	candidate: VisualizerSubscriberLeases;
}

function tombstone(generation: number, now: number): VisualizerSubscriberLease {
	return {
		generation,
		tabIds: new Set<number>(),
		expiresAt: now + VISUALIZER_SUBSCRIBER_TOMBSTONE_TTL_MS,
		state: 'tombstone',
	};
}

// Active leases become tombstones before deletion. The retained generation
// prevents a delayed pre-hide batch from resurrecting a released analyser.
export function advanceVisualizerSubscriberLeases(
	current: VisualizerSubscriberLeases,
	now: number,
): VisualizerSubscriberLeases {
	let candidate: VisualizerSubscriberLeases | null = null;
	for (const [subscriberId, lease] of current) {
		if (lease.expiresAt > now) continue;
		candidate ??= new Map(current);
		if (lease.state === 'active') {
			candidate.set(subscriberId, tombstone(lease.generation, now));
		} else {
			candidate.delete(subscriberId);
		}
	}
	return candidate ?? current;
}

export function planVisualizerSubscriberLease(
	current: VisualizerSubscriberLeases,
	payload: VisualizerBatchPayload,
	now: number,
): VisualizerSubscriberPlan {
	const advanced = advanceVisualizerSubscriberLeases(current, now);
	const previous = advanced.get(payload.subscriberId);
	if (previous && payload.generation <= previous.generation) {
		return {
			accepted: false,
			responseGeneration: previous.generation,
			candidate: advanced,
		};
	}

	const candidate = new Map(advanced);
	candidate.set(payload.subscriberId, payload.tabIds.length === 0
		? tombstone(payload.generation, now)
		: {
			generation: payload.generation,
			tabIds: new Set(payload.tabIds),
			expiresAt: now + VISUALIZER_SUBSCRIBER_TTL_MS,
			state: 'active',
		});
	return {
		accepted: true,
		responseGeneration: payload.generation,
		candidate,
	};
}

export function removeVisualizerTab(
	current: VisualizerSubscriberLeases,
	tabId: number,
): VisualizerSubscriberLeases {
	let candidate: VisualizerSubscriberLeases | null = null;
	for (const [subscriberId, lease] of current) {
		if (!lease.tabIds.has(tabId)) continue;
		candidate ??= new Map(current);
		const tabIds = new Set(lease.tabIds);
		tabIds.delete(tabId);
		candidate.set(subscriberId, { ...lease, tabIds });
	}
	return candidate ?? current;
}

export function visualizerSubscriberUnion(
	subscribers: VisualizerSubscriberLeases,
): number[] {
	return [...new Set(
		[...subscribers.values()]
			.filter((subscriber) => subscriber.state === 'active')
			.flatMap((subscriber) => [...subscriber.tabIds]),
	)];
}

export function nextVisualizerSubscriberExpiry(
	subscribers: VisualizerSubscriberLeases,
): number | null {
	let next: number | null = null;
	for (const subscriber of subscribers.values()) {
		if (next === null || subscriber.expiresAt < next) next = subscriber.expiresAt;
	}
	return next;
}
