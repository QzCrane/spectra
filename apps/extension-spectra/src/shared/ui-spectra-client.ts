// goal: send runtime-validated SPECTRA v2 requests from unprivileged UI surfaces

import {
	SPECTRA_PROTOCOL_VERSION,
	type SpectraRequestEnvelope,
	type SpectraRequestPayload,
	type SpectraResponse,
} from '@nexus/contracts';
import {
	isSpectraUiResponse,
	type SpectraUiRequestType,
} from '@nexus/contracts/ui-runtime';
import { requiresContentRuntime } from './content-runtime';

export interface SpectraUiRequestContext {
	tabId?: number;
	documentId?: string;
	generation?: number;
}

function createRequestId(): string {
	return typeof crypto.randomUUID === 'function'
		? crypto.randomUUID()
		: `${Date.now().toString(36)}-${crypto.getRandomValues(new Uint32Array(2)).join('-')}`;
}

export async function sendSpectraRequest<T extends SpectraUiRequestType>(
	type: T,
	payload: SpectraRequestPayload<T>,
	context: SpectraUiRequestContext = {},
): Promise<SpectraResponse<T>> {
	const message = {
		protocolVersion: SPECTRA_PROTOCOL_VERSION,
		requestId: createRequestId(),
		type,
		payload,
		...context,
	} as SpectraRequestEnvelope<T>;
	const response: unknown = await chrome.runtime.sendMessage(message);
	if (!isSpectraUiResponse(type, response)) {
		throw new Error('Peer returned an invalid SPECTRA v2 UI response');
	}
	return response;
}

export async function sendSpectraTabRequest<T extends SpectraUiRequestType>(
	tabId: number,
	type: T,
	payload: SpectraRequestPayload<T>,
	context: Omit<SpectraUiRequestContext, 'tabId'> = {},
): Promise<SpectraResponse<T>> {
	const message = {
		protocolVersion: SPECTRA_PROTOCOL_VERSION,
		requestId: createRequestId(),
		type,
		payload,
		...context,
		tabId,
	} as SpectraRequestEnvelope<T>;
	const deliver = async (documentId?: string): Promise<SpectraResponse<T>> => {
		const response: unknown = documentId
			? await chrome.tabs.sendMessage(tabId, message, { documentId })
			: await chrome.tabs.sendMessage(tabId, message);
		if (!isSpectraUiResponse(type, response)) {
			throw new Error('Content host returned an invalid SPECTRA v2 UI response');
		}
		return response;
	};

	try {
		const response = await deliver(context.documentId);
		if (response.ok
			|| response.error.code !== 'content_runtime_not_loaded'
			|| !requiresContentRuntime(type)) return response;
	} catch (error) {
		if (!requiresContentRuntime(type)) throw error;
	}

	const capability = `request:${message.requestId}`;
	const ensure = await sendSpectraRequest('spectra.content.runtime.ensure', {
		tabId,
		...(context.documentId ? { documentId: context.documentId } : {}),
		reason: 'observation',
		capability,
	});
	if (!ensure.ok) return { ok: false, error: ensure.error };
	try {
		return await deliver(ensure.data.documentId);
	} finally {
		void sendSpectraRequest('spectra.content.runtime.release', {
			runtimeRevision: ensure.data.runtimeRevision,
			tabId,
			documentId: ensure.data.documentId,
			reason: 'observation',
			capability,
		}).catch(() => undefined);
	}
}
