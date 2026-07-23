// goal: one side-effect-free boundary for detecting and retiring invalid extension contexts

export function isExtensionContextValid(): boolean {
	try {
		return Boolean(chrome.runtime?.id);
	} catch {
		return false;
	}
}

export function isExtensionContextInvalidatedError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return message.includes('Extension context invalidated');
}

// post: known extension-reload invalidation resolves to undefined and invokes
// the disposer exactly once; unrelated transport and application errors remain visible.
export async function runWithValidExtensionContext<T>(
	operation: () => Promise<T>,
	onInvalidated?: () => void,
): Promise<T | undefined> {
	let retired = false;
	const retire = () => {
		if (retired) return;
		retired = true;
		onInvalidated?.();
	};

	if (!isExtensionContextValid()) {
		retire();
		return undefined;
	}
	try {
		return await operation();
	} catch (error) {
		if (!isExtensionContextInvalidatedError(error)) throw error;
		retire();
		return undefined;
	}
}
