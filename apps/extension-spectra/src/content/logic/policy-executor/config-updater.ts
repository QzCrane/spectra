// goal: unifies configuration updates with conflict resolution, actual apply, Badge sync and persistence
// ban: direct state mutation of the global config outside this module

import type { AudioConfig } from '@nexus/kernel';
import { resolveAudioVolume, rpcFailure, type SpectraResponse } from '@nexus/contracts';
import type { PolicyExecutorDeps, PolicyExecutorState } from '../../types';
import type { InternalState } from './types';
import type { PolicyApplicationOptions, PolicyUpdateOptions } from './types';
import { updateBadge } from './badge-sync';
import { sendSpectraRequest } from '../../../shared/spectra-client';

// eff: updates internal state, applies policy, refreshes Badge state and persists the snapshot
export function updateConfig(
	deps: PolicyExecutorDeps,
	state: PolicyExecutorState,
	internalState: InternalState,
	changes: Partial<AudioConfig>,
	options: PolicyUpdateOptions = {},
	applyStateFn: (options?: PolicyApplicationOptions) => Promise<void>
): Promise<SpectraResponse<'spectra.audio.config.set'>> {
	// rule: any configuration update NOT from native sync is considered a user engagement
	// this activates the "Special Features" like sticky badge and bi-directional sync
	if (!options.isNativeSync) {
		state.userHasInteracted = true;
	}

	const newConfig = { ...state.config, ...changes };
	const legacyVolume = changes.volume;
	const legacyVolumeOnly = legacyVolume !== undefined
		&& changes.volumeBase === undefined
		&& changes.boost === undefined;
	const volume = legacyVolumeOnly
		? resolveAudioVolume({ volume: legacyVolume ?? 100 })
		: resolveAudioVolume({
			volume: newConfig.volume,
			volumeBase: newConfig.volumeBase,
			boost: newConfig.boost,
		});
	newConfig.volumeBase = volume.volumeBase;
	newConfig.boost = volume.boost;
	newConfig.volume = volume.effectiveVolume;

	// inv: remove transient delta fields before state consolidation
	Reflect.deleteProperty(newConfig, 'volumeDelta');
	Reflect.deleteProperty(newConfig, 'toggleMute');

	state.config = newConfig;

	// rule: NEVER trigger applyState for a native sync update
	// reason: applying state writes the current config BACK to the DOM/Injector;
	// if we do this during a native sync, we create a feedback loop that causes volume drift/jitter
	return (async () => {
		if (!options.isNativeSync) {
			await applyStateFn(options.captureAdmission
				? { captureAdmission: options.captureAdmission }
				: undefined);
		}

		updateBadge(deps, state, internalState);

		return persistConfigSnapshot(internalState, state.config, state.generation);
	})();
}

// post: config writes reach the background in update order. The returned
// promise resolves only after the background has accepted (and queued) this
// snapshot, allowing runtime.configure to delay its ACK without blocking other
// local policy side effects.
export function persistConfigSnapshot(
	internalState: InternalState,
	config: AudioConfig,
	generation: number,
): Promise<SpectraResponse<'spectra.audio.config.set'>> {
	const snapshot: AudioConfig = { ...config, eqValues: [...config.eqValues] };
	const previous = internalState.configPersistenceTail ?? Promise.resolve();
	const operation = previous.then(async () => {
		try {
			return await sendSpectraRequest(
		'spectra.audio.config.set',
				{ config: snapshot },
				{ generation },
			);
		} catch (error) {
			return rpcFailure(
				'audio_config_persist_failed',
				error instanceof Error ? error.message : String(error),
				true,
			);
		}
	});
	internalState.configPersistenceTail = operation.then(
		() => undefined,
		() => undefined,
	);
	return operation;
}
