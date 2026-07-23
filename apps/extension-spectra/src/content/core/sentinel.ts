// goal: transfer validated runtime state between same-document content-script revisions

import {
	isAudioConfig,
	type AudioSessionPhase,
	type SpectraAudioMode,
} from '@nexus/contracts';
import type { AudioModeType } from '@nexus/audio-engine';
import { logger } from '../../shared/logger';
import type { PolicyExecutorState } from '../types';

const log = logger.content;
const MAX_STUB_AGE_MS = 30_000;
const MAX_CLOCK_SKEW_MS = 5_000;
const SNAPSHOT_KEYS = new Set([
	'version',
	'config',
	'appliedConfig',
	'userHasInteracted',
	'hasGesture',
	'desiredMode',
	'actualMode',
	'phase',
	'generation',
	'timestamp',
]);
const DESIRED_MODES = new Set<AudioModeType>([
	'NATIVE_WEBAUDIO',
	'NATIVE_LITE',
	'CAPTURE',
	'DISABLED',
]);
const ACTUAL_MODES = new Set<SpectraAudioMode>(['bypass', 'webaudio', 'capture']);
const PHASES = new Set<AudioSessionPhase>(['idle', 'starting', 'active', 'stopping', 'error']);

interface HandoffRecord {
	token: string;
	snapshot: string;
	createdAt: number;
}

interface HandoffWindow extends Window {
	__SPECTRA_ISOLATED_HANDOFF__?: HandoffRecord;
}

interface SerializedState {
	version: string;
	config: PolicyExecutorState['config'];
	appliedConfig: PolicyExecutorState['appliedConfig'];
	userHasInteracted: boolean;
	hasGesture: boolean;
	desiredMode: AudioModeType | null;
	actualMode: SpectraAudioMode;
	phase: AudioSessionPhase;
	generation: number;
	timestamp: number;
}

function extensionVersion(): string {
	try { return chrome.runtime.getManifest().version; } catch { return 'unknown'; }
}

export function createSnapshot(state: PolicyExecutorState): string {
	const snapshot: SerializedState = {
		version: extensionVersion(),
		config: { ...state.config, eqValues: [...state.config.eqValues] },
		appliedConfig: { ...state.appliedConfig, eqValues: [...state.appliedConfig.eqValues] },
		userHasInteracted: state.userHasInteracted,
		hasGesture: state.hasGesture,
		desiredMode: state.desiredMode,
		actualMode: state.actualMode,
		phase: state.phase,
		generation: state.generation,
		timestamp: Date.now(),
	};
	return JSON.stringify(snapshot);
}

// Isolated-world state never enters page-visible DOM. Content-script revisions
// in the same isolated world share this window wrapper; the random token binds
// the record to the serialized payload without exposing either to the page.
export function mountStub(snapshot: string): void {
	const token = crypto.randomUUID();
	const handoff = { token, snapshot, createdAt: Date.now() };
	(window as HandoffWindow).__SPECTRA_ISOLATED_HANDOFF__ = handoff;
	log.debug('[Sentinel] Isolated state handoff mounted');
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseSnapshot(raw: string, createdAt: number): Partial<PolicyExecutorState> | null {
	try {
		const value: unknown = JSON.parse(raw);
		if (!isRecord(value) || !Object.keys(value).every((key) => SNAPSHOT_KEYS.has(key))
			|| Object.keys(value).length !== SNAPSHOT_KEYS.size
			|| typeof value.version !== 'string'
			|| !isAudioConfig(value.config)
			|| !isAudioConfig(value.appliedConfig)
			|| typeof value.userHasInteracted !== 'boolean'
			|| typeof value.hasGesture !== 'boolean'
			|| (value.desiredMode !== null && !DESIRED_MODES.has(value.desiredMode as AudioModeType))
			|| !ACTUAL_MODES.has(value.actualMode as SpectraAudioMode)
			|| !PHASES.has(value.phase as AudioSessionPhase)
			|| !Number.isInteger(value.generation) || Number(value.generation) < 0
			|| typeof value.timestamp !== 'number' || !Number.isFinite(value.timestamp)) return null;

		const now = Date.now();
		const timestamp = Number(value.timestamp);
		if (now - timestamp > MAX_STUB_AGE_MS || timestamp - now > MAX_CLOCK_SKEW_MS
			|| Math.abs(timestamp - createdAt) > MAX_CLOCK_SKEW_MS) return null;

		return {
			config: { ...value.config, eqValues: [...value.config.eqValues] },
			appliedConfig: { ...value.appliedConfig, eqValues: [...value.appliedConfig.eqValues] },
			userHasInteracted: value.userHasInteracted,
			hasGesture: value.hasGesture,
			desiredMode: value.desiredMode as AudioModeType | null,
			actualMode: value.actualMode as SpectraAudioMode,
			phase: value.phase as AudioSessionPhase,
			generation: Number(value.generation),
		};
	} catch {
		return null;
	}
}

export function consumeStub(): Partial<PolicyExecutorState> | null {
	const host = window as HandoffWindow;
	const handoff = host.__SPECTRA_ISOLATED_HANDOFF__;
	delete host.__SPECTRA_ISOLATED_HANDOFF__;
	if (!handoff?.token || !handoff.snapshot) return null;

	const recovered = parseSnapshot(handoff.snapshot, handoff.createdAt);
	if (!recovered) {
		// Expected fail-closed path during an extension update or stale same-document handoff.
		// Rejection is the security behavior; it is not a production console error.
		return null;
	}
	log.info('[Sentinel] Recovered authenticated runtime state');
	return recovered;
}
