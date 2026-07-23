// goal: routes audio processing commands to the appropriate execution layer (DOM, WebAudio, or Tab Capture) based on the active policy mode

import {
	AudioMode,
	assessMediaSourceCoverage,
	audioGraphSignature,
	requiresAudioProcessor,
	type AudioGraphSnapshot,
} from '@nexus/audio-engine';
import { DEFAULT_AUDIO_CONFIG, type AudioConfig } from '@nexus/kernel';
import { resolveAudioVolume, type CaptureAdmission } from '@nexus/contracts';
import type { PolicyExecutorDeps, PolicyExecutorState } from '../types';
import { isAnyMediaPlaying } from '../audio/media-detection';
import { logger } from '../../shared/logger';
import { getActiveMediaRegistry } from '../core/media-registry';

const log = logger.content;

let currentUpdateBadge: (() => void) | null = null;
let currentBroadcastUI: (() => void) | null = null;
let executionRun = 0;
const CAPTURE_ADMISSION_REQUIRED = 'Capture requires a current-tab extension invocation';

export function initModeExecutorCallbacks(
	_deps: PolicyExecutorDeps,
	_state: PolicyExecutorState,
	updateBadge: () => void,
	broadcastUI: () => void,
	_updateConfig: (changes: Partial<AudioConfig>, options?: { isNativeSync?: boolean }) => void
): () => void {
	currentUpdateBadge = updateBadge;
	currentBroadcastUI = broadcastUI;
	return () => {
		currentUpdateBadge = null;
		currentBroadcastUI = null;
	};
}

// post: returns true if the user has engaged with the page, making it safe to initialize AudioContext
export function hasUserGesture(state: PolicyExecutorState): boolean {
	if (state.userHasInteracted || state.hasGesture) return true;

	// rule: active media playback or navigator.userActivation signals implied user intent
	if (isAnyMediaPlaying()) return true;

	const userActivation = (navigator as Navigator & { userActivation?: { hasBeenActive: boolean } }).userActivation;
	if (userActivation?.hasBeenActive) return true;

	return false;
}

// eff: orchestrates audio modifications by dispatching to specialized controllers based on activeMode
export function executeMode(
	deps: PolicyExecutorDeps,
	state: PolicyExecutorState,
	advanceGeneration = false,
	captureAdmission?: CaptureAdmission,
): Promise<void> {
	const run = executionRun + 1;
	executionRun = run;
	if (advanceGeneration) state.generation += 1;
	return executeModeTransition(deps, state, run, state.generation, captureAdmission);
}
async function executeModeTransition(
	deps: PolicyExecutorDeps,
	state: PolicyExecutorState,
	run: number,
	generation: number,
	captureAdmission?: CaptureAdmission,
): Promise<void> {
	const { audioController, captureManager } = deps;
	const mode = state.activeMode;
	const config = state.config;
	const previousActualMode = state.actualMode;
	const previousAppliedConfig = cloneAudioConfig(state.appliedConfig);

	// A pending START owns no acknowledged processor yet, so it cannot be made
	// transparent. Let it settle before bringing up a replacement path; once it
	// becomes active the normal handoff below first applies a unity config. This
	// prevents a delayed START from overlapping WebAudio/DOM or surviving disable.
	if (captureManager.isPending()) {
		await captureManager.waitForSettled();
		if (run !== executionRun) return;
	}

	if (mode === AudioMode.CAPTURE) {
		// The optional media processor is made transparent before Capture starts.
		// Standard page volume/mute remain native and are never a mode-owned path.
		await audioController.cleanup();
		if (captureManager.isActive()) {
			state.phase = 'starting';
			const synced = await captureManager.syncConfig(config, generation);
			if (run !== executionRun) return;
			state.generation = Math.max(state.generation, captureManager.getGeneration());
			state.actualMode = 'capture';
			state.phase = synced ? 'active' : 'error';
			if (synced) state.appliedConfig = cloneAudioConfig(synced);
			state.lastError = synced ? undefined : captureManager.getLastError();
		} else if (captureAdmission === 'extension-invocation') {
			log.capture('Strategy suggests CAPTURE and current-tab invocation is admitted, requesting...');
			state.phase = 'starting';
			const result = await captureManager.request(true, config, generation);
			if (run !== executionRun) return;
			if (result.phase === 'active') {
				state.generation = result.generation ?? run;
				state.actualMode = 'capture';
				state.phase = 'active';
				state.appliedConfig = result.actualConfig
					? cloneAudioConfig(result.actualConfig)
					: captureManager.getActualConfig() ?? transparentAudioConfig();
				state.lastError = undefined;
			} else if (result.active) {
				state.actualMode = 'capture';
				state.phase = 'error';
				state.appliedConfig = result.actualConfig
					? cloneAudioConfig(result.actualConfig)
					: captureManager.getActualConfig() ?? transparentAudioConfig();
				state.lastError = result.error ?? 'Capture actual configuration is unavailable';
			} else {
				// Restore the last acknowledged path when capture startup fails.
				const restoredWebAudio = previousActualMode === 'webaudio'
					? await restoreWebAudioState(previousAppliedConfig, deps).catch(() => null)
					: null;
				if (restoredWebAudio) {
					state.actualMode = 'webaudio';
					state.appliedConfig = restoredWebAudio;
				} else {
					state.actualMode = 'bypass';
					state.appliedConfig = toDomAppliedConfig(config);
				}
				state.phase = 'error';
				state.lastError = result.error;
			}
		} else {
			state.actualMode = 'bypass';
			state.phase = 'error';
			state.appliedConfig = toDomAppliedConfig(config);
			state.lastError = CAPTURE_ADMISSION_REQUIRED;
		}

	} else if (mode === AudioMode.DISABLED) {
		if (captureManager.isActive() || captureManager.isPending()) {
			const transparentActual = captureManager.isActive()
				? await captureManager.syncConfig(transparentAudioConfig(), generation)
				: null;
			if (captureManager.isActive() && !transparentActual) {
				state.actualMode = 'capture';
				state.phase = 'error';
				state.lastError = captureManager.getLastError();
				currentUpdateBadge?.();
				currentBroadcastUI?.();
				return;
			}
			if (run !== executionRun) return;
			await audioController.cleanup();
			state.phase = 'stopping';
			const result = await captureManager.request(false, config, generation);
			if (run !== executionRun) return;
			state.generation = result.generation ?? run;
			if (result.status === 'error' && result.active) {
				// The retained capture processor was acknowledged transparent before
				// shutdown. Playback is therefore bypass, even though its lease remains
				// alive for a retry.
				state.actualMode = 'bypass';
				state.phase = 'error';
				state.appliedConfig = transparentActual ?? transparentAudioConfig();
				state.lastError = result.error;
				currentUpdateBadge?.();
				currentBroadcastUI?.();
				return;
			}
		}
		await audioController.cleanup();
		state.actualMode = 'bypass';
		state.phase = 'idle';
		state.appliedConfig = transparentAudioConfig();
		state.lastError = undefined;
	} else if (mode === AudioMode.NATIVE_LITE) {
		if (captureManager.isActive() || captureManager.isPending()) {
			const transparentActual = captureManager.isActive()
				? await captureManager.syncConfig(transparentAudioConfig(), generation)
				: null;
			if (captureManager.isActive() && !transparentActual) {
				state.actualMode = 'capture';
				state.phase = 'error';
				state.lastError = captureManager.getLastError();
				currentUpdateBadge?.();
				currentBroadcastUI?.();
				return;
			}
			if (run !== executionRun) return;
			// Native standard-media state is already live; only the processor lease
			// needs to leave its transparent handoff state.
			await audioController.cleanup();
			state.phase = 'stopping';
			const result = await captureManager.request(false, config, generation);
			if (run !== executionRun) return;
			state.generation = result.generation ?? run;
			if (result.status === 'error' && result.active) {
				// DOM is the applied path; the retained capture graph is unity-only.
				state.actualMode = 'bypass';
				state.phase = 'error';
				state.appliedConfig = toDomAppliedConfig(config);
				state.lastError = result.error;
				currentUpdateBadge?.();
				currentBroadcastUI?.();
				return;
			}
		}
		await audioController.cleanup();
		// Native-lite is zero DSP. NativeMediaExecutor continues to own any
		// explicit standard media controls independently of this mode.
		state.actualMode = 'bypass';
		state.phase = 'idle';
		state.appliedConfig = toDomAppliedConfig(config);

	} else if (mode === AudioMode.NATIVE_WEBAUDIO) {
		const handingOffCapture = captureManager.isActive() || captureManager.isPending();
		const registry = getActiveMediaRegistry();
		const mediaElements = (registry?.list() ?? []).map(({ element }) => element);
		const evidenceFor = (element: HTMLMediaElement) =>
			typeof registry?.getEligibilityEvidence === 'function'
				? registry.getEligibilityEvidence(element)
				: undefined;
		const prospectiveCoverage = assessMediaSourceCoverage(mediaElements, evidenceFor);
		if (!prospectiveCoverage.fullCoverage) {
			await audioController.cleanup();
			if (captureManager.isActive()) {
				const restored = await captureManager.syncConfig(config, generation);
				if (run !== executionRun) return;
				state.actualMode = restored ? 'capture' : 'bypass';
				state.appliedConfig = restored
					? cloneAudioConfig(restored)
					: transparentAudioConfig();
				state.phase = restored ? 'active' : 'error';
				state.lastError = restored
					? undefined
					: captureManager.getLastError() ?? 'Media WebAudio coverage is incomplete';
			} else if (requiresAudioProcessor(config)
				&& captureAdmission === 'extension-invocation') {
				// rule: Capture is the last-resort full-output path (SCTRL-011).
				// When Media WebAudio coverage fails but a processor is explicitly
				// needed (volume > 100, EQ, bass, etc.), capture can still serve
				// the request because tabCapture is not blocked by page CORS.
				// Background admission is required because Capture is bound to a
				// current-tab extension invocation. This also covers the case
				// where a site was mistakenly pinned to `direct` in the registry
				// but the page's media sources are in fact cross-origin.
				log.capture('WebAudio coverage failed with active processor need, falling back to Capture');
				state.phase = 'starting';
				const result = await captureManager.request(true, config, generation);
				if (run !== executionRun) return;
				if (result.phase === 'active') {
					state.generation = result.generation ?? run;
					state.actualMode = 'capture';
					state.phase = 'active';
					state.appliedConfig = result.actualConfig
						? cloneAudioConfig(result.actualConfig)
						: captureManager.getActualConfig() ?? transparentAudioConfig();
					state.lastError = undefined;
				} else {
					state.actualMode = 'bypass';
					state.phase = 'error';
					state.appliedConfig = toDomAppliedConfig(config);
					state.lastError = result.error ?? 'Capture fallback failed after WebAudio coverage failure';
				}
			} else {
				state.actualMode = 'bypass';
				state.phase = 'error';
				state.appliedConfig = toDomAppliedConfig(config);
				state.lastError = requiresAudioProcessor(config)
					? CAPTURE_ADMISSION_REQUIRED
					: prospectiveCoverage.eligibility === 'unknown'
						? 'Media WebAudio coverage is not yet proven'
						: 'Media WebAudio coverage is unsafe';
			}
			currentUpdateBadge?.();
			currentBroadcastUI?.();
			return;
		}
		const transparentCaptureActual = captureManager.isActive()
			? await captureManager.syncConfig(transparentAudioConfig(), generation)
			: null;
		if (captureManager.isActive() && !transparentCaptureActual) {
			state.actualMode = 'capture';
			state.phase = 'error';
			state.lastError = captureManager.getLastError();
			currentUpdateBadge?.();
			currentBroadcastUI?.();
			return;
		}
		if (run !== executionRun) return;

		if (hasUserGesture(state)) {
			// rule: always attempt to initialize or resume the context if we have a gesture
			// this handles cases where it's 'ready' but suspended
			state.phase = 'starting';
			const success = await audioController.initialize(true);
			if (run !== executionRun) return;
			if (success) {
				const attached = mediaElements.every((element) =>
					audioController.ensureAttached(element, evidenceFor(element)));
				let graphError: string | undefined;
				let graphActual: AudioConfig | null = null;
				if (!attached || !audioController.hasCompleteCoverage(mediaElements, evidenceFor)) {
					graphError = 'Media WebAudio did not bind the complete registry scope';
				} else try {
					graphActual = await applyWebAudioState(config, deps);
				} catch (error) {
					log.warn('WebAudio graph apply failed', error);
					graphError = error instanceof Error ? error.message : String(error);
				}
				if (!graphError && !graphActual) graphError = 'WebAudio graph returned no actual configuration';
				if (graphError) {
					await audioController.cleanup();
					if (captureManager.isActive()) {
						const restored = await captureManager.syncConfig(config, generation);
						if (run !== executionRun) return;
						state.actualMode = restored ? 'capture' : 'bypass';
						state.appliedConfig = restored
							? cloneAudioConfig(restored)
							: transparentAudioConfig();
						state.lastError = restored
							? graphError
							: captureManager.getLastError() ?? graphError;
					} else {
						state.actualMode = 'bypass';
						state.appliedConfig = toDomAppliedConfig(config);
						state.lastError = graphError;
					}
					state.phase = 'error';
					currentUpdateBadge?.();
					currentBroadcastUI?.();
					return;
				}
				if (handingOffCapture) {
					const result = await captureManager.request(false, config, generation);
					if (run !== executionRun) return;
					state.generation = result.generation ?? run;
					if (result.status === 'error' && result.active) {
						// WebAudio is already confirmed and capture was switched to unity.
						state.actualMode = 'webaudio';
						state.phase = 'error';
						state.appliedConfig = graphActual ?? toDomAppliedConfig(config);
						state.lastError = result.error;
						currentUpdateBadge?.();
						currentBroadcastUI?.();
						return;
					}
				}
				state.actualMode = 'webaudio';
				state.phase = 'active';
				state.appliedConfig = graphActual ?? toDomAppliedConfig(config);
				state.lastError = undefined;
			} else {
				if (captureManager.isActive()) {
					const restored = await captureManager.syncConfig(config, generation);
					state.actualMode = 'capture';
					state.appliedConfig = restored
						? cloneAudioConfig(restored)
						: transparentAudioConfig();
				} else {
					log.debug('WebAudio resume/init failed -> transparent native path');
					state.actualMode = 'bypass';
					state.appliedConfig = toDomAppliedConfig(config);
				}
				state.phase = 'error';
				state.lastError = 'Unable to start WebAudio';
			}
		} else {
			state.actualMode = 'bypass';
			state.phase = 'idle';
			state.appliedConfig = toDomAppliedConfig(config);
		}
	}

	if (run === executionRun) {
		currentUpdateBadge?.();
		currentBroadcastUI?.();
	}
}
function transparentAudioConfig(): AudioConfig {
	return {
		...DEFAULT_AUDIO_CONFIG,
		eqValues: [...DEFAULT_AUDIO_CONFIG.eqValues],
	};
}

function cloneAudioConfig(config: AudioConfig): AudioConfig {
	return { ...config, eqValues: [...config.eqValues] };
}

// post: describes only controls the native media-element path can implement.
// Unsupported DSP fields are neutral so snapshots never claim an EQ/boost that
// a capture/WebAudio startup failure did not apply.
export function toDomAppliedConfig(config: AudioConfig): AudioConfig {
	const volume = resolveAudioVolume(config);
	return {
		...config,
		volume: volume.volumeBase,
		volumeBase: volume.volumeBase,
		boost: 1,
		compressor: false,
		mono: false,
		bass: false,
		eqValues: [...DEFAULT_AUDIO_CONFIG.eqValues],
		pan: 0,
		delay: 0,
	};
}

// post: compensates for the DOM attenuation owned by SPECTRA so every media
// graph has the same effective output, including elements inserted by an SPA.
export function toWebAudioProcessingConfig(config: AudioConfig): AudioConfig {
	const volume = resolveAudioVolume(config);
	return {
		...config,
		volume: volume.effectiveVolume,
		volumeBase: volume.volumeBase,
		boost: volume.boost,
	};
}

// eff: applies WebAudio processing while maintaining visual sync with native volume slider
// theory: for <= 100%, we let DOM handle attenuation (visual sync). For > 100%, we lock DOM to 100% and apply boost via WebAudio.
async function applyWebAudioState(config: AudioConfig, deps: PolicyExecutorDeps): Promise<AudioConfig> {
	const { audioController } = deps;
	const effectiveConfig = toWebAudioProcessingConfig(config);
	const snapshot = await audioController.applyConfig(effectiveConfig);
	if (snapshot.contextState !== 'running' || snapshot.sourceCount < 1) {
		throw new Error('WebAudio graph did not return a running source-backed ACK');
	}
	if (audioGraphSignature(snapshot.normalizedActualConfig) !== snapshot.graphSignature) {
		throw new Error('WebAudio graph signature does not match its normalized actual configuration');
	}
	return actualConfigFromGraphSnapshot(config, snapshot);
}

async function restoreWebAudioState(
	config: AudioConfig,
	deps: PolicyExecutorDeps,
): Promise<AudioConfig | null> {
	const registry = getActiveMediaRegistry();
	const entries = registry?.list() ?? [];
	const elements = entries.map(({ element }) => element);
	const evidenceFor = (element: HTMLMediaElement) =>
		typeof registry?.getEligibilityEvidence === 'function'
			? registry.getEligibilityEvidence(element)
			: undefined;
	if (!assessMediaSourceCoverage(elements, evidenceFor).fullCoverage) return null;
	if (!await deps.audioController.initialize(true)) return null;
	if (!elements.every((element) => deps.audioController.ensureAttached(element, evidenceFor(element)))) {
		return null;
	}
	if (!deps.audioController.hasCompleteCoverage(elements, evidenceFor)) return null;
	return applyWebAudioState(config, deps);
}

function actualConfigFromGraphSnapshot(
	requested: AudioConfig,
	snapshot: AudioGraphSnapshot,
): AudioConfig {
	const actual = snapshot.normalizedActualConfig;
	const volumeBase = resolveAudioVolume(requested).volumeBase;
	return {
		...requested,
		volumeBase,
		boost: actual.boostGain,
		volume: Math.round(volumeBase * actual.boostGain * 100) / 100,
		bass: actual.bass,
		eqValues: [...actual.eqValues],
		compressor: actual.compressor,
		mono: actual.mono,
		pan: actual.pan,
		delay: actual.delay,
	};
}
