// goal: manages the reset and persistence of advanced effect presets (EQ, Pan, Delay) in the side panel

import { DEFAULT_AUDIO_CONFIG } from '@nexus/kernel';
import { getCurrentPanelTabId, getCardRegistration } from './index';
import { syncSidePanelState } from './controls';
import { patchSettings } from '../../shared/settings-client';

export function bindFooterActions(): void {
	const btnReset = document.querySelector('.sp-btn-reset') as HTMLButtonElement | null;
	const btnSave = document.querySelector('.sp-btn-save') as HTMLButtonElement | null;

	btnReset?.addEventListener('click', handleReset);
	btnSave?.addEventListener('click', handleSave);
}

// eff: reverts the side panel's effect settings to factory defaults while preserving the current tab's volume level
function handleReset(): void {
	const tabId = getCurrentPanelTabId();
	if (tabId === null) return;

	const reg = getCardRegistration(tabId);
	if (!reg) return;

	const resetValues = {
		eqValues: [...DEFAULT_AUDIO_CONFIG.eqValues],
		pan: DEFAULT_AUDIO_CONFIG.pan,
		delay: DEFAULT_AUDIO_CONFIG.delay,
	};

	reg.update(resetValues);

	const newConfig = { ...reg.getConfig(), ...resetValues };
	syncSidePanelState(newConfig);
}

// eff: captures only the effect-related values from the current tab and saves them as a domain-specific preset
async function handleSave(): Promise<void> {
	const tabId = getCurrentPanelTabId();
	if (tabId === null) return;

	const reg = getCardRegistration(tabId);
	if (!reg) return;

	const domain = await getDomainForTab(tabId);
	if (!domain) return;

	const config = reg.getConfig();
	// rule: exclude persistent volume/mute state to prevent jarring jumps when presets are reused across sessions
	const fxPreset = {
		eqValues: config.eqValues,
		pan: config.pan,
		delay: config.delay,
	};

	await patchSettings({
		scope: 'audio-site',
		domain,
		value: fxPreset,
		mode: 'merge',
	});
}

async function getDomainForTab(tabId: number): Promise<string | null> {
	try {
		const tab = await chrome.tabs.get(tabId);
		if (!tab?.url) return null;
		return new URL(tab.url).hostname;
	} catch {
		return null;
	}
}
