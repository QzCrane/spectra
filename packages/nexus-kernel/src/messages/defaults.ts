// goal: defines runtime default values for audio and global configurations

import type { AudioConfig, GlobalSettings } from '@nexus/contracts';

export const DEFAULT_AUDIO_CONFIG: AudioConfig = {
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
};

export const DEFAULT_GLOBAL_SETTINGS: GlobalSettings = {
  osdEnabled: true,
  visualizerEnabled: true,
  lang: 'en-US',
  themeMode: 'system',
  pauseRetentionSeconds: 60
};
