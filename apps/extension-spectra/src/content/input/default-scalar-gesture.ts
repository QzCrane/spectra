// goal: share exact hotkey gesture lifecycle between the document-start
// bootstrap input owner and the lazily mounted full Content runtime

import type { SpectraDefaultHotkeyAction } from '@nexus/contracts/bootstrap';

export interface DefaultScalarGestureSignal {
	gesture: string;
	action: SpectraDefaultHotkeyAction;
	phase: 'press' | 'release' | 'settled';
	repeated: boolean;
}

type DefaultScalarGestureListener = (signal: DefaultScalarGestureSignal) => void;

export interface PhysicalHotkeyReleaseSignal {
	code: string;
}

type PhysicalHotkeyReleaseListener = (signal: PhysicalHotkeyReleaseSignal) => void;

interface HotkeyGestureChannel {
	version: 3;
	sequence: number;
	listeners: Set<DefaultScalarGestureListener>;
	pending: DefaultScalarGestureSignal[];
	releaseListeners: Set<PhysicalHotkeyReleaseListener>;
}

const CHANNEL_KEY = '__spectraHotkeyGestureV3';
const MAX_PENDING_SIGNALS = 160;

type GestureGlobal = typeof globalThis & {
	[CHANNEL_KEY]?: HotkeyGestureChannel;
};

function channel(): HotkeyGestureChannel {
	const owner = globalThis as GestureGlobal;
	const current = owner[CHANNEL_KEY];
	if (current?.version === 3) return current;
	const created: HotkeyGestureChannel = {
		version: 3,
		sequence: 0,
		listeners: new Set(),
		pending: [],
		releaseListeners: new Set(),
	};
	owner[CHANNEL_KEY] = created;
	return created;
}

// One isolated-world sequence survives bootstrap/runtime reinjection, so a
// late release from an older bundle can never settle a newer gesture.
export function nextScalarGestureId(namespace: 'default' | 'site'): string {
	const owner = channel();
	owner.sequence = owner.sequence >= Number.MAX_SAFE_INTEGER ? 1 : owner.sequence + 1;
	return `${namespace}:${owner.sequence}`;
}

export function publishDefaultScalarGesture(signal: DefaultScalarGestureSignal): void {
	const owner = channel();
	if (owner.listeners.size === 0) {
		if (owner.pending.length >= MAX_PENDING_SIGNALS) owner.pending.shift();
		owner.pending.push(signal);
		return;
	}
	for (const listener of owner.listeners) listener(signal);
}

export function subscribeDefaultScalarGesture(
	listener: DefaultScalarGestureListener,
): () => void {
	const owner = channel();
	owner.listeners.add(listener);
	const pending = owner.pending.splice(0);
	for (const signal of pending) listener(signal);
	return () => owner.listeners.delete(listener);
}

// Site bindings can only become active after the full runtime subscribes, so
// releases need no replay queue. Bootstrap publishes them synchronously from
// its document-start capture observer before website propagation can hide them.
export function publishPhysicalHotkeyRelease(signal: PhysicalHotkeyReleaseSignal): void {
	for (const listener of channel().releaseListeners) listener(signal);
}

export function subscribePhysicalHotkeyRelease(
	listener: PhysicalHotkeyReleaseListener,
): () => void {
	const owner = channel();
	owner.releaseListeners.add(listener);
	return () => owner.releaseListeners.delete(listener);
}
