// goal: defines visual and interaction bounds for audio parameters within the popup UI

export const AUDIO_UI = {
  // One product control projects to native volumeBase (0–100) plus the hidden
  // processor boost (1–8). The UI never exposes those implementation fields.
  MAX_VOLUME: 800,
  VOLUME_STEP: 10,
  // EQ_MIN/MAX: decibel range for the graphic equalizer UI
  EQ_MIN: -12,
  EQ_MAX: 12,
  EQ_STEP: 0.1,
} as const;
