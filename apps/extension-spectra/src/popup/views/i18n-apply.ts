// goal: orchestrates the live application of internationalized strings across the popup's static and dynamic elements

import type { I18NDict } from '../types';
import { $$ } from '../utils/dom';
import { getPopupDictionary } from '../../shared/i18n/catalog';

// perf: cache current dictionary for access from other modules
let currentDictCache: I18NDict | null = null;

// eff: gets the current i18n dictionary
export function getCurrentDict(): I18NDict | null {
	return currentDictCache;
}

// eff: iterates through all elements with data-i18n attributes and replaces their text/titles/placeholders with localized strings
export function applyLang(lang: string): I18NDict {
	const dict = getPopupDictionary(lang);
	currentDictCache = dict;
	document.documentElement.lang = lang;

	$$<HTMLElement>('[data-i18n]').forEach((el) => {
		const key = el.dataset.i18n as keyof I18NDict;
		const value = dict[key];
		if (typeof value === 'string') {
			el.innerText = value;
		}
	});

	$$<HTMLElement>('[data-i18n-title]').forEach((el) => {
		const key = el.dataset.i18nTitle as keyof I18NDict;
		const value = dict[key];
		setInteractiveLabel(el, value, el.title || el.getAttribute('aria-label') || 'Action');
	});

	$$<HTMLInputElement>('[data-i18n-placeholder]').forEach((el) => {
		const key = el.dataset.i18nPlaceholder as keyof I18NDict;
		const value = dict[key];
		if (typeof value === 'string') {
			el.placeholder = value;
		}
	});

	// eff: apply localized aria-label / title for elements that carry an
	// explicit data-i18n-aria attribute. Static markup previously hard-coded
	// English aria-labels (registry inputs, preset search, etc.) which broke
	// screen-reader output under non-English locales.
	$$<HTMLElement>('[data-i18n-aria]').forEach((el) => {
		const key = el.dataset.i18nAria as keyof I18NDict;
		const value = dict[key];
		if (typeof value === 'string' && value.trim().length > 0) {
			el.setAttribute('aria-label', value);
			el.title = value;
		}
	});

	return dict;
}

// goal: updates text/tooltips for dynamically generated tab cards and side panel components
export function updateCardsI18n(dict: I18NDict, vizEnabled: boolean): void {
	$$<HTMLElement>('.glass-card').forEach((card) => {
		const keys: Array<keyof I18NDict> = ['comp', 'bass', 'mono', 'eqTitle'];
		keys.forEach((k) => {
			const el = card.querySelector(`[data-i18n="${k}"]`);
			const value = dict[k];
			if (el && typeof value === 'string') el.textContent = value;
		});

		const btnSave = card.querySelector('.btn-save') as HTMLElement | null;
		const btnReset = card.querySelector('.btn-reset') as HTMLElement | null;
		const btnSaveGlobal = card.querySelector('.btn-save-global') as HTMLElement | null;
		setInteractiveLabel(btnSave, dict.saveTooltip, 'Save');
		setInteractiveLabel(btnReset, dict.resetTooltip, 'Reset');
		setInteractiveLabel(btnSaveGlobal, dict.btnSaveAsGlobal, 'Save as Global Preset');

		const btnPause = card.querySelector('.btn-pause') as HTMLElement | null;
		const btnMute = card.querySelector('.btn-mute') as HTMLElement | null;
		const btnPip = card.querySelector('.btn-pip') as HTMLElement | null;
		const btnHotkey = card.querySelector('.btn-hotkey-target') as HTMLElement | null;
		const btnGotoTab = card.querySelector('.btn-goto-tab') as HTMLElement | null;
		setInteractiveLabel(btnPause, dict.btnPause, 'Pause/Play');
		setInteractiveLabel(btnMute, dict.btnMute, 'Mute');
		setInteractiveLabel(btnPip, dict.btnPip, 'Picture-in-Picture');
		setInteractiveLabel(btnHotkey, dict.btnHotkeyTarget, 'Hotkey Target');
		setInteractiveLabel(btnGotoTab, dict.btnGotoTab, 'Go to Tab');

		const metaIcon = card.querySelector('.meta-icon') as HTMLElement | null;
		if (metaIcon) metaIcon.title = dict.tipAdvancedSettings;

		const maskText = card.querySelector('.sleep-text') as HTMLElement | null;
		if (maskText) {
			const paused = document.createElement('div');
			paused.textContent = dict.paused;
			const resume = document.createElement('div');
			resume.className = 'sleep-resume-hint';
			resume.textContent = dict.clickToResume;
			maskText.replaceChildren(paused, resume);
		}

		const vizIsland = card.querySelector('.viz-island') as HTMLElement | null;
		if (vizIsland) {
			vizIsland.classList.toggle('hidden', !vizEnabled);
		}
	});

	updateSidePanelI18n(dict);
}

// eff: updates localized text/tooltips for the slide-out side panel (Settings / Registry)
function updateSidePanelI18n(dict: I18NDict): void {
	const panel = document.getElementById('side-panel');
	if (!panel) return;

	const btnReset = panel.querySelector('.sp-btn-reset') as HTMLElement | null;
	const btnSave = panel.querySelector('.sp-btn-save') as HTMLElement | null;
	if (btnReset) {
		if (typeof dict.spResetFx === 'string') btnReset.textContent = dict.spResetFx;
		setInteractiveLabel(btnReset, dict.spResetFxTip, 'Reset effects');
	}
	if (btnSave) {
		if (typeof dict.spSaveFx === 'string') btnSave.textContent = dict.spSaveFx;
		setInteractiveLabel(btnSave, dict.spSaveFxTip, 'Save effects');
	}

	const btnPin = panel.querySelector('.btn-pin') as HTMLElement | null;
	const btnClose = panel.querySelector('.btn-close-panel') as HTMLElement | null;
	setInteractiveLabel(btnPin, dict.tipPinPanel, 'Pin Panel');
	setInteractiveLabel(btnClose, dict.tipClose, 'Close');
}

function setInteractiveLabel(element: HTMLElement | null, value: unknown, fallback: string): void {
	if (!element) return;
	const label = typeof value === 'string' && value.trim().length > 0 ? value : fallback;
	element.title = label;
	element.setAttribute('aria-label', label);
}
