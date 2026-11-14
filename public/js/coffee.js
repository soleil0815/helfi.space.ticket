// Support for the developer (admins only): a sentence and a button that opens Buy Me a Coffee in a
// new tab. Shared by the desktop (sidebar foot, Administration → System) and the phone app ("Me").
import { h, icon } from './dom.js';
import { t } from './i18n.js';

export const COFFEE_URL = 'https://buymeacoffee.com/soleil0815';

export function coffeeButton(cls = 'a.coffee-btn') {
  return h(cls, { href: COFFEE_URL, target: '_blank', rel: 'noopener noreferrer', title: t('app.coffeeTitle') }, icon('coffee'), h('span', t('app.coffeeButton')));
}

/** Box with a sentence and the button; "stacked" (sentence above, button full width) for narrow places */
export function coffeeBox({ stacked = false } = {}) {
  return h(`div.coffee-box${stacked ? '.coffee-box-stacked' : ''}`, { 'data-coffee': '' }, h('p', t('app.coffeeText')), coffeeButton());
}
