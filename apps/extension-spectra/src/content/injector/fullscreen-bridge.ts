// goal: preserve native fullscreen activation while enhanced audio briefly yields the media pipeline

import {
	SPECTRA_FULLSCREEN_BRIDGE_READY_ATTRIBUTE,
	SPECTRA_FULLSCREEN_FINISH_EVENT,
	SPECTRA_FULLSCREEN_PREPARE_EVENT,
	SPECTRA_FULLSCREEN_READY_EVENT,
	SPECTRA_FULLSCREEN_REQUEST_ATTRIBUTE,
	SPECTRA_FULLSCREEN_RESULT_ATTRIBUTE,
	type SpectraFullscreenBridgeMessage,
} from '../../shared/fullscreen-bridge';

interface MainFullscreenBridgeState {
	version: 1;
}

interface MainFullscreenWindow extends Window {
	__SPECTRA_FULLSCREEN_BRIDGE_V1__?: MainFullscreenBridgeState;
}

const mainWindow = window as MainFullscreenWindow;

function decodeMessage(attribute: string): SpectraFullscreenBridgeMessage | null {
	const encoded = document.documentElement?.getAttribute(attribute);
	if (!encoded) return null;
	try {
		const value = JSON.parse(encoded) as Partial<SpectraFullscreenBridgeMessage>;
		return typeof value.requestId === 'string' && value.requestId.length > 0
			? { requestId: value.requestId }
			: null;
	} catch {
		return null;
	}
}

function waitForAudioHandoff(requestId: string): Promise<void> {
	if (document.documentElement?.getAttribute(SPECTRA_FULLSCREEN_BRIDGE_READY_ATTRIBUTE) !== 'true') {
		return Promise.resolve();
	}
	document.documentElement.setAttribute(
		SPECTRA_FULLSCREEN_REQUEST_ATTRIBUTE,
		JSON.stringify({ requestId } satisfies SpectraFullscreenBridgeMessage),
	);
	return new Promise((resolve) => {
		let settled = false;
		const finish = (): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timeoutId);
			document.removeEventListener(SPECTRA_FULLSCREEN_READY_EVENT, onReady);
			resolve();
		};
		const onReady = (): void => {
			if (decodeMessage(SPECTRA_FULLSCREEN_RESULT_ATTRIBUTE)?.requestId === requestId) finish();
		};
		const timeoutId = setTimeout(finish, 1_200);
		document.addEventListener(SPECTRA_FULLSCREEN_READY_EVENT, onReady);
		document.dispatchEvent(new Event(SPECTRA_FULLSCREEN_PREPARE_EVENT));
		onReady();
	});
}

function finishAudioHandoff(requestId: string): void {
	if (!document.documentElement) return;
	document.documentElement.setAttribute(
		SPECTRA_FULLSCREEN_REQUEST_ATTRIBUTE,
		JSON.stringify({ requestId } satisfies SpectraFullscreenBridgeMessage),
	);
	document.dispatchEvent(new Event(SPECTRA_FULLSCREEN_FINISH_EVENT));
	document.documentElement.removeAttribute(SPECTRA_FULLSCREEN_REQUEST_ATTRIBUTE);
	document.documentElement.removeAttribute(SPECTRA_FULLSCREEN_RESULT_ATTRIBUTE);
}

function wrapFullscreenMethod<K extends 'requestFullscreen' | 'webkitRequestFullscreen'>(
	method: K,
): void {
	const prototype = Element.prototype as Element & Record<K, ((options?: FullscreenOptions) => Promise<void>) | undefined>;
	const original = prototype[method];
	if (typeof original !== 'function') return;
	const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, method);
	const wrapped = function (this: Element, options?: FullscreenOptions): Promise<void> {
		const requestId = crypto.randomUUID();
		return waitForAudioHandoff(requestId)
			.then(() => Reflect.apply(original, this, options === undefined ? [] : [options]))
			.finally(() => finishAudioHandoff(requestId));
	};
	Object.defineProperty(Element.prototype, method, {
		...(descriptor ?? { configurable: true, enumerable: false, writable: true }),
		value: wrapped,
	});
}

if (!mainWindow.__SPECTRA_FULLSCREEN_BRIDGE_V1__) {
	mainWindow.__SPECTRA_FULLSCREEN_BRIDGE_V1__ = { version: 1 };
	wrapFullscreenMethod('requestFullscreen');
	wrapFullscreenMethod('webkitRequestFullscreen');
}
