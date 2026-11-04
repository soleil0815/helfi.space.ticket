// Pull-to-refresh for list pages: drag down at the top of the list, release to reload.
import { h, icon } from '/js/dom.js';

const THRESHOLD = 64;
const MAX = 96;

export function pullToRefresh(page, onRefresh) {
  const sc = page.scroll;
  const spin = h('div.m-ptr-spin', icon('refresh'));
  const ind = h('div.m-ptr', { 'aria-hidden': 'true' }, spin);
  page.el.append(ind);
  let s = null;
  let busy = false;

  const set = (px, animate) => {
    const tr = animate ? 'transform .2s ease-out, opacity .2s' : 'none';
    ind.style.transition = tr;
    page.body.style.transition = animate ? 'transform .2s ease-out' : 'none';
    ind.style.transform = `translate3d(-50%,${px - 44}px,0)`;
    ind.style.opacity = String(Math.min(1, px / THRESHOLD));
    spin.style.transform = busy ? '' : `rotate(${px * 4}deg)`;
    page.body.style.transform = px ? `translate3d(0,${px * 0.6}px,0)` : '';
  };

  sc.addEventListener('touchstart', (e) => {
    if (busy || e.touches.length !== 1 || sc.scrollTop > 0) { s = null; return; }
    s = { y0: e.touches[0].clientY, x0: e.touches[0].clientX, pull: 0, active: false };
  }, { passive: true });
  sc.addEventListener('touchmove', (e) => {
    if (!s) return;
    const dy = e.touches[0].clientY - s.y0;
    const dx = e.touches[0].clientX - s.x0;
    if (!s.active) {
      if (dy < 8 || Math.abs(dx) > dy || sc.scrollTop > 0) { if (dy < -4 || Math.abs(dx) > 8) s = null; return; }
      s.active = true;
    }
    e.preventDefault();
    s.pull = Math.min(MAX, (dy - 8) * 0.5);
    set(s.pull, false);
    ind.classList.toggle('ready', s.pull >= THRESHOLD);
  }, { passive: false });
  const end = async () => {
    if (!s) return;
    const st = s; s = null;
    if (!st.active) return;
    ind.classList.remove('ready');
    if (st.pull < THRESHOLD) { set(0, true); return; }
    busy = true;
    ind.classList.add('spinning');
    set(THRESHOLD, true);
    try { await onRefresh(); } catch { /* the page shows its own error */ }
    busy = false;
    ind.classList.remove('spinning');
    set(0, true);
  };
  sc.addEventListener('touchend', end);
  sc.addEventListener('touchcancel', end);
}
