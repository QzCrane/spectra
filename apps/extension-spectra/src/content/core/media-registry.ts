// goal: event-driven media identity and sticky active-target selection without command-time scans

import type { MediaTarget } from '@nexus/contracts';
import type { MediaSourceEligibilityEvidence } from '@nexus/audio-engine';

export type MediaRegistryEvent =
	| 'registered'
	| 'removed'
	| 'selected'
	| 'loadstart'
	| 'play'
	| 'pause'
	| 'loadedmetadata'
	| 'emptied'
	| 'volumechange'
	| 'ratechange'
	| 'loopchange'
	| 'seeked'
	| 'enterpictureinpicture'
	| 'leavepictureinpicture'
	| 'fullscreenchange';

export type MediaRegistryRemovalReason = 'detached' | 'source-change';

interface MediaRecord {
	element: HTMLMediaElement;
	target: MediaTarget;
	source: string;
	sourceTransitionOpen: boolean;
	eligibilityEvidence?: MediaSourceEligibilityEvidence;
	registrationOrder: number;
	lastInteraction: number;
	lastPlay: number;
	visibleArea: number;
	dispose(): void;
}

type MediaRegistryListener = (
	record: MediaTarget,
	event: MediaRegistryEvent,
	element: HTMLMediaElement,
	removalReason?: MediaRegistryRemovalReason,
) => void;

const sourceObjectIds = new WeakMap<object, number>();
let nextSourceObjectId = 1;

function sourceIdentity(element: HTMLMediaElement): string {
	const sourceObject = element.srcObject;
	let objectIdentity = 0;
	if (sourceObject && typeof sourceObject === 'object') {
		objectIdentity = sourceObjectIds.get(sourceObject) ?? nextSourceObjectId++;
		sourceObjectIds.set(sourceObject, objectIdentity);
	}
	return `${element.currentSrc || element.src || ''}\n${objectIdentity}`;
}

function preloadCorsEvidence(
	element: HTMLMediaElement,
): MediaSourceEligibilityEvidence | undefined {
	const resourceUrl = element.currentSrc || element.src || '';
	if (!resourceUrl || element.readyState < HTMLMediaElement.HAVE_METADATA || element.error) return undefined;
	const crossOrigin = element.crossOrigin;
	if (crossOrigin !== 'anonymous' && crossOrigin !== 'use-credentials') return undefined;
	return { kind: 'preload-cors', resourceUrl };
}

function initialVisibleArea(element: HTMLMediaElement): number {
	const rect = element.getBoundingClientRect();
	if (rect.width <= 0 || rect.height <= 0) return 0;
	if (typeof window === 'undefined') return rect.width * rect.height;
	const left = Math.max(0, rect.left);
	const top = Math.max(0, rect.top);
	const right = Math.min(window.innerWidth, rect.right);
	const bottom = Math.min(window.innerHeight, rect.bottom);
	return Math.max(0, right - left) * Math.max(0, bottom - top);
}

let activeMediaRegistry: MediaRegistry | null = null;

export function setActiveMediaRegistry(registry: MediaRegistry | null): () => void {
	activeMediaRegistry = registry;
	return () => {
		if (activeMediaRegistry === registry) activeMediaRegistry = null;
	};
}

export function getActiveMediaRegistry(): MediaRegistry | null {
	return activeMediaRegistry;
}

export class MediaRegistry {
	private readonly byElement = new Map<HTMLMediaElement, MediaRecord>();
	private readonly byId = new Map<string, MediaRecord>();
	private readonly mutationObserver: MutationObserver;
	private readonly intersectionObserver: IntersectionObserver;
	private documentId = '';
	private nextMediaId = 1;
	private order = 1;
	private activeMediaId: string | null = null;
	private activeVideoId: string | null = null;
	private fullscreenMediaId: string | null = null;
	private selectedTargetKey: string | null = null;
	private readonly pendingRemovals = new Set<HTMLMediaElement>();
	private removalFlushQueued = false;
	private disposed = false;
	private readonly fullscreenListener: EventListener;
	private readonly listeners = new Set<MediaRegistryListener>();

	constructor(onEvent?: MediaRegistryListener) {
		if (onEvent) this.listeners.add(onEvent);
		this.fullscreenListener = () => {
			const fullscreenElement = document.fullscreenElement;
			const entering = fullscreenElement
				? this.fullscreenRecord(fullscreenElement)
				: null;
			const record = entering
				?? (this.fullscreenMediaId ? this.byId.get(this.fullscreenMediaId) : undefined);
			if (!record) return;
			if (entering) {
				this.selectRecord(record, false);
				this.fullscreenMediaId = record.target.mediaId;
			} else this.fullscreenMediaId = null;
			this.emit(record.target, 'fullscreenchange', record.element);
		};
		this.intersectionObserver = new IntersectionObserver((entries) => {
			for (const entry of entries) {
				const media = entry.target;
				if (!(media instanceof HTMLMediaElement)) continue;
				const record = this.byElement.get(media);
				if (!record) continue;
				record.visibleArea = entry.isIntersecting
					? entry.intersectionRect.width * entry.intersectionRect.height
					: 0;
			}
		});
		this.mutationObserver = new MutationObserver((mutations) => {
			for (const mutation of mutations) {
				for (const node of mutation.addedNodes) this.discover(node);
				for (const node of mutation.removedNodes) this.queueRemovalTree(node);
			if (mutation.type === 'attributes' && mutation.target instanceof HTMLMediaElement) {
					if (mutation.attributeName === 'src' || mutation.attributeName === 'crossorigin') {
						this.refreshSource(mutation.target, false);
					}
					if (mutation.attributeName === 'loop') {
						const record = this.byElement.get(mutation.target);
						if (record) this.emit(record.target, 'loopchange', mutation.target);
					}
				}
			}
		});
		this.discover(document.documentElement);
		this.mutationObserver.observe(document, {
			childList: true,
			subtree: true,
			attributes: true,
			// `loop` is a reflected boolean attribute with no dedicated DOM event.
			// Reuse the existing runtime observer rather than polling or patching its
			// property descriptor so page-side loop changes join the same snapshot.
			attributeFilter: ['src', 'crossorigin', 'loop'],
		});
		document.addEventListener('fullscreenchange', this.fullscreenListener);
	}

	subscribe(listener: MediaRegistryListener): () => void {
		if (this.disposed) throw new Error('Media registry is disposed');
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private emit(
		target: MediaTarget,
		event: MediaRegistryEvent,
		element: HTMLMediaElement,
		removalReason?: MediaRegistryRemovalReason,
	): void {
		for (const listener of this.listeners) {
			listener({ ...target }, event, element, removalReason);
		}
	}

	setDocumentId(documentId: string): void {
		if (this.documentId && this.documentId !== documentId) {
			throw new Error('Media registry cannot cross a document boundary');
		}
		if (this.documentId === documentId) return;
		this.documentId = documentId;
		for (const record of this.byElement.values()) record.target.documentId = documentId;
	}

	private discover(node: Node): void {
		if (node instanceof HTMLMediaElement) this.register(node);
		if (!(node instanceof Element)) return;
		for (const media of node.querySelectorAll('video,audio')) {
			if (media instanceof HTMLMediaElement) this.register(media);
		}
	}

	private queueRemovalTree(node: Node): void {
		if (node instanceof HTMLMediaElement) this.pendingRemovals.add(node);
		if (!(node instanceof Element)) return;
		for (const media of node.querySelectorAll('video,audio')) {
			if (media instanceof HTMLMediaElement) this.pendingRemovals.add(media);
		}
		if (this.removalFlushQueued) return;
		this.removalFlushQueued = true;
		queueMicrotask(() => {
			this.removalFlushQueued = false;
			for (const media of this.pendingRemovals) {
				if (!media.isConnected) this.unregister(media);
			}
			this.pendingRemovals.clear();
		});
	}

	private register(element: HTMLMediaElement): void {
		if (this.disposed || this.byElement.has(element)) return;
		const mediaId = `media:${this.nextMediaId++}`;
		const record: MediaRecord = {
			element,
			target: {
				frameId: 0,
				documentId: this.documentId,
				mediaId,
				sourceRevision: 0,
				kind: element instanceof HTMLVideoElement ? 'video' : 'audio',
			},
			source: sourceIdentity(element),
			sourceTransitionOpen: false,
			eligibilityEvidence: preloadCorsEvidence(element),
			registrationOrder: this.order++,
			lastInteraction: 0,
			lastPlay: 0,
			// IntersectionObserver is asynchronous. Seed the first selection from
			// current geometry so a restore that immediately follows runtime
			// acquisition cannot choose an earlier hidden/preloaded SPA source
			// before the observer delivers its initial entries.
			visibleArea: initialVisibleArea(element),
			dispose: () => undefined,
		};
		const listeners: Array<[MediaRegistryEvent, EventListener]> = [];
		for (const type of [
			'loadstart',
			'play',
			'pause',
			'loadedmetadata',
			'emptied',
			'volumechange',
			'ratechange',
			'seeked',
			'enterpictureinpicture',
			'leavepictureinpicture',
		] as const) {
			const listener = (event: Event): void => {
				if (type === 'play') {
					record.lastPlay = performance.now();
					this.selectRecord(record, false);
				}
				if (type === 'loadstart' || type === 'emptied') this.refreshSource(element, true);
				if (type === 'loadedmetadata') {
					this.refreshSource(element, false);
					record.sourceTransitionOpen = false;
					record.eligibilityEvidence = preloadCorsEvidence(element);
				}
				if (event.isTrusted
					&& (type === 'volumechange' || type === 'ratechange' || type === 'seeked')) {
					// Native control events can be delivered after transient activation has
					// expired. The trusted event itself is the best element-level evidence
					// that a page/player changed this source; pending intent correlation in
					// NativeMediaExecutor prevents extension echoes from becoming a second
					// revision even when an explicit command selected another media element.
					record.lastInteraction = performance.now();
					this.selectRecord(record, false);
				}
				this.emit(record.target, type, element);
			};
			element.addEventListener(type, listener);
			listeners.push([type, listener]);
		}
		const onPointer = (event: Event): void => {
			if (!event.isTrusted) return;
			record.lastInteraction = performance.now();
			this.selectRecord(record, true);
		};
		element.addEventListener('pointerdown', onPointer, true);
		record.dispose = () => {
			for (const [type, listener] of listeners) element.removeEventListener(type, listener);
			element.removeEventListener('pointerdown', onPointer, true);
		};
		this.byElement.set(element, record);
		this.byId.set(mediaId, record);
		this.intersectionObserver.observe(element);
		this.emit(record.target, 'registered', element);
	}

	private unregister(element: HTMLMediaElement): void {
		const record = this.byElement.get(element);
		if (!record) return;
		this.emit(record.target, 'removed', element, 'detached');
		record.dispose();
		this.intersectionObserver.unobserve(element);
		this.byElement.delete(element);
		this.byId.delete(record.target.mediaId);
		if (this.activeMediaId === record.target.mediaId) this.activeMediaId = null;
		if (this.activeVideoId === record.target.mediaId) this.activeVideoId = null;
		if (this.fullscreenMediaId === record.target.mediaId) this.fullscreenMediaId = null;
		if (this.selectedTargetKey === this.targetKey(record.target)) this.selectedTargetKey = null;
	}

	private refreshSource(element: HTMLMediaElement, lifecycleBoundary: boolean): void {
		const record = this.byElement.get(element);
		if (!record) return;
		const source = sourceIdentity(element);
		record.eligibilityEvidence = preloadCorsEvidence(element);
		if (lifecycleBoundary && record.sourceTransitionOpen) {
			record.source = source;
			return;
		}
		if (!lifecycleBoundary && source === record.source) return;
		// A reused <audio>/<video> element is a new control identity. Emit a
		// logical removal before incrementing the revision so every source-scoped
		// owner can dispose baselines, CSS/overlay state and graph routing without
		// polling or command-time scans, then re-register the same element under
		// its new identity. Page-lifetime MediaElementSource ownership is reused by
		// the WebAudio controller rather than rebound.
		this.emit(record.target, 'removed', element, 'source-change');
		record.source = source;
		record.sourceTransitionOpen = true;
		record.eligibilityEvidence = undefined;
		record.target.sourceRevision += 1;
		this.emit(record.target, 'registered', element);
		if (this.activeMediaId === record.target.mediaId) this.selectRecord(record, true);
	}

	private targetKey(target: MediaTarget): string {
		return `${target.documentId}:${target.frameId}:${target.mediaId}:${target.sourceRevision}`;
	}

	private selectRecord(record: MediaRecord, notify: boolean): void {
		this.activeMediaId = record.target.mediaId;
		if (record.target.kind === 'video') this.activeVideoId = record.target.mediaId;
		const key = this.targetKey(record.target);
		if (key === this.selectedTargetKey) return;
		this.selectedTargetKey = key;
		if (notify) this.emit(record.target, 'selected', record.element);
	}

	select(target: MediaTarget): boolean {
		const record = this.recordForTarget(target);
		if (!record) return false;
		this.selectRecord(record, true);
		return true;
	}

	private recordForTarget(target: MediaTarget): MediaRecord | null {
		const record = this.byId.get(target.mediaId);
		return record
			&& record.target.documentId === target.documentId
			&& record.target.frameId === target.frameId
			&& record.target.sourceRevision === target.sourceRevision
			? record
			: null;
	}

	private bestRecord(
		records: Iterable<MediaRecord>,
		kind: 'media' | 'video' = 'media',
	): MediaRecord | null {
		let best: MediaRecord | null = null;
		for (const record of records) {
			if (kind === 'video' && record.target.kind !== 'video') continue;
			if (!best || this.compare(record, best) > 0) best = record;
		}
		return best;
	}

	private fullscreenRecord(owner: Element): MediaRecord | null {
		if (owner instanceof HTMLMediaElement) {
			const exact = this.byElement.get(owner);
			if (exact) return exact;
		}
		const contained = [...this.byElement.values()].filter(({ element }) => owner.contains(element));
		if (contained.length === 0) return null;
		const activeVideo = this.activeVideoId ? this.byId.get(this.activeVideoId) : undefined;
		if (activeVideo && contained.includes(activeVideo)) return activeVideo;
		const bestVideo = this.bestRecord(contained, 'video');
		if (bestVideo) return bestVideo;
		const activeMedia = this.activeMediaId ? this.byId.get(this.activeMediaId) : undefined;
		if (activeMedia && contained.includes(activeMedia)) return activeMedia;
		return this.bestRecord(contained);
	}

	private best(kind: 'media' | 'video'): MediaRecord | null {
		const activeId = kind === 'video' ? this.activeVideoId : this.activeMediaId;
		const active = activeId ? this.byId.get(activeId) : undefined;
		if (active && (kind === 'media' || active.target.kind === 'video')) return active;
		return this.bestRecord(this.byElement.values(), kind);
	}

	peek(
		target: MediaTarget | null,
		kind: 'media' | 'video' = 'media',
	): { element: HTMLMediaElement; target: MediaTarget } | null {
		if (target) {
			const record = this.recordForTarget(target);
			if (!record || kind === 'video' && record.target.kind !== 'video') return null;
			return { element: record.element, target: { ...record.target } };
		}
		const best = this.best(kind);
		if (!best) return null;
		return { element: best.element, target: { ...best.target } };
	}

	resolve(target: MediaTarget | null): { element: HTMLMediaElement; target: MediaTarget } | null {
		return this.peek(target, 'media');
	}

	resolveVideo(target: MediaTarget | null): { element: HTMLVideoElement; target: MediaTarget } | null {
		const resolved = this.peek(target, 'video');
		return resolved && resolved.element instanceof HTMLVideoElement
			? { element: resolved.element, target: resolved.target }
			: null;
	}

	list(): Array<{ element: HTMLMediaElement; target: MediaTarget }> {
		return [...this.byElement.values()].map((record) => ({
			element: record.element,
			target: { ...record.target },
		}));
	}

	get size(): number {
		return this.byElement.size;
	}

	hasPlayingMedia(): boolean {
		for (const { element } of this.byElement.values()) {
			if (!element.paused && !element.ended) return true;
		}
		return false;
	}

	getEligibilityEvidence(
		element: HTMLMediaElement,
	): MediaSourceEligibilityEvidence | undefined {
		const record = this.byElement.get(element);
		if (!record) return undefined;
		const evidence = record.eligibilityEvidence;
		return evidence ? { ...evidence } : undefined;
	}

	private compare(left: MediaRecord, right: MediaRecord): number {
		if (left.lastInteraction !== right.lastInteraction) return left.lastInteraction - right.lastInteraction;
		const leftPlaying = !left.element.paused && !left.element.ended ? 1 : 0;
		const rightPlaying = !right.element.paused && !right.element.ended ? 1 : 0;
		if (leftPlaying !== rightPlaying) return leftPlaying - rightPlaying;
		if (left.visibleArea !== right.visibleArea) return left.visibleArea - right.visibleArea;
		if (left.lastPlay !== right.lastPlay) return left.lastPlay - right.lastPlay;
		return right.registrationOrder - left.registrationOrder;
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.mutationObserver.disconnect();
		this.intersectionObserver.disconnect();
		document.removeEventListener('fullscreenchange', this.fullscreenListener);
		for (const record of this.byElement.values()) record.dispose();
		this.byElement.clear();
		this.byId.clear();
		this.pendingRemovals.clear();
		this.listeners.clear();
		this.activeMediaId = null;
		this.activeVideoId = null;
		this.fullscreenMediaId = null;
		this.selectedTargetKey = null;
	}
}
