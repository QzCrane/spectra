// goal: focused canonical-parity control guards for extension UI bundles

import type {
	ControlApplyAck,
	ControlField,
	ControlOperation,
	ControlOperationAck,
	ControlSnapshot,
	ControlStrategy,
	MediaTarget,
} from './control.contracts.js';

const CONTROL_FIELDS = new Set<ControlField>([
	'audioEnabled', 'volumeBase', 'boost', 'mediaMuted', 'tabMuted', 'speed',
	'preservePitch', 'playing', 'currentTime', 'loop', 'pip', 'fullscreen',
	'rotation', 'mirrored', 'fill', 'filterEnabled', 'filter', 'dimEnabled',
	'dimOpacity', 'abLoop', 'tabPinned', 'eqValues', 'bass', 'compressor',
	'mono', 'pan', 'delay', 'visualizer',
]);
const STRATEGIES = new Set<ControlStrategy>([
	'observe', 'page-native', 'dom-native', 'chrome-native', 'extension-state',
	'extension-css', 'extension-overlay', 'media-webaudio', 'capture', 'unsupported',
]);
const COVERAGES = new Set(['full', 'active-target', 'partial', 'opaque']);
const PHASES = new Set(['idle', 'applying', 'applied', 'error']);
const OPERATIONS = new Set<ControlOperation>([
	'restore-page-settings', 'effective-volume', 'playback-toggle', 'seek-relative', 'audio-reset',
	'frame-step', 'screenshot', 'marker-add', 'marker-remove', 'marker-jump',
	'marker-jump-previous', 'marker-jump-next', 'ab-set-a', 'ab-set-b', 'ab-clear',
	'ab-skip', 'video-effects-toggle', 'video-effects-reset', 'show-info',
	'open-popup', 'open-options', 'run-user-script', 'open-url',
]);
const PROCESSOR_FIELDS = new Set<ControlField>([
	'boost', 'eqValues', 'bass', 'compressor', 'mono', 'pan', 'delay',
]);
const FIELD_STRATEGIES = {
	audioEnabled: ['extension-state'],
	volumeBase: ['page-native', 'dom-native'],
	boost: ['media-webaudio', 'capture'],
	mediaMuted: ['page-native', 'dom-native'],
	tabMuted: ['chrome-native'],
	speed: ['page-native', 'dom-native'],
	preservePitch: ['dom-native'],
	playing: ['dom-native'],
	currentTime: ['dom-native'],
	loop: ['dom-native'],
	pip: ['dom-native'],
	fullscreen: ['dom-native'],
	rotation: ['extension-css'],
	mirrored: ['extension-css'],
	fill: ['extension-css'],
	filterEnabled: ['extension-css'],
	filter: ['extension-css'],
	dimEnabled: ['extension-overlay'],
	dimOpacity: ['extension-overlay'],
	abLoop: ['extension-state'],
	tabPinned: ['chrome-native'],
	eqValues: ['media-webaudio', 'capture'],
	bass: ['media-webaudio', 'capture'],
	compressor: ['media-webaudio', 'capture'],
	mono: ['media-webaudio', 'capture'],
	pan: ['media-webaudio', 'capture'],
	delay: ['media-webaudio', 'capture'],
	visualizer: ['observe'],
} as const satisfies Record<ControlField, readonly ControlStrategy[]>;
const OPERATION_STRATEGIES = {
	'restore-page-settings': 'extension-state',
	'effective-volume': 'extension-state',
	'playback-toggle': 'dom-native',
	'seek-relative': 'dom-native',
	'frame-step': 'dom-native',
	screenshot: 'chrome-native',
	'marker-add': 'extension-state',
	'marker-remove': 'extension-state',
	'marker-jump': 'dom-native',
	'marker-jump-previous': 'dom-native',
	'marker-jump-next': 'dom-native',
	'ab-set-a': 'extension-state',
	'ab-set-b': 'extension-state',
	'ab-clear': 'extension-state',
	'ab-skip': 'dom-native',
	'audio-reset': 'extension-state',
	'video-effects-toggle': 'extension-state',
	'video-effects-reset': 'extension-state',
	'show-info': 'observe',
	'open-popup': 'chrome-native',
	'open-options': 'chrome-native',
	'run-user-script': 'extension-state',
	'open-url': 'chrome-native',
} as const satisfies Record<ControlOperation, ControlStrategy>;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnly(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
	return Object.keys(value).every((key) => allowed.has(key));
}

function isInteger(value: unknown, positive = false): value is number {
	return Number.isSafeInteger(value) && Number(value) >= (positive ? 1 : 0);
}

function isFiniteInRange(value: unknown, minimum: number, maximum: number): value is number {
	return typeof value === 'number' && Number.isFinite(value) && value >= minimum && value <= maximum;
}

function isAudioVolumeProjection(value: unknown): boolean {
	return isRecord(value)
		&& hasOnly(value, new Set(['effectiveVolume', 'volumeState']))
		&& isFiniteInRange(value.effectiveVolume, 0, 800)
		&& (value.volumeState === 'silent'
			|| value.volumeState === 'native'
			|| value.volumeState === 'capture');
}

function isBoundedString(value: unknown, maximum: number): value is string {
	return typeof value === 'string' && value.length > 0 && value.length <= maximum;
}

function isControlError(value: unknown): boolean {
	return isRecord(value)
		&& hasOnly(value, new Set(['code', 'message', 'retryable']))
		&& isBoundedString(value.code, 128)
		&& isBoundedString(value.message, 4096)
		&& typeof value.retryable === 'boolean';
}

function isMediaTarget(value: unknown): value is MediaTarget {
	return isRecord(value)
		&& hasOnly(value, new Set(['frameId', 'documentId', 'mediaId', 'sourceRevision', 'kind']))
		&& isInteger(value.frameId)
		&& isBoundedString(value.documentId, 256)
		&& isBoundedString(value.mediaId, 256)
		&& isInteger(value.sourceRevision)
		&& (value.kind === 'audio' || value.kind === 'video');
}

function isFilter(value: unknown): boolean {
	return isRecord(value)
		&& hasOnly(value, new Set(['brightness', 'contrast', 'saturate', 'grayscale', 'invert']))
		&& isFiniteInRange(value.brightness, 0, 200)
		&& isFiniteInRange(value.contrast, 0, 200)
		&& isFiniteInRange(value.saturate, 0, 200)
		&& typeof value.grayscale === 'boolean'
		&& typeof value.invert === 'boolean';
}

function isABLoop(value: unknown): boolean {
	if (!isRecord(value)
		|| !hasOnly(value, new Set(['pointA', 'pointB', 'enabled']))
		|| (value.pointA !== null && !isFiniteInRange(value.pointA, 0, Number.MAX_SAFE_INTEGER))
		|| (value.pointB !== null && !isFiniteInRange(value.pointB, 0, Number.MAX_SAFE_INTEGER))
		|| typeof value.enabled !== 'boolean') return false;
	if (value.enabled) {
		return value.pointA !== null && value.pointB !== null && value.pointB > value.pointA;
	}
	return value.pointB === null || value.pointA === null || value.pointB > value.pointA;
}

function isControlValue(field: ControlField, value: unknown): boolean {
	switch (field) {
		case 'volumeBase': return isFiniteInRange(value, 0, 100);
		case 'boost': return isFiniteInRange(value, 1, 8);
		case 'speed': return isFiniteInRange(value, 0.1, 16);
		case 'currentTime': return isFiniteInRange(value, 0, Number.MAX_SAFE_INTEGER);
		case 'rotation': return value === 0 || value === 90 || value === 180 || value === 270;
		case 'filter': return isFilter(value);
		case 'abLoop': return isABLoop(value);
		case 'dimOpacity': return isFiniteInRange(value, 0, 1);
		case 'eqValues': return Array.isArray(value)
			&& value.length === 10
			&& value.every((item) => isFiniteInRange(item, -12, 12));
		case 'pan': return isFiniteInRange(value, -1, 1);
		case 'delay': return isFiniteInRange(value, 0, 500);
		default: return typeof value === 'boolean';
	}
}

function isStrategyAdmitted(field: ControlField, value: Record<string, unknown>): boolean {
	if (typeof value.strategy !== 'string' || !STRATEGIES.has(value.strategy as ControlStrategy)) return false;
	const strategy = value.strategy as ControlStrategy;
	return FIELD_STRATEGIES[field].includes(strategy as never)
		|| strategy === 'unsupported'
			&& value.phase === 'error'
			&& value.controlled === false
			&& value.lastError !== null
		|| strategy === 'observe'
			&& PROCESSOR_FIELDS.has(field)
			&& value.controlled === false
			&& (value.phase === 'idle' || value.phase === 'applied');
}

function isControlFieldStates(value: unknown): boolean {
	if (!isRecord(value) || !hasOnly(value, CONTROL_FIELDS)) return false;
	return Object.entries(value).every(([fieldName, state]) => {
		const field = fieldName as ControlField;
		if (!isRecord(state) || !hasOnly(state, new Set([
			'desired', 'actual', 'restoreBaseline', 'revision', 'phase', 'strategy',
			'coverage', 'controlled', 'intentId', 'lastError',
		]))) return false;
		return (state.desired === null || isControlValue(field, state.desired))
			&& (state.actual === null || isControlValue(field, state.actual))
			&& (state.restoreBaseline === undefined || isControlValue(field, state.restoreBaseline))
			&& isInteger(state.revision)
			&& typeof state.phase === 'string'
			&& PHASES.has(state.phase)
			&& isStrategyAdmitted(field, state)
			&& typeof state.coverage === 'string'
			&& COVERAGES.has(state.coverage)
			&& typeof state.controlled === 'boolean'
			&& (state.intentId === undefined || isBoundedString(state.intentId, 128))
			&& (state.lastError === null || isControlError(state.lastError));
	});
}

function isCanonicalOrigin(value: unknown): value is string {
	if (!isBoundedString(value, 2048)) return false;
	try {
		const url = new URL(value);
		return url.origin !== 'null' && url.origin === value;
	} catch {
		return false;
	}
}

function isMarker(value: unknown): boolean {
	return isRecord(value)
		&& hasOnly(value, new Set(['id', 'time', 'label']))
		&& typeof value.id === 'string'
		&& /^m_[0-9a-f-]{36}$/iu.test(value.id)
		&& isFiniteInRange(value.time, 0, Number.MAX_SAFE_INTEGER)
		&& isBoundedString(value.label, 256);
}

function isOperationResult(operation: ControlOperation, value: unknown): boolean {
	if (!isRecord(value)) return false;
	switch (operation) {
		case 'restore-page-settings':
			return hasOnly(value, new Set(['releasedFields']))
				&& Array.isArray(value.releasedFields)
				&& value.releasedFields.every((field) => typeof field === 'string' && CONTROL_FIELDS.has(field as ControlField));
		case 'effective-volume':
			return hasOnly(value, new Set(['effectiveVolume', 'volumeBase', 'boost']))
				&& isFiniteInRange(value.effectiveVolume, 0, 800)
				&& isFiniteInRange(value.volumeBase, 0, 100)
				&& isFiniteInRange(value.boost, 1, 8)
				&& Math.round(value.volumeBase * value.boost * 100) / 100 === value.effectiveVolume;
		case 'playback-toggle':
			return hasOnly(value, new Set(['playing'])) && typeof value.playing === 'boolean';
		case 'seek-relative':
			return hasOnly(value, new Set(['currentTime']))
				&& isFiniteInRange(value.currentTime, 0, Number.MAX_SAFE_INTEGER);
		case 'frame-step':
			return hasOnly(value, new Set(['currentTime', 'frameDuration', 'approximate']))
				&& isFiniteInRange(value.currentTime, 0, Number.MAX_SAFE_INTEGER)
				&& isFiniteInRange(value.frameDuration, 0.001, 1)
				&& typeof value.approximate === 'boolean';
		case 'screenshot':
			return hasOnly(value, new Set(['saved', 'method', 'width', 'height']))
				&& value.saved === true
				&& value.method === 'capture-visible-tab'
				&& isFiniteInRange(value.width, 1, 100_000)
				&& isFiniteInRange(value.height, 1, 100_000);
		case 'marker-add':
			return hasOnly(value, new Set(['marker', 'remaining']))
				&& (value.marker === null || isMarker(value.marker))
				&& isFiniteInRange(value.remaining, 0, 1_000);
		case 'marker-remove':
			return hasOnly(value, new Set(['removed', 'remaining']))
				&& typeof value.removed === 'boolean'
				&& isFiniteInRange(value.remaining, 0, 1_000);
		case 'marker-jump':
			return hasOnly(value, new Set(['jumped', 'time']))
				&& typeof value.jumped === 'boolean'
				&& isFiniteInRange(value.time, 0, Number.MAX_SAFE_INTEGER);
		case 'marker-jump-previous':
		case 'marker-jump-next':
			return hasOnly(value, new Set(['jumped', 'actualTime', 'marker']))
				&& typeof value.jumped === 'boolean'
				&& (value.actualTime === null || isFiniteInRange(value.actualTime, 0, Number.MAX_SAFE_INTEGER))
				&& (value.marker === null || isMarker(value.marker));
		case 'ab-set-a':
		case 'ab-set-b':
			return hasOnly(value, new Set(['abLoop'])) && isABLoop(value.abLoop);
		case 'ab-clear':
			return hasOnly(value, new Set(['abLoop', 'cleared']))
				&& isABLoop(value.abLoop) && typeof value.cleared === 'boolean';
		case 'ab-skip':
			return hasOnly(value, new Set(['abLoop', 'skipped', 'currentTime']))
				&& isABLoop(value.abLoop)
				&& typeof value.skipped === 'boolean'
				&& (value.currentTime === null
					|| isFiniteInRange(value.currentTime, 0, Number.MAX_SAFE_INTEGER));
		case 'audio-reset':
		case 'video-effects-reset':
			return hasOnly(value, new Set(['reset'])) && value.reset === true;
		case 'video-effects-toggle':
			return hasOnly(value, new Set(['enabled'])) && typeof value.enabled === 'boolean';
		case 'show-info':
			return hasOnly(value, new Set(['shown'])) && typeof value.shown === 'boolean';
		case 'open-popup':
		case 'open-options':
		case 'open-url':
			return hasOnly(value, new Set(['opened'])) && value.opened === true;
		case 'run-user-script':
			return hasOnly(value, new Set(['executed'])) && value.executed === true;
	}
}

export function isUiControlSnapshot(value: unknown): value is ControlSnapshot {
	return isRecord(value)
		&& hasOnly(value, new Set([
			'tabId', 'documentId', 'origin', 'generation', 'revision',
			'activeMedia', 'activeVideo', 'fields',
		]))
		&& isInteger(value.tabId, true)
		&& isBoundedString(value.documentId, 256)
		&& isCanonicalOrigin(value.origin)
		&& isInteger(value.generation)
		&& isInteger(value.revision)
		&& (value.activeMedia === null || isMediaTarget(value.activeMedia))
		&& (value.activeVideo === null || isMediaTarget(value.activeVideo) && value.activeVideo.kind === 'video')
		&& isControlFieldStates(value.fields);
}

export function isUiControlApplyAck(value: unknown): value is ControlApplyAck {
	return isRecord(value)
		&& hasOnly(value, new Set([
			'intentId', 'tabId', 'documentId', 'generation', 'revision', 'target',
			'fields', 'audioVolume',
		]))
		&& isBoundedString(value.intentId, 128)
		&& isInteger(value.tabId, true)
		&& isBoundedString(value.documentId, 256)
		&& isInteger(value.generation)
		&& isInteger(value.revision)
		&& (value.target === null || isMediaTarget(value.target))
		&& isControlFieldStates(value.fields)
		&& (value.audioVolume === undefined || isAudioVolumeProjection(value.audioVolume));
}

export function isUiControlOperationAck(value: unknown): value is ControlOperationAck {
	return isRecord(value)
		&& hasOnly(value, new Set([
			'operationId', 'tabId', 'documentId', 'generation', 'revision', 'target',
			'operation', 'strategy', 'coverage', 'fields', 'audioVolume', 'result',
		]))
		&& isBoundedString(value.operationId, 128)
		&& isInteger(value.tabId, true)
		&& isBoundedString(value.documentId, 256)
		&& isInteger(value.generation)
		&& isInteger(value.revision)
		&& (value.target === null || isMediaTarget(value.target))
		&& typeof value.operation === 'string'
		&& OPERATIONS.has(value.operation as ControlOperation)
		&& typeof value.strategy === 'string'
		&& value.strategy === OPERATION_STRATEGIES[value.operation as ControlOperation]
		&& typeof value.coverage === 'string'
		&& COVERAGES.has(value.coverage)
		&& isControlFieldStates(value.fields)
		&& (value.audioVolume === undefined || isAudioVolumeProjection(value.audioVolume))
		&& isOperationResult(value.operation as ControlOperation, value.result);
}
