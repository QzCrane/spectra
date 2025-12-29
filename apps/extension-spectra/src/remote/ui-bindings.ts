/**
 * SPECTRA Remote - Popup UI Bindings
 *
 * Communicates with background to display remote control modal.
 * Each tab uses independent session.
 */

import { generateRemoteQR } from './qr-generator.js';
import { Actions } from '@nexus/contracts';
import { renderRemoteModal, closeRemoteModal, isRemoteModalOpen, setRemoteI18n } from './modal-renderer.js';
import type { I18NDict } from '../popup/types';

const REMOTE_HOST = 'https://nexus-remote.pages.dev';

let currentDict: I18NDict | null = null;
let currentTabId: number | null = null;
let statusCheckInterval: number | null = null;
let isConnected = false;

export function bindRemoteUI(tabId: number, dict?: I18NDict): void {
	currentTabId = tabId;

	if (dict) {
		currentDict = dict;
		setRemoteI18n(dict);
	}

	const btnRemote = document.getElementById('btn-remote');
	if (btnRemote) {
		btnRemote.addEventListener('click', toggleRemoteModal);
	}

	startStatusCheck();
}

export function updateRemoteI18n(dict: I18NDict): void {
	currentDict = dict;
	setRemoteI18n(dict);
	const btnRemote = document.getElementById('btn-remote');
	if (btnRemote) {
		if (isConnected) {
			btnRemote.title = dict.remoteConnectedTooltip;
		} else {
			btnRemote.title = dict.btnRemoteTooltip;
		}
	}
}

export function isRemoteConnected(): boolean {
	return isConnected;
}

function startStatusCheck(): void {
	if (statusCheckInterval) return;

	checkAndUpdateStatus();

	// Check every 3s
	statusCheckInterval = window.setInterval(checkAndUpdateStatus, 3000);
}

async function checkAndUpdateStatus(): Promise<void> {
	const btnRemote = document.getElementById('btn-remote');
	if (!btnRemote || !currentTabId) return;

	try {
		const res = await chrome.runtime.sendMessage({
			action: Actions.REMOTE_GET_SESSION,
			tabId: currentTabId,
		});

		if (res?.connected) {
			isConnected = true;
			btnRemote.classList.add('remote-connected');
			if (currentDict) btnRemote.title = currentDict.remoteConnectedTooltip;
		} else {
			isConnected = false;
			btnRemote.classList.remove('remote-connected');
			if (currentDict) btnRemote.title = currentDict.btnRemoteTooltip;
		}
	} catch {
		isConnected = false;
		btnRemote.classList.remove('remote-connected');
	}
}

async function toggleRemoteModal(): Promise<void> {
	if (isRemoteModalOpen()) {
		closeRemoteModal();
		return;
	}

	if (!currentTabId) {
		console.error('[SPECTRA Remote] tabId uninit');
		return;
	}

	const btnRemote = document.getElementById('btn-remote');
	if (btnRemote) {
		btnRemote.classList.add('loading');
		btnRemote.textContent = '⏳';
	}

	try {
		const existingSession = await chrome.runtime.sendMessage({
			action: Actions.REMOTE_GET_SESSION,
			tabId: currentTabId,
		});

		if (existingSession?.session) {
			const qrDataUrl = await generateRemoteQR(existingSession.session.sessionId, REMOTE_HOST);
			renderRemoteModal(qrDataUrl, existingSession.session.sessionId, existingSession.connected);
			return;
		}

		const response = await chrome.runtime.sendMessage({
			action: Actions.REMOTE_CREATE_SESSION,
			tabId: currentTabId,
		});

		if (!response?.success) {
			console.error('[SPECTRA Remote] Create session failed:', response?.error);
			return;
		}

		const { session } = response;
		const qrDataUrl = await generateRemoteQR(session.sessionId, REMOTE_HOST);

		renderRemoteModal(qrDataUrl, session.sessionId, false);
	} catch (err) {
		console.error('[SPECTRA Remote] Init failed:', err);
	} finally {
		if (btnRemote) {
			btnRemote.classList.remove('loading');
			btnRemote.textContent = '📱';
		}
	}
}
