// goal: one shared event name for the extension-owned isolated-world activation bridge

import type { MediaTarget } from '@nexus/contracts';

export const SPECTRA_TRUSTED_PIP_EVENT = 'spectra:trusted-pip-toggle:v1' as const;
export const SPECTRA_TRUSTED_PIP_REQUEST_ATTRIBUTE = 'data-spectra-trusted-pip-request-v1' as const;
export const SPECTRA_TRUSTED_PIP_RESULT_ATTRIBUTE = 'data-spectra-trusted-pip-result-v1' as const;

export interface SpectraTrustedPipRequest {
	requestId: string;
	documentId: string;
	target: MediaTarget;
}

export interface SpectraTrustedPipResult {
	active: boolean;
}

export type SpectraTrustedPipOutcome =
	| (SpectraTrustedPipRequest & { ok: true; active: boolean })
	| (SpectraTrustedPipRequest & { ok: false; error: string });
