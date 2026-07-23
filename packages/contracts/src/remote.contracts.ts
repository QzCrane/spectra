// goal: extension-internal UI/background boundary for authenticated remote sessions

import type { ControlCapability } from './control.contracts.js';
import type {
	AudioSessionPhase,
	AudioVolumeState,
	SpectraAudioMode,
} from './audio.contracts.js';

export interface RemotePublicSession {
	protocolVersion: 2;
	sessionId: string;
	peerId: string;
	secret: string;
	createdAt: number;
	pairingExpiresAt: number;
	tabId: number;
	connected: boolean;
}

export interface RemoteSessionStatus {
	session: RemotePublicSession | null;
	connected: boolean;
}

export interface RemoteSessionChangedEvent {
	tabId: number;
	sessionId: string;
	connected: boolean;
}

export interface RemoteSessionClosedEvent {
	tabId: number;
	sessionId: string;
}

export const REMOTE_COMMANDS = [
	'volume_up',
	'volume_down',
	'volume_max',
	'volume_100',
	'boost_up',
	'boost_down',
	'boost_reset',
	'boost_max',
	'mute',
	'play_pause',
	'seek_forward',
	'seek_backward',
	'seek_forward_30',
	'seek_backward_30',
	'speed_up',
	'speed_down',
	'speed_reset',
	'fullscreen',
	'pip',
] as const;

export type RemoteCommand = (typeof REMOTE_COMMANDS)[number];

export type RemoteCommandOperation = 'delta' | 'set' | 'toggle';

export interface RemoteCommandDescriptor {
	capability: ControlCapability;
	operation: RemoteCommandOperation;
	value?: number;
	legacyAlias: boolean;
}

const remoteDescriptor = (
	capability: ControlCapability,
	operation: RemoteCommandOperation,
	value?: number,
	legacyAlias = false,
): RemoteCommandDescriptor => ({ capability, operation, value, legacyAlias });

// Remote buttons are surface aliases, never independent algorithms. This
// exhaustive map fixes their canonical capability and transform so handler,
// phone UI and tests cannot silently diverge on steps or volume/Boost meaning.
export const REMOTE_COMMAND_DESCRIPTORS = {
	volume_up: remoteDescriptor('effective-volume', 'delta', 10),
	volume_down: remoteDescriptor('effective-volume', 'delta', -10),
	volume_max: remoteDescriptor('effective-volume', 'set', 800),
	volume_100: remoteDescriptor('effective-volume', 'set', 100),
	boost_up: remoteDescriptor('effective-volume', 'delta', 10, true),
	boost_down: remoteDescriptor('effective-volume', 'delta', -10, true),
	boost_reset: remoteDescriptor('effective-volume', 'set', 100, true),
	boost_max: remoteDescriptor('effective-volume', 'set', 800, true),
	mute: remoteDescriptor('mediaMuted', 'toggle'),
	play_pause: remoteDescriptor('playback-toggle', 'toggle'),
	seek_forward: remoteDescriptor('seek-relative', 'delta', 10),
	seek_backward: remoteDescriptor('seek-relative', 'delta', -10),
	seek_forward_30: remoteDescriptor('seek-relative', 'delta', 30),
	seek_backward_30: remoteDescriptor('seek-relative', 'delta', -30),
	speed_up: remoteDescriptor('speed', 'delta', 0.25),
	speed_down: remoteDescriptor('speed', 'delta', -0.25),
	speed_reset: remoteDescriptor('speed', 'set', 1),
	fullscreen: remoteDescriptor('fullscreen', 'toggle'),
	pip: remoteDescriptor('pip', 'toggle'),
} as const satisfies Record<RemoteCommand, RemoteCommandDescriptor>;

export interface RemoteState {
	generation: number;
	/** @deprecated one-release effective-volume projection */
	volume: number;
	volumeBase?: number;
	boost?: number;
	actualMode: SpectraAudioMode;
	phase: AudioSessionPhase;
	/** Canonical color/state projection; optional only for one-release clients. */
	volumeState?: AudioVolumeState;
	muted: boolean;
	playing: boolean;
	speed: number;
	tabTitle?: string;
	tabDomain?: string;
}

const REMOTE_PUBLIC_SESSION_KEYS = new Set<keyof RemotePublicSession>([
	'protocolVersion',
	'sessionId',
	'peerId',
	'secret',
	'createdAt',
	'pairingExpiresAt',
	'tabId',
	'connected',
]);
const TOKEN_RE = /^[A-Za-z0-9_-]{22}$/u;
const remoteCommandSet: ReadonlySet<string> = new Set(REMOTE_COMMANDS);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isRemotePublicSession(value: unknown): value is RemotePublicSession {
	if (!isRecord(value) || !Object.keys(value).every((key) => REMOTE_PUBLIC_SESSION_KEYS.has(key as keyof RemotePublicSession))) {
		return false;
	}
	return value.protocolVersion === 2
		&& typeof value.sessionId === 'string'
		&& TOKEN_RE.test(value.sessionId)
		&& typeof value.peerId === 'string'
		&& /^spectra-[a-f0-9]{32}$/u.test(value.peerId)
		&& typeof value.secret === 'string'
		&& TOKEN_RE.test(value.secret)
		&& typeof value.createdAt === 'number'
		&& Number.isSafeInteger(value.createdAt)
		&& value.createdAt >= 0
		&& typeof value.pairingExpiresAt === 'number'
		&& Number.isSafeInteger(value.pairingExpiresAt)
		&& value.pairingExpiresAt > value.createdAt
		&& typeof value.tabId === 'number'
		&& Number.isInteger(value.tabId)
		&& value.tabId > 0
		&& typeof value.connected === 'boolean';
}

export function isRemoteSessionToken(value: unknown): value is string {
	return typeof value === 'string' && TOKEN_RE.test(value);
}

export function isRemoteCommand(value: unknown): value is RemoteCommand {
	return typeof value === 'string' && remoteCommandSet.has(value);
}

export function isRemoteState(value: unknown): value is RemoteState {
	if (!isRecord(value)) return false;
	const keys = Object.keys(value);
	if (!keys.every((key) => [
		'generation',
		'volume',
		'volumeBase',
		'boost',
		'actualMode',
		'phase',
		'volumeState',
		'muted',
		'playing',
		'speed',
		'tabTitle',
		'tabDomain',
	].includes(key))) return false;
	return Number.isSafeInteger(value.generation)
		&& (value.generation as number) >= 0
		&& isFiniteInRange(value.volume, 0, 800)
		&& (value.volumeBase === undefined || isFiniteInRange(value.volumeBase, 0, 100))
		&& (value.boost === undefined || isFiniteInRange(value.boost, 1, 8))
		&& (value.actualMode === 'bypass' || value.actualMode === 'webaudio' || value.actualMode === 'capture')
		&& (value.phase === 'idle' || value.phase === 'starting' || value.phase === 'active'
			|| value.phase === 'stopping' || value.phase === 'error')
		&& (value.volumeState === undefined || value.volumeState === 'silent'
			|| value.volumeState === 'native' || value.volumeState === 'capture')
		&& typeof value.muted === 'boolean'
		&& typeof value.playing === 'boolean'
		&& isFiniteInRange(value.speed, 0.1, 16)
		&& (value.tabTitle === undefined
			|| (typeof value.tabTitle === 'string' && value.tabTitle.length <= 512))
		&& (value.tabDomain === undefined
			|| (typeof value.tabDomain === 'string' && value.tabDomain.length <= 253));
}

function isFiniteInRange(value: unknown, minimum: number, maximum: number): value is number {
	return typeof value === 'number'
		&& Number.isFinite(value)
		&& value >= minimum
		&& value <= maximum;
}
