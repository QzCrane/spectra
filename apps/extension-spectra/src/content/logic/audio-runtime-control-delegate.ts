// goal: bridge full-output coordinator fields to one acknowledged audio policy runtime

import {
	resolveAudioVolume,
	type ControlActualContext,
	type ControlDirectField,
	type ControlField,
	type ControlFieldStates,
	type ControlIntent,
	type ControlPatch,
	type ControlStrategy,
	type ControlValues,
} from '@nexus/contracts';
import type { PolicyExecutor } from './policy-executor';
import type { PolicyExecutorState } from '../types';
import type { AudioRuntimeControlDelegate } from './native-media-executor';
import type { FullscreenAudioHandoff } from '../core/fullscreen-audio-handoff';

const AUDIO_RUNTIME_CONTROL_FIELDS = new Set<ControlDirectField>([
	'audioEnabled',
	'boost',
	'eqValues',
	'bass',
	'compressor',
	'mono',
	'pan',
	'delay',
]);

function hasRequestedProcessor(config: PolicyExecutorState['config']): boolean {
	const volume = resolveAudioVolume(config);
	return volume.boost !== 1
		|| config.eqValues.some((value) => value !== 0)
		|| config.bass
		|| config.compressor
		|| config.mono
		|| config.pan !== 0
		|| config.delay !== 0;
}

function actualAudioEnabled(state: PolicyExecutorState): boolean {
	if (!state.config.enabled) return false;
	return !hasRequestedProcessor(state.config)
		|| state.actualMode === 'webaudio'
		|| state.actualMode === 'capture';
}

export function createAudioRuntimeControlDelegate(
	policyExecutor: PolicyExecutor,
	state: PolicyExecutorState,
	fullscreenHandoff?: Pick<FullscreenAudioHandoff, 'run'>,
): AudioRuntimeControlDelegate {
	const synchronizeNative = (context: ControlActualContext): void => {
		if (typeof context.volumeBase === 'number') {
			const desiredBoost = resolveAudioVolume(state.config).boost;
			const appliedBoost = resolveAudioVolume(state.appliedConfig).boost;
			state.config.volumeBase = context.volumeBase;
			state.config.volume = Math.round(context.volumeBase * desiredBoost * 100) / 100;
			state.appliedConfig.volumeBase = context.volumeBase;
			state.appliedConfig.volume = Math.round(context.volumeBase * appliedBoost * 100) / 100;
		}
		if (typeof context.mediaMuted === 'boolean') {
			state.config.muted = context.mediaMuted;
			state.appliedConfig.muted = context.mediaMuted;
		}
		if (typeof context.speed === 'number') {
			state.config.speed = context.speed;
			state.appliedConfig.speed = context.speed;
		}
		if (typeof context.preservePitch === 'boolean') {
			state.config.preservePitch = context.preservePitch;
			state.appliedConfig.preservePitch = context.preservePitch;
		}
	};
	const read = (fields: readonly ControlField[]): ControlPatch => {
		const applied = state.appliedConfig;
		const patch: ControlPatch = {};
		for (const field of fields) {
			let actual: unknown;
			switch (field) {
				case 'audioEnabled': actual = actualAudioEnabled(state); break;
				case 'boost': actual = resolveAudioVolume(applied).boost; break;
				case 'eqValues': actual = [...applied.eqValues]; break;
				case 'bass': actual = applied.bass; break;
				case 'compressor': actual = applied.compressor; break;
				case 'mono': actual = applied.mono; break;
				case 'pan': actual = applied.pan; break;
				case 'delay': actual = applied.delay; break;
			}
			if (actual !== undefined) (patch as Record<string, unknown>)[field] = actual;
		}
		return patch;
	};
	const apply = async (intent: ControlIntent, patch: ControlPatch): Promise<ControlFieldStates> => {
		const requestedRuntimeFields = Object.keys(patch)
			.filter((field): field is ControlDirectField => AUDIO_RUNTIME_CONTROL_FIELDS.has(field as ControlDirectField));
		if (intent.requestedCoverage !== 'full' && requestedRuntimeFields.length > 0) {
			return Object.fromEntries(requestedRuntimeFields.map((field) => [field, {
				desired: patch[field] as ControlValues[ControlField],
				actual: null,
				revision: intent.baseRevision + 1,
				phase: 'error',
				strategy: 'unsupported',
				coverage: 'partial',
				controlled: false,
				intentId: intent.intentId,
				lastError: {
					code: 'coverage-incomplete',
					message: 'The shared audio processor requires explicit full-output coverage',
					retryable: true,
				},
			}])) as ControlFieldStates;
		}
		const changes: Partial<PolicyExecutorState['config']> = {};
		for (const [rawField, rawValue] of Object.entries(patch)) {
			const field = rawField as ControlDirectField;
			if (!AUDIO_RUNTIME_CONTROL_FIELDS.has(field)) continue;
			switch (field) {
				case 'audioEnabled': changes.enabled = rawValue as boolean; break;
				case 'boost': changes.boost = rawValue as number; break;
				case 'eqValues': changes.eqValues = [...rawValue as number[]]; break;
				case 'bass': changes.bass = rawValue as boolean; break;
				case 'compressor': changes.compressor = rawValue as boolean; break;
				case 'mono': changes.mono = rawValue as boolean; break;
				case 'pan': changes.pan = rawValue as number; break;
				case 'delay': changes.delay = rawValue as number; break;
			}
		}
		if (changes.boost !== undefined) {
			const current = resolveAudioVolume(state.config);
			changes.volumeBase = current.volumeBase;
			changes.volume = Math.round(current.volumeBase * changes.boost * 100) / 100;
		}
		// The existing OSD has exact actual-value projections only for effective volume,
		// Boost and speed. Pan/delay/mono hotkeys retain their listener-owned label
		// instead of displaying a misleading volume OSD and then a second toast.
		const persisted = await policyExecutor.updateConfig(changes, {
			...(intent.captureAdmission
				? { captureAdmission: intent.captureAdmission }
				: {}),
		});
		if (!persisted.ok) throw new Error(persisted.error.message);

		const applied = state.appliedConfig;
		const fields: ControlFieldStates = {};
		const acknowledgedFields = new Set<ControlDirectField>(
			Object.keys(patch).filter((field) => AUDIO_RUNTIME_CONTROL_FIELDS.has(field as ControlDirectField)) as ControlDirectField[],
		);
		// `audioEnabled` is the compound session gate. A toggle ACK includes the
		// actual state of every dependent DSP field so Popup/remote never retain a
		// stale "active" processor after disable or hide a startup failure on enable.
		if (patch.audioEnabled !== undefined) {
			for (const field of AUDIO_RUNTIME_CONTROL_FIELDS) acknowledgedFields.add(field);
		}
		for (const field of acknowledgedFields) {
			let desired: ControlValues[ControlField];
			switch (field) {
				case 'audioEnabled': desired = state.config.enabled; break;
				case 'boost': desired = resolveAudioVolume(state.config).boost; break;
				case 'eqValues': desired = [...state.config.eqValues]; break;
				case 'bass': desired = state.config.bass; break;
				case 'compressor': desired = state.config.compressor; break;
				case 'mono': desired = state.config.mono; break;
				case 'pan': desired = state.config.pan; break;
				case 'delay': desired = state.config.delay; break;
				default: continue;
			}
			let actual: ControlValues[ControlField];
			switch (field) {
				case 'audioEnabled': actual = actualAudioEnabled(state); break;
				case 'boost': actual = resolveAudioVolume(applied).boost; break;
				case 'eqValues': actual = [...applied.eqValues]; break;
				case 'bass': actual = applied.bass; break;
				case 'compressor': actual = applied.compressor; break;
				case 'mono': actual = applied.mono; break;
				case 'pan': actual = applied.pan; break;
				case 'delay': actual = applied.delay; break;
				default: continue;
			}
			const matches = JSON.stringify(desired) === JSON.stringify(actual);
			const isDisabledRelease = patch.audioEnabled === false && field !== 'audioEnabled';
			const isNeutralRelease = field !== 'audioEnabled'
				&& state.actualMode === 'bypass'
				&& matches;
			const strategy: ControlStrategy = field === 'audioEnabled'
				? 'extension-state'
				: isDisabledRelease || isNeutralRelease
					? 'observe'
					: state.actualMode === 'capture'
						? 'capture'
						: state.actualMode === 'webaudio'
							? 'media-webaudio'
							: 'unsupported';
			(fields as Record<string, unknown>)[field] = {
				desired,
				actual,
				revision: intent.baseRevision + 1,
				phase: isDisabledRelease ? 'idle' : matches ? 'applied' : 'error',
				strategy,
				coverage: strategy === 'capture'
					? 'opaque'
					: intent.requestedCoverage,
				controlled: matches && !isNeutralRelease && !isDisabledRelease,
				intentId: intent.intentId,
				lastError: isDisabledRelease || matches
					? null
					: {
						code: 'readback-mismatch',
						message: state.lastError ?? 'Audio runtime did not apply the requested value',
						retryable: true,
					},
			};
		}
		return fields;
	};
	return {
		apply,
		read,
		synchronizeNative,
		...(fullscreenHandoff
			? { runFullscreenTransition: fullscreenHandoff.run.bind(fullscreenHandoff) }
			: {}),
	};
}
