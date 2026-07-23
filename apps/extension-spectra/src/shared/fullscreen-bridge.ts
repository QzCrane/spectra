// goal: stable DOM boundary between the MAIN fullscreen wrapper and isolated audio runtime

export const SPECTRA_FULLSCREEN_BRIDGE_READY_ATTRIBUTE =
	'data-spectra-fullscreen-bridge-ready-v1' as const;
export const SPECTRA_FULLSCREEN_REQUEST_ATTRIBUTE =
	'data-spectra-fullscreen-request-v1' as const;
export const SPECTRA_FULLSCREEN_RESULT_ATTRIBUTE =
	'data-spectra-fullscreen-result-v1' as const;
export const SPECTRA_FULLSCREEN_PREPARE_EVENT =
	'spectra:fullscreen-prepare:v1' as const;
export const SPECTRA_FULLSCREEN_READY_EVENT =
	'spectra:fullscreen-ready:v1' as const;
export const SPECTRA_FULLSCREEN_FINISH_EVENT =
	'spectra:fullscreen-finish:v1' as const;

export interface SpectraFullscreenBridgeMessage {
	requestId: string;
}
