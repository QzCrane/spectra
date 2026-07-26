// goal: transient visual notifications
import { activateFeedbackSurface, createFeedbackSurface } from './feedback-surface';

const s: {
	host: HTMLElement | null;
	root: ShadowRoot | null;
	timer: ReturnType<typeof setTimeout> | null;
	shortcutGesture: string | null;
} = { host: null, root: null, timer: null, shortcutGesture: null };

export interface ToastOptions {
	variant?: 'alternate-target';
	targetTitle?: string;
	targetHostname?: string;
	shortcutGesture?: string;
}

const TOAST_HIDE_DELAY_MS = 1_800;

function scheduleToastHide(toast: HTMLElement): void {
	if (s.timer) clearTimeout(s.timer);
	s.timer = setTimeout(() => {
		toast.classList.add('hide');
		s.timer = null;
	}, TOAST_HIDE_DELAY_MS);
}

export function showToast(msg: string, options: ToastOptions = {}): void {
	if (!document.documentElement) return;
	if (!s.host?.isConnected || !s.root) {
		const surface = createFeedbackSurface(
			'spectra-toast-host',
			'position:fixed;top:20%;left:50%;transform:translateX(-50%);z-index:2147483647',
		);
		const h = surface.host;
		const ws = surface.root;
		const st = document.createElement('style');
		// note: toast must appear INSTANTLY (no fade-in delay). Only fade OUT when hiding.
		// The previous `transition:0.3s;opacity:0` initial state caused a 300ms perceived delay.
		st.textContent = '.t{background:rgba(20,20,30,0.92);backdrop-filter:blur(10px);padding:14px 24px;border-radius:14px;color:#fff;font-family:system-ui;opacity:1;transform:translateY(0);display:flex;align-items:center;box-shadow:0 8px 32px rgba(0,0,0,0.3);border:1px solid rgba(255,255,255,0.1);transition:opacity 0.25s ease,transform 0.25s ease}.t.hide{opacity:0;transform:translateY(-15px)}.body{display:grid;gap:3px;min-width:0}.txt{font-size:14px;font-weight:500;white-space:nowrap}.meta{max-width:min(480px,70vw);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;opacity:.78}.meta[hidden]{display:none}';

		const d = document.createElement('div');
		d.className = 't'; d.id = 't';
		const txt = document.createElement('span');
		txt.className = 'txt'; txt.id = 'txt';
		const meta = document.createElement('span');
		meta.className = 'meta'; meta.id = 'meta'; meta.hidden = true;
		const body = document.createElement('span');
		body.className = 'body';
		body.append(txt, meta);
		d.appendChild(body);
		ws.append(st, d);
		s.host = h;
		s.root = ws;
	}
	activateFeedbackSurface(s.host);

	const t = s.root.getElementById('t');
	const txt = s.root.getElementById('txt');
	const meta = s.root.getElementById('meta');
	if (!t || !txt || !meta) return;

	txt.textContent = msg;
	const alternate = options.variant === 'alternate-target';
	meta.toggleAttribute('hidden', !alternate);
	meta.textContent = alternate
		? `↗ ${options.targetTitle || options.targetHostname || ''}${options.targetTitle && options.targetHostname ? ` · ${options.targetHostname}` : ''}`
		: '';
	s.shortcutGesture = options.shortcutGesture ?? null;
	// Force reflow then remove hide class so toast appears INSTANTLY.
	t.classList.remove('hide');
	// Force browser to apply the visible state synchronously before scheduling hide.
	void t.offsetHeight;
	scheduleToastHide(t);
}

// Keyup freezes a held label and restarts its readable display window. It does
// not share ownership with cancellation of the underlying shortcut writer.
export function freezeHotkeyToast(gesture: string): void {
	if (s.shortcutGesture !== gesture) return;
	const toast = s.root?.getElementById('t');
	if (!toast) return;
	toast.classList.remove('hide');
	void toast.offsetHeight;
	scheduleToastHide(toast);
}

export function releaseHotkeyToast(gesture: string): void {
	if (s.shortcutGesture === gesture) s.shortcutGesture = null;
}

// eff: hides feedback immediately only when its UI lifecycle actually ends.
export function hideToast(): void {
	if (s.timer) {
		clearTimeout(s.timer);
		s.timer = null;
	}
	s.shortcutGesture = null;
	s.root?.getElementById('t')?.classList.add('hide');
}
