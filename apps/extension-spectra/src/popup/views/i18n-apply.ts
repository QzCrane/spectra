// goal: orchestrates the live application of internationalized strings across the popup's static and dynamic elements

import type { I18NDict } from '../types';
import { $$ } from '../utils/dom';
import { getDict } from '../constants';

// eff: iterates through all elements with data-i18n attributes and replaces their text/titles/placeholders with localized strings
export function applyLang(lang: string): I18NDict {
	const dict = getDict(lang);
	if (!dict) return getDict('en-US')!;

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
		if (typeof value === 'string') {
			el.title = value;
		}
	});

	$$<HTMLInputElement>('[data-i18n-placeholder]').forEach((el) => {
		const key = el.dataset.i18nPlaceholder as keyof I18NDict;
		const value = dict[key];
		if (typeof value === 'string') {
			el.placeholder = value;
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
		if (btnSave) btnSave.title = dict.saveTooltip;
		if (btnReset) btnReset.title = dict.resetTooltip;

		const btnPause = card.querySelector('.btn-pause') as HTMLElement | null;
		const btnPip = card.querySelector('.btn-pip') as HTMLElement | null;
		const btnHotkey = card.querySelector('.btn-hotkey-target') as HTMLElement | null;
		const btnGotoTab = card.querySelector('.btn-goto-tab') as HTMLElement | null;
		if (btnPause) btnPause.title = dict.btnPause;
		if (btnPip) btnPip.title = dict.btnPip;
		if (btnHotkey) btnHotkey.title = dict.btnHotkeyTarget;
		if (btnGotoTab) btnGotoTab.title = dict.btnGotoTab;

		const metaIcon = card.querySelector('.meta-icon') as HTMLElement | null;
		if (metaIcon) metaIcon.title = dict.tipAdvancedSettings;

		const maskText = card.querySelector('.sleep-text') as HTMLElement | null;
		if (maskText) {
			maskText.innerHTML = `<div>${dict.paused}</div><div style="font-size:11px; opacity:0.7; margin-top:4px; font-weight:400;">${dict.clickToResume}</div>`;
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
		btnReset.textContent = dict.spResetFx;
		btnReset.title = dict.spResetFxTip;
	}
	if (btnSave) {
		btnSave.textContent = dict.spSaveFx;
		btnSave.title = dict.spSaveFxTip;
	}

	const btnPin = panel.querySelector('.btn-pin') as HTMLElement | null;
	const btnClose = panel.querySelector('.btn-close-panel') as HTMLElement | null;
	if (btnPin) btnPin.title = dict.tipPinPanel;
	if (btnClose) btnClose.title = dict.tipClose;
}
