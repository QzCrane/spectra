// goal: minimum runtime guards for settings, registry and hotkey-target UI surfaces

import { isDomainEntry, isRegistryEntries } from './registry.contracts.js';
import { SPECTRA_PROTOCOL_VERSION } from './spectra.bootstrap.js';
import type {
	RpcError,
	SpectraEventEnvelope,
	SpectraRequestType,
	SpectraResponse,
} from './spectra.protocol.js';
import { isSettingsSnapshot } from './settings.contracts.js';

export const SPECTRA_SETTINGS_UI_REQUEST_TYPES = [
	'spectra.settings.get',
	'spectra.settings.patch',
	'spectra.settings.flush',
	'spectra.registry.get',
	'spectra.registry.add',
	'spectra.registry.remove',
	'spectra.registry.query',
	'spectra.registry.mark-probed',
	'spectra.hotkey-target.get',
	'spectra.hotkey-target.set',
] as const satisfies readonly SpectraRequestType[];

export type SpectraSettingsUiRequestType = (typeof SPECTRA_SETTINGS_UI_REQUEST_TYPES)[number];
export type SpectraSettingsUiEventType = 'spectra.settings.changed';

const SETTINGS_UI_REQUEST_TYPE_SET: ReadonlySet<SpectraRequestType> = new Set(
	SPECTRA_SETTINGS_UI_REQUEST_TYPES,
);
const EVENT_KEYS = new Set(['protocolVersion', 'tabId', 'documentId', 'generation', 'type', 'payload']);

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

function isRegistrySnapshot(value: unknown): boolean {
	return isRecord(value) && hasExact(value, ['entries']) && isRegistryEntries(value.entries);
}

function isRegistryAddResult(value: unknown, userOnly = false): boolean {
	if (!isRecord(value)
		|| !hasExact(value, ['entries', 'entry', 'created'])
		|| !isRegistryEntries(value.entries)
		|| !isDomainEntry(value.entry)) return false;
	const entry = value.entry;
	return value.entries.some((candidate) => candidate.fingerprint === entry.fingerprint)
		&& (!userOnly || entry.source === 'user')
		&& typeof value.created === 'boolean';
}

function isRegistryRemoveResult(value: unknown): boolean {
	return isRecord(value)
		&& hasExact(value, ['entries', 'removed'])
		&& isRegistryEntries(value.entries)
		&& typeof value.removed === 'boolean';
}

function isRegistryQueryResult(value: unknown): boolean {
	return isRecord(value)
		&& hasExact(value, ['entry'])
		&& (value.entry === null || isDomainEntry(value.entry));
}

function isHotkeyTargetState(value: unknown): boolean {
	return isRecord(value)
		&& hasExact(value, ['tabId'])
		&& (value.tabId === null || isInteger(value.tabId, true));
}

export function isSpectraSettingsUiRequestType(
	value: unknown,
): value is SpectraSettingsUiRequestType {
	return typeof value === 'string'
		&& SETTINGS_UI_REQUEST_TYPE_SET.has(value as SpectraRequestType);
}

function isSettingsUiResponseData(type: SpectraSettingsUiRequestType, value: unknown): boolean {
	switch (type) {
		case 'spectra.settings.get':
		case 'spectra.settings.patch': return isSettingsSnapshot(value);
		case 'spectra.settings.flush': return isRecord(value)
			&& hasExact(value, ['flushed']) && value.flushed === true;
		case 'spectra.registry.get': return isRegistrySnapshot(value);
		case 'spectra.registry.add': return isRegistryAddResult(value, true);
		case 'spectra.registry.mark-probed': return isRegistryAddResult(value);
		case 'spectra.registry.remove': return isRegistryRemoveResult(value);
		case 'spectra.registry.query': return isRegistryQueryResult(value);
		case 'spectra.hotkey-target.get':
		case 'spectra.hotkey-target.set': return isHotkeyTargetState(value);
	}
}

export function isSpectraSettingsUiResponse<T extends SpectraRequestType>(
	type: T,
	value: unknown,
): value is SpectraResponse<Extract<T, SpectraSettingsUiRequestType>> {
	if (!isSpectraSettingsUiRequestType(type) || !isRecord(value)) return false;
	if (value.ok === true) {
		return hasExact(value, ['ok', 'data']) && isSettingsUiResponseData(type, value.data);
	}
	return value.ok === false
		&& hasExact(value, ['ok', 'error'])
		&& isRpcError(value.error);
}

export function isSpectraSettingsUiEventEnvelope(
	value: unknown,
): value is SpectraEventEnvelope<SpectraSettingsUiEventType> {
	return isRecord(value)
		&& hasOnly(value, EVENT_KEYS)
		&& value.protocolVersion === SPECTRA_PROTOCOL_VERSION
		&& value.type === 'spectra.settings.changed'
		&& value.tabId === undefined
		&& value.documentId === undefined
		&& value.generation === undefined
		&& isSettingsSnapshot(value.payload);
}
