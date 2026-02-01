// goal: transient visual notifications
const s: { root: ShadowRoot | null; timer: ReturnType<typeof setTimeout> | null } = { root: null, timer: null };

export function showToast(msg: string): void {
	if (!document.body) return;
	if (!s.root) {
		const h = document.createElement('div');
		h.id = 'spectra-toast-host';
		h.style.cssText = 'position:fixed;top:20%;left:50%;transform:translateX(-50%);z-index:2147483647;pointer-events:none';
		document.body.appendChild(h);

		const ws = h.attachShadow({ mode: 'open' });
		const st = document.createElement('style');
		st.textContent = '.t{background:rgba(20,20,30,0.92);backdrop-filter:blur(10px);padding:14px 24px;border-radius:14px;color:#fff;font-family:system-ui;transition:0.3s;opacity:0;transform:translateY(-15px);display:flex;align-items:center;box-shadow:0 8px 32px rgba(0,0,0,0.3);border:1px solid rgba(255,255,255,0.1)}.v{opacity:1;transform:translateY(0)}.txt{font-size:14px;font-weight:500;white-space:nowrap}';

		const d = document.createElement('div');
		d.className = 't'; d.id = 't';
		const txt = document.createElement('span');
		txt.className = 'txt'; txt.id = 'txt';
		d.appendChild(txt);
		ws.append(st, d);
		s.root = ws;
	}

	const t = s.root.getElementById('t');
	const txt = s.root.getElementById('txt');
	if (!t || !txt) return;

	txt.textContent = msg;
	t.classList.add('v');
	if (s.timer) clearTimeout(s.timer);
	s.timer = setTimeout(() => t.classList.remove('v'), 3000);
}
