// goal: manages the lifecycle and visibility of the advanced settings side panel in the popup

import type { AudioConfig } from '@nexus/kernel';
import { bindSidePanelControls, syncSidePanelState } from './controls';
import { bindVideoControls, setVideoControlTabId } from './video-controls';
import { bindFooterActions } from './footer-actions';
import { getCardRegistration as getCardReg, updateCardConfig as updateReg } from './registry';
import { safeStorageGet, safeStorageSet } from '../../shared/safe-storage';

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

	elements.btnPin?.addEventListener('click', async () => {
		state.isPinned = !state.isPinned;
		elements?.btnPin.classList.toggle('active', state.isPinned);
		await safeStorageSet({ sidePanelPinned: state.isPinned });
	});

	elements.btnClose?.addEventListener('click', () => closeSidePanel());

	// rule: auto-dismiss panel on outside clicks ONLY if the pinning toggle is inactive
	document.addEventListener('click', (e) => {
		if (!state.isOpen || state.isPinned) return;
		const target = e.target as HTMLElement;
		if (!elements?.panel.contains(target) && !target.closest('.meta-icon')) {
			closeSidePanel();
		}
	});

	safeStorageGet<{ sidePanelPinned?: boolean }>(['sidePanelPinned'], {}).then(result => {
		state.isPinned = result.sidePanelPinned ?? false;
		elements?.btnPin.classList.toggle('active', state.isPinned);
	});

	bindFooterActions();
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

	iconEl.addEventListener('click', (e) => {
		e.stopPropagation();
		if (state.isOpen && state.currentTabId === tabId) {
			closeSidePanel();
		} else {
			openSidePanel(tabId, tabTitle, faviconUrl);
		}
	});
}

// eff: slides in the advanced panel and binds controls to the target tab's update handle
function openSidePanel(tabId: number, title: string, faviconUrl: string): void {
	if (!elements) return;
	state.isOpen = true;
	state.currentTabId = tabId;

	elements.icon.src = faviconUrl || '';
	elements.title.textContent = title || 'Settings';

	document.documentElement.classList.add('side-panel-open');

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
}

// eff: slides out the panel and cleans up transition classes after the CSS animation completes
function closeSidePanel(): void {
	if (!elements) return;
	state.isOpen = false;
	state.currentTabId = null;

	elements.panel.classList.remove('open');

	// note: 200ms delay matches the CSS transition-duration defined in popup.css
	setTimeout(() => {
		document.documentElement.classList.remove('side-panel-open');
	}, 200);
}

export function getCurrentPanelTabId(): number | null {
	return state.currentTabId;
}

export function isSidePanelOpen(): boolean {
	return state.isOpen;
}
