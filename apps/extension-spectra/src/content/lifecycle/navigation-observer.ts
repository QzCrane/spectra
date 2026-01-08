// goal: detects Single Page Application (SPA) route changes to refresh site-specific configurations and re-probe CORS status
// note: native popstate doesn't trigger on pushState/replaceState, so monkeypatching the History API is necessary

import { isExtensionContextValid } from '../context-guard';
import type { PolicyExecutor } from '../policy-executor';

interface NavigationObserverDeps {
	policyExecutor: PolicyExecutor;
	onNavigate: () => void;
}

// eff: initializes listeners and patches the window.history object to monitor URL transitions
// post: returns a cleanup function to restore original history methods and remove listeners
export function createNavigationObserver(deps: NavigationObserverDeps): () => void {
	const { policyExecutor, onNavigate } = deps;

	let lastPathname = window.location.pathname;
	let debounceTimer: ReturnType<typeof setTimeout> | null = null;

	// eff: evaluates if the URL path has materially changed and triggers a debounced re-probing of the audio policy
	const handleNavigation = () => {
		if (!isExtensionContextValid()) return;

		const currentPathname = window.location.pathname;

		// rule: ignore hash or query parameter changes to prevent redundant processing on purely client-side UI state shifts
		if (currentPathname === lastPathname) return;

		lastPathname = currentPathname;

		// rule: apply a 300ms debounce to stabilize state during rapid navigation sequences
		if (debounceTimer) clearTimeout(debounceTimer);
		debounceTimer = setTimeout(() => {
			if (!isExtensionContextValid()) return;

			policyExecutor.probeCors();
			onNavigate();
		}, 300);
	};

	window.addEventListener('popstate', handleNavigation);

	// eff: intercept history.pushState to catch programmatic navigation
	const originalPushState = history.pushState;
	history.pushState = function (...args) {
		originalPushState.apply(this, args);
		setTimeout(handleNavigation, 0);
	};

	// eff: intercept history.replaceState for URL normalization/redirection events
	const originalReplaceState = history.replaceState;
	history.replaceState = function (...args) {
		originalReplaceState.apply(this, args);
		setTimeout(handleNavigation, 0);
	};

	return () => {
		if (debounceTimer) clearTimeout(debounceTimer);
		window.removeEventListener('popstate', handleNavigation);
		history.pushState = originalPushState;
		history.replaceState = originalReplaceState;
	};
}
