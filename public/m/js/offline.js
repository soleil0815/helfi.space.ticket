// Offline page of the installed app (shown by the service worker when a page cannot be loaded):
// texts in the user's language, "Try again" reloads, and it reloads by itself once the
// connection is back.
import { t, setLang, browserLang } from '/js/i18n.js';

let lang = null;
try { lang = localStorage.getItem('helfi.lang'); } catch { /* ignore */ }
setLang(lang || browserLang() || 'de');
for (const el of document.querySelectorAll('[data-t]')) el.textContent = t(el.dataset.t);
document.title = `Helfi.Space – ${t('m.offline.title')}`;

const retry = document.querySelector('.m-offline-retry');
const reload = () => { retry.disabled = true; location.reload(); };
retry.addEventListener('click', reload);
window.addEventListener('online', reload);
