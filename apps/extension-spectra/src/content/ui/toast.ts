// goal: provides transient visual notifications for background processes (e.g. auto-registry additions)

interface ToastState {
	container: ShadowRoot | null;
	timer: ReturnType<typeof setTimeout> | null;
}

const state: ToastState = {
	container: null,
	timer: null,
};

// eff: displays a toast message for 3 seconds; re-uses existing shadow host if available
export function showToast(message: string): void {
	if (!document.body) return;

	if (!state.container) createToast();
	if (!state.container) return;

	const toast = state.container.getElementById('toast');
	const text = state.container.getElementById('toast-text');

	if (!toast || !text) return;

	text.innerText = message;
	toast.classList.add('visible');

	if (state.timer) clearTimeout(state.timer);
	state.timer = setTimeout(() => toast.classList.remove('visible'), 3000);
}

// goal: injects a shadow DOM host into the page to prevent host site CSS from polluting toast styles
function createToast(): void {
	if (!document.body) return;

	const host = document.createElement('div');
	host.id = 'spectra-toast-host';
	host.style.cssText = 'position: fixed; top: 20%; left: 50%; transform: translateX(-50%); z-index: 2147483647; pointer-events: none;';
	document.body.appendChild(host);

	const shadow = host.attachShadow({ mode: 'open' });
	shadow.innerHTML = `
    <style>
      .toast { background: rgba(20,20,30,0.92); backdrop-filter: blur(10px); padding: 14px 24px; border-radius: 14px; color: white; font-family: system-ui, sans-serif; transition: opacity 0.3s, transform 0.3s; opacity: 0; transform: translateY(-15px); display: flex; align-items: center; gap: 12px; box-shadow: 0 8px 32px rgba(0,0,0,0.3); border: 1px solid rgba(255,255,255,0.1); }
      .toast.visible { opacity: 1; transform: translateY(0); }
      .toast-text { font-size: 14px; font-weight: 500; white-space: nowrap; }
    </style>
    <div class="toast" id="toast">
      <span class="toast-text" id="toast-text"></span>
    </div>
  `;
	state.container = shadow;
}
