// goal: keep the always-on content bootstrap on a minimal, versioned protocol boundary

import type { ControlDirectField, MediaTarget } from './control.contracts.js';

export const SPECTRA_PROTOCOL_VERSION = 2 as const;
export const SPECTRA_CONTENT_BOOTSTRAP_REVISION = '1.3.2' as const;
export const SPECTRA_CONTENT_RUNTIME_REVISION = '3.3.7' as const;

export const SPECTRA_DEFAULT_HOTKEY_ACTION_BY_CODE = {
	ArrowLeft: 'speed_down',
	ArrowRight: 'speed_up',
	ArrowDown: 'volume_down',
	ArrowUp: 'volume_up',
	KeyM: 'volume_mute',
} as const;
export type SpectraDefaultHotkeyAction =
	typeof SPECTRA_DEFAULT_HOTKEY_ACTION_BY_CODE[
		keyof typeof SPECTRA_DEFAULT_HOTKEY_ACTION_BY_CODE
	];
export const SPECTRA_DEFAULT_HOTKEY_ACTIONS: readonly SpectraDefaultHotkeyAction[] =
	Object.freeze(Object.values(SPECTRA_DEFAULT_HOTKEY_ACTION_BY_CODE));
export interface SpectraDefaultHotkeyChord {
	code: string;
	altKey: boolean;
	ctrlKey: boolean;
	shiftKey: boolean;
	metaKey: boolean;
}

// One resolver owns both the always-on bootstrap mapping and the heavy
// site-hotkey exclusion. A built-in scalar chord can therefore have only one
// physical KeyboardEvent owner, even when an old site binding uses the same key.
export function resolveSpectraDefaultHotkeyAction(
	chord: SpectraDefaultHotkeyChord,
): SpectraDefaultHotkeyAction | null {
	if (!chord.altKey || chord.ctrlKey || chord.shiftKey || chord.metaKey) return null;
	return Object.hasOwn(SPECTRA_DEFAULT_HOTKEY_ACTION_BY_CODE, chord.code)
		? SPECTRA_DEFAULT_HOTKEY_ACTION_BY_CODE[
			chord.code as keyof typeof SPECTRA_DEFAULT_HOTKEY_ACTION_BY_CODE
		]
		: null;
}

export type SpectraDefaultHotkeyPhase = 'press' | 'release';
export interface SpectraDefaultHotkeyTriggerPayload {
	action: SpectraDefaultHotkeyAction;
	phase: SpectraDefaultHotkeyPhase;
	gesture: string;
	repeated: boolean;
}

const REQUEST_KEYS = new Set([
	'protocolVersion',
	'requestId',
	'type',
	'payload',
	'tabId',
	'documentId',
	'generation',
]);
const MEDIA_TARGET_KEYS = new Set(['frameId', 'documentId', 'mediaId', 'sourceRevision', 'kind']);
const DIRECT_FIELDS = new Set([
	'audioEnabled', 'volumeBase', 'boost', 'mediaMuted', 'tabMuted', 'speed', 'preservePitch',
	'playing', 'currentTime', 'loop', 'pip', 'fullscreen', 'rotation', 'mirrored', 'fill',
	'filterEnabled', 'filter', 'dimEnabled', 'dimOpacity', 'tabPinned', 'eqValues', 'bass',
	'compressor', 'mono', 'pan', 'delay',
]);

type BootstrapRequestType =
	| 'spectra.content.runtime.status'
	| 'spectra.control.actual.read'
	| 'spectra.content.runtime.release';

interface BootstrapRequestBase<T extends BootstrapRequestType, P> {
	protocolVersion: typeof SPECTRA_PROTOCOL_VERSION;
	requestId: string;
	type: T;
	payload: P;
	tabId?: number;
	documentId?: string;
	generation?: number;
}

export type BootstrapInboundRequest =
	| BootstrapRequestBase<'spectra.content.runtime.status', Record<string, never>>
	| BootstrapRequestBase<'spectra.control.actual.read', {
		fields: ControlDirectField[];
		target: MediaTarget | null;
	}>
	| BootstrapRequestBase<'spectra.content.runtime.release', { runtimeRevision: string }>;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: ReadonlySet<string>): boolean {
	return Object.keys(value).every((key) => keys.has(key));
}

function isSafeNonNegativeInteger(value: unknown): boolean {
	return Number.isSafeInteger(value) && Number(value) >= 0;
}

function isBoundedString(value: unknown, max: number): value is string {
	return typeof value === 'string' && value.length > 0 && value.length <= max;
}

export function isSpectraDefaultHotkeyTriggerPayload(
	value: unknown,
): value is SpectraDefaultHotkeyTriggerPayload {
	return isRecord(value)
		&& hasOnlyKeys(value, new Set(['action', 'phase', 'gesture', 'repeated']))
		&& SPECTRA_DEFAULT_HOTKEY_ACTIONS.some((action) => action === value.action)
		&& (value.phase === 'press' || value.phase === 'release')
		&& isBoundedString(value.gesture, 128)
		&& typeof value.repeated === 'boolean';
}

function hasValidEnvelope(value: Record<string, unknown>): boolean {
	return hasOnlyKeys(value, REQUEST_KEYS)
		&& value.protocolVersion === SPECTRA_PROTOCOL_VERSION
		&& isBoundedString(value.requestId, 128)
		&& (value.tabId === undefined || Number.isInteger(value.tabId) && Number(value.tabId) > 0)
		&& (value.documentId === undefined || isBoundedString(value.documentId, 256))
		&& (value.generation === undefined || isSafeNonNegativeInteger(value.generation));
}

function isMediaTarget(value: unknown): boolean {
	return isRecord(value)
		&& hasOnlyKeys(value, MEDIA_TARGET_KEYS)
		&& Number.isInteger(value.frameId)
		&& Number(value.frameId) >= 0
		&& isBoundedString(value.documentId, 256)
		&& isBoundedString(value.mediaId, 256)
		&& isSafeNonNegativeInteger(value.sourceRevision)
		&& (value.kind === 'audio' || value.kind === 'video');
}

export function isBootstrapInboundRequest(value: unknown): value is BootstrapInboundRequest {
	if (!isRecord(value) || !hasValidEnvelope(value) || !isRecord(value.payload)) return false;
	if (value.type === 'spectra.content.runtime.status') return Object.keys(value.payload).length === 0;
	if (value.type === 'spectra.content.runtime.release') {
		return hasOnlyKeys(value.payload, new Set(['runtimeRevision']))
			&& isBoundedString(value.payload.runtimeRevision, 128);
	}
	if (value.type !== 'spectra.control.actual.read'
		|| !hasOnlyKeys(value.payload, new Set(['fields', 'target']))
		|| !Array.isArray(value.payload.fields)
		|| value.payload.fields.length === 0
		|| value.payload.fields.length > DIRECT_FIELDS.size
		|| new Set(value.payload.fields).size !== value.payload.fields.length
		|| !value.payload.fields.every((field) => typeof field === 'string' && DIRECT_FIELDS.has(field))) {
		return false;
	}
	return value.payload.target === null || isMediaTarget(value.payload.target);
}

export function isBootstrapHelloResponse(value: unknown): value is {
	ok: true;
	data: { accepted: true; runtimeRevision: string | null };
} {
	if (!isRecord(value) || !hasOnlyKeys(value, new Set(['ok', 'data'])) || value.ok !== true
		|| !isRecord(value.data) || !hasOnlyKeys(value.data, new Set(['accepted', 'runtimeRevision']))) {
		return false;
	}
	return value.data.accepted === true
		&& (value.data.runtimeRevision === null || isBoundedString(value.data.runtimeRevision, 128));
}

export function bootstrapRpcSuccess<T>(data: T): { ok: true; data: T } {
	return { ok: true, data };
}

export function bootstrapRpcFailure(
	code: string,
	message: string,
	retryable = false,
): { ok: false; error: { code: string; message: string; retryable: boolean } } {
	return { ok: false, error: { code, message, retryable } };
}
