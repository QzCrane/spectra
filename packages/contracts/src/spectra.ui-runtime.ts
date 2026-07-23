// goal: minimum runtime guards for Popup/Options without request-router or algorithm-catalog code

import {
	isAudioCaptureState,
	isAudioRuntimeStatus,
	isAudioSessionSnapshot,
} from './audio.contracts.js';
import { isRemotePublicSession } from './remote.contracts.js';
import { SPECTRA_PROTOCOL_VERSION } from './spectra.bootstrap.js';
import {
	isUiControlApplyAck,
	isUiControlOperationAck,
	isUiControlSnapshot,
} from './spectra.ui-control-runtime.js';
import {
	SPECTRA_SETTINGS_UI_REQUEST_TYPES,
	isSpectraSettingsUiEventEnvelope,
	isSpectraSettingsUiRequestType,
	isSpectraSettingsUiResponse,
} from './spectra.ui-settings-runtime.js';
import type {
	RemoteSessionChangedEvent,
	RemoteSessionClosedEvent,
	RemoteSessionStatus,
} from './remote.contracts.js';
import type {
	RpcError,
	SpectraEventEnvelope,
	SpectraEventType,
	SpectraRequestType,
	SpectraResponse,
} from './spectra.protocol.js';

export const SPECTRA_UI_REQUEST_TYPES = [
	'spectra.content.runtime.ensure',
	'spectra.content.runtime.release',
	'spectra.control.snapshot.get',
	'spectra.control.intent.submit',
	'spectra.control.operation.submit',
	...SPECTRA_SETTINGS_UI_REQUEST_TYPES,
	'spectra.audio.session.flush',
	'spectra.remote.session.get',
	'spectra.remote.session.create',
	'spectra.remote.session.close',
	'spectra.audio.session.get',
	'spectra.audio.runtime.get',
	'spectra.audio.visualizer.batch',
	'spectra.tab.visible.list',
] as const satisfies readonly SpectraRequestType[];

export type SpectraUiRequestType = (typeof SPECTRA_UI_REQUEST_TYPES)[number];

export const SPECTRA_UI_EVENT_TYPES = [
	'spectra.control.snapshot.changed',
	'spectra.settings.changed',
	'spectra.remote.session.changed',
	'spectra.remote.session.closed',
	'spectra.audio.session.changed',
	'spectra.audio.capture.changed',
] as const satisfies readonly SpectraEventType[];

export type SpectraUiEventType = (typeof SPECTRA_UI_EVENT_TYPES)[number];

const UI_REQUEST_TYPE_SET: ReadonlySet<SpectraRequestType> = new Set(SPECTRA_UI_REQUEST_TYPES);
const UI_EVENT_TYPE_SET: ReadonlySet<SpectraEventType> = new Set(SPECTRA_UI_EVENT_TYPES);

export function isSpectraUiRequestType(value: unknown): value is SpectraUiRequestType {
	return typeof value === 'string' && UI_REQUEST_TYPE_SET.has(value as SpectraRequestType);
}

export function isSpectraUiEventType(value: unknown): value is SpectraUiEventType {
	return typeof value === 'string' && UI_EVENT_TYPE_SET.has(value as SpectraEventType);
}

const EVENT_KEYS = new Set(['protocolVersion', 'tabId', 'documentId', 'generation', 'type', 'payload']);
const RUNTIME_REVISION_RE = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?$/u;
const BASE64URL_128_RE = /^[A-Za-z0-9_-]{22}$/u;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnly(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
	return Object.keys(value).every((key) => allowed.has(key));
}

function hasExact(value: Record<string, unknown>, keys: readonly string[]): boolean {
	return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function isInteger(value: unknown, positive = false): value is number {
	return Number.isSafeInteger(value) && Number(value) >= (positive ? 1 : 0);
}

function isBoundedString(value: unknown, maximum: number): value is string {
	return typeof value === 'string' && value.length > 0 && value.length <= maximum;
}

function isRpcError(value: unknown): value is RpcError {
	return isRecord(value)
		&& hasExact(value, ['code', 'message', 'retryable'])
		&& isBoundedString(value.code, 128)
		&& isBoundedString(value.message, 4096)
		&& typeof value.retryable === 'boolean';
}

function isRemoteSessionStatus(value: unknown): value is RemoteSessionStatus {
	return isRecord(value)
		&& hasExact(value, ['session', 'connected'])
		&& typeof value.connected === 'boolean'
		&& (value.session === null
			? value.connected === false
			: isRemotePublicSession(value.session) && value.connected === value.session.connected);
}

function isRemoteSessionChanged(value: unknown): value is RemoteSessionChangedEvent {
	return isRecord(value)
		&& hasExact(value, ['tabId', 'sessionId', 'connected'])
		&& isInteger(value.tabId, true)
		&& typeof value.sessionId === 'string'
		&& BASE64URL_128_RE.test(value.sessionId)
		&& typeof value.connected === 'boolean';
}

function isRemoteSessionClosed(value: unknown): value is RemoteSessionClosedEvent {
	return isRecord(value)
		&& hasExact(value, ['tabId', 'sessionId'])
		&& isInteger(value.tabId, true)
		&& typeof value.sessionId === 'string'
		&& BASE64URL_128_RE.test(value.sessionId);
}

function isVisualizerBatch(value: unknown): boolean {
	if (!isRecord(value)
		|| !hasExact(value, ['subscriberId', 'generation', 'frames'])
		|| !isBoundedString(value.subscriberId, 128)
		|| !isInteger(value.generation)
		|| !isRecord(value.frames)) return false;
	return Object.entries(value.frames).every(([tabId, frame]) => (
		/^[1-9]\d*$/u.test(tabId)
		&& (frame === null || Array.isArray(frame)
			&& frame.length <= 4096
			&& frame.every((sample) => Number.isInteger(sample) && sample >= 0 && sample <= 255))
	));
}

function isVisibleTabs(value: unknown): boolean {
	if (!isRecord(value) || !hasExact(value, ['tabs']) || !Array.isArray(value.tabs)) return false;
	return value.tabs.length <= 10_000
		&& value.tabs.every((tabId) => isInteger(tabId, true))
		&& new Set(value.tabs).size === value.tabs.length;
}

function isUiResponseData(type: SpectraUiRequestType, value: unknown): boolean {
	switch (type) {
		case 'spectra.content.runtime.ensure': return isRecord(value)
			&& hasExact(value, ['documentId', 'runtimeRevision', 'ready'])
			&& isBoundedString(value.documentId, 256)
			&& typeof value.runtimeRevision === 'string'
			&& RUNTIME_REVISION_RE.test(value.runtimeRevision)
			&& value.ready === true;
		case 'spectra.content.runtime.release': return isRecord(value)
			&& hasExact(value, ['accepted']) && value.accepted === true;
		case 'spectra.control.snapshot.get': return value === null || isUiControlSnapshot(value);
		case 'spectra.control.intent.submit': return isUiControlApplyAck(value);
		case 'spectra.control.operation.submit': return isUiControlOperationAck(value);
		case 'spectra.audio.session.flush': return isRecord(value)
			&& hasExact(value, ['flushed']) && value.flushed === true;
		case 'spectra.remote.session.get': return isRemoteSessionStatus(value);
		case 'spectra.remote.session.create': return isRemotePublicSession(value);
		case 'spectra.remote.session.close': return isRecord(value)
			&& hasExact(value, ['closed']) && value.closed === true;
		case 'spectra.audio.session.get': return value === null || isAudioSessionSnapshot(value);
		case 'spectra.audio.runtime.get': return isAudioRuntimeStatus(value);
		case 'spectra.audio.visualizer.batch': return isVisualizerBatch(value);
		case 'spectra.tab.visible.list': return isVisibleTabs(value);
		default: return false;
	}
}

export function isSpectraUiResponse<T extends SpectraRequestType>(
	type: T,
	value: unknown,
): value is SpectraResponse<Extract<T, SpectraUiRequestType>> {
	if (!isSpectraUiRequestType(type)) return false;
	if (isSpectraSettingsUiRequestType(type)) return isSpectraSettingsUiResponse(type, value);
	if (!isRecord(value)) return false;
	if (value.ok === true) {
		return hasExact(value, ['ok', 'data']) && isUiResponseData(type, value.data);
	}
	return value.ok === false
		&& hasExact(value, ['ok', 'error'])
		&& isRpcError(value.error);
}

export function isSpectraUiEventEnvelope(
	value: unknown,
): value is SpectraEventEnvelope<SpectraUiEventType> {
	if (!isRecord(value)
		|| !hasOnly(value, EVENT_KEYS)
		|| value.protocolVersion !== SPECTRA_PROTOCOL_VERSION
		|| !isSpectraUiEventType(value.type)
		|| (value.tabId !== undefined && !isInteger(value.tabId, true))
		|| (value.documentId !== undefined && !isBoundedString(value.documentId, 256))
		|| (value.generation !== undefined && !isInteger(value.generation))) return false;
	if (value.type === 'spectra.control.snapshot.changed') {
		return isUiControlSnapshot(value.payload)
			&& value.tabId === value.payload.tabId
			&& value.documentId === value.payload.documentId
			&& value.generation === value.payload.generation;
	}
	if (value.type === 'spectra.settings.changed') return isSpectraSettingsUiEventEnvelope(value);
	if (value.type === 'spectra.remote.session.changed') {
		return isRemoteSessionChanged(value.payload) && value.tabId === value.payload.tabId;
	}
	if (value.type === 'spectra.remote.session.closed') {
		return isRemoteSessionClosed(value.payload) && value.tabId === value.payload.tabId;
	}
	if (value.type === 'spectra.audio.session.changed') {
		return isAudioSessionSnapshot(value.payload)
			&& value.tabId === value.payload.tabId
			&& value.documentId === value.payload.documentId
			&& value.generation === value.payload.generation;
	}
	if (value.type === 'spectra.audio.capture.changed') {
		return isAudioCaptureState(value.payload)
			&& value.tabId === value.payload.tabId
			&& value.generation === value.payload.generation;
	}
	return false;
}
