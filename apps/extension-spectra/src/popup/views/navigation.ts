// goal: manages transitions between the main control view and the settings panel within the popup

import { $, $required } from '../utils/dom';
import { UI_SIZES } from '../constants';
import { cardRenderCallbacks } from '../views/settings';

interface NavigationState {
  viewMain: HTMLElement;
  viewSettings: HTMLElement;
  viewContainer: HTMLElement;
}

// eff: initializes click handlers for view switching and manages container min-height during transitions
export function initNavigation(): NavigationState {
  const viewMain = $required<HTMLElement>('view-main');
  const viewSettings = $required<HTMLElement>('view-settings');
  const viewContainer = document.querySelector('.view-container') as HTMLElement;

  const btnSettings = $<HTMLElement>('btn-settings');
  const btnBack = $<HTMLElement>('btn-back');
  const btnHotkeys = $<HTMLElement>('btn-hotkeys');
	const btnShortcuts = $<HTMLElement>('btn-shortcuts');

	setViewActive(viewMain, true);
	setViewActive(viewSettings, false);

  if (btnHotkeys) {
    btnHotkeys.onclick = () => {
      chrome.runtime.openOptionsPage();
    };
  }

  if (btnShortcuts) {
    btnShortcuts.onclick = () => {
      chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
    };
  }

	if (btnSettings) {
		btnSettings.onclick = () => {
      const mainHeight = viewMain.offsetHeight;

			setViewActive(viewSettings, true);
			btnBack?.focus();
			setViewActive(viewMain, false);

      // rule: ensure the settings view has a minimum height to avoid layout collapse if the main view was very small
      if (mainHeight < UI_SIZES.SETTINGS_MIN_HEIGHT) {
        viewContainer.style.minHeight = `${UI_SIZES.SETTINGS_MIN_HEIGHT}px`;
      }
    };
  }

	if (btnBack) {
		btnBack.onclick = () => {
			setViewActive(viewMain, true);
			btnSettings?.focus();
			setViewActive(viewSettings, false);
			viewContainer.style.minHeight = '';

      // note: trigger rerender of all cards on return to main view to ensure UI state (sliders, toggles) is perfectly synced
      requestAnimationFrame(() => {
        cardRenderCallbacks.forEach((cb) => cb());
      });
    };
  }

	return { viewMain, viewSettings: viewSettings, viewContainer };
}

function setViewActive(view: HTMLElement, active: boolean): void {
	view.classList.toggle('active', active);
	view.hidden = !active;
	view.setAttribute('aria-hidden', String(!active));
	view.toggleAttribute('inert', !active);
}

