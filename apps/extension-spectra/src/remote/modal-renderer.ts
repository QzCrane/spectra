/**
 * SPECTRA Remote - Modal Renderer
 * 
 * Creates/Destroys remote control modal and syncs connection status.
 */

import { Actions } from '@nexus/contracts';
import type { I18NDict } from '../popup/types';
import { getRemoteUrl } from './constants.js';

let isModalOpen = false;
let statusInterval: number | null = null;
let currentDict: I18NDict | null = null;

export const isRemoteModalOpen = () => isModalOpen;

export function setRemoteI18n(dict: I18NDict): void {
	currentDict = dict;
}

function t(key: keyof I18NDict, fallback: string): string {
	return (currentDict?.[key] as string) || fallback;
}

export function renderRemoteModal(qrDataUrl: string, sessionId: string, isConnected = false): void {
	const existing = document.getElementById('remote-modal');
	if (existing) existing.remove();

	const statusClass = isConnected ? 'connected' : '';
	const statusText = isConnected
		? t('remoteConnected', '✅ Connected')
		: t('remoteWaiting', 'Waiting for connection...');

	const modal = document.createElement('div');
	modal.id = 'remote-modal';
	modal.className = 'remote-modal';

	const remoteUrl = getRemoteUrl(sessionId);

	modal.innerHTML = `
		<div class="remote-modal-content">
			<div class="remote-modal-header">
				<span>${t('remoteModalTitle', '📱 Remote Control')}</span>
				<button class="remote-modal-close">✕</button>
			</div>
			<div class="remote-modal-body">
				<img src="${qrDataUrl}" alt="QR Code" class="remote-qr" />
				<div class="remote-session-id">
					<span>${t('remoteSessionCode', 'Session Code')}</span>
					<code>${sessionId}</code>
				</div>
				<div class="remote-url">
					<a href="${remoteUrl}" target="_blank" rel="noopener" title="${t('remoteOpenLinkTitle', 'Click to open remote in new tab')}">${remoteUrl}</a>
				</div>
				<div class="remote-status">
					<span class="remote-status-dot ${statusClass}"></span>
					<span class="remote-status-text">${statusText}</span>
				</div>
				<p class="remote-hint">${t('remoteHint', '📱 Scan QR code or copy link to connect<br>⚡ Closing this dialog won\'t disconnect')}</p>
				<button class="remote-disconnect-btn">${t('remoteDisconnect', '🔌 Disconnect & Close')}</button>
			</div>
		</div>
	`;

	document.body.appendChild(modal);
	isModalOpen = true;

	modal.querySelector('.remote-modal-close')?.addEventListener('click', () => closeRemoteModal(false));

	const codeElem = modal.querySelector('.remote-session-id code');
	codeElem?.addEventListener('click', () => {
		navigator.clipboard.writeText(sessionId);
		const oldText = codeElem.textContent;
		codeElem.textContent = t('remoteCopied', 'Copied!');
		setTimeout(() => { if (codeElem) codeElem.textContent = oldText; }, 1000);
	});

	modal.addEventListener('click', (e) => {
		if (e.target === modal) closeRemoteModal(false);
	});

	modal.querySelector('.remote-disconnect-btn')?.addEventListener('click', () => closeRemoteModal(true));

	adjustPopupHeight(true);

	statusInterval = window.setInterval(async () => {
		const res = await chrome.runtime.sendMessage({ action: Actions.REMOTE_GET_SESSION });
		const dot = modal.querySelector('.remote-status-dot');
		const text = modal.querySelector('.remote-status-text');
		if (dot && text && res) {
			if (res.connected) {
				dot.classList.add('connected');
				text.textContent = t('remoteConnected', '✅ Connected');
			} else {
				dot.classList.remove('connected');
				text.textContent = t('remoteWaiting', 'Waiting for connection...');
			}
		}
	}, 1000);
}

function adjustPopupHeight(expand: boolean): void {
	const body = document.body;
	const MIN_HEIGHT = 520;

	if (expand) {
		const currentHeight = body.offsetHeight;
		if (currentHeight < MIN_HEIGHT) {
			body.style.minHeight = `${MIN_HEIGHT}px`;
		}
	} else {
		body.style.minHeight = '';
	}
}

export function closeRemoteModal(closeConnection = false): void {
	const modal = document.getElementById('remote-modal');
	if (modal) {
		modal.remove();
		isModalOpen = false;

		if (statusInterval) {
			clearInterval(statusInterval);
			statusInterval = null;
		}

		adjustPopupHeight(false);

		if (closeConnection) {
			chrome.runtime.sendMessage({ action: Actions.REMOTE_CLOSE_SESSION });
		}
	}
}
