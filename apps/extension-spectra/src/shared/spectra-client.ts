// goal: send runtime-validated SPECTRA v2 requests from extension contexts

import {
	SPECTRA_PROTOCOL_VERSION,
	isSpectraResponse,
	type SpectraRequestEnvelope,
	type SpectraRequestPayload,
	type SpectraRequestType,
	type SpectraResponse,
} from '@nexus/contracts';
import { requiresContentRuntime } from './content-runtime';

export interface SpectraRequestContext {
	tabId?: number;
	documentId?: string;
	generation?: number;
}

function createRequestId(): string {
	return typeof crypto.randomUUID === 'function'
		? crypto.randomUUID()
		: `${Date.now().toString(36)}-${crypto.getRandomValues(new Uint32Array(2)).join('-')}`;
}

function createEnvelope<T extends SpectraRequestType>(
	type: T,
	payload: SpectraRequestPayload<T>,
	context: SpectraRequestContext,
): SpectraRequestEnvelope<T> {
	return {
		protocolVersion: SPECTRA_PROTOCOL_VERSION,
		requestId: createRequestId(),
		type,
		payload,
		...context,
	} as SpectraRequestEnvelope<T>;
}

function validateResponse<T extends SpectraRequestType>(
	type: T,
	response: unknown,
): SpectraResponse<T> {
	if (!isSpectraResponse(type, response)) {
		throw new Error('Peer returned an invalid SPECTRA v2 response');
	}
	return response;
}

export async function sendSpectraRequest<T extends SpectraRequestType>(
	type: T,
	payload: SpectraRequestPayload<T>,
	context: SpectraRequestContext = {},
): Promise<SpectraResponse<T>> {
	const message = createEnvelope(type, payload, context);
	const response: unknown = await chrome.runtime.sendMessage(message);
	return validateResponse(type, response);
}

async function deliverSpectraTabEnvelope<T extends SpectraRequestType>(
	tabId: number,
	message: SpectraRequestEnvelope<T>,
	documentId?: string,
): Promise<SpectraResponse<T>> {
	const response: unknown = documentId
		? await chrome.tabs.sendMessage(tabId, message, { documentId })
		: await chrome.tabs.sendMessage(tabId, message);
	return validateResponse(message.type, response);
}

// Background callers that own Content runtime lifecycle use this single-hop
// primitive after acquiring a local runtime lease. UI callers use the
// auto-acquiring client below because their lifecycle owner lives in Background.
export function sendSpectraTabRequestOnce<T extends SpectraRequestType>(
	tabId: number,
	type: T,
	payload: SpectraRequestPayload<T>,
	context: Omit<SpectraRequestContext, 'tabId'> = {},
): Promise<SpectraResponse<T>> {
	return deliverSpectraTabEnvelope(
		tabId,
		createEnvelope(type, payload, { ...context, tabId }),
		context.documentId,
	);
}

export async function sendSpectraTabRequest<T extends SpectraRequestType>(
	tabId: number,
	type: T,
	payload: SpectraRequestPayload<T>,
	context: Omit<SpectraRequestContext, 'tabId'> = {},
): Promise<SpectraResponse<T>> {
	const message = createEnvelope(type, payload, { ...context, tabId });
	const deliver = (documentId?: string): Promise<SpectraResponse<T>> =>
		deliverSpectraTabEnvelope(tabId, message, documentId);

	let firstResponse: SpectraResponse<T> | null = null;
	try {
		firstResponse = await deliver(context.documentId);
		if (firstResponse.ok
			|| firstResponse.error.code !== 'content_runtime_not_loaded'
			|| !requiresContentRuntime(type)) return firstResponse;
	} catch (error) {
		if (!requiresContentRuntime(type)) throw error;
	}

	const ensureResponse = await sendSpectraRequest('spectra.content.runtime.ensure', {
		tabId,
		...(context.documentId ? { documentId: context.documentId } : {}),
		reason: type === 'spectra.hotkey.trigger' ? 'hotkey' : 'control',
		capability: `request:${message.requestId}`,
	});
	if (!ensureResponse.ok) return { ok: false, error: ensureResponse.error };
	const reason = type === 'spectra.hotkey.trigger' ? 'hotkey' : 'control';
	const capability = `request:${message.requestId}`;
	try {
		return await deliver(ensureResponse.data.documentId);
	} finally {
		void sendSpectraRequest('spectra.content.runtime.release', {
			runtimeRevision: ensureResponse.data.runtimeRevision,
			tabId,
			documentId: ensureResponse.data.documentId,
			reason,
			capability,
		}).catch(() => undefined);
	}
}
