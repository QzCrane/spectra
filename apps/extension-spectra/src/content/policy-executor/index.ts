// goal: orchestrates PolicyEngine decisions with AudioController and CaptureManager
// eff: manages transitions between NATIVE and CAPTURE modes while syncing side effects (Badge/CORS)

import type { AudioConfig } from '@nexus/kernel';
import { AudioMode, type PolicyContext, type UrlInfo } from '@nexus/audio-engine';
import { logger } from '../../shared/logger';
import type { PolicyExecutorDeps, PolicyExecutorState } from '../types';
import { executeMode, hasUserGesture, initModeExecutorCallbacks } from '../mode-executor';

import type { PolicyExecutor, InternalState } from './types';
import { updateBadge, broadcastUI } from './badge-sync';
import { setupCorsCallback, probeCorsOnMediaDetected, initCorsStatus } from './cors-handler';
import { updateConfig } from './config-updater';

const log = logger.content;

// post: returns an initialized PolicyExecutor with cached or pending CORS status applied
export async function createPolicyExecutor(deps: PolicyExecutorDeps, state: PolicyExecutorState): Promise<PolicyExecutor> {
	const { policyEngine, audioController, captureManager, settingsManager } = deps;

	const initialCorsStatus = await initCorsStatus(deps.messenger);

	// internalState: local transient markers not exposed beyond the executor lifecycle
	const internalState: InternalState = {
		corsStatus: initialCorsStatus,
		lastBadgeHash: '',
		lastSyncHash: '',
	};


	const statusDesc = initialCorsStatus === 'PENDING' ? 'Unknown (Pending)'
		: initialCorsStatus === 'SAFE' ? 'Safe (Cached)' : 'Restricted (Cached)';
	log.info(`[CORS] Init: ${initialCorsStatus} (${statusDesc})`);

	// rule: bypass expensive DOM traversal if CORS status is already persisted in registry
	if (initialCorsStatus !== 'PENDING') {
		audioController.setSkipCorsCheck(true);
	}

	function getUrlInfo(): UrlInfo {
		return {
			fullUrl: window.location.href,
			domain: window.location.hostname,
			pathname: window.location.pathname,
			isIframe: window.self !== window.top,
		};
	}

	// goal: core logic loop that calculates the optimal AudioMode and triggers execution
	function applyState(): void {
		const settings = settingsManager.get();
		const urlInfo = getUrlInfo();

		const isRestricted = internalState.corsStatus === 'RESTRICTED';

		// rule: force advanced processing (WebAudio) if user is actively interacting but CORS is still PENDING
		const needsCorsDetection = state.userHasInteracted && internalState.corsStatus === 'PENDING';

		const context: PolicyContext = {
			urlInfo,
			enabled: state.config.enabled,
			volume: state.config.volume,
			visualizerEnabled: settings.visualizerEnabled || needsCorsDetection,
			userInteracted: state.userHasInteracted,
			forceNative: false,
			isRestricted,
			hasMediaElement: true,
			hasAudioContext: audioController.isReady(),
			config: state.config,
		};

		// inv: policyEngine must be fully hydrated for mode calculation
		if (!policyEngine || typeof policyEngine.calculateMode !== 'function') {
			log.error('[SPECTRA] policyEngine.calculateMode invalid, fallback to NATIVE_LITE', {
				hasPolicyEngine: !!policyEngine,
				calculateModeType: typeof policyEngine?.calculateMode
			});
			const domVol = state.config.muted ? 0 : Math.min(1, state.config.volume / 100);
			document.querySelectorAll('video, audio').forEach((el) => {
				const media = el as HTMLMediaElement;
				media.volume = domVol;
				media.muted = state.config.muted;
			});
			return;
		}

		const desiredMode = policyEngine.calculateMode(context);

		if (desiredMode !== state.activeMode) {
			log.debug('[SPECTRA] Policy Calculation:', {
				url: urlInfo.domain + urlInfo.pathname,
				volume: state.config.volume,
				isRestricted,
				visualizerEnabled: settings.visualizerEnabled,
				result: desiredMode
			});

			log.mode(state.activeMode, desiredMode);

			if (state.activeMode === AudioMode.NATIVE_WEBAUDIO) {
				audioController.cleanup();
			}
			// note: explicitly shutdown capture session when switching away from CAPTURE mode
			if (state.activeMode === AudioMode.CAPTURE && desiredMode !== AudioMode.CAPTURE && captureManager.isActive()) {
				log.capture('Mode changing from CAPTURE, sending OFF');
				captureManager.request(false, state.config);
			}

			state.activeMode = desiredMode;
		}

		executeMode(deps, state);

		updateBadge(deps, state, internalState);
		broadcastUI(deps, state, internalState);
	}

	setupCorsCallback(deps, internalState, applyState);

	initModeExecutorCallbacks(
		deps,
		state,
		() => updateBadge(deps, state, internalState),
		() => broadcastUI(deps, state, internalState)
	);

	probeCorsOnMediaDetected(deps.messenger, internalState, applyState);

<<<<<<< HEAD
	// rule: CORS detection requires user gesture per Chrome Autoplay policy
	// note: detection happens once when user interacts (via user-interaction.ts -> applyState -> executeMode)
	// The audioController.initialize() is called in mode-executor.ts when hasUserGesture() is true
=======
	// rule: auto-trigger CORS probe on page load with exponential-ish backoff
	// note: discovery of media elements triggers immediate AudioContext attachment for real-time CORS testing
	if (internalState.corsStatus === 'PENDING') {
		const tryStartCorsDetection = (attempt: number, maxAttempts: number) => {
			const mediaCount = document.querySelectorAll('video, audio').length;

			if (mediaCount > 0) {
				log.info(`[CORS] Found ${mediaCount} media elements, starting detection...`);
				audioController.initialize().then(() => {
					audioController.scanAndAttach();
				});
			} else if (attempt < maxAttempts) {
				setTimeout(() => tryStartCorsDetection(attempt + 1, maxAttempts), 1000);
			} else {
				log.info('[CORS] No media elements found, waiting for DOM changes');
			}
		};

		setTimeout(() => tryStartCorsDetection(1, 5), 500);
	}
>>>>>>> origin/main

	return {
		applyState,
		updateBadge: () => updateBadge(deps, state, internalState),
		updateConfig: (changes, options) => updateConfig(deps, state, internalState, changes, options, applyState),
		hasUserGesture: () => hasUserGesture(state),
		markUserInteracted: () => { state.userHasInteracted = true; },
		getActiveMode: () => state.activeMode,
		getUrlInfo,
		probeCors: () => probeCorsOnMediaDetected(deps.messenger, internalState, applyState),
	};
}

export type { PolicyExecutor } from './types';
export type { PolicyExecutorState, PolicyExecutorDeps } from '../types';
