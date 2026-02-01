// goal: synchronizes internal audio state with browser badge and popup UI
// rule: badge ONLY appears if user explicitly interacted with UI or capture is active (sticky display)

import { AudioMode, predictCapture } from '@nexus/audio-engine';
import { Actions } from '@nexus/contracts';
import { safeSend } from '../../core/context-guard';
import type { PolicyExecutorDeps, PolicyExecutorState } from '../../types';
import type { InternalState } from './types';
import { createBadgePayload, getBadgeStateHash } from '../../../shared/badge-logic';

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

	// rule: sticky badge only if user explicitly boosted volume > 100%
	// note: isPredictedCapture alone does NOT trigger badge - user must actively adjust parameters
	// note: volume > 100% implies the user intentionally used the plugin's boost feature

	const payload = createBadgePayload(state.config, isPredictedCapture, state.userHasInteracted);
	const hash = getBadgeStateHash(payload);

	if (hash === internalState.lastBadgeHash) return;
	internalState.lastBadgeHash = hash;

	// note: BADGE_UPDATE is handled by background worker (badge.ts)
	safeSend(() => messenger.send('BADGE_UPDATE', payload as any)).catch(() => { });
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

	// eff: notify background to forward this sync state to all open popups/extension pages
	safeSend(() => deps.messenger.send(Actions.UI_SYNC, {
		config: state.config,
		mode: state.activeMode as any,
		isCaptureActive: isPredictedCapture,
		isRestricted,
	} as any)).catch(() => { });
}
