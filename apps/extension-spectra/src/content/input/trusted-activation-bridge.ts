// goal: expose one lifecycle-bound PiP trigger inside the extension isolated world

import { isMediaTarget } from '@nexus/contracts';
import {
	SPECTRA_TRUSTED_PIP_EVENT,
	SPECTRA_TRUSTED_PIP_REQUEST_ATTRIBUTE,
	SPECTRA_TRUSTED_PIP_RESULT_ATTRIBUTE,
	type SpectraTrustedPipOutcome,
	type SpectraTrustedPipRequest,
} from '../../shared/trusted-activation';
import { submitTrustedActivationControl } from './hotkey-helpers';

export function registerTrustedActivationBridge(): () => void {
	let inFlight = false;
	const dispatchOutcome = (outcome: SpectraTrustedPipOutcome): void => {
		document.documentElement.setAttribute(
			SPECTRA_TRUSTED_PIP_RESULT_ATTRIBUTE,
			JSON.stringify(outcome),
		);
	};
	const onToggle = () => {
		const encoded = document.documentElement.getAttribute(SPECTRA_TRUSTED_PIP_REQUEST_ATTRIBUTE);
		if (!encoded) return;
		let request: SpectraTrustedPipRequest;
		try {
			request = JSON.parse(encoded) as SpectraTrustedPipRequest;
		} catch {
			return;
		}
		if (!request
			|| typeof request.requestId !== 'string'
			|| request.requestId.length === 0
			|| typeof request.documentId !== 'string'
			|| request.documentId.length === 0
			|| !isMediaTarget(request.target)
			|| request.target.kind !== 'video'
			|| request.target.documentId !== request.documentId) return;
		if (inFlight) {
			dispatchOutcome({
				...request,
				ok: false,
				error: 'A native PiP request is already running',
			});
			return;
		}
		if (!navigator.userActivation.isActive) {
			dispatchOutcome({
				...request,
				ok: false,
				error: 'Native PiP requires an active user gesture',
			});
			return;
		}
		inFlight = true;
		// rule: the canonical PiP entry is submitTrustedActivationControl('pip').
		// The bridge passes the document identity and target only as contextual
		// hints; the ISOLATED world executor resolves the actual writer.
		void submitTrustedActivationControl('pip')
			.then(
				(result) => dispatchOutcome({
					...request,
					ok: true,
					active: result.actual,
				}),
				(error: unknown) => dispatchOutcome({
					...request,
					ok: false,
					error: error instanceof Error ? error.message : String(error),
				}),
			)
			.finally(() => {
				inFlight = false;
			});
	};
	document.addEventListener(SPECTRA_TRUSTED_PIP_EVENT, onToggle);
	return () => {
		document.removeEventListener(SPECTRA_TRUSTED_PIP_EVENT, onToggle);
	};
}
