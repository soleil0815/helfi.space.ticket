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

/** Hint below the user name: AD logon name and/or email address of a self-created account */
export function loginUserHint(auth) {
  if (auth.register) return t(auth.ldap ? 'login.usernameOrEmailHint' : 'login.emailHint');
  return auth.ldap ? t('login.usernameHint') : null;
}

/** "Forgot password?" and "Create account" below the sign-in form (shared with the mobile UI) */
export function accountLinks(auth, wrap, link) {
  if (!auth.passwordReset && !auth.register) return null;
  // Full page loads: these pages exist in the desktop UI only (also used on phones)
  return h(wrap,
    auth.passwordReset ? h(link, { href: '/forgot' }, t('login.forgot')) : null,
    auth.register ? h(link, { href: '/register' }, t('login.register')) : null);
}
