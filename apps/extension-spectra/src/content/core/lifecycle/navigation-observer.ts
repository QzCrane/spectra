// goal: consumes browser-owned same-document navigation signals without patching page history

import { isExtensionContextValid } from '../context-guard';
import { createEventListener, createCleanupManager } from '../../utils/timing';

interface NavigationObserverDeps {
	onNavigate: () => void;
}

export function getDocumentRouteIdentity(location: Pick<Location, 'origin' | 'pathname' | 'search' | 'hash'>): string {
	return `${location.origin}${location.pathname}${location.search}${location.hash}`;
}

export const SPECTRA_SAME_DOCUMENT_NAVIGATION_EVENT = 'spectra:same-document-navigation';

export function createNavigationObserver(deps: NavigationObserverDeps): () => void {
	const { onNavigate } = deps;
	const cleanup = createCleanupManager();
	let lastRoute = getDocumentRouteIdentity(window.location);

	const handleNav = () => {
		if (!isExtensionContextValid()) return;
		const currentRoute = getDocumentRouteIdentity(window.location);
		if (currentRoute === lastRoute) return;

		// Invalidate the previous document generation immediately. Delaying this
		// behind a debounce would leave a window in which an ACK from the previous
		// query/hash route could still be accepted.
		lastRoute = currentRoute;
		onNavigate();
	};

	cleanup.add(createEventListener(window, 'popstate', handleNav));
	cleanup.add(createEventListener(window, 'hashchange', handleNav));
	cleanup.add(createEventListener(window, SPECTRA_SAME_DOCUMENT_NAVIGATION_EVENT, handleNav));

	return cleanup.dispose;
}
