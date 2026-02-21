// goal: binds secondary media control UI elements to content script commands for playback and focus management

import type { AudioConfig } from '@nexus/kernel';
import type { CardUIElements } from '../types';
import { sendToTab } from '../utils/dom';
import { syncSidePanelSpeed } from '../side-panel/controls';
import { safeStorageGet, safeStorageSet } from '../../shared/safe-storage';

const PAUSE_SVG = '<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>';
const PLAY_SVG = '<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';

// eff: attaches click and input handlers to playback buttons, speed controls, and tab-focus utilities
// note: speed controls now use unified update flow through onSpeedChange callback
export function bindMediaControls(ui: CardUIElements, tabId: number, update?: (changes: Partial<AudioConfig>) => void): void {
	if (ui.btnPause) {
		ui.btnPause.onclick = async () => {
			const res = await sendToTab<{ playing: boolean }>(tabId, 'MEDIA_TOGGLE_PLAY', {});
			if (res && ui.btnPause) {
				ui.btnPause.innerHTML = res.playing ? PAUSE_SVG : PLAY_SVG;
			}
		};
	}

	if (ui.btnPip) {
		ui.btnPip.onclick = async () => {
			const res = await sendToTab<{ active: boolean }>(tabId, 'MEDIA_TOGGLE_PIP', {});
			if (res && ui.btnPip) {
				ui.btnPip.classList.toggle('active', res.active);
			}
		};
	}

	// rule: speed controls use unified update flow via update callback (same as volume)
	ui.speedBtns.forEach(btn => {
		btn.onclick = () => {
			const delta = parseFloat(btn.dataset.delta || '0');
			const currentSpeed = parseFloat(ui.speedInput?.value || '1');
			// note: fix floating point precision errors (e.g. 1.1 + 0.1 = 1.2000000000000002)
			const rawSpeed = currentSpeed + delta;
			const newSpeed = Math.max(0.1, Math.min(16, Math.round(rawSpeed * 100) / 100));
			if (ui.speedInput) ui.speedInput.value = newSpeed.toFixed(2);
			syncSidePanelSpeed(newSpeed);
			update?.({ speed: newSpeed });
		};
	});

	if (ui.speedInput) {
		const handleSpeedChange = (speed: number) => {
			const clampedSpeed = Math.max(0.1, Math.min(16, speed));
			if (ui.speedInput) ui.speedInput.value = clampedSpeed.toFixed(2);
			syncSidePanelSpeed(clampedSpeed);
			update?.({ speed: clampedSpeed });
		};

		ui.speedInput.onchange = (e) => {
			const speed = parseFloat((e.target as HTMLInputElement).value) || 1;
			handleSpeedChange(speed);
		};

		ui.speedInput.onwheel = (e) => {
			e.preventDefault();
			const current = parseFloat(ui.speedInput!.value) || 1;
			const delta = e.deltaY < 0 ? 0.1 : -0.1;
			handleSpeedChange(current + delta);
		};
	}

	if (ui.btnHotkeyTarget) {
		const btn = ui.btnHotkeyTarget;

		safeStorageGet<{ hotkeyTargetTabId?: number }>(['hotkeyTargetTabId'], {}).then(result => {
			if (result.hotkeyTargetTabId === tabId) {
				btn.classList.add('active');
			}
		});

		btn.onclick = () => {
			safeStorageSet({ hotkeyTargetTabId: tabId }).then(() => {
				// note: enforce exclusive "active" state across all rendered cards in the popup
				document.querySelectorAll('.btn-hotkey-target').forEach(b => b.classList.remove('active'));
				btn.classList.add('active');
			});
		};
	}

	if (ui.btnGotoTab) {
		ui.btnGotoTab.onclick = () => {
			chrome.tabs.update(tabId, { active: true });
		};
	}
}

