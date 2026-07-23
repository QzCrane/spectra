// goal: content-only audio-engine entry without planner and package-wide re-export reachability

export * from './constants.js';
export { PolicyEngine } from './PolicyEngine.js';
export {
	AudioGraphRouter,
	AUDIO_GRAPH_CROSSFADE_MS,
	AUDIO_PARAM_RAMP_MS,
	DEFAULT_AUDIO_GRAPH_CONFIG,
	audioConfigToGraphConfig,
	audioGraphSignature,
	normalizeAudioGraphConfig,
} from './AudioGraphRouter.js';
export {
	WebAudioController,
	assessMediaSourceCoverage,
	assessMediaSourceEligibility,
} from './WebAudioController.js';
export {
	needsAdvancedProcessing,
	predictCapture,
	requiresAudioProcessor,
} from './color-predictor.js';
