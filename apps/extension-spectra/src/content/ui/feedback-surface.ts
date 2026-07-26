// goal: owns one browser top-layer host for transient Content feedback
// rule: feedback competes in the browser top layer, never in a site's z-index stack

export interface FeedbackSurface {
	host: HTMLElement;
	root: ShadowRoot;
}

const feedbackHosts = new Set<HTMLElement>();
let fullscreenListenerInstalled = false;

function fallbackParent(): HTMLElement {
	const fullscreen = document.fullscreenElement;
	return fullscreen instanceof HTMLElement && !(fullscreen instanceof HTMLMediaElement)
		? fullscreen
		: document.documentElement;
}

function showInTopLayer(host: HTMLElement, reorder = false): void {
	try {
		if (reorder && host.matches(':popover-open')) host.hidePopover();
		if (!host.matches(':popover-open')) host.showPopover();
	} catch {
		// Chrome 135+ supports manual popovers. Retain a lifecycle-correct
		// fullscreen descendant fallback for non-conforming embedded runtimes.
		fallbackParent().appendChild(host);
	}
}

function installFullscreenListener(): void {
	if (fullscreenListenerInstalled) return;
	fullscreenListenerInstalled = true;
	document.addEventListener('fullscreenchange', () => {
		for (const host of [...feedbackHosts]) {
			if (!host.isConnected) {
				feedbackHosts.delete(host);
				continue;
			}
			// Fullscreen itself enters the top layer after any existing popover.
			// Reopen feedback after that boundary so it remains above the video.
			showInTopLayer(host, true);
		}
	}, true);
}

export function createFeedbackSurface(id: string, layout: string): FeedbackSurface {
	const host = document.createElement('div');
	host.id = id;
	host.popover = 'manual';
	host.style.cssText = [
		layout,
		'right:auto',
		'bottom:auto',
		'border:0',
		'padding:0',
		'margin:0',
		'overflow:visible',
		'background:transparent',
		'pointer-events:none',
	].join(';');
	document.documentElement.appendChild(host);
	const root = host.attachShadow({ mode: 'open' });
	feedbackHosts.add(host);
	installFullscreenListener();
	showInTopLayer(host);
	return { host, root };
}

export function activateFeedbackSurface(host: HTMLElement): void {
	if (!host.isConnected) {
		document.documentElement.appendChild(host);
		feedbackHosts.add(host);
	}
	installFullscreenListener();
	showInTopLayer(host);
}
