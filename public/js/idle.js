// Automatic sign-out after inactivity – client side (desktop and mobile UI).
//
// The server decides (idle period per role/network, see src/auth/session.js); this module only
// makes it pleasant: while someone works (keys, clicks, touches) it tells the server now and then,
// so nobody is signed out while typing a long reply. Shortly before the end it asks
// "continue?"; if nobody answers, the page goes to the sign-in with a note.
// Started/stopped by the bootstrap answer (event "helfi:session" from api.js).
import { api } from './api.js';
import { h, icon } from './dom.js';
import { t } from './i18n.js';

const PING_EVERY_MS = 5 * 60 * 1000; // report activity at most this often
const NOTE_KEY = 'helfi.idleSignedOut';
const EVENTS = ['pointerdown', 'keydown', 'wheel', 'touchstart'];

let info = null; // { idleMs, remainingMs, warnMs }
let deadline = 0; // local time of the end (estimated)
let timer = null;
let lastPing = 0;
let dialog = null;
let countdown = null;
let loginUrl = '/login';

function clear() {
  clearTimeout(timer);
  timer = null;
  clearInterval(countdown);
  countdown = null;
}

function schedule() {
  clear();
  if (!info) return;
  const warnAt = deadline - (info.warnMs || 120000);
  timer = setTimeout(check, Math.max(1000, warnAt - Date.now()));
}

function apply(next) {
  info = next;
  deadline = Date.now() + (next?.remainingMs ?? 0);
  schedule();
}

/** Ask the server (does not count as activity): another tab may have kept the session alive */
async function check() {
  if (!info) return;
  let r;
  try { r = await api.sessionStatus(); } catch (e) {
    if (e.status === 401) expired(); // api.js leaves this 401 to us (see there)
    else timer = setTimeout(check, 30000); // offline: try again soon
    return;
  }
  info = r;
  deadline = Date.now() + r.remainingMs;
  if (r.remainingMs > (r.warnMs || 120000) + 5000) { closeDialog(); schedule(); return; }
  if (r.remainingMs <= 0) { expired(); return; }
  showDialog();
}

async function ping() {
  lastPing = Date.now();
  try { apply(await api.sessionPing()); } catch (e) { if (e.status === 401) expired(); }
}


function onActivity() {
  if (!info || dialog) return;
  // Long period: report rarely; short period (e.g. 5 minutes for admins): more often
  const every = Math.min(PING_EVERY_MS, Math.max(30000, (info.idleMs || 0) / 4));
  if (Date.now() - lastPing > every) ping();
}

function remainingText() {
  const s = Math.max(0, Math.round((deadline - Date.now()) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function showDialog() {
  if (!dialog) {
    const time = h('strong.idle-time', remainingText());
    const stay = h('button.btn.btn-primary', { type: 'button', onclick: () => { closeDialog(); ping(); } }, t('idle.stay'));
    const leave = h('button.btn', { type: 'button', onclick: () => signOutNow() }, t('idle.signOut'));
    dialog = h('div.idle-overlay', { role: 'alertdialog', 'aria-modal': 'true', 'aria-labelledby': 'idle-title', 'aria-describedby': 'idle-text' },
      h('div.idle-box',
        h('div.idle-icon', icon('clock')),
        h('h2', { id: 'idle-title' }, t('idle.title')),
        h('p', { id: 'idle-text' }, t('idle.text'), ' ', time),
        h('div.idle-actions', leave, stay)));
    document.body.append(dialog);
    stay.focus();
    countdown = setInterval(() => {
      time.textContent = remainingText();
      if (Date.now() >= deadline) { clearInterval(countdown); countdown = null; check(); }
    }, 1000);
  }
}

function closeDialog() {
  clearInterval(countdown);
  countdown = null;
  dialog?.remove();
  dialog = null;
}

async function signOutNow() {
  stop();
  try { await api.logout(); } catch { /* signed out anyway */ }
  location.assign(loginUrl);
}

function setNote(on) {
  try { if (on) sessionStorage.setItem(NOTE_KEY, '1'); else sessionStorage.removeItem(NOTE_KEY); } catch { /* ignore */ }
}

/** Session ended by inactivity: note for the sign-in page, then the usual way out (401) */
function expired() {
  stop();
  setNote(true);
  window.dispatchEvent(new CustomEvent('helfi:unauthorized'));
}

export function stop() {
  clear();
  closeDialog();
  info = null;
}

/** Was the last sign-out caused by inactivity? (read once by the sign-in page) */
export function takeIdleNote() {
  try {
    const v = sessionStorage.getItem(NOTE_KEY);
    sessionStorage.removeItem(NOTE_KEY);
    return v === '1';
  } catch { return false; }
}

/** Once per page: listen for the bootstrap answer and for activity */
export function initIdle({ login = '/login' } = {}) {
  loginUrl = login;
  window.addEventListener('helfi:session', (e) => {
    if (e.detail) { lastPing = Date.now(); apply(e.detail); } else stop();
  });
  window.addEventListener('helfi:unauthorized', () => stop());
  for (const ev of EVENTS) window.addEventListener(ev, onActivity, { passive: true, capture: true });
  // Back from sleep / another tab: the timer may be late
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && info) check(); });
}
