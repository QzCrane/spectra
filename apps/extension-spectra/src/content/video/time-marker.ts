// goal: bounded, source-scoped markers whose jumps use the unique seek executor

import type { MediaTarget } from '@nexus/contracts';
import { createLogger } from '../../shared/logger';
import { getActiveMediaRegistry, type MediaRegistry } from '../core/media-registry';
import { seekNativeMedia } from '../logic/native-media-executor';

const log = createLogger('Marker');
const MAX_MARKERS_PER_SOURCE = 1_000;

export interface TimeMarker {
	id: string;
	time: number;
	label: string;
}

interface MarkerContext {
	element: HTMLMediaElement;
	target: MediaTarget;
	key: string;
}

interface MarkerSet {
	target: MediaTarget;
	markers: TimeMarker[];
}

const markerSets = new Map<string, MarkerSet>();

function sourceKey(target: {
	documentId: string;
	mediaId: string;
	sourceRevision: number;
}): string {
	return `${target.documentId}:${target.mediaId}:${target.sourceRevision}`;
}

function activeContext(target: MediaTarget | null = null): MarkerContext | null {
	const registry = getActiveMediaRegistry();
	const active = registry?.resolve(target);
	if (!registry || !active) return null;
	const currentKeys = new Set(registry.list().map(({ target }) => sourceKey(target)));
	for (const key of markerSets.keys()) {
		if (!currentKeys.has(key)) markerSets.delete(key);
	}
	return { element: active.element, target: active.target, key: sourceKey(active.target) };
}

function markerSetFor(context: MarkerContext): MarkerSet {
	let set = markerSets.get(context.key);
	if (!set) {
		set = { target: { ...context.target }, markers: [] };
		markerSets.set(context.key, set);
	}
	return set;
}

function formatTime(seconds: number): string {
	const minutes = Math.floor(seconds / 60);
	const remainder = Math.floor(seconds % 60);
	return `${minutes}:${remainder.toString().padStart(2, '0')}`;
}

function insertionIndex(markers: readonly TimeMarker[], time: number): number {
	let low = 0;
	let high = markers.length;
	while (low < high) {
		const middle = (low + high) >>> 1;
		if (markers[middle]!.time < time) low = middle + 1;
		else high = middle;
	}
	return low;
}

export function addMarker(
	label?: string,
	target: MediaTarget | null = null,
): { marker: TimeMarker; remaining: number; target: MediaTarget } | null {
	const context = activeContext(target);
	if (!context) return null;
	const markers = markerSetFor(context).markers;
	if (markers.length >= MAX_MARKERS_PER_SOURCE) {
		throw new Error(`Marker limit reached (${MAX_MARKERS_PER_SOURCE})`);
	}
	const time = context.element.currentTime;
	const marker: TimeMarker = {
		id: `m_${crypto.randomUUID()}`,
		time,
		label: label?.trim().slice(0, 256) || `Mark @ ${formatTime(time)}`,
	};
	markers.splice(insertionIndex(markers, time), 0, marker);
	log.info(`Added: ${marker.label}`);
	return { marker: { ...marker }, remaining: markers.length, target: { ...context.target } };
}

export function removeMarker(
	id: string,
	target: MediaTarget | null = null,
): { removed: boolean; remaining: number; target: MediaTarget | null } {
	const context = activeContext(target);
	if (!context) return { removed: false, remaining: 0, target: null };
	const set = markerSets.get(context.key);
	const markers = set?.markers;
	if (!markers) return { removed: false, remaining: 0, target: context.target };
	const index = markers.findIndex((marker) => marker.id === id);
	if (index < 0) return { removed: false, remaining: markers.length, target: context.target };
	markers.splice(index, 1);
	if (markers.length === 0) markerSets.delete(context.key);
	log.info(`Deleted: ${id}`);
	return { removed: true, remaining: markers.length, target: context.target };
}

export async function jumpToMarker(id: string, target: MediaTarget | null = null): Promise<{ jumped: boolean; time: number }> {
	const context = activeContext(target);
	const marker = context && markerSets.get(context.key)?.markers.find((candidate) => candidate.id === id);
	if (!context || !marker) return { jumped: false, time: 0 };
	const actual = await seekNativeMedia(context.element, marker.time);
	log.info(`Jumped: ${marker.label}`);
	return { jumped: true, time: actual };
}

export async function jumpAdjacentMarker(
	forward: boolean,
	target: MediaTarget | null = null,
): Promise<{ marker: TimeMarker; actualTime: number } | null> {
	const context = activeContext(target);
	const markers = context && markerSets.get(context.key)?.markers;
	if (!context || !markers?.length) return null;
	const threshold = context.element.currentTime + (forward ? 0.5 : -0.5);
	const index = insertionIndex(markers, threshold);
	const marker = forward
		? markers[index]
		: markers[Math.min(markers.length, index) - 1];
	if (!marker) return null;
	const actualTime = await seekNativeMedia(context.element, marker.time);
	return { marker: { ...marker }, actualTime };
}

export function listMarkers(target: MediaTarget | null = null): TimeMarker[] {
	const context = activeContext(target);
	return context
		? (markerSets.get(context.key)?.markers ?? []).map((marker) => ({ ...marker }))
		: [];
}

export function listMarkerOwnership(): Array<{
	target: MediaTarget;
	markerCount: number;
}> {
	return [...markerSets.values()].map((set) => ({
		target: { ...set.target },
		markerCount: set.markers.length,
	}));
}

export function disposeMarkers(): void {
	markerSets.clear();
}

// Markers describe one resource timeline, not the reusable DOM element. Drop
// them at the registry's logical removal boundary instead of waiting for a
// later marker command to lazily discover the stale source key.
export function observeMarkerSources(registry: MediaRegistry): () => void {
	return registry.subscribe((target, event) => {
		if (event === 'removed') markerSets.delete(sourceKey(target));
	});
}

export const timeMarkerTestApi = {
	sourceCount: (): number => markerSets.size,
};
