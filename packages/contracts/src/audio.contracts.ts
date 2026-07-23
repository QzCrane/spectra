// goal: defines core audio data structures and service interfaces for the audio engine

import type { Result } from './common.types.js';

// `volume` remains the one-release v1 compatibility projection. New code owns
// `volumeBase` (page-native 0-100) and `boost` (processor 1-8) independently.
export interface AudioConfig {
  enabled: boolean;
  volume: number;
  volumeBase?: number;
  boost?: number;
  muted: boolean;
  compressor: boolean;
  mono: boolean;
  bass: boolean;
  // inv: 10-band array, range -12 to +12
  eqValues: number[];
  // inv: -1 (left) to 1 (right)
  pan: number;
  // inv: 0ms to 500ms; browsers cannot render negative audio delay
  delay: number;
  // inv: 0.1 to 16.0, default 1.0
  speed: number;
  // Standard HTMLMediaElement pitch-preservation preference.
  preservePitch: boolean;
}

// Exact graph state shared by Media WebAudio and Capture. Playback speed and
// the product enable switch are intentionally outside the processor boundary.
export interface AudioProcessorConfig {
  // Processor gain is Boost only. Page volume and media mute remain owned by
  // the standard DOM/allowlisted official-player writers and cannot be encoded
  // as a second DSP writer at this boundary.
  boostGain: number;
  compressor: boolean;
  mono: boolean;
  bass: boolean;
  eqValues: number[];
  pan: number;
  delay: number;
}

export const DEFAULT_AUDIO_CONFIG: Readonly<AudioConfig> = {
  enabled: true,
  volume: 100,
  volumeBase: 100,
  boost: 1,
  muted: false,
  compressor: false,
  mono: false,
  bass: false,
  eqValues: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  pan: 0,
  delay: 0,
  speed: 1.0,
  preservePitch: true,
} as const;

const AUDIO_CONFIG_KEYS = new Set<keyof AudioConfig>([
  'enabled',
  'volume',
  'volumeBase',
  'boost',
  'muted',
  'compressor',
  'mono',
  'bass',
  'eqValues',
  'pan',
  'delay',
  'speed',
  'preservePitch',
]);

const AUDIO_PROCESSOR_CONFIG_KEYS = new Set<keyof AudioProcessorConfig>([
  'boostGain',
  'compressor',
  'mono',
  'bass',
  'eqValues',
  'pan',
  'delay',
]);

const AUDIO_SESSION_KEYS = new Set<keyof AudioSessionSnapshot>([
  'tabId',
  'documentId',
  'origin',
  'generation',
  'desiredMode',
  'actualMode',
  'phase',
  'configRevision',
  'actualConfig',
  'lastError',
]);

const AUDIO_RUNTIME_STATUS_KEYS = new Set<keyof AudioRuntimeStatus>([
  'config',
  'hasAudio',
  'isPlaying',
  'desiredMode',
  'actualMode',
  'phase',
  'generation',
  'userInteracted',
  'pausedAt',
  'lastError',
]);

const AUDIO_CAPTURE_STATE_KEYS = new Set<keyof AudioCaptureState>([
  'tabId',
  'generation',
  'phase',
  'active',
  'actualMode',
  'lastError',
  'actualConfig',
]);

const AUDIO_SESSION_MODES = new Set<SpectraAudioMode>(['bypass', 'webaudio', 'capture']);
const AUDIO_SESSION_PHASES = new Set<AudioSessionPhase>(['idle', 'starting', 'active', 'stopping', 'error']);
const AUDIO_SESSION_ERROR_KEYS = new Set<keyof AudioSessionError>(['code', 'message', 'retryable']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function isFiniteInRange(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === 'number'
    && Number.isFinite(value)
    && value >= minimum
    && value <= maximum;
}

export interface ResolvedAudioVolume {
  volumeBase: number;
  boost: number;
  effectiveVolume: number;
}

export function resolveAudioVolume(config: Pick<AudioConfig, 'volume' | 'volumeBase' | 'boost'>): ResolvedAudioVolume {
  const legacy = Math.max(0, Math.min(800, Number.isFinite(config.volume) ? config.volume : 100));
  const hasCanonical = config.volumeBase !== undefined || config.boost !== undefined;
  const volumeBase = hasCanonical
    ? Math.max(0, Math.min(100, Number.isFinite(config.volumeBase) ? Number(config.volumeBase) : 100))
    : Math.min(100, legacy);
  const boost = hasCanonical
    ? Math.max(1, Math.min(8, Number.isFinite(config.boost) ? Number(config.boost) : 1))
    : legacy > 100 ? legacy / 100 : 1;
  return {
    volumeBase,
    boost,
    effectiveVolume: Math.round(volumeBase * boost * 100) / 100,
  };
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

export function isAudioSessionError(value: unknown): value is AudioSessionError {
  if (!isRecord(value) || !hasOnlyKeys(value, AUDIO_SESSION_ERROR_KEYS)) return false;
  return typeof value.code === 'string'
    && value.code.length > 0
    && value.code.length <= 128
    && typeof value.message === 'string'
    && value.message.length > 0
    && value.message.length <= 4096
    && typeof value.retryable === 'boolean';
}

function isCanonicalOrigin(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2048) return false;
  try {
    const url = new URL(value);
    return url.origin !== 'null' && url.origin === value;
  } catch {
    return false;
  }
}

// post: accepts only a complete, finite AudioConfig that the WebAudio runtime can implement
export function isAudioConfig(value: unknown): value is AudioConfig {
  if (!isRecord(value) || !hasOnlyKeys(value, AUDIO_CONFIG_KEYS)) return false;
  return typeof value.enabled === 'boolean'
    && isFiniteInRange(value.volume, 0, 800)
    && (value.volumeBase === undefined || isFiniteInRange(value.volumeBase, 0, 100))
    && (value.boost === undefined || isFiniteInRange(value.boost, 1, 8))
    && typeof value.muted === 'boolean'
    && typeof value.compressor === 'boolean'
    && typeof value.mono === 'boolean'
    && typeof value.bass === 'boolean'
    && Array.isArray(value.eqValues)
    && value.eqValues.length === 10
    && value.eqValues.every((item) => isFiniteInRange(item, -12, 12))
    && isFiniteInRange(value.pan, -1, 1)
    && isFiniteInRange(value.delay, 0, 500)
    && isFiniteInRange(value.speed, 0.1, 16)
    && typeof value.preservePitch === 'boolean';
}

export function isAudioProcessorConfig(value: unknown): value is AudioProcessorConfig {
  if (!isRecord(value) || !hasOnlyKeys(value, AUDIO_PROCESSOR_CONFIG_KEYS)) return false;
  return isFiniteInRange(value.boostGain, 1, 8)
    && typeof value.compressor === 'boolean'
    && typeof value.mono === 'boolean'
    && typeof value.bass === 'boolean'
    && Array.isArray(value.eqValues)
    && value.eqValues.length === 10
    && value.eqValues.every((item) => isFiniteInRange(item, -12, 12))
    && isFiniteInRange(value.pan, -1, 1)
    && isFiniteInRange(value.delay, 0, 500);
}

// post: validates a field-level audio update without requiring unrelated fields
export function isAudioConfigPatch(value: unknown): value is Partial<AudioConfig> {
  if (!isRecord(value) || !hasOnlyKeys(value, AUDIO_CONFIG_KEYS)) return false;
  return (value.enabled === undefined || typeof value.enabled === 'boolean')
    && (value.volume === undefined || isFiniteInRange(value.volume, 0, 800))
    && (value.volumeBase === undefined || isFiniteInRange(value.volumeBase, 0, 100))
    && (value.boost === undefined || isFiniteInRange(value.boost, 1, 8))
    && (value.muted === undefined || typeof value.muted === 'boolean')
    && (value.compressor === undefined || typeof value.compressor === 'boolean')
    && (value.mono === undefined || typeof value.mono === 'boolean')
    && (value.bass === undefined || typeof value.bass === 'boolean')
    && (value.eqValues === undefined || (
      Array.isArray(value.eqValues)
      && value.eqValues.length === 10
      && value.eqValues.every((item) => isFiniteInRange(item, -12, 12))
    ))
    && (value.pan === undefined || isFiniteInRange(value.pan, -1, 1))
    && (value.delay === undefined || isFiniteInRange(value.delay, 0, 500))
    && (value.speed === undefined || isFiniteInRange(value.speed, 0.1, 16))
    && (value.preservePitch === undefined || typeof value.preservePitch === 'boolean');
}

// post: identifies the transparent, never-activated site configuration
export function isDefaultAudioConfig(config: AudioConfig): boolean {
	const volume = resolveAudioVolume(config);
	return config.enabled === DEFAULT_AUDIO_CONFIG.enabled
		&& volume.volumeBase === DEFAULT_AUDIO_CONFIG.volumeBase
		&& volume.boost === DEFAULT_AUDIO_CONFIG.boost
		&& config.muted === DEFAULT_AUDIO_CONFIG.muted
		&& config.compressor === DEFAULT_AUDIO_CONFIG.compressor
		&& config.mono === DEFAULT_AUDIO_CONFIG.mono
		&& config.bass === DEFAULT_AUDIO_CONFIG.bass
		&& config.pan === DEFAULT_AUDIO_CONFIG.pan
		&& config.delay === DEFAULT_AUDIO_CONFIG.delay
		&& config.speed === DEFAULT_AUDIO_CONFIG.speed
		&& config.preservePitch === DEFAULT_AUDIO_CONFIG.preservePitch
		&& config.eqValues.length === DEFAULT_AUDIO_CONFIG.eqValues.length
		&& config.eqValues.every((value, index) => value === DEFAULT_AUDIO_CONFIG.eqValues[index]);
}

// Types of audio processing engines
export type AudioMode =
  // Legacy internal tokens kept for the v1 adapter. `NATIVE_WEBAUDIO` means
  // explicitly admitted extension-owned Media WebAudio, never page injection
  // or a native fallback; `NATIVE_LITE` means transparent/native-only bypass.
  | 'NATIVE_WEBAUDIO'
  | 'NATIVE_LITE'
  | 'CAPTURE'          // browser tab capture mode (prevents CORS issues)
  | 'DISABLED';

// Runtime state of the audio engine
export interface AudioState {
  config: AudioConfig;
  mode: AudioMode;
  hasAudio: boolean;
  isPlaying: boolean;
  userInteracted: boolean;
  corsBlocked: boolean;
}

export type SpectraAudioMode = 'bypass' | 'webaudio' | 'capture';
export type AudioSessionPhase = 'idle' | 'starting' | 'active' | 'stopping' | 'error';
export type AudioVolumeState = 'silent' | 'native' | 'capture';

export interface AudioSessionError {
	code: string;
	message: string;
	retryable: boolean;
}

export interface TabSessionIdentity {
	tabId: number;
	documentId: string;
	origin: string;
}

// goal: acknowledged, read-only state shared by UI, badge, offscreen, and remote control
export interface AudioSessionSnapshot extends TabSessionIdentity {
	generation: number;
	desiredMode: SpectraAudioMode;
	actualMode: SpectraAudioMode;
	phase: AudioSessionPhase;
	configRevision: number;
	actualConfig: AudioConfig;
	lastError: AudioSessionError | null;
}

export type AudioSessionIdentity = TabSessionIdentity & { generation: number };

// post: true only when lifecycle and field-level actual state belong to the
// same top-level document generation. UI surfaces must fail closed on a
// missing or stale session instead of carrying Capture color across navigation.
export function audioSessionMatchesIdentity<T extends AudioSessionIdentity>(
	session: T | null | undefined,
	identity: AudioSessionIdentity | null | undefined,
): session is T {
	return session !== null
		&& session !== undefined
		&& identity !== null
		&& identity !== undefined
		&& session.tabId === identity.tabId
		&& session.documentId === identity.documentId
		&& session.origin === identity.origin
		&& session.generation === identity.generation;
}

// ControlSnapshot generation orders per-field document control, while an audio
// session generation orders processor transitions. They share document
// identity but intentionally keep independent monotonic clocks.
export function audioSessionMatchesControlDocument<T extends TabSessionIdentity>(
	session: T | null | undefined,
	control: TabSessionIdentity | null | undefined,
): session is T {
	return session !== null
		&& session !== undefined
		&& control !== null
		&& control !== undefined
		&& session.tabId === control.tabId
		&& session.documentId === control.documentId
		&& session.origin === control.origin;
}

export function isActiveCaptureLifecycle(value: {
	actualMode: SpectraAudioMode | null | undefined;
	phase: AudioSessionPhase;
}): boolean {
	return value.actualMode === 'capture' && value.phase === 'active';
}

// post: the single semantic state behind Popup, badge and authenticated remote
// colors. Volume thresholds never imply Capture; only an acknowledged active
// Capture lifecycle can do so.
export function resolveAudioVolumeState(value: {
	volume: number;
	muted: boolean;
	actualMode: SpectraAudioMode | null | undefined;
	phase: AudioSessionPhase;
}): AudioVolumeState {
	if (value.muted || value.volume <= 0) return 'silent';
	return isActiveCaptureLifecycle(value)
		? 'capture'
		: 'native';
}

// goal: complete, side-effect-free status returned by the current document runtime
export interface AudioRuntimeStatus {
  config: AudioConfig;
  hasAudio: boolean;
  isPlaying: boolean;
  desiredMode: SpectraAudioMode;
  actualMode: SpectraAudioMode;
  phase: AudioSessionPhase;
  generation: number;
  userInteracted: boolean;
  pausedAt: number | null;
  lastError: AudioSessionError | null;
}

// goal: acknowledged capture processor state shared by background, content, and popup
export interface AudioCaptureState {
  tabId: number;
  generation: number;
  phase: AudioSessionPhase;
  active: boolean;
  actualMode: 'bypass' | 'capture';
  lastError: AudioSessionError | null;
  actualConfig?: AudioConfig;
}

// post: validates the complete acknowledged state before UI, badge, or remote code consumes it
export function isAudioSessionSnapshot(value: unknown): value is AudioSessionSnapshot {
  if (!isRecord(value) || !hasOnlyKeys(value, AUDIO_SESSION_KEYS)) return false;
  return Number.isInteger(value.tabId)
    && Number(value.tabId) > 0
    && typeof value.documentId === 'string'
    && value.documentId.length > 0
    && value.documentId.length <= 256
    && isCanonicalOrigin(value.origin)
    && isNonNegativeInteger(value.generation)
    && typeof value.desiredMode === 'string'
    && AUDIO_SESSION_MODES.has(value.desiredMode as SpectraAudioMode)
    && typeof value.actualMode === 'string'
    && AUDIO_SESSION_MODES.has(value.actualMode as SpectraAudioMode)
    && typeof value.phase === 'string'
    && AUDIO_SESSION_PHASES.has(value.phase as AudioSessionPhase)
    && isNonNegativeInteger(value.configRevision)
    && isAudioConfig(value.actualConfig)
    && (value.lastError === null || isAudioSessionError(value.lastError));
}

export function isAudioRuntimeStatus(value: unknown): value is AudioRuntimeStatus {
  if (!isRecord(value) || !hasOnlyKeys(value, AUDIO_RUNTIME_STATUS_KEYS)) return false;
  return isAudioConfig(value.config)
    && typeof value.hasAudio === 'boolean'
    && typeof value.isPlaying === 'boolean'
    && typeof value.desiredMode === 'string'
    && AUDIO_SESSION_MODES.has(value.desiredMode as SpectraAudioMode)
    && typeof value.actualMode === 'string'
    && AUDIO_SESSION_MODES.has(value.actualMode as SpectraAudioMode)
    && typeof value.phase === 'string'
    && AUDIO_SESSION_PHASES.has(value.phase as AudioSessionPhase)
    && isNonNegativeInteger(value.generation)
    && typeof value.userInteracted === 'boolean'
    && (value.pausedAt === null || isNonNegativeInteger(value.pausedAt))
    && (value.lastError === null || isAudioSessionError(value.lastError));
}

export function isAudioCaptureState(value: unknown): value is AudioCaptureState {
  if (!isRecord(value) || !hasOnlyKeys(value, AUDIO_CAPTURE_STATE_KEYS)) return false;
  return Number.isInteger(value.tabId)
    && Number(value.tabId) > 0
    && isNonNegativeInteger(value.generation)
    && typeof value.phase === 'string'
    && AUDIO_SESSION_PHASES.has(value.phase as AudioSessionPhase)
    && typeof value.active === 'boolean'
    && (value.actualMode === 'bypass' || value.actualMode === 'capture')
    && value.actualMode === (value.active ? 'capture' : 'bypass')
    && (value.actualConfig === undefined || isAudioConfig(value.actualConfig))
    && (value.lastError === null || isAudioSessionError(value.lastError));
}

// goal: abstract interface for audio control, implementation in @nexus/audio-engine
export interface IAudioService {
  getState(): AudioState;

  // eff: returns frequency data for visualization
  getVisualizerData(): Float32Array | null;

  setVolume(level: number): Result<void>;

  toggleMute(): Result<boolean>;

  updateConfig(config: Partial<AudioConfig>): Result<void>;

  // eff: switch to tab capture mode, requires user permission
  setCaptureMode(enabled: boolean): Promise<Result<void>>;

  on(event: 'stateChange', handler: (state: AudioState) => void): () => void;

  on(event: 'corsDetected', handler: () => void): () => void;

  init(): Promise<Result<void>>;

  // post: release all hardware and memory resources
  dispose(): void;
}

export interface UrlInfo {
  fullUrl: string;
  domain: string;
  pathname: string;
  isIframe: boolean;
}

// Input for audio mode policy calculation
export interface PolicyContext {
  urlInfo: UrlInfo;
  hasMediaElement: boolean;
  hasAudioContext: boolean;
  userInteracted: boolean;
  enabled: boolean;
  volume: number;
  // rule: force native mode for specific self-healing scenarios
  forceNative: boolean;
  // rule: determined by CORS detection results
  isRestricted?: boolean;
  config?: AudioConfig;
}

// goal: stateless engine to determine optimal audio mode based on environment
export interface IPolicyEngine {
  // eff: compute the best mode for the given context
  calculateMode(context: PolicyContext): AudioMode;

  /** @deprecated v3.0 */
  getRuleForDomain(domain: string): SiteRule | null;
}

/** @deprecated moved to dynamic CORS detection */
export interface SiteRule {
  type: 'whitelist' | 'blacklist' | 'force_capture' | 'force_native';
  pattern: string;
  reason?: string;
}

