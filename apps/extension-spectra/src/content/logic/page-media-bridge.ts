// goal: synchronously cross the exact-element ISOLATED/MAIN boundary for page-owned media semantics

import type { ControlValues } from '@nexus/contracts';
import {
	SPECTRA_PAGE_MEDIA_EVENT,
	SPECTRA_PAGE_MEDIA_REQUEST_ATTRIBUTE,
	SPECTRA_PAGE_MEDIA_RESULT_ATTRIBUTE,
	type SpectraPageMediaField,
	type SpectraPageMediaRequest,
	type SpectraPageMediaResult,
} from '../../shared/page-media-bridge';

function isActualValue<K extends SpectraPageMediaField>(
	field: K,
	value: unknown,
): value is ControlValues[K] {
	if (field === 'mediaMuted') return typeof value === 'boolean';
	if (typeof value !== 'number' || !Number.isFinite(value)) return false;
	return field === 'volumeBase'
		? value >= 0 && value <= 100
		: value >= 0.1 && value <= 16;
}

function decodeResult<K extends SpectraPageMediaField>(
	encoded: string | null,
	requestId: string,
	field: K,
): SpectraPageMediaResult | null {
	if (!encoded) return null;
	try {
		const result = JSON.parse(encoded) as Partial<SpectraPageMediaResult>;
		return result.requestId === requestId
			&& result.field === field
			&& typeof result.supported === 'boolean'
			&& (result.actual === null || isActualValue(field, result.actual))
			&& (result.error === undefined || typeof result.error === 'string')
			? result as SpectraPageMediaResult
			: null;
	} catch {
		return null;
	}
}

function transact<K extends SpectraPageMediaField>(
	element: HTMLMediaElement,
	request: SpectraPageMediaRequest & { field: K },
): ControlValues[K] | null {
	if (typeof document === 'undefined'
		|| typeof element.setAttribute !== 'function'
		|| typeof element.dispatchEvent !== 'function') return null;
	try {
		element.setAttribute(SPECTRA_PAGE_MEDIA_REQUEST_ATTRIBUTE, JSON.stringify(request));
		element.dispatchEvent(new Event(SPECTRA_PAGE_MEDIA_EVENT, { composed: true }));
		const result = decodeResult(
			element.getAttribute(SPECTRA_PAGE_MEDIA_RESULT_ATTRIBUTE),
			request.requestId,
			request.field,
		);
		if (!result?.supported) return null;
		if (result.error || result.actual === null) {
			throw new Error(result.error ?? `Page-media ${request.field} returned no actual value`);
		}
		return result.actual as ControlValues[K];
	} finally {
		element.removeAttribute(SPECTRA_PAGE_MEDIA_REQUEST_ATTRIBUTE);
		element.removeAttribute(SPECTRA_PAGE_MEDIA_RESULT_ATTRIBUTE);
	}
}

export function readPageMediaField<K extends SpectraPageMediaField>(
	element: HTMLMediaElement,
	field: K,
): ControlValues[K] | null {
	return transact(element, {
		requestId: crypto.randomUUID(),
		operation: 'read',
		field,
	});
}

export function writePageMediaField(
	element: HTMLMediaElement,
	field: SpectraPageMediaField,
	value: ControlValues[SpectraPageMediaField],
): ControlValues[SpectraPageMediaField] | null {
	return transact(element, {
		requestId: crypto.randomUUID(),
		operation: 'write',
		field,
		value,
	});
}
