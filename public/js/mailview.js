// Formatierte Ansicht von HTML-Mails: abgeschotteter Rahmen (keine Skripte), Umschalter „Formatiert | Text“
import { h, mount } from './dom.js';
import { t } from './i18n.js';

const KEY = 'helfi.mailView';
export function mailViewMode() {
  try { return localStorage.getItem(KEY) === 'text' ? 'text' : 'html'; } catch { return 'html'; }
}
function setMode(m) { try { localStorage.setItem(KEY, m); } catch { /* egal */ } }

/** Rahmen, der sich an die Höhe des Inhalts anpasst */
export function mailFrame(src) {
  // allow-same-origin nur, damit die Höhe gemessen werden kann – Skripte sind im Rahmen nie erlaubt
  const frame = h('iframe.mail-frame', {
    src, title: t('mail.view.formatted'), loading: 'lazy', referrerpolicy: 'no-referrer',
    sandbox: 'allow-same-origin allow-popups allow-popups-to-escape-sandbox',
  });
  const fit = () => {
    try {
      const doc = frame.contentDocument;
      if (!doc?.documentElement) return;
      frame.style.height = `${Math.min(Math.max(doc.documentElement.scrollHeight, 24), 20000)}px`;
    } catch { /* fremder Ursprung – Standardhöhe */ }
  };
  frame.addEventListener('load', () => {
    fit();
    try {
      const doc = frame.contentDocument;
      // Bilder, Aufklappen des zitierten Texts, Fenstergröße
      doc.addEventListener('toggle', fit, true);
      doc.querySelectorAll('img').forEach((img) => img.addEventListener('load', fit));
      if (window.ResizeObserver) new ResizeObserver(fit).observe(doc.body);
    } catch { /* egal */ }
  });
  return frame;
}

/**
 * Inhalt mit Umschalter. textView: () => Element (Textfassung), src: URL der formatierten Fassung.
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
