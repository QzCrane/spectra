// goal: core audio processing engine for SPECTRA
// note: integrates policy engine, WebAudio controllers, and capture mode heuristics

export * from './constants.js';

export { PolicyEngine } from './PolicyEngine.js';
export type { PolicyContext, UrlInfo } from '@nexus/contracts';

export { CapabilityPlanner } from './CapabilityPlanner.js';
export type {
	CapabilitySupport,
	CapabilityPlannerContext,
	CapabilityPlan,
	CapabilityAttempt,
} from './CapabilityPlanner.js';

export {
	AudioGraphRouter,
	AUDIO_GRAPH_CROSSFADE_MS,
	AUDIO_PARAM_RAMP_MS,
	DEFAULT_AUDIO_GRAPH_CONFIG,
	audioConfigToGraphConfig,
	audioGraphSignature,
	normalizeAudioGraphConfig,
} from './AudioGraphRouter.js';
export type {
	AudioGraphApplyOptions,
	AudioGraphConfig,
	AudioGraphRouterOptions,
	AudioGraphSnapshot,
} from './AudioGraphRouter.js';

export {
	WebAudioController,
	assessMediaSourceCoverage,
	assessMediaSourceEligibility,
} from './WebAudioController.js';
export type {
	MediaSourceCoverageAssessment,
	MediaSourceEligibility,
	MediaSourceEligibilityEvidence,
	MediaSourceEligibilityReason,
} from './WebAudioController.js';

export {
	needsAdvancedProcessing,
	predictCapture,
	requiresAudioProcessor,
} from './color-predictor.js';
export type { ColorContext } from './color-predictor.js';
