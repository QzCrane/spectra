// goal: keeps page hotkeys behind the browser's user-activation boundary

// A page can dispatch arbitrary KeyboardEvent objects, but synthetic events
// always have isTrusted=false. Privileged actions must never run for them.
export function isTrustedHotkeyEvent(event: Pick<KeyboardEvent, 'isTrusted'>): boolean {
	return event.isTrusted === true;
}

const EDITABLE_HOTKEY_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT']);

export function isEditableHotkeyEvent(
	event: Pick<KeyboardEvent, 'composedPath'>,
): boolean {
	return event.composedPath().some((target) => target instanceof HTMLElement
		&& (target.isContentEditable || EDITABLE_HOTKEY_TAGS.has(target.tagName)));
}

interface WebsiteFirstKeyboardArbiterOptions<Candidate> {
	type: 'keydown' | 'keyup';
	resolveCandidate: (event: KeyboardEvent) => Candidate | null;
	onSettled: (
		event: KeyboardEvent,
		candidate: Candidate,
		websiteClaimed: boolean,
	) => void;
}

type PhysicalHotkeyReleaseListener = (event: Pick<KeyboardEvent, 'code'>) => void;
interface PhysicalHotkeyReleaseOwner {
	version: 1;
	listeners: Set<PhysicalHotkeyReleaseListener>;
}
const PHYSICAL_RELEASE_OWNER_KEY = '__spectraPhysicalHotkeyReleaseV1';
type PhysicalReleaseGlobal = typeof globalThis & {
	[PHYSICAL_RELEASE_OWNER_KEY]?: PhysicalHotkeyReleaseOwner;
};

// The first document-start Bootstrap installs one stable capture observer.
// Revision replacement only hands off its subscriber; it never unregisters and
// re-appends the observer behind website capture listeners created meanwhile.
// The document lifetime itself owns the sole raw listener.
export function subscribeDocumentStartPhysicalHotkeyRelease(
	listener: PhysicalHotkeyReleaseListener,
): () => void {
	const scope = globalThis as PhysicalReleaseGlobal;
	let owner = scope[PHYSICAL_RELEASE_OWNER_KEY];
	if (owner?.version !== 1) {
		owner = { version: 1, listeners: new Set() };
		scope[PHYSICAL_RELEASE_OWNER_KEY] = owner;
		window.addEventListener('keyup', (rawEvent) => {
			const event = rawEvent as KeyboardEvent;
			if (!event.isTrusted || event.code.length === 0) return;
			const current = (globalThis as PhysicalReleaseGlobal)[PHYSICAL_RELEASE_OWNER_KEY];
			if (current?.version !== 1) return;
			for (const subscriber of current.listeners) subscriber(event);
		}, true);
	}
	owner.listeners.add(listener);
	return () => owner?.listeners.delete(listener);
}

// Window capture only schedules a tail for the same physical event. The tail is
// appended after every website window listener that already exists for that
// dispatch, so target/document/window handlers can claim the chord first with
// preventDefault, stopPropagation, or stopImmediatePropagation. A macrotask
// removes tails that propagation never reaches; a microtask would run before
// the event reaches window bubble and is therefore incorrect. The candidate is
// resolved once at capture and carried to settlement, so a settings change in
// another listener cannot remap one physical event midway through dispatch.
export function createWebsiteFirstKeyboardArbiter<Candidate>(
	options: WebsiteFirstKeyboardArbiterOptions<Candidate>,
): () => void {
	const pending = new Map<KeyboardEvent, {
		candidate: Candidate;
		tail: EventListener;
		cleanupTimer: ReturnType<typeof setTimeout>;
	}>();

	const clearPending = (event: KeyboardEvent): {
		candidate: Candidate;
		tail: EventListener;
		cleanupTimer: ReturnType<typeof setTimeout>;
	} | null => {
		const owned = pending.get(event);
		if (!owned) return null;
		pending.delete(event);
		window.removeEventListener(options.type, owned.tail);
		clearTimeout(owned.cleanupTimer);
		return owned;
	};

	const capture = (rawEvent: Event): void => {
		const event = rawEvent as KeyboardEvent;
		if (pending.has(event)) return;
		const candidate = options.resolveCandidate(event);
		if (candidate === null) return;
		const tail: EventListener = (tailEvent) => {
			if (tailEvent !== event) return;
			const owned = clearPending(event);
			if (!owned) return;
			options.onSettled(
				event,
				owned.candidate,
				event.defaultPrevented || event.cancelBubble,
			);
		};
		window.addEventListener(options.type, tail);
		const cleanupTimer = setTimeout(() => {
			const owned = clearPending(event);
			if (!owned) return;
			options.onSettled(event, owned.candidate, true);
		}, 0);
		pending.set(event, { candidate, tail, cleanupTimer });
	};

	window.addEventListener(options.type, capture, true);
	return () => {
		window.removeEventListener(options.type, capture, true);
		for (const [event] of pending) clearPending(event);
	};
}
