// goal: central brand and state color tokens used across the UI layer

export const UIColors = {
	// CAPTURE: purple only after the matching Capture runtime is active
	CAPTURE: '#7c3aed',
	// NATIVE: blue for native, Media WebAudio and every non-active transition
	NATIVE: '#2563eb',
	// PENDING: an explicit desired/actual boundary; never predicts Capture.
	PENDING: '#f59e0b',
	MUTED: '#9ca3af',
	WHITE: '#ffffff',
} as const;
