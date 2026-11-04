// Custom texts of the sign-in page (settings → sign-in page), used by the desktop and the mobile sign-in.
import { h, richText } from './dom.js';
import { t, getLang } from './i18n.js';

/** Custom login page text in the matching language (English falls back to German). */
function pickLang(obj) {
  if (!obj) return '';
  return (getLang() === 'en' && obj.en) ? obj.en : (obj.de || obj.en || '');
}
export function loginUserLabel(login) { return pickLang(login?.userLabel).trim(); }

/** Heading and welcome text (text without HTML, **bold**, links/email addresses clickable). */
export function loginIntro(login) {
  const title = String(login?.title || '').trim();
  const text = pickLang(login?.text).trim();
  if (!title && !text) return [h('h1', t('login.title'))];
  return [
    title ? h('h1.login-custom-title', title) : h('h1', t('login.title')),
    text ? h('div.login-intro', richText(text)) : null,
  ];
}
