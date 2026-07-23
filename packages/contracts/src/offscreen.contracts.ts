// goal: one runtime-validated contract for the SPECTRA background/offscreen boundary

import {
	isAudioConfig,
	isAudioProcessorConfig,
	type AudioConfig,
	type AudioProcessorConfig,
} from './audio.contracts.js';
import {
	isRemoteCommand,
	isRemotePublicSession,
	isRemoteSessionToken,
	isRemoteState,
	type RemoteCommand,
	type RemotePublicSession,
	type RemoteState,
} from './remote.contracts.js';

export interface OffscreenHostSnapshot {
	audioTabs: Array<{
		tabId: number;
		generation: number;
		controlRevision?: number;
		graphSignature?: string;
		normalizedActualConfig?: AudioProcessorConfig;
	}>;
	remoteTabs: Array<{ tabId: number; sessionId: string }>;
}

export type OffscreenAudioResult =
	| {
		ok: true;
		tabId: number;
		generation: number;
		controlRevision: number;
		phase: 'active';
		contextState: 'running';
		graphSignature: string;
		normalizedActualConfig: AudioProcessorConfig;
		error?: never;
	}
	| {
		ok: true;
		tabId: number;
		generation: number;
		controlRevision: number;
		phase: 'idle';
		contextState: 'closed';
		graphSignature: 'none';
		normalizedActualConfig: null;
		error?: never;
	}
	| {
		ok: false;
		tabId: number;
		generation: number;
		controlRevision: number;
		error: { code: string; message: string; retryable: boolean };
		phase?: never;
	};

export interface OffscreenVisualizerFrame {
	buffer: number[] | null;
}

export interface OffscreenVisualizerBatch {
	frames: Record<string, number[] | null>;
}

export interface OffscreenVisualizerSubscriptions {
	subscribedTabIds: number[];
}

export interface RemoteHostSession extends RemotePublicSession {
	capability: string;
	reconnectUntil: number | null;
	generation: number;
}

export type RemoteHostCreateResponse =
	| { success: true; session: RemoteHostSession; error?: never }
	| { success: false; error: string; session?: never };

export interface RemoteHostStatusResponse {
	session: RemoteHostSession | null;
}

export interface RemoteHostDescribeResponse {
	sessions: RemoteHostSession[];
}

export interface RemoteHostMutationResponse {
	success: boolean;
	error?: string;
}

interface OffscreenHostRequestDefinition<TRequest, TResponse> {
	request: TRequest;
	response: TResponse;
}

// inv: every background-to-offscreen request and its response are declared together
export interface OffscreenHostRequestMap {
	OFFSCREEN_HOST_HELLO: OffscreenHostRequestDefinition<Record<never, never>, OffscreenHostSnapshot>;
	OFFSCREEN_AUDIO_START: OffscreenHostRequestDefinition<{
		tabId: number;
		streamId: string;
		config: AudioConfig;
		generation: number;
		controlRevision?: number;
	}, OffscreenAudioResult>;
	OFFSCREEN_AUDIO_STOP: OffscreenHostRequestDefinition<{
		tabId: number;
		generation: number;
	}, OffscreenAudioResult>;
	OFFSCREEN_AUDIO_CANCEL_START: OffscreenHostRequestDefinition<{
		tabId: number;
		generation: number;
		stopCommitted: boolean;
	}, OffscreenAudioResult>;
	OFFSCREEN_AUDIO_UPDATE: OffscreenHostRequestDefinition<{
		tabId: number;
		generation: number;
		controlRevision?: number;
		config: AudioConfig;
	}, OffscreenAudioResult>;
	OFFSCREEN_AUDIO_GET_VIZ: OffscreenHostRequestDefinition<{
		tabId: number;
	}, OffscreenVisualizerFrame>;
	OFFSCREEN_AUDIO_GET_VIZ_BATCH: OffscreenHostRequestDefinition<{
		tabIds: number[];
	}, OffscreenVisualizerBatch>;
	OFFSCREEN_AUDIO_SET_VIZ_SUBSCRIPTIONS: OffscreenHostRequestDefinition<{
		tabIds: number[];
	}, OffscreenVisualizerSubscriptions>;
	REMOTE_HOST_CREATE_SESSION: OffscreenHostRequestDefinition<{
		tabId: number;
	}, RemoteHostCreateResponse>;
	REMOTE_HOST_GET_STATUS: OffscreenHostRequestDefinition<{
		tabId: number;
	}, RemoteHostStatusResponse>;
	REMOTE_HOST_DESCRIBE: OffscreenHostRequestDefinition<Record<never, never>, RemoteHostDescribeResponse>;
	REMOTE_HOST_CLOSE_SESSION: OffscreenHostRequestDefinition<{
		tabId: number;
		sessionId: string;
	}, RemoteHostMutationResponse>;
	REMOTE_HOST_CLOSE_TAB: OffscreenHostRequestDefinition<{
		tabId: number;
	}, RemoteHostMutationResponse>;
	REMOTE_HOST_SEND_STATE: OffscreenHostRequestDefinition<{
		tabId: number;
		sessionId: string;
		state: RemoteState;
	}, RemoteHostMutationResponse>;
}

export type OffscreenHostRequestType = keyof OffscreenHostRequestMap;

export type OffscreenHostRequest<TType extends OffscreenHostRequestType = OffscreenHostRequestType> = {
	[TKey in TType]: { type: TKey } & OffscreenHostRequestMap[TKey]['request'];
}[TType];

export type OffscreenHostWireRequest<TType extends OffscreenHostRequestType = OffscreenHostRequestType> = {
	[TKey in TType]: OffscreenHostRequest<TKey> & { target: 'offscreen' };
}[TType];

export type OffscreenHostResponse<TType extends OffscreenHostRequestType> =
	OffscreenHostRequestMap[TType]['response'];

export type OffscreenAudioRequestType = Extract<OffscreenHostRequestType, `OFFSCREEN_AUDIO_${string}`>;
export type OffscreenAudioRequest = OffscreenHostRequest<OffscreenAudioRequestType>;
export type RemoteHostRequestType = Extract<OffscreenHostRequestType, `REMOTE_HOST_${string}`>;
export type RemoteHostRequest = OffscreenHostRequest<RemoteHostRequestType>;

export type RemoteHostCloseReason =
	| 'manual'
	| 'tab-closed'
	| 'pairing-expired'
	| 'reconnect-expired'
	| 'host-destroyed';

interface OffscreenHostEventMap {
	OFFSCREEN_AUDIO_ENDED: {
		tabId: number;
		generation: number;
	};
	REMOTE_HOST_EXECUTE_COMMAND: {
		tabId: number;
		sessionId: string;
		capability: string;
		sequence: number;
		generation: number;
		command: RemoteCommand;
	};
	REMOTE_HOST_REQUEST_SYNC: {
		tabId: number;
		sessionId: string;
		capability: string;
	};
	REMOTE_HOST_STATUS_CHANGE: {
		tabId: number;
		sessionId: string;
		capability: string;
	} & (
		| { connected: true; reconnectUntil?: never }
		| { connected: false; reconnectUntil: number }
	);
	REMOTE_HOST_SESSION_CLOSED: {
		tabId: number;
		sessionId: string;
		reason: RemoteHostCloseReason;
	};
}

export type OffscreenHostEventType = keyof OffscreenHostEventMap;
export type OffscreenHostEvent<TType extends OffscreenHostEventType = OffscreenHostEventType> = {
	[TKey in TType]: { type: TKey } & OffscreenHostEventMap[TKey];
}[TType];
export type OffscreenAudioEvent = OffscreenHostEvent<'OFFSCREEN_AUDIO_ENDED'>;
export type RemoteHostEventType = Extract<OffscreenHostEventType, `REMOTE_HOST_${string}`>;
export type RemoteHostEvent = OffscreenHostEvent<RemoteHostEventType>;

const MAX_STREAM_ID_LENGTH = 4_096;
const MAX_VISUALIZER_TABS = 256;
const MAX_VISUALIZER_BINS = 32_768;
const MAX_HOST_RESOURCES = 4_096;
const MAX_ERROR_CODE_LENGTH = 128;
const MAX_ERROR_MESSAGE_LENGTH = 2_048;
const CLOSE_REASONS: ReadonlySet<string> = new Set<RemoteHostCloseReason>([
	'manual',
	'tab-closed',
	'pairing-expired',
	'reconnect-expired',
	'host-destroyed',
]);

export function isOffscreenHostRequest(value: unknown): value is OffscreenHostWireRequest {
	if (!isRecord(value) || value.target !== 'offscreen' || typeof value.type !== 'string') return false;
	switch (value.type) {
		case 'OFFSCREEN_HOST_HELLO':
		case 'REMOTE_HOST_DESCRIBE':
			return hasOnlyKeys(value, ['target', 'type']);
		case 'OFFSCREEN_AUDIO_START':
			return hasOnlyKeys(value, [
				'target',
				'type',
				'tabId',
				'streamId',
				'config',
				'generation',
				'controlRevision',
			])
				&& isTabId(value.tabId)
				&& typeof value.streamId === 'string'
				&& value.streamId.length > 0
				&& value.streamId.length <= MAX_STREAM_ID_LENGTH
				&& isAudioConfig(value.config)
				&& isGeneration(value.generation)
				&& (value.controlRevision === undefined || isGeneration(value.controlRevision));
		case 'OFFSCREEN_AUDIO_STOP':
			return hasOnlyKeys(value, ['target', 'type', 'tabId', 'generation'])
				&& isTabId(value.tabId)
				&& isGeneration(value.generation);
		case 'OFFSCREEN_AUDIO_CANCEL_START':
			return hasOnlyKeys(value, ['target', 'type', 'tabId', 'generation', 'stopCommitted'])
				&& isTabId(value.tabId)
				&& isGeneration(value.generation)
				&& typeof value.stopCommitted === 'boolean';
		case 'OFFSCREEN_AUDIO_UPDATE':
			return hasOnlyKeys(value, [
				'target',
				'type',
				'tabId',
				'generation',
				'controlRevision',
				'config',
			])
				&& isTabId(value.tabId)
				&& isGeneration(value.generation)
				&& (value.controlRevision === undefined || isGeneration(value.controlRevision))
				&& isAudioConfig(value.config);
		case 'OFFSCREEN_AUDIO_GET_VIZ':
		case 'REMOTE_HOST_CREATE_SESSION':
		case 'REMOTE_HOST_GET_STATUS':
		case 'REMOTE_HOST_CLOSE_TAB':
			return hasOnlyKeys(value, ['target', 'type', 'tabId']) && isTabId(value.tabId);
		case 'OFFSCREEN_AUDIO_GET_VIZ_BATCH':
		case 'OFFSCREEN_AUDIO_SET_VIZ_SUBSCRIPTIONS':
			return hasOnlyKeys(value, ['target', 'type', 'tabIds'])
				&& isTabIdList(value.tabIds);
		case 'REMOTE_HOST_CLOSE_SESSION':
			return hasOnlyKeys(value, ['target', 'type', 'tabId', 'sessionId'])
				&& isTabId(value.tabId)
				&& isRemoteSessionToken(value.sessionId);
		case 'REMOTE_HOST_SEND_STATE':
			return hasOnlyKeys(value, ['target', 'type', 'tabId', 'sessionId', 'state'])
				&& isTabId(value.tabId)
				&& isRemoteSessionToken(value.sessionId)
				&& isRemoteState(value.state);
		default:
			return false;
	}
}

export function isOffscreenHostResponse<TType extends OffscreenHostRequestType>(
	type: TType,
	value: unknown,
): value is OffscreenHostResponse<TType> {
	switch (type) {
		case 'OFFSCREEN_HOST_HELLO':
			return isOffscreenHostSnapshot(value);
		case 'OFFSCREEN_AUDIO_START':
		case 'OFFSCREEN_AUDIO_STOP':
		case 'OFFSCREEN_AUDIO_CANCEL_START':
		case 'OFFSCREEN_AUDIO_UPDATE':
			return isOffscreenAudioResult(value);
		case 'OFFSCREEN_AUDIO_GET_VIZ':
			return isRecord(value)
				&& hasOnlyKeys(value, ['buffer'])
				&& isVisualizerFrame(value.buffer);
		case 'OFFSCREEN_AUDIO_GET_VIZ_BATCH':
			return isVisualizerBatch(value);
		case 'OFFSCREEN_AUDIO_SET_VIZ_SUBSCRIPTIONS':
			return isRecord(value)
				&& hasOnlyKeys(value, ['subscribedTabIds'])
				&& isTabIdList(value.subscribedTabIds);
		case 'REMOTE_HOST_CREATE_SESSION':
			return isRemoteHostCreateResponse(value);
		case 'REMOTE_HOST_GET_STATUS':
			return isRecord(value)
				&& hasOnlyKeys(value, ['session'])
				&& (value.session === null || isRemoteHostSession(value.session));
		case 'REMOTE_HOST_DESCRIBE':
			return isRecord(value)
				&& hasOnlyKeys(value, ['sessions'])
				&& Array.isArray(value.sessions)
				&& value.sessions.length <= MAX_HOST_RESOURCES
				&& value.sessions.every(isRemoteHostSession);
		case 'REMOTE_HOST_CLOSE_SESSION':
		case 'REMOTE_HOST_CLOSE_TAB':
		case 'REMOTE_HOST_SEND_STATE':
			return isRemoteHostMutationResponse(value);
		default:
			return false;
	}
}

export function isOffscreenHostEvent(value: unknown): value is OffscreenHostEvent {
	if (!isRecord(value) || typeof value.type !== 'string') return false;
	switch (value.type) {
		case 'OFFSCREEN_AUDIO_ENDED':
			return hasOnlyKeys(value, ['type', 'tabId', 'generation'])
				&& isTabId(value.tabId)
				&& isGeneration(value.generation);
		case 'REMOTE_HOST_EXECUTE_COMMAND':
			return hasOnlyKeys(value, [
				'type',
				'tabId',
				'sessionId',
				'capability',
				'sequence',
				'generation',
				'command',
			])
				&& isRemoteEventIdentity(value)
				&& isPositiveSequence(value.sequence)
				&& isGeneration(value.generation)
				&& isRemoteCommand(value.command);
		case 'REMOTE_HOST_REQUEST_SYNC':
			return hasOnlyKeys(value, ['type', 'tabId', 'sessionId', 'capability'])
				&& isRemoteEventIdentity(value);
		case 'REMOTE_HOST_STATUS_CHANGE':
			return hasOnlyKeys(value, [
				'type',
				'tabId',
				'sessionId',
				'capability',
				'connected',
				'reconnectUntil',
			])
				&& isRemoteEventIdentity(value)
				&& (value.connected === true
					? value.reconnectUntil === undefined
					: value.connected === false && isTimestamp(value.reconnectUntil));
		case 'REMOTE_HOST_SESSION_CLOSED':
			return hasOnlyKeys(value, ['type', 'tabId', 'sessionId', 'reason'])
				&& isTabId(value.tabId)
				&& isRemoteSessionToken(value.sessionId)
				&& typeof value.reason === 'string'
				&& CLOSE_REASONS.has(value.reason);
		default:
			return false;
	}
}

export function isOffscreenHostSnapshot(value: unknown): value is OffscreenHostSnapshot {
	if (!isRecord(value) || !hasOnlyKeys(value, ['audioTabs', 'remoteTabs'])) return false;
	if (!Array.isArray(value.audioTabs)
		|| value.audioTabs.length > MAX_HOST_RESOURCES
		|| !value.audioTabs.every((audio) => isRecord(audio)
			&& hasOnlyKeys(audio, [
				'tabId',
				'generation',
				'controlRevision',
				'graphSignature',
				'normalizedActualConfig',
			])
			&& isTabId(audio.tabId)
			&& isGeneration(audio.generation)
			&& (audio.controlRevision === undefined || isGeneration(audio.controlRevision))
			&& (audio.graphSignature === undefined || isBoundedString(audio.graphSignature, 512))
			&& (audio.normalizedActualConfig === undefined
				|| isAudioProcessorConfig(audio.normalizedActualConfig)))) return false;
	if (!Array.isArray(value.remoteTabs)
		|| value.remoteTabs.length > MAX_HOST_RESOURCES
		|| !value.remoteTabs.every((remote) => isRecord(remote)
			&& hasOnlyKeys(remote, ['tabId', 'sessionId'])
			&& isTabId(remote.tabId)
			&& isRemoteSessionToken(remote.sessionId))) return false;
	return hasUniqueNumbers(value.audioTabs.map((audio) => audio.tabId))
		&& hasUniqueNumbers(value.remoteTabs.map((remote) => remote.tabId))
		&& new Set(value.remoteTabs.map((remote) => remote.sessionId)).size === value.remoteTabs.length;
}

export function isOffscreenAudioResult(value: unknown): value is OffscreenAudioResult {
	if (!isRecord(value)
		|| !isTabId(value.tabId)
		|| !isGeneration(value.generation)
		|| !isGeneration(value.controlRevision)) return false;
	if (value.ok === true) {
		if (value.phase === 'active') {
			return hasOnlyKeys(value, [
				'ok',
				'tabId',
				'generation',
				'controlRevision',
				'phase',
				'contextState',
				'graphSignature',
				'normalizedActualConfig',
			])
				&& value.contextState === 'running'
				&& isBoundedString(value.graphSignature, 512)
				&& isAudioProcessorConfig(value.normalizedActualConfig);
		}
		return value.phase === 'idle'
			&& hasOnlyKeys(value, [
				'ok',
				'tabId',
				'generation',
				'controlRevision',
				'phase',
				'contextState',
				'graphSignature',
				'normalizedActualConfig',
			])
			&& value.contextState === 'closed'
			&& value.graphSignature === 'none'
			&& value.normalizedActualConfig === null;
	}
	return value.ok === false
		&& hasOnlyKeys(value, ['ok', 'tabId', 'generation', 'controlRevision', 'error'])
		&& isRecord(value.error)
		&& hasOnlyKeys(value.error, ['code', 'message', 'retryable'])
		&& isBoundedString(value.error.code, MAX_ERROR_CODE_LENGTH)
		&& isBoundedString(value.error.message, MAX_ERROR_MESSAGE_LENGTH)
		&& typeof value.error.retryable === 'boolean';
}

export function isRemoteHostSession(value: unknown): value is RemoteHostSession {
	if (!isRecord(value) || !hasOnlyKeys(value, [
		'protocolVersion',
		'sessionId',
		'peerId',
		'secret',
		'createdAt',
		'pairingExpiresAt',
		'tabId',
		'connected',
		'capability',
		'reconnectUntil',
		'generation',
	])) return false;
	const publicSession = {
		protocolVersion: value.protocolVersion,
		sessionId: value.sessionId,
		peerId: value.peerId,
		secret: value.secret,
		createdAt: value.createdAt,
		pairingExpiresAt: value.pairingExpiresAt,
		tabId: value.tabId,
		connected: value.connected,
	};
	return isRemotePublicSession(publicSession)
		&& isRemoteSessionToken(value.capability)
		&& (value.reconnectUntil === null || isTimestamp(value.reconnectUntil))
		&& isGeneration(value.generation);
}

function isRemoteHostCreateResponse(value: unknown): value is RemoteHostCreateResponse {
	if (!isRecord(value)) return false;
	if (value.success === true) {
		return hasOnlyKeys(value, ['success', 'session']) && isRemoteHostSession(value.session);
	}
	return value.success === false
		&& hasOnlyKeys(value, ['success', 'error'])
		&& isBoundedString(value.error, MAX_ERROR_MESSAGE_LENGTH);
}

function isRemoteHostMutationResponse(value: unknown): value is RemoteHostMutationResponse {
	return isRecord(value)
		&& hasOnlyKeys(value, ['success', 'error'])
		&& typeof value.success === 'boolean'
		&& (value.error === undefined || isBoundedString(value.error, MAX_ERROR_MESSAGE_LENGTH));
}

function isVisualizerBatch(value: unknown): value is OffscreenVisualizerBatch {
	if (!isRecord(value) || !hasOnlyKeys(value, ['frames']) || !isRecord(value.frames)) return false;
	const entries = Object.entries(value.frames);
	return entries.length <= MAX_VISUALIZER_TABS
		&& entries.every(([tabId, frame]) => isCanonicalTabIdKey(tabId) && isVisualizerFrame(frame));
}

function isVisualizerFrame(value: unknown): value is number[] | null {
	return value === null || (Array.isArray(value)
		&& value.length <= MAX_VISUALIZER_BINS
		&& value.every((bin) => Number.isInteger(bin) && bin >= 0 && bin <= 255));
}

function isRemoteEventIdentity(value: Record<string, unknown>): boolean {
	return isTabId(value.tabId)
		&& isRemoteSessionToken(value.sessionId)
		&& isRemoteSessionToken(value.capability);
}

function isTabIdList(value: unknown): value is number[] {
	return Array.isArray(value)
		&& value.length <= MAX_VISUALIZER_TABS
		&& value.every(isTabId)
		&& hasUniqueNumbers(value);
}

function isCanonicalTabIdKey(value: string): boolean {
	const parsed = Number(value);
	return isTabId(parsed) && String(parsed) === value;
}

function hasUniqueNumbers(values: number[]): boolean {
	return new Set(values).size === values.length;
}

function isTabId(value: unknown): value is number {
	return Number.isSafeInteger(value) && (value as number) > 0;
}

function isGeneration(value: unknown): value is number {
	return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isPositiveSequence(value: unknown): value is number {
	return Number.isSafeInteger(value) && (value as number) > 0;
}

function isTimestamp(value: unknown): value is number {
	return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isBoundedString(value: unknown, maximumLength: number): value is string {
	return typeof value === 'string' && value.length > 0 && value.length <= maximumLength;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
	const allowed = new Set(keys);
	return Object.keys(value).every((key) => allowed.has(key));
}
