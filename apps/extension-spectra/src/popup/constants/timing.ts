// goal: defines timing thresholds, rendering intervals, and visual proportions for the popup UI

// TIMING: values in milliseconds controlling animation synchronization and renderer updates
export const TIMING = {
  // CAPTURE_INIT_DELAY: allowance for Chrome's offscreen document to bootstrap before sending commands
  CAPTURE_INIT_DELAY: 300,
  // VIZ_FRAME_INTERVAL: target interval (~30 FPS) for polling visualizer data from content/offscreen
  VIZ_FRAME_INTERVAL: 32,
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
