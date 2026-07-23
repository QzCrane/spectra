// goal: centralizes type definitions for the SPECTRA popup UI, element mapping, and transient state

import type { AudioConfig, GlobalSettings } from '@nexus/kernel';

export type { I18NDict, I18NMap } from './types/i18n.types';

// CardUIElements: DOM references for a single tab management card
export interface CardUIElements {
  card: HTMLElement;
  title: HTMLElement;
  domain: HTMLElement;
  icon: HTMLImageElement;
  enable: HTMLInputElement;
  mask: HTMLElement;
  maskText: HTMLElement;
  slider: HTMLInputElement;
  fill: HTMLElement;
  val: HTMLElement;
  mute: HTMLElement;
  comp: HTMLInputElement;
  bass: HTMLInputElement;
  mono: HTMLInputElement;
  eqTrigger: HTMLElement;
  eqDrawer: HTMLElement;
  eqInputs: NodeListOf<HTMLInputElement>;
  eqVals: NodeListOf<HTMLElement>;
  btnSave: HTMLElement;
  btnReset: HTMLElement;
  btnSaveGlobal: HTMLElement | null;
  canvas: HTMLCanvasElement;
  sliderArea: HTMLElement;
  tComp: HTMLElement;
  tBass: HTMLElement;
  tMono: HTMLElement;
  tEq: HTMLElement;
  vizIsland: HTMLElement | null;
  btnPause: HTMLElement | null;
  btnPip: HTMLElement | null;
  btnHotkeyTarget: HTMLElement | null;
  btnGotoTab: HTMLElement | null;
  speedInput: HTMLInputElement | null;
  speedBtns: NodeListOf<HTMLElement>;
}

// SettingsUIElements: DOM references for the global settings view in the side panel
export interface SettingsUIElements {
  swOsd: HTMLInputElement | null;
  swViz: HTMLInputElement | null;
  selLang: HTMLSelectElement | null;
  txtRegistry: HTMLTextAreaElement | null;
  groupRegistry: HTMLElement | null;
  btnSaveReg: HTMLElement | null;
}

// CardState: UI-specific transient state for a tab card
export interface CardState {
  config: AudioConfig;
  isCaptureActive: boolean;
  userInteracted: boolean;
  isConnected: boolean;
}

// MetricsCacheData: internal drawing metrics for the smooth EQ analyzer and visualizer
export interface MetricsCacheData {
  row: HTMLElement;
  canvas: HTMLCanvasElement;
  xCoords: Float32Array;
  midY: number;
  width: number;
  height: number;
  dpr: number;
  scaleFactor: number;
  isValid: boolean;
}

export type RenderCallback = () => void;
export type MetricsChangeCallback = () => void;

export type { AudioConfig, GlobalSettings };
