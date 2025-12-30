// goal: defines visual and interaction bounds for audio parameters within the popup UI

export const AUDIO_UI = {
  // MAX_VOLUME: maps to the maximum allowable boost (800%) in the volume slider
  MAX_VOLUME: 800,
  // VOLUME_STEP: incremental value for mouse wheel or keyboard adjustments
  VOLUME_STEP: 10,
  // EQ_MIN/MAX: decibel range for the graphic equalizer UI
  EQ_MIN: -12,
  EQ_MAX: 12,
  EQ_STEP: 0.1,
} as const;

// DEFAULT_EQ_VALUES: initial flat gain (0dB) for all 10 frequency bands
export const DEFAULT_EQ_VALUES = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] as const;
