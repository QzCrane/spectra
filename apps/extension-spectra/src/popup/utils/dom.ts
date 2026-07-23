// goal: provides streamlined DOM selection helpers and unified cross-process messaging for the popup context

import type { SettingsUIElements } from '../types';
import { RESTRICTED_URL_PREFIXES } from '../constants';

export function $<T extends HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

// $required: strictly selects an element by ID or throws if missing to prevent silent UI failures
export function $required<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id) as T | null;
  if (!el) throw new Error(`Required element #${id} not found`);
  return el;
}

export function $$<T extends Element>(selector: string, parent: ParentNode = document): NodeListOf<T> {
  return parent.querySelectorAll<T>(selector);
}

// post: returns a mapped object of DOM references for the global settings panel
export function getSettingsUIElements(): SettingsUIElements {
  return {
    swOsd: $<HTMLInputElement>('set-osd'),
    swViz: $<HTMLInputElement>('set-viz'),
    selLang: $<HTMLSelectElement>('set-lang'),
    txtRegistry: $<HTMLTextAreaElement>('set-registry'),
    groupRegistry: $<HTMLElement>('registry-group'),
    btnSaveReg: $<HTMLElement>('btn-save-registry'),
  };
}

export function getDomain(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return 'local';
  }
}

// Browser-provided tab metadata crosses into an extension document. Keep image
// navigation to known image/data and browser URL schemes before assigning src.
export function getSafeImageUrl(value: string | undefined, fallback: string): string {
  if (!value) return fallback;
  if (/^data:image\/(?:png|jpe?g|gif|webp|x-icon|vnd\.microsoft\.icon);base64,[A-Za-z0-9+/=]+$/iu.test(value)) {
    return value;
  }
  try {
    const url = new URL(value);
    return ['https:', 'http:', 'chrome:', 'chrome-extension:'].includes(url.protocol) ? url.href : fallback;
  } catch {
    return fallback;
  }
}

// post: resolves a site icon through Chromium's extension-owned favicon endpoint
// so remote icon hosts, page CSP, and chrome://favicon URLs cannot erase identity.
export function getWebsiteIconUrl(
  pageUrl: string | undefined,
  faviconUrl: string | undefined,
  fallback: string,
  size = 32,
): string {
  const direct = getSafeImageUrl(faviconUrl, '');
  if (direct.startsWith('data:image/')) return direct;

  try {
    const page = new URL(pageUrl ?? '');
    if (['http:', 'https:', 'file:', 'chrome:', 'edge:'].includes(page.protocol)) {
      const endpoint = new URL(chrome.runtime.getURL('_favicon/'));
      endpoint.searchParams.set('pageUrl', page.href);
      endpoint.searchParams.set('size', String(Math.max(16, Math.min(64, Math.round(size)))));
      return endpoint.href;
    }
  } catch {
    // Invalid/missing page URLs may still carry a browser-provided HTTP icon.
  }

  return direct || fallback;
}

// rule: identifies browser-internal or restricted URLs (e.g. chrome://, edge://) where extensions are disabled
export function isRestrictedUrl(url: string | undefined): boolean {
  if (!url) return true;
  return RESTRICTED_URL_PREFIXES.some(prefix => url.startsWith(prefix));
}

