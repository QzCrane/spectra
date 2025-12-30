// goal: synchronizes internal audio state with browser badge and popup UI
// rule: badge ONLY appears if user explicitly interacted with UI or capture is active (sticky display)

import { AudioMode, predictCapture } from '@nexus/audio-engine';
import { Actions } from '@nexus/contracts';
import { safeSend } from '../context-guard';
import type { PolicyExecutorDeps, PolicyExecutorState } from '../types';
import type { InternalState } from './types';

// note: kept for legacy compatibility, prefer predictCapture for mode-based logic
export function isEffectivelyCapturing(
	state: PolicyExecutorState,
	captureManager: PolicyExecutorDeps['captureManager']
): boolean {
	return state.activeMode === AudioMode.CAPTURE && captureManager.isActive();
}

// eff: updates the extension icon badge text/color based on volume boosts and capture state
export function updateBadge(
	deps: PolicyExecutorDeps,
	state: PolicyExecutorState,
	internalState: InternalState
): void {
	const { messenger, settingsManager } = deps;
	const isRestricted = internalState.corsStatus === 'RESTRICTED';

	const isPredictedCapture = predictCapture({
		config: state.config,
		isRestricted,
		visualizerEnabled: settingsManager.get().visualizerEnabled,
	});

	// rule: force sticky badge if volume > 100% or capture mode is engaged
	if (isPredictedCapture || state.config.volume > 100) {
		state.userHasInteracted = true;
	}

	const hash = `${state.config.volume}_${state.config.muted || false}_${isPredictedCapture}_${state.userHasInteracted}`;
	if (hash === internalState.lastBadgeHash) return;
	internalState.lastBadgeHash = hash;

	// note: BADGE_UPDATE is handled by background worker (badge.ts)
	safeSend(() => messenger.send('BADGE_UPDATE', {
		volume: state.config.volume,
		muted: state.config.muted,
		isCapture: isPredictedCapture,
		userInteracted: state.userHasInteracted,
	} as any)).catch(() => { });
}

// goal: broadcasts current configuration to open popup windows to ensure UI consistency
export function broadcastUI(
	deps: PolicyExecutorDeps,
	state: PolicyExecutorState,
	internalState: InternalState
): void {
	const { settingsManager } = deps;
	const isRestricted = internalState.corsStatus === 'RESTRICTED';

	const isPredictedCapture = predictCapture({
		config: state.config,
		isRestricted,
		visualizerEnabled: settingsManager.get().visualizerEnabled,
	});

	const syncHash = `${JSON.stringify(state.config)}_${isPredictedCapture}_${state.activeMode}`;
	if (syncHash === internalState.lastSyncHash) return;
	internalState.lastSyncHash = syncHash;

	safeSend(() => new Promise<void>((resolve, reject) => {
		chrome.runtime.sendMessage({
			action: Actions.UI_SYNC,
			payload: {
				config: state.config,
				mode: state.activeMode as any,
				isCaptureActive: isPredictedCapture,
				isRestricted,
			}
		}, {}, (response: any) => {
			if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
			else resolve(response);
		});
	})).catch(() => { });
}
