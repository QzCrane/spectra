// goal: manages the lifecycle and visibility of the advanced settings side panel in the popup

import type { AudioConfig } from '@nexus/kernel';
import { isSpectraUiEventEnvelope } from '@nexus/contracts/ui-runtime';
import { bindSidePanelControls, syncSidePanelState } from './controls';
import { bindVideoControls, setVideoControlTabId, syncVideoControlSnapshot } from './video-controls';
import { bindFooterActions } from './footer-actions';
import { getCardRegistration as getCardReg, updateCardConfig as updateReg } from './registry';
import { getSafeImageUrl } from '../utils/dom';
import { sendSpectraRequest } from '../../shared/ui-spectra-client';

export { registerCard, getCardRegistration } from './registry';

interface SidePanelState {
	isOpen: boolean;
	isPinned: boolean;
	currentTabId: number | null;
}

interface SidePanelElements {
	panel: HTMLElement;
	icon: HTMLImageElement;
	title: HTMLElement;
	btnPin: HTMLElement;
	btnClose: HTMLElement;
}

const state: SidePanelState = {
	isOpen: false,
	isPinned: false,
	currentTabId: null,
};

let elements: SidePanelElements | null = null;
let lastTrigger: HTMLElement | null = null;
let closeAnimationTimer: ReturnType<typeof setTimeout> | null = null;
let snapshotListenerInstalled = false;

// eff: updates the internal registry and refreshes the panel UI if it's currently focused on the modified tab
export function updateCardConfig(tabId: number, config: AudioConfig): void {
	updateReg(tabId, config);
	if (state.isOpen && state.currentTabId === tabId) {
		syncSidePanelState(config);
	}
}

// goal: initializes panel DOM references and global event listeners for pinning and dismissal
export function initSidePanel(): void {
	const panel = document.getElementById('side-panel');
	if (!panel) return;

	elements = {
		panel,
		icon: panel.querySelector('.side-panel-icon') as HTMLImageElement,
		title: panel.querySelector('.side-panel-title') as HTMLElement,
		btnPin: panel.querySelector('.btn-pin') as HTMLElement,
		btnClose: panel.querySelector('.btn-close-panel') as HTMLElement,
	};

	elements.btnPin?.addEventListener('click', () => {
		state.isPinned = !state.isPinned;
		elements?.btnPin.classList.toggle('active', state.isPinned);
		elements?.btnPin.setAttribute('aria-pressed', String(state.isPinned));
	});
	elements.btnPin?.setAttribute('aria-pressed', String(state.isPinned));

	elements.btnClose?.addEventListener('click', () => closeSidePanel());
	document.addEventListener('keydown', (event) => {
		if (event.key === 'Escape' && state.isOpen) {
			event.preventDefault();
			closeSidePanel();
		}
	});
	setPanelAccessibility(false);
	panel.hidden = true;

	// rule: auto-dismiss panel on outside clicks ONLY if the pinning toggle is inactive
	document.addEventListener('click', (e) => {
		if (!state.isOpen || state.isPinned) return;
		const target = e.target as HTMLElement;
		if (!elements?.panel.contains(target) && !target.closest('.meta-icon')) {
			closeSidePanel();
		}
	});

	bindFooterActions();
	if (!snapshotListenerInstalled) {
		snapshotListenerInstalled = true;
		chrome.runtime.onMessage.addListener((message: unknown) => {
			if (!state.isOpen || !isSpectraUiEventEnvelope(message)
				|| message.type !== 'spectra.control.snapshot.changed'
				|| message.payload.tabId !== state.currentTabId) return false;
			syncVideoControlSnapshot(message.payload);
			const speed = message.payload.fields.speed?.actual;
			if (typeof speed === 'number' && state.currentTabId !== null) {
				const registration = getCardReg(state.currentTabId);
				if (registration) {
					const config = { ...registration.getConfig(), speed };
					updateReg(state.currentTabId, config);
					syncSidePanelState(config);
				}
			}
			return false;
		});
	}
}

// eff: attaches a toggle listener to a card icon to open/close advanced settings for that specific tab
export function bindCardIconClick(
	iconEl: HTMLElement,
	tabId: number,
	tabTitle: string,
	faviconUrl: string,
	i18nTitle?: string
): void {
	iconEl.style.cursor = 'pointer';
	iconEl.title = i18nTitle || 'Click for advanced settings';
	iconEl.tabIndex = 0;
	iconEl.setAttribute('role', 'button');
	iconEl.setAttribute('aria-label', `${i18nTitle || 'Open advanced settings'} for ${tabTitle || 'this tab'}`);
	iconEl.setAttribute('aria-expanded', 'false');
	iconEl.setAttribute('aria-controls', 'side-panel');

	const toggle = (e: Event) => {
		e.stopPropagation();
		if (state.isOpen && state.currentTabId === tabId) {
			closeSidePanel();
		} else {
			lastTrigger?.setAttribute('aria-expanded', 'false');
			lastTrigger = iconEl;
			iconEl.setAttribute('aria-expanded', 'true');
			openSidePanel(tabId, tabTitle, faviconUrl);
		}
	};
	iconEl.addEventListener('click', toggle);
	iconEl.addEventListener('keydown', (event) => {
		if (event.key === 'Enter' || event.key === ' ') {
			event.preventDefault();
			toggle(event);
		}
	});
}

// eff: slides in the advanced panel and binds controls to the target tab's update handle
function openSidePanel(tabId: number, title: string, faviconUrl: string): void {
	if (!elements) return;
	if (closeAnimationTimer) {
		clearTimeout(closeAnimationTimer);
		closeAnimationTimer = null;
	}
	state.isOpen = true;
	state.currentTabId = tabId;

	elements.icon.src = getSafeImageUrl(faviconUrl, chrome.runtime.getURL('icons/icon48.png'));
	elements.title.textContent = title || 'Settings';

	elements.panel.hidden = false;
	document.documentElement.classList.add('side-panel-open');
	setPanelAccessibility(true);

	// note: double requestAnimationFrame ensures the 'side-panel-open' layout shift is committed before the 'open' transform starts
	requestAnimationFrame(() => {
		requestAnimationFrame(() => {
			elements?.panel.classList.add('open');
		});
	});

	const reg = getCardReg(tabId);
	if (reg) {
		bindSidePanelControls(reg.getConfig(), reg.update, tabId);
	}

	setVideoControlTabId(tabId);
	bindVideoControls();
	void sendSpectraRequest('spectra.control.snapshot.get', { tabId }, { tabId })
		.then((response) => {
			if (response.ok && response.data && state.isOpen && state.currentTabId === tabId) {
				syncVideoControlSnapshot(response.data);
			}
		})
		.catch(() => undefined);
}

// eff: slides out the panel and cleans up transition classes after the CSS animation completes
function closeSidePanel(): void {
	if (!elements) return;
	state.isOpen = false;
	state.currentTabId = null;
	lastTrigger?.setAttribute('aria-expanded', 'false');
	setPanelAccessibility(false);
	lastTrigger?.focus();

	elements.panel.classList.remove('open');

	// note: 200ms delay matches the CSS transition-duration defined in popup.css
	if (closeAnimationTimer) clearTimeout(closeAnimationTimer);
	closeAnimationTimer = setTimeout(() => {
		document.documentElement.classList.remove('side-panel-open');
		if (elements && !state.isOpen) elements.panel.hidden = true;
		closeAnimationTimer = null;
	}, 200);
}

function setPanelAccessibility(open: boolean): void {
	const panel = elements?.panel;
	if (!panel) return;
	panel.setAttribute('aria-hidden', String(!open));
	panel.toggleAttribute('inert', !open);
}

export function getCurrentPanelTabId(): number | null {
	return state.currentTabId;
}

export function isSidePanelOpen(): boolean {
	return state.isOpen;
}
