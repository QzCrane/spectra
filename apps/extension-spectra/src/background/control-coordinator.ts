// goal: authoritative per-field intent ordering, actual ACK commit, and snapshot projection

import {
	audioSessionMatchesControlDocument,
	CONTROL_ALGORITHM_POLICIES,
	CONTROL_BOOTSTRAP_OBSERVATION_GROUPS,
	CONTROL_SESSION_FIELDS,
	SPECTRA_PROTOCOL_VERSION,
	isControlApplyAck,
	isControlOperationAck,
	isControlSnapshot,
	isSpectraRequestEnvelope,
	compileEffectiveVolume,
	isActiveCaptureLifecycle,
	resolveAudioVolume,
	rpcFailure,
	rpcSuccess,
	splitEffectiveVolume,
	type CaptureAdmission,
	type ControlActualContext,
	type ControlApplyAck,
	type ControlCapability,
	type ControlDirectField,
	type ControlField,
	type ControlFieldStates,
	type ControlIntent,
	type ControlMutation,
	type ControlNativeObservationStrategies,
	type ControlOperationAck,
	type ControlOperationIntent,
	type ControlOperationRequest,
	type ControlOperationResult,
	type ControlPatch,
	type ControlSessionPatch,
	type ControlSnapshot,
	type ControlSubmitRequest,
	type ControlValues,
	type MediaTarget,
	type SpectraEventEnvelope,
} from '@nexus/contracts';
import { createKeyedSerializedQueue } from '@nexus/kernel';
import { sendSpectraTabRequest } from './spectra-tab-client';
import { storage } from './state';
import {
	markBadgeUsedForTab,
	restoreBadgeUsageForTab,
	updateBadgeFromControlProjection,
} from './handlers/badge';
import { executeUserScriptInTab } from './handlers/user-scripts';
import { getAudioSession } from './audio-session-store';
import {
	ensureContentRuntime,
	awaitDocumentInitialization,
	releaseContentRuntimeLease,
	releaseSourceRuntimeLease,
	retainSourceRuntimeLease,
} from './runtime-loader';
import { swLog } from '../shared/logger';

const STORAGE_PREFIX = 'spectra.control.tab.';
const GENERATION_PREFIX = 'spectra.control.generation.';
const snapshots = new Map<number, ControlSnapshot>();
const serialized = createKeyedSerializedQueue<number>();
const invalidations = new Map<number, Promise<void>>();
let initialized = false;

type RoutedControlSubmitRequest = Omit<ControlSubmitRequest, 'tabId'> & {
	tabId: number;
	captureAdmission?: CaptureAdmission;
	observationDocumentId?: string;
};
type ResolvedControlSubmitRequest = Omit<RoutedControlSubmitRequest, 'patch' | 'mutations'> & {
	patch: ControlPatch;
};
type RoutedControlOperationRequest = ControlOperationRequest & {
	tabId: number;
	captureAdmission?: CaptureAdmission;
};

const EXTENSION_INVOCATION_ADMISSION: CaptureAdmission = 'extension-invocation';

// Page-originated messages are observations emitted by the trusted content
// runtime after a native event/getter readback. They must update the shared
// snapshot without routing the same value back to the DOM as a second write.
const PAGE_OBSERVABLE_FIELDS = new Set<ControlField>([
	'volumeBase',
	'mediaMuted',
	'speed',
	'preservePitch',
	'playing',
	'currentTime',
	'loop',
	'pip',
	'fullscreen',
]);
const BOOTSTRAP_PAGE_OBSERVABLE_FIELDS = new Set<ControlField>(
	CONTROL_BOOTSTRAP_OBSERVATION_GROUPS.flat(),
);

const AUDIO_PROJECTION_FIELDS = new Set<ControlField>([
	'audioEnabled',
	'volumeBase',
	'boost',
	'mediaMuted',
	'speed',
	'preservePitch',
	'eqValues',
	'bass',
	'compressor',
	'mono',
	'pan',
	'delay',
]);

interface ControlTargetProjection {
	activeMedia: ControlSnapshot['activeMedia'];
	activeVideo: ControlSnapshot['activeVideo'];
}

function controlTargetScopeFlags(capabilities: readonly ControlCapability[]): {
	updatesMedia: boolean;
	updatesVideo: boolean;
} {
	const scopes = capabilities.map((capability) => CONTROL_ALGORITHM_POLICIES[capability].scope);
	return {
		updatesMedia: scopes.some((scope) => scope === 'active-media'
			|| scope === 'media-source'
			|| scope === 'requested-audio-scope'),
		updatesVideo: scopes.some((scope) => scope === 'active-video'),
	};
}

function assertUnambiguousTargetScope(request: RoutedControlSubmitRequest): void {
	const capabilities = [
		...Object.keys(request.patch ?? {}),
		...(request.mutations ?? []).map(({ field }) => field),
	] as ControlCapability[];
	const { updatesMedia, updatesVideo } = controlTargetScopeFlags(capabilities);
	if (updatesVideo && request.target?.kind === 'audio') {
		throw new Error('A video-scoped control cannot target an audio element');
	}
	if (updatesMedia && updatesVideo && request.target === null) {
		throw new Error('Mixed media/video controls require one explicit video target');
	}
}

// An ACK target identifies what executed; it is not permission to replace both
// active identities. Contract scope is the executable owner of that projection:
// video-only controls update only activeVideo, tab/document controls update
// neither, and media/audio/source controls update activeMedia (plus activeVideo
// when the resolved media itself is a video).
function projectControlTarget(
	baseline: Pick<ControlSnapshot, 'activeMedia' | 'activeVideo'>,
	capabilities: readonly ControlCapability[],
	target: MediaTarget | null,
): ControlTargetProjection {
	let activeMedia = baseline.activeMedia;
	let activeVideo = baseline.activeVideo;
	if (!target) return { activeMedia, activeVideo };

	const { updatesMedia, updatesVideo } = controlTargetScopeFlags(capabilities);
	if (updatesMedia) {
		activeMedia = target;
		if (target.kind === 'video') activeVideo = target;
	}
	if (updatesVideo && target.kind === 'video') activeVideo = target;
	return { activeMedia, activeVideo };
}

const RUNTIME_OWNER_CAPABILITY = 'owned-control-state';
const RUNTIME_RESIDENT_NATIVE_FIELDS = new Set<ControlField>([
	'volumeBase',
	'mediaMuted',
	'speed',
	'preservePitch',
	'loop',
]);

function hasRuntimeOwnedState(snapshot: ControlSnapshot): boolean {
	return Object.entries(snapshot.fields).some(([rawField, state]) => {
		if (!state?.controlled || (state.phase !== 'applied' && state.phase !== 'error')) return false;
		const field = rawField as ControlField;
		if (field === 'audioEnabled') return false;
		if (state.strategy === 'chrome-native'
			|| state.strategy === 'observe' || state.strategy === 'unsupported') return false;
		if (state.strategy === 'dom-native') return RUNTIME_RESIDENT_NATIVE_FIELDS.has(field);
		return true;
	});
}

async function reconcileRuntimeOwnership(snapshot: ControlSnapshot): Promise<void> {
	if (hasRuntimeOwnedState(snapshot)) {
		await ensureContentRuntime(
			snapshot.tabId,
			snapshot.documentId,
			'control',
			RUNTIME_OWNER_CAPABILITY,
		);
		return;
	}
	releaseContentRuntimeLease(
		snapshot.tabId,
		snapshot.documentId,
		'control',
		RUNTIME_OWNER_CAPABILITY,
	);
}

function storageKey(tabId: number): string {
	return `${STORAGE_PREFIX}${tabId}`;
}

function generationKey(tabId: number): string {
	return `${GENERATION_PREFIX}${tabId}`;
}

async function currentIdentity(tabId: number): Promise<{ documentId: string; origin: string }> {
	const frame = await chrome.webNavigation.getFrame({ tabId, frameId: 0 });
	if (!frame?.documentId) throw new Error('The tab has no current document');
	const url = new URL(frame.url);
	if (url.origin === 'null') throw new Error('The current document has no controllable origin');
	return { documentId: frame.documentId, origin: url.origin };
}

function sameMediaTarget(
	left: import('@nexus/contracts').MediaTarget | null,
	right: import('@nexus/contracts').MediaTarget | null,
): boolean {
	return left === right || Boolean(left && right
		&& left.documentId === right.documentId
		&& left.frameId === right.frameId
		&& left.mediaId === right.mediaId
		&& left.sourceRevision === right.sourceRevision
		&& left.kind === right.kind);
}

function nativeObservationFields(
	patch: ControlPatch,
	revision: number,
	observedStrategies: ControlNativeObservationStrategies = {},
): ControlFieldStates {
	const fields: ControlFieldStates = {};
	for (const [rawField, actual] of Object.entries(patch)) {
		const field = rawField as ControlDirectField;
		(fields as Record<string, unknown>)[field] = {
			desired: actual,
			actual,
			revision,
			phase: 'applied',
			strategy: observedStrategies[field] ?? 'dom-native',
			coverage: 'active-target',
			controlled: false,
			lastError: null,
		};
	}
	return fields;
}

async function readPersistedSnapshot(tabId: number): Promise<ControlSnapshot | null> {
	const key = storageKey(tabId);
	const stored = await chrome.storage.session.get(key)
		.catch(() => ({})) as Record<string, unknown>;
	const value = stored[key];
	return isControlSnapshot(value) ? value : null;
}

async function readPersistedGeneration(tabId: number): Promise<number> {
	const key = generationKey(tabId);
	const stored = await chrome.storage.session.get(key)
		.catch(() => ({})) as Record<string, unknown>;
	const value = stored[key];
	return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : 0;
}

async function persistGeneration(tabId: number, generation: number): Promise<void> {
	await chrome.storage.session.set({ [generationKey(tabId)]: generation })
		.catch((error) => swLog.warn('persistGeneration failed', error));
}

async function getSnapshot(tabId: number): Promise<ControlSnapshot | null> {
	const invalidation = invalidations.get(tabId);
	if (invalidation) {
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			await Promise.race([
				invalidation,
				new Promise<void>((resolve) => {
					timer = setTimeout(() => resolve(), 5_000);
				}),
			]);
		} finally {
			if (timer) clearTimeout(timer);
		}
	}
	const known = snapshots.get(tabId) ?? await readPersistedSnapshot(tabId);
	if (!known) return null;
	const identity = await currentIdentity(tabId).catch(() => null);
	if (!identity
		|| known.documentId !== identity.documentId
		|| known.origin !== identity.origin) return null;
	snapshots.set(tabId, known);
	return known;
}

export async function getControlViewSnapshot(tabId: number): Promise<ControlSnapshot | null> {
	const existing = await getSnapshot(tabId);
	const identity = await currentIdentity(tabId).catch(() => null);
	if (!identity) return existing;
	const generation = existing?.generation ?? await readPersistedGeneration(tabId);
	const videoFields = ['pip', 'fullscreen'] as const satisfies readonly ControlDirectField[];
	const mediaFields = [...PAGE_OBSERVABLE_FIELDS]
		.filter((field): field is ControlDirectField => !videoFields.includes(field as typeof videoFields[number]));
	const read = (fields: readonly ControlDirectField[]) => sendSpectraTabRequest(
		tabId,
		'spectra.control.actual.read',
		{ fields, target: null },
		{ documentId: identity.documentId, generation },
	).catch(() => null);
	const [mediaResponse, videoResponse] = await Promise.all([
		read(mediaFields),
		read(videoFields),
	]);
	if (!mediaResponse?.ok && !videoResponse?.ok) return existing;
	const base: ControlSnapshot = existing ?? {
		tabId,
		documentId: identity.documentId,
		origin: identity.origin,
		generation,
		revision: 0,
		activeMedia: null,
		activeVideo: null,
		fields: {},
	};
	const fields = {
		...base.fields,
		...(mediaResponse?.ok ? nativeObservationFields(
			mediaResponse.data.patch,
			base.revision,
			mediaResponse.data.observedStrategies,
		) : {}),
		...(videoResponse?.ok ? nativeObservationFields(
			videoResponse.data.patch,
			base.revision,
			videoResponse.data.observedStrategies,
		) : {}),
	};
	const activeMedia = mediaResponse?.ok
		? mediaResponse.data.target
		: mediaResponse?.error.code === 'capability-unavailable'
			? null
			: base.activeMedia;
	const observedVideo = videoResponse?.ok
		? videoResponse.data.target
		: videoResponse?.error.code === 'capability-unavailable'
			? null
			: base.activeVideo;
	return {
		...base,
		activeMedia,
		activeVideo: observedVideo?.kind === 'video' ? observedVideo : null,
		fields,
	};
}

async function getOrCreateSnapshot(tabId: number): Promise<ControlSnapshot> {
	const existing = await getSnapshot(tabId);
	if (existing) return existing;
	const [identity, persisted, storedGeneration] = await Promise.all([
		currentIdentity(tabId),
		readPersistedSnapshot(tabId),
		readPersistedGeneration(tabId),
	]);
	const generation = persisted
		&& (persisted.documentId !== identity.documentId || persisted.origin !== identity.origin)
		? Math.max(storedGeneration, persisted.generation + 1)
		: storedGeneration;
	if (generation !== storedGeneration) await persistGeneration(tabId, generation);
	return {
		tabId,
		documentId: identity.documentId,
		origin: identity.origin,
		generation,
		revision: 0,
		activeMedia: null,
		activeVideo: null,
		fields: {},
	};
}

function createIntent(
	snapshot: ControlSnapshot,
	request: ResolvedControlSubmitRequest,
): ControlIntent {
	const actualContext: ControlActualContext = {};
	for (const field of ['volumeBase', 'mediaMuted', 'speed', 'preservePitch'] as const) {
		const state = snapshot.fields[field];
		if (state?.phase === 'applied' && state.actual !== null) {
			(actualContext as Record<string, unknown>)[field] = state.actual;
		}
		if (request.source === 'page' && request.patch[field] !== undefined) {
			(actualContext as Record<string, unknown>)[field] = request.patch[field];
		}
	}
	return {
		intentId: crypto.randomUUID(),
		tabId: request.tabId,
		documentId: snapshot.documentId,
		generation: snapshot.generation,
		baseRevision: snapshot.revision,
		source: request.source,
		requestedCoverage: request.requestedCoverage,
		// `null` is an explicit live-active selection. Content resolves it from
		// the current document registry; Background must not silently replace it
		// with a possibly stale snapshot target.
		target: request.target,
		actualContext,
		patch: request.patch,
		...(request.captureAdmission
			? { captureAdmission: request.captureAdmission }
			: {}),
	};
}

function defaultControlValue(field: ControlField): ControlValues[ControlField] {
	switch (field) {
		case 'volumeBase': return 100;
		case 'boost': return 1;
		case 'speed': return 1;
		case 'currentTime': return 0;
		case 'rotation': return 0;
		case 'dimOpacity': return 0.72;
		case 'pan': return 0;
		case 'delay': return 0;
		case 'eqValues': return [0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
		case 'filter': return {
			brightness: 100,
			contrast: 100,
			saturate: 100,
			grayscale: false,
			invert: false,
		};
		case 'abLoop': return { pointA: null, pointB: null, enabled: false };
		default: return false;
	}
}

function normalizeMutationValue(
	field: ControlField,
	value: ControlValues[ControlField],
): ControlValues[ControlField] {
	if (typeof value !== 'number') return value;
	switch (field) {
		case 'volumeBase': return Math.max(0, Math.min(100, value));
		case 'boost': return Math.round(Math.max(1, Math.min(8, value)) * 10) / 10;
		case 'speed': return Math.round(Math.max(0.1, Math.min(16, value)) * 100) / 100;
		case 'currentTime': return Math.max(0, value);
		case 'rotation': return ((Math.round(value / 90) * 90 % 360) + 360) % 360 as 0 | 90 | 180 | 270;
		case 'dimOpacity': return Math.max(0, Math.min(1, value));
		case 'pan': return Math.round(Math.max(-1, Math.min(1, value)) * 100) / 100;
		case 'delay': return Math.round(Math.max(0, Math.min(500, value)));
		default: return value;
	}
}

function applyMutation(
	current: ControlValues[ControlField],
	mutation: ControlMutation,
): ControlValues[ControlField] {
	if (mutation.operation === 'set') {
		return normalizeMutationValue(mutation.field, mutation.value as ControlValues[ControlField]);
	}
	if (mutation.operation === 'toggle') return !current;
	return normalizeMutationValue(
		mutation.field,
		(Number(current) + Number(mutation.value)) as ControlValues[ControlField],
	);
}

async function resolveSubmitRequest(
	snapshot: ControlSnapshot,
	request: RoutedControlSubmitRequest,
): Promise<ResolvedControlSubmitRequest> {
	assertUnambiguousTargetScope(request);
	const patch: ControlPatch = { ...(request.patch ?? {}) };
	const baselines: ControlPatch = {};
	let resolvedTarget = request.target;
	const missingFields = [...new Set((request.mutations ?? [])
		.map((mutation) => mutation.field)
		.filter((field) => patch[field] === undefined
			&& (snapshot.fields[field]?.actual === undefined
				|| request.target === null && field !== 'tabMuted' && field !== 'tabPinned'
					&& (PAGE_OBSERVABLE_FIELDS.has(field) || !AUDIO_PROJECTION_FIELDS.has(field)))))];
	const tabFields = missingFields.filter((field) => field === 'tabMuted' || field === 'tabPinned');
	if (tabFields.length > 0) {
		const tab = await chrome.tabs.get(request.tabId);
		for (const field of tabFields) {
			(baselines as Record<string, unknown>)[field] = field === 'tabMuted'
				? tab.mutedInfo?.muted === true
				: tab.pinned === true;
		}
	}
	const contentFields = missingFields.filter((field) => field !== 'tabMuted' && field !== 'tabPinned');
	if (contentFields.length > 0) {
		const response = await sendSpectraTabRequest(
			request.tabId,
			'spectra.control.actual.read',
			{ fields: contentFields, target: resolvedTarget },
			{ documentId: snapshot.documentId, generation: snapshot.generation },
		);
		if (!response.ok) throw new Error(`${response.error.code}: ${response.error.message}`);
		Object.assign(baselines, response.data.patch);
		resolvedTarget = response.data.target ?? resolvedTarget;
	}
	for (const mutation of request.mutations ?? []) {
		const pending = patch[mutation.field] as ControlValues[ControlField] | undefined;
		const existing = snapshot.fields[mutation.field]?.actual
			?? baselines[mutation.field]
			?? snapshot.fields[mutation.field]?.desired
			?? defaultControlValue(mutation.field);
		(patch as Record<string, unknown>)[mutation.field] = applyMutation(
			pending ?? existing as ControlValues[ControlField],
			mutation,
		);
	}
	if (Object.keys(patch).length === 0) throw new Error('Control request has no effective mutation');
	return {
		tabId: request.tabId,
		source: request.source,
		requestedCoverage: request.requestedCoverage,
		target: resolvedTarget,
		...(request.baseRevision === undefined ? {} : { baseRevision: request.baseRevision }),
		patch,
		...(request.captureAdmission
			? { captureAdmission: request.captureAdmission }
			: {}),
		...(request.observedStrategies === undefined
			? {}
			: { observedStrategies: request.observedStrategies }),
	};
}

function assignFieldState<K extends ControlField>(
	fields: ControlFieldStates,
	field: K,
	desired: ControlValues[K],
	actual: ControlValues[K],
	revision: number,
	intentId: string,
): void {
	const matches = JSON.stringify(desired) === JSON.stringify(actual);
	(fields as Record<string, unknown>)[field] = {
		desired,
		actual,
		revision,
		phase: matches ? 'applied' : 'error',
		strategy: 'chrome-native',
		coverage: 'full',
		controlled: matches,
		intentId,
		lastError: matches
			? null
			: {
				code: 'readback-mismatch',
				message: 'Chrome state differs from the requested value',
				retryable: true,
			},
	};
}

async function applyChromeFields(intent: ControlIntent): Promise<{
	remaining: ControlPatch;
	fields: ControlFieldStates;
}> {
	const remaining = { ...intent.patch };
	const fields: ControlFieldStates = {};
	const revision = intent.baseRevision + 1;

	if (remaining.tabMuted !== undefined) {
		const desired = remaining.tabMuted;
		delete remaining.tabMuted;
		await chrome.tabs.update(intent.tabId, { muted: desired });
		const actual = (await chrome.tabs.get(intent.tabId)).mutedInfo?.muted === true;
		assignFieldState(fields, 'tabMuted', desired, actual, revision, intent.intentId);
	}
	if (remaining.tabPinned !== undefined) {
		const desired = remaining.tabPinned;
		delete remaining.tabPinned;
		await chrome.tabs.update(intent.tabId, { pinned: desired });
		const actual = (await chrome.tabs.get(intent.tabId)).pinned === true;
		assignFieldState(fields, 'tabPinned', desired, actual, revision, intent.intentId);
	}
	return { remaining, fields };
}

function applyPageObservation(
	intent: ControlIntent,
	observedStrategies: ControlNativeObservationStrategies | undefined,
): ControlFieldStates {
	if (intent.requestedCoverage !== 'active-target') {
		throw new Error('A page observation cannot claim full-output coverage');
	}
	if (!observedStrategies) throw new Error('A page observation requires native strategy provenance');
	const patchKeys = Object.keys(intent.patch);
	if (!intent.target
		&& patchKeys.some((field) => !BOOTSTRAP_PAGE_OBSERVABLE_FIELDS.has(field as ControlField))) {
		throw new Error('A targetless bootstrap observation contains a target-bound field');
	}
	const strategyKeys = Object.keys(observedStrategies);
	if (patchKeys.length !== strategyKeys.length
		|| patchKeys.some((field) => !Object.hasOwn(observedStrategies, field))) {
		throw new Error('Page observation strategy provenance must match every patch field');
	}
	const fields: ControlFieldStates = {};
	const revision = intent.baseRevision + 1;
	for (const [rawField, rawValue] of Object.entries(intent.patch)) {
		const field = rawField as ControlDirectField;
		if (!PAGE_OBSERVABLE_FIELDS.has(field)) {
			throw new Error(`Page observation is not admitted for ${field}`);
		}
		(fields as Record<string, unknown>)[field] = {
			desired: rawValue,
			actual: rawValue,
			revision,
			phase: 'applied',
			strategy: observedStrategies[field],
			coverage: 'active-target',
			controlled: false,
			intentId: intent.intentId,
			lastError: null,
		};
	}
	return fields;
}

async function publishSnapshot(snapshot: ControlSnapshot): Promise<void> {
	const previous = snapshots.get(snapshot.tabId);
	snapshots.set(snapshot.tabId, snapshot);
	try {
		await chrome.storage.session.set({ [storageKey(snapshot.tabId)]: snapshot });
	} catch (error) {
		if (previous) snapshots.set(snapshot.tabId, previous);
		else snapshots.delete(snapshot.tabId);
		throw error;
	}
	const event: SpectraEventEnvelope<'spectra.control.snapshot.changed'> = {
		protocolVersion: SPECTRA_PROTOCOL_VERSION,
		type: 'spectra.control.snapshot.changed',
		payload: snapshot,
		tabId: snapshot.tabId,
		documentId: snapshot.documentId,
		generation: snapshot.generation,
	};
	await chrome.runtime.sendMessage(event).catch(() => undefined);
}

function projectControlSessionPatch(fields: ControlFieldStates): ControlSessionPatch {
	const patch: ControlSessionPatch = {};
	for (const field of CONTROL_SESSION_FIELDS) {
		const state = fields[field];
		if (state?.phase !== 'applied' || state.actual === null) continue;
		(patch as Record<string, unknown>)[field] = structuredClone(state.actual);
	}
	return patch;
}

async function persistControlProjection(
	snapshot: ControlSnapshot,
	changedFields: ControlFieldStates,
	userInteracted: boolean,
	acknowledgedSessionPatch: ControlSessionPatch = {},
): Promise<void> {
	const sessionPatch = {
		...projectControlSessionPatch(changedFields),
		...structuredClone(acknowledgedSessionPatch),
	};
	if (Object.keys(sessionPatch).length === 0) return;
	const identity = {
		tabId: snapshot.tabId,
		documentId: snapshot.documentId,
		origin: snapshot.origin,
	};
	await storage.tabSession.merge(snapshot.tabId, sessionPatch, identity);
	if (!Object.keys(sessionPatch).some((field) => AUDIO_PROJECTION_FIELDS.has(field as ControlField))) return;
	const completeSession = await storage.tabSession.get(snapshot.tabId, identity)
		.catch(() => null) ?? sessionPatch;
	const session = await getAudioSession(snapshot.tabId).catch(() => null);
	const isCaptureActive = audioSessionMatchesControlDocument(session, snapshot)
		&& isActiveCaptureLifecycle(session);
	await updateBadgeFromControlProjection(
		snapshot,
		completeSession,
		isCaptureActive,
		userInteracted,
	);
}

// Chrome clears a tab-scoped Action projection during full navigation. Rebuild
// it only after the document initialization barrier has restored the current
// acknowledged session; the badge remains a projection, never another owner.
async function reprojectBadgeForCurrentDocument(tabId: number): Promise<void> {
	const snapshot = await getSnapshot(tabId);
	if (!snapshot) {
		await restoreBadgeUsageForTab(tabId);
		return;
	}
	const identity = {
		tabId: snapshot.tabId,
		documentId: snapshot.documentId,
		origin: snapshot.origin,
	};
	const completeSession = await storage.tabSession.get(tabId, identity)
		.catch(() => null) ?? projectControlSessionPatch(snapshot.fields);
	const session = await getAudioSession(tabId).catch(() => null);
	const isCaptureActive = audioSessionMatchesControlDocument(session, snapshot)
		&& isActiveCaptureLifecycle(session);
	await updateBadgeFromControlProjection(
		snapshot,
		completeSession,
		isCaptureActive,
		false,
	);
}

interface PreparedControlIntent {
	intent: ControlIntent;
	baseline: ControlSnapshot;
	ackTarget: MediaTarget | null;
	activeMedia: ControlSnapshot['activeMedia'];
	activeVideo: ControlSnapshot['activeVideo'];
	fields: ControlFieldStates;
}

interface CommitControlProjection {
	activeVideo?: ControlSnapshot['activeVideo'];
	acknowledgedSessionPatch?: ControlSessionPatch;
}

async function prepareIntent(
	request: RoutedControlSubmitRequest,
	contextSnapshot?: ControlSnapshot,
): Promise<PreparedControlIntent> {
	const snapshot = contextSnapshot ?? await getOrCreateSnapshot(request.tabId);
	if (request.baseRevision !== undefined && request.baseRevision !== snapshot.revision) {
		throw new Error(`Stale control revision: expected ${snapshot.revision}`);
	}
	if (request.target && request.target.documentId !== snapshot.documentId) {
		throw new Error('The selected media target belongs to a stale document');
	}
	if (request.source === 'page' && request.target === null
		&& request.observationDocumentId !== snapshot.documentId) {
		throw new Error('The bootstrap observation belongs to a stale document');
	}

	const resolvedRequest = await resolveSubmitRequest(snapshot, request);
	const intent = createIntent(snapshot, resolvedRequest);
	const pageObservation = intent.source === 'page';
	const chromeResult = pageObservation
		? { remaining: {}, fields: applyPageObservation(intent, resolvedRequest.observedStrategies) }
		: await applyChromeFields(intent);
	let fields: ControlFieldStates = { ...chromeResult.fields };
	let ackTarget = intent.target;
	let activeMedia = snapshot.activeMedia;
	let activeVideo = snapshot.activeVideo;
	if (pageObservation) {
		({ activeMedia, activeVideo } = projectControlTarget(
			snapshot,
			Object.keys(intent.patch) as ControlCapability[],
			intent.target,
		));
	}
	if (pageObservation && typeof intent.patch.volumeBase === 'number') {
		const knownBoost = snapshot.fields.boost?.actual;
		const session = typeof knownBoost === 'number'
			? null
			: await getAudioSession(snapshot.tabId).catch(() => null);
		const sessionMatches = session?.documentId === snapshot.documentId
			&& session.origin === snapshot.origin
			&& session.generation === snapshot.generation;
		const currentBoost = typeof knownBoost === 'number'
			? knownBoost
			: sessionMatches
				? resolveAudioVolume(session.actualConfig).boost
				: 1;
		if (currentBoost !== 1) {
			// A page-side volume gesture owns the public effective-volume value. Reset
			// the hidden processor multiplier once, in the same coordinator commit,
			// so page 50% can never be projected as stale 50% x old Boost.
			const normalizationIntent: ControlIntent = {
				...intent,
				source: 'system',
				requestedCoverage: 'full',
				actualContext: { ...intent.actualContext, volumeBase: intent.patch.volumeBase },
				patch: { boost: 1 },
			};
			const response = await sendSpectraTabRequest(
				intent.tabId,
				'spectra.control.intent.execute',
				normalizationIntent,
				{ documentId: intent.documentId, generation: intent.generation },
			).catch(() => null);
			if (response?.ok
				&& response.data.intentId === intent.intentId
				&& response.data.documentId === intent.documentId
				&& response.data.generation === intent.generation
				&& response.data.revision === intent.baseRevision + 1) {
				fields = { ...fields, ...response.data.fields };
			} else {
				const existingStrategy = snapshot.fields.boost?.strategy;
				const strategy = existingStrategy === 'capture' || existingStrategy === 'media-webaudio'
					? existingStrategy
					: sessionMatches && session.actualMode === 'capture'
						? 'capture'
						: 'media-webaudio';
				fields.boost = {
					desired: 1,
					actual: currentBoost,
					revision: intent.baseRevision + 1,
					phase: 'error',
					strategy,
					coverage: 'full',
					controlled: true,
					intentId: intent.intentId,
					lastError: {
						code: 'strategy-runtime-failed',
						message: response?.ok
							? 'The processor returned a stale Boost reset acknowledgement'
							: response && !response.ok
								? response.error.message
								: 'The processor did not acknowledge the Boost reset',
						retryable: true,
					},
				};
			}
		}
	}
	const routedPatch: ControlPatch = pageObservation ? {} : chromeResult.remaining;
	if (Object.keys(routedPatch).length > 0) {
		// Page observations never echo a second DOM write. The only processor work
		// they may cause is the one-shot hidden Boost normalization above.
		const routedIntent: ControlIntent = {
			...intent,
			source: pageObservation ? 'system' : intent.source,
			patch: routedPatch,
		};
		const response = await sendSpectraTabRequest(
			intent.tabId,
			'spectra.control.intent.execute',
			routedIntent,
			{ documentId: intent.documentId, generation: intent.generation },
		);
		if (!response.ok) throw new Error(`${response.error.code}: ${response.error.message}`);
		if (response.data.intentId !== intent.intentId
			|| response.data.tabId !== intent.tabId
			|| response.data.documentId !== intent.documentId
			|| response.data.generation !== intent.generation
			|| response.data.revision !== intent.baseRevision + 1
			|| response.data.target && response.data.target.documentId !== intent.documentId) {
			throw new Error('Content runtime returned a stale control ACK');
		}
		ackTarget = response.data.target;
		({ activeMedia, activeVideo } = projectControlTarget(
			snapshot,
			Object.keys(routedPatch) as ControlCapability[],
			response.data.target,
		));
		fields = {
			...fields,
			...response.data.fields,
		};
	}

	const baseline = await getOrCreateSnapshot(intent.tabId);
	if (baseline.documentId !== intent.documentId
		|| baseline.generation !== intent.generation
		|| baseline.revision !== intent.baseRevision) {
		throw new Error('Control ACK arrived after the document or revision changed');
	}
	return { intent, baseline, ackTarget, activeMedia, activeVideo, fields };
}

async function commitControlFields(
	baseline: ControlSnapshot,
	fields: ControlFieldStates,
	activeMedia: ControlSnapshot['activeMedia'],
	source: ControlIntent['source'],
	projection: CommitControlProjection = {},
): Promise<ControlSnapshot> {
	const current = await getOrCreateSnapshot(baseline.tabId);
	if (current.documentId !== baseline.documentId
		|| current.generation !== baseline.generation
		|| current.revision !== baseline.revision) {
		throw new Error('Control transaction lost its document or revision before commit');
	}
	const revision = baseline.revision + 1;
	const activeVideo = Object.hasOwn(projection, 'activeVideo')
		? projection.activeVideo ?? null
		: activeMedia?.kind === 'video'
			? activeMedia
			: baseline.activeVideo;
	const committed: ControlSnapshot = {
		...current,
		revision,
		activeMedia,
		activeVideo,
		fields: { ...current.fields, ...fields },
	};
	await persistControlProjection(
		committed,
		fields,
		source !== 'page' && source !== 'restore' && source !== 'system',
		projection.acknowledgedSessionPatch,
	);
	if (source !== 'page' && source !== 'restore' && source !== 'system') {
		await markBadgeUsedForTab(committed.tabId);
	}
	await publishSnapshot(committed);
	await reconcileRuntimeOwnership(committed);
	return committed;
}

async function applyChromeTabObservation(
	tabId: number,
	patch: Pick<ControlPatch, 'tabMuted' | 'tabPinned'>,
): Promise<ControlSnapshot> {
	const baseline = await getOrCreateSnapshot(tabId);
	const fields: ControlFieldStates = {};
	for (const [rawField, actual] of Object.entries(patch)) {
		const field = rawField as 'tabMuted' | 'tabPinned';
		if (typeof actual !== 'boolean') continue;
		const current = baseline.fields[field];
		if (current?.phase === 'applied' && current.actual === actual) continue;
		(fields as Record<string, unknown>)[field] = {
			desired: actual,
			actual,
			revision: baseline.revision + 1,
			phase: 'applied',
			strategy: 'chrome-native',
			coverage: 'full',
			controlled: false,
			intentId: crypto.randomUUID(),
			lastError: null,
		};
	}
	if (Object.keys(fields).length === 0) return baseline;
	return commitControlFields(baseline, fields, baseline.activeMedia, 'page');
}

function observeChromeTabState(
	tabId: number,
	patch: Pick<ControlPatch, 'tabMuted' | 'tabPinned'>,
): Promise<ControlSnapshot> {
	return serialized(tabId, () => applyChromeTabObservation(tabId, patch));
}

async function executeIntent(request: RoutedControlSubmitRequest): Promise<ControlApplyAck> {
	const current = await getOrCreateSnapshot(request.tabId);
	const prepared = await prepareIntent(request, current);
	const { intent, baseline, ackTarget, activeMedia, activeVideo, fields } = prepared;
	const committed = await commitControlFields(
		baseline,
		fields,
		activeMedia,
		intent.source,
		{ activeVideo },
	);
	return {
		intentId: intent.intentId,
		tabId: intent.tabId,
		documentId: intent.documentId,
		generation: intent.generation,
		revision: committed.revision,
		target: ackTarget,
		fields,
	};
}

const RESET_AUDIO_TARGET_PATCH: ControlPatch = {
	volumeBase: 100,
	mediaMuted: false,
};

const RESET_AUDIO_PROCESSOR_PATCH: ControlPatch = {
	// rule: reset clears DSP parameters but keeps the audio enhancement enabled.
	// Closing the master switch on reset discarded the user's enhancement preference
	// and left the page silent until they re-toggled it.
	audioEnabled: true,
	boost: 1,
	eqValues: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
	bass: false,
	compressor: false,
	mono: false,
	pan: 0,
	delay: 0,
};

const RESET_VIDEO_PATCH: ControlPatch = {
	rotation: 0,
	mirrored: false,
	fill: false,
	filterEnabled: false,
	filter: {
		brightness: 100,
		contrast: 100,
		saturate: 100,
		grayscale: false,
		invert: false,
	},
	dimEnabled: false,
	dimOpacity: 0.72,
};

const RESTORABLE_TARGET_FIELDS = [
	'volumeBase', 'mediaMuted', 'speed', 'preservePitch', 'loop',
	'rotation', 'mirrored', 'fill', 'filterEnabled', 'filter', 'dimEnabled', 'dimOpacity',
] as const satisfies readonly ControlDirectField[];

const RESTORABLE_PROCESSOR_FIELDS = [
	'audioEnabled', 'boost', 'eqValues', 'bass', 'compressor', 'mono', 'pan', 'delay',
] as const satisfies readonly ControlDirectField[];

function snapshotActualPatch(
	snapshot: ControlSnapshot,
	fields: readonly ControlDirectField[],
	controlledOnly: boolean,
): ControlPatch {
	const patch: ControlPatch = {};
	for (const field of fields) {
		const state = snapshot.fields[field];
		if (!state || state.actual === null || controlledOnly && !state.controlled) continue;
		(patch as Record<string, unknown>)[field] = structuredClone(state.actual);
	}
	return patch;
}

async function captureActualPatch(
	snapshot: ControlSnapshot,
	target: ControlSnapshot['activeMedia'],
	fields: readonly ControlDirectField[],
	controlledOnly = false,
): Promise<ControlPatch> {
	const patch = snapshotActualPatch(snapshot, fields, controlledOnly);
	const response = await sendSpectraTabRequest(
		snapshot.tabId,
		'spectra.control.actual.read',
		{ fields, target },
		{ documentId: snapshot.documentId, generation: snapshot.generation },
	).catch(() => null);
	if (response?.ok) {
		for (const [rawField, value] of Object.entries(response.data.patch)) {
			const field = rawField as ControlField;
			if (controlledOnly && !snapshot.fields[field]?.controlled) continue;
			(patch as Record<string, unknown>)[field] = value;
		}
	}
	return patch;
}

interface CompensationResult {
	ok: boolean;
	fields: ControlFieldStates;
	error: string | null;
}

async function compensateControlPatch(
	baseline: ControlSnapshot,
	target: ControlSnapshot['activeMedia'],
	targetPatch: ControlPatch,
	processorPatch: ControlPatch,
	order: readonly ('target' | 'processor')[] = ['target', 'processor'],
	captureAdmission?: CaptureAdmission,
): Promise<CompensationResult> {
	const fields: ControlFieldStates = {};
	const failures: string[] = [];
	const isolatedTargetPatch: ControlPatch = { ...targetPatch };
	const stages = {
		target: [isolatedTargetPatch, 'active-target'],
		processor: [processorPatch, 'full'],
	} as const;
	for (const stage of order) {
		const [patch, requestedCoverage] = stages[stage];
		if (Object.keys(patch).length === 0) continue;
		try {
			const prepared = await prepareIntent({
				tabId: baseline.tabId,
				source: 'restore',
				requestedCoverage,
				target,
				patch,
				...(captureAdmission ? { captureAdmission } : {}),
			}, baseline);
			Object.assign(fields, prepared.fields);
			assertAppliedPatch(prepared.fields, patch, 'Compensating rollback');
		} catch (error) {
			failures.push(error instanceof Error ? error.message : String(error));
		}
	}
	return {
		ok: failures.length === 0,
		fields,
		error: failures.length === 0 ? null : failures.join('; '),
	};
}

async function commitCompensationFailure(
	baseline: ControlSnapshot,
	target: ControlSnapshot['activeMedia'],
	rollbackPatch: ControlPatch,
	compensation: CompensationResult,
	originalError: unknown,
): Promise<void> {
	const message = originalError instanceof Error ? originalError.message : String(originalError);
	const intentId = crypto.randomUUID();
	const fields: ControlFieldStates = {};
	for (const [rawField, expected] of Object.entries(rollbackPatch)) {
		const field = rawField as ControlField;
		const rollbackState = compensation.fields[field];
		const previous = baseline.fields[field];
		(fields as Record<string, unknown>)[field] = {
			desired: previous?.desired ?? expected,
			actual: rollbackState?.actual ?? null,
			revision: baseline.revision + 1,
			phase: 'error',
			strategy: rollbackState?.strategy ?? previous?.strategy ?? 'unsupported',
			coverage: rollbackState?.coverage ?? previous?.coverage ?? 'partial',
			controlled: false,
			intentId,
			lastError: {
				code: 'transaction-rollback-failed',
				message: `${message}; rollback: ${compensation.error ?? 'unknown failure'}`,
				retryable: true,
			},
		};
	}
	await commitControlFields(baseline, fields, target, 'system');
}

function operationIntent(
	snapshot: ControlSnapshot,
	request: RoutedControlOperationRequest,
	operationId: string,
): ControlOperationIntent {
	return {
		operationId,
		tabId: request.tabId,
		documentId: snapshot.documentId,
		generation: snapshot.generation,
		baseRevision: snapshot.revision,
		source: request.source,
		// Preserve the same nullable live-active semantic used by field intents.
		target: request.target,
		operation: request.operation,
		payload: request.payload,
	} as ControlOperationIntent;
}

interface PreparedContentOperation {
	intent: ControlOperationIntent;
	baseline: ControlSnapshot;
	acknowledgement: ControlOperationAck;
}

function stageSnapshot(
	baseline: ControlSnapshot,
	fields: ControlFieldStates,
	activeMedia: ControlSnapshot['activeMedia'],
): ControlSnapshot {
	return {
		...baseline,
		activeMedia: activeMedia ?? baseline.activeMedia,
		activeVideo: activeMedia?.kind === 'video' ? activeMedia : baseline.activeVideo,
		fields: { ...baseline.fields, ...fields },
	};
}

function assertAppliedPatch(
	fields: ControlFieldStates,
	patch: ControlPatch,
	label: string,
): void {
	assertAppliedFields(fields, Object.keys(patch) as ControlField[], label);
}

function assertReleasedPatch(
	fields: ControlFieldStates,
	patch: ControlPatch,
	label: string,
): void {
	for (const field of Object.keys(patch) as ControlField[]) {
		const state = fields[field];
		if (state?.phase === 'applied'
			|| (state?.phase === 'idle'
				&& JSON.stringify(state.actual) === JSON.stringify(patch[field as keyof ControlPatch]))) {
			continue;
		}
		const detail = state?.lastError
			? `${state.lastError.code}: ${state.lastError.message}`
			: 'missing released field acknowledgement';
		throw new Error(`${label} failed for ${field}: ${detail}`);
	}
}

function assertAppliedFields(
	fields: ControlFieldStates,
	requiredFields: readonly ControlField[],
	label: string,
): void {
	for (const field of requiredFields) {
		const state = fields[field];
		if (state?.phase === 'applied') continue;
		const detail = state?.lastError
			? `${state.lastError.code}: ${state.lastError.message}`
			: 'missing actual field acknowledgement';
		throw new Error(`${label} failed for ${field}: ${detail}`);
	}
}

async function prepareContentOperation(
	request: RoutedControlOperationRequest,
	operationId: string,
	contextSnapshot?: ControlSnapshot,
): Promise<PreparedContentOperation> {
	const snapshot = contextSnapshot ?? await getOrCreateSnapshot(request.tabId);
	const intent = operationIntent(snapshot, request, operationId);
	const response = await sendSpectraTabRequest(
		request.tabId,
		'spectra.control.operation.execute',
		intent,
		{ documentId: intent.documentId, generation: intent.generation },
	);
	if (!response.ok) throw new Error(`${response.error.code}: ${response.error.message}`);
	const ack = response.data;
	if (ack.operationId !== operationId
		|| ack.operation !== request.operation
		|| ack.documentId !== intent.documentId
		|| ack.generation !== intent.generation
		|| ack.revision !== intent.baseRevision + 1) {
		throw new Error('Content runtime returned a stale control operation ACK');
	}
	const current = await getOrCreateSnapshot(request.tabId);
	if (current.documentId !== intent.documentId
		|| current.generation !== intent.generation
		|| current.revision !== intent.baseRevision) {
		throw new Error('Control operation ACK arrived after the document or revision changed');
	}
	return { intent, baseline: current, acknowledgement: ack };
}

async function commitContentOperation(
	prepared: PreparedContentOperation,
	source: ControlOperationIntent['source'],
): Promise<ControlOperationAck> {
	const { intent, baseline, acknowledgement } = prepared;
	const projection = intent.operation === 'ab-clear' && source === 'restore'
		? { activeMedia: baseline.activeMedia, activeVideo: baseline.activeVideo }
		: projectControlTarget(baseline, [intent.operation], acknowledgement.target);
	const committed = await commitControlFields(
		baseline,
		acknowledgement.fields,
		projection.activeMedia,
		source,
		{ activeVideo: projection.activeVideo },
	);
	if (committed.revision !== intent.baseRevision + 1) {
		throw new Error('Control operation committed an unexpected revision');
	}
	return { ...acknowledgement, revision: committed.revision } as ControlOperationAck;
}

async function routeContentOperation(
	request: RoutedControlOperationRequest,
	operationId: string,
): Promise<ControlOperationAck> {
	const acknowledgement = await commitContentOperation(
		await prepareContentOperation(request, operationId),
		request.source,
	);
	reconcileOperationSourceOwnership(acknowledgement);
	return acknowledgement;
}

function reconcileOperationSourceOwnership(ack: ControlOperationAck): void {
	const target = ack.target;
	if (!target) return;
	if (ack.operation === 'marker-add') {
		if (ack.result.remaining > 0) retainSourceRuntimeLease(ack.tabId, target, 'marker');
		return;
	}
	if (ack.operation === 'marker-remove') {
		if (ack.result.remaining === 0) releaseSourceRuntimeLease(ack.tabId, target, 'marker');
		return;
	}
	if (ack.operation === 'ab-set-a' || ack.operation === 'ab-set-b') {
		retainSourceRuntimeLease(ack.tabId, target, 'ab');
		return;
	}
	if (ack.operation === 'ab-clear') releaseSourceRuntimeLease(ack.tabId, target, 'ab');
}

async function handleSourceReleased(tabId: number, target: import('@nexus/contracts').MediaTarget): Promise<void> {
	releaseSourceRuntimeLease(tabId, target, 'marker');
	releaseSourceRuntimeLease(tabId, target, 'ab');
	const snapshot = await getSnapshot(tabId);
	if (!snapshot || snapshot.documentId !== target.documentId) return;
	const ownsActiveSource = snapshot.activeMedia?.mediaId === target.mediaId
		&& snapshot.activeMedia.sourceRevision === target.sourceRevision;
	const ownsActiveVideo = snapshot.activeVideo?.mediaId === target.mediaId
		&& snapshot.activeVideo.sourceRevision === target.sourceRevision;
	const ab = snapshot.fields.abLoop;
	if (!ownsActiveSource && !ownsActiveVideo
		&& (!ab || ab.phase === 'idle' || !ab.controlled)) return;
	const intentId = crypto.randomUUID();
	const fields: ControlFieldStates = ab && (ownsActiveSource || snapshot.activeMedia === null)
		? {
			abLoop: {
				desired: null,
				actual: { pointA: null, pointB: null, enabled: false },
				revision: snapshot.revision + 1,
				phase: 'idle',
				strategy: 'extension-state',
				coverage: 'active-target',
				controlled: false,
				intentId,
				lastError: null,
			},
		}
		: {};
	await commitControlFields(
		snapshot,
		fields,
		ownsActiveSource ? null : snapshot.activeMedia,
		'system',
		{ activeVideo: ownsActiveVideo ? null : snapshot.activeVideo },
	);
}

async function handleTargetChanged(
	tabId: number,
	target: import('@nexus/contracts').MediaTarget,
): Promise<void> {
	const baseline = await getOrCreateSnapshot(tabId);
	if (target.frameId !== 0 || target.documentId !== baseline.documentId) {
		throw new Error('Active media selection belongs to a stale or unsupported frame');
	}
	if (sameMediaTarget(baseline.activeMedia, target)
		&& (target.kind !== 'video' || sameMediaTarget(baseline.activeVideo, target))) return;
	const response = await sendSpectraTabRequest(
		tabId,
		'spectra.control.actual.read',
		{
			fields: [...PAGE_OBSERVABLE_FIELDS] as ControlDirectField[],
			target,
		},
		{ documentId: baseline.documentId, generation: baseline.generation },
	);
	if (!response.ok || !sameMediaTarget(response.data.target, target)) {
		throw new Error(response.ok
			? 'Active media readback resolved a different source'
			: `${response.error.code}: ${response.error.message}`);
	}
	const fields = nativeObservationFields(
		response.data.patch,
		baseline.revision + 1,
		response.data.observedStrategies,
	);
	await commitControlFields(baseline, fields, target, 'page');
}

async function commitBackgroundOperation<O extends Extract<
	ControlOperationRequest['operation'],
	'open-popup' | 'open-options' | 'open-url' | 'run-user-script'
>>(
	request: RoutedControlOperationRequest & { operation: O },
	operationId: string,
	strategy: 'chrome-native' | 'extension-state',
	result: ControlOperationResult<O>,
	expected: Pick<ControlSnapshot, 'documentId' | 'generation'>,
): Promise<ControlOperationAck<O>> {
	const current = await getOrCreateSnapshot(request.tabId);
	if (current.documentId !== expected.documentId || current.generation !== expected.generation) {
		throw new Error('Background operation completed after its target document changed');
	}
	const revision = current.revision + 1;
	const committed = { ...current, revision };
	await publishSnapshot(committed);
	const acknowledgement: ControlOperationAck<O> = {
		operationId,
		tabId: request.tabId,
		documentId: committed.documentId,
		generation: committed.generation,
		revision,
		// Extension UI, URL and sandbox operations do not own a media source.
		// Returning the active media here would falsely project a media-scoped ACK
		// into Popup/remote reducers even though no media writer ran.
		target: null,
		operation: request.operation,
		strategy,
		coverage: 'full',
		fields: {},
		result,
	};
	return acknowledgement;
}

async function currentOperationTab(
	tabId: number,
	documentId: string,
): Promise<chrome.tabs.Tab> {
	const identity = await currentIdentity(tabId);
	if (identity.documentId !== documentId) {
		throw new Error('Background operation belongs to a stale document');
	}
	const tab = await chrome.tabs.get(tabId);
	if (tab.id !== tabId || !Number.isInteger(tab.windowId)) {
		throw new Error('Background operation target tab is unavailable');
	}
	return tab;
}

function normalizeHttpUrl(value: string): string {
	if (value.length === 0 || value.length > 8_192) throw new Error('Invalid URL');
	const url = new URL(value);
	if (url.protocol !== 'http:' && url.protocol !== 'https:') {
		throw new Error('Only HTTP(S) URLs may be opened');
	}
	return url.href;
}

async function executeFieldOperation(
	request: RoutedControlOperationRequest,
	operationId: string,
): Promise<ControlOperationAck> {
	const common = {
		tabId: request.tabId,
		source: request.source,
		target: request.target,
		...(request.captureAdmission
			? { captureAdmission: request.captureAdmission }
			: {}),
	} as const;
	if (request.operation === 'effective-volume') {
		const baseline = await getOrCreateSnapshot(request.tabId);
		const snapshotActual = (field: 'volumeBase' | 'boost'): number | null => {
			const actual = baseline.fields[field]?.actual;
			return typeof actual === 'number' ? actual : null;
		};
		const knownVolumeBase = snapshotActual('volumeBase');
		const knownBoost = snapshotActual('boost');
		// ControlSnapshot is the actual-value owner. Only a cold snapshot needs one
		// Content readback; established and repeated slider samples avoid that IPC.
		const readback = knownVolumeBase === null || knownBoost === null
			? await sendSpectraTabRequest(
				request.tabId,
				'spectra.control.actual.read',
				{ fields: ['volumeBase', 'boost'], target: request.target },
				{ documentId: baseline.documentId, generation: baseline.generation },
			).catch(() => null)
			: null;
		const actualField = <K extends 'volumeBase' | 'boost'>(field: K): number | null => {
			const direct = readback?.ok ? readback.data.patch[field] : undefined;
			if (typeof direct === 'number') return direct;
			const known = field === 'volumeBase' ? knownVolumeBase : knownBoost;
			return known;
		};
		const currentVolumeBase = actualField('volumeBase');
		if (currentVolumeBase === null) {
			throw new Error('Effective volume requires an observable page or standard native volume');
		}
		const current = {
			volumeBase: currentVolumeBase,
			boost: actualField('boost') ?? 1,
		};
		const currentEffective = compileEffectiveVolume(current.volumeBase, current.boost);
		const desiredEffective = Math.max(0, Math.min(800,
			request.payload.operation === 'delta'
				? currentEffective + request.payload.value
				: request.payload.value,
		));
		const desired = splitEffectiveVolume(desiredEffective);
		let target = readback?.ok ? readback.data.target : request.target ?? baseline.activeMedia;
		const targetPatch: ControlPatch = current.volumeBase === desired.volumeBase
			? {}
			: { volumeBase: desired.volumeBase };
		const processorPatch: ControlPatch = current.boost === desired.boost
			? {}
			: { boost: desired.boost };
		const stageOrder: readonly ('target' | 'processor')[] = current.boost !== 1
			&& desired.boost === 1
			&& Object.keys(targetPatch).length > 0
			? ['processor', 'target']
			: ['target', 'processor'];

		// A repeated slider sample at the already acknowledged value is a true
		// no-op: no content IPC, no storage write and no synthetic revision.
		if (Object.keys(targetPatch).length === 0 && Object.keys(processorPatch).length === 0) {
			return {
				operationId,
				tabId: request.tabId,
				documentId: baseline.documentId,
				generation: baseline.generation,
				revision: baseline.revision,
				target,
				operation: request.operation,
				strategy: 'extension-state',
				coverage: desired.boost === 1 ? 'active-target' : 'full',
				fields: {},
				result: { effectiveVolume: currentEffective, ...current },
			};
		}

		let fields: ControlFieldStates = {};
		try {
			let staged = baseline;
			for (const stage of stageOrder) {
				const patch = stage === 'target' ? targetPatch : processorPatch;
				if (Object.keys(patch).length === 0) continue;
				const prepared = await prepareIntent({
					...common,
					target,
					requestedCoverage: stage === 'target' ? 'active-target' : 'full',
					patch,
				}, staged);
				fields = { ...fields, ...prepared.fields };
				if (stage === 'target') {
					assertAppliedPatch(prepared.fields, patch, 'Effective volume native stage');
				} else if (desired.boost === 1) {
					assertReleasedPatch(prepared.fields, patch, 'Effective volume processor release');
				} else {
					assertAppliedPatch(prepared.fields, patch, 'Effective volume processor stage');
				}
				target = prepared.ackTarget ?? target;
				staged = stageSnapshot(baseline, fields, target);
			}
			const actualVolumeBase = typeof fields.volumeBase?.actual === 'number'
				? fields.volumeBase.actual
				: current.volumeBase;
			const actualBoost = typeof fields.boost?.actual === 'number'
				? fields.boost.actual
				: current.boost;
			const effectiveVolume = compileEffectiveVolume(actualVolumeBase, actualBoost);
			const committed = await commitControlFields(
				baseline,
				fields,
				target,
				request.source,
				{
					// Effective volume is one public value backed by two actual
					// fields. Persist the complete read-back pair even when one
					// component was already correct and needed no writer stage.
					acknowledgedSessionPatch: {
						volumeBase: actualVolumeBase,
						boost: actualBoost,
					},
				},
			);
			return {
				operationId,
				tabId: request.tabId,
				documentId: committed.documentId,
				generation: committed.generation,
				revision: committed.revision,
				target,
				operation: request.operation,
				strategy: 'extension-state',
				coverage: Object.keys(processorPatch).length > 0 ? 'full' : 'active-target',
				fields,
				result: { effectiveVolume, volumeBase: actualVolumeBase, boost: actualBoost },
			};
		} catch (error) {
			const compensation = await compensateControlPatch(
				baseline,
				target,
				targetPatch.volumeBase === undefined ? {} : { volumeBase: current.volumeBase },
				processorPatch.boost === undefined ? {} : { boost: current.boost },
				[...stageOrder].reverse(),
				request.captureAdmission,
			);
			if (!compensation.ok) {
				await commitCompensationFailure(
					baseline,
					target,
					{ volumeBase: current.volumeBase, boost: current.boost },
					compensation,
					error,
				);
			}
			throw error;
		}
	}
	if (request.operation === 'playback-toggle') {
		const fieldAck = await executeIntent({
			...common,
			requestedCoverage: 'active-target',
			mutations: [{ field: 'playing', operation: 'toggle' }],
		});
		assertAppliedFields(fieldAck.fields, ['playing'], 'Playback toggle');
		const playing = fieldAck.fields.playing?.actual;
		if (typeof playing !== 'boolean') throw new Error('Playback toggle did not return actual state');
		return {
			operationId,
			tabId: request.tabId,
			documentId: fieldAck.documentId,
			generation: fieldAck.generation,
			revision: fieldAck.revision,
			target: fieldAck.target,
			operation: request.operation,
			strategy: fieldAck.fields.playing?.strategy ?? 'unsupported',
			coverage: fieldAck.fields.playing?.coverage ?? 'partial',
			fields: fieldAck.fields,
			result: { playing },
		};
	}
	if (request.operation === 'seek-relative') {
		const fieldAck = await executeIntent({
			...common,
			requestedCoverage: 'active-target',
			mutations: [{ field: 'currentTime', operation: 'delta', value: request.payload.delta }],
		});
		assertAppliedFields(fieldAck.fields, ['currentTime'], 'Relative seek');
		const currentTime = fieldAck.fields.currentTime?.actual;
		if (typeof currentTime !== 'number') throw new Error('Relative seek did not return actual state');
		return {
			operationId,
			tabId: request.tabId,
			documentId: fieldAck.documentId,
			generation: fieldAck.generation,
			revision: fieldAck.revision,
			target: fieldAck.target,
			operation: request.operation,
			strategy: fieldAck.fields.currentTime?.strategy ?? 'unsupported',
			coverage: fieldAck.fields.currentTime?.coverage ?? 'partial',
			fields: fieldAck.fields,
			result: { currentTime },
		};
	}
	if (request.operation === 'audio-reset') {
		const baseline = await getOrCreateSnapshot(request.tabId);
		let target = request.target ?? baseline.activeMedia;
		if (!target) {
			// Snapshot state may legitimately be empty before the first Popup action.
			// Resolve one standard field only to discover the actual active media; a
			// page without media is non-fatal because the processor still must release.
			const observed = await sendSpectraTabRequest(
				request.tabId,
				'spectra.control.actual.read',
				{ fields: ['volumeBase'], target: null },
				{ documentId: baseline.documentId, generation: baseline.generation },
			).catch(() => null);
			if (observed?.ok) target = observed.data.target;
		}
		const targetActual = await captureActualPatch(
			baseline,
			target,
			[
				...Object.keys(RESET_AUDIO_TARGET_PATCH) as ControlDirectField[],
				'preservePitch',
			],
		);
		const targetRollback: ControlPatch = {};
		for (const field of Object.keys(RESET_AUDIO_TARGET_PATCH) as ControlDirectField[]) {
			const value = targetActual[field];
			if (value !== undefined) (targetRollback as Record<string, unknown>)[field] = value;
		}
		const processorRollback = await captureActualPatch(
			baseline,
			target,
			Object.keys(RESET_AUDIO_PROCESSOR_PATCH) as ControlDirectField[],
		);
		let staged = baseline;
		let fields: ControlFieldStates = {};
		try {
			const targetPrepared = await prepareIntent({
				...common,
				target,
				requestedCoverage: 'active-target',
				patch: RESET_AUDIO_TARGET_PATCH,
			}, staged);
			const targetUnavailable = target === null
				&& (Object.keys(RESET_AUDIO_TARGET_PATCH) as ControlDirectField[]).every((field) => {
					const failure = targetPrepared.fields[field]?.lastError;
					return Boolean(failure
						&& (failure.code === 'capability-unavailable' || failure.code === 'strategy-runtime-failed')
						&& failure.message.includes('No active media target'));
				});
			if (!targetUnavailable) {
				assertAppliedPatch(targetPrepared.fields, RESET_AUDIO_TARGET_PATCH, 'Audio target reset');
				target = targetPrepared.ackTarget ?? targetPrepared.activeMedia ?? target;
				fields = { ...fields, ...targetPrepared.fields };
				// Reset explicitly normalizes playback speed. Pitch preservation is
				// observation-only and is carried into the processor's native context.
				staged = stageSnapshot(baseline, {
					...nativeObservationFields(targetActual, baseline.revision),
					...fields,
				}, targetPrepared.activeMedia ?? target);
			}
			const processorPrepared = await prepareIntent({
				...common,
				target,
				requestedCoverage: 'full',
				patch: RESET_AUDIO_PROCESSOR_PATCH,
			}, staged);
			fields = { ...fields, ...processorPrepared.fields };
			assertReleasedPatch(
				processorPrepared.fields,
				RESET_AUDIO_PROCESSOR_PATCH,
				'Audio processor reset',
			);
			const committed = await commitControlFields(
				baseline,
				fields,
				target,
				request.source,
			);
			return {
				operationId,
				tabId: request.tabId,
				documentId: committed.documentId,
				generation: committed.generation,
				revision: committed.revision,
				target,
				operation: request.operation,
				strategy: 'extension-state',
				coverage: 'full',
				fields,
				result: { reset: true },
			};
		} catch (error) {
			const compensation = await compensateControlPatch(
				baseline,
				target,
				targetRollback,
				processorRollback,
				undefined,
				request.captureAdmission,
			);
			if (!compensation.ok) {
				await commitCompensationFailure(
					baseline,
					target,
					{ ...targetRollback, ...processorRollback },
					compensation,
					error,
				);
			}
			throw error;
		}
	}
	if (request.operation === 'video-effects-toggle') {
		const fieldAck = await executeIntent({
			...common,
			requestedCoverage: 'active-target',
			mutations: [{ field: 'filterEnabled', operation: 'toggle' }],
		});
		assertAppliedFields(fieldAck.fields, ['filterEnabled'], 'Video effects toggle');
		const enabled = fieldAck.fields.filterEnabled?.actual;
		if (typeof enabled !== 'boolean') throw new Error('Video effects toggle did not return actual state');
		return {
			operationId,
			tabId: request.tabId,
			documentId: fieldAck.documentId,
			generation: fieldAck.generation,
			revision: fieldAck.revision,
			target: fieldAck.target,
			operation: request.operation,
			strategy: fieldAck.fields.filterEnabled?.strategy ?? 'unsupported',
			coverage: fieldAck.fields.filterEnabled?.coverage ?? 'partial',
			fields: fieldAck.fields,
			result: { enabled },
		};
	}
	if (request.operation === 'video-effects-reset') {
		const fieldAck = await executeIntent({
			...common,
			requestedCoverage: 'active-target',
			patch: RESET_VIDEO_PATCH,
		});
		assertAppliedPatch(fieldAck.fields, RESET_VIDEO_PATCH, 'Video effects reset');
		return {
			operationId,
			tabId: request.tabId,
			documentId: fieldAck.documentId,
			generation: fieldAck.generation,
			revision: fieldAck.revision,
			target: fieldAck.target,
			operation: request.operation,
			strategy: 'extension-state',
			coverage: 'active-target',
			fields: fieldAck.fields,
			result: { reset: true },
		};
	}
	throw new Error(`Operation ${request.operation} is not a field operation`);
}

async function executeControlOperation(
	request: RoutedControlOperationRequest,
): Promise<ControlOperationAck> {
	const snapshot = await getOrCreateSnapshot(request.tabId);
	if (request.baseRevision !== undefined && request.baseRevision !== snapshot.revision) {
		throw new Error(`Stale control revision: expected ${snapshot.revision}`);
	}
	if (request.target && request.target.documentId !== snapshot.documentId) {
		throw new Error('The selected media target belongs to a stale document');
	}
	const operationId = crypto.randomUUID();
	if (request.operation === 'playback-toggle'
		|| request.operation === 'effective-volume'
		|| request.operation === 'seek-relative'
		|| request.operation === 'audio-reset'
		|| request.operation === 'video-effects-toggle'
		|| request.operation === 'video-effects-reset') {
		return executeFieldOperation(request, operationId);
	}
	if (request.operation === 'open-popup') {
		const tab = await currentOperationTab(request.tabId, snapshot.documentId);
		await chrome.action.openPopup({ windowId: tab.windowId });
		return commitBackgroundOperation(request, operationId, 'chrome-native', { opened: true }, snapshot);
	}
	if (request.operation === 'open-options') {
		await chrome.runtime.openOptionsPage();
		return commitBackgroundOperation(request, operationId, 'chrome-native', { opened: true }, snapshot);
	}
	if (request.operation === 'open-url') {
		const tab = await currentOperationTab(request.tabId, snapshot.documentId);
		await chrome.tabs.create({
			url: normalizeHttpUrl(request.payload.url),
			windowId: tab.windowId,
			index: tab.index + 1,
			openerTabId: request.tabId,
			active: true,
		});
		return commitBackgroundOperation(request, operationId, 'chrome-native', { opened: true }, snapshot);
	}
	if (request.operation === 'run-user-script') {
		const result = await executeUserScriptInTab(
			request.tabId,
			snapshot.documentId,
			request.payload.script,
		);
		if (!result.success) throw new Error(result.error ?? 'User script execution failed');
		return commitBackgroundOperation(request, operationId, 'extension-state', { executed: true }, snapshot);
	}
	if (request.operation === 'restore-page-settings') {
		const baseline = await getOrCreateSnapshot(request.tabId);
		const target = request.target ?? baseline.activeMedia;
		const targetRollback = await captureActualPatch(
			baseline,
			target,
			RESTORABLE_TARGET_FIELDS,
			true,
		);
		const processorRollback = await captureActualPatch(
			baseline,
			target,
			RESTORABLE_PROCESSOR_FIELDS,
		);
		let fields: ControlFieldStates = {};
		try {
			const contentRequest = {
				...request,
				payload: {},
			} as RoutedControlOperationRequest;
			const preparedRelease = await prepareContentOperation(contentRequest, operationId, baseline);
			const released = preparedRelease.acknowledgement as ControlOperationAck<'restore-page-settings'>;
			fields = { ...fields, ...released.fields };
			const staged = stageSnapshot(baseline, fields, released.target);
			const processorPrepared = await prepareIntent({
				tabId: request.tabId,
				source: request.source,
				requestedCoverage: 'full',
				target: released.target,
				patch: RESET_AUDIO_PROCESSOR_PATCH,
				...(request.captureAdmission
					? { captureAdmission: request.captureAdmission }
					: {}),
			}, staged);
			fields = { ...fields, ...processorPrepared.fields };
			assertReleasedPatch(
				processorPrepared.fields,
				RESET_AUDIO_PROCESSOR_PATCH,
				'Page processor release',
			);
			const committed = await commitControlFields(
				baseline,
				fields,
				released.target,
				request.source,
			);
			return {
				...released,
				revision: committed.revision,
				fields,
				result: {
					releasedFields: [
						...new Set([
							...released.result.releasedFields,
							...Object.keys(processorPrepared.fields) as ControlField[],
						]),
					],
				},
			} as ControlOperationAck<'restore-page-settings'>;
		} catch (error) {
			const compensation = await compensateControlPatch(
				baseline,
				target,
				targetRollback,
				processorRollback,
				undefined,
				request.captureAdmission,
			);
			if (!compensation.ok) {
				await commitCompensationFailure(
					baseline,
					target,
					{ ...targetRollback, ...processorRollback },
					compensation,
					error,
				);
			}
			throw error;
		}
	}
	return routeContentOperation(request, operationId);
}

async function captureAdmissionForCurrentTab(tabId: number): Promise<CaptureAdmission | undefined> {
	const tabs = await chrome.tabs.query({ active: true, currentWindow: true }).catch(() => []);
	return tabs[0]?.id === tabId ? EXTENSION_INVOCATION_ADMISSION : undefined;
}

function submitSerialized(
	request: RoutedControlSubmitRequest,
	extensionInvoked = false,
): Promise<ControlApplyAck> {
	const initialize = request.source === 'restore'
		|| request.source === 'page' && request.target !== null
		? Promise.resolve()
		: awaitDocumentInitialization(request.tabId, request.observationDocumentId);
	return initialize.then(() => serialized(request.tabId, async () => {
		const unadmittedRequest = { ...request };
		Reflect.deleteProperty(unadmittedRequest, 'captureAdmission');
		const captureAdmission = extensionInvoked
			? await captureAdmissionForCurrentTab(request.tabId)
			: undefined;
		const acknowledgement = await executeIntent({
			...unadmittedRequest,
			...(captureAdmission ? { captureAdmission } : {}),
		});
		if (!isControlApplyAck(acknowledgement)) {
			throw new Error('Control executor returned a strategy outside the capability policy');
		}
		return acknowledgement;
	}));
}

function submitOperationSerialized(
	request: RoutedControlOperationRequest,
	extensionInvoked = false,
): Promise<ControlOperationAck> {
	const initialize = request.source === 'restore'
		? Promise.resolve()
		: awaitDocumentInitialization(request.tabId);
	return initialize.then(() => serialized(request.tabId, async () => {
		const unadmittedRequest = { ...request };
		Reflect.deleteProperty(unadmittedRequest, 'captureAdmission');
		const captureAdmission = extensionInvoked
			? await captureAdmissionForCurrentTab(request.tabId)
			: undefined;
		const acknowledgement = await executeControlOperation({
			...unadmittedRequest,
			...(captureAdmission ? { captureAdmission } : {}),
		});
		if (!isControlOperationAck(acknowledgement)) {
			throw new Error('Control operation returned a strategy outside the capability policy');
		}
		await markBadgeUsedForTab(request.tabId);
		return acknowledgement;
	}));
}

export function submitControlRequest(request: RoutedControlSubmitRequest): Promise<ControlApplyAck> {
	return submitSerialized(request);
}

export function submitControlOperation(
	request: RoutedControlOperationRequest,
): Promise<ControlOperationAck> {
	return submitOperationSerialized(request);
}

export function submitExtensionInvokedControlRequest(
	request: RoutedControlSubmitRequest & { source: 'popup' | 'hotkey' },
): Promise<ControlApplyAck> {
	return submitSerialized(request, true);
}

export function submitExtensionInvokedControlOperation(
	request: RoutedControlOperationRequest & { source: 'popup' | 'hotkey' },
): Promise<ControlOperationAck> {
	return submitOperationSerialized(request, true);
}

function isExtensionPopupSender(sender: chrome.runtime.MessageSender): boolean {
	return sender.tab === undefined
		&& sender.url === chrome.runtime.getURL('popup.html');
}

async function removeTab(tabId: number): Promise<void> {
	snapshots.delete(tabId);
	invalidations.delete(tabId);
	await chrome.storage.session.remove([
		storageKey(tabId),
		generationKey(tabId),
	]).catch(() => undefined);
}

function invalidateNavigation(tabId: number, preserveDocumentState = false): Promise<void> {
	const previous = invalidations.get(tabId) ?? Promise.resolve();
	const operation = previous.then(async () => {
		const [memory, persisted, storedGeneration] = await Promise.all([
			Promise.resolve(snapshots.get(tabId) ?? null),
			readPersistedSnapshot(tabId),
			readPersistedGeneration(tabId),
		]);
		const generation = Math.max(
			storedGeneration,
			memory?.generation ?? 0,
			persisted?.generation ?? 0,
		) + 1;
		const previousSnapshot = memory ?? persisted;
		if (preserveDocumentState && previousSnapshot) {
			const revision = previousSnapshot.revision + 1;
			const carried: ControlSnapshot = {
				...previousSnapshot,
				generation,
				revision,
				fields: Object.fromEntries(Object.entries(previousSnapshot.fields).map(([field, state]) => [
					field,
					state ? { ...state, revision } : state,
				])) as ControlFieldStates,
			};
			await persistGeneration(tabId, generation);
			await publishSnapshot(carried);
			await reconcileRuntimeOwnership(carried);
			return;
		}
		snapshots.delete(tabId);
		await Promise.all([
			persistGeneration(tabId, generation),
			chrome.storage.session.remove([
				storageKey(tabId),
			]),
		]);
	}).finally(() => {
		if (invalidations.get(tabId) === operation) invalidations.delete(tabId);
	});
	invalidations.set(tabId, operation);
	return operation;
}

export function initializeControlCoordinator(): void {
	if (initialized) return;
	initialized = true;
	chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
		if (!message || typeof message !== 'object') return false;
		const candidate = message as { protocolVersion?: unknown; type?: unknown };
		const isControlMessage = candidate.type === 'spectra.control.snapshot.get'
			|| candidate.type === 'spectra.control.intent.submit'
			|| candidate.type === 'spectra.control.operation.submit'
			|| candidate.type === 'spectra.content.source.released'
			|| candidate.type === 'spectra.content.target.changed';
		if (candidate.protocolVersion !== SPECTRA_PROTOCOL_VERSION || !isControlMessage) return false;
		if (sender.id && sender.id !== chrome.runtime.id) {
			sendResponse(rpcFailure('forbidden', 'Control coordinator RPC is extension-internal only'));
			return false;
		}
		if (!isSpectraRequestEnvelope(message)
			|| (message.type !== 'spectra.control.snapshot.get'
				&& message.type !== 'spectra.control.intent.submit'
				&& message.type !== 'spectra.control.operation.submit'
				&& message.type !== 'spectra.content.source.released'
				&& message.type !== 'spectra.content.target.changed')) {
			sendResponse(rpcFailure('invalid_request', 'Malformed control coordinator request'));
			return false;
		}

		if (message.type === 'spectra.content.source.released') {
			const tabId = sender.tab?.id;
			if (!tabId || sender.documentId !== message.payload.target.documentId) {
				sendResponse(rpcFailure('forbidden', 'Source lifecycle must match its sending document'));
				return false;
			}
			void serialized(tabId, () => handleSourceReleased(tabId, message.payload.target)).then(
				() => sendResponse(rpcSuccess({ accepted: true as const })),
				(error) => sendResponse(rpcFailure(
					'source_release_failed',
					error instanceof Error ? error.message : String(error),
					true,
				)),
			);
			return true;
		}

		if (message.type === 'spectra.content.target.changed') {
			const tabId = sender.tab?.id;
			if (!tabId || sender.documentId !== message.payload.target.documentId) {
				sendResponse(rpcFailure('forbidden', 'Active media selection must match its sending document'));
				return false;
			}
			void serialized(tabId, () => handleTargetChanged(tabId, message.payload.target)).then(
				() => sendResponse(rpcSuccess({ accepted: true as const })),
				(error) => sendResponse(rpcFailure(
					'target_change_failed',
					error instanceof Error ? error.message : String(error),
					true,
				)),
			);
			return true;
		}

		if (message.type === 'spectra.control.snapshot.get') {
			void awaitDocumentInitialization(message.payload.tabId)
				.then(() => getControlViewSnapshot(message.payload.tabId)).then(
				(snapshot) => sendResponse(rpcSuccess(snapshot)),
				(error) => sendResponse(rpcFailure('snapshot_unavailable', String(error), true)),
			);
			return true;
		}

		const tabId = message.payload.tabId ?? sender.tab?.id ?? message.tabId;
		if (!tabId) {
			sendResponse(rpcFailure('invalid_request', 'Control intent requires a target tab'));
			return false;
		}
		const pageObservation = message.type === 'spectra.control.intent.submit'
			&& message.payload.source === 'page';
		if (pageObservation && (
			sender.tab?.id !== tabId
			|| sender.frameId !== 0
			|| !sender.documentId
			|| message.payload.target !== null
				&& message.payload.target.documentId !== sender.documentId
		)) {
			sendResponse(rpcFailure(
				'forbidden',
				'Page observation identity does not match its top-level sender',
			));
			return false;
		}
		const extensionInvoked = message.payload.source === 'popup'
			&& isExtensionPopupSender(sender);
		const operation = message.type === 'spectra.control.operation.submit'
			? submitOperationSerialized(
				{ ...message.payload, tabId } as RoutedControlOperationRequest,
				extensionInvoked,
			)
			: submitSerialized({
				...message.payload,
				tabId,
				...(pageObservation && message.payload.target === null
					? { observationDocumentId: sender.documentId }
					: {}),
			}, extensionInvoked);
		void operation.then(
			(ack) => sendResponse(rpcSuccess(ack)),
			(error) => sendResponse(rpcFailure(
				message.type === 'spectra.control.operation.submit'
					? 'control_operation_failed'
					: 'control_apply_failed',
				error instanceof Error ? error.message : String(error),
				true,
			)),
		);
		return true;
	});

	chrome.tabs.onRemoved.addListener((tabId) => { void removeTab(tabId); });
	chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
		const patch: Pick<ControlPatch, 'tabMuted' | 'tabPinned'> = {};
		if (typeof changeInfo.pinned === 'boolean') patch.tabPinned = changeInfo.pinned;
		if (typeof changeInfo.mutedInfo?.muted === 'boolean') {
			patch.tabMuted = changeInfo.mutedInfo.muted;
		}
		if (Object.keys(patch).length > 0) {
			void observeChromeTabState(tabId, patch).catch((error: unknown) => {
				swLog.debug(`[Control] Ignored tab-state observation without a controllable document: ${String(error)}`);
			});
		}
		if (changeInfo.status === 'complete') {
			void awaitDocumentInitialization(tabId)
				.then(() => serialized(tabId, () => reprojectBadgeForCurrentDocument(tabId)))
				.catch((error: unknown) => {
					swLog.debug(`[Control] Badge navigation projection settled at browser boundary: ${String(error)}`);
				});
		}
	});
	chrome.webNavigation.onCommitted.addListener((details) => {
		if (details.frameId === 0) {
			void invalidateNavigation(details.tabId).catch((error: unknown) => {
				swLog.debug(`[Control] Navigation invalidation settled at browser boundary: ${String(error)}`);
			});
		}
	});
	chrome.webNavigation.onHistoryStateUpdated.addListener((details) => {
		if (details.frameId === 0) {
			void invalidateNavigation(details.tabId, true).catch((error: unknown) => {
				swLog.debug(`[Control] History projection settled at browser boundary: ${String(error)}`);
			});
		}
	});
	chrome.webNavigation.onReferenceFragmentUpdated.addListener((details) => {
		if (details.frameId === 0) {
			void invalidateNavigation(details.tabId, true).catch((error: unknown) => {
				swLog.debug(`[Control] Fragment projection settled at browser boundary: ${String(error)}`);
			});
		}
	});
}

// Direct test surface for module-scoped MV3 state. These exports are not used
// by the background entry and are removed from production bundles.
export const controlCoordinatorTestApi = {
	submit: submitSerialized,
	submitInvoked: (request: RoutedControlSubmitRequest) => submitSerialized(request, true),
	submitOperation: submitOperationSerialized,
	submitOperationInvoked: (request: RoutedControlOperationRequest) => (
		submitOperationSerialized(request, true)
	),
	isExtensionPopupSender,
	getSnapshot,
	getViewSnapshot: getControlViewSnapshot,
	targetChanged: handleTargetChanged,
	sourceReleased: handleSourceReleased,
	observeChromeTabState,
	invalidateNavigation,
	reprojectBadgeForCurrentDocument,
	async reset(): Promise<void> {
		await Promise.allSettled([...invalidations.values()]);
		await serialized.drain();
		// Drain the repository's trailing debounce while the test/background
		// Chrome storage owner still exists. Otherwise a late timer can outlive
		// the service-worker harness and write through a deleted global.
		await storage.tabSession.flush().catch(() => undefined);
		snapshots.clear();
		invalidations.clear();
		initialized = false;
	},
};
