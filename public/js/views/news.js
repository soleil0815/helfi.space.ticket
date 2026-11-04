// News: shown once as a notice after an update, all versions under /news
import { api } from '../api.js';
import { h, mount, modal, fmtDate } from '../dom.js';
import { t, getLang } from '../i18n.js';
import { state, navigate } from '../app.js';

const text = (i) => (getLang() === 'en' ? i.en : i.de) || i.de || i.en || '';

function itemList(entry) {
  return h('ul.news-items', entry.items.map((i) => h('li', text(i))));
}

/** “New in …” notice – counts as seen once it is closed */
export function showNewsPopup(entry) {
  let done = false;
  const seen = () => {
    if (done) return;
    done = true;
    state.boot.news = null;
    api.newsSeen().catch(() => { /* retry on next load */ });
  };
  const dlg = modal(t('news.popupTitle', { version: entry.version }), itemList(entry), {
    onClose: seen,
    footer: [
      h('button.btn.btn-subtle', { type: 'button', onclick: () => { dlg.close(); navigate('/news'); } }, t('news.all')),
      h('button.btn.btn-primary', { type: 'button', onclick: () => dlg.close() }, t('app.ok')),
    ],
  });
  setTimeout(() => dlg.el.querySelector('.btn-primary')?.focus(), 40);
  return dlg;
}

export async function renderNews(content) {
  const { entries } = await api.news();
  if (state.boot.news) { state.boot.news = null; api.newsSeen().catch(() => {}); }
  mount(content,
    h('div.page-head', h('h1', t('news.title'))),
    h('p.muted', t('news.intro')),
    entries.length
      ? h('div.news-list', entries.map((e) => h('section.panel.news-entry',
        h('h2', `Helfi.Space ${e.version}`, e.date ? h('span.muted.news-date', fmtDate(e.date, false)) : null),
        itemList(e))))
      : h('p.muted', t('news.none')));
}
