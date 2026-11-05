// "Not found" page of the mobile UI.
import { h, icon } from '/js/dom.js';
import { t } from '/js/i18n.js';
import { emptyState } from '../ui.js';

export function renderNotFound(page) {
  page.title('404');
  page.body.replaceChildren(emptyState('search', t('m.notFound'), null,
    h('a.m-btn', { href: '/m/', 'data-link': '' }, icon('home'), t('m.toStart'))));
}
