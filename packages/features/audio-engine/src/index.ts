// goal: core audio processing engine for SPECTRA
// note: integrates policy engine, WebAudio controllers, and capture mode heuristics

export * from './constants.js';

export { PolicyEngine } from './PolicyEngine.js';
export type { PolicyContext, UrlInfo } from '@nexus/contracts';

export { WebAudioController } from './WebAudioController.js';
export type { CorsDetectedCallback } from './WebAudioController.js';

export { predictCapture, needsAdvancedProcessing } from './color-predictor.js';
export type { ColorContext } from './color-predictor.js';
