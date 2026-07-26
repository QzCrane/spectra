// goal: transient visual feedback (On-Screen Display) for adjustments

import { UIColors } from '@nexus/audio-engine';
import {
	crossesAudioVolumeProcessorBoundary,
	type AudioVolumeState,
	type SpectraHotkeyActualFeedback,
} from '@nexus/contracts';
import type { ContentGlobalSettings } from '../core/settings-manager';
import { activateFeedbackSurface, createFeedbackSurface } from './feedback-surface';
import {
	scalarFeedbackAnimationDuration,
	clampScalarFeedbackValue,
	scalarFeedbackMaxFrameDelta,
	scalarFeedbackMarkers,
	scalarFeedbackProgress,
	type ScalarFeedbackKind,
} from './scalar-feedback';

type OSDPayload =
	| { type: 'volume'; value: number; volumeState: AudioVolumeState }
	| { type: 'speed'; value: number };
type VolumeOSDPayload = Extract<OSDPayload, { type: 'volume' }>;

type HotkeyOSDPhase = 'active' | 'frozen' | 'settled';

interface HotkeyOSDTransaction {
	gesture: string;
	phase: HotkeyOSDPhase;
	alternate: boolean;
	target: OSDPayload;
	volumeState: AudioVolumeState;
}

interface OSDState {
	host: HTMLElement | null;
	root: ShadowRoot | null;
	timer: ReturnType<typeof setTimeout> | null;
	animationFrame: number | null;
	displayedValue: number | null;
	presentation: OSDPayload | null;
	hotkey: HotkeyOSDTransaction | null;
	claimedGesture: string | null;
	lastTargetAt: number | null;
	lastType: 'volume' | 'speed' | null;
}
const state: OSDState = {
	host: null,
	root: null,
	timer: null,
	animationFrame: null,
	displayedValue: null,
	presentation: null,
	hotkey: null,
	claimedGesture: null,
	lastTargetAt: null,
	lastType: null,
};

export interface OSDOptions {
	variant?: 'alternate-target';
	targetTitle?: string;
	targetHostname?: string;
}

const OSD_HIDE_DELAY_MS = 2_000;

export function resolveHotkeyVolumeTarget(
	previous: VolumeOSDPayload,
	target: VolumeOSDPayload,
): VolumeOSDPayload {
	return crossesAudioVolumeProcessorBoundary(previous.value, target.value)
		? previous
		: target;
}

export function resolveHotkeyVolumeBaseline(
	visible: VolumeOSDPayload | null,
	baseline: VolumeOSDPayload | null,
	priorPhase?: HotkeyOSDPhase,
): VolumeOSDPayload | null {
	return priorPhase !== undefined && priorPhase !== 'settled'
		? visible ?? baseline
		: baseline ?? visible;
}

// The OSD is the only owner of the transient shortcut target. Input listeners
// provide physical deltas and the latest local actual baseline; they never keep
// a second predicted value that can drift across ACKs or gestures.
export function advanceHotkeyTargetOSD(
	baseline: SpectraHotkeyActualFeedback,
	delta: number,
	s: ContentGlobalSettings,
	gesture: string,
): void {
	if (!s.osdEnabled) return;
	state.claimedGesture = gesture;
	const priorHotkey = state.hotkey;
	const sameKind = priorHotkey?.target.type === baseline.kind;
	const previousTarget = sameKind ? priorHotkey.target.value : undefined;
	const step = Math.abs(delta);
	const base = previousTarget !== undefined
		&& (priorHotkey?.gesture === gesture && priorHotkey.phase === 'active'
			|| priorHotkey?.phase !== 'settled'
				&& Math.abs(previousTarget - baseline.value) <= step + 0.001)
		? previousTarget
		: baseline.value;
	const value = clampScalarFeedbackValue(
		baseline.kind,
		Math.round((base + delta) * 100) / 100,
	);
	const feedback = { ...baseline, value };
	const started = priorHotkey?.gesture !== gesture;
	const visibleVolume = state.presentation?.type === 'volume'
		? state.presentation
		: null;
	const baselineVolume = baseline.kind === 'volume'
		? feedbackPayload({ ...baseline, value: base }) as VolumeOSDPayload
		: null;
	const previous = resolveHotkeyVolumeBaseline(
		visibleVolume,
		baselineVolume,
		started ? priorHotkey?.phase : 'active',
	);
	const predictedState = feedback.kind === 'volume' ? feedback.volumeState : 'native';
	const hotkey: HotkeyOSDTransaction = started
		? {
			gesture,
			phase: 'active',
			alternate: false,
			target: feedbackPayload(feedback),
			volumeState: previous !== null && previous.value > 0
				? previous.volumeState
				: predictedState,
		}
		: priorHotkey!;
	state.hotkey = hotkey;
	if (hotkey.phase !== 'active' || hotkey.alternate) return;
	if (feedback.kind === 'speed') {
		hotkey.target = { type: 'speed', value };
		renderOSD(hotkey.target, s, {});
		return;
	}
	const target: VolumeOSDPayload = {
		type: 'volume',
		value,
		volumeState: value <= 0 ? 'silent' : hotkey.volumeState,
	};
	hotkey.target = target;
	const projection = resolveHotkeyVolumeTarget(previous ?? target, target);
	renderOSD(
		projection,
		s,
		{},
		!crossesAudioVolumeProcessorBoundary(projection.value, target.value),
	);
}

// A non-predictive actual-OSD action (mute/reset/set) still claims the current
// physical gesture before its ACK arrives. This lets it supersede an older
// visible transaction while rejecting a late ACK from that older gesture.
export function claimHotkeyActualOSDGesture(gesture: string): void {
	state.claimedGesture = gesture;
}

function feedbackPayload(feedback: SpectraHotkeyActualFeedback): OSDPayload {
	return feedback.kind === 'volume'
		? { type: 'volume', value: feedback.value, volumeState: feedback.volumeState }
		: { type: 'speed', value: feedback.value };
}

function pendingVolumeBoundary(
	hotkey: HotkeyOSDTransaction,
	presentation: OSDPayload | null,
): presentation is VolumeOSDPayload {
	return hotkey.target.type === 'volume'
		&& presentation?.type === 'volume'
		&& crossesAudioVolumeProcessorBoundary(presentation.value, hotkey.target.value);
}

function updateAcknowledgedVolumeState(
	hotkey: HotkeyOSDTransaction,
	actual: VolumeOSDPayload,
): void {
	// A zero value hides processor tone but does not prove that the processor
	// changed. A positive ACK is complete: silent then means media mute.
	if (actual.value > 0) hotkey.volumeState = actual.volumeState;
}

function paintOSDColor(root: ShadowRoot, payload: OSDPayload): void {
	const fill = root.getElementById('f');
	if (!fill) return;
	fill.style.backgroundColor = payload.type === 'speed'
		? '#10b981'
		: payload.volumeState === 'capture'
			? UIColors.CAPTURE
			: payload.volumeState === 'silent'
				? UIColors.MUTED
				: UIColors.NATIVE;
}

// eff: commits one gesture-bound aggregate ACK; a different target adds only
// the target row and then owns prediction for the rest of that gesture.
export function showHotkeyActualOSD(
	feedback: SpectraHotkeyActualFeedback,
	s: ContentGlobalSettings,
	options: OSDOptions = {},
	gesture?: string,
): void {
	if (!s.osdEnabled) return;
	const alternate = options.variant === 'alternate-target';
	let hotkey = state.hotkey;
	if (!gesture) {
		if (hotkey && hotkey.phase !== 'settled') return;
		renderOSD(feedbackPayload(feedback), s, options);
		return;
	}
	const actual = feedbackPayload(feedback);
	const claimedByNewGesture = state.claimedGesture === gesture
		&& hotkey?.gesture !== gesture;
	if (state.claimedGesture !== null
		&& state.claimedGesture !== gesture) return;
	if (!hotkey || claimedByNewGesture) {
		hotkey = {
			gesture,
			phase: 'active',
			alternate,
			target: actual,
			volumeState: actual.type === 'volume' ? actual.volumeState : 'native',
		};
		state.hotkey = hotkey;
		state.claimedGesture = gesture;
		renderOSD(actual, s, options);
		return;
	}
	if (hotkey.gesture !== gesture
		|| hotkey.phase === 'settled'
		|| state.presentation?.type !== feedback.kind
		|| hotkey.alternate && !alternate) return;
	if (alternate) {
		hotkey.alternate = alternate;
		hotkey.target = actual;
		if (actual.type === 'volume') updateAcknowledgedVolumeState(hotkey, actual);
		renderOSD(
			actual,
			s,
			options,
			hotkey.phase === 'active',
			hotkey.phase === 'active',
		);
		return;
	}
	if (hotkey.phase === 'frozen') {
		if (actual.type === 'volume') updateAcknowledgedVolumeState(hotkey, actual);
		// Keyup owns the frozen visual frame. A late ACK may refresh the
		// internal volume truth, but it must not repaint the released target or
		// restart its interpolation window.
		return;
	}
	if (feedback.kind !== 'volume' || hotkey.target.type !== 'volume') return;
	if ((feedback.value > 100) !== (hotkey.target.value > 100)) return;
	updateAcknowledgedVolumeState(hotkey, actual as VolumeOSDPayload);
	const target = {
		...hotkey.target,
		volumeState: hotkey.target.value <= 0 ? 'silent' : hotkey.volumeState,
	} satisfies VolumeOSDPayload;
	hotkey.target = target;
	if (pendingVolumeBoundary(hotkey, state.presentation)) {
		renderOSD(
			hotkey.phase === 'active' ? target : actual,
			s,
			options,
			false,
			hotkey.phase === 'active',
		);
		return;
	}
	// Same-region ACKs correct only the acknowledged tone. They must not rewind
	// the transient target, cancel its fill interpolation, or restart its timer.
	state.presentation = target;
	if (state.root) paintOSDColor(state.root, target);
}

function formatSpeed(speed: number): string {
	const rounded = Math.round(speed * 100) / 100;
	return Number.isInteger(rounded * 10)
		? rounded.toFixed(1)
		: rounded.toFixed(2).replace(/0$/u, '');
}

function cancelValueAnimation(): void {
	if (state.animationFrame !== null) cancelAnimationFrame(state.animationFrame);
	state.animationFrame = null;
}

function scheduleOSDHide(): void {
	if (state.timer) clearTimeout(state.timer);
	state.timer = setTimeout(() => {
		concealOSD();
		if (state.hotkey) state.hotkey.phase = 'settled';
	}, OSD_HIDE_DELAY_MS);
}

function renderMarkers(root: ShadowRoot, type: ScalarFeedbackKind): void {
	const markerLayer = root.getElementById('marks');
	if (!markerLayer) return;
	const markers = scalarFeedbackMarkers(type).map((marker) => {
		const element = document.createElement('span');
		element.className = `mk ${marker.lane}`;
		element.dataset.label = marker.label;
		element.style.left = `${scalarFeedbackProgress(type, marker.value)}%`;
		return element;
	});
	markerLayer.replaceChildren(...markers);
}

function paintScalarValue(
	root: ShadowRoot,
	payload: OSDPayload,
	value: number,
	s: ContentGlobalSettings,
): void {
	const fill = root.getElementById('f');
	const text = root.getElementById('t');
	const icon = root.getElementById('i');
	if (!fill || !text || !icon) return;
	fill.style.width = `${scalarFeedbackProgress(payload.type, value)}%`;
	const target = payload.value;
	if (payload.type === 'speed') {
		text.textContent = `${formatSpeed(target)}×`;
		icon.textContent = target > 1 ? '⚡' : (target < 1 ? '🐢' : '⏱️');
		return;
	}
	const silent = payload.volumeState === 'silent';
	text.textContent = silent
		? s.osdMessages.muted
		: `${Number.isInteger(target) ? target : target.toFixed(1)}%`;
	icon.textContent = silent ? '🔇' : (target > 100 ? '🚀' : '🔊');
}

function animateScalarValue(
	root: ShadowRoot,
	payload: OSDPayload,
	s: ContentGlobalSettings,
): void {
	cancelValueAnimation();
	const targetAt = performance.now();
	const targetIntervalMs = state.hotkey !== null
		&& state.lastType === payload.type
		&& state.lastTargetAt !== null
		? targetAt - state.lastTargetAt
		: undefined;
	state.lastTargetAt = targetAt;
	const from = state.lastType === payload.type && state.displayedValue !== null
		? state.displayedValue
		: payload.value;
	const to = payload.value;
	if (payload.type === 'volume' && payload.volumeState === 'silent'
		|| from === to) {
		state.displayedValue = to;
		paintScalarValue(root, payload, to, s);
		return;
	}
	const duration = scalarFeedbackAnimationDuration(payload.type, from, to, targetIntervalMs);
	// Commit the discrete shortcut target in the input task while preserving the
	// current interpolated fill. A busy frame cannot swallow a physical step's
	// integer label merely because the next keydown arrives before rAF.
	paintScalarValue(root, payload, from, s);
	let startedAt: number | null = null;
	const step = (now: number): void => {
		startedAt ??= now;
		const progress = Math.min(1, (now - startedAt) / duration);
		const desired = from + (to - from) * progress;
		const current = state.displayedValue ?? from;
		const remaining = desired - current;
		const maxFrameDelta = state.hotkey === null
			? Math.abs(remaining)
			: scalarFeedbackMaxFrameDelta(payload.type);
		const value = Math.abs(remaining) <= maxFrameDelta
			? desired
			: current + Math.sign(remaining) * maxFrameDelta;
		state.displayedValue = value;
		paintScalarValue(root, payload, value, s);
		if (progress < 1 || Math.abs(to - value) > Number.EPSILON) {
			state.animationFrame = requestAnimationFrame(step);
		} else {
			state.animationFrame = null;
			state.displayedValue = to;
		}
	};
	state.animationFrame = requestAnimationFrame(step);
}

function concealOSD(): void {
	cancelValueAnimation();
	state.root?.getElementById('o')?.classList.remove('v');
	state.timer = null;
	state.displayedValue = null;
	state.presentation = null;
	state.lastTargetAt = null;
	state.lastType = null;
}

// Keyup terminates motion but not readability. Preserve the exact final
// number/width/tone frame synchronously, then give it a fresh display window.
// The gesture identity remains until the in-flight ACK settles so late actual
// feedback cannot repaint or restart the released surface.
export function freezeHotkeyTargetOSD(gesture: string): void {
	if (state.hotkey?.gesture !== gesture) return;
	if (state.hotkey.phase === 'active') state.hotkey.phase = 'frozen';
	cancelValueAnimation();
	state.root?.getElementById('o')?.classList.add('v');
	state.lastTargetAt = null;
	scheduleOSDHide();
}

export function releaseHotkeyTargetOSD(gesture: string): void {
	if (state.hotkey?.gesture !== gesture) return;
	if (state.timer === null) {
		state.hotkey = null;
		return;
	}
	state.hotkey.phase = 'settled';
}

// eff: core OSD rendering logic, handles both volume and speed display modes
function renderOSD(
	payload: OSDPayload,
	s: ContentGlobalSettings,
	options: OSDOptions,
	animate = true,
	refreshHide = true,
): void {
	if (!state.host?.isConnected || !state.root) {
		const surface = createFeedbackSurface(
			'spectra-osd-host',
			'position:fixed;top:15%;left:50%;transform:translateX(-50%);z-index:2147483647',
		);
		const h = surface.host;
		const ws = surface.root;
		const css = document.createElement('style');
		css.textContent = `.o{background:rgba(20,20,30,0.85);backdrop-filter:blur(8px);padding:12px 20px;border-radius:30px;color:#fff;display:grid;gap:4px;font-family:system-ui;transition:0.2s;opacity:0;transform:translateY(-10px)}.v{opacity:1;transform:translateY(0)}.r{display:flex;align-items:center;gap:12px}.g{width:160px;height:26px;position:relative;flex:none}.b{position:absolute;left:0;right:0;top:10px;height:6px;background:rgba(255,255,255,0.2);border-radius:3px;overflow:hidden}.f{height:100%;width:0%}.marks{position:absolute;inset:0;pointer-events:none}.mk{position:absolute;top:9px;width:1px;height:8px;background:rgba(255,255,255,0.72);transform:translateX(-.5px);z-index:5}.mk::after{content:attr(data-label);position:absolute;left:50%;transform:translateX(-50%);font-size:8px;line-height:9px;font-weight:600;white-space:nowrap;color:rgba(255,255,255,0.76)}.mk.upper::after{bottom:9px}.mk.lower::after{top:9px}.t{font-weight:600;font-size:14px;min-width:58px;text-align:right;font-variant-numeric:tabular-nums}.meta{max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:center;font-size:11px;opacity:.78}.meta[hidden]{display:none}`;

		const o = document.createElement('div'); o.className = 'o'; o.id = 'o';
		const r = document.createElement('div'); r.className = 'r';
		const i = document.createElement('span'); i.id = 'i';
		const g = document.createElement('div'); g.className = 'g';
		const b = document.createElement('div'); b.className = 'b';
		const f = document.createElement('div'); f.className = 'f'; f.id = 'f';
		const marks = document.createElement('div'); marks.className = 'marks'; marks.id = 'marks';
		const t = document.createElement('span'); t.className = 't'; t.id = 't';
		const meta = document.createElement('div'); meta.className = 'meta'; meta.id = 'meta'; meta.hidden = true;

		b.append(f);
		g.append(b, marks);
		r.append(i, g, t);
		o.append(r, meta);
		ws.append(css, o);
		state.host = h;
		state.root = ws;
	}
	activateFeedbackSurface(state.host);

	const o = state.root.getElementById('o');
	const meta = state.root.getElementById('meta');
	if (!o || !meta) return;

	o.classList.add('v');
	paintOSDColor(state.root, payload);
	const alternate = options.variant === 'alternate-target';
	meta.toggleAttribute('hidden', !alternate);
	meta.textContent = alternate
		? `↗ ${options.targetTitle || options.targetHostname || ''}${options.targetTitle && options.targetHostname ? ` · ${options.targetHostname}` : ''}`
		: '';

	if (state.lastType !== payload.type) renderMarkers(state.root, payload.type);
	state.presentation = payload;
	if (animate) {
		animateScalarValue(state.root, payload, s);
	} else {
		cancelValueAnimation();
		state.displayedValue = payload.value;
		paintScalarValue(state.root, payload, payload.value, s);
	}
	state.lastType = payload.type;
	if (refreshHide) scheduleOSDHide();
}

// eff: removes feedback immediately only at a real lifecycle boundary.
export function hideOSD(preserveShortcutTarget = false): void {
	if (state.timer) clearTimeout(state.timer);
	concealOSD();
	if (!preserveShortcutTarget) {
		state.hotkey = null;
		state.claimedGesture = null;
	}
}
