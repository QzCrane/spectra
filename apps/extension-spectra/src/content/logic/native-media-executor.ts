// goal: sole DOM/browser writer with per-target intent correlation and actual readback

import {
	SPECTRA_PROTOCOL_VERSION,
	isSpectraRequestEnvelope,
	rpcFailure,
	rpcSuccess,
	type ControlApplyAck,
	type ControlActualContext,
	type ControlField,
	type ControlFieldStates,
	type ControlIntent,
	type ControlOperationIntent,
	type ControlFrameStepResult,
	type ControlNativeObservationStrategies,
	type ControlPatch,
	type ControlReadRequest,
	type ControlReadResult,
	type ControlStrategy,
	type ControlStrategyFailure,
	type ControlValues,
	type MediaTarget,
} from '@nexus/contracts';
import { sendSpectraRequest } from '../../shared/spectra-client';
import {
	MediaRegistry,
	type MediaRegistryEvent,
	type MediaRegistryRemovalReason,
} from '../core/media-registry';
import type {
	VideoEffectsController,
	VideoEffectState,
} from '../video/video-effects-controller';
import { contentControlStrategy } from './content-control-policy';
import {
	readPageMediaField,
	writePageMediaField,
} from './page-media-bridge';
import {
	SPECTRA_PAGE_MEDIA_FIELDS,
	type SpectraPageMediaField,
} from '../../shared/page-media-bridge';

interface PendingWrite {
	intentId: string;
	revision: number;
	expected: unknown;
	tolerance: number;
	timeoutId: ReturnType<typeof setTimeout>;
}

interface OwnedSeek {
	expected: number;
	tolerance: number;
	expiresAt: number;
}

type RestorableMediaField = 'volumeBase' | 'mediaMuted' | 'speed' | 'preservePitch' | 'loop';
type RestorableMediaWriter = 'page-native' | 'dom-native';

class PageMediaCapabilityUnavailableError extends Error {
	constructor(field: SpectraPageMediaField) {
		super(`Page-media ${field} writer is no longer available`);
		this.name = 'PageMediaCapabilityUnavailableError';
	}
}

interface OwnedMediaField {
	baseline: ControlValues[RestorableMediaField];
	lastApplied: ControlValues[RestorableMediaField];
	writer: RestorableMediaWriter;
}

interface RestorableMediaWriteState {
	actual: ControlValues[RestorableMediaField];
	writer: RestorableMediaWriter;
	upgradeFrom?: OwnedMediaField;
}

interface NativeMediaOwnershipStore {
	byElement: WeakMap<HTMLMediaElement, Map<RestorableMediaField, OwnedMediaField>>;
}

type VideoEffectsControllerPort = Pick<VideoEffectsController, 'apply' | 'dispose' | 'release' | 'snapshot'>;

interface VideoEffectsRuntimeModule {
	VideoEffectsController: new () => VideoEffectsControllerPort;
}

const DEFAULT_VIDEO_EFFECT_STATE: Readonly<VideoEffectState> = Object.freeze({
	rotation: 0,
	mirrored: false,
	fill: false,
	filterEnabled: false,
	filter: Object.freeze({
		brightness: 100,
		contrast: 100,
		saturate: 100,
		grayscale: false,
		invert: false,
	}),
	dimEnabled: false,
	dimOpacity: 0.7,
});

let videoEffectsRuntimePromise: Promise<VideoEffectsRuntimeModule> | null = null;

function loadVideoEffectsRuntime(): Promise<VideoEffectsRuntimeModule> {
	videoEffectsRuntimePromise ??= import(chrome.runtime.getURL('content-video-effects.js'))
		.then((module) => module as VideoEffectsRuntimeModule)
		.catch((error) => {
			videoEffectsRuntimePromise = null;
			throw error;
		});
	return videoEffectsRuntimePromise;
}

const ownershipScope = globalThis as typeof globalThis & {
	__nexusSpectraNativeMediaOwnershipV3?: NativeMediaOwnershipStore;
};
const nativeMediaOwnership = ownershipScope.__nexusSpectraNativeMediaOwnershipV3
	?? { byElement: new WeakMap<HTMLMediaElement, Map<RestorableMediaField, OwnedMediaField>>() };
ownershipScope.__nexusSpectraNativeMediaOwnershipV3 = nativeMediaOwnership;

const ownedSeeks = new WeakMap<HTMLMediaElement, OwnedSeek[]>();
const videoCadence = new WeakMap<HTMLVideoElement, {
	sourceRevision: number;
	frameDuration: number;
}>();

function markOwnedSeek(
	element: HTMLMediaElement,
	expected: number,
	tolerance: number,
): OwnedSeek {
	const now = performance.now();
	const active = (ownedSeeks.get(element) ?? [])
		.filter((seek) => seek.expiresAt > now);
	const owned = { expected, tolerance, expiresAt: now + 1_000 };
	active.push(owned);
	ownedSeeks.set(element, active);
	return owned;
}

function releaseOwnedSeek(element: HTMLMediaElement, owned: OwnedSeek): void {
	const active = (ownedSeeks.get(element) ?? []).filter((seek) => seek !== owned);
	if (active.length > 0) ownedSeeks.set(element, active);
	else ownedSeeks.delete(element);
}

function consumeOwnedSeek(element: HTMLMediaElement, actual: number): boolean {
	const now = performance.now();
	const active = (ownedSeeks.get(element) ?? [])
		.filter((seek) => seek.expiresAt > now);
	const index = active.findIndex((seek) => Math.abs(seek.expected - actual) <= seek.tolerance);
	if (index < 0) {
		if (active.length > 0) ownedSeeks.set(element, active);
		else ownedSeeks.delete(element);
		return false;
	}
	active.splice(index, 1);
	if (active.length > 0) ownedSeeks.set(element, active);
	else ownedSeeks.delete(element);
	return true;
}

export interface AudioRuntimeControlDelegate {
	apply(intent: ControlIntent, patch: ControlPatch): Promise<ControlFieldStates>;
	read(fields: readonly ControlField[]): ControlPatch;
	synchronizeNative(context: ControlActualContext): void;
	runFullscreenTransition?<T>(operation: () => Promise<T>): Promise<T>;
}

const VIDEO_EFFECT_FIELDS = new Set<ControlField>([
	'rotation',
	'mirrored',
	'fill',
	'filterEnabled',
	'filter',
	'dimEnabled',
	'dimOpacity',
]);

const AUDIO_RUNTIME_FIELDS = new Set<ControlField>([
	'audioEnabled',
	'boost',
	'eqValues',
	'bass',
	'compressor',
	'mono',
	'pan',
	'delay',
]);

const RESTORABLE_MEDIA_FIELDS = new Set<ControlField>([
	'volumeBase',
	'mediaMuted',
	'speed',
	'preservePitch',
	'loop',
]);

function isRestorableMediaField(field: ControlField): field is RestorableMediaField {
	return RESTORABLE_MEDIA_FIELDS.has(field);
}

function valuesMatch(expected: unknown, actual: unknown, tolerance: number): boolean {
	if (typeof expected === 'number' && typeof actual === 'number') {
		return Math.abs(expected - actual) <= tolerance;
	}
	return JSON.stringify(expected) === JSON.stringify(actual);
}

const ANIMATION_BOUNDARY_FALLBACK_MS = 48;

function nextAnimationBoundary(): Promise<void> {
	if (typeof requestAnimationFrame !== 'function') return Promise.resolve();
	return new Promise((resolve) => {
		let settled = false;
		let frameId: number | undefined;
		const finish = (): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timeoutId);
			if (frameId !== undefined && typeof cancelAnimationFrame === 'function') {
				cancelAnimationFrame(frameId);
			}
			resolve();
		};
		// Hidden/background tabs may suspend rAF indefinitely. A native control ACK
		// must remain bounded for Popup and authenticated remote callers, so retain
		// the animation-boundary read when available and fall back to a short clock.
		const timeoutId = setTimeout(finish, ANIMATION_BOUNDARY_FALLBACK_MS);
		frameId = requestAnimationFrame(finish);
	});
}

async function stableReadback<T>(read: () => T): Promise<T> {
	// Page players commonly reflect a standard setter synchronously and then
	// normalize it in a microtask or animation callback. Two bounded frame
	// boundaries catch that rollback without installing a standing observer.
	await Promise.resolve();
	await nextAnimationBoundary();
	await nextAnimationBoundary();
	return read();
}

const NATIVE_EVENT_QUIET_MS = 64;

async function stablePageReadback<T>(read: () => T): Promise<T> {
	// Page controller getters are the ACK boundary. Give the player the same
	// short quiet window used by native event ACKs, then cross two render
	// boundaries so delayed UI/state rollback cannot be committed as success.
	await new Promise<void>((resolve) => setTimeout(resolve, NATIVE_EVENT_QUIET_MS));
	return stableReadback(read);
}

async function writeWithStableEventAck<T>(
	target: EventTarget,
	type: string,
	write: () => unknown | Promise<unknown>,
	read: () => T,
	expected: unknown,
	tolerance: number,
	timeoutMs = 750,
): Promise<T> {
	if (valuesMatch(expected, read(), tolerance)) {
		// The native field already exposes the requested value. Re-read across
		// the same stabilization boundary instead of causing an unnecessary
		// setter side effect with no authoritative event to acknowledge it.
		return stableReadback(read);
	}
	let finish!: (matched: boolean) => void;
	let quietTimer: ReturnType<typeof setTimeout> | null = null;
	let timeoutId: ReturnType<typeof setTimeout> | null = null;
	const acknowledgement = new Promise<boolean>((resolve) => {
		finish = resolve;
	});
	const onEvent = (): void => {
		if (quietTimer !== null) clearTimeout(quietTimer);
		quietTimer = null;
		if (!valuesMatch(expected, read(), tolerance)) return;
		// A page-player setter can acknowledge our value and restore its own value
		// in a timer. Require one short event-quiet window before committing.
		quietTimer = setTimeout(() => finish(true), NATIVE_EVENT_QUIET_MS);
	};
	target.addEventListener(type, onEvent);
	timeoutId = setTimeout(() => finish(false), timeoutMs);
	try {
		await write();
		if (!await acknowledgement) {
			throw new Error(`Native ${type} event readback did not acknowledge the requested value`);
		}
		return await stableReadback(read);
	} finally {
		target.removeEventListener(type, onEvent);
		if (quietTimer !== null) clearTimeout(quietTimer);
		if (timeoutId !== null) clearTimeout(timeoutId);
	}
}

async function measureVideoFrameDuration(
	video: HTMLVideoElement,
	sourceRevision: number,
): Promise<number> {
	const cached = videoCadence.get(video);
	if (cached?.sourceRevision === sourceRevision) return cached.frameDuration;
	if (video.paused || typeof video.requestVideoFrameCallback !== 'function') {
		throw new Error('Frame cadence is unavailable until this source has rendered measurable frames');
	}
	const frameDuration = await new Promise<number>((resolve, reject) => {
		let previousMediaTime: number | null = null;
		let callbackId: number | null = null;
		let samples = 0;
		let settled = false;
		const deltas: number[] = [];
		const timeoutId = setTimeout(() => finish(null), 750);
		const finish = (duration: number | null): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timeoutId);
			if (callbackId !== null && typeof video.cancelVideoFrameCallback === 'function') {
				video.cancelVideoFrameCallback(callbackId);
			}
			callbackId = null;
			if (duration === null) reject(new Error('Frame cadence measurement timed out'));
			else resolve(duration);
		};
		const sample: VideoFrameRequestCallback = (_now, metadata) => {
			if (settled) return;
			callbackId = null;
			const mediaTime = metadata.mediaTime;
			if (previousMediaTime !== null) {
				const delta = mediaTime - previousMediaTime;
				if (Number.isFinite(delta) && delta >= 1 / 240 && delta <= 1 / 5) {
					deltas.push(delta);
				}
			}
			previousMediaTime = mediaTime;
			samples += 1;
			if (deltas.length >= 5 || samples >= 8) {
				if (deltas.length < 3) {
					finish(null);
					return;
				}
				const ordered = [...deltas].sort((left, right) => left - right);
				const median = ordered[Math.floor(ordered.length / 2)]!;
				const stable = ordered.at(-1)! - ordered[0]! <= median * 0.35;
				if (stable || samples >= 8) finish(median);
				else callbackId = video.requestVideoFrameCallback(sample);
				return;
			}
			callbackId = video.requestVideoFrameCallback(sample);
		};
		callbackId = video.requestVideoFrameCallback(sample);
	});
	videoCadence.set(video, { sourceRevision, frameDuration });
	return frameDuration;
}

function fullscreenOwnsMedia(element: HTMLMediaElement): boolean {
	const owner = document.fullscreenElement;
	return owner === element
		|| typeof Element !== 'undefined' && owner instanceof Element && owner.contains(element);
}

function resolvePictureInPictureOwner(
	registry: MediaRegistry,
): ReturnType<MediaRegistry['resolveVideo']> {
	const owner = document.pictureInPictureElement;
	if (!(owner instanceof HTMLVideoElement)) return null;
	const registered = registry.list().find(({ element }) => element === owner);
	return registered?.element instanceof HTMLVideoElement
		? { element: registered.element, target: registered.target }
		: null;
}

function isPageMediaField(field: RestorableMediaField): field is SpectraPageMediaField {
	return field === 'volumeBase' || field === 'mediaMuted' || field === 'speed';
}

function readDomRestorableMediaField(
	element: HTMLMediaElement,
	field: RestorableMediaField,
): ControlValues[RestorableMediaField] {
	switch (field) {
		case 'volumeBase': return Math.round(element.volume * 10_000) / 100;
		case 'mediaMuted': return element.muted;
		case 'speed': return element.playbackRate;
		case 'preservePitch': {
			if (!('preservesPitch' in element)) throw new Error('Pitch preservation is unsupported');
			return (element as HTMLMediaElement & { preservesPitch: boolean }).preservesPitch;
		}
		case 'loop': return element.loop;
	}
}

function readRestorableMediaField(
	element: HTMLMediaElement,
	field: RestorableMediaField,
	writer: RestorableMediaWriter,
): ControlValues[RestorableMediaField] {
	if (writer === 'page-native' && isPageMediaField(field)) {
		const actual = readPageMediaField(element, field);
		if (actual === null) throw new Error(`Page-media ${field} reader is no longer available`);
		return actual;
	}
	return readDomRestorableMediaField(element, field);
}

function readRestorableMediaFieldWithWriter(
	element: HTMLMediaElement,
	field: RestorableMediaField,
): { actual: ControlValues[RestorableMediaField]; writer: RestorableMediaWriter } {
	const owned = nativeMediaOwnership.byElement.get(element)?.get(field);
	// A DOM-owned high speed may intentionally exceed the page controller's UI
	// range, so its later reads must stay on playbackRate until an actual DOM
	// ratechange releases ownership. Volume/mute retain semantic page-gesture
	// discovery because their controller values can intentionally differ from
	// the media element projection.
	if (owned && (
		!isPageMediaField(field)
		|| (owned.writer === 'dom-native' && field === 'speed')
	)) {
		return {
			actual: readRestorableMediaField(element, field, owned.writer),
			writer: owned.writer,
		};
	}
	if (isPageMediaField(field)) {
		try {
			const actual = readPageMediaField(element, field);
			if (actual !== null) return { actual, writer: 'page-native' };
		} catch {
			// A broken or transient page controller does not suppress the standard
			// media fallback. No page write has occurred during this read probe.
		}
	}
	return { actual: readDomRestorableMediaField(element, field), writer: 'dom-native' };
}

function readRestorableMediaFieldForWrite(
	element: HTMLMediaElement,
	field: RestorableMediaField,
): RestorableMediaWriteState {
	const owned = nativeMediaOwnership.byElement.get(element)?.get(field);
	if (owned) {
		if (owned.writer === 'dom-native' && isPageMediaField(field)) {
			try {
				const actual = readPageMediaField(element, field);
				if (actual !== null) {
					return {
						actual,
						writer: 'page-native',
						upgradeFrom: owned,
					};
				}
			} catch {
				// Capability discovery is a read-only probe. A controller that is
				// incomplete while a SPA player is mounting leaves the acknowledged
				// DOM writer untouched until a later exact-source intent can prove it.
			}
		}
		return {
			actual: readRestorableMediaField(element, field, owned.writer),
			writer: owned.writer,
		};
	}
	return readRestorableMediaFieldWithWriter(element, field);
}

function writeRestorableMediaField(
	element: HTMLMediaElement,
	field: RestorableMediaField,
	value: ControlValues[RestorableMediaField],
	writer: RestorableMediaWriter,
): ControlValues[RestorableMediaField] {
	if (writer === 'page-native' && isPageMediaField(field)) {
		const actual = writePageMediaField(element, field, value);
		if (actual === null) throw new PageMediaCapabilityUnavailableError(field);
		return actual;
	}
	switch (field) {
		case 'volumeBase': return writeNativeVolumeBase(element, value as number);
		case 'mediaMuted': return writeNativeMediaMuted(element, value as boolean);
		case 'speed': return writeNativePlaybackRate(element, value as number);
		case 'preservePitch': return writeNativePreservesPitch(element, value as boolean);
		case 'loop': return writeNativeLoop(element, value as boolean);
	}
}

// These primitives are the only standard-media property writers. Legacy call
// sites use them during migration, then the coordinator/executor becomes their
// sole caller. Keeping the setters here lets static checks reject a second
// playback/volume/seek owner immediately.
export function writeNativeVolumeBase(element: HTMLMediaElement, volumeBase: number): number {
	element.volume = Math.max(0, Math.min(1, volumeBase / 100));
	return element.volume * 100;
}

export function writeNativeMediaMuted(element: HTMLMediaElement, muted: boolean): boolean {
	element.muted = muted;
	return element.muted;
}

export function writeNativePlaybackRate(element: HTMLMediaElement, speed: number): number {
	const next = Math.max(0.1, Math.min(16, speed));
	// Keep the standard default/current pair coherent when the page has not
	// deliberately separated them. Player UIs commonly project the default while
	// playback itself reads the current rate.
	if (Math.abs(element.defaultPlaybackRate - element.playbackRate) <= 0.005) {
		element.defaultPlaybackRate = next;
	}
	element.playbackRate = next;
	return element.playbackRate;
}

export function writeNativePreservesPitch(element: HTMLMediaElement, preserve: boolean): boolean {
	if (!('preservesPitch' in element)) throw new Error('Pitch preservation is unsupported');
	const target = element as HTMLMediaElement & { preservesPitch: boolean };
	target.preservesPitch = preserve;
	return target.preservesPitch;
}

export function writeNativeCurrentTime(element: HTMLMediaElement, currentTime: number): number {
	element.currentTime = currentTime;
	return element.currentTime;
}

export function writeNativeLoop(element: HTMLMediaElement, loop: boolean): boolean {
	element.loop = loop;
	return element.loop;
}

async function writeRestorableMediaFieldWithStableAck(
	element: HTMLMediaElement,
	field: SpectraPageMediaField,
	desired: ControlValues[SpectraPageMediaField],
	writer: RestorableMediaWriter,
	tolerance: number,
): Promise<ControlValues[SpectraPageMediaField]> {
	const read = (): ControlValues[SpectraPageMediaField] => (
		writer === 'page-native'
			? readRestorableMediaField(element, field, writer)
			: readDomRestorableMediaField(element, field)
	) as ControlValues[SpectraPageMediaField];
	let actual: ControlValues[SpectraPageMediaField];
	if (writer === 'page-native') {
		writeRestorableMediaField(element, field, desired, writer);
		actual = await stablePageReadback(read);
	} else {
		actual = await writeWithStableEventAck(
			element,
			field === 'speed' ? 'ratechange' : 'volumechange',
			() => { writeRestorableMediaField(element, field, desired, writer); },
			read,
			desired,
			tolerance,
		);
	}
	if (!valuesMatch(desired, actual, tolerance)) {
		throw new Error(`${field} readback mismatch after the stable boundary`);
	}
	return actual;
}

async function pageCandidateRestoredBaseline(
	element: HTMLMediaElement,
	field: SpectraPageMediaField,
	baseline: ControlValues[SpectraPageMediaField],
	error: unknown,
	tolerance: number,
): Promise<boolean> {
	// An explicitly unavailable request never called a page setter. Every other
	// page failure may fall through only after the same candidate proves that its
	// baseline is stable again.
	if (error instanceof PageMediaCapabilityUnavailableError) return true;
	try {
		const current = readRestorableMediaField(element, field, 'page-native');
		if (!valuesMatch(current, baseline, tolerance)) {
			writeRestorableMediaField(element, field, baseline, 'page-native');
		}
		const restored = await stablePageReadback(
			() => readRestorableMediaField(element, field, 'page-native'),
		);
		return valuesMatch(restored, baseline, tolerance);
	} catch {
		return false;
	}
}

export function clampNativeSeek(element: HTMLMediaElement, desired: number): number {
	const maximum = Number.isFinite(element.duration) ? element.duration : desired;
	const value = Math.max(0, Math.min(maximum, desired));
	if (element.seekable.length === 0) return value;
	for (let index = 0; index < element.seekable.length; index += 1) {
		const start = element.seekable.start(index);
		const end = element.seekable.end(index);
		if (value >= start && value <= end) return value;
		if (value < start) return start;
	}
	return element.seekable.end(element.seekable.length - 1);
}

export async function seekNativeMedia(
	element: HTMLMediaElement,
	desired: number,
	tolerance = 0.05,
): Promise<number> {
	const target = clampNativeSeek(element, desired);
	const owned = markOwnedSeek(element, target, tolerance);
	let acknowledged = false;
	try {
		writeNativeCurrentTime(element, target);
		if (element.seeking || Math.abs(element.currentTime - target) > tolerance) {
			await waitForNativeEvent(
				element,
				'seeked',
				() => !element.seeking && Math.abs(element.currentTime - target) <= tolerance,
				750,
			);
		}
		if (element.seeking || Math.abs(element.currentTime - target) > tolerance) {
			throw new Error('Seek readback did not reach the requested media time');
		}
		acknowledged = true;
		return element.currentTime;
	} finally {
		// A standards-compliant `seeked` event may be queued after the synchronous
		// getter already confirms the target. Keep the token until that event (or
		// its one-second expiry) so marker/A-B/frame-step ACKs do not become a
		// second page-originated snapshot revision.
		if (!acknowledged) releaseOwnedSeek(element, owned);
	}
}

function waitForNativeEvent(
	target: EventTarget,
	type: string,
	readback: () => boolean,
	timeoutMs: number,
): Promise<void> {
	if (readback()) return Promise.resolve();
	return new Promise((resolve) => {
		let settled = false;
		const finish = (): void => {
			if (settled) return;
			settled = true;
			target.removeEventListener(type, onEvent);
			clearTimeout(timeoutId);
			resolve();
		};
		const onEvent = (): void => { if (readback()) finish(); };
		const timeoutId = setTimeout(finish, timeoutMs);
		target.addEventListener(type, onEvent);
	});
}

export class NativeMediaExecutor {
	private readonly pending = new Map<string, Map<ControlField, PendingWrite>>();
	private readonly observed = new Map<string, Partial<ControlValues>>();
	private readonly desiredMedia: ControlPatch = {};
	private readonly appliedDesiredRevision = new Map<string, number>();
	private readonly replayPending = new Set<string>();
	private readonly automaticPageMaturationRevision = new Map<string, number>();
	private readonly pageMaturationRequested = new Map<string, {
		target: MediaTarget;
		element: HTMLMediaElement;
	}>();
	private effects: VideoEffectsControllerPort | null;
	private readonly ownsEffects: boolean;
	private readonly registry: MediaRegistry;
	private readonly ownsRegistry: boolean;
	private readonly unsubscribeRegistry: () => void;
	private audioRuntimeDelegate: AudioRuntimeControlDelegate | null = null;
	private tabId: number | null = null;
	private desiredRevision = 0;
	private disposed = false;

	constructor(registry?: MediaRegistry, effects?: VideoEffectsControllerPort) {
		this.registry = registry ?? new MediaRegistry();
		this.ownsRegistry = registry === undefined;
		this.effects = effects ?? null;
		this.ownsEffects = effects === undefined;
		this.unsubscribeRegistry = this.registry.subscribe(
			(target, event, element, removalReason) =>
				this.handleMediaEvent(target, event, element, removalReason),
		);
		// Establish event-correlation baselines when the runtime is acquired. A
		// later status/read request must remain a pure projection and must not
		// mutate the executor merely to suppress the next native event.
		for (const { element, target } of this.registry.list()) {
			this.primeObserved(target.mediaId, element);
		}
	}

	private async ensureVideoEffects(): Promise<VideoEffectsControllerPort> {
		if (this.effects) return this.effects;
		const { VideoEffectsController: Controller } = await loadVideoEffectsRuntime();
		if (this.disposed) throw new Error('Native media executor is disposed');
		this.effects = new Controller();
		return this.effects;
	}

	setAudioRuntimeDelegate(delegate: AudioRuntimeControlDelegate | null): void {
		this.audioRuntimeDelegate = delegate;
	}

	bindRequestContext(tabId: number | undefined, documentId: string | undefined): void {
		if (tabId !== undefined) this.tabId = tabId;
		if (documentId) this.registry.setDocumentId(documentId);
	}

	async execute(intent: ControlIntent): Promise<ControlApplyAck> {
		if (this.disposed) throw new Error('Native media executor is disposed');
		this.registry.setDocumentId(intent.documentId);
		this.tabId = intent.tabId;
		const fields: ControlFieldStates = {};
		const runtimePatch: ControlPatch = {};
		const directEntries: Array<[ControlField, ControlValues[ControlField]]> = [];
		this.audioRuntimeDelegate?.synchronizeNative(intent.actualContext);
		for (const [rawField, rawValue] of Object.entries(intent.patch)) {
			const field = rawField as ControlField;
			const value = rawValue as ControlValues[ControlField];
			if (AUDIO_RUNTIME_FIELDS.has(field)) {
				(runtimePatch as Record<string, unknown>)[field] = value;
			} else {
				directEntries.push([field, value]);
			}
		}
		const onlyVideoFields = directEntries.length > 0
			&& directEntries.every(([field]) => VIDEO_EFFECT_FIELDS.has(field)
				|| field === 'pip'
				|| field === 'fullscreen');
		const videoResolver = this.registry as MediaRegistry & {
			resolveVideo?(target: import('@nexus/contracts').MediaTarget | null): ReturnType<MediaRegistry['resolve']>;
		};
		const resolved = onlyVideoFields && typeof videoResolver.resolveVideo === 'function'
			? videoResolver.resolveVideo(intent.target)
			: this.registry.resolve(intent.target);
		if (intent.source === 'restore') {
			for (const [field, value] of directEntries) {
				if (isRestorableMediaField(field)) this.rememberDesired(field, value);
			}
		}
		for (const [field, value] of directEntries) {
			await this.applyField(intent, resolved, field, value, fields);
			const state = fields[field];
			if (isRestorableMediaField(field)
				&& state?.phase === 'applied'
				&& state.desired !== null) {
				this.rememberDesired(field, state.desired);
			}
		}
		this.synchronizeAppliedNative(fields);
		if (Object.keys(runtimePatch).length > 0) {
			if (this.audioRuntimeDelegate) {
				Object.assign(fields, await this.audioRuntimeDelegate.apply(intent, runtimePatch));
			} else {
				for (const [rawField, rawValue] of Object.entries(runtimePatch)) {
					this.putError(
						fields,
						rawField as ControlField,
						rawValue as ControlValues[ControlField],
						intent,
						'strategy-runtime-failed',
						'The acknowledged audio runtime is unavailable',
					);
				}
			}
		}
		if (resolved && directEntries.some(([field]) => RESTORABLE_MEDIA_FIELDS.has(field))) {
			const restored = directEntries
				.filter(([field]) => RESTORABLE_MEDIA_FIELDS.has(field))
				.every(([field]) => fields[field]?.phase === 'applied');
			if (restored) this.appliedDesiredRevision.set(this.targetKey(resolved.target), this.desiredRevision);
		}
		return {
			intentId: intent.intentId,
			tabId: intent.tabId,
			documentId: intent.documentId,
			generation: intent.generation,
			revision: intent.baseRevision + 1,
			// ACK the target that was actually resolved for this document. Echoing a
			// requested-but-stale target would let Background publish a false owner.
			target: resolved?.target ?? null,
			fields,
		};
	}

	async toggleTrustedActivation(
		field: 'playing' | 'pip' | 'fullscreen',
		explicitTarget?: MediaTarget,
	): Promise<{
		target: import('@nexus/contracts').MediaTarget;
		actual: boolean;
	}> {
		if (this.disposed) throw new Error('Native media executor is disposed');
		if (field === 'pip' && explicitTarget && document.pictureInPictureElement) {
			const requested = this.registry.resolveVideo(explicitTarget);
			if (!requested) throw new Error('No active video target');
			const owner = document.pictureInPictureElement;
			const registeredOwner = resolvePictureInPictureOwner(this.registry);
			const acknowledgementTarget = owner instanceof EventTarget
				? owner
				: requested.element;
			const actual = await writeWithStableEventAck(
				acknowledgementTarget,
				'leavepictureinpicture',
				() => document.exitPictureInPicture(),
				() => document.pictureInPictureElement !== null,
				false,
				0,
			);
			return {
				target: registeredOwner?.target ?? requested.target,
				actual,
			};
		}
		const resolved = field === 'pip' && explicitTarget
			? this.registry.resolveVideo(explicitTarget)
			: field === 'playing'
				? this.registry.resolve(null)
				: field === 'pip'
					? resolvePictureInPictureOwner(this.registry) ?? this.registry.resolveVideo(null)
					: this.registry.resolveVideo(null);
		if (!resolved) throw new Error(field === 'playing' ? 'No active media target' : 'No active video target');
		const { element, target } = resolved;
		const current = field === 'playing'
			? !element.paused
			: field === 'pip'
				? document.pictureInPictureElement === element
				: fullscreenOwnsMedia(element);
		const intent: ControlIntent = {
			intentId: `trusted-hotkey-${field}-${performance.now().toString(36)}`,
			tabId: this.tabId ?? 1,
			documentId: target.documentId,
			generation: 0,
			baseRevision: 0,
			source: 'hotkey',
			requestedCoverage: 'active-target',
			target,
			actualContext: {},
			patch: { [field]: !current },
		};
		const fields: ControlFieldStates = {};
		await this.applyField(intent, resolved, field, !current, fields);
		const state = fields[field];
		if (state?.phase !== 'applied' || typeof state.actual !== 'boolean') {
			throw new Error(state?.lastError?.message ?? `Native ${field} toggle was not applied`);
		}
		return { target, actual: state.actual };
	}

	async stepFrame(
		intent: ControlOperationIntent<'frame-step'>,
	): Promise<{ result: ControlFrameStepResult; fields: ControlFieldStates }> {
		const resolved = this.registry.resolveVideo(intent.target);
		if (!resolved || !(resolved.element instanceof HTMLVideoElement)) {
			throw new Error('No active video target');
		}
		const video = resolved.element;
		const frameDuration = await measureVideoFrameDuration(video, resolved.target.sourceRevision);
		const currentTime = await seekNativeMedia(
			video,
			video.currentTime + intent.payload.direction * frameDuration,
			frameDuration / 2,
		);
		const pseudoIntent: ControlIntent = {
			intentId: intent.operationId,
			tabId: intent.tabId,
			documentId: intent.documentId,
			generation: intent.generation,
			baseRevision: intent.baseRevision,
			source: intent.source,
			requestedCoverage: 'active-target',
			target: resolved.target,
			actualContext: {},
			patch: { currentTime },
		};
		const fields: ControlFieldStates = {};
		this.putState(fields, 'currentTime', currentTime, currentTime, pseudoIntent, 'dom-native');
		return {
			result: { currentTime, frameDuration, approximate: true },
			fields,
		};
	}

	readMediaSummary(target: import('@nexus/contracts').MediaTarget | null): {
		playing: boolean;
		speed: number;
		currentTime: number;
	} {
		const resolved = this.registry.resolve(target);
		if (!resolved) throw new Error('No active media target');
		return {
			playing: !resolved.element.paused,
			speed: readRestorableMediaFieldWithWriter(resolved.element, 'speed').actual as number,
			currentTime: resolved.element.currentTime,
		};
	}

	async releasePageSettings(
		intent: ControlOperationIntent<'restore-page-settings'>,
	): Promise<{ releasedFields: ControlField[]; fields: ControlFieldStates }> {
		const active = this.registry.resolve(intent.target);
		const activeKey = active ? this.targetKey(active.target) : null;
		const fields: ControlFieldStates = {};
		const released = new Set<ControlField>();
		for (const { element, target } of this.registry.list()) {
			const key = this.targetKey(target);
			const ownership = nativeMediaOwnership.byElement.get(element);
			if (ownership) {
				for (const [field, owned] of [...ownership.entries()]) {
					const tolerance = field === 'volumeBase' || field === 'speed' ? 0.01 : 0;
					const current = readRestorableMediaField(element, field, owned.writer);
					if (!valuesMatch(current, owned.lastApplied, tolerance)) {
						// The page/user changed the field after SPECTRA's last ACK. It is no
						// longer our property to restore.
						ownership.delete(field);
						continue;
					}
					writeRestorableMediaField(element, field, owned.baseline, owned.writer);
					const actual = await (owned.writer === 'page-native' ? stablePageReadback : stableReadback)(
						() => readRestorableMediaField(element, field, owned.writer),
					);
					if (!valuesMatch(actual, owned.baseline, tolerance)) {
						throw new Error(`Page baseline readback failed for ${field}`);
					}
					ownership.delete(field);
					released.add(field);
					if (key === activeKey) {
						(fields as Record<string, unknown>)[field] = {
							desired: null,
							actual: actual as ControlValues[ControlField],
							revision: intent.baseRevision + 1,
							phase: 'applied',
							strategy: owned.writer,
							coverage: 'active-target',
							controlled: false,
							intentId: intent.operationId,
							lastError: null,
						};
					}
				}
				if (ownership.size === 0) nativeMediaOwnership.byElement.delete(element);
			}
			this.appliedDesiredRevision.delete(key);
			if (element instanceof HTMLVideoElement) {
				const releasedState = this.effects?.release(element) ?? DEFAULT_VIDEO_EFFECT_STATE;
				for (const field of VIDEO_EFFECT_FIELDS) released.add(field);
				if (key === activeKey) {
					for (const field of VIDEO_EFFECT_FIELDS) {
						(fields as Record<string, unknown>)[field] = {
							desired: null,
							actual: releasedState[field as keyof typeof releasedState],
							revision: intent.baseRevision + 1,
							phase: 'applied',
							strategy: field === 'dimEnabled' || field === 'dimOpacity'
								? 'extension-overlay'
								: 'extension-css',
							coverage: 'active-target',
							controlled: false,
							intentId: intent.operationId,
							lastError: null,
						};
					}
				}
			}
		}
		for (const key of Object.keys(this.desiredMedia)) delete (this.desiredMedia as Record<string, unknown>)[key];
		this.desiredRevision += 1;
		this.automaticPageMaturationRevision.clear();
		this.pageMaturationRequested.clear();
		return { releasedFields: [...released], fields };
	}

	read(request: ControlReadRequest): ControlReadResult {
		if (this.disposed) throw new Error('Native media executor is disposed');
		const patch: ControlPatch = {};
		const observedStrategies: ControlNativeObservationStrategies = {};
		const runtimeFields = request.fields.filter((field) => AUDIO_RUNTIME_FIELDS.has(field));
		if (runtimeFields.length > 0 && this.audioRuntimeDelegate) {
			Object.assign(patch, this.audioRuntimeDelegate.read(runtimeFields));
		}
		const onlyVideoFields = request.fields.length > 0
			&& request.fields.every((field) => VIDEO_EFFECT_FIELDS.has(field)
				|| field === 'pip'
				|| field === 'fullscreen');
		const videoResolver = this.registry as MediaRegistry & {
			resolveVideo?(target: import('@nexus/contracts').MediaTarget | null): ReturnType<MediaRegistry['resolve']>;
		};
		const pipOwner = request.target === null && request.fields.includes('pip')
			? resolvePictureInPictureOwner(this.registry)
			: null;
		const resolved = pipOwner
			?? (onlyVideoFields && typeof videoResolver.resolveVideo === 'function'
				? videoResolver.resolveVideo(request.target)
				: this.registry.resolve(request.target));
		if (resolved) {
			const { element, target } = resolved;
			const effectState = element instanceof HTMLVideoElement
				? this.effects?.snapshot(element) ?? DEFAULT_VIDEO_EFFECT_STATE
				: null;
			for (const field of request.fields) {
				if ((patch as Record<string, unknown>)[field] !== undefined) continue;
				let actual: unknown;
				switch (field) {
					case 'volumeBase':
					case 'mediaMuted':
					case 'speed': {
						const observed = readRestorableMediaFieldWithWriter(element, field);
						actual = observed.actual;
						observedStrategies[field] = observed.writer;
						break;
					}
					case 'preservePitch':
						if ('preservesPitch' in element) {
							actual = (element as HTMLMediaElement & { preservesPitch: boolean }).preservesPitch;
							observedStrategies.preservePitch = 'dom-native';
						}
						break;
					case 'playing': actual = !element.paused; observedStrategies.playing = 'dom-native'; break;
					case 'currentTime': actual = element.currentTime; observedStrategies.currentTime = 'dom-native'; break;
					case 'loop': actual = element.loop; observedStrategies.loop = 'dom-native'; break;
					case 'pip': actual = document.pictureInPictureElement === element; observedStrategies.pip = 'dom-native'; break;
					case 'fullscreen': actual = fullscreenOwnsMedia(element); observedStrategies.fullscreen = 'dom-native'; break;
					case 'rotation': actual = effectState?.rotation; break;
					case 'mirrored': actual = effectState?.mirrored; break;
					case 'fill': actual = effectState?.fill; break;
					case 'filterEnabled': actual = effectState?.filterEnabled; break;
					case 'filter': actual = effectState?.filter; break;
					case 'dimEnabled': actual = effectState?.dimEnabled; break;
					case 'dimOpacity': actual = effectState?.dimOpacity; break;
				}
				if (actual !== undefined) (patch as Record<string, unknown>)[field] = actual;
			}
			if (Object.keys(patch).length > 0) return { target, patch, observedStrategies };
		}
		if (Object.keys(patch).length === 0) {
			throw new Error('No requested control field has an observable actual value');
		}
		return { target: request.target, patch, observedStrategies };
	}

	private async applyField(
		intent: ControlIntent,
		resolved: ReturnType<MediaRegistry['resolve']>,
		field: ControlField,
		value: ControlValues[ControlField],
		fields: ControlFieldStates,
	): Promise<void> {
		if (!resolved) {
			this.putError(fields, field, value, intent, 'capability-unavailable', 'No active media target');
			return;
		}
		const { element, target } = resolved;
		this.primeObserved(target.mediaId, element);
		if (VIDEO_EFFECT_FIELDS.has(field)) {
			if (!(element instanceof HTMLVideoElement)) {
				this.putError(fields, field, value, intent, 'capability-unavailable', 'The active target is audio-only');
				return;
			}
			const strategy = contentControlStrategy(field, intent.requestedCoverage);
			if (strategy !== 'extension-css' && strategy !== 'extension-overlay') {
				this.putError(fields, field, value, intent, 'capability-unavailable', 'No admitted video enhancement is available');
				return;
			}
			const effects = await this.ensureVideoEffects();
			const actual = await effects.apply(
				element,
				field as 'rotation' | 'mirrored' | 'fill' | 'filterEnabled' | 'filter' | 'dimEnabled' | 'dimOpacity',
				value as never,
			) as ControlValues[ControlField];
			this.putState(fields, field, value, actual, intent, strategy);
			return;
		}

		const strategy = contentControlStrategy(field, intent.requestedCoverage);
		if (strategy !== 'dom-native') {
			this.putError(fields, field, value, intent, 'capability-unavailable', 'No complete standard media strategy is available');
			return;
		}

		const tolerance = field === 'volumeBase' || field === 'speed'
			? 0.01
			: field === 'currentTime' ? 0.05 : 0;
		const effectiveDesired = field === 'currentTime'
			? clampNativeSeek(element, value as number)
			: value;
		let baseline: ControlValues[RestorableMediaField] | undefined;
		let mediaWriter: RestorableMediaWriter = 'dom-native';
		let writerUpgrade: OwnedMediaField | undefined;
		if (isRestorableMediaField(field)) {
			try {
				const baselineState = readRestorableMediaFieldForWrite(element, field);
				baseline = baselineState.actual;
				mediaWriter = baselineState.writer;
				writerUpgrade = baselineState.upgradeFrom;
			} catch (error) {
				const failure = this.nativeFailure(field, error);
				this.putError(
					fields,
					field,
					effectiveDesired,
					intent,
					failure.code,
					failure.message,
					failure.retryable,
				);
				return;
			}
		}
		this.markPending(target.mediaId, field, {
			intentId: intent.intentId,
			revision: intent.baseRevision + 1,
			expected: effectiveDesired,
			tolerance,
			timeoutId: setTimeout(() => this.clearPending(target.mediaId, field, intent.intentId), 1_000),
		});
		try {
			if (field === 'volumeBase' || field === 'mediaMuted' || field === 'speed') {
				if (baseline === undefined) throw new Error(`Missing ${field} baseline`);
				const pageWriterAlreadyOwned = nativeMediaOwnership.byElement.get(element)?.get(field)?.writer
					=== 'page-native';
				let actual: ControlValues[typeof field];
				try {
					actual = await writeRestorableMediaFieldWithStableAck(
						element,
						field,
						effectiveDesired as ControlValues[typeof field],
						mediaWriter,
						tolerance,
					) as ControlValues[typeof field];
				} catch (pageError) {
					const mayFallThrough = mediaWriter === 'page-native'
						&& !pageWriterAlreadyOwned
						&& await pageCandidateRestoredBaseline(
							element,
							field,
							baseline as ControlValues[typeof field],
							pageError,
							tolerance,
						);
					if (!mayFallThrough) throw pageError;
					if (writerUpgrade) {
						await writeRestorableMediaFieldWithStableAck(
							element,
							field,
							writerUpgrade.lastApplied as ControlValues[typeof field],
							'dom-native',
							tolerance,
						);
						baseline = writerUpgrade.lastApplied;
						writerUpgrade = undefined;
					} else {
						baseline = readDomRestorableMediaField(element, field);
					}
					mediaWriter = 'dom-native';
					actual = await writeRestorableMediaFieldWithStableAck(
						element,
						field,
						effectiveDesired as ControlValues[typeof field],
						mediaWriter,
						tolerance,
					) as ControlValues[typeof field];
				}
				this.putState(fields, field, effectiveDesired, actual, intent, mediaWriter);
				this.observe(target.mediaId, field, actual);
			} else switch (field) {
				case 'preservePitch': {
					writeNativePreservesPitch(element, value as boolean);
					const actual = await stableReadback(() => (
						element as HTMLMediaElement & { preservesPitch: boolean }
					).preservesPitch);
					if (!valuesMatch(effectiveDesired, actual, tolerance)) {
						throw new Error('Pitch-preservation readback mismatch after the stable boundary');
					}
					this.putState(fields, field, effectiveDesired, actual, intent, 'dom-native');
					this.observe(target.mediaId, field, actual);
					break;
				}
				case 'playing': {
					const actual = await writeWithStableEventAck(
						element,
						value ? 'playing' : 'pause',
						() => value ? element.play() : element.pause(),
						() => !element.paused,
						effectiveDesired,
						tolerance,
					);
					if (!valuesMatch(effectiveDesired, actual, tolerance)) {
						throw new Error('Playback readback mismatch after the stable boundary');
					}
					this.putState(fields, field, effectiveDesired, actual, intent, 'dom-native');
					this.observe(target.mediaId, field, actual);
					break;
				}
				case 'currentTime': {
					await seekNativeMedia(element, effectiveDesired as number, tolerance);
					const actual = await stableReadback(() => element.currentTime);
					if (!valuesMatch(effectiveDesired, actual, tolerance)) {
						throw new Error('Seek readback mismatch after the stable boundary');
					}
					this.putState(fields, field, effectiveDesired, actual, intent, 'dom-native');
					this.observe(target.mediaId, field, actual);
					break;
				}
				case 'loop': {
					writeNativeLoop(element, value as boolean);
					const actual = await stableReadback(() => element.loop);
					if (!valuesMatch(effectiveDesired, actual, tolerance)) {
						throw new Error('Loop readback mismatch after the stable boundary');
					}
					this.putState(fields, field, effectiveDesired, actual, intent, 'dom-native');
					this.observe(target.mediaId, field, actual);
					break;
				}
				case 'pip': {
					if (!(element instanceof HTMLVideoElement) || !document.pictureInPictureEnabled) {
						throw new Error('Picture-in-Picture is unsupported');
					}
					const actual = await writeWithStableEventAck(
						element,
						value ? 'enterpictureinpicture' : 'leavepictureinpicture',
						async () => {
							if (value) {
								if (document.pictureInPictureElement
									&& document.pictureInPictureElement !== element) {
									await document.exitPictureInPicture();
								}
								// Sites may set disablePictureInPicture as a UI preference. The
								// explicit extension click temporarily lifts it for this native call.
								const restoreDisabled = element.disablePictureInPicture;
								if (restoreDisabled) element.disablePictureInPicture = false;
								try {
									await element.requestPictureInPicture();
								} finally {
									if (restoreDisabled) element.disablePictureInPicture = true;
								}
							}
							else if (document.pictureInPictureElement === element) await document.exitPictureInPicture();
						},
						() => document.pictureInPictureElement === element,
						effectiveDesired,
						tolerance,
					);
					if (!valuesMatch(effectiveDesired, actual, tolerance)) {
						throw new Error('Picture-in-Picture readback mismatch after the stable boundary');
					}
					this.putState(fields, field, effectiveDesired, actual, intent, 'dom-native');
					this.observe(target.mediaId, field, actual);
					break;
				}
				case 'fullscreen': {
					const requestFullscreen = async (): Promise<void> => {
						if (value) await element.requestFullscreen();
						else if (fullscreenOwnsMedia(element)) await document.exitFullscreen();
					};
					const actual = await writeWithStableEventAck(
						document,
						'fullscreenchange',
						() => value && this.audioRuntimeDelegate?.runFullscreenTransition
							? this.audioRuntimeDelegate.runFullscreenTransition(requestFullscreen)
							: requestFullscreen(),
						() => fullscreenOwnsMedia(element),
						effectiveDesired,
						tolerance,
					);
					if (!valuesMatch(effectiveDesired, actual, tolerance)) {
						throw new Error('Fullscreen readback mismatch after the stable boundary');
					}
					this.putState(fields, field, effectiveDesired, actual, intent, 'dom-native');
					this.observe(target.mediaId, field, actual);
					break;
				}
				default:
					this.putError(
						fields,
						field,
						value,
						intent,
						'capability-unavailable',
						'No safe native or augmentation strategy is available',
					);
			}
			const state = fields[field];
			if (isRestorableMediaField(field)
				&& baseline !== undefined
				&& state?.phase === 'applied'
				&& state.actual !== null) {
				this.commitOwnership(
					element,
					field,
					baseline,
					state.actual,
					mediaWriter,
					writerUpgrade,
				);
			}
		} catch (error) {
			if (isRestorableMediaField(field) && baseline !== undefined) {
				await this.rollbackFailedRestorableWrite(
					element,
					field,
					baseline,
					effectiveDesired,
					mediaWriter,
				)
					.catch(() => undefined);
			}
			const failure = this.nativeFailure(field, error);
			this.putError(
				fields,
				field,
				effectiveDesired,
				intent,
				failure.code,
				failure.message,
				failure.retryable,
				baseline,
			);
		} finally {
			this.clearPending(target.mediaId, field, intent.intentId);
		}
	}

	private commitOwnership(
		element: HTMLMediaElement,
		field: RestorableMediaField,
		baseline: ControlValues[RestorableMediaField],
		actual: ControlValues[ControlField],
		writer: RestorableMediaWriter,
		upgradeFrom?: OwnedMediaField,
	): void {
		const fields = nativeMediaOwnership.byElement.get(element)
			?? new Map<RestorableMediaField, OwnedMediaField>();
		const previous = fields.get(field);
		if (upgradeFrom && previous !== upgradeFrom) {
			throw new Error(`Restorable ${field} ownership changed during writer upgrade`);
		}
		if (previous && previous.writer !== writer) {
			const validUpgrade = previous === upgradeFrom
				&& previous.writer === 'dom-native'
				&& writer === 'page-native';
			if (!validUpgrade) {
				throw new Error(`Restorable ${field} writer changed while ownership was active`);
			}
		}
		fields.set(field, {
			baseline: previous?.baseline ?? baseline,
			lastApplied: actual as ControlValues[RestorableMediaField],
			writer,
		});
		nativeMediaOwnership.byElement.set(element, fields);
	}

	private async rollbackFailedRestorableWrite(
		element: HTMLMediaElement,
		field: RestorableMediaField,
		baseline: ControlValues[RestorableMediaField],
		attempted: ControlValues[ControlField],
		writer: RestorableMediaWriter,
	): Promise<void> {
		const tolerance = field === 'volumeBase' || field === 'speed' ? 0.01 : 0;
		const current = readRestorableMediaField(element, field, writer);
		if (!valuesMatch(current, attempted, tolerance)) return;
		writeRestorableMediaField(element, field, baseline, writer);
		await (writer === 'page-native' ? stablePageReadback : stableReadback)(
			() => readRestorableMediaField(element, field, writer),
		);
	}

	private putState(
		fields: ControlFieldStates,
		field: ControlField,
		desired: ControlValues[ControlField],
		actual: ControlValues[ControlField],
		intent: ControlIntent,
		strategy: ControlStrategy,
	): void {
		(fields as Record<string, unknown>)[field] = {
			desired,
			actual,
			revision: intent.baseRevision + 1,
			phase: this.matches(desired, actual, field === 'currentTime' ? 0.05 : 0.01) ? 'applied' : 'error',
			strategy,
			coverage: 'active-target',
			controlled: this.matches(desired, actual, field === 'currentTime' ? 0.05 : 0.01),
			intentId: intent.intentId,
			lastError: this.matches(desired, actual, field === 'currentTime' ? 0.05 : 0.01)
				? null
				: { code: 'readback-mismatch', message: 'Actual state differs from the requested value', retryable: true },
		};
	}

	private synchronizeAppliedNative(fields: ControlFieldStates): void {
		if (!this.audioRuntimeDelegate) return;
		const context: ControlActualContext = {};
		for (const field of ['volumeBase', 'mediaMuted', 'speed', 'preservePitch'] as const) {
			const state = fields[field];
			if (state?.phase === 'applied' && state.actual !== null) {
				(context as Record<string, unknown>)[field] = state.actual;
			}
		}
		this.audioRuntimeDelegate.synchronizeNative(context);
	}

	private putError(
		fields: ControlFieldStates,
		field: ControlField,
		desired: ControlValues[ControlField],
		intent: ControlIntent,
		code: ControlStrategyFailure,
		message: string,
		retryable = true,
		restoreBaseline?: ControlValues[RestorableMediaField],
	): void {
		(fields as Record<string, unknown>)[field] = {
			desired,
			actual: null,
			...(restoreBaseline === undefined ? {} : { restoreBaseline }),
			revision: intent.baseRevision + 1,
			phase: 'error',
			strategy: 'unsupported',
			coverage: 'partial',
			controlled: false,
			intentId: intent.intentId,
			lastError: { code, message, retryable },
		};
	}

	private nativeFailure(
		field: ControlField,
		error: unknown,
	): { code: ControlStrategyFailure; message: string; retryable: boolean } {
		const message = error instanceof Error ? error.message : String(error);
		const name = error && typeof error === 'object' && 'name' in error
			? String((error as { name: unknown }).name)
			: '';
		if (message.toLowerCase().includes('readback')) {
			return { code: 'readback-mismatch', message, retryable: true };
		}
		if ((message.includes('unsupported') || name === 'NotSupportedError')
			&& (field === 'volumeBase' || field === 'mediaMuted' || field === 'speed')) {
			return { code: 'write-unsupported', message, retryable: true };
		}
		if (message.includes('unsupported') || name === 'NotSupportedError') {
			return { code: 'capability-unavailable', message, retryable: true };
		}
		if (name === 'NotAllowedError'
			|| ((field === 'playing' || field === 'pip' || field === 'fullscreen')
				&& name === 'TypeError')) {
			return { code: 'user-activation-required', message, retryable: false };
		}
		if (name === 'SecurityError') {
			return { code: 'policy-denied', message, retryable: false };
		}
		return { code: 'strategy-runtime-failed', message, retryable: true };
	}

	private markPending(mediaId: string, field: ControlField, pending: PendingWrite): void {
		let fields = this.pending.get(mediaId);
		if (!fields) {
			fields = new Map();
			this.pending.set(mediaId, fields);
		}
		const previous = fields.get(field);
		if (previous) clearTimeout(previous.timeoutId);
		fields.set(field, pending);
	}

	private clearPending(mediaId: string, field: ControlField, intentId: string): void {
		const fields = this.pending.get(mediaId);
		const pending = fields?.get(field);
		if (pending?.intentId === intentId) {
			clearTimeout(pending.timeoutId);
			fields?.delete(field);
		}
		if (fields?.size === 0) this.pending.delete(mediaId);
	}

	private handleMediaEvent(
		target: import('@nexus/contracts').MediaTarget,
		event: MediaRegistryEvent,
		element: HTMLMediaElement,
		removalReason?: MediaRegistryRemovalReason,
	): void {
		if (this.disposed || this.tabId === null) return;
		if (event === 'removed') {
			const key = this.targetKey(target);
			const pending = this.pending.get(target.mediaId);
			if (pending) {
				for (const write of pending.values()) clearTimeout(write.timeoutId);
				this.pending.delete(target.mediaId);
			}
			this.observed.delete(target.mediaId);
			this.appliedDesiredRevision.delete(key);
			this.replayPending.delete(key);
			this.pageMaturationRequested.delete(key);
			for (const attemptKey of this.automaticPageMaturationRevision.keys()) {
				if (attemptKey.startsWith(`${key}:`)) {
					this.automaticPageMaturationRevision.delete(attemptKey);
				}
			}
			if (removalReason === 'detached') {
				void this.releaseDetachedOwnership(element);
				if (element instanceof HTMLVideoElement) this.effects?.release(element);
			}
			return;
		}
		if (event === 'selected') {
			this.primeObserved(target.mediaId, element);
			this.replayDesired(target, element, true);
			void sendSpectraRequest(
				'spectra.content.target.changed',
				{ target },
				{ documentId: target.documentId },
			).catch(() => undefined);
			return;
		}
		if (event === 'registered') this.primeObserved(target.mediaId, element);
		if (event === 'registered') this.replayDesired(target);
		else if (event === 'loadedmetadata' || event === 'play') {
			this.replayDesired(target, element, true);
		}
		const resolved = this.registry.resolve(null);
		if (!resolved || resolved.target.mediaId !== target.mediaId) return;
		const mediaId = target.mediaId;
		const candidates: ControlPatch = {};
		const candidateStrategies: ControlNativeObservationStrategies = {};
		if (event === 'volumechange') {
			const volume = readRestorableMediaFieldWithWriter(element, 'volumeBase');
			const muted = readRestorableMediaFieldWithWriter(element, 'mediaMuted');
			candidates.volumeBase = volume.actual as number;
			candidates.mediaMuted = muted.actual as boolean;
			candidateStrategies.volumeBase = volume.writer;
			candidateStrategies.mediaMuted = muted.writer;
		} else if (event === 'ratechange') {
			const speed = readRestorableMediaFieldWithWriter(element, 'speed');
			candidates.speed = speed.actual as number;
			candidateStrategies.speed = speed.writer;
			// preservesPitch has no standard change event. Reading it on the native
			// rate event captures the common page-player transaction without adding
			// polling or a prototype/descriptor interception.
			if ('preservesPitch' in element) {
				candidates.preservePitch = (
					element as HTMLMediaElement & { preservesPitch: boolean }
				).preservesPitch;
				candidateStrategies.preservePitch = 'dom-native';
			}
		} else if (event === 'play' || event === 'pause') {
			candidates.playing = !element.paused;
			candidateStrategies.playing = 'dom-native';
		}
		else if (event === 'seeked') {
			candidates.currentTime = element.currentTime;
			candidateStrategies.currentTime = 'dom-native';
		}
		else if (event === 'loopchange') {
			candidates.loop = element.loop;
			candidateStrategies.loop = 'dom-native';
		}
		else if (event === 'enterpictureinpicture' || event === 'leavepictureinpicture') {
			candidates.pip = document.pictureInPictureElement === element;
			candidateStrategies.pip = 'dom-native';
		} else if (event === 'fullscreenchange') {
			candidates.fullscreen = fullscreenOwnsMedia(element);
			candidateStrategies.fullscreen = 'dom-native';
		}
		else return;

		const pending = this.pending.get(mediaId);
		const ownedSeek = event === 'seeked'
			&& consumeOwnedSeek(element, element.currentTime);
		const observed = this.observed.get(mediaId) ?? {};
		const patch: ControlPatch = {};
		const observedStrategies: ControlNativeObservationStrategies = {};
		for (const [rawField, actual] of Object.entries(candidates)) {
			const field = rawField as ControlField;
			const write = pending?.get(field);
			if (write) {
				if (this.matches(write.expected, actual, write.tolerance)) {
					this.observe(mediaId, field, actual as ControlValues[ControlField]);
				}
				// The executor's event/getter transaction owns every event for this
				// field until its stable boundary settles. A transient mismatch is
				// evidence for that transaction, not a competing page revision.
				continue;
			}
			if (field === 'currentTime' && ownedSeek) {
				this.observe(mediaId, field, actual as ControlValues[ControlField]);
				continue;
			}
			if (this.matches(observed[field], actual, field === 'currentTime' ? 0.05 : 0.01)) continue;
			this.observe(mediaId, field, actual as ControlValues[ControlField]);
			(patch as Record<string, unknown>)[field] = actual;
			const strategy = candidateStrategies[field as keyof ControlNativeObservationStrategies];
			if (!strategy) throw new Error(`Native observation strategy is missing for ${field}`);
			observedStrategies[field as keyof ControlNativeObservationStrategies] = strategy;
		}
		if (event === 'volumechange' && Object.keys(patch).length > 0) {
			// Page volume and page mute are one semantic transaction even when only
			// one value changed. Publishing the coherent pair prevents Popup state
			// from combining a fresh slider value with stale mute state.
			patch.volumeBase = candidates.volumeBase;
			patch.mediaMuted = candidates.mediaMuted;
			observedStrategies.volumeBase = candidateStrategies.volumeBase;
			observedStrategies.mediaMuted = candidateStrategies.mediaMuted;
			this.observe(mediaId, 'volumeBase', candidates.volumeBase as number);
			this.observe(mediaId, 'mediaMuted', candidates.mediaMuted as boolean);
		}
		if (Object.keys(patch).length === 0) return;
		this.audioRuntimeDelegate?.synchronizeNative(patch);
		for (const rawField of Object.keys(patch)) {
			const field = rawField as ControlField;
			if (isRestorableMediaField(field)) {
				const ownership = nativeMediaOwnership.byElement.get(element);
				ownership?.delete(field);
				if (ownership?.size === 0) nativeMediaOwnership.byElement.delete(element);
				// Page observations are per media/source actual state. They never become
				// a document-wide desired template replayed onto later media elements.
			}
		}
		void sendSpectraRequest('spectra.control.intent.submit', {
			tabId: this.tabId,
			source: 'page',
			requestedCoverage: 'active-target',
			target,
			patch,
			observedStrategies,
		}).catch(() => undefined);
	}

	private rememberDesired(field: ControlField, value: ControlValues[ControlField]): void {
		if (this.matches((this.desiredMedia as Record<string, unknown>)[field], value, 0.001)) return;
		(this.desiredMedia as Record<string, unknown>)[field] = value;
		this.desiredRevision += 1;
	}

	private async releaseDetachedOwnership(element: HTMLMediaElement): Promise<void> {
		const ownership = nativeMediaOwnership.byElement.get(element);
		if (!ownership) return;
		for (const [field, owned] of ownership) {
			try {
				const tolerance = field === 'volumeBase' || field === 'speed' ? 0.01 : 0;
				const current = readRestorableMediaField(element, field, owned.writer);
				if (!valuesMatch(current, owned.lastApplied, tolerance)) continue;
				writeRestorableMediaField(element, field, owned.baseline, owned.writer);
				await (owned.writer === 'page-native' ? stablePageReadback : stableReadback)(
					() => readRestorableMediaField(element, field, owned.writer),
				);
			} catch {
				// Detached page objects are best-effort release targets. Ownership is
				// still discarded so a later insertion cannot inherit a false baseline.
			}
		}
		nativeMediaOwnership.byElement.delete(element);
	}

	private targetKey(target: import('@nexus/contracts').MediaTarget): string {
		return `${target.documentId}:${target.mediaId}:${target.sourceRevision}`;
	}

	private replayDesired(
		target: MediaTarget,
		element?: HTMLMediaElement,
		allowPageMaturation = false,
	): void {
		if (this.tabId === null || Object.keys(this.desiredMedia).length === 0) return;
		const key = this.targetKey(target);
		if (this.replayPending.has(key)) {
			if (allowPageMaturation && element) {
				this.pageMaturationRequested.set(key, { target, element });
			}
			return;
		}
		const revision = this.desiredRevision;
		const alreadyApplied = (this.appliedDesiredRevision.get(key) ?? -1) >= revision;
		let patch: ControlPatch = { ...this.desiredMedia };
		const automaticFields: SpectraPageMediaField[] = [];
		if (alreadyApplied) {
			if (!allowPageMaturation || !element) return;
			patch = {};
			const ownership = nativeMediaOwnership.byElement.get(element);
			for (const field of SPECTRA_PAGE_MEDIA_FIELDS) {
				const attemptKey = `${key}:${field}`;
				const desired = this.desiredMedia[field];
				if (desired === undefined
					|| ownership?.get(field)?.writer !== 'dom-native'
					|| this.pending.get(target.mediaId)?.has(field)
					|| (this.automaticPageMaturationRevision.get(attemptKey) ?? -1) >= revision) {
					continue;
				}
				try {
					if (readPageMediaField(element, field) === null) continue;
				} catch {
					continue;
				}
				(patch as Record<string, unknown>)[field] = desired;
				automaticFields.push(field);
			}
			if (automaticFields.length === 0) return;
		}
		this.replayPending.add(key);
		void sendSpectraRequest('spectra.control.intent.submit', {
			tabId: this.tabId,
			source: 'restore',
			requestedCoverage: 'active-target',
			target,
			patch,
		}).then((response) => {
			if (!response.ok) return;
			const applied = Object.values(response.data.fields)
				.every((field) => field?.phase === 'applied');
			if (applied) this.appliedDesiredRevision.set(key, revision);
			for (const field of automaticFields) {
				this.automaticPageMaturationRevision.set(`${key}:${field}`, revision);
			}
		}).catch(() => undefined).finally(() => {
			this.replayPending.delete(key);
			const requested = this.pageMaturationRequested.get(key);
			if (!requested) return;
			this.pageMaturationRequested.delete(key);
			this.replayDesired(requested.target, requested.element, true);
		});
	}

	private primeObserved(mediaId: string, element: HTMLMediaElement): void {
		if (this.observed.has(mediaId)) return;
		const values: Partial<ControlValues> = {
			volumeBase: readRestorableMediaFieldWithWriter(element, 'volumeBase').actual as number,
			mediaMuted: readRestorableMediaFieldWithWriter(element, 'mediaMuted').actual as boolean,
			speed: readRestorableMediaFieldWithWriter(element, 'speed').actual as number,
			playing: !element.paused,
			currentTime: element.currentTime,
			loop: element.loop,
			pip: document.pictureInPictureElement === element,
			fullscreen: fullscreenOwnsMedia(element),
		};
		if ('preservesPitch' in element) {
			values.preservePitch = (element as HTMLMediaElement & { preservesPitch: boolean }).preservesPitch;
		}
		this.observed.set(mediaId, values);
	}

	private observe(
		mediaId: string,
		field: ControlField,
		actual: ControlValues[ControlField],
	): void {
		const values = this.observed.get(mediaId) ?? {};
		(values as Record<string, unknown>)[field] = actual;
		this.observed.set(mediaId, values);
	}

	private matches(expected: unknown, actual: unknown, tolerance: number): boolean {
		if (typeof expected === 'number' && typeof actual === 'number') {
			return Math.abs(expected - actual) <= tolerance;
		}
		return valuesMatch(expected, actual, tolerance);
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		for (const fields of this.pending.values()) {
			for (const pending of fields.values()) clearTimeout(pending.timeoutId);
		}
		this.pending.clear();
		this.observed.clear();
		this.appliedDesiredRevision.clear();
		this.replayPending.clear();
		this.automaticPageMaturationRevision.clear();
		this.pageMaturationRequested.clear();
		this.unsubscribeRegistry();
		if (this.ownsRegistry) this.registry.dispose();
		if (this.ownsEffects) this.effects?.dispose();
		this.effects = null;
	}
}

let activeNativeMediaExecutor: NativeMediaExecutor | null = null;

export function getActiveNativeMediaExecutor(): NativeMediaExecutor | null {
	return activeNativeMediaExecutor;
}

export function registerNativeMediaExecutor(executor: NativeMediaExecutor): () => void {
	activeNativeMediaExecutor = executor;
	const listener = (
		message: unknown,
		sender: chrome.runtime.MessageSender,
		sendResponse: (response?: unknown) => void,
	): boolean => {
		if (!message || typeof message !== 'object') return false;
		const candidate = message as { protocolVersion?: unknown; type?: unknown };
		if (candidate.protocolVersion !== SPECTRA_PROTOCOL_VERSION
			|| (candidate.type !== 'spectra.control.intent.execute'
				&& candidate.type !== 'spectra.control.actual.read')) return false;
		if (sender.id && sender.id !== chrome.runtime.id) {
			sendResponse(rpcFailure('forbidden', 'Native control execution is extension-internal only'));
			return false;
		}
		if (!isSpectraRequestEnvelope(message)
			|| (message.type !== 'spectra.control.intent.execute'
				&& message.type !== 'spectra.control.actual.read')) {
			sendResponse(rpcFailure('invalid_request', 'Malformed native control intent'));
			return false;
		}
		executor.bindRequestContext(message.tabId, message.documentId);
		const operation = message.type === 'spectra.control.actual.read'
			? Promise.resolve().then(() => executor.read(message.payload))
			: executor.execute(message.payload);
		void operation.then(
			(ack) => sendResponse(rpcSuccess(ack)),
			(error) => sendResponse(rpcFailure(
				'native_control_failed',
				error instanceof Error ? error.message : String(error),
				true,
			)),
		);
		return true;
	};
	chrome.runtime.onMessage.addListener(listener);
	return () => {
		chrome.runtime.onMessage.removeListener(listener);
		if (activeNativeMediaExecutor === executor) activeNativeMediaExecutor = null;
	};
}
