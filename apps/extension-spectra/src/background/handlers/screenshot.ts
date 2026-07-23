// goal: privileged, crop-verified Chrome-native screenshot pipeline without image IPC to content

import {
	SPECTRA_PROTOCOL_VERSION,
	isSpectraRequestEnvelope,
	rpcFailure,
	rpcSuccess,
	type ScreenshotCapturePayload,
	type ScreenshotResult,
} from '@nexus/contracts';
import { sendSpectraTabRequest } from '../spectra-tab-client';

function toPngDataUrl(blob: Blob): Promise<string> {
	return blob.arrayBuffer().then((buffer) => {
		const bytes = new Uint8Array(buffer);
		let binary = '';
		const chunk = 0x8000;
		for (let offset = 0; offset < bytes.length; offset += chunk) {
			binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk));
		}
		return `data:image/png;base64,${btoa(binary)}`;
	});
}

async function waitForDownloadComplete(downloadId: number): Promise<void> {
	let finish!: (error?: string) => void;
	const completion = new Promise<void>((resolve, reject) => {
		const timeoutId = setTimeout(() => {
			chrome.downloads.onChanged.removeListener(onChanged);
			reject(new Error('Screenshot download completion timed out'));
		}, 30_000);
		finish = (error?: string): void => {
			clearTimeout(timeoutId);
			chrome.downloads.onChanged.removeListener(onChanged);
			if (error) reject(new Error(error));
			else resolve();
		};
		const onChanged = (delta: chrome.downloads.DownloadDelta): void => {
			if (delta.id !== downloadId) return;
			if (delta.error?.current) finish(delta.error.current);
			else if (delta.state?.current === 'interrupted') finish('Screenshot download was interrupted');
			else if (delta.state?.current === 'complete') finish();
		};
		chrome.downloads.onChanged.addListener(onChanged);
	});
	// Register first, then inspect current state. A fast download can complete
	// between `download()` and `search()`; this ordering cannot miss the event.
	const [existing] = await chrome.downloads.search({ id: downloadId });
	if (existing?.state === 'complete') finish();
	else if (existing?.state === 'interrupted') {
		finish(existing.error ?? 'Screenshot download was interrupted');
	}
	await completion;
}

async function assertSameVisibleTab(tab: chrome.tabs.Tab): Promise<void> {
	const [active] = await chrome.tabs.query({ active: true, windowId: tab.windowId });
	if (!active?.id || active.id !== tab.id || active.windowId !== tab.windowId) {
		throw new Error('The active visible tab changed during screenshot capture');
	}
}

async function captureAndSave(
	tab: chrome.tabs.Tab,
	payload: ScreenshotCapturePayload,
	verifyTarget: () => Promise<void>,
): Promise<ScreenshotResult> {
	if (!tab.id || tab.windowId === undefined || !tab.active) {
		throw new Error('Screenshot capture requires the active visible tab');
	}
	await assertSameVisibleTab(tab);
	await verifyTarget();
	const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
	await assertSameVisibleTab(tab);
	await verifyTarget();
	const bitmap = await createImageBitmap(await (await fetch(dataUrl)).blob());
	try {
		const { rect } = payload;
		const scaleX = bitmap.width / rect.viewportWidth;
		const scaleY = bitmap.height / rect.viewportHeight;
		const sourceX = Math.max(0, Math.round(rect.x * scaleX));
		const sourceY = Math.max(0, Math.round(rect.y * scaleY));
		const sourceWidth = Math.min(bitmap.width - sourceX, Math.max(1, Math.round(rect.width * scaleX)));
		const sourceHeight = Math.min(bitmap.height - sourceY, Math.max(1, Math.round(rect.height * scaleY)));
		if (sourceWidth <= 0 || sourceHeight <= 0) throw new Error('Active video is outside the captured viewport');

		const canvas = new OffscreenCanvas(sourceWidth, sourceHeight);
		const context = canvas.getContext('2d');
		if (!context) throw new Error('Screenshot crop canvas is unavailable');
		context.drawImage(
			bitmap,
			sourceX,
			sourceY,
			sourceWidth,
			sourceHeight,
			0,
			0,
			sourceWidth,
			sourceHeight,
		);
		const pngUrl = await toPngDataUrl(await canvas.convertToBlob({ type: 'image/png' }));
		const downloadId = await chrome.downloads.download({
			url: pngUrl,
			filename: `spectra/screenshot-${Date.now()}.png`,
			saveAs: false,
		});
		if (downloadId === undefined) throw new Error('Chrome rejected the screenshot download');
		await waitForDownloadComplete(downloadId);
		return {
			saved: true,
			method: 'capture-visible-tab',
			width: sourceWidth,
			height: sourceHeight,
		};
	} finally {
		bitmap.close();
	}
}

export function registerScreenshotHandler(): void {
	chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
		if (!message || typeof message !== 'object') return false;
		const candidate = message as { protocolVersion?: unknown; type?: unknown };
		if (candidate.protocolVersion !== SPECTRA_PROTOCOL_VERSION
			|| candidate.type !== 'spectra.screenshot.capture-visible') return false;
		if (sender.id && sender.id !== chrome.runtime.id) {
			sendResponse(rpcFailure('forbidden', 'Screenshot capture is extension-internal only'));
			return false;
		}
		if (!isSpectraRequestEnvelope(message)
			|| message.type !== 'spectra.screenshot.capture-visible'
			|| !sender.tab
			|| !message.documentId
			|| !Number.isSafeInteger(message.generation)
			|| message.generation! < 0
			|| sender.documentId !== message.documentId) {
			sendResponse(rpcFailure('invalid_request', 'Screenshot capture requires a valid sender tab'));
			return false;
		}
		const verifyTarget = async (): Promise<void> => {
			const response = await sendSpectraTabRequest(
				sender.tab!.id!,
				'spectra.screenshot.target.verify',
				{ captureToken: message.payload.captureToken },
				{ documentId: message.documentId, generation: message.generation },
			);
			if (!response.ok || response.data.valid !== true) {
				throw new Error(response.ok
					? 'The screenshot target could not be verified'
					: response.error.message);
			}
		};
		void captureAndSave(sender.tab, message.payload, verifyTarget).then(
			(result) => sendResponse(rpcSuccess(result)),
			(error) => sendResponse(rpcFailure(
				'screenshot_capture_failed',
				error instanceof Error ? error.message : String(error),
				true,
			)),
		);
		return true;
	});
}

export const screenshotHandlerTestApi = { captureAndSave };
