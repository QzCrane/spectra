// goal: detects SPA route changes to refresh site-specific configs
// note: monkeypatching History API for pushState/replaceState

import { isExtensionContextValid } from '../context-guard';
import { debounce, createEventListener, createCleanupManager } from '../../utils/timing';
import type { PolicyExecutor } from '../../logic/policy-executor';
// note: site cache management is now handled by the bridge instance itself during re-matching

interface NavigationObserverDeps {
	policyExecutor: PolicyExecutor;
	onNavigate: () => void;
}

let lastPath = '';

export function createNavigationObserver(deps: NavigationObserverDeps): () => void {
	const { policyExecutor, onNavigate } = deps;
	const cleanup = createCleanupManager();
	lastPath = window.location.pathname;

	const handleNav = () => {
		if (!isExtensionContextValid()) return;
		const cur = window.location.pathname;
		if (cur === lastPath) return;

		lastPath = cur;
		debouncedNav();
	};

	const debouncedNav = debounce(() => {
		if (!isExtensionContextValid()) return;
		policyExecutor.probeCors();
		onNavigate();
	}, 300);

	cleanup.add(createEventListener(window, 'popstate', handleNav));

	const origPush = history.pushState;
	const origReplace = history.replaceState;
	history.pushState = function (...args) { origPush.apply(this, args); handleNav(); };
	history.replaceState = function (...args) { origReplace.apply(this, args); handleNav(); };

	cleanup.add(() => {
		debouncedNav.cancel();
		history.pushState = origPush;
		history.replaceState = origReplace;
	});

	return cleanup.dispose;
}
