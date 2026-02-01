// goal: orchestrates PolicyEngine decisions with AudioController and CaptureManager

import type { AudioConfig } from '@nexus/kernel';
import { AudioMode, type PolicyContext, type UrlInfo } from '@nexus/audio-engine';
import { logger } from '../../../shared/logger';
import type { PolicyExecutorDeps, PolicyExecutorState } from '../../types';
import { executeMode, hasUserGesture, initModeExecutorCallbacks } from '../mode-executor';
import type { PolicyExecutor, InternalState } from './types';
import { updateBadge, broadcastUI } from './badge-sync'; // Assuming these don't hold too much state themselves
import { setupCorsCallback, probeCorsOnMediaDetected, initCorsStatus } from './cors-handler';
import { updateConfig } from './config-updater';

const log = logger.content;

export async function createPolicyExecutor(deps: PolicyExecutorDeps, state: PolicyExecutorState): Promise<PolicyExecutor> {
	const startCors = await initCorsStatus(deps.messenger);
	const istate: InternalState = { corsStatus: startCors, lastBadgeHash: '', lastSyncHash: '' };

	if (startCors !== 'PENDING') deps.audioController.setSkipCorsCheck(true);

	const getUrlInfo = (): UrlInfo => ({
		fullUrl: window.location.href, domain: window.location.hostname, pathname: window.location.pathname, isIframe: window.self !== window.top
	});

	const applyState = () => {
		const s = deps.settingsManager.get();
		const u = getUrlInfo();
		const restrict = istate.corsStatus === 'RESTRICTED';

		const ctx: PolicyContext = {
			urlInfo: u, enabled: state.config.enabled, volume: state.config.volume,
			visualizerEnabled: s.visualizerEnabled || (state.userHasInteracted && istate.corsStatus === 'PENDING'),
			userInteracted: state.userHasInteracted, forceNative: false, isRestricted: restrict,
			hasMediaElement: true, hasAudioContext: deps.audioController.isReady(), config: state.config
		};

		if (!deps.policyEngine?.calculateMode) {
			// Fallback lite
			const dv = state.config.muted ? 0 : Math.min(1, state.config.volume / 100);
			const els = document.getElementsByTagName('video');
			for (let i = 0; i < els.length; i++) {
				const el = els[i];
				if (el) { el.volume = dv; el.muted = state.config.muted; }
			}
			return;
		}

		const mode = deps.policyEngine.calculateMode(ctx);
		if (mode !== state.activeMode) {
			log.mode(state.activeMode, mode);
			if (state.activeMode === AudioMode.NATIVE_WEBAUDIO) deps.audioController.cleanup();
			if (state.activeMode === AudioMode.CAPTURE && mode !== AudioMode.CAPTURE && deps.captureManager.isActive()) {
				deps.captureManager.request(false, state.config);
			}
			state.activeMode = mode;
		}

		executeMode(deps, state);
		updateBadge(deps, state, istate);
		broadcastUI(deps, state, istate);
	};

	setupCorsCallback(deps, istate, applyState);
	initModeExecutorCallbacks(deps, state, () => updateBadge(deps, state, istate), () => broadcastUI(deps, state, istate), applyState, (ch, opt) => updateConfig(deps, state, istate, ch, opt, applyState));
	probeCorsOnMediaDetected(deps.messenger, istate, applyState);

	return {
		applyState,
		updateBadge: () => updateBadge(deps, state, istate),
		updateConfig: (ch, opt) => updateConfig(deps, state, istate, ch, opt, applyState),
		hasUserGesture: () => hasUserGesture(state),
		markUserInteracted: () => { state.userHasInteracted = true; },
		getActiveMode: () => state.activeMode,
		getUrlInfo,
		probeCors: () => probeCorsOnMediaDetected(deps.messenger, istate, applyState),
	};
}

export type { PolicyExecutor } from './types';
export type { PolicyExecutorState, PolicyExecutorDeps } from '../../types';
