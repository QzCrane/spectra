// goal: aggregation layer for popup view modules, including navigation, settings, and i18n application

export { initNavigation } from './navigation';
export {
  initSettings,
  cardRenderCallbacks,
  type SettingsState,
} from './settings';

export { applyLang, updateCardsI18n } from './i18n-apply';
