// goal: enforce CORS crossorigin attribute on all media elements
// theory: hijack createElement to inject crossorigin before site scripts access

export function enforceCORS(): void {
	const originalCreateElement = document.createElement;
	const originalCreateElementNS = document.createElementNS;
	const OriginalAudio = window.Audio;

	const enforceCrossOrigin = (element: HTMLElement, tagName: string) => {
		if (tagName && (tagName.toLowerCase() === 'video' || tagName.toLowerCase() === 'audio')) {
			element.setAttribute('crossorigin', 'anonymous');
		}
	};

	document.createElement = function (tagName: string, options?: ElementCreationOptions) {
		const element = originalCreateElement.call(this, tagName, options);
		enforceCrossOrigin(element, tagName);
		return element;
	};

	// @ts-expect-error: Override with simplified signature
	document.createElementNS = function (ns: string | null, tagName: string, options?: ElementCreationOptions) {
		const element = originalCreateElementNS.call(this, ns, tagName, options);
		enforceCrossOrigin(element as HTMLElement, tagName);
		return element;
	};

	window.Audio = function (src?: string) {
		const element = new OriginalAudio(src);
		element.setAttribute('crossorigin', 'anonymous');
		ensureInDom(element);
		return element;
	} as any;
	window.Audio.prototype = OriginalAudio.prototype;
}

// eff: ensures detached Audio elements are reachable for scanning
function ensureInDom(element: HTMLAudioElement) {
	if (!document.body) {
		document.addEventListener('DOMContentLoaded', () => ensureInDom(element));
		return;
	}
	let container = document.getElementById('spectra-hidden-container');
	if (!container) {
		container = document.createElement('div');
		container.id = 'spectra-hidden-container';
		container.style.cssText = 'position:absolute;top:-9999px;left:-9999px;width:1px;height:1px;overflow:hidden;opacity:0;pointer-events:none;';
		document.body.appendChild(container);
	}
	if (!element.parentNode) {
		container.appendChild(element);
	}
}
