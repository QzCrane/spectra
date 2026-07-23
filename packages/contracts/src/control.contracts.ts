// goal: authoritative, per-field control protocol shared by every SPECTRA surface

export const CONTROL_STRATEGIES = [
	'observe',
	'page-native',
	'dom-native',
	'chrome-native',
	'extension-state',
	'extension-css',
	'extension-overlay',
	'media-webaudio',
	'capture',
	'unsupported',
] as const;

export type ControlStrategy = (typeof CONTROL_STRATEGIES)[number];
export type ControlStrategyClass = 'observe' | 'native' | 'augmentation' | 'unsupported';
export type ControlInterceptionKind =
	| 'none'
	| 'reversible-extension-layer'
	| 'irreversible-media-source-binding'
	| 'authorized-tab-stream';
export type ControlAdmissionEvidence =
	| 'none'
	| 'existing-runtime-state'
	| 'page-controller-readback'
	| 'standard-api-readback'
	| 'chrome-api-readback'
	| 'extension-owner-readback'
	| 'computed-style-readback'
	| 'overlay-geometry-readback'
	| 'proven-media-source-eligibility'
	| 'authorized-capture-readback';
export type ControlWriterOwner =
	| 'none'
	| 'page-media-controller'
	| 'standard-dom-api'
	| 'chrome-api'
	| 'extension-state'
	| 'extension-style'
	| 'extension-overlay'
	| 'media-processor'
	| 'capture-processor';
export type ControlAudioRuntimeCost = 'none' | 'existing-processor-only' | 'lazy-audio-context' | 'lazy-offscreen-capture';
export type ControlMainWorldPolicy = 'forbidden' | 'exact-element-page-bridge';

export interface ControlStrategyRule {
	class: ControlStrategyClass;
	writerOwner: ControlWriterOwner;
	interception: ControlInterceptionKind;
	admissionEvidence: ControlAdmissionEvidence;
	requiresExplicitIntent: boolean;
	requiresActualReadback: boolean;
	requiresDisposer: boolean;
	mainWorld: ControlMainWorldPolicy;
	audioRuntimeCost: ControlAudioRuntimeCost;
	canBypassUserActivation: false;
	canBypassCorsOrDrm: false;
}

// Strategy semantics are data, not comments hidden in one executor. Runtime
// planners, architecture checks and UX tests consume this exhaustive record so
// a future strategy cannot quietly acquire broader MAIN/audio/permission power.
export const CONTROL_STRATEGY_RULES = {
	observe: {
		class: 'observe', writerOwner: 'none', requiresExplicitIntent: false,
		interception: 'none', admissionEvidence: 'existing-runtime-state',
		requiresActualReadback: true, requiresDisposer: true, mainWorld: 'forbidden',
		audioRuntimeCost: 'existing-processor-only', canBypassUserActivation: false, canBypassCorsOrDrm: false,
	},
	'page-native': {
		class: 'native', writerOwner: 'page-media-controller', requiresExplicitIntent: true,
		interception: 'none', admissionEvidence: 'page-controller-readback',
		requiresActualReadback: true, requiresDisposer: false, mainWorld: 'exact-element-page-bridge',
		audioRuntimeCost: 'none', canBypassUserActivation: false, canBypassCorsOrDrm: false,
	},
	'dom-native': {
		class: 'native', writerOwner: 'standard-dom-api', requiresExplicitIntent: true,
		interception: 'none', admissionEvidence: 'standard-api-readback',
		requiresActualReadback: true, requiresDisposer: false, mainWorld: 'forbidden',
		audioRuntimeCost: 'none', canBypassUserActivation: false, canBypassCorsOrDrm: false,
	},
	'chrome-native': {
		class: 'native', writerOwner: 'chrome-api', requiresExplicitIntent: true,
		interception: 'none', admissionEvidence: 'chrome-api-readback',
		requiresActualReadback: true, requiresDisposer: false, mainWorld: 'forbidden',
		audioRuntimeCost: 'none', canBypassUserActivation: false, canBypassCorsOrDrm: false,
	},
	'extension-state': {
		class: 'augmentation', writerOwner: 'extension-state', requiresExplicitIntent: true,
		interception: 'reversible-extension-layer', admissionEvidence: 'extension-owner-readback',
		requiresActualReadback: true, requiresDisposer: true, mainWorld: 'forbidden',
		audioRuntimeCost: 'none', canBypassUserActivation: false, canBypassCorsOrDrm: false,
	},
	'extension-css': {
		class: 'augmentation', writerOwner: 'extension-style', requiresExplicitIntent: true,
		interception: 'reversible-extension-layer', admissionEvidence: 'computed-style-readback',
		requiresActualReadback: true, requiresDisposer: true, mainWorld: 'forbidden',
		audioRuntimeCost: 'none', canBypassUserActivation: false, canBypassCorsOrDrm: false,
	},
	'extension-overlay': {
		class: 'augmentation', writerOwner: 'extension-overlay', requiresExplicitIntent: true,
		interception: 'reversible-extension-layer', admissionEvidence: 'overlay-geometry-readback',
		requiresActualReadback: true, requiresDisposer: true, mainWorld: 'forbidden',
		audioRuntimeCost: 'none', canBypassUserActivation: false, canBypassCorsOrDrm: false,
	},
	'media-webaudio': {
		class: 'augmentation', writerOwner: 'media-processor', requiresExplicitIntent: true,
		interception: 'irreversible-media-source-binding', admissionEvidence: 'proven-media-source-eligibility',
		requiresActualReadback: true, requiresDisposer: true, mainWorld: 'forbidden',
		audioRuntimeCost: 'lazy-audio-context', canBypassUserActivation: false, canBypassCorsOrDrm: false,
	},
	capture: {
		class: 'augmentation', writerOwner: 'capture-processor', requiresExplicitIntent: true,
		interception: 'authorized-tab-stream', admissionEvidence: 'authorized-capture-readback',
		requiresActualReadback: true, requiresDisposer: true, mainWorld: 'forbidden',
		audioRuntimeCost: 'lazy-offscreen-capture', canBypassUserActivation: false, canBypassCorsOrDrm: false,
	},
	unsupported: {
		class: 'unsupported', writerOwner: 'none', requiresExplicitIntent: false,
		interception: 'none', admissionEvidence: 'none',
		requiresActualReadback: false, requiresDisposer: false, mainWorld: 'forbidden',
		audioRuntimeCost: 'none', canBypassUserActivation: false, canBypassCorsOrDrm: false,
	},
} as const satisfies Record<ControlStrategy, ControlStrategyRule>;

// A failed native attempt may enter a more invasive strategy only when the
// failure proves that the capability itself is incomplete. Permission,
// activation, protected-content and identity boundaries are terminal: MAIN or
// Capture must never be used to disguise them as a successful fallback.
export const CONTROL_RETRYABLE_STRATEGY_FAILURES = [
	'capability-unavailable',
	'write-unsupported',
	'readback-mismatch',
	'coverage-incomplete',
	'source-binding-ineligible',
	'strategy-runtime-failed',
] as const;

export const CONTROL_TERMINAL_STRATEGY_FAILURES = [
	'user-activation-required',
	'permission-denied',
	'cors-or-drm-protected',
	'protected-content',
	'closed-shadow-inaccessible',
	'stale-document',
	'stale-media-source',
	'policy-denied',
] as const;

export type ControlRetryableStrategyFailure =
	(typeof CONTROL_RETRYABLE_STRATEGY_FAILURES)[number];
export type ControlTerminalStrategyFailure =
	(typeof CONTROL_TERMINAL_STRATEGY_FAILURES)[number];
export type ControlStrategyFailure =
	| ControlRetryableStrategyFailure
	| ControlTerminalStrategyFailure;

const retryableStrategyFailures: ReadonlySet<string> =
	new Set(CONTROL_RETRYABLE_STRATEGY_FAILURES);

const controlStrategyFailures: ReadonlySet<string> = new Set([
	...CONTROL_RETRYABLE_STRATEGY_FAILURES,
	...CONTROL_TERMINAL_STRATEGY_FAILURES,
]);

export function isControlStrategyFailure(value: unknown): value is ControlStrategyFailure {
	return typeof value === 'string' && controlStrategyFailures.has(value);
}

export function shouldTryNextControlStrategy(failure: ControlStrategyFailure): boolean {
	return retryableStrategyFailures.has(failure);
}
export type ControlCoverage = 'full' | 'active-target' | 'partial' | 'opaque';
export type ControlRequestedCoverage = Extract<ControlCoverage, 'full' | 'active-target'>;
export type ControlFieldPhase = 'idle' | 'applying' | 'applied' | 'error';
export type ControlIntentSource = 'page' | 'popup' | 'remote' | 'hotkey' | 'restore' | 'system';
export type CaptureAdmission = 'extension-invocation';
export type MediaKind = 'audio' | 'video';

export interface MediaTarget {
	frameId: number;
	documentId: string;
	mediaId: string;
	sourceRevision: number;
	kind: MediaKind;
}

export interface VideoFilterState {
	brightness: number;
	contrast: number;
	saturate: number;
	grayscale: boolean;
	invert: boolean;
}

export interface ABLoopState {
	pointA: number | null;
	pointB: number | null;
	enabled: boolean;
}

export interface ControlValues {
	audioEnabled: boolean;
	volumeBase: number;
	boost: number;
	mediaMuted: boolean;
	tabMuted: boolean;
	speed: number;
	preservePitch: boolean;
	playing: boolean;
	currentTime: number;
	loop: boolean;
	pip: boolean;
	fullscreen: boolean;
	rotation: 0 | 90 | 180 | 270;
	mirrored: boolean;
	fill: boolean;
	filterEnabled: boolean;
	filter: VideoFilterState;
	dimEnabled: boolean;
	dimOpacity: number;
	abLoop: ABLoopState;
	tabPinned: boolean;
	eqValues: number[];
	bass: boolean;
	compressor: boolean;
	mono: boolean;
	pan: number;
	delay: number;
	visualizer: boolean;
}

export type ControlField = keyof ControlValues;
// `abLoop` is committed only by the typed A/B operations and `visualizer` is
// owned only by the explicit subscription protocol. Keeping them out of the
// ordinary patch/mutation surface prevents a caller from receiving a generic
// "unsupported" ACK for an algorithm that has a different authoritative
// entry point.
export type ControlDirectField = Exclude<ControlField, 'abLoop' | 'visualizer'>;
export type ControlNativeObservationStrategy = Extract<ControlStrategy, 'page-native' | 'dom-native'>;
export type ControlNativeObservationStrategies = Partial<
	Record<ControlDirectField, ControlNativeObservationStrategy>
>;
export type ControlPatch = Partial<Pick<ControlValues, ControlDirectField>>;

// The always-on bootstrap has no MediaRegistry identity. It may therefore
// report only the two complete native field groups whose values are scoped to
// the current top-level document and are safe to restore after refresh.
export const CONTROL_BOOTSTRAP_OBSERVATION_GROUPS = [
	['volumeBase', 'mediaMuted'],
	['speed', 'preservePitch'],
] as const satisfies readonly (readonly ControlDirectField[])[];

// Read-only native facts required to compile related augmentation fields. They
// travel with an intent so a lazy audio runtime never derives Boost/DSP from a
// stale legacy config after page, Popup or remote control.
export interface ControlActualContext {
	volumeBase?: number;
	mediaMuted?: boolean;
	speed?: number;
	preservePitch?: boolean;
}

export const CONTROL_FIELDS = [
	'audioEnabled',
	'volumeBase',
	'boost',
	'mediaMuted',
	'tabMuted',
	'speed',
	'preservePitch',
	'playing',
	'currentTime',
	'loop',
	'pip',
	'fullscreen',
	'rotation',
	'mirrored',
	'fill',
	'filterEnabled',
	'filter',
	'dimEnabled',
	'dimOpacity',
	'abLoop',
	'tabPinned',
	'eqValues',
	'bass',
	'compressor',
	'mono',
	'pan',
	'delay',
	'visualizer',
] as const satisfies readonly ControlField[];

export const CONTROL_DIRECT_FIELDS = [
	'audioEnabled',
	'volumeBase',
	'boost',
	'mediaMuted',
	'tabMuted',
	'speed',
	'preservePitch',
	'playing',
	'currentTime',
	'loop',
	'pip',
	'fullscreen',
	'rotation',
	'mirrored',
	'fill',
	'filterEnabled',
	'filter',
	'dimEnabled',
	'dimOpacity',
	'tabPinned',
	'eqValues',
	'bass',
	'compressor',
	'mono',
	'pan',
	'delay',
] as const satisfies readonly ControlDirectField[];

// A document replacement may replay only durable configuration. Momentary
// media facts (playing/currentTime/PiP/fullscreen), source-bound A/B state and
// visualizer subscriptions belong to the old document; tab mute/pin are
// already browser-owned across a refresh. The remaining fields form the exact
// acknowledged same-tab session projection and deliberately carry no media
// target identity.
export const CONTROL_SESSION_FIELDS = [
	'audioEnabled',
	'volumeBase',
	'boost',
	'mediaMuted',
	'speed',
	'preservePitch',
	'loop',
	'rotation',
	'mirrored',
	'fill',
	'filterEnabled',
	'filter',
	'dimEnabled',
	'dimOpacity',
	'eqValues',
	'bass',
	'compressor',
	'mono',
	'pan',
	'delay',
] as const satisfies readonly ControlDirectField[];

export type ControlSessionField = (typeof CONTROL_SESSION_FIELDS)[number];
export type ControlSessionPatch = Partial<Pick<ControlValues, ControlSessionField>>;

// Operations are momentary algorithms. They are planned like fields but do not
// pretend to be persistent desired values in ControlSnapshot.
export const CONTROL_OPERATIONS = [
	'restore-page-settings',
	'effective-volume',
	'playback-toggle',
	'seek-relative',
	'frame-step',
	'screenshot',
	'marker-add',
	'marker-remove',
	'marker-jump',
	'marker-jump-previous',
	'marker-jump-next',
	'ab-set-a',
	'ab-set-b',
	'ab-clear',
	'ab-skip',
	'audio-reset',
	'video-effects-toggle',
	'video-effects-reset',
	'show-info',
	'open-popup',
	'open-options',
	'run-user-script',
	'open-url',
] as const;

export type ControlOperation = (typeof CONTROL_OPERATIONS)[number];
export type ControlCapability = ControlField | ControlOperation;
export const CONTROL_CAPABILITIES: readonly ControlCapability[] = [
	...CONTROL_FIELDS,
	...CONTROL_OPERATIONS,
];

export type ControlScope =
	| 'document'
	| 'tab'
	| 'requested-audio-scope'
	| 'active-media'
	| 'active-video'
	| 'media-source'
	| 'extension-ui'
	| 'sandbox';

export type ControlAlgorithmKind =
	| 'field'
	| 'compound'
	| 'state-then-native'
	| 'observation'
	| 'subscription'
	| 'browser-action'
	| 'sandbox';

export type ControlAcknowledgement =
	| 'coordinator-snapshot'
	| 'page-controller-getter'
	| 'dom-event-getter'
	| 'dom-stable-getter'
	| 'chrome-event-getter'
	| 'processor-readback'
	| 'computed-style'
	| 'overlay-readback'
	| 'subscription-state'
	| 'operation-result';

export type ControlRecurringWork =
	| 'none'
	| 'while-owned'
	| 'while-subscribed'
	| 'page-lifetime-after-media-binding';

export interface ControlAlgorithmPolicy {
	scope: ControlScope;
	kind: ControlAlgorithmKind;
	orderedStrategies: readonly Exclude<ControlStrategy, 'unsupported'>[];
	acknowledgements: readonly ControlAcknowledgement[];
	recurringWork: ControlRecurringWork;
}

export type ControlNativePreference =
	| 'observation-only'
	| 'native-only'
	| 'hybrid-extension-native'
	| 'augmentation-only';

export type ControlAugmentationAdmission =
	| 'none'
	| 'native-incomplete'
	| 'extension-owned-capability'
	| 'proven-safe-source-or-explicit-full-output'
	| 'explicit-full-output-only'
	| 'existing-processor-only';

export interface ControlAlgorithmAdjudication {
	nativePreference: ControlNativePreference;
	augmentationAdmission: ControlAugmentationAdmission;
}

// This is the executable owner of the native/extension decision table. The
// CapabilityPlanner consumes this record, and the exhaustive Record type makes
// a new field or operation fail compilation until its complete algorithm is
// classified. `unsupported` is deliberately absent: it is the result after all
// listed candidates fail actual-write/readback checks.
export const CONTROL_ALGORITHM_POLICIES = {
	audioEnabled: {
		scope: 'document', kind: 'compound', orderedStrategies: ['extension-state'],
		acknowledgements: ['coordinator-snapshot'], recurringWork: 'none',
	},
	volumeBase: {
		scope: 'requested-audio-scope', kind: 'field',
		orderedStrategies: ['page-native', 'dom-native'],
		acknowledgements: ['page-controller-getter', 'dom-event-getter'],
		recurringWork: 'none',
	},
	boost: {
		scope: 'requested-audio-scope', kind: 'field',
		orderedStrategies: ['media-webaudio', 'capture'],
		acknowledgements: ['processor-readback'], recurringWork: 'page-lifetime-after-media-binding',
	},
	mediaMuted: {
		scope: 'requested-audio-scope', kind: 'field',
		orderedStrategies: ['page-native', 'dom-native'],
		acknowledgements: ['page-controller-getter', 'dom-event-getter'],
		recurringWork: 'none',
	},
	tabMuted: {
		scope: 'tab', kind: 'field', orderedStrategies: ['chrome-native'],
		acknowledgements: ['chrome-event-getter'], recurringWork: 'none',
	},
	speed: {
		scope: 'active-media', kind: 'field', orderedStrategies: ['page-native', 'dom-native'],
		acknowledgements: ['page-controller-getter', 'dom-event-getter'],
		recurringWork: 'none',
	},
	preservePitch: {
		scope: 'active-media', kind: 'field', orderedStrategies: ['dom-native'],
		acknowledgements: ['dom-stable-getter'], recurringWork: 'none',
	},
	playing: {
		scope: 'active-media', kind: 'field', orderedStrategies: ['dom-native'],
		acknowledgements: ['dom-event-getter'], recurringWork: 'none',
	},
	currentTime: {
		scope: 'active-media', kind: 'field', orderedStrategies: ['dom-native'],
		acknowledgements: ['dom-event-getter'], recurringWork: 'none',
	},
	loop: {
		scope: 'active-media', kind: 'field', orderedStrategies: ['dom-native'],
		acknowledgements: ['dom-stable-getter'], recurringWork: 'none',
	},
	pip: {
		scope: 'active-video', kind: 'field', orderedStrategies: ['dom-native'],
		acknowledgements: ['dom-event-getter'], recurringWork: 'none',
	},
	fullscreen: {
		scope: 'active-video', kind: 'field', orderedStrategies: ['dom-native'],
		acknowledgements: ['dom-event-getter'], recurringWork: 'none',
	},
	rotation: {
		scope: 'active-video', kind: 'field', orderedStrategies: ['extension-css'],
		acknowledgements: ['computed-style'], recurringWork: 'none',
	},
	mirrored: {
		scope: 'active-video', kind: 'field', orderedStrategies: ['extension-css'],
		acknowledgements: ['computed-style'], recurringWork: 'none',
	},
	fill: {
		scope: 'active-video', kind: 'field', orderedStrategies: ['extension-css'],
		acknowledgements: ['computed-style'], recurringWork: 'none',
	},
	filterEnabled: {
		scope: 'active-video', kind: 'field', orderedStrategies: ['extension-css'],
		acknowledgements: ['computed-style'], recurringWork: 'none',
	},
	filter: {
		scope: 'active-video', kind: 'field', orderedStrategies: ['extension-css'],
		acknowledgements: ['computed-style'], recurringWork: 'none',
	},
	dimEnabled: {
		scope: 'active-video', kind: 'field', orderedStrategies: ['extension-overlay'],
		acknowledgements: ['overlay-readback'], recurringWork: 'while-owned',
	},
	dimOpacity: {
		scope: 'active-video', kind: 'field', orderedStrategies: ['extension-overlay'],
		acknowledgements: ['overlay-readback'], recurringWork: 'while-owned',
	},
	abLoop: {
		scope: 'media-source', kind: 'compound', orderedStrategies: ['extension-state'],
		acknowledgements: ['coordinator-snapshot', 'dom-event-getter'],
		recurringWork: 'while-owned',
	},
	tabPinned: {
		scope: 'tab', kind: 'field', orderedStrategies: ['chrome-native'],
		acknowledgements: ['chrome-event-getter'], recurringWork: 'none',
	},
	eqValues: {
		scope: 'requested-audio-scope', kind: 'field', orderedStrategies: ['media-webaudio', 'capture'],
		acknowledgements: ['processor-readback'], recurringWork: 'page-lifetime-after-media-binding',
	},
	bass: {
		scope: 'requested-audio-scope', kind: 'field', orderedStrategies: ['media-webaudio', 'capture'],
		acknowledgements: ['processor-readback'], recurringWork: 'page-lifetime-after-media-binding',
	},
	compressor: {
		scope: 'requested-audio-scope', kind: 'field', orderedStrategies: ['media-webaudio', 'capture'],
		acknowledgements: ['processor-readback'], recurringWork: 'page-lifetime-after-media-binding',
	},
	mono: {
		scope: 'requested-audio-scope', kind: 'field', orderedStrategies: ['media-webaudio', 'capture'],
		acknowledgements: ['processor-readback'], recurringWork: 'page-lifetime-after-media-binding',
	},
	pan: {
		scope: 'requested-audio-scope', kind: 'field', orderedStrategies: ['media-webaudio', 'capture'],
		acknowledgements: ['processor-readback'], recurringWork: 'page-lifetime-after-media-binding',
	},
	delay: {
		scope: 'requested-audio-scope', kind: 'field', orderedStrategies: ['media-webaudio', 'capture'],
		acknowledgements: ['processor-readback'], recurringWork: 'page-lifetime-after-media-binding',
	},
	visualizer: {
		scope: 'requested-audio-scope', kind: 'subscription', orderedStrategies: ['observe'],
		acknowledgements: ['subscription-state'], recurringWork: 'while-subscribed',
	},
	'restore-page-settings': {
		scope: 'document', kind: 'compound', orderedStrategies: ['extension-state'],
		acknowledgements: ['coordinator-snapshot'], recurringWork: 'none',
	},
	'effective-volume': {
		scope: 'requested-audio-scope', kind: 'compound',
		orderedStrategies: ['page-native', 'dom-native', 'extension-state', 'media-webaudio', 'capture'],
		acknowledgements: ['page-controller-getter', 'dom-event-getter', 'processor-readback'],
		recurringWork: 'none',
	},
	'playback-toggle': {
		scope: 'active-media', kind: 'compound', orderedStrategies: ['dom-native'],
		acknowledgements: ['dom-event-getter'], recurringWork: 'none',
	},
	'seek-relative': {
		scope: 'active-media', kind: 'compound', orderedStrategies: ['dom-native'],
		acknowledgements: ['dom-event-getter'], recurringWork: 'none',
	},
	'frame-step': {
		// No native media API exposes exact frame stepping.
		// Extension-owned cadence estimation selects the delta, then the DOM executor
		// performs one measured, explicitly approximate native seek.
		scope: 'active-video', kind: 'state-then-native', orderedStrategies: ['dom-native'],
		acknowledgements: ['dom-event-getter'], recurringWork: 'none',
	},
	screenshot: {
		scope: 'active-video', kind: 'compound', orderedStrategies: ['chrome-native'],
		acknowledgements: ['operation-result'], recurringWork: 'none',
	},
	'marker-add': {
		scope: 'media-source', kind: 'compound', orderedStrategies: ['extension-state'],
		acknowledgements: ['coordinator-snapshot'], recurringWork: 'none',
	},
	'marker-remove': {
		scope: 'media-source', kind: 'compound', orderedStrategies: ['extension-state'],
		acknowledgements: ['coordinator-snapshot'], recurringWork: 'none',
	},
	'marker-jump': {
		scope: 'media-source', kind: 'state-then-native', orderedStrategies: ['dom-native'],
		acknowledgements: ['dom-event-getter'], recurringWork: 'none',
	},
	'marker-jump-previous': {
		scope: 'media-source', kind: 'state-then-native', orderedStrategies: ['dom-native'],
		acknowledgements: ['dom-event-getter'], recurringWork: 'none',
	},
	'marker-jump-next': {
		scope: 'media-source', kind: 'state-then-native', orderedStrategies: ['dom-native'],
		acknowledgements: ['dom-event-getter'], recurringWork: 'none',
	},
	'ab-set-a': {
		scope: 'media-source', kind: 'compound', orderedStrategies: ['extension-state'],
		acknowledgements: ['operation-result'], recurringWork: 'none',
	},
	'ab-set-b': {
		scope: 'media-source', kind: 'compound', orderedStrategies: ['extension-state'],
		acknowledgements: ['operation-result'], recurringWork: 'none',
	},
	'ab-clear': {
		scope: 'media-source', kind: 'compound', orderedStrategies: ['extension-state'],
		acknowledgements: ['operation-result'], recurringWork: 'none',
	},
	'ab-skip': {
		scope: 'media-source', kind: 'state-then-native', orderedStrategies: ['dom-native'],
		acknowledgements: ['dom-event-getter'], recurringWork: 'none',
	},
	'audio-reset': {
		scope: 'requested-audio-scope', kind: 'compound', orderedStrategies: ['extension-state'],
		acknowledgements: ['coordinator-snapshot'], recurringWork: 'none',
	},
	'video-effects-toggle': {
		scope: 'active-video', kind: 'compound', orderedStrategies: ['extension-state'],
		acknowledgements: ['coordinator-snapshot'], recurringWork: 'none',
	},
	'video-effects-reset': {
		scope: 'active-video', kind: 'compound', orderedStrategies: ['extension-state'],
		acknowledgements: ['coordinator-snapshot'], recurringWork: 'none',
	},
	'show-info': {
		scope: 'document', kind: 'observation', orderedStrategies: ['observe'],
		acknowledgements: ['coordinator-snapshot'], recurringWork: 'none',
	},
	'open-popup': {
		scope: 'extension-ui', kind: 'browser-action', orderedStrategies: ['chrome-native'],
		acknowledgements: ['operation-result'], recurringWork: 'none',
	},
	'open-options': {
		scope: 'extension-ui', kind: 'browser-action', orderedStrategies: ['chrome-native'],
		acknowledgements: ['operation-result'], recurringWork: 'none',
	},
	'run-user-script': {
		scope: 'sandbox', kind: 'sandbox', orderedStrategies: ['extension-state'],
		acknowledgements: ['operation-result'], recurringWork: 'none',
	},
	'open-url': {
		scope: 'tab', kind: 'browser-action', orderedStrategies: ['chrome-native'],
		acknowledgements: ['operation-result'], recurringWork: 'none',
	},
} as const satisfies Record<ControlCapability, ControlAlgorithmPolicy>;

// Ordered strategies say what may execute. This second exhaustive record says
// why a non-native candidate may be admitted at all. Keeping that distinction
// explicit prevents a future executor from treating Capture, CSS or WebAudio as
// a generic fallback merely because it appears later in an ordered list.
export const CONTROL_ALGORITHM_ADJUDICATIONS = {
	audioEnabled: { nativePreference: 'augmentation-only', augmentationAdmission: 'extension-owned-capability' },
	volumeBase: { nativePreference: 'native-only', augmentationAdmission: 'none' },
	boost: { nativePreference: 'augmentation-only', augmentationAdmission: 'proven-safe-source-or-explicit-full-output' },
	mediaMuted: { nativePreference: 'native-only', augmentationAdmission: 'none' },
	tabMuted: { nativePreference: 'native-only', augmentationAdmission: 'none' },
	speed: { nativePreference: 'native-only', augmentationAdmission: 'none' },
	preservePitch: { nativePreference: 'native-only', augmentationAdmission: 'none' },
	playing: { nativePreference: 'native-only', augmentationAdmission: 'none' },
	currentTime: { nativePreference: 'native-only', augmentationAdmission: 'none' },
	loop: { nativePreference: 'native-only', augmentationAdmission: 'none' },
	pip: { nativePreference: 'native-only', augmentationAdmission: 'none' },
	fullscreen: { nativePreference: 'native-only', augmentationAdmission: 'none' },
	rotation: { nativePreference: 'augmentation-only', augmentationAdmission: 'extension-owned-capability' },
	mirrored: { nativePreference: 'augmentation-only', augmentationAdmission: 'extension-owned-capability' },
	fill: { nativePreference: 'augmentation-only', augmentationAdmission: 'extension-owned-capability' },
	filterEnabled: { nativePreference: 'augmentation-only', augmentationAdmission: 'extension-owned-capability' },
	filter: { nativePreference: 'augmentation-only', augmentationAdmission: 'extension-owned-capability' },
	dimEnabled: { nativePreference: 'augmentation-only', augmentationAdmission: 'extension-owned-capability' },
	dimOpacity: { nativePreference: 'augmentation-only', augmentationAdmission: 'extension-owned-capability' },
	abLoop: { nativePreference: 'augmentation-only', augmentationAdmission: 'extension-owned-capability' },
	tabPinned: { nativePreference: 'native-only', augmentationAdmission: 'none' },
	eqValues: { nativePreference: 'augmentation-only', augmentationAdmission: 'proven-safe-source-or-explicit-full-output' },
	bass: { nativePreference: 'augmentation-only', augmentationAdmission: 'proven-safe-source-or-explicit-full-output' },
	compressor: { nativePreference: 'augmentation-only', augmentationAdmission: 'proven-safe-source-or-explicit-full-output' },
	mono: { nativePreference: 'augmentation-only', augmentationAdmission: 'proven-safe-source-or-explicit-full-output' },
	pan: { nativePreference: 'augmentation-only', augmentationAdmission: 'proven-safe-source-or-explicit-full-output' },
	delay: { nativePreference: 'augmentation-only', augmentationAdmission: 'proven-safe-source-or-explicit-full-output' },
	visualizer: { nativePreference: 'observation-only', augmentationAdmission: 'existing-processor-only' },
	'restore-page-settings': { nativePreference: 'augmentation-only', augmentationAdmission: 'extension-owned-capability' },
	'effective-volume': { nativePreference: 'hybrid-extension-native', augmentationAdmission: 'proven-safe-source-or-explicit-full-output' },
	'playback-toggle': { nativePreference: 'native-only', augmentationAdmission: 'none' },
	'seek-relative': { nativePreference: 'native-only', augmentationAdmission: 'none' },
	'frame-step': { nativePreference: 'hybrid-extension-native', augmentationAdmission: 'extension-owned-capability' },
	screenshot: { nativePreference: 'native-only', augmentationAdmission: 'none' },
	'marker-add': { nativePreference: 'augmentation-only', augmentationAdmission: 'extension-owned-capability' },
	'marker-remove': { nativePreference: 'augmentation-only', augmentationAdmission: 'extension-owned-capability' },
	'marker-jump': { nativePreference: 'hybrid-extension-native', augmentationAdmission: 'extension-owned-capability' },
	'marker-jump-previous': { nativePreference: 'hybrid-extension-native', augmentationAdmission: 'extension-owned-capability' },
	'marker-jump-next': { nativePreference: 'hybrid-extension-native', augmentationAdmission: 'extension-owned-capability' },
	'ab-set-a': { nativePreference: 'augmentation-only', augmentationAdmission: 'extension-owned-capability' },
	'ab-set-b': { nativePreference: 'augmentation-only', augmentationAdmission: 'extension-owned-capability' },
	'ab-clear': { nativePreference: 'augmentation-only', augmentationAdmission: 'extension-owned-capability' },
	'ab-skip': { nativePreference: 'hybrid-extension-native', augmentationAdmission: 'extension-owned-capability' },
	'audio-reset': { nativePreference: 'augmentation-only', augmentationAdmission: 'extension-owned-capability' },
	'video-effects-toggle': { nativePreference: 'augmentation-only', augmentationAdmission: 'extension-owned-capability' },
	'video-effects-reset': { nativePreference: 'augmentation-only', augmentationAdmission: 'extension-owned-capability' },
	'show-info': { nativePreference: 'observation-only', augmentationAdmission: 'none' },
	'open-popup': { nativePreference: 'native-only', augmentationAdmission: 'none' },
	'open-options': { nativePreference: 'native-only', augmentationAdmission: 'none' },
	'run-user-script': { nativePreference: 'augmentation-only', augmentationAdmission: 'extension-owned-capability' },
	'open-url': { nativePreference: 'native-only', augmentationAdmission: 'none' },
} as const satisfies Record<ControlCapability, ControlAlgorithmAdjudication>;

export interface ControlError {
	code: string;
	message: string;
	retryable: boolean;
}

export interface ControlFieldState<T> {
	desired: T | null;
	actual: T | null;
	// Captured before a restorable writer attempt so a failed transaction can
	// compensate through the same page-controller or standard-DOM writer.
	restoreBaseline?: T;
	revision: number;
	phase: ControlFieldPhase;
	strategy: ControlStrategy;
	coverage: ControlCoverage;
	controlled: boolean;
	intentId?: string;
	lastError: ControlError | null;
}

export type ControlFieldStates = {
	[K in ControlField]?: ControlFieldState<ControlValues[K]>;
};

export interface ControlIntent {
	intentId: string;
	tabId: number;
	documentId: string;
	generation: number;
	baseRevision: number;
	source: ControlIntentSource;
	requestedCoverage: ControlRequestedCoverage;
	target: MediaTarget | null;
	actualContext: ControlActualContext;
	patch: ControlPatch;
	// Background mints this volatile admission only for one current-tab Popup or
	// chrome.commands transaction. It is deliberately absent from
	// ControlSubmitRequest so callers cannot claim browser invocation authority.
	captureAdmission?: CaptureAdmission;
}

export interface ControlSubmitRequest {
	// Content-originated intents omit tabId; Background binds it to sender.tab.
	// Popup/remote/background callers must provide the explicit target tab.
	tabId?: number;
	source: Exclude<ControlIntentSource, 'system'>;
	requestedCoverage: ControlRequestedCoverage;
	target: MediaTarget | null;
	baseRevision?: number;
	patch?: ControlPatch;
	mutations?: readonly ControlMutation[];
	// Required only for source=page. Every observed patch field carries the
	// exact native getter/writer boundary that produced it; other sources must
	// not claim observation provenance.
	observedStrategies?: ControlNativeObservationStrategies;
}

export interface ControlMarker {
	id: string;
	time: number;
	label: string;
}

export interface ControlScreenshotResult {
	saved: true;
	method: 'capture-visible-tab';
	width: number;
	height: number;
}

export interface ControlFrameStepResult {
	currentTime: number;
	frameDuration: number;
	approximate: boolean;
}

export interface ControlOperationPayloadMap {
	'restore-page-settings': Record<string, never>;
	'effective-volume': { operation: 'set' | 'delta'; value: number };
	'playback-toggle': Record<string, never>;
	'seek-relative': { delta: number };
	'frame-step': { direction: -1 | 1 };
	screenshot: Record<string, never>;
	'marker-add': { label?: string };
	'marker-remove': { id: string };
	'marker-jump': { id: string };
	'marker-jump-previous': Record<string, never>;
	'marker-jump-next': Record<string, never>;
	'ab-set-a': Record<string, never>;
	'ab-set-b': Record<string, never>;
	'ab-clear': Record<string, never>;
	'ab-skip': Record<string, never>;
	'audio-reset': Record<string, never>;
	'video-effects-toggle': Record<string, never>;
	'video-effects-reset': Record<string, never>;
	'show-info': Record<string, never>;
	'open-popup': Record<string, never>;
	'open-options': Record<string, never>;
	'run-user-script': { script: string };
	'open-url': { url: string };
}

export interface ControlOperationResultMap {
	'restore-page-settings': { releasedFields: ControlField[] };
	'effective-volume': { effectiveVolume: number; volumeBase: number; boost: number };
	'playback-toggle': { playing: boolean };
	'seek-relative': { currentTime: number };
	'frame-step': ControlFrameStepResult;
	screenshot: ControlScreenshotResult;
	'marker-add': { marker: ControlMarker | null; remaining: number };
	'marker-remove': { removed: boolean; remaining: number };
	'marker-jump': { jumped: boolean; time: number };
	'marker-jump-previous': { jumped: boolean; actualTime: number | null; marker: ControlMarker | null };
	'marker-jump-next': { jumped: boolean; actualTime: number | null; marker: ControlMarker | null };
	'ab-set-a': { abLoop: ABLoopState };
	'ab-set-b': { abLoop: ABLoopState };
	'ab-clear': { abLoop: ABLoopState; cleared: boolean };
	'ab-skip': { abLoop: ABLoopState; skipped: boolean; currentTime: number | null };
	'audio-reset': { reset: true };
	'video-effects-toggle': { enabled: boolean };
	'video-effects-reset': { reset: true };
	'show-info': { shown: boolean };
	'open-popup': { opened: true };
	'open-options': { opened: true };
	'run-user-script': { executed: true };
	'open-url': { opened: true };
}

export type ControlOperationPayload<O extends ControlOperation> =
	ControlOperationPayloadMap[O];
export type ControlOperationResult<O extends ControlOperation> =
	ControlOperationResultMap[O];

export type ControlOperationRequest<O extends ControlOperation = ControlOperation> = {
	[K in O]: {
		tabId?: number;
		source: Exclude<ControlIntentSource, 'page' | 'system'>;
		target: MediaTarget | null;
		baseRevision?: number;
		operation: K;
		payload: ControlOperationPayloadMap[K];
	};
}[O];

export type ControlOperationIntent<O extends ControlOperation = ControlOperation> = {
	[K in O]: {
		operationId: string;
		tabId: number;
		documentId: string;
		generation: number;
		baseRevision: number;
		source: Exclude<ControlIntentSource, 'page' | 'system'>;
		target: MediaTarget | null;
		operation: K;
		payload: ControlOperationPayloadMap[K];
	};
}[O];

export type ControlOperationAck<O extends ControlOperation = ControlOperation> = {
	[K in O]: {
		operationId: string;
		tabId: number;
		documentId: string;
		generation: number;
		revision: number;
		target: MediaTarget | null;
		operation: K;
		strategy: ControlStrategy;
		coverage: ControlCoverage;
		fields: ControlFieldStates;
		result: ControlOperationResultMap[K];
	};
}[O];

export type ControlMutationOperation = 'set' | 'delta' | 'toggle';

export interface ControlMutation {
	field: ControlDirectField;
	operation: ControlMutationOperation;
	value?: ControlValues[ControlField];
}

export interface ControlSnapshot {
	tabId: number;
	documentId: string;
	origin: string;
	generation: number;
	revision: number;
	activeMedia: MediaTarget | null;
	activeVideo: MediaTarget | null;
	fields: ControlFieldStates;
}

export interface ControlApplyAck {
	intentId: string;
	tabId: number;
	documentId: string;
	generation: number;
	revision: number;
	target: MediaTarget | null;
	fields: ControlFieldStates;
}

export interface ControlReadRequest {
	fields: readonly ControlDirectField[];
	target: MediaTarget | null;
}

export interface ControlReadResult {
	target: MediaTarget | null;
	patch: ControlPatch;
	// Native semantic fields may be read through a complete page controller or
	// the standard DOM getter. Keep that provenance with the value instead of
	// reconstructing it in Background.
	observedStrategies: ControlNativeObservationStrategies;
}

const strategySet: ReadonlySet<string> = new Set(CONTROL_STRATEGIES);
const coverageSet: ReadonlySet<string> = new Set(['full', 'active-target', 'partial', 'opaque']);
const phaseSet: ReadonlySet<string> = new Set(['idle', 'applying', 'applied', 'error']);
const sourceSet: ReadonlySet<string> = new Set(['page', 'popup', 'remote', 'hotkey', 'restore', 'system']);
const controlFields: ReadonlySet<string> = new Set(CONTROL_FIELDS);
const controlDirectFields: ReadonlySet<string> = new Set(CONTROL_DIRECT_FIELDS);
const controlSessionFields: ReadonlySet<string> = new Set(CONTROL_SESSION_FIELDS);
const numericMutationFields: ReadonlySet<ControlField> = new Set([
	'volumeBase', 'boost', 'speed', 'currentTime', 'rotation', 'dimOpacity', 'pan', 'delay',
]);
const nativeObservationStrategies: ReadonlySet<string> = new Set(['page-native', 'dom-native']);
const pageNativeObservationFields: readonly ControlDirectField[] = [
	'volumeBase', 'mediaMuted', 'speed',
];
const bootstrapObservationFields: ReadonlySet<ControlDirectField> = new Set(
	CONTROL_BOOTSTRAP_OBSERVATION_GROUPS.flat(),
);

const intentKeys = new Set<keyof ControlIntent>([
	'intentId',
	'tabId',
	'documentId',
	'generation',
	'baseRevision',
	'source',
	'requestedCoverage',
	'target',
	'actualContext',
	'patch',
	'captureAdmission',
]);
const submitKeys = new Set<keyof ControlSubmitRequest>([
	'tabId',
	'source',
	'requestedCoverage',
	'target',
	'baseRevision',
	'patch',
	'mutations',
	'observedStrategies',
]);
const mutationKeys = new Set<keyof ControlMutation>(['field', 'operation', 'value']);
const operationRequestKeys = new Set([
	'tabId', 'source', 'target', 'baseRevision', 'operation', 'payload',
]);
const operationIntentKeys = new Set([
	'operationId', 'tabId', 'documentId', 'generation', 'baseRevision',
	'source', 'target', 'operation', 'payload',
]);
const operationAckKeys = new Set([
	'operationId', 'tabId', 'documentId', 'generation', 'revision', 'target',
	'operation', 'strategy', 'coverage', 'fields', 'result',
]);
const ackKeys = new Set<keyof ControlApplyAck>([
	'intentId',
	'tabId',
	'documentId',
	'generation',
	'revision',
	'target',
	'fields',
]);
const readRequestKeys = new Set<keyof ControlReadRequest>(['fields', 'target']);
const readResultKeys = new Set<keyof ControlReadResult>(['target', 'patch', 'observedStrategies']);
const snapshotKeys = new Set<keyof ControlSnapshot>([
	'tabId',
	'documentId',
	'origin',
	'generation',
	'revision',
	'activeMedia',
	'activeVideo',
	'fields',
]);
const targetKeys = new Set<keyof MediaTarget>([
	'frameId',
	'documentId',
	'mediaId',
	'sourceRevision',
	'kind',
]);
const fieldStateKeys = new Set<keyof ControlFieldState<unknown>>([
	'desired',
	'actual',
	'restoreBaseline',
	'revision',
	'phase',
	'strategy',
	'coverage',
	'controlled',
	'intentId',
	'lastError',
]);
const errorKeys = new Set<keyof ControlError>(['code', 'message', 'retryable']);
const filterKeys = new Set<keyof VideoFilterState>([
	'brightness',
	'contrast',
	'saturate',
	'grayscale',
	'invert',
]);
const actualContextKeys = new Set<keyof ControlActualContext>([
	'volumeBase', 'mediaMuted', 'speed', 'preservePitch',
]);
const abLoopKeys = new Set<keyof ABLoopState>(['pointA', 'pointB', 'enabled']);
const operationSet: ReadonlySet<string> = new Set(CONTROL_OPERATIONS);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
	return Object.keys(value).every((key) => allowed.has(key));
}

function isSafeNonNegativeInteger(value: unknown): value is number {
	return Number.isSafeInteger(value) && Number(value) >= 0;
}

function isFiniteInRange(value: unknown, minimum: number, maximum: number): value is number {
	return typeof value === 'number' && Number.isFinite(value) && value >= minimum && value <= maximum;
}

function isBoundedString(value: unknown, maximum: number): value is string {
	return typeof value === 'string' && value.length > 0 && value.length <= maximum;
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

export function compileEffectiveVolume(volumeBase: number, boost: number): number {
	const base = Math.max(0, Math.min(100, Number.isFinite(volumeBase) ? volumeBase : 100));
	const multiplier = Math.max(1, Math.min(8, Number.isFinite(boost) ? boost : 1));
	return Math.max(0, Math.min(800, Math.round(base * multiplier * 100) / 100));
}

export function splitEffectiveVolume(volume: number): { volumeBase: number; boost: number } {
	const normalized = Math.max(0, Math.min(800, Number.isFinite(volume) ? volume : 100));
	return normalized <= 100
		? { volumeBase: normalized, boost: 1 }
		: { volumeBase: 100, boost: normalized / 100 };
}

/** @deprecated One-release v1 name. Use splitEffectiveVolume. */
export const splitLegacyVolume = splitEffectiveVolume;

export function classifyControlStrategy(strategy: ControlStrategy): ControlStrategyClass {
	return CONTROL_STRATEGY_RULES[strategy].class;
}

// Cross-process ACKs must prove more than "this is a known strategy name".
// The strategy must also belong to the exact capability policy. This prevents
// a future executor (or a stale context) from reporting Capture as page volume,
// CSS as fullscreen, or extension state as a successful native operation.
export function isControlStrategyAdmittedForCapability(
	capability: ControlCapability,
	strategy: ControlStrategy,
): boolean {
	if (strategy === 'unsupported') return false;
	return (CONTROL_ALGORITHM_POLICIES[capability].orderedStrategies as readonly ControlStrategy[])
		.includes(strategy);
}

export function isControlError(value: unknown): value is ControlError {
	return isRecord(value)
		&& hasOnlyKeys(value, errorKeys)
		&& isBoundedString(value.code, 128)
		&& isBoundedString(value.message, 4096)
		&& typeof value.retryable === 'boolean';
}

export function isMediaTarget(value: unknown): value is MediaTarget {
	return isRecord(value)
		&& hasOnlyKeys(value, targetKeys)
		&& Number.isInteger(value.frameId)
		&& Number(value.frameId) >= 0
		&& isBoundedString(value.documentId, 256)
		&& isBoundedString(value.mediaId, 256)
		&& isSafeNonNegativeInteger(value.sourceRevision)
		&& (value.kind === 'audio' || value.kind === 'video');
}

function isVideoFilterState(value: unknown): value is VideoFilterState {
	return isRecord(value)
		&& hasOnlyKeys(value, filterKeys)
		&& isFiniteInRange(value.brightness, 0, 200)
		&& isFiniteInRange(value.contrast, 0, 200)
		&& isFiniteInRange(value.saturate, 0, 200)
		&& typeof value.grayscale === 'boolean'
		&& typeof value.invert === 'boolean';
}

function isNullableTime(value: unknown): value is number | null {
	return value === null || isFiniteInRange(value, 0, Number.MAX_SAFE_INTEGER);
}

function isABLoopState(value: unknown): value is ABLoopState {
	if (!isRecord(value) || !hasOnlyKeys(value, abLoopKeys)) return false;
	if (!isNullableTime(value.pointA) || !isNullableTime(value.pointB) || typeof value.enabled !== 'boolean') {
		return false;
	}
	if (value.enabled) {
		return value.pointA !== null && value.pointB !== null && value.pointB > value.pointA;
	}
	return value.pointB === null || value.pointA === null || value.pointB > value.pointA;
}

function isEmptyRecord(value: unknown): value is Record<string, never> {
	return isRecord(value) && Object.keys(value).length === 0;
}

function isControlMarker(value: unknown): value is ControlMarker {
	return isRecord(value)
		&& hasOnlyKeys(value, new Set(['id', 'time', 'label']))
		&& typeof value.id === 'string'
		&& /^m_[0-9a-f-]{36}$/iu.test(value.id)
		&& isFiniteInRange(value.time, 0, Number.MAX_SAFE_INTEGER)
		&& typeof value.label === 'string'
		&& value.label.length > 0
		&& value.label.length <= 256;
}

function isOperationPayload(operation: ControlOperation, value: unknown): boolean {
	if (operation === 'restore-page-settings') {
		return isRecord(value) && hasOnlyKeys(value, new Set());
	}
	if (operation === 'seek-relative') {
		return isRecord(value) && hasOnlyKeys(value, new Set(['delta']))
			&& isFiniteInRange(value.delta, -86_400, 86_400) && value.delta !== 0;
	}
	if (operation === 'effective-volume') {
		if (!isRecord(value) || !hasOnlyKeys(value, new Set(['operation', 'value']))
			|| (value.operation !== 'set' && value.operation !== 'delta')
			|| typeof value.value !== 'number' || !Number.isFinite(value.value)) return false;
		return value.operation === 'set'
			? value.value >= 0 && value.value <= 800
			: value.value >= -800 && value.value <= 800 && value.value !== 0;
	}
	if (operation === 'frame-step') {
		return isRecord(value) && hasOnlyKeys(value, new Set(['direction']))
			&& (value.direction === -1 || value.direction === 1);
	}
	if (operation === 'marker-add') {
		return isRecord(value) && hasOnlyKeys(value, new Set(['label']))
			&& (value.label === undefined || (
				typeof value.label === 'string' && value.label.length > 0 && value.label.length <= 256
			));
	}
	if (operation === 'marker-remove' || operation === 'marker-jump') {
		return isRecord(value) && hasOnlyKeys(value, new Set(['id']))
			&& typeof value.id === 'string' && /^m_[0-9a-f-]{36}$/iu.test(value.id);
	}
	if (operation === 'run-user-script') {
		return isRecord(value) && hasOnlyKeys(value, new Set(['script']))
			&& typeof value.script === 'string' && value.script.length > 0
			&& value.script.length <= 100_000;
	}
	if (operation === 'open-url') {
		if (!isRecord(value) || !hasOnlyKeys(value, new Set(['url']))
			|| typeof value.url !== 'string' || value.url.length > 8192) return false;
		try {
			const url = new URL(value.url);
			return url.protocol === 'http:' || url.protocol === 'https:';
		} catch { return false; }
	}
	return isEmptyRecord(value);
}

function isOperationResult(operation: ControlOperation, value: unknown): boolean {
	if (!isRecord(value)) return false;
	switch (operation) {
		case 'restore-page-settings':
			return hasOnlyKeys(value, new Set(['releasedFields']))
				&& Array.isArray(value.releasedFields)
				&& value.releasedFields.every((field) => typeof field === 'string' && controlFields.has(field));
		case 'effective-volume':
			return hasOnlyKeys(value, new Set(['effectiveVolume', 'volumeBase', 'boost']))
				&& isFiniteInRange(value.effectiveVolume, 0, 800)
				&& isFiniteInRange(value.volumeBase, 0, 100)
				&& isFiniteInRange(value.boost, 1, 8)
				&& compileEffectiveVolume(value.volumeBase, value.boost) === value.effectiveVolume;
		case 'playback-toggle':
			return hasOnlyKeys(value, new Set(['playing'])) && typeof value.playing === 'boolean';
		case 'seek-relative':
			return hasOnlyKeys(value, new Set(['currentTime']))
				&& isFiniteInRange(value.currentTime, 0, Number.MAX_SAFE_INTEGER);
		case 'frame-step':
			return hasOnlyKeys(value, new Set(['currentTime', 'frameDuration', 'approximate']))
				&& isFiniteInRange(value.currentTime, 0, Number.MAX_SAFE_INTEGER)
				&& isFiniteInRange(value.frameDuration, 0.001, 1)
				&& typeof value.approximate === 'boolean';
		case 'screenshot':
			return hasOnlyKeys(value, new Set(['saved', 'method', 'width', 'height']))
				&& value.saved === true
				&& value.method === 'capture-visible-tab'
				&& isFiniteInRange(value.width, 1, 100_000)
				&& isFiniteInRange(value.height, 1, 100_000);
		case 'marker-add':
			return hasOnlyKeys(value, new Set(['marker', 'remaining']))
				&& (value.marker === null || isControlMarker(value.marker))
				&& isFiniteInRange(value.remaining, 0, 1_000);
		case 'marker-remove':
			return hasOnlyKeys(value, new Set(['removed', 'remaining']))
				&& typeof value.removed === 'boolean'
				&& isFiniteInRange(value.remaining, 0, 1_000);
		case 'marker-jump':
			return hasOnlyKeys(value, new Set(['jumped', 'time']))
				&& typeof value.jumped === 'boolean'
				&& isFiniteInRange(value.time, 0, Number.MAX_SAFE_INTEGER);
		case 'marker-jump-previous':
		case 'marker-jump-next':
			return hasOnlyKeys(value, new Set(['jumped', 'actualTime', 'marker']))
				&& typeof value.jumped === 'boolean'
				&& (value.actualTime === null || isFiniteInRange(value.actualTime, 0, Number.MAX_SAFE_INTEGER))
				&& (value.marker === null || isControlMarker(value.marker));
		case 'ab-set-a':
		case 'ab-set-b':
			return hasOnlyKeys(value, new Set(['abLoop'])) && isABLoopState(value.abLoop);
		case 'ab-clear':
			return hasOnlyKeys(value, new Set(['abLoop', 'cleared']))
				&& isABLoopState(value.abLoop) && typeof value.cleared === 'boolean';
		case 'ab-skip':
			return hasOnlyKeys(value, new Set(['abLoop', 'skipped', 'currentTime']))
				&& isABLoopState(value.abLoop)
				&& typeof value.skipped === 'boolean'
				&& (value.currentTime === null
					|| isFiniteInRange(value.currentTime, 0, Number.MAX_SAFE_INTEGER));
		case 'audio-reset':
		case 'video-effects-reset':
			return hasOnlyKeys(value, new Set(['reset'])) && value.reset === true;
		case 'video-effects-toggle':
			return hasOnlyKeys(value, new Set(['enabled'])) && typeof value.enabled === 'boolean';
		case 'show-info':
			return hasOnlyKeys(value, new Set(['shown'])) && typeof value.shown === 'boolean';
		case 'open-popup':
		case 'open-options':
		case 'open-url':
			return hasOnlyKeys(value, new Set(['opened'])) && value.opened === true;
		case 'run-user-script':
			return hasOnlyKeys(value, new Set(['executed'])) && value.executed === true;
	}
}

function isControlValue(field: ControlField, value: unknown): boolean {
	switch (field) {
		case 'volumeBase': return isFiniteInRange(value, 0, 100);
		case 'boost': return isFiniteInRange(value, 1, 8);
		case 'speed': return isFiniteInRange(value, 0.1, 16);
		case 'currentTime': return isFiniteInRange(value, 0, Number.MAX_SAFE_INTEGER);
		case 'rotation': return value === 0 || value === 90 || value === 180 || value === 270;
		case 'filter': return isVideoFilterState(value);
		case 'abLoop': return isABLoopState(value);
		case 'dimOpacity': return isFiniteInRange(value, 0, 1);
		case 'eqValues': return Array.isArray(value)
			&& value.length === 10
			&& value.every((item) => isFiniteInRange(item, -12, 12));
		case 'pan': return isFiniteInRange(value, -1, 1);
		case 'delay': return isFiniteInRange(value, 0, 500);
		default: return typeof value === 'boolean';
	}
}

export function isControlPatch(value: unknown): value is ControlPatch {
	if (!isRecord(value) || !hasOnlyKeys(value, controlDirectFields) || Object.keys(value).length === 0) return false;
	return Object.entries(value).every(([field, item]) => isControlValue(field as ControlField, item));
}

export function isControlSessionPatch(value: unknown): value is ControlSessionPatch {
	return isControlPatch(value)
		&& Object.keys(value).every((field) => controlSessionFields.has(field));
}

function isControlNativeObservationStrategies(
	value: unknown,
	patch: ControlPatch,
	requireExactPatchKeys: boolean,
): value is ControlNativeObservationStrategies {
	if (!isRecord(value) || !hasOnlyKeys(value, controlDirectFields)) return false;
	const patchKeys = Object.keys(patch);
	const strategyKeys = Object.keys(value);
	if (requireExactPatchKeys && (
		strategyKeys.length !== patchKeys.length
		|| patchKeys.some((field) => !Object.hasOwn(value, field))
	)) return false;
	return Object.entries(value).every(([rawField, rawStrategy]) => {
		if (!Object.hasOwn(patch, rawField)
			|| typeof rawStrategy !== 'string'
			|| !nativeObservationStrategies.has(rawStrategy)) return false;
		return isControlStrategyAdmittedForCapability(
			rawField as ControlDirectField,
			rawStrategy as ControlNativeObservationStrategy,
		);
	});
}

function isBootstrapNativeObservationPatch(patch: ControlPatch): boolean {
	const patchKeys = Object.keys(patch) as ControlDirectField[];
	if (patchKeys.length === 0 || patchKeys.some((field) => !bootstrapObservationFields.has(field))) {
		return false;
	}
	return CONTROL_BOOTSTRAP_OBSERVATION_GROUPS.every((group) => {
		const present = group.filter((field) => Object.hasOwn(patch, field)).length;
		return present === 0 || present === group.length;
	});
}

function isControlActualContext(value: unknown): value is ControlActualContext {
	return isRecord(value)
		&& hasOnlyKeys(value, actualContextKeys)
		&& Object.entries(value).every(([field, item]) =>
			isControlValue(field as keyof ControlActualContext, item));
}

function isControlFieldState(field: ControlField, value: unknown): boolean {
	if (!isRecord(value) || !hasOnlyKeys(value, fieldStateKeys)) return false;
	const strategy = value.strategy as ControlStrategy;
	const admittedStrategy = typeof value.strategy === 'string'
		&& strategySet.has(value.strategy)
		&& (
			isControlStrategyAdmittedForCapability(field, strategy)
			|| (strategy === 'unsupported'
				&& value.phase === 'error'
				&& value.controlled === false
				&& value.lastError !== null)
			// A neutral or disabled processor reports an observation-only release:
			// no graph owns the field, and saved desired DSP values may remain idle.
			|| (strategy === 'observe'
				&& CONTROL_ALGORITHM_ADJUDICATIONS[field].augmentationAdmission
					=== 'proven-safe-source-or-explicit-full-output'
				&& value.controlled === false
				&& (value.phase === 'idle' || value.phase === 'applied'))
		);
	return (value.desired === null || isControlValue(field, value.desired))
		&& (value.actual === null || isControlValue(field, value.actual))
		&& (value.restoreBaseline === undefined || isControlValue(field, value.restoreBaseline))
		&& isSafeNonNegativeInteger(value.revision)
		&& typeof value.phase === 'string'
		&& phaseSet.has(value.phase)
		&& admittedStrategy
		&& typeof value.coverage === 'string'
		&& coverageSet.has(value.coverage)
		&& typeof value.controlled === 'boolean'
		&& (value.intentId === undefined || isBoundedString(value.intentId, 128))
		&& (value.lastError === null || isControlError(value.lastError));
}

function isControlFieldStates(value: unknown): value is ControlFieldStates {
	if (!isRecord(value) || !hasOnlyKeys(value, controlFields)) return false;
	return Object.entries(value).every(([field, state]) => isControlFieldState(field as ControlField, state));
}

export function isControlIntent(value: unknown): value is ControlIntent {
	return isRecord(value)
		&& hasOnlyKeys(value, intentKeys)
		&& isBoundedString(value.intentId, 128)
		&& (value.tabId === undefined || (Number.isInteger(value.tabId) && Number(value.tabId) > 0))
		&& isBoundedString(value.documentId, 256)
		&& isSafeNonNegativeInteger(value.generation)
		&& isSafeNonNegativeInteger(value.baseRevision)
		&& typeof value.source === 'string'
		&& sourceSet.has(value.source)
		&& (value.requestedCoverage === 'active-target' || value.requestedCoverage === 'full')
		&& (value.target === null || isMediaTarget(value.target))
		&& isControlActualContext(value.actualContext)
		&& isControlPatch(value.patch)
		&& (value.captureAdmission === undefined
			|| value.captureAdmission === 'extension-invocation');
}

export function isControlSubmitRequest(value: unknown): value is ControlSubmitRequest {
	const hasPatch = isRecord(value) && value.patch !== undefined;
	const hasMutations = isRecord(value) && value.mutations !== undefined;
	if (!isRecord(value)) return false;
	if (!hasOnlyKeys(value, submitKeys)) return false;
	const sourceIsPage = value.source === 'page';
	const observationShapeIsValid = sourceIsPage
		? value.requestedCoverage === 'active-target'
			&& hasPatch
			&& !hasMutations
			&& isControlPatch(value.patch)
			&& (value.target !== null || isBootstrapNativeObservationPatch(value.patch))
			&& isControlNativeObservationStrategies(value.observedStrategies, value.patch, true)
		: value.observedStrategies === undefined;
	return observationShapeIsValid
		&& (value.tabId === undefined || (Number.isInteger(value.tabId) && Number(value.tabId) > 0))
		&& typeof value.source === 'string'
		&& value.source !== 'system'
		&& sourceSet.has(value.source)
		&& (value.requestedCoverage === 'active-target' || value.requestedCoverage === 'full')
		&& (value.target === null || isMediaTarget(value.target))
		&& (value.baseRevision === undefined || isSafeNonNegativeInteger(value.baseRevision))
		&& (hasPatch || hasMutations)
		&& (value.patch === undefined || isControlPatch(value.patch))
		&& (value.mutations === undefined || (
			Array.isArray(value.mutations)
			&& value.mutations.length > 0
			&& value.mutations.length <= 32
			&& value.mutations.every(isControlMutation)
		));
}

export function isControlOperationRequest(value: unknown): value is ControlOperationRequest {
	return isRecord(value)
		&& hasOnlyKeys(value, operationRequestKeys)
		&& (value.tabId === undefined || (Number.isInteger(value.tabId) && Number(value.tabId) > 0))
		&& typeof value.source === 'string'
		&& value.source !== 'page'
		&& value.source !== 'system'
		&& sourceSet.has(value.source)
		&& (value.target === null || isMediaTarget(value.target))
		&& (value.baseRevision === undefined || isSafeNonNegativeInteger(value.baseRevision))
		&& typeof value.operation === 'string'
		&& operationSet.has(value.operation)
		&& isOperationPayload(value.operation as ControlOperation, value.payload);
}

export function isControlOperationIntent(value: unknown): value is ControlOperationIntent {
	return isRecord(value)
		&& hasOnlyKeys(value, operationIntentKeys)
		&& isBoundedString(value.operationId, 128)
		&& Number.isInteger(value.tabId)
		&& Number(value.tabId) > 0
		&& isBoundedString(value.documentId, 256)
		&& isSafeNonNegativeInteger(value.generation)
		&& isSafeNonNegativeInteger(value.baseRevision)
		&& typeof value.source === 'string'
		&& value.source !== 'page'
		&& value.source !== 'system'
		&& sourceSet.has(value.source)
		&& (value.target === null || isMediaTarget(value.target))
		&& typeof value.operation === 'string'
		&& operationSet.has(value.operation)
		&& isOperationPayload(value.operation as ControlOperation, value.payload);
}

export function isControlOperationAck(value: unknown): value is ControlOperationAck {
	return isRecord(value)
		&& hasOnlyKeys(value, operationAckKeys)
		&& isBoundedString(value.operationId, 128)
		&& Number.isInteger(value.tabId)
		&& Number(value.tabId) > 0
		&& isBoundedString(value.documentId, 256)
		&& isSafeNonNegativeInteger(value.generation)
		&& isSafeNonNegativeInteger(value.revision)
		&& (value.target === null || isMediaTarget(value.target))
		&& typeof value.operation === 'string'
		&& operationSet.has(value.operation)
		&& typeof value.strategy === 'string'
		&& strategySet.has(value.strategy)
		&& isControlStrategyAdmittedForCapability(
			value.operation as ControlOperation,
			value.strategy as ControlStrategy,
		)
		&& typeof value.coverage === 'string'
		&& coverageSet.has(value.coverage)
		&& isControlFieldStates(value.fields)
		&& isOperationResult(value.operation as ControlOperation, value.result);
}

function isControlMutation(value: unknown): value is ControlMutation {
	if (!isRecord(value)
		|| !hasOnlyKeys(value, mutationKeys)
		|| typeof value.field !== 'string'
		|| !controlDirectFields.has(value.field)
		|| (value.operation !== 'set' && value.operation !== 'delta' && value.operation !== 'toggle')) {
		return false;
	}
	const field = value.field as ControlDirectField;
	if (value.operation === 'set') return isControlValue(field, value.value);
	if (value.operation === 'toggle') {
		return value.value === undefined && isControlValue(field, false);
	}
	return typeof value.value === 'number'
		&& Number.isFinite(value.value)
		&& value.value !== 0
		&& numericMutationFields.has(field);
}

export function isControlSnapshot(value: unknown): value is ControlSnapshot {
	return isRecord(value)
		&& hasOnlyKeys(value, snapshotKeys)
		&& Number.isInteger(value.tabId)
		&& Number(value.tabId) > 0
		&& isBoundedString(value.documentId, 256)
		&& isCanonicalOrigin(value.origin)
		&& isSafeNonNegativeInteger(value.generation)
		&& isSafeNonNegativeInteger(value.revision)
		&& (value.activeMedia === null || isMediaTarget(value.activeMedia))
		&& (value.activeVideo === null
			|| isMediaTarget(value.activeVideo) && value.activeVideo.kind === 'video')
		&& isControlFieldStates(value.fields);
}

export function isControlApplyAck(value: unknown): value is ControlApplyAck {
	return isRecord(value)
		&& hasOnlyKeys(value, ackKeys)
		&& isBoundedString(value.intentId, 128)
		&& Number.isInteger(value.tabId)
		&& Number(value.tabId) > 0
		&& isBoundedString(value.documentId, 256)
		&& isSafeNonNegativeInteger(value.generation)
		&& isSafeNonNegativeInteger(value.revision)
		&& (value.target === null || isMediaTarget(value.target))
		&& isControlFieldStates(value.fields);
}

export function isControlReadRequest(value: unknown): value is ControlReadRequest {
	return isRecord(value)
		&& hasOnlyKeys(value, readRequestKeys)
		&& Array.isArray(value.fields)
		&& value.fields.length > 0
		&& value.fields.length <= CONTROL_DIRECT_FIELDS.length
		&& new Set(value.fields).size === value.fields.length
		&& value.fields.every((field) => typeof field === 'string' && controlDirectFields.has(field))
		&& (value.target === null || isMediaTarget(value.target));
}

export function isControlReadResult(value: unknown): value is ControlReadResult {
	if (!isRecord(value)) return false;
	const patch = value.patch;
	const observedStrategies = value.observedStrategies;
	if (!hasOnlyKeys(value, readResultKeys)
		|| (value.target !== null && !isMediaTarget(value.target))
		|| !isControlPatch(patch)
		|| !isControlNativeObservationStrategies(observedStrategies, patch, false)) {
		return false;
	}
	return pageNativeObservationFields.every((field) => (
		patch[field] === undefined
		|| Object.hasOwn(observedStrategies, field)
	));
}
