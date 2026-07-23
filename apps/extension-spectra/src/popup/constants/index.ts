// goal: serves as the central aggregation point for all SPECTRA popup constants, ensuring consistent UI behavior

export { COLORS, EQ_GRADIENT } from './colors';
export type { ColorKey } from './colors';

export { AUDIO_UI } from './audio';

export { TIMING, UI_SIZES, VIZ_PARAMS } from './timing';

// rule: identifies browser-protected schemes where extension interaction (e.g. content script injection) is forbidden
export const RESTRICTED_URL_PREFIXES = [
  'chrome:',
  'edge:',
  'about:',
  'chrome-extension:',
] as const;
