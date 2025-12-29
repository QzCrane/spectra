// goal: aggregates all localized dictionaries and provides utility functions for language resolution

import type { I18NMap, I18NDict } from '../../types';
import { EN_US } from './en';
import { ZH_CN } from './zh-CN';
import { JA_JP } from './ja-JP';
import { KO_KR } from './ko-KR';
import { ES_ES } from './es-ES';
import { FR_FR } from './fr-FR';
import { DE_DE } from './de-DE';
import { RU_RU } from './ru-RU';

export const I18N: I18NMap = {
  'en-US': EN_US,
  'zh-CN': ZH_CN,
  'ja-JP': JA_JP,
  'ko-KR': KO_KR,
  'es-ES': ES_ES,
  'fr-FR': FR_FR,
  'de-DE': DE_DE,
  'ru-RU': RU_RU,
};

export const DEFAULT_LANG = 'en-US';

export const SUPPORTED_LANGS = Object.keys(I18N) as Array<keyof typeof I18N>;

// post: returns the dictionary for the requested language or falls back to the default (en-US)
export function getDict(lang: string): I18NDict {
  return I18N[lang] || I18N[DEFAULT_LANG]!;
}

export { EN_US } from './en';
export { ZH_CN } from './zh-CN';
export { JA_JP } from './ja-JP';
export { KO_KR } from './ko-KR';
export { ES_ES } from './es-ES';
export { FR_FR } from './fr-FR';
export { DE_DE } from './de-DE';
export { RU_RU } from './ru-RU';
