// goal: manages the internal state of a tab control card and orchestrates configuration updates across background and content scripts

import type { AudioConfig, GlobalSettings } from '@nexus/kernel';
import {
	isActiveCaptureLifecycle,
	resolveAudioVolume,
	type ControlOperationAck,
	type ControlFieldStates,
	type ControlPatch,
} from '@nexus/contracts';
import { mergeAudioConfig, mergeControlFields, type CardInternalState } from './types';
import { sendSpectraRequest } from '../../shared/ui-spectra-client';

export type ConfigUpdateFn = ((changes: Partial<AudioConfig>) => void) & {
	flush: () => Promise<void>;
	runControl: <T>(command: () => Promise<T>) => Promise<T>;
};

// A field ACK using Capture proves the processor is already active. Project it
// immediately so Popup rendering cannot lag behind that ACK while the matching
// lifecycle event is still crossing the extension event queue.
export function projectAcknowledgedProcessorLifecycle(
	state: CardInternalState,
	fields: ControlFieldStates,
): void {
	const captureApplied = Object.values(fields).some((field) => (
		field?.phase === 'applied' && field.strategy === 'capture'
	));
	if (!captureApplied) return;
	state.actualMode = 'capture';
	state.desiredMode = 'capture';
	state.phase = 'active';
	state.isCaptureActive = true;
	state.processorTransitionPending = false;
}

export function createGetCapturing(
  state: CardInternalState,
): () => boolean {
  return () => isActiveCaptureLifecycle({
	actualMode: state.actualMode,
	phase: state.phase,
  });
}

// post: returns an async update function that applies changes optimistically and routes commands based on the active capture mode
export function createUpdateFn(
  state: CardInternalState,
  tabId: number,
  _getCapturing: () => boolean,
  render: () => void,
  _getGlobalSettings: () => GlobalSettings
): ConfigUpdateFn {
	const minSendIntervalMs = 50;
	let pending = false;
	let inFlight: Promise<void> | null = null;
	let timer: ReturnType<typeof setTimeout> | null = null;
	let lastSentAt = 0;
	let localRevision = 0;
	let pendingPatch: ControlPatch = {};
	let pendingEffectiveVolume: number | null = null;
	let desiredConfig = state.config;
	let controlTail: Promise<void> = Promise.resolve();

	const serializeControl = <T>(command: () => Promise<T>): Promise<T> => {
		const result = controlTail.then(command, command);
		controlTail = result.then(() => undefined, () => undefined);
		return result;
	};

	const toControlPatch = (
		changes: Partial<AudioConfig>,
		config: AudioConfig = state.config,
	): ControlPatch => {
		const patch: ControlPatch = {};
		if (changes.enabled !== undefined) patch.audioEnabled = config.enabled;
		// The public 0-800 control is submitted as one compound operation below.
		// Never duplicate its split native/processor fields into ordinary patches.
		if (changes.muted !== undefined) patch.mediaMuted = config.muted;
		if (changes.speed !== undefined) patch.speed = config.speed;
		if (changes.preservePitch !== undefined) patch.preservePitch = config.preservePitch;
		if (changes.eqValues !== undefined) patch.eqValues = [...config.eqValues];
		if (changes.bass !== undefined) patch.bass = config.bass;
		if (changes.compressor !== undefined) patch.compressor = config.compressor;
		if (changes.mono !== undefined) patch.mono = config.mono;
		if (changes.pan !== undefined) patch.pan = config.pan;
		if (changes.delay !== undefined) patch.delay = config.delay;
		return patch;
	};

	const splitByCoverage = (patch: ControlPatch): Array<{
		requestedCoverage: 'active-target' | 'full';
		patch: ControlPatch;
	}> => {
		const target: ControlPatch = {};
		const full: ControlPatch = {};
		for (const [field, value] of Object.entries(patch)) {
			const output = ['audioEnabled', 'boost', 'eqValues', 'bass', 'compressor', 'mono', 'pan', 'delay'].includes(field)
				? full
				: target;
			(output as Record<string, unknown>)[field] = value;
		}
		return [
			...(Object.keys(target).length > 0 ? [{ requestedCoverage: 'active-target' as const, patch: target }] : []),
			...(Object.keys(full).length > 0 ? [{ requestedCoverage: 'full' as const, patch: full }] : []),
		];
	};

	const scheduleFlush = () => {
		if (timer || inFlight) return;
		const delay = Math.max(0, minSendIntervalMs - (performance.now() - lastSentAt));
		timer = setTimeout(() => {
			timer = null;
			void flush().catch(() => undefined);
		}, delay);
	};

	const flush = (): Promise<void> => {
		if (inFlight) return inFlight;
		if (!pending) return Promise.resolve();
		pending = false;
		lastSentAt = performance.now();
		const sentRevision = localRevision;
		const patch = pendingPatch;
		const effectiveVolume = pendingEffectiveVolume;
		pendingPatch = {};
		pendingEffectiveVolume = null;

		inFlight = serializeControl(async () => {
			if (effectiveVolume !== null) {
				const response = await sendSpectraRequest(
					'spectra.control.operation.submit',
					{
						tabId,
						source: 'popup',
						target: state.controlSnapshot?.activeMedia ?? null,
						baseRevision: state.controlRevision,
						operation: 'effective-volume',
						payload: { operation: 'set', value: effectiveVolume },
					},
					{ tabId },
				);
				if (!response.ok) {
					state.lastError = response.error;
					throw new Error(response.error.message);
				}
				const acknowledgement = response.data as ControlOperationAck<'effective-volume'>;
				state.controlRevision = Math.max(state.controlRevision, acknowledgement.revision);
				state.controlGeneration = Math.max(state.controlGeneration, acknowledgement.generation);
				state.stableConfig = mergeControlFields(state.stableConfig, acknowledgement.fields);
				projectAcknowledgedProcessorLifecycle(state, acknowledgement.fields);
				state.stableConfig = mergeAudioConfig(state.stableConfig, {
					volume: acknowledgement.result.effectiveVolume,
					volumeBase: acknowledgement.result.volumeBase,
					boost: acknowledgement.result.boost,
				});
			}
			for (const group of splitByCoverage(patch)) {
				const response = await sendSpectraRequest(
					'spectra.control.intent.submit',
					{
						tabId,
						source: 'popup',
						requestedCoverage: group.requestedCoverage,
						target: state.controlSnapshot?.activeMedia ?? null,
						baseRevision: state.controlRevision,
						patch: group.patch,
					},
					{ tabId },
				);
				if (!response.ok) {
					state.lastError = response.error;
					throw new Error(response.error.message);
				}
				state.controlRevision = Math.max(state.controlRevision, response.data.revision);
				state.controlGeneration = Math.max(
					state.controlGeneration,
					response.data.generation,
				);
				const applied = Object.values(response.data.fields);
				const failed = applied.find((field) => field?.lastError)?.lastError ?? null;
				if (failed) {
					state.lastError = failed;
					throw new Error(failed.message);
				}
				state.stableConfig = mergeControlFields(state.stableConfig, response.data.fields);
				projectAcknowledgedProcessorLifecycle(state, response.data.fields);
			}
			// A response for an earlier drag sample must not overwrite a newer
			// optimistic value that is waiting to be coalesced and sent.
			if (localRevision === sentRevision) {
				state.config = mergeAudioConfig(state.stableConfig, {
					eqValues: [...state.stableConfig.eqValues],
				});
				desiredConfig = state.config;
				state.processorTransitionPending = false;
			}
			state.lastError = null;
		}).catch((error) => {
			if (localRevision === sentRevision) {
				state.config = mergeAudioConfig(state.stableConfig, {
					eqValues: [...state.stableConfig.eqValues],
				});
				desiredConfig = state.config;
				state.processorTransitionPending = false;
			}
			throw error;
		}).finally(() => {
			inFlight = null;
			render();
			if (pending) scheduleFlush();
		});
		return inFlight;
	};

	const drain = async (): Promise<void> => {
		while (true) {
			while (pending || inFlight) {
				if (inFlight) await inFlight;
				else {
					if (timer) {
						clearTimeout(timer);
						timer = null;
					}
					await flush();
				}
			}
			await controlTail;
			if (!pending && !inFlight) return;
		}
	};

	const runControl = async <T>(command: () => Promise<T>): Promise<T> => {
		await drain();
		return serializeControl(command);
	};

	window.addEventListener('pagehide', () => {
		if (timer) {
			clearTimeout(timer);
			timer = null;
		}
		void drain()
			.then(() => sendSpectraRequest('spectra.audio.session.flush', {}, { tabId }))
			.catch(() => undefined);
	}, { once: true });

	const update = ((changes: Partial<AudioConfig>) => {
		// This function is only invoked by explicit controls/preset actions; reads never call it.
		const previous = pending || inFlight ? desiredConfig : state.config;
		const next = mergeAudioConfig(previous, changes);
		desiredConfig = next;
		const hasVolumeChange = changes.volume !== undefined
			|| changes.volumeBase !== undefined
			|| changes.boost !== undefined;
		const previousVolume = resolveAudioVolume(previous).effectiveVolume;
		const nextVolume = resolveAudioVolume(next).effectiveVolume;
		const volumeChanged = hasVolumeChange && previousVolume !== nextVolume;
		const patch = toControlPatch(changes, next);
		// Identical range-input samples are discarded before the runtime boundary.
		// This keeps repeated values at zero IPC and zero persistence work.
		if (!volumeChanged && Object.keys(patch).length === 0) return;
		state.userInteracted = true;

		// An amber pending projection separates desired from actual while crossing
		// the native/processor boundary. Publishing desired 110% as native blue is
		// the blue-before-purple flash; purple remains reserved for the compound
		// Capture ACK. Same-region drags remain optimistic.
		const stableVolume = resolveAudioVolume(state.stableConfig).effectiveVolume;
		const crossesProcessorBoundary = volumeChanged
			&& (stableVolume > 100) !== (nextVolume > 100);
		state.processorTransitionPending = crossesProcessorBoundary;
		state.config = next;
		if (volumeChanged) pendingEffectiveVolume = nextVolume;
		pendingPatch = { ...pendingPatch, ...patch };
		localRevision += 1;
		pending = true;
		render();
		scheduleFlush();
	}) as ConfigUpdateFn;
	update.flush = drain;
	update.runControl = runControl;
	return update;
}

