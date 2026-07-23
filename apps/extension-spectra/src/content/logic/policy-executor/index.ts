// goal: orchestrates PolicyEngine decisions with AudioController and CaptureManager

import { isDefaultAudioConfig, resolveAudioVolume } from '@nexus/contracts';
import {
	assessMediaSourceCoverage,
	type PolicyContext,
	type MediaSourceEligibilityEvidence,
	type UrlInfo,
} from '@nexus/audio-engine';
import { logger } from '../../../shared/logger';
import type { PolicyExecutorDeps, PolicyExecutorState } from '../../types';
import { executeMode, hasUserGesture, initModeExecutorCallbacks } from '../mode-executor';
import type { PolicyApplicationOptions, PolicyExecutor, InternalState } from './types';
import { updateBadge, broadcastUI } from './badge-sync';
import { updateConfig } from './config-updater';
import { getActiveMediaRegistry } from '../../core/media-registry';
import {
	createSiteEligibilityCache,
} from './eligibility-cache';

const log = logger.content;

export function evaluateMediaSourceEligibility(
	elements: readonly HTMLMediaElement[],
	hasKnownBindingFailure: (element: HTMLMediaElement) => boolean = () => false,
	evidenceFor: (element: HTMLMediaElement) => MediaSourceEligibilityEvidence | undefined = () => undefined,
): InternalState['corsStatus'] {
	const coverage = assessMediaSourceCoverage(elements, evidenceFor);
	if (coverage.eligibility === 'unsafe') return 'RESTRICTED';
	if (!coverage.fullCoverage) return 'PENDING';
	return elements.some(hasKnownBindingFailure) ? 'RESTRICTED' : 'SAFE';
}

export async function createPolicyExecutor(
	deps: PolicyExecutorDeps,
	state: PolicyExecutorState,
	isCurrent: () => boolean = () => true,
): Promise<PolicyExecutor | null> {
	if (!isCurrent()) return null;
	const istate: InternalState = { corsStatus: 'PENDING', lastBadgeHash: '', lastSyncHash: '' };
	const eligibilityCache = createSiteEligibilityCache(window.location.hostname);

	const evaluateSourceEligibility = (): InternalState['corsStatus'] => {
		const registry = getActiveMediaRegistry();
		if (!registry) return 'PENDING';
		const elements = registry.list().map(({ element }) => element);
		return evaluateMediaSourceEligibility(
			elements,
			(element) => deps.audioController.hasKnownBindingFailure(element),
			(element) => typeof registry.getEligibilityEvidence === 'function'
				? registry.getEligibilityEvidence(element)
				: undefined,
		);
	};

	const getUrlInfo = (): UrlInfo => ({
		fullUrl: window.location.href, domain: window.location.hostname, pathname: window.location.pathname, isIframe: window.self !== window.top
	});

	const applyState = async (options: PolicyApplicationOptions = {}): Promise<void> => {
		const u = getUrlInfo();
		istate.corsStatus = await eligibilityCache.resolve(evaluateSourceEligibility());
		// Full-output DSP may claim Media WebAudio coverage only when every
		// registered source is proven safe before its irreversible binding.
		// Unselected media remains unknown and therefore takes the conservative
		// Capture path instead of producing a partial WebAudio ACK.
		const restrict = istate.corsStatus !== 'SAFE';

		const volume = resolveAudioVolume(state.config);
		const ctx: PolicyContext = {
			urlInfo: u,
			enabled: state.config.enabled && (
				state.userHasInteracted
				|| !isDefaultAudioConfig(state.config)
			),
			volume: volume.effectiveVolume,
			userInteracted: state.userHasInteracted,
			forceNative: false,
			isRestricted: restrict,
			hasMediaElement: (getActiveMediaRegistry()?.list().length ?? 0) > 0,
			hasAudioContext: deps.audioController.isReady(),
			config: state.config,
		};

		if (!deps.policyEngine?.calculateMode) {
			// Standard media properties are owned exclusively by
			// NativeMediaExecutor. A missing DSP planner is a transparent bypass,
			// never an alternate DOM writer.
			state.actualMode = 'bypass';
			state.phase = 'idle';
			return;
		}

		const policyMode = deps.policyEngine.calculateMode(ctx);
		const mode = policyMode;
		state.desiredMode = mode;
		const modeChanged = mode !== state.activeMode;
		if (modeChanged) {
			log.mode(state.activeMode, mode);
			state.activeMode = mode;
		}

		await executeMode(
			deps,
			state,
			modeChanged || options.navigation === true || options.modeIntent === true,
			options.captureAdmission,
		);
		await eligibilityCache.recordActual(state.actualMode, state.phase);
		updateBadge(deps, state, istate);
		broadcastUI(deps, state, istate);
	};

	const disposeModeExecutor = initModeExecutorCallbacks(deps, state, () => updateBadge(deps, state, istate), () => broadcastUI(deps, state, istate), (ch, opt) => updateConfig(deps, state, istate, ch, opt, applyState));

	return {
		dispose: disposeModeExecutor,
		applyState,
		updateBadge: () => updateBadge(deps, state, istate),
		updateConfig: (ch, opt) => updateConfig(deps, state, istate, ch, opt, applyState),
		hasUserGesture: () => hasUserGesture(state),
		markUserInteracted: () => { state.userHasInteracted = true; },
		getActiveMode: () => state.activeMode,
		getUrlInfo,
	};
}

export type { PolicyExecutor } from './types';
export type { PolicyExecutorState, PolicyExecutorDeps } from '../../types';
