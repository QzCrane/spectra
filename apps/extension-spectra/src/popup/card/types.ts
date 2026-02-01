// goal: defines internal types, state interfaces, and configuration defaults for the popup tab card component

import type { AudioConfig, GlobalSettings } from '@nexus/kernel';
import type { DomainEntry } from '@nexus/contracts';
import type { CardUIElements, I18NDict } from '../types';

export interface CardInternalState {
  config: AudioConfig;
  isCaptureActive: boolean;
  userInteracted: boolean;
  isRestrictedSite: boolean;
  actualMode: 'NATIVE_WEBAUDIO' | 'NATIVE_LITE' | 'CAPTURE' | null;
  // isDragging: flag to prevent UI jitter by skipping re-renders while the user is actively manipulating sliders
  isDragging: boolean;
}

export interface InitCardParams {
  container: HTMLElement;
  template: HTMLTemplateElement;
  tab: chrome.tabs.Tab;
  dict: I18NDict;
  registryEntries: DomainEntry[];
  getGlobalSettings: () => GlobalSettings;
  isBackground?: boolean;
  createEqCurveDrawer?: (
    canvas: HTMLCanvasElement,
    sliderRow: HTMLElement,
    getEqValues: () => number[]
  ) => { draw: (color?: string) => void; updateMetrics: () => void };
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

export const DEFAULT_CONFIG: AudioConfig = {
  enabled: true,
  volume: 100,
  muted: false,
  compressor: false,
  mono: false,
  bass: false,
  pan: 0,
  delay: 0,
  eqValues: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  speed: 1.0
};

// post: returns deep-merged and validated AudioConfig object, ensuring eqValues array presence and removing transient command fields
export function cleanConfig(config: Partial<AudioConfig> | null): AudioConfig {
  const c = { ...DEFAULT_CONFIG, ...config };
  if (!Array.isArray(c.eqValues)) {
    c.eqValues = [...DEFAULT_CONFIG.eqValues];
  }
  if (c.enabled === undefined) {
    c.enabled = true;
  }
  // note: strip internal command triggers used for temporary sync that shouldn't persist in the configuration state
  delete (c as any).toggleMute;
  delete (c as any).volumeDelta;
  return c;
}
