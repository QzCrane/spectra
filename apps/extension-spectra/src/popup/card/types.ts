// goal: defines internal types, state interfaces, and configuration defaults for the popup tab card component

import type { AudioConfig, GlobalSettings } from '@nexus/kernel';
import type { ControlFieldStates, ControlSnapshot } from '@nexus/contracts';
import { DEFAULT_AUDIO_CONFIG } from '@nexus/kernel';
import type {
  AudioSessionError,
  AudioSessionPhase,
  DomainEntry,
  SpectraAudioMode,
} from '@nexus/contracts';
import { resolveAudioVolume } from '@nexus/contracts';
import type { CardUIElements, I18NDict } from '../types';

export interface CardInternalState {
  config: AudioConfig;
  stableConfig: AudioConfig;
  controlSnapshot: ControlSnapshot | null;
  isCaptureActive: boolean;
  processorTransitionPending?: boolean;
  userInteracted: boolean;
  isRestrictedSite: boolean;
  actualMode: SpectraAudioMode;
  desiredMode: SpectraAudioMode;
  phase: AudioSessionPhase;
  controlGeneration: number;
  controlRevision: number;
  audioDocumentId: string | null;
  audioOrigin: string | null;
  audioGeneration: number;
  audioConfigRevision: number;
  lastError: AudioSessionError | null;
  // isDragging: flag to prevent UI jitter by skipping re-renders while the user is actively manipulating sliders
  isDragging: boolean;
  draggingField: 'volume' | null;
}

export type EqCurveDrawerFactory = (
  canvas: HTMLCanvasElement,
  sliderRow: HTMLElement,
  getEqValues: () => number[]
) => { draw: (color?: string) => void; updateMetrics: () => void };

export interface InitCardParams {
  container: HTMLElement;
  template: HTMLTemplateElement;
  tab: chrome.tabs.Tab;
  dict: I18NDict;
  registryEntries: DomainEntry[];
  getGlobalSettings: () => GlobalSettings;
  isBackground?: boolean;
  createEqCurveDrawer?: EqCurveDrawerFactory;
}

// CardContext: unified handle passed to sub-modules (rendering, messaging, events) to access shared tab state and UI refs
export interface CardContext {
  tab: chrome.tabs.Tab;
  domain: string;
  ui: CardUIElements;
  state: CardInternalState;
  render: () => void;
  update: (changes: Partial<AudioConfig>) => void;
  getCapturing: () => boolean;
}

// post: returns deep-merged and validated AudioConfig object, ensuring eqValues array presence and removing transient command fields
export function cleanConfig(config: Partial<AudioConfig> | null): AudioConfig {
  const c = mergeAudioConfig(DEFAULT_AUDIO_CONFIG, config ?? {});
  if (!Array.isArray(c.eqValues)) {
    c.eqValues = [...DEFAULT_AUDIO_CONFIG.eqValues];
  }
  if (c.enabled === undefined) {
    c.enabled = true;
  }
  // note: strip internal command triggers used for temporary sync that shouldn't persist in the configuration state
  Reflect.deleteProperty(c, 'toggleMute');
  Reflect.deleteProperty(c, 'volumeDelta');
  return c;
}

// post: canonical volume fields and the one-release compatibility projection
// are updated atomically so no UI surface can collapse 50% x 2 into 100% x 1.
export function mergeAudioConfig(
  current: AudioConfig,
  changes: Partial<AudioConfig>,
): AudioConfig {
  const merged = { ...current, ...changes };
  const legacyVolume = changes.volume;
  const legacyOnly = legacyVolume !== undefined
    && changes.volumeBase === undefined
    && changes.boost === undefined;
  const volume = legacyOnly
    ? resolveAudioVolume({ volume: legacyVolume ?? 100 })
    : resolveAudioVolume({
      volume: merged.volume,
      volumeBase: merged.volumeBase,
      boost: merged.boost,
    });
  return {
    ...merged,
    volumeBase: volume.volumeBase,
    boost: volume.boost,
    volume: volume.effectiveVolume,
  };
}

// Snapshot fields are actual cross-surface control state. Project only audio
// fields understood by the current card and preserve every unrelated config
// value until its owning control migrates to the coordinator.
export function mergeControlSnapshot(
  current: AudioConfig,
  snapshot: ControlSnapshot | null,
): AudioConfig {
  return snapshot ? mergeControlFields(current, snapshot.fields) : current;
}

// ControlSnapshot is the sole field-level actual authority. AudioSessionSnapshot
// owns only processor lifecycle, so initial card fields start neutral and are
// projected exclusively from the current control snapshot.
export function initialControlConfig(snapshot: ControlSnapshot | null): AudioConfig {
  return mergeControlSnapshot(cleanConfig(DEFAULT_AUDIO_CONFIG), snapshot);
}

export function mergeControlFields(
  current: AudioConfig,
  fields: ControlFieldStates,
): AudioConfig {
  const changes: Partial<AudioConfig> = {};
  const actual = <K extends keyof ControlFieldStates>(field: K) =>
    fields[field]?.phase === 'applied' ? fields[field]?.actual : undefined;
  const audioEnabled = actual('audioEnabled');
  const volumeBase = actual('volumeBase');
  const boost = actual('boost');
  const mediaMuted = actual('mediaMuted');
  const speed = actual('speed');
  const preservePitch = actual('preservePitch');
  const eqValues = actual('eqValues');
  const bass = actual('bass');
  const compressor = actual('compressor');
  const mono = actual('mono');
  const pan = actual('pan');
  const delay = actual('delay');
  if (typeof audioEnabled === 'boolean') changes.enabled = audioEnabled;
  if (typeof volumeBase === 'number') changes.volumeBase = volumeBase;
  if (typeof boost === 'number') changes.boost = boost;
  if (typeof mediaMuted === 'boolean') changes.muted = mediaMuted;
  if (typeof speed === 'number') changes.speed = speed;
  if (typeof preservePitch === 'boolean') changes.preservePitch = preservePitch;
  if (Array.isArray(eqValues)) changes.eqValues = [...eqValues];
  if (typeof bass === 'boolean') changes.bass = bass;
  if (typeof compressor === 'boolean') changes.compressor = compressor;
  if (typeof mono === 'boolean') changes.mono = mono;
  if (typeof pan === 'number') changes.pan = pan;
  if (typeof delay === 'number') changes.delay = delay;
  return mergeAudioConfig(current, changes);
}
