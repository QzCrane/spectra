// goal: defines core audio data structures and service interfaces for the audio engine

import type { Result, VolumeLevel, TabId } from './common.types.js';

// inv: 0-800 range where 100 is unity gain
export interface AudioConfig {
  enabled: boolean;
  volume: number;
  muted: boolean;
  compressor: boolean;
  mono: boolean;
  bass: boolean;
  // inv: 10-band array, range -12 to +12
  eqValues: number[];
  // inv: -1 (left) to 1 (right)
  pan: number;
  // inv: -500ms to +500ms, positive means audio delay
  delay: number;
}

export const DEFAULT_AUDIO_CONFIG: Readonly<AudioConfig> = {
  enabled: true,
  volume: 100,
  muted: false,
  compressor: false,
  mono: false,
  bass: false,
  eqValues: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  pan: 0,
  delay: 0
} as const;

// Types of audio processing engines
export type AudioMode =
  | 'NATIVE_WEBAUDIO'  // direct injection via WebAudio
  | 'NATIVE_LITE'      // lightweight mode for overhead reduction
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
  visualizerEnabled: boolean;
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

