// goal: minimal document-start boundary for messages, native observations, and five defaults

import {
	SPECTRA_CONTENT_BOOTSTRAP_REVISION,
	SPECTRA_PROTOCOL_VERSION,
	bootstrapRpcFailure,
	bootstrapRpcSuccess,
	isBootstrapHelloResponse,
	isBootstrapInboundRequest,
	resolveSpectraDefaultHotkeyAction,
	type SpectraDefaultHotkeyAction,
} from '@nexus/contracts/bootstrap';
import {
	getContentBootstrapState,
	requiresContentRuntime,
	setContentBootstrapState,
	type ContentBootstrapState,
} from '../../shared/content-runtime';
import {
	isExtensionContextValid,
	runWithValidExtensionContext,
} from './extension-context';
import { readPageMediaField } from '../logic/page-media-bridge';
import {
	nextScalarGestureId,
	publishDefaultScalarGesture,
	publishPhysicalHotkeyRelease,
} from '../input/default-scalar-gesture';
import {
	isEditableHotkeyEvent,
	subscribeDocumentStartPhysicalHotkeyRelease,
} from '../input/hotkey-event';

const previous = getContentBootstrapState();
if (previous?.bootstrapRevision !== SPECTRA_CONTENT_BOOTSTRAP_REVISION) previous?.dispose();

if (!getContentBootstrapState()) {
	let disposed = false;
	let observationsReady = false;
	let observationInFlight = false;
	const activeDefaultScalarKeys = new Map<string, {
		action: SpectraDefaultHotkeyAction;
		gesture: string;
		repeated: boolean;
	}>();
	type BootstrapNativeObservation = {
		patch: import('@nexus/contracts').ControlPatch;
		observedStrategies: import('@nexus/contracts').ControlNativeObservationStrategies;
	};
	let pendingObservation: BootstrapNativeObservation | null = null;

	const defaultHotkeyAction = (event: KeyboardEvent): SpectraDefaultHotkeyAction | null => {
		if (!event.isTrusted || event.defaultPrevented) return null;
		const action = resolveSpectraDefaultHotkeyAction(event);
		if (action === null) return null;
		if (isEditableHotkeyEvent(event)) return null;
		return action;
	};

	const sendDefaultScalarPhase = (
		active: { action: SpectraDefaultHotkeyAction; gesture: string; repeated: boolean },
		phase: 'press' | 'release',
	): Promise<void> => sendBootstrapRequest(
			'spectra.content.default-hotkey.trigger',
			{
				action: active.action,
				gesture: active.gesture,
				phase,
				repeated: active.repeated,
			},
			state.dispose,
		).then(() => undefined);

	const acceptDefaultHotkeyKeydown = (
		event: KeyboardEvent,
		action: SpectraDefaultHotkeyAction,
	): void => {
		if (disposed) return;
		event.preventDefault();
		event.stopImmediatePropagation();
		let active = activeDefaultScalarKeys.get(event.code);
		if (!active) {
			active = {
				action,
				gesture: nextScalarGestureId('default'),
				repeated: false,
			};
			activeDefaultScalarKeys.set(event.code, active);
		} else {
			active.repeated = true;
			if (active.action === 'volume_mute') return;
		}
		publishDefaultScalarGesture({ ...active, phase: 'press' });
		void sendDefaultScalarPhase(active, 'press').catch(() => undefined);
	};

	const releaseDefaultScalarGesture = (
		active: { action: SpectraDefaultHotkeyAction; gesture: string; repeated: boolean },
	): void => {
		publishDefaultScalarGesture({ ...active, phase: 'release' });
		void sendDefaultScalarPhase(active, 'release')
			.catch(() => undefined)
			.finally(() => publishDefaultScalarGesture({ ...active, phase: 'settled' }));
	};

	const releaseDefaultScalarKeys = (): void => {
		for (const active of activeDefaultScalarKeys.values()) {
			releaseDefaultScalarGesture(active);
		}
		activeDefaultScalarKeys.clear();
	};

	const releaseDefaultHotkeyKeyup = (
		event: KeyboardEvent,
	): void => {
		const active = activeDefaultScalarKeys.get(event.code);
		if (active) {
			event.preventDefault();
			event.stopImmediatePropagation();
			activeDefaultScalarKeys.delete(event.code);
			releaseDefaultScalarGesture(active);
			return;
		}
		if (!event.code.startsWith('Alt') || activeDefaultScalarKeys.size === 0) return;
		event.preventDefault();
		event.stopImmediatePropagation();
		releaseDefaultScalarKeys();
	};

	const onDefaultHotkeyKeydown = (event: KeyboardEvent): void => {
		const action = defaultHotkeyAction(event);
		if (action !== null) acceptDefaultHotkeyKeydown(event, action);
	};

	const onDefaultHotkeyKeyup = (event: KeyboardEvent): void => {
		if (!event.isTrusted
			|| !(activeDefaultScalarKeys.has(event.code)
				|| event.code.startsWith('Alt') && activeDefaultScalarKeys.size > 0)) return;
		releaseDefaultHotkeyKeyup(event);
	};

	const onVisibilityChange = (): void => {
		if (document.hidden) releaseDefaultScalarKeys();
	};

	const readBootstrapObservation = (
		element: HTMLMediaElement,
		eventType: 'volumechange' | 'ratechange',
	): BootstrapNativeObservation | null => {
		const pageActual = (field: 'volumeBase' | 'mediaMuted' | 'speed'): number | boolean | null => {
			try { return readPageMediaField(element, field); }
			catch { return null; }
		};
		if (eventType === 'volumechange') {
			const pageVolume = pageActual('volumeBase');
			const pageMuted = pageActual('mediaMuted');
			return {
				patch: {
					volumeBase: typeof pageVolume === 'number'
						? pageVolume
						: Math.round(element.volume * 10_000) / 100,
					mediaMuted: typeof pageMuted === 'boolean' ? pageMuted : element.muted,
				},
				observedStrategies: {
					volumeBase: pageVolume === null ? 'dom-native' : 'page-native',
					mediaMuted: pageMuted === null ? 'dom-native' : 'page-native',
				},
			};
		}
		if (!('preservesPitch' in element)) return null;
		const pageSpeed = pageActual('speed');
		return {
			patch: {
				speed: typeof pageSpeed === 'number' ? pageSpeed : element.playbackRate,
				preservePitch: element.preservesPitch,
			},
			observedStrategies: {
				speed: pageSpeed === null ? 'dom-native' : 'page-native',
				preservePitch: 'dom-native',
			},
		};
	};

	const readNativeActual = (
		request: import('@nexus/contracts').ControlReadRequest,
	): import('@nexus/contracts').ControlReadResult | null => {
		const videoOnly = request.fields.every((field) => field === 'pip' || field === 'fullscreen');
		const media = [...document.querySelectorAll<HTMLMediaElement>('video,audio')]
			.filter((element) => !videoOnly || element instanceof HTMLVideoElement)
			.filter((element) => element.isConnected);
		const fullscreen = document.fullscreenElement;
		const element = media.find((candidate) => document.pictureInPictureElement === candidate)
			?? media.find((candidate) => fullscreen === candidate
				|| fullscreen instanceof Element && fullscreen.contains(candidate))
			?? media.find((candidate) => !candidate.paused && !candidate.ended)
			?? media[0];
		if (!element) return null;
		const patch: import('@nexus/contracts').ControlPatch = {};
		const observedStrategies: import('@nexus/contracts').ControlNativeObservationStrategies = {};
		const pageActual = (field: 'volumeBase' | 'mediaMuted' | 'speed'): number | boolean | null => {
			try { return readPageMediaField(element, field); }
			catch { return null; }
		};
		for (const field of request.fields) {
			let actual: unknown;
			switch (field) {
				case 'volumeBase': {
					const pageValue = pageActual(field);
					actual = pageValue ?? Math.round(element.volume * 10_000) / 100;
					observedStrategies.volumeBase = pageValue === null ? 'dom-native' : 'page-native';
					break;
				}
				case 'mediaMuted': {
					const pageValue = pageActual(field);
					actual = pageValue ?? element.muted;
					observedStrategies.mediaMuted = pageValue === null ? 'dom-native' : 'page-native';
					break;
				}
				case 'speed': {
					const pageValue = pageActual(field);
					actual = pageValue ?? element.playbackRate;
					observedStrategies.speed = pageValue === null ? 'dom-native' : 'page-native';
					break;
				}
				case 'preservePitch':
					if ('preservesPitch' in element) {
						actual = element.preservesPitch;
						observedStrategies.preservePitch = 'dom-native';
					}
					break;
				case 'playing': actual = !element.paused; observedStrategies.playing = 'dom-native'; break;
				case 'currentTime': actual = element.currentTime; observedStrategies.currentTime = 'dom-native'; break;
				case 'loop': actual = element.loop; observedStrategies.loop = 'dom-native'; break;
				case 'pip': actual = document.pictureInPictureElement === element; observedStrategies.pip = 'dom-native'; break;
				case 'fullscreen': actual = fullscreen === element
					|| fullscreen instanceof Element && fullscreen.contains(element);
					observedStrategies.fullscreen = 'dom-native';
					break;
			}
			if (actual !== undefined) (patch as Record<string, unknown>)[field] = actual;
		}
		return Object.keys(patch).length > 0 ? { target: null, patch, observedStrategies } : null;
	};

	let unsubscribePhysicalHotkeyRelease = (): void => undefined;
	const state: ContentBootstrapState = {
		bootstrapRevision: SPECTRA_CONTENT_BOOTSTRAP_REVISION,
		runtimeRevision: null as string | null,
		ready: false,
		dispose() {
			if (disposed) return;
			disposed = true;
			releaseDefaultScalarKeys();
			pendingObservation = null;
			try { chrome.runtime.onMessage.removeListener(onMessage); } catch { /* invalidated context */ }
			document.removeEventListener('volumechange', onNativeMediaChange, true);
			document.removeEventListener('ratechange', onNativeMediaChange, true);
			unsubscribePhysicalHotkeyRelease();
			window.removeEventListener('keydown', onDefaultHotkeyKeydown, true);
			window.removeEventListener('keyup', onDefaultHotkeyKeyup, true);
			document.removeEventListener('visibilitychange', onVisibilityChange);
			window.removeEventListener('blur', releaseDefaultScalarKeys);
			window.removeEventListener('pagehide', onPageHide);
			delete state.disposeRuntime;
			if (getContentBootstrapState() === state) setContentBootstrapState(undefined);
		},
	};

	const drainObservation = (): void => {
		if (disposed || observationInFlight || !pendingObservation) return;
		if (!observationsReady || state.ready || state.disposeRuntime) {
			if (state.ready || state.disposeRuntime) pendingObservation = null;
			return;
		}
		const observation = pendingObservation;
		pendingObservation = null;
		observationInFlight = true;
		void sendBootstrapRequest('spectra.control.intent.submit', {
			source: 'page',
			requestedCoverage: 'active-target',
			target: null,
			patch: observation.patch,
			observedStrategies: observation.observedStrategies,
		}, state.dispose).catch(() => undefined).finally(() => {
			observationInFlight = false;
			drainObservation();
		});
	};

	const onNativeMediaChange = (event: Event): void => {
		if (disposed || !observationsReady || state.ready || state.disposeRuntime) return;
		const element = event.composedPath().find(
			(candidate): candidate is HTMLMediaElement => candidate instanceof HTMLMediaElement,
		);
		if (!element?.isConnected
			|| (event.type !== 'volumechange' && event.type !== 'ratechange')) return;
		const observation = readBootstrapObservation(element, event.type);
		if (!observation) return;
		pendingObservation = pendingObservation
			? {
				patch: { ...pendingObservation.patch, ...observation.patch },
				observedStrategies: {
					...pendingObservation.observedStrategies,
					...observation.observedStrategies,
				},
			}
			: observation;
		drainObservation();
	};

	const onMessage = (
		message: unknown,
		sender: chrome.runtime.MessageSender,
		sendResponse: (response?: unknown) => void,
	): boolean => {
		if (disposed) return false;
		if (!isExtensionContextValid()) {
			state.dispose();
			return false;
		}
		if (sender.id && sender.id !== chrome.runtime.id) return false;
		if (!message || typeof message !== 'object') return false;
		const candidate = message as { protocolVersion?: unknown; type?: unknown };
		if (candidate.protocolVersion !== SPECTRA_PROTOCOL_VERSION || typeof candidate.type !== 'string') {
			return false;
		}
		if (candidate.type === 'spectra.content.runtime.status') {
			if (!isBootstrapInboundRequest(message) || message.type !== 'spectra.content.runtime.status') {
				sendResponse(bootstrapRpcFailure('invalid_request', 'Malformed content runtime status request'));
				return false;
			}
			sendResponse(bootstrapRpcSuccess({
				bootstrapRevision: state.bootstrapRevision,
				runtimeRevision: state.runtimeRevision,
				ready: state.ready,
				ownedSources: state.getOwnedSources?.() ?? [],
			}));
			return false;
		}
		if (candidate.type === 'spectra.control.actual.read' && !state.ready) {
			if (!isBootstrapInboundRequest(message) || message.type !== 'spectra.control.actual.read') {
				sendResponse(bootstrapRpcFailure('invalid_request', 'Malformed native observation request'));
				return false;
			}
			const passiveFields = new Set([
				'volumeBase', 'mediaMuted', 'speed', 'preservePitch', 'playing',
				'currentTime', 'loop', 'pip', 'fullscreen',
			]);
			if (message.payload.target !== null
				|| !message.payload.fields.every((field) => passiveFields.has(field))) {
				sendResponse(bootstrapRpcFailure(
					'content_runtime_not_loaded',
					'The document runtime is required for a target-bound or augmented read',
					true,
				));
				return false;
			}
			const result = readNativeActual(message.payload);
			if (!result) {
				sendResponse(bootstrapRpcFailure('capability-unavailable', 'No observable native media state'));
				return false;
			}
			sendResponse(bootstrapRpcSuccess(result));
			return false;
		}
		if (candidate.type === 'spectra.content.runtime.release' && state.ready) {
			if (!isBootstrapInboundRequest(message) || message.type !== 'spectra.content.runtime.release') {
				sendResponse(bootstrapRpcFailure('invalid_request', 'Malformed content runtime release'));
				return false;
			}
			if (message.payload.runtimeRevision !== state.runtimeRevision) {
				sendResponse(bootstrapRpcFailure('runtime_revision_mismatch', 'Content runtime release revision is stale'));
				return false;
			}
			void (state.disposeRuntime?.() ?? Promise.resolve()).then(() => {
				state.runtimeRevision = null;
				state.ready = false;
				sendResponse(bootstrapRpcSuccess({ accepted: true as const }));
		}, (error: unknown) => sendResponse(bootstrapRpcFailure(
				'runtime_release_failed',
				error instanceof Error ? error.message : String(error),
				true,
			)));
			return true;
		}
		if (isBootstrapInboundRequest(message)
			&& requiresContentRuntime(message.type)
			&& !state.ready) {
			sendResponse(bootstrapRpcFailure(
				'content_runtime_not_loaded',
				'The document runtime has not been acquired for this control',
				true,
			));
			return false;
		}
		return false;
	};

	const onPageHide = (): void => {
		releaseDefaultScalarKeys();
		if (!state.runtimeRevision) return;
		void sendBootstrapRequest('spectra.content.runtime.release', {
			runtimeRevision: state.runtimeRevision,
		}, state.dispose);
	};

	setContentBootstrapState(state);
	chrome.runtime.onMessage.addListener(onMessage);
	document.addEventListener('volumechange', onNativeMediaChange, true);
	document.addEventListener('ratechange', onNativeMediaChange, true);
	// This document-start observer is the release authority for lazily mounted
	// site hotkeys. It publishes only isolated-world cleanup identity and does
	// not claim, cancel, or otherwise mutate the website's keyup event.
	unsubscribePhysicalHotkeyRelease = subscribeDocumentStartPhysicalHotkeyRelease(
		(event) => publishPhysicalHotkeyRelease({ code: event.code }),
	);
	// The five shipped chords are reserved extension commands. Claiming them at
	// document_start keeps the first physical press out of page handlers that
	// would otherwise clamp volume to their native 0-100 range. Configured site
	// bindings remain website-first in the heavy hotkey listener.
	window.addEventListener('keydown', onDefaultHotkeyKeydown, true);
	window.addEventListener('keyup', onDefaultHotkeyKeyup, true);
	document.addEventListener('visibilitychange', onVisibilityChange);
	window.addEventListener('blur', releaseDefaultScalarKeys);
	window.addEventListener('pagehide', onPageHide, { once: true });

	void sendBootstrapRequest('spectra.content.bootstrap.hello', {
		bootstrapRevision: SPECTRA_CONTENT_BOOTSTRAP_REVISION,
	}, state.dispose).then((response) => {
		if (!isBootstrapHelloResponse(response) || disposed) return;
		state.runtimeRevision = response.data.runtimeRevision;
		state.ready = response.data.runtimeRevision !== null;
		observationsReady = true;
	}).catch(() => undefined);
}

function sendBootstrapRequest(
	type: 'spectra.content.bootstrap.hello'
		| 'spectra.content.runtime.release'
		| 'spectra.content.default-hotkey.trigger'
		| 'spectra.control.intent.submit',
	payload: { bootstrapRevision: string }
		| { runtimeRevision: string }
		| {
			action: SpectraDefaultHotkeyAction;
			phase: 'press' | 'release';
			gesture: string;
			repeated: boolean;
		}
		| import('@nexus/contracts').ControlSubmitRequest,
	onInvalidated?: () => void,
): Promise<unknown | undefined> {
	return runWithValidExtensionContext(() => chrome.runtime.sendMessage({
		protocolVersion: SPECTRA_PROTOCOL_VERSION,
		requestId: crypto.randomUUID(),
		type,
		payload,
	}), onInvalidated);
}
