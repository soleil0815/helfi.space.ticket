// "Me" tab: account, language, news, desktop view, sign out – and the news page.
import { api } from '/js/api.js';
import { h, avatar, fmtDate } from '/js/dom.js';
import { t, getLang } from '/js/i18n.js';
import { state } from '/js/state.js';
import { setUiPref, desktopUrlFor } from '/js/uimode.js';
import { setLanguage, signOut } from '../main.js';
import { listRow, emptyState, skeletonList } from '../ui.js';

/** Switch to the desktop UI for good (saved preference; the desktop user menu offers the way back) */
export function switchToDesktop(path = location.pathname) {
  setUiPref('desktop');
  location.assign(desktopUrlFor(path, ''));
}

export function renderMe(page) {
  page.title(t('m.tab.me'));
  const u = state.user;
  const langBtn = (l, label) => h('button', {
    type: 'button', role: 'radio', 'aria-checked': String(getLang() === l), class: getLang() === l ? 'active' : '',
    onclick: () => { if (getLang() !== l) setLanguage(l); },
  }, label);
  const group = (title, ...rows) => h('section.m-group', title ? h('h2.m-group-title', title) : null, h('div.m-group-rows', ...rows));

  page.body.replaceChildren(
    h('div.m-profile',
      avatar(u, 'xl'),
      h('div.m-profile-name', u.displayName),
      h('div.m-profile-sub', [t(`role.${u.role}`), u.email].filter(Boolean).join(' · '))),
    group(t('app.language'),
      h('div.m-row.m-row-static',
        h('div.m-segmented', { role: 'radiogroup', 'aria-label': t('app.language') }, langBtn('de', 'Deutsch'), langBtn('en', 'English')))),
    group(null,
      listRow({ icon: 'info', label: t('news.title'), href: '/m/news' }),
      listRow({ icon: 'monitor', label: t('m.me.desktop'), hint: t('m.me.desktopHint'), onClick: () => switchToDesktop('/m/me') })),
    group(null,
      listRow({ icon: 'logout', label: t('app.logout'), danger: true, onClick: () => signOut() })),
    h('p.m-version', `Helfi.Space ${state.boot.app.version}`));
}

const newsText = (i) => (getLang() === 'en' ? i.en : i.de) || i.de || i.en || '';

export async function renderNews(page) {
  page.title(t('news.title'));
  page.body.replaceChildren(skeletonList(2));
  const { entries } = await api.news();
  if (state.boot.news) { state.boot.news = null; api.newsSeen().catch(() => { /* next time */ }); }
  page.body.replaceChildren(
    h('p.m-intro', t('news.intro')),
    ...(entries.length
      ? entries.map((e) => h('section.m-card.m-news',
        h('h2', `Helfi.Space ${e.version}`, e.date ? h('span.m-muted', fmtDate(e.date, false)) : null),
        h('ul', e.items.map((i) => h('li', newsText(i))))))
      : [emptyState('info', t('news.none'))]));
}
