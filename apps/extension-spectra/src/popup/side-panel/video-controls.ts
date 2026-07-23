// goal: binds interactive video manipulation controls (filters, transforms, A/B loops) in the side panel to content script actions

import type {
	ControlMutation,
	ControlOperation,
	ControlOperationAck,
	ControlOperationPayload,
	ControlOperationRequest,
	ControlPatch,
	ControlSnapshot,
	VideoFilterState,
} from '@nexus/contracts';
import { sendSpectraRequest } from '../../shared/ui-spectra-client';

let currentTabId: number | null = null;
let currentSnapshot: ControlSnapshot | null = null;
let pendingFilter: VideoFilterState | null = null;
let filterTimer: ReturnType<typeof setTimeout> | null = null;
let filterInFlight = false;
let lastFilterSentAt = 0;
const FILTER_SEND_INTERVAL_MS = 50;

type ControlAckLike = Pick<
	ControlSnapshot,
	'tabId' | 'documentId' | 'generation' | 'revision' | 'fields'
> & { target: ControlSnapshot['activeMedia'] };

function updateSnapshotFromAck(ack: ControlAckLike | null): void {
	if (!ack || !currentSnapshot || ack.tabId !== currentSnapshot.tabId
		|| ack.documentId !== currentSnapshot.documentId) return;
	currentSnapshot = {
		...currentSnapshot,
		generation: ack.generation,
		revision: ack.revision,
		activeMedia: currentSnapshot.activeMedia,
		activeVideo: ack.target?.kind === 'video'
			? ack.target
			: currentSnapshot.activeVideo,
		fields: { ...currentSnapshot.fields, ...ack.fields },
	};
}

async function submitMutation(mutation: ControlMutation) {
	if (!currentTabId) return null;
	const response = await sendSpectraRequest(
		'spectra.control.intent.submit',
		{
			tabId: currentTabId,
			source: 'popup',
			requestedCoverage: 'active-target',
			target: currentSnapshot?.activeVideo ?? null,
			...(currentSnapshot ? { baseRevision: currentSnapshot.revision } : {}),
			mutations: [mutation],
		},
		{ tabId: currentTabId },
	);
	if (!response.ok) throw new Error(response.error.message);
	updateSnapshotFromAck(response.data);
	return response.data;
}

async function submitPatch(patch: ControlPatch) {
	if (!currentTabId) return null;
	const response = await sendSpectraRequest(
		'spectra.control.intent.submit',
		{
			tabId: currentTabId,
			source: 'popup',
			requestedCoverage: 'active-target',
			target: currentSnapshot?.activeVideo ?? null,
			...(currentSnapshot ? { baseRevision: currentSnapshot.revision } : {}),
			patch,
		},
		{ tabId: currentTabId },
	);
	if (!response.ok) throw new Error(response.error.message);
	updateSnapshotFromAck(response.data);
	return response.data;
}

async function submitOperation<O extends ControlOperation>(
	operation: O,
	payload: ControlOperationPayload<O>,
): Promise<ControlOperationAck<O> | null> {
	if (!currentTabId) return null;
	const response = await sendSpectraRequest(
		'spectra.control.operation.submit',
		{
			tabId: currentTabId,
			source: 'popup',
			target: currentSnapshot?.activeVideo ?? null,
			...(currentSnapshot ? { baseRevision: currentSnapshot.revision } : {}),
			operation,
			payload,
		} as unknown as ControlOperationRequest,
		{ tabId: currentTabId },
	);
	if (!response.ok) throw new Error(response.error.message);
	const acknowledgement = response.data as ControlOperationAck<O>;
	updateSnapshotFromAck(acknowledgement);
	return acknowledgement;
}

function readFilter(panel: HTMLElement): VideoFilterState {
	return {
		brightness: Number.parseInt(panel.querySelector<HTMLInputElement>('.sp-brightness')?.value ?? '100', 10),
		contrast: Number.parseInt(panel.querySelector<HTMLInputElement>('.sp-contrast')?.value ?? '100', 10),
		saturate: Number.parseInt(panel.querySelector<HTMLInputElement>('.sp-saturate')?.value ?? '100', 10),
		grayscale: panel.querySelector<HTMLInputElement>('.sp-sw-grayscale')?.checked === true,
		invert: panel.querySelector<HTMLInputElement>('.sp-sw-invert')?.checked === true,
	};
}

// eff: sets the target tab for all subsequent video control commands
export function setVideoControlTabId(tabId: number): void {
	if (currentTabId !== tabId) {
		if (filterTimer) clearTimeout(filterTimer);
		filterTimer = null;
		pendingFilter = null;
		currentSnapshot = null;
	}
	currentTabId = tabId;
}

// eff: identifies and initializes all video-related UI components within the side panel container
export function bindVideoControls(): void {
	const panel = document.getElementById('side-panel');
	if (!panel) return;

	bindButtons(panel);
	bindFilterSliders(panel);
	bindFilterSwitches(panel);
	bindSeekButtons(panel);
	window.addEventListener('pagehide', () => {
		void flushFilter().catch(() => undefined);
	}, { once: true });
}

// note: handles discrete action buttons like rotation, mirroring, and A/B marker placement via a centralized switch
function bindButtons(panel: HTMLElement): void {
	const btns = panel.querySelectorAll<HTMLButtonElement>('.sp-btn[data-action]');

	btns.forEach(btn => {
		const action = btn.dataset.action;
		if (!action) return;
		if (['mirror', 'crop', 'fullscreen', 'dim', 'mark-a', 'mark-b'].includes(action)) {
			btn.setAttribute('aria-pressed', String(btn.classList.contains('active')));
		}

		btn.onclick = async () => {
			if (!currentTabId) return;

			switch (action) {
			case 'rotate': {
					const ack = await submitMutation({ field: 'rotation', operation: 'delta', value: 90 });
					const rotation = ack?.fields.rotation?.actual;
					if (typeof rotation === 'number') btn.title = `Rotation: ${rotation}°`;
					break;
				}
				case 'mirror': {
					const ack = await submitMutation({ field: 'mirrored', operation: 'toggle' });
					const mirrored = ack?.fields.mirrored?.actual;
					if (typeof mirrored === 'boolean') setPressed(btn, mirrored);
					break;
				}
				case 'screenshot': {
					await submitOperation('screenshot', {});
					break;
				}
				case 'crop': {
					const ack = await submitMutation({ field: 'fill', operation: 'toggle' });
					const fill = ack?.fields.fill?.actual;
					if (typeof fill === 'boolean') setPressed(btn, fill);
					break;
				}
				case 'fullscreen': {
					const ack = await submitMutation({ field: 'fullscreen', operation: 'toggle' });
					const active = ack?.fields.fullscreen?.actual;
					if (typeof active === 'boolean') setPressed(btn, active);
					break;
				}
				case 'dim': {
					const ack = await submitMutation({ field: 'dimEnabled', operation: 'toggle' });
					const active = ack?.fields.dimEnabled?.actual;
					if (typeof active === 'boolean') setPressed(btn, active);
					break;
				}
				case 'mark-a': {
					const ack = await submitOperation('ab-set-a', {});
					setPressed(btn, ack?.result.abLoop.pointA !== null);
					break;
				}
				case 'mark-b': {
					const ack = await submitOperation('ab-set-b', {});
					setPressed(btn, ack?.result.abLoop.pointB !== null);
					break;
				}
				case 'ab-loop': {
					await submitOperation('ab-clear', {});
					for (const marker of panel.querySelectorAll<HTMLElement>('.sp-btn-marker[data-action="mark-a"], .sp-btn-marker[data-action="mark-b"]')) {
						setPressed(marker, false);
					}
					break;
				}
			}
		};
	});
}

export function syncVideoControlSnapshot(snapshot: ControlSnapshot): void {
	if (snapshot.tabId !== currentTabId) return;
	if (currentSnapshot && (snapshot.generation < currentSnapshot.generation
		|| snapshot.generation === currentSnapshot.generation
			&& snapshot.revision < currentSnapshot.revision)) return;
	currentSnapshot = snapshot;
	const panel = document.getElementById('side-panel');
	if (!panel) return;
	const actual = <T>(field: keyof ControlSnapshot['fields']): T | undefined => {
		const value = snapshot.fields[field]?.actual;
		return value === null || value === undefined ? undefined : value as T;
	};
	const pressed = (action: string, value: boolean | undefined): void => {
		const button = panel.querySelector<HTMLElement>(`.sp-btn[data-action="${action}"]`);
		if (button && typeof value === 'boolean') setPressed(button, value);
	};
	const rotation = actual<number>('rotation');
	const rotate = panel.querySelector<HTMLElement>('.sp-btn[data-action="rotate"]');
	if (rotate && typeof rotation === 'number') rotate.title = `Rotation: ${rotation}°`;
	pressed('mirror', actual<boolean>('mirrored'));
	pressed('crop', actual<boolean>('fill'));
	pressed('fullscreen', actual<boolean>('fullscreen'));
	pressed('dim', actual<boolean>('dimEnabled'));

	const filter = actual<VideoFilterState>('filter');
	if (filter) {
		for (const [selector, value] of [
			['.sp-brightness', filter.brightness],
			['.sp-contrast', filter.contrast],
			['.sp-saturate', filter.saturate],
		] as const) {
			const input = panel.querySelector<HTMLInputElement>(selector);
			if (input && document.activeElement !== input) input.value = String(value);
		}
		const grayscale = panel.querySelector<HTMLInputElement>('.sp-sw-grayscale');
		const invert = panel.querySelector<HTMLInputElement>('.sp-sw-invert');
		if (grayscale) grayscale.checked = filter.grayscale;
		if (invert) invert.checked = filter.invert;
	}
	const abLoop = actual<import('@nexus/contracts').ABLoopState>('abLoop');
	if (abLoop) {
		pressed('mark-a', abLoop.pointA !== null);
		pressed('mark-b', abLoop.pointB !== null);
		pressed('ab-loop', abLoop.enabled);
	}
}

function setPressed(button: HTMLElement, pressed: boolean): void {
	button.classList.toggle('active', pressed);
	button.setAttribute('aria-pressed', String(pressed));
}

function bindFilterSliders(panel: HTMLElement): void {
	const sliders: Array<{
		cls: string;
		val: string;
	}> = [
		{ cls: '.sp-brightness', val: '.sp-brightness-val' },
		{ cls: '.sp-contrast', val: '.sp-contrast-val' },
		{ cls: '.sp-saturate', val: '.sp-saturate-val' },
	];

	sliders.forEach(({ cls, val }) => {
		const slider = panel.querySelector<HTMLInputElement>(cls);
		const valEl = panel.querySelector<HTMLElement>(val);
		if (!slider) return;

		slider.oninput = () => {
			if (valEl) valEl.textContent = `${slider.value}%`;
			queueFilter(panel);
		};

		slider.onchange = () => queueFilter(panel, true);
	});
}

function bindFilterSwitches(panel: HTMLElement): void {
	const grayscale = panel.querySelector<HTMLInputElement>('.sp-sw-grayscale');
	const invert = panel.querySelector<HTMLInputElement>('.sp-sw-invert');

	if (grayscale) {
		grayscale.onchange = () => queueFilter(panel, true);
	}

	if (invert) {
		invert.onchange = () => queueFilter(panel, true);
	}
}

function queueFilter(panel: HTMLElement, flushNow = false): void {
	pendingFilter = readFilter(panel);
	if (filterTimer) clearTimeout(filterTimer);
	if (flushNow) {
		filterTimer = null;
		void flushFilter().catch(() => undefined);
		return;
	}
	const delay = flushNow
		? 0
		: Math.max(0, FILTER_SEND_INTERVAL_MS - (performance.now() - lastFilterSentAt));
	filterTimer = setTimeout(() => {
		filterTimer = null;
		void flushFilter().catch(() => undefined);
	}, delay);
}

async function flushFilter(): Promise<void> {
	if (filterInFlight || !pendingFilter) return;
	const filter = pendingFilter;
	pendingFilter = null;
	filterInFlight = true;
	lastFilterSentAt = performance.now();
	try {
		await submitPatch({ filter, filterEnabled: true });
	} finally {
		filterInFlight = false;
		if (pendingFilter) {
			const panel = document.getElementById('side-panel');
			if (panel) queueFilter(panel);
		}
	}
}

// eff: attaches click handlers to seek buttons providing discrete jumps (e.g. +/- 5s, +/- 30s) based on dataset deltas
function bindSeekButtons(panel: HTMLElement): void {
	const seekBtns = panel.querySelectorAll<HTMLButtonElement>('.sp-btn-small[data-action="seek"]');

	seekBtns.forEach(btn => {
		btn.onclick = async () => {
			if (!currentTabId) return;
			const delta = parseFloat(btn.dataset.delta ?? '0');
			if (delta !== 0) await submitOperation('seek-relative', { delta });
		};
	});
}

