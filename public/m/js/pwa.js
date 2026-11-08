// Installable app: service worker registration, "new version" notice, install prompt, standalone mode.
import { h, icon } from '/js/dom.js';
import { t } from '/js/i18n.js';
import { isStandalone } from '/js/uimode.js';

let installEvent = null; // beforeinstallprompt (Chrome/Android), kept for the "Install app" button
const listeners = new Set();

export { isStandalone };
export const isIos = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
export const canPromptInstall = () => !!installEvent;
export function onInstallChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }

/** Show the browser's install dialog (only after a beforeinstallprompt event) */
export async function promptInstall() {
  const ev = installEvent;
  if (!ev) return false;
  installEvent = null;
  ev.prompt();
  const choice = await ev.userChoice.catch(() => null);
  for (const fn of listeners) fn();
  return choice?.outcome === 'accepted';
}

export function setupPwa() {
  document.documentElement.classList.toggle('m-standalone', isStandalone());
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault(); // no mini-infobar: the "Me" tab offers the button
    installEvent = e;
    for (const fn of listeners) fn();
  });
  window.addEventListener('appinstalled', () => { installEvent = null; for (const fn of listeners) fn(); });
  registerWorker();
}

function registerWorker() {
  if (!('serviceWorker' in navigator) || !window.isSecureContext) return;
  // A page that was already controlled gets a new worker only after an update: then offer a reload
  const hadController = !!navigator.serviceWorker.controller;
  let notified = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController || notified) return;
    notified = true;
    showUpdateNotice();
  });
  const register = () => navigator.serviceWorker.register('/m/sw.js', { scope: '/m/' }).then((reg) => {
    // Apps stay open for days: look for a new version whenever the app comes back to the front
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') reg.update().catch(() => { /* offline */ }); });
  }).catch((e) => console.warn('Service worker not registered:', e.message));
  if (document.readyState === 'complete') register();
  else window.addEventListener('load', register, { once: true });
}

/** Small bar above the tab bar: "New version – reload" */
export function showUpdateNotice() {
  if (document.querySelector('.m-update')) return;
  const bar = h('div.m-update', { role: 'status' },
    icon('refresh'),
    h('span.m-update-text', t('m.pwa.updated')),
    h('button.m-update-btn', { type: 'button', onclick: () => location.reload() }, t('m.pwa.reload')),
    h('button.m-iconbtn.m-update-x', { type: 'button', 'aria-label': t('app.close'), onclick: () => bar.remove() }, icon('close')));
  document.body.append(bar);
}
