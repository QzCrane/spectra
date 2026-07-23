/**
 * SPECTRA Remote - Popup UI Bindings
 *
 * Communicates with background to display remote control modal.
 * Each tab uses independent session.
 */

import { generateRemoteQR } from './qr-generator.js';
import { renderRemoteModal, closeRemoteModal, isRemoteModalOpen, setRemoteI18n } from './modal-renderer.js';
import type { I18NDict } from '../popup/types';
import { isRemotePairing } from './protocol';
import { sendSpectraRequest } from '../shared/ui-spectra-client';
import { isSpectraUiEventEnvelope } from '@nexus/contracts/ui-runtime';

let currentDict: I18NDict | null = null;
let currentTabId: number | null = null;
let currentSessionId: string | null = null;
let isConnected = false;
let disposeBindings: (() => void) | null = null;
let sessionRevision = 0;

export function bindRemoteUI(tabId: number, dict?: I18NDict): () => void {
	disposeBindings?.();
	currentTabId = tabId;
	sessionRevision += 1;

	if (dict) {
		currentDict = dict;
		setRemoteI18n(dict);
	}

	const btnRemote = document.getElementById('btn-remote');
	const clickListener = () => void toggleRemoteModal();
	if (btnRemote) {
		btnRemote.addEventListener('click', clickListener);
	}

	const messageListener = (message: unknown): false => {
		if (!isSpectraUiEventEnvelope(message)) return false;
		if (message.type === 'spectra.remote.session.changed'
			&& message.payload.tabId === currentTabId
			&& message.payload.sessionId === currentSessionId) {
			setConnected(message.payload.connected);
		} else if (message.type === 'spectra.remote.session.closed'
			&& message.payload.tabId === currentTabId
			&& message.payload.sessionId === currentSessionId) {
			currentSessionId = null;
			setConnected(false);
		}
		return false;
	};
	chrome.runtime.onMessage.addListener(messageListener);
	void refreshRemoteStatus();

	const cleanup = () => {
		btnRemote?.removeEventListener('click', clickListener);
		chrome.runtime.onMessage.removeListener(messageListener);
		if (disposeBindings === cleanup) {
			closeRemoteModal(false);
			disposeBindings = null;
			currentTabId = null;
			currentSessionId = null;
			isConnected = false;
			sessionRevision += 1;
		}
	};
	disposeBindings = cleanup;
	return cleanup;
}

export function updateRemoteI18n(dict: I18NDict): void {
	currentDict = dict;
	setRemoteI18n(dict);
	const btnRemote = document.getElementById('btn-remote');
	if (btnRemote) setRemoteButtonLabel(btnRemote, isConnected);
}

export function isRemoteConnected(): boolean {
	return isConnected;
}

async function refreshRemoteStatus(): Promise<void> {
	const btnRemote = document.getElementById('btn-remote');
	const tabId = currentTabId;
	const revision = sessionRevision;
	if (!btnRemote || tabId === null) return;

	try {
		const response = await sendSpectraRequest(
			'spectra.remote.session.get',
			{ tabId },
			{ tabId },
		);
		if (currentTabId !== tabId || sessionRevision !== revision) return;
		if (!response.ok) throw new Error(response.error.message);
		currentSessionId = isRemotePairing(response.data.session) ? response.data.session.sessionId : null;
		setConnected(response.data.connected);
	} catch {
		if (currentTabId === tabId && sessionRevision === revision) setConnected(false);
	}
}

function setConnected(connected: boolean): void {
	isConnected = connected;
	const btnRemote = document.getElementById('btn-remote');
	if (!btnRemote) return;
	btnRemote.classList.toggle('remote-connected', connected);
	setRemoteButtonLabel(btnRemote, connected);
}

function setRemoteButtonLabel(button: HTMLElement, connected: boolean): void {
	const candidate = connected ? currentDict?.remoteConnectedTooltip : currentDict?.btnRemoteTooltip;
	const label = typeof candidate === 'string' && candidate.trim().length > 0
		? candidate
		: connected ? 'Remote Connected' : 'Remote Control';
	button.title = label;
	button.setAttribute('aria-label', label);
}

async function toggleRemoteModal(): Promise<void> {
	if (isRemoteModalOpen()) {
		closeRemoteModal();
		return;
	}

	if (currentTabId === null) {
		console.error('[SPECTRA Remote] tabId uninit');
		return;
	}
	const tabId = currentTabId;
	const revision = ++sessionRevision;

	const btnRemote = document.getElementById('btn-remote');
	if (btnRemote) {
		btnRemote.classList.add('loading');
		btnRemote.textContent = '⏳';
	}

	try {
		const existingResponse = await sendSpectraRequest(
			'spectra.remote.session.get',
			{ tabId },
			{ tabId },
		);
		if (currentTabId !== tabId || sessionRevision !== revision) return;
		if (!existingResponse.ok) throw new Error(existingResponse.error.message);
		const existingSession = existingResponse.data;

		if (isRemotePairing(existingSession?.session)) {
			currentSessionId = existingSession.session.sessionId;
			setConnected(existingSession.connected === true);
			const qrDataUrl = await generateRemoteQR(existingSession.session);
			if (currentTabId !== tabId || sessionRevision !== revision || currentSessionId !== existingSession.session.sessionId) return;
			renderRemoteModal(qrDataUrl, existingSession.session, tabId, isConnected);
			return;
		}

		const response = await sendSpectraRequest(
			'spectra.remote.session.create',
			{ tabId },
			{ tabId },
		);
		if (currentTabId !== tabId || sessionRevision !== revision) return;

		if (!response.ok || !isRemotePairing(response.data)) {
			console.error('[SPECTRA Remote] Create session failed:', response.ok ? 'invalid session' : response.error);
			return;
		}

		const session = response.data;
		currentSessionId = session.sessionId;
		setConnected(false);
		const qrDataUrl = await generateRemoteQR(session);
		if (currentTabId !== tabId || sessionRevision !== revision || currentSessionId !== session.sessionId) return;
		renderRemoteModal(qrDataUrl, session, tabId, isConnected);
	} catch (err) {
		console.error('[SPECTRA Remote] Init failed:', err);
	} finally {
		if (btnRemote) {
			btnRemote.classList.remove('loading');
			btnRemote.textContent = '📱';
		}
	}
}
