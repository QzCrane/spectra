// goal: unifies configuration updates with conflict resolution (mute vs volume) and side-effects (OSD/Badge sync)
// ban: direct state mutation of the global config outside this module

import type { AudioConfig } from '@nexus/kernel';
import { predictCapture } from '@nexus/audio-engine';
import { showOSD } from '../osd';
import { safeSend } from '../context-guard';
import type { PolicyExecutorDeps, PolicyExecutorState } from '../types';
import type { InternalState } from './types';
import { updateBadge } from './badge-sync';

// eff: updates internal state, triggers badge/OSD refreshes, and persists changes to storage
export function updateConfig(
	deps: PolicyExecutorDeps,
	state: PolicyExecutorState,
	internalState: InternalState,
	changes: Partial<AudioConfig>,
	options: { showOSD?: boolean; unMute?: boolean } = {},
	applyStateFn: () => void
): void {
	const { messenger, settingsManager } = deps;

	// rule: exclude 'enabled' from interaction tracking; only functional changes activate the sticky badge
	const isOperation = Object.entries(changes).some(([k, v]) => {
		if (k === 'enabled') return false;
		return true;
	});

	if (isOperation) {
		state.userHasInteracted = true;
	}

	const newConfig = { ...state.config, ...changes };

	// note: auto-unmute if specifically requested (e.g. volume adjustment via hotkey)
	if (options.unMute) {
		newConfig.muted = false;
	}

	// inv: remove transient delta fields before state consolidation
	delete (newConfig as any).volumeDelta;

	state.config = newConfig;
	applyStateFn();
	updateBadge(deps, state, internalState);

	if (options.showOSD) {
		const settings = settingsManager.get();
		const isRestricted = internalState.corsStatus === 'RESTRICTED';
		const predictedCapture = predictCapture({
			config: newConfig,
			isRestricted,
			visualizerEnabled: settings.visualizerEnabled,
		});

		showOSD(
			state.config,
			predictedCapture,
			settings,
			state.isPopupOpen
		);
	}

	// eff: sync the updated domain configuration to the background worker for persistence
	safeSend(() => messenger.send('AUDIO_SET_CONFIG', { config: state.config })).catch(() => { });
}

