// goal: aggregates and re-exports common popup utilities for DOM manipulation, messaging, and theme management

export {
  messenger,
  $,
  $required,
  $$,
  getSettingsUIElements,
  getDomain,
  isRestrictedUrl,
  sendToTab,
  sendToBackground,
} from './dom';

export {
  applyTheme,
  getEffectiveTheme,
  getNextThemeMode,
  THEME_ICONS
} from './theme';
