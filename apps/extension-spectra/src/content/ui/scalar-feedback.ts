// goal: one linear value-to-visual contract for every scalar feedback bar

export type ScalarFeedbackKind = 'volume' | 'speed';

export interface ScalarFeedbackMarker {
	value: number;
	label: string;
	lane: 'upper' | 'lower';
}

interface ScalarFeedbackScale {
	min: number;
	max: number;
	step: number;
	markers: readonly ScalarFeedbackMarker[];
}

const SCALAR_FEEDBACK_SCALES = {
	volume: {
		min: 0,
		max: 800,
		step: 10,
		markers: [
			{ value: 100, label: '100%', lane: 'lower' },
		],
	},
	speed: {
		min: 0.1,
		max: 16,
		step: 0.1,
		markers: [
			{ value: 1, label: '1×', lane: 'lower' },
			{ value: 2, label: '2×', lane: 'upper' },
		],
	},
} as const satisfies Record<ScalarFeedbackKind, ScalarFeedbackScale>;

const FEEDBACK_STEP_DURATION_MS = 50;
const MAX_FEEDBACK_ANIMATION_MS = 300;
const MIN_FEEDBACK_ANIMATION_MS = 16;
const MAX_SHORTCUT_STEP_PER_FRAME = 0.6;

function scaleFor(kind: ScalarFeedbackKind): ScalarFeedbackScale {
	return SCALAR_FEEDBACK_SCALES[kind];
}

export function clampScalarFeedbackValue(
	kind: ScalarFeedbackKind,
	value: number,
): number {
	const scale = scaleFor(kind);
	return Math.max(scale.min, Math.min(scale.max, value));
}

// Linear normalization is deliberate: equal numeric deltas always occupy equal
// visual distances. Marker placement consumes this same function.
export function scalarFeedbackProgress(
	kind: ScalarFeedbackKind,
	value: number,
): number {
	const scale = scaleFor(kind);
	const clamped = clampScalarFeedbackValue(kind, value);
	return ((clamped - scale.min) / (scale.max - scale.min)) * 100;
}

export function scalarFeedbackMarkers(
	kind: ScalarFeedbackKind,
): readonly ScalarFeedbackMarker[] {
	return SCALAR_FEEDBACK_SCALES[kind].markers;
}

// Volume and speed use the same temporal rule: one shortcut-sized numeric step
// receives one 50 ms visual step, while large direct jumps stay bounded.
export function scalarFeedbackAnimationDuration(
	kind: ScalarFeedbackKind,
	from: number,
	to: number,
	targetIntervalMs?: number,
): number {
	if (targetIntervalMs !== undefined && Number.isFinite(targetIntervalMs)) {
		return Math.max(
			MIN_FEEDBACK_ANIMATION_MS,
			Math.min(FEEDBACK_STEP_DURATION_MS, targetIntervalMs),
		);
	}
	const scale = scaleFor(kind);
	const steps = Math.abs(to - from) / scale.step;
	return Math.min(
		MAX_FEEDBACK_ANIMATION_MS,
		Math.max(FEEDBACK_STEP_DURATION_MS, steps * FEEDBACK_STEP_DURATION_MS),
	);
}

// A delayed browser frame must not turn one discrete shortcut step into one
// visible jump. Both scalar kinds use the same fraction of their semantic step.
export function scalarFeedbackMaxFrameDelta(kind: ScalarFeedbackKind): number {
	return scaleFor(kind).step * MAX_SHORTCUT_STEP_PER_FRAME;
}
