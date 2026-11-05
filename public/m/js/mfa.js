// Two-factor setup on the phone (in "Me" and during sign-in). The phone usually IS the device with
// the authenticator app, so scanning its own screen is impossible: the secret key is shown big with
// a copy button and an otpauth:// link that opens the authenticator app directly; the QR code is
// still there for a second device. Then: enter the code, show the recovery codes (copy/share/save).
import { h, icon, toast } from '/js/dom.js';
import { t } from '/js/i18n.js';

const groups = (secret) => String(secret).replace(/(.{4})/g, '$1 ').trim();

async function copyText(text, okMsg) {
  try { await navigator.clipboard.writeText(text); toast(okMsg, 'success'); return true; } catch { return false; }
}

/**
 * Setup steps. info: { secret, uri, qr } from the API; confirm(code) → Promise<string[] recovery codes>.
 * Returns the element; after a correct code it replaces itself with the recovery codes and calls onDone(codes).
 */
export function mfaSetupSteps(info, { confirm, onDone, doneLabel = t('mfa.done') }) {
  const err = h('div.m-alert.m-alert-error', { role: 'alert', hidden: true });
  const code = h('input.m-code', { inputmode: 'numeric', autocomplete: 'one-time-code', maxLength: 6, pattern: '[0-9]{6}', placeholder: '123456', 'aria-label': t('m.mfa.codeLabel'), name: 'code' });
  const btn = h('button.m-btn.m-btn-primary.m-btn-block', { type: 'submit' }, icon('check'), t('mfa.activate'));
  const secretEl = h('code.m-secret', { 'aria-label': t('m.mfa.secretLabel') }, groups(info.secret));
  const step = (n, title, ...body) => h('li.m-step', h('span.m-step-n', { 'aria-hidden': 'true' }, String(n)), h('div.m-step-body', h('h3', title), ...body));

  const el = h('form.m-mfa-setup', {
    novalidate: true,
    onsubmit: async (e) => {
      e.preventDefault();
      if (!/^\d{6}$/.test(code.value.trim())) { err.textContent = t('m.mfa.codeInvalid'); err.hidden = false; code.focus(); return; }
      err.hidden = true;
      btn.disabled = true;
      try {
        const codes = await confirm(code.value.trim());
        el.replaceWith(recoveryCodesView(codes, { onDone: () => onDone?.(codes), doneLabel }));
      } catch (ex) {
        err.textContent = ex.message; err.hidden = false;
        code.value = '';
        code.focus();
        btn.disabled = false;
      }
    },
  },
  h('ol.m-steps',
    step(1, t('m.mfa.step1'), h('p.m-muted', t('m.mfa.step1Text'))),
    step(2, t('m.mfa.step2'),
      h('p.m-muted', t('m.mfa.step2Text')),
      h('a.m-btn.m-btn-primary.m-btn-block.m-otpauth', { href: info.uri }, icon('key'), t('m.mfa.openApp')),
      h('p.m-muted.m-small', t('m.mfa.orKey')),
      h('div.m-secret-box', secretEl,
        h('button.m-btn.m-copy-btn', { type: 'button', onclick: () => copyText(info.secret, t('m.mfa.keyCopied')) }, icon('copy'), t('mfa.copy'))),
      h('p.m-muted.m-small', t('m.mfa.keyHint')),
      h('details.m-qr-details', h('summary', icon('smartphone'), t('m.mfa.qrOther')),
        h('img.m-qr', { src: info.qr, alt: t('mfa.qrAlt'), width: 200, height: 200 }))),
    step(3, t('m.mfa.step3'), h('p.m-muted', t('mfa.codeHint')), err, code, btn)));
  code.addEventListener('input', () => {
    code.value = code.value.replace(/\D/g, '').slice(0, 6);
    if (/^\d{6}$/.test(code.value) && !btn.disabled) el.requestSubmit();
  });
  return el;
}

/** Recovery codes: shown once, copy / share / save as a file */
export function recoveryCodesView(codes, { onDone, doneLabel = t('mfa.done') } = {}) {
  const text = codes.join('\n');
  const file = `Helfi.Space – ${t('mfa.recoveryTitle')}\n\n${text}\n`;
  const canShare = typeof navigator.share === 'function';
  return h('div.m-recovery',
    h('div.m-login-icon', icon('shield')),
    h('h2.m-recovery-title', t('mfa.recoveryTitle')),
    h('p.m-muted', t('mfa.recoveryIntro')),
    h('ul.m-recovery-codes', { 'aria-label': t('mfa.recoveryTitle') }, codes.map((c) => h('li', c))),
    h('div.m-recovery-actions',
      h('button.m-btn', { type: 'button', onclick: () => copyText(text, t('mfa.copied')) }, icon('copy'), t('mfa.copy')),
      canShare
        ? h('button.m-btn', { type: 'button', onclick: () => navigator.share({ title: t('mfa.recoveryTitle'), text: file }).catch(() => { /* cancelled */ }) }, icon('share'), t('m.mfa.share'))
        : h('a.m-btn', { href: URL.createObjectURL(new Blob([file], { type: 'text/plain' })), download: 'helfi-recovery-codes.txt' }, icon('download'), t('mfa.download'))),
    h('button.m-btn.m-btn-primary.m-btn-block.m-recovery-done', { type: 'button', onclick: () => onDone?.() }, doneLabel));
}
