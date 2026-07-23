// goal: binds secondary media control UI elements to content script commands for playback and focus management

import type { CardUIElements } from '../types';
import type { ControlMutation, ControlOperationAck, MediaTarget } from '@nexus/contracts';
import { sendSpectraRequest } from '../../shared/ui-spectra-client';
import { syncSidePanelSpeed } from '../side-panel/controls';
import { getHotkeyTarget, setHotkeyTarget } from '../../shared/registry-client';
import type { CardInternalState } from './types';
import type { ConfigUpdateFn } from './state';
import { showPopupToast } from '../toast';
import { getCurrentDict } from '../views/i18n-apply';
import {
	SPECTRA_TRUSTED_PIP_EVENT,
	SPECTRA_TRUSTED_PIP_REQUEST_ATTRIBUTE,
	SPECTRA_TRUSTED_PIP_RESULT_ATTRIBUTE,
	type SpectraTrustedPipOutcome,
	type SpectraTrustedPipResult,
} from '../../shared/trusted-activation';

const SVG_NS = 'http://www.w3.org/2000/svg';

interface ControlUiFailure {
	code: string;
	message: string;
	retryable: boolean;
}

class ControlUiError extends Error {
	constructor(readonly failure: ControlUiFailure) {
		super(failure.message);
		this.name = 'ControlUiError';
	}
}

// rule: SCTRL-005/014/025 — the click handler captures the video target
// exactly once and resolves it through a per-tab map. The single-parameter
// `togglePictureInPicture(tabId)` keeps the dispatch site decoupled from
// any closure or positional argument, so the IPC stack cannot drift between
// click-time snapshot and executor-time target.
interface PipToggleContext {
	documentId: string;
	target: MediaTarget;
}

const pipToggleByTab = new Map<number, PipToggleContext>();

function togglePictureInPicture(tabId: number): Promise<SpectraTrustedPipResult> {
	const context = pipToggleByTab.get(tabId);
	if (!context) throw new Error('The active video target is unavailable');
	return dispatchPictureInPicture(tabId, context.documentId, context.target);
}

async function dispatchPictureInPicture(
	tabId: number,
	documentId: string,
	target: MediaTarget,
): Promise<SpectraTrustedPipResult> {
	if (!documentId) throw new Error('The current document identity is unavailable');
	if (target.kind !== 'video' || target.documentId !== documentId) {
		throw new Error('The selected video target is unavailable');
	}
	const requestId = crypto.randomUUID();
	const injections = await chrome.scripting.executeScript({
		target: { tabId },
		world: 'ISOLATED',
		args: [
			SPECTRA_TRUSTED_PIP_EVENT,
			SPECTRA_TRUSTED_PIP_REQUEST_ATTRIBUTE,
			SPECTRA_TRUSTED_PIP_RESULT_ATTRIBUTE,
			requestId,
			documentId,
			target,
		],
		func: ((
			requestEvent: string,
			requestAttribute: string,
			resultAttribute: string,
			currentRequestId: string,
			currentDocumentId: string,
			currentTarget: MediaTarget,
		) => {
			document.documentElement.removeAttribute(resultAttribute);
			document.documentElement.setAttribute(
				requestAttribute,
				JSON.stringify({
					requestId: currentRequestId,
					documentId: currentDocumentId,
					target: currentTarget,
				}),
			);
			document.dispatchEvent(new Event(requestEvent));
			return { requestId: currentRequestId };
		}) as unknown as () => void,
	}) as unknown as Array<{
		result?: { requestId: string };
		error?: { message?: string } | string;
	}>;
	const [injection] = injections;
	if (injection?.result?.requestId !== requestId) {
		const injectionError = typeof injection?.error === 'string'
			? injection.error
			: injection?.error?.message;
		throw new Error(injectionError ?? 'The native PiP bridge did not accept the request');
	}

	const deadline = performance.now() + 2_000;
	while (performance.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, 25));
		const [readback] = await chrome.scripting.executeScript({
			target: { tabId },
			world: 'ISOLATED',
			args: [SPECTRA_TRUSTED_PIP_REQUEST_ATTRIBUTE, SPECTRA_TRUSTED_PIP_RESULT_ATTRIBUTE, requestId],
			func: ((requestAttribute: string, resultAttribute: string, currentRequestId: string) => {
				const encoded = document.documentElement.getAttribute(resultAttribute);
				if (!encoded) return null;
				try {
					const outcome = JSON.parse(encoded) as SpectraTrustedPipOutcome;
					if (!outcome || outcome.requestId !== currentRequestId) return null;
					document.documentElement.removeAttribute(requestAttribute);
					document.documentElement.removeAttribute(resultAttribute);
					return outcome;
				} catch {
					return null;
				}
			}) as unknown as () => void,
		}) as unknown as Array<{ result?: SpectraTrustedPipOutcome | null }>;
		const outcome = readback?.result;
		if (!outcome) continue;
		if (!outcome.ok) throw new Error(outcome.error);
		return { active: outcome.active };
	}
	throw new Error('Native Picture-in-Picture bridge did not acknowledge the click');
}

function asControlUiFailure(error: unknown): ControlUiFailure {
	if (error instanceof ControlUiError) return error.failure;
	return {
		code: 'control_failed',
		message: error instanceof Error ? error.message : String(error),
		retryable: true,
	};
}

async function reportControlFailure(
	error: unknown,
	state: CardInternalState,
): Promise<void> {
	const failure = asControlUiFailure(error);
	state.lastError = failure;
	showPopupToast(failure.message, 'error');
}

async function submitMutation(tabId: number, state: CardInternalState, mutation: ControlMutation) {
	const response = await sendSpectraRequest(
		'spectra.control.intent.submit',
		{
			tabId,
			source: 'popup',
			requestedCoverage: 'active-target',
			target: state.controlSnapshot?.activeMedia ?? null,
			baseRevision: state.controlRevision,
			mutations: [mutation],
		},
		{ tabId },
	);
	if (!response.ok) throw new ControlUiError(response.error);
	state.controlRevision = Math.max(state.controlRevision, response.data.revision);
	state.controlGeneration = Math.max(state.controlGeneration, response.data.generation);
	const field = response.data.fields[mutation.field];
	if (field?.phase !== 'applied') {
		throw new ControlUiError(field?.lastError ?? {
			code: 'control_not_applied',
			message: `Control ${mutation.field} was not applied`,
			retryable: true,
		});
	}
	return response.data;
}

// eff: attaches click and input handlers to playback buttons, speed controls, and tab-focus utilities
export function bindMediaControls(
	ui: CardUIElements,
	tabId: number,
	state: CardInternalState,
	update: ConfigUpdateFn,
): void {
	if (ui.btnPause) {
		ui.btnPause.onclick = () => {
			void update.runControl(() => sendSpectraRequest(
				'spectra.control.operation.submit',
				{
					tabId,
					source: 'popup',
					target: state.controlSnapshot?.activeMedia ?? null,
					baseRevision: state.controlRevision,
					operation: 'playback-toggle',
					payload: {},
				},
				{ tabId },
			)).then((response) => {
				if (!response.ok) throw new ControlUiError(response.error);
				const acknowledgement = response.data as ControlOperationAck<'playback-toggle'>;
				state.controlRevision = Math.max(state.controlRevision, acknowledgement.revision);
				state.controlGeneration = Math.max(state.controlGeneration, acknowledgement.generation);
				const playing = acknowledgement.result.playing;
				if (typeof playing === 'boolean' && ui.btnPause) renderPlaybackButton(ui.btnPause, playing);
			}).catch((error: unknown) => reportControlFailure(error, state));
		};
	}

	if (ui.btnPip) {
		ui.btnPip.onclick = () => {
			const snapshot = state.controlSnapshot;
			const target = snapshot?.activeVideo
				?? (snapshot?.activeMedia?.kind === 'video' ? snapshot.activeMedia : null);
			if (!snapshot?.documentId || !target) {
				void reportControlFailure(new Error('No active video target'), state);
				return;
			}
			ui.btnPip?.setAttribute('aria-busy', 'true');
			pipToggleByTab.set(tabId, { documentId: snapshot.documentId, target });
			// The first call in the click stack is a one-shot isolated-world injection.
			// It reaches the sole native writer without a Background/message await.
			void togglePictureInPicture(tabId)
				.then((result) => {
					if (!ui.btnPip) return;
					ui.btnPip.classList.toggle('active', result.active);
					ui.btnPip.setAttribute('aria-pressed', String(result.active));
				})
				.catch((error: unknown) => reportControlFailure(error, state))
				.finally(() => {
					pipToggleByTab.delete(tabId);
					ui.btnPip?.removeAttribute('aria-busy');
				});
		};
	}

	const submitSpeed = (operation: 'set' | 'delta', value: number) => {
		void update.runControl(() => submitMutation(tabId, state, {
			field: 'speed', operation, value,
		}))
			.then((ack) => {
				const actual = ack.fields.speed?.actual;
				if (typeof actual !== 'number') return;
				if (ui.speedInput) ui.speedInput.value = actual.toFixed(2);
				syncSidePanelSpeed(actual);
			})
			.catch((error: unknown) => reportControlFailure(error, state));
	};

	ui.speedBtns.forEach(btn => {
		btn.onclick = () => {
			const delta = parseFloat(btn.dataset.delta || '0');
			submitSpeed('delta', delta);
		};
	});

	if (ui.speedInput) {
		const submitClampedSpeed = (speed: number) => {
			const clampedSpeed = Math.max(0.1, Math.min(16, speed));
			submitSpeed('set', clampedSpeed);
		};

		ui.speedInput.onchange = (e) => {
			const speed = parseFloat((e.target as HTMLInputElement).value) || 1;
			submitClampedSpeed(speed);
		};

		ui.speedInput.onwheel = (e) => {
			e.preventDefault();
			const current = parseFloat(ui.speedInput!.value) || 1;
			const delta = e.deltaY < 0 ? 0.1 : -0.1;
			submitClampedSpeed(current + delta);
		};
	}

	if (ui.btnHotkeyTarget) {
		const btn = ui.btnHotkeyTarget;
		btn.setAttribute('aria-pressed', 'false');

		void getHotkeyTarget().then(result => {
			if (result.tabId === tabId) {
				btn.classList.add('active');
				btn.setAttribute('aria-pressed', 'true');
			}
		}).catch(() => undefined);

		btn.onclick = () => {
			const clearing = btn.classList.contains('active');
			void setHotkeyTarget(clearing ? null : tabId).then(() => {
				// note: enforce exclusive "active" state across all rendered cards in the popup
				document.querySelectorAll<HTMLElement>('.btn-hotkey-target').forEach((button) => {
					button.classList.remove('active');
					button.setAttribute('aria-pressed', 'false');
				});
				if (!clearing) {
					btn.classList.add('active');
					btn.setAttribute('aria-pressed', 'true');
				}
			}).catch(() => undefined);
		};
	}

	if (ui.btnGotoTab) {
		ui.btnGotoTab.onclick = () => {
			chrome.tabs.update(tabId, { active: true });
		};
	}
}

export function renderPlaybackButton(button: HTMLElement, playing: boolean): void {
	button.replaceChildren(createPlaybackIcon(playing));
	button.setAttribute('aria-pressed', String(playing));
	const localized = getCurrentDict()?.btnPause;
	const label = typeof localized === 'string' && localized.trim().length > 0
		? localized
		: 'Pause/Play';
	button.title = label;
	button.setAttribute('aria-label', label);
}

function createPlaybackIcon(playing: boolean): SVGSVGElement {
	const svg = document.createElementNS(SVG_NS, 'svg');
	svg.setAttribute('width', '12');
	svg.setAttribute('height', '12');
	svg.setAttribute('viewBox', '0 0 24 24');
	svg.setAttribute('fill', 'currentColor');
	svg.setAttribute('aria-hidden', 'true');

	if (playing) {
		for (const x of ['6', '14']) {
			const rect = document.createElementNS(SVG_NS, 'rect');
			rect.setAttribute('x', x);
			rect.setAttribute('y', '4');
			rect.setAttribute('width', '4');
			rect.setAttribute('height', '16');
			svg.append(rect);
		}
	} else {
		const path = document.createElementNS(SVG_NS, 'path');
		path.setAttribute('d', 'M8 5v14l11-7z');
		svg.append(path);
	}

	return svg;
}

