// goal: keeps page hotkeys behind the browser's user-activation boundary

// A page can dispatch arbitrary KeyboardEvent objects, but synthetic events
// always have isTrusted=false. Privileged actions must never run for them.
export function isTrustedHotkeyEvent(event: Pick<KeyboardEvent, 'isTrusted'>): boolean {
	return event.isTrusted === true;
}
