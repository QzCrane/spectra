// goal: aggregates and re-exports common popup utilities for DOM manipulation, messaging, and theme management

export {
  $,
  $required,
  $$,
  getSettingsUIElements,
  getDomain,
  isRestrictedUrl,
} from './dom';

export {
  applyTheme,
  getEffectiveTheme,
  getNextThemeMode,
  THEME_ICONS
} from './theme';
