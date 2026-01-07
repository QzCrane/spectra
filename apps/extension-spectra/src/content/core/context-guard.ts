// goal: prevents "Extension context invalidated" runtime errors by validating the environment before browser API calls

import { logger } from '../../shared/logger';

const log = logger.content;

// post: returns true if the extension runtime is still active; false if reloaded or updated
export function isExtensionContextValid(): boolean {
	try {
		return !!chrome.runtime?.id;
	} catch {
		return false;
	}
}

// eff: executes a message-sending function only if the context is valid, suppressing invalidation errors
// post: returns the actual result or a fallback value if the context is lost
export async function safeSend<T>(
	sendFn: () => Promise<T>,
	fallback?: T
): Promise<T | undefined> {
	if (!isExtensionContextValid()) {
		log.debug('Extension context invalidated, skipping message.');
		return fallback;
	}
	try {
		return await sendFn();
	} catch (e) {
		// rule: specifically intercept known invalidation patterns to prevent unhandled promise rejections
		if (String(e).includes('Extension context invalidated') ||
			String(e).includes('message port closed')) {
			log.debug('Extension context invalidated during send.');
			return fallback;
		}
		throw e;
	}
}
