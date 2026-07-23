// goal: synchronizes internal audio state with browser badge and popup UI
// rule: badge ONLY appears if user explicitly interacted with UI or capture is active (sticky display)

import { AudioMode } from '@nexus/audio-engine';
import type { SpectraAudioMode } from '@nexus/contracts';
import type { PolicyExecutorDeps, PolicyExecutorState } from '../../types';
import type { InternalState } from './types';
import { sendSpectraRequest } from '../../../shared/spectra-client';

// note: kept for legacy callers; actual UI color still requires session phase=active
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
	publishSession(deps, state, internalState);
}

function normalizeMode(value: unknown): SpectraAudioMode {
	if (value === 'capture' || value === 'CAPTURE') return 'capture';
	if (value === 'webaudio' || value === 'NATIVE_WEBAUDIO') return 'webaudio';
	return 'bypass';
}

function publishSession(
	deps: PolicyExecutorDeps,
	state: PolicyExecutorState,
	internalState: InternalState
): void {
	const isActualCapture = state.actualMode === 'capture' && deps.captureManager.isActive();
	const actualMode = isActualCapture ? 'capture' : state.actualMode;
	const syncHash = `${JSON.stringify(state.appliedConfig)}_${actualMode}_${state.desiredMode}_${state.phase}_${state.generation}_${state.lastError}_${state.userHasInteracted}`;
	if (syncHash === internalState.lastSyncHash) return;
	internalState.lastSyncHash = syncHash;

	void sendSpectraRequest(
		'spectra.audio.session.publish',
		{
			config: state.appliedConfig,
			desiredMode: normalizeMode(state.desiredMode),
			actualMode,
			phase: state.phase,
			lastError: state.lastError ?? null,
			userInteracted: state.userHasInteracted,
		},
		{ generation: state.generation },
	).catch(() => undefined);
}

// goal: publishes current acknowledged state; background owns popup events and badge updates
export function broadcastUI(
	deps: PolicyExecutorDeps,
	state: PolicyExecutorState,
	internalState: InternalState
): void {
	publishSession(deps, state, internalState);
}
