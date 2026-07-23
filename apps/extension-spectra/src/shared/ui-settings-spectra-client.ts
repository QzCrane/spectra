// goal: send runtime-validated settings and registry requests without control-bundle code

import {
	SPECTRA_PROTOCOL_VERSION,
	type SpectraRequestEnvelope,
	type SpectraRequestPayload,
	type SpectraResponse,
} from '@nexus/contracts';
import {
	isSpectraSettingsUiResponse,
	type SpectraSettingsUiRequestType,
} from '@nexus/contracts/ui-settings-runtime';

function createRequestId(): string {
	return typeof crypto.randomUUID === 'function'
		? crypto.randomUUID()
		: `${Date.now().toString(36)}-${crypto.getRandomValues(new Uint32Array(2)).join('-')}`;
}

export async function sendSettingsUiRequest<T extends SpectraSettingsUiRequestType>(
	type: T,
	payload: SpectraRequestPayload<T>,
): Promise<SpectraResponse<T>> {
	const message = {
		protocolVersion: SPECTRA_PROTOCOL_VERSION,
		requestId: createRequestId(),
		type,
		payload,
	} as SpectraRequestEnvelope<T>;
	const response: unknown = await chrome.runtime.sendMessage(message);
	if (!isSpectraSettingsUiResponse(type, response)) {
		throw new Error('Peer returned an invalid SPECTRA settings UI response');
	}
	return response;
}
