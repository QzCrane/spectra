// goal: minimal content-side projection of the canonical control policy
//
// This module is intentionally tiny: Content can execute target-scoped native
// media writes (page-controller first, standard DOM fallback) and
// extension-owned video CSS/overlay writes. Background retains the complete
// policy and validates every ACK. Architecture tests compare this projection
// with CONTROL_ALGORITHM_POLICIES so it cannot become a second independently
// evolving strategy table.

import type {
	ControlField,
	ControlOperation,
	ControlRequestedCoverage,
	ControlStrategy,
} from '@nexus/contracts';

export const CONTENT_DOM_NATIVE_FIELDS = Object.freeze([
	'volumeBase',
	'mediaMuted',
	'speed',
	'preservePitch',
	'playing',
	'currentTime',
	'loop',
	'pip',
	'fullscreen',
] as const satisfies readonly ControlField[]);

export const CONTENT_PAGE_NATIVE_FIELDS = Object.freeze([
	'volumeBase',
	'mediaMuted',
	'speed',
] as const satisfies readonly ControlField[]);

export const CONTENT_EXTENSION_CSS_FIELDS = Object.freeze([
	'rotation',
	'mirrored',
	'fill',
	'filterEnabled',
	'filter',
] as const satisfies readonly ControlField[]);

export const CONTENT_EXTENSION_OVERLAY_FIELDS = Object.freeze([
	'dimEnabled',
	'dimOpacity',
] as const satisfies readonly ControlField[]);

export const CONTENT_ACTIVE_VIDEO_OPERATIONS = Object.freeze([
	'frame-step',
	'screenshot',
	'video-effects-toggle',
	'video-effects-reset',
] as const satisfies readonly ControlOperation[]);

const domNativeFields = new Set<ControlField>(CONTENT_DOM_NATIVE_FIELDS);
const extensionCssFields = new Set<ControlField>(CONTENT_EXTENSION_CSS_FIELDS);
const extensionOverlayFields = new Set<ControlField>(CONTENT_EXTENSION_OVERLAY_FIELDS);
const activeVideoOperations = new Set<ControlOperation>(CONTENT_ACTIVE_VIDEO_OPERATIONS);

export function contentControlStrategy(
	field: ControlField,
	requestedCoverage: ControlRequestedCoverage,
): Extract<ControlStrategy, 'dom-native' | 'extension-css' | 'extension-overlay'> | null {
	// Every content writer is target-scoped. A full-output request must remain in
	// Background so it can select and verify an admitted processor strategy.
	// `dom-native` here selects the native executor route; the executor discovers
	// and ACKs `page-native` for the three semantic fields before falling back to
	// the standard DOM writer.
	if (requestedCoverage !== 'active-target') return null;
	if (domNativeFields.has(field)) return 'dom-native';
	if (extensionCssFields.has(field)) return 'extension-css';
	if (extensionOverlayFields.has(field)) return 'extension-overlay';
	return null;
}

export function isContentActiveVideoOperation(operation: ControlOperation): boolean {
	return activeVideoOperations.has(operation);
}
