// Pages that follow in later versions of the mobile UI (new ticket, knowledge base) and "not found".
import { h, icon } from '/js/dom.js';
import { t } from '/js/i18n.js';
import { state } from '/js/state.js';
import { emptyState } from '../ui.js';

function soon(page, title, ic, text, desktopHref) {
  page.title(title);
  page.body.replaceChildren(h('div.m-soon',
    emptyState(ic, t('m.soon.title'), text,
      h('a.m-btn.m-btn-primary', { href: desktopHref }, icon('monitor'), t('m.openDesktop')))));
}

export function renderSoonNew(page) {
  soon(page, t('m.newTicket'), 'plus', t('m.soon.new'), state.isAgent ? '/my?ui=desktop' : '/requests?ui=desktop');
}

export function renderKbSoon(page, ctx) {
  const id = ctx.match[1];
  soon(page, state.isAgent ? t('kb.title') : t('kb.titleUser'), 'book', t('m.soon.kb'), id ? `/kb/${id}?ui=desktop` : '/kb?ui=desktop');
}

export function renderNotFound(page) {
  page.title('404');
  page.body.replaceChildren(emptyState('search', t('m.notFound'), null,
    h('a.m-btn', { href: '/m', 'data-link': '' }, icon('home'), t('m.toStart'))));
}
