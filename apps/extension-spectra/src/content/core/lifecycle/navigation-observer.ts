// goal: detects SPA route changes to refresh site-specific configs
// note: monkeypatching History API for pushState/replaceState

import { isExtensionContextValid } from '../context-guard';
import type { PolicyExecutor } from '../../logic/policy-executor';

interface NavigationObserverDeps {
	policyExecutor: PolicyExecutor;
	onNavigate: () => void;
}

// eff: single timer instance properly cleared
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let lastPath = '';

export function createNavigationObserver(deps: NavigationObserverDeps): () => void {
	const { policyExecutor, onNavigate } = deps;
	lastPath = window.location.pathname;

	const handleNav = () => {
		if (!isExtensionContextValid()) return;
		const cur = window.location.pathname;
		if (cur === lastPath) return; // Ignore hash/query

		lastPath = cur;
		if (debounceTimer) clearTimeout(debounceTimer);

		debounceTimer = setTimeout(() => {
			if (!isExtensionContextValid()) return;
			policyExecutor.probeCors();
			onNavigate();
			debounceTimer = null;
		}, 300);
	};

	window.addEventListener('popstate', handleNav);

	const origPush = history.pushState;
	history.pushState = function (...args) {
		origPush.apply(this, args);
		handleNav();
	};

	const origReplace = history.replaceState;
	history.replaceState = function (...args) {
		origReplace.apply(this, args);
		handleNav();
	};

	return () => {
		if (debounceTimer) clearTimeout(debounceTimer);
		window.removeEventListener('popstate', handleNav);
		history.pushState = origPush;
		history.replaceState = origReplace;
	};
}
