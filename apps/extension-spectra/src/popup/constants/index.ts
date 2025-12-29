// goal: serves as the central aggregation point for all SPECTRA popup constants, ensuring consistent UI behavior

export { COLORS, EQ_GRADIENT } from './colors';
export type { ColorKey } from './colors';

export { AUDIO_UI, DEFAULT_EQ_VALUES } from './audio';

export { TIMING, UI_SIZES, VIZ_PARAMS } from './timing';

export { I18N, DEFAULT_LANG, SUPPORTED_LANGS, getDict } from './i18n';

// rule: identifies browser-protected schemes where extension interaction (e.g. content script injection) is forbidden
export const RESTRICTED_URL_PREFIXES = [
  'chrome:',
  'edge:',
  'about:',
  'chrome-extension:',
] as const;
