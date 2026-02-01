// goal: transient notifications

interface ToastState { root: ShadowRoot | null; timer: ReturnType<typeof setTimeout> | null; }
const state: ToastState = { root: null, timer: null };

export function showToast(msg: string): void {
	if (!document.body) return;

	if (!state.root) {
		const host = document.createElement('div');
		host.id = 'spectra-toast-host';
		host.style.cssText = 'position:fixed;top:20%;left:50%;transform:translateX(-50%);z-index:2147483647;pointer-events:none';
		document.body.appendChild(host);

		const ws = host.attachShadow({ mode: 'open' });
		const style = document.createElement('style');
		style.textContent = '.t{background:rgba(20,20,30,0.92);backdrop-filter:blur(10px);padding:14px 24px;border-radius:14px;color:#fff;font-family:system-ui;transition:0.3s;opacity:0;transform:translateY(-15px);display:flex;align-items:center;box-shadow:0 8px 32px rgba(0,0,0,0.3);border:1px solid rgba(255,255,255,0.1)}.v{opacity:1;transform:translateY(0)}.txt{font-size:14px;font-weight:500;white-space:nowrap}';

		const div = document.createElement('div');
		div.className = 't';
		div.id = 't';

		const span = document.createElement('span');
		span.className = 'txt';
		span.id = 'txt';

		div.appendChild(span);
		ws.append(style, div);
		state.root = ws;
	}

	const toast = state.root.getElementById('t');
	const text = state.root.getElementById('txt');
	if (!toast || !text) return;

	text.textContent = msg;
	toast.classList.add('v');

	if (state.timer) clearTimeout(state.timer);
	state.timer = setTimeout(() => toast.classList.remove('v'), 3000);
}
