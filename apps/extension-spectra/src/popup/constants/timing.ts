// goal: defines timing thresholds, rendering intervals, and visual proportions for the popup UI

// TIMING: values in milliseconds controlling animation synchronization and renderer updates
export const TIMING = {
  // VIZ_FRAME_INTERVAL: maximum 15 samples per second across one shared popup scheduler
  VIZ_FRAME_INTERVAL: 67,
  // EQ_DRAWER_DELAY: matches CSS transition time to ensure canvas resizing triggers after the drawer is fully open
  EQ_DRAWER_DELAY: 310,
  METRICS_INIT_LOOPS: 20,
  BUTTON_FEEDBACK_DURATION: 1000,
} as const;

// UI_SIZES: pixel-based dimensions for canvas drawing and layout constraints
export const UI_SIZES = {
  SETTINGS_MIN_HEIGHT: 480,
  VIZ_BAR_WIDTH: 3,
  VIZ_BAR_GAP: 1,
  EQ_CURVE_LINE_WIDTH: 2.5,
  EQ_CURVE_SHADOW_BLUR: 8,
} as const;

export const VIZ_PARAMS = {
  HEIGHT_FACTOR: 0.9,
  MIN_VISIBLE_HEIGHT: 1,
} as const;
