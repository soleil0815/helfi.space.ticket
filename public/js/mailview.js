// Formatted view of HTML emails: sandboxed frame (no scripts), toggle “Formatted | Text”
import { h, mount } from './dom.js';
import { t } from './i18n.js';

const KEY = 'helfi.mailView';
export function mailViewMode() {
  try { return localStorage.getItem(KEY) === 'text' ? 'text' : 'html'; } catch { return 'html'; }
}
function setMode(m) { try { localStorage.setItem(KEY, m); } catch { /* ignore */ } }

/** Frame that adapts to the height of its content */
export function mailFrame(src) {
  // allow-same-origin only so the height can be measured – scripts are never allowed in the frame
  const frame = h('iframe.mail-frame', {
    src, title: t('mail.view.formatted'), loading: 'lazy', referrerpolicy: 'no-referrer',
    sandbox: 'allow-same-origin allow-popups allow-popups-to-escape-sandbox',
  });
  const fit = () => {
    try {
      const doc = frame.contentDocument;
      if (!doc?.documentElement) return;
      frame.style.height = `${Math.min(Math.max(doc.documentElement.scrollHeight, 24), 20000)}px`;
    } catch { /* foreign origin – default height */ }
  };
  frame.addEventListener('load', () => {
    fit();
    try {
      const doc = frame.contentDocument;
      // Images, expanding quoted text, window size
      doc.addEventListener('toggle', fit, true);
      doc.querySelectorAll('img').forEach((img) => img.addEventListener('load', fit));
      if (window.ResizeObserver) new ResizeObserver(fit).observe(doc.body);
    } catch { /* ignore */ }
  });
  return frame;
}

/**
 * Content with toggle. textView: () => element (text version), src: URL of the formatted version.
 */
export function mailView(textView, src) {
  let mode = mailViewMode();
  const body = h('div.mail-view-body');
  const btn = (m, label) => h('button.mail-switch-btn', { type: 'button', 'aria-pressed': String(mode === m), onclick: () => { mode = m; setMode(m); draw(); } }, label);
  const bar = h('div.mail-switch', { role: 'group', 'aria-label': t('mail.view.label') });
  const draw = () => {
    mount(bar, btn('html', t('mail.view.formatted')), btn('text', t('mail.view.text')));
    mount(body, mode === 'html' ? mailFrame(src) : textView());
  };
  draw();
  return h('div.mail-view', bar, body);
}
