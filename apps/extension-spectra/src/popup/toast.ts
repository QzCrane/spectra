// goal: one accessible transient-feedback surface for every popup feature

let activeToast: HTMLElement | null = null;
let removalTimer: ReturnType<typeof setTimeout> | null = null;

export function showPopupToast(message: string, tone: 'status' | 'error' = 'status'): void {
	if (removalTimer !== null) clearTimeout(removalTimer);
	activeToast?.remove();

	const toast = document.createElement('div');
	toast.className = `preset-toast popup-toast-${tone}`;
	toast.setAttribute('role', tone === 'error' ? 'alert' : 'status');
	toast.setAttribute('aria-live', tone === 'error' ? 'assertive' : 'polite');
	toast.setAttribute('aria-atomic', 'true');
	toast.textContent = message;
	document.body.appendChild(toast);
	activeToast = toast;

	removalTimer = setTimeout(() => {
		toast.classList.add('fade-out');
		removalTimer = setTimeout(() => {
			toast.remove();
			if (activeToast === toast) activeToast = null;
			removalTimer = null;
		}, 300);
	}, 3_500);
}
