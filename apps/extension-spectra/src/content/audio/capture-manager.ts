// goal: expose only background/offscreen-acknowledged capture state to the content runtime

import {
	Actions,
	isSpectraEventEnvelope,
	type AudioConfig,
} from '@nexus/contracts';
import { isExtensionContextValid } from '../core/context-guard';
import { logger } from '../../shared/logger';
import { sendSpectraRequest } from '../../shared/spectra-client';
import { shouldAcceptAudioSessionPhase } from '../../shared/audio-session-phase';

interface CaptureReply {
	status: 'processing' | 'error';
	phase?: 'idle' | 'starting' | 'active' | 'stopping' | 'error';
	active?: boolean;
	generation?: number;
	error?: string;
	actualConfig?: AudioConfig;
}

interface CaptureStateEvent {
	enabled?: boolean;
	phase?: CaptureReply['phase'];
	generation?: number;
	error?: string;
}

export interface CaptureContinuation {
	resume(config: AudioConfig, requestedGeneration?: number): Promise<CaptureReply>;
}

const log = logger.content;
let active = false;
let phase: CaptureReply['phase'] = 'idle';
let generation = 0;
let lastError: string | undefined;
let actualConfig: AudioConfig | null = null;
let pending: Promise<CaptureReply> | null = null;

function applyConfirmedState(event: CaptureStateEvent): void {
	const nextGeneration = event.generation ?? generation;
	const nextPhase = event.phase ?? (event.enabled ? 'active' : 'idle');
	if (!shouldAcceptAudioSessionPhase(generation, phase ?? 'idle', nextGeneration, nextPhase)) return;
	generation = nextGeneration;
	phase = nextPhase;
	lastError = event.error;
	// `phase` describes the in-flight transition; `enabled` is the last
	// acknowledged processor state. Capture remains actual while stopping/erroring
	// until the offscreen host confirms it is idle.
	const nextActive = event.enabled ?? nextPhase === 'active';
	active = nextActive;
	if (!nextActive) actualConfig = null;
}

function cloneConfig(config: AudioConfig): AudioConfig {
	return { ...config, eqValues: [...config.eqValues] };
}

export function createCaptureManager() {
	return {
		isActive: () => active,
		isPending: () => phase === 'starting' || phase === 'stopping' || pending !== null,
		hasLocalRequest: () => pending !== null,
		getPhase: () => phase,
		getGeneration: () => generation,
		getLastError: () => lastError,
		getActualConfig: () => actualConfig ? cloneConfig(actualConfig) : null,
		waitForSettled: async () => {
			const operation = pending;
			if (operation) await operation.catch(() => undefined);
		},
		setActive: (isActive: boolean, nextGeneration = generation) => applyConfirmedState({
			enabled: isActive,
			phase: isActive ? 'active' : 'idle',
			generation: nextGeneration,
		}),
		restoreState: (snapshot: {
			active: boolean;
			phase: CaptureReply['phase'];
			generation: number;
			error?: string;
			actualConfig?: AudioConfig;
		}) => {
			actualConfig = snapshot.actualConfig ? cloneConfig(snapshot.actualConfig) : null;
			applyConfirmedState({
				enabled: snapshot.active,
				phase: snapshot.phase,
				generation: snapshot.generation,
				error: snapshot.error,
			});
		},
		handleMessage,
		request,
		syncConfig,
		suspendForContinuation,
	};
}

// post: yields an already-authorized processor and returns one document-local,
// single-use continuation. Only an actually active Capture can mint it, and any
// intervening generation/state change invalidates it before a new start request.
async function suspendForContinuation(
	config: AudioConfig,
	requestedGeneration?: number,
): Promise<CaptureContinuation | null> {
	if (pending) await pending.catch(() => undefined);
	if (!active) return null;
	const stopped = await request(false, config, requestedGeneration);
	if (stopped.active || stopped.phase === 'error') {
		throw new Error(stopped.error ?? 'Capture did not yield for continuation');
	}
	const suspendedGeneration = generation;
	let consumed = false;
	return {
		async resume(nextConfig, nextGeneration) {
			if (consumed) throw new Error('Capture continuation was already consumed');
			consumed = true;
			if (active || phase !== 'idle' || generation !== suspendedGeneration) {
				throw new Error('Capture continuation no longer owns the suspended processor');
			}
			const resumed = await request(true, nextConfig, nextGeneration);
			if (!resumed.active || resumed.phase !== 'active') {
				throw new Error(resumed.error ?? 'Capture continuation did not resume');
			}
			return resumed;
		},
	};
}

async function request(enabled: boolean, config: AudioConfig, requestedGeneration?: number): Promise<CaptureReply> {
	if (!isExtensionContextValid()) {
		return { status: 'error', phase: 'error', active: false, generation, error: 'Extension context is unavailable' };
	}
	if (pending) await pending.catch(() => undefined);
	if (enabled === active
		&& ((!enabled && phase === 'idle')
			|| (enabled && phase === 'active' && actualConfig !== null))) {
		const currentActual = enabled ? actualConfig : null;
		return {
			status: 'processing',
			phase,
			active,
			generation,
			...(currentActual ? { actualConfig: cloneConfig(currentActual) } : {}),
		};
	}

	const previousActive = active;
	// Starting/stopping changes processor ownership. It cannot reuse the stable
	// generation even when a caller still holds that acknowledged generation;
	// otherwise Background sees active -> idle in one generation and correctly
	// rejects the terminal session update as a stale phase regression.
	const requestGeneration = requestedGeneration === undefined
		? generation + 1
		: Math.max(generation + 1, requestedGeneration);
	generation = requestGeneration;
	phase = enabled ? 'starting' : 'stopping';
	lastError = undefined;

	const operation = sendSpectraRequest(
		'spectra.audio.capture.set',
		{ enabled, config },
		{ generation: requestGeneration },
	).then((response): CaptureReply => {
		if (!response.ok) {
			return {
				status: 'error',
				phase: 'error',
				active: previousActive,
				generation: requestGeneration,
				error: response.error.message,
			};
		}
		return {
			status: response.data.phase === 'error' ? 'error' : 'processing',
			phase: response.data.phase,
			active: response.data.active,
			generation: response.data.generation,
			error: response.data.lastError?.message,
			...(response.data.actualConfig
				? { actualConfig: cloneConfig(response.data.actualConfig) }
				: {}),
		};
	});
	pending = operation;

	try {
		const response = await operation;
		const responseGeneration = response.generation ?? requestGeneration;
		if (responseGeneration < generation) return response;
		if (response.status === 'error' || response.phase === 'error') {
			applyConfirmedState({
				enabled: response.active ?? active,
				phase: response.phase ?? 'error',
				generation: responseGeneration,
				error: response.error || 'Capture transition failed',
			});
			// Missing browser invocation is prevented before this request is sent.
			// A denial after an admitted transaction therefore indicates a real
			// navigation/permission race and must retain the original failure signal.
			log.error('Capture transition failed:', response.error ?? 'Unknown capture error');
			return response;
		}
		applyConfirmedState({
			enabled: response.active ?? response.phase === 'active',
			phase: response.phase,
			generation: responseGeneration,
		});
		if (response.active && response.phase === 'active') {
			const confirmedActual = response.actualConfig ?? actualConfig;
			if (!confirmedActual) {
				const error = 'Capture processor did not return an actual configuration';
				applyConfirmedState({
					enabled: true,
					phase: 'error',
					generation: responseGeneration,
					error,
				});
				return {
					...response,
					status: 'error',
					phase: 'error',
					error,
				};
			}
			actualConfig = cloneConfig(confirmedActual);
			return { ...response, actualConfig: confirmedActual };
		}
		return response;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		applyConfirmedState({ enabled: previousActive, phase: 'error', generation: requestGeneration, error: message });
		return {
			status: 'error',
			phase: 'error',
			active: previousActive,
			generation: requestGeneration,
			error: message,
		};
	} finally {
		if (pending === operation) pending = null;
	}
}

function handleMessage(message: unknown): boolean {
	if (isSpectraEventEnvelope(message) && message.type === 'spectra.audio.capture.changed') {
		applyConfirmedState({
			enabled: message.payload.active,
			phase: message.payload.phase,
			generation: message.payload.generation,
			error: message.payload.lastError?.message,
		});
		return true;
	}
	if (!message || typeof message !== 'object') return false;
	const legacy = message as { action?: string; payload?: CaptureStateEvent; enabled?: boolean };
	if (legacy.action !== Actions.CAPTURE_STATE_CHANGE) return false;
	const payload = legacy.payload ?? { enabled: legacy.enabled };
	applyConfirmedState(payload);
	return true;
}

async function syncConfig(config: AudioConfig, requestedGeneration = generation): Promise<AudioConfig | null> {
	if (!active || !isExtensionContextValid()) return null;
	try {
		const nextGeneration = Math.max(generation, requestedGeneration);
		const response = await sendSpectraRequest(
			'spectra.audio.capture.config',
			{ config },
			{ generation: nextGeneration },
		);
		if (!response.ok) throw new Error(response.error.message);
		if (response.data.lastError || response.data.generation !== nextGeneration) {
			throw new Error(response.data.lastError?.message || 'Capture configuration was not acknowledged');
		}
		generation = response.data.generation;
		lastError = undefined;
		if (!response.data.actualConfig) {
			throw new Error('Capture processor did not return an actual configuration');
		}
		actualConfig = cloneConfig(response.data.actualConfig);
		return cloneConfig(actualConfig);
	} catch (error) {
		lastError = error instanceof Error ? error.message : String(error);
		return null;
	}
}

export type CaptureManager = ReturnType<typeof createCaptureManager>;

export function resetCaptureManagerForTests(): void {
	active = false;
	phase = 'idle';
	generation = 0;
	lastError = undefined;
	actualConfig = null;
	pending = null;
}
