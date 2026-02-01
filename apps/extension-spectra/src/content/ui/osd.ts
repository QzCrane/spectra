// goal: transient visual feedback (On-Screen Display) for adjustments

import type { AudioConfig } from '@nexus/kernel';
import type { ContentGlobalSettings } from '../core/settings-manager';

interface OSDState { root: ShadowRoot | null; timer: ReturnType<typeof setTimeout> | null; }
const state: OSDState = { root: null, timer: null };

export function showOSD(c: AudioConfig, cap: boolean, s: ContentGlobalSettings, pop: boolean): void {
	if (pop || !s.osdEnabled || !c.enabled) return;

	if (!state.root) {
		const h = document.createElement('div');
		h.style.cssText = 'position:fixed;top:15%;left:50%;transform:translateX(-50%);z-index:2147483647;pointer-events:none';
		document.body.appendChild(h);

		const ws = h.attachShadow({ mode: 'open' });
		const css = document.createElement('style');
		css.textContent = `.o{background:rgba(20,20,30,0.85);backdrop-filter:blur(8px);padding:12px 20px;border-radius:30px;color:#fff;display:flex;align-items:center;gap:12px;font-family:system-ui;transition:0.2s;opacity:0;transform:translateY(-10px)}.v{opacity:1;transform:translateY(0)}.b{width:120px;height:6px;background:rgba(255,255,255,0.2);border-radius:3px;overflow:hidden;position:relative}.f{height:100%;width:0%;transition:width 0.05s linear;background:#3b82f6}.c .f{background:#8b5cf6}.m .f{background:#9ca3af}.mr{position:absolute;left:12.5%;top:0;bottom:0;width:2px;background:rgba(255,255,255,0.6);z-index:5}.t{font-weight:600;font-size:14px;min-width:40px;text-align:right}`;

		const o = document.createElement('div'); o.className = 'o'; o.id = 'o';
		const i = document.createElement('span'); i.id = 'i';
		const b = document.createElement('div'); b.className = 'b';
		const m = document.createElement('div'); m.className = 'mr';
		const f = document.createElement('div'); f.className = 'f'; f.id = 'f';
		const t = document.createElement('span'); t.className = 't'; t.id = 't';

		b.append(m, f);
		o.append(i, b, t);
		ws.append(css, o);
		state.root = ws;
	}

	const o = state.root.getElementById('o');
	const f = state.root.getElementById('f');
	const t = state.root.getElementById('t');
	const i = state.root.getElementById('i');
	if (!o || !f || !t || !i) return;

	o.classList.add('v');
	o.classList.toggle('c', cap);

	const muted = c.muted || c.volume === 0;
	o.classList.toggle('m', muted);

	f.style.width = Math.min(100, (c.volume / 800) * 100) + '%';
	t.textContent = muted ? 'MUTE' : c.volume + '%';
	i.textContent = muted ? '🔇' : (c.volume > 100 ? '🚀' : '🔊');

	if (state.timer) clearTimeout(state.timer);
	state.timer = setTimeout(() => o.classList.remove('v'), 2000);
}
