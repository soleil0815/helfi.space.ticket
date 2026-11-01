// Bilder aus der Zwischenablage (z. B. Screenshots) in Textfelder einfügen.
// Das Bild wird als Entwurf hochgeladen und als ![Name](/api/attachments/ID) an der Cursorposition eingesetzt;
// sichtbar für andere wird es erst, wenn der Text gespeichert ist.
import { t, getLang } from './i18n.js';
import { toast } from './dom.js';

function screenshotName(type, i) {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const ext = { 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' }[type] || 'png';
  return `${getLang() === 'en' ? 'Screenshot' : 'Bildschirmfoto'}-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}${i ? `-${i + 1}` : ''}.${ext}`;
}

/** Bilder aus einem Paste-Ereignis (nur reine Bilder – kopierter Text mit Bild bleibt Text). */
export function imagesFromPaste(e) {
  const items = [...(e.clipboardData?.items || [])];
  if (items.some((it) => it.type === 'text/plain' || it.type === 'text/html')) return [];
  return items.filter((it) => it.kind === 'file' && /^image\/(png|jpeg|gif|webp)$/.test(it.type))
    .map((it, i) => { const f = it.getAsFile(); return f ? new File([f], screenshotName(f.type, i), { type: f.type }) : null; })
    .filter(Boolean);
}

/**
 * Einfügen für ein Textfeld aktivieren.
 * upload(files) → Promise<ids>; ohne upload (z. B. noch kein Ticket) merkt sich das Feld die Dateien
 * als „pending:n“ – mit takePending() abholen und später ersetzen.
 */
export function enableImagePaste(textarea, { upload } = {}) {
  const pending = new Map();
  let n = 0;
  textarea.addEventListener('paste', async (e) => {
    const files = imagesFromPaste(e);
    if (!files.length) return;
    e.preventDefault();
    for (const f of files) {
      const token = `upload-${++n}`;
      const marker = `![${t('paste.uploading')}](${token})`;
      textarea.setRangeText(`${marker}\n`, textarea.selectionStart, textarea.selectionEnd, 'end');
      textarea.dispatchEvent(new Event('input'));
      if (!upload) {
        pending.set(token, f);
        textarea.value = textarea.value.replace(marker, `![${f.name}](${token})`);
        continue;
      }
      try {
        const { ids } = await upload([f]);
        textarea.value = textarea.value.replace(marker, `![${f.name}](/api/attachments/${ids[0]})`);
      } catch (ex) {
        textarea.value = textarea.value.replace(`${marker}\n`, '').replace(marker, '');
        toast(ex.message, 'error');
      }
      textarea.dispatchEvent(new Event('input'));
    }
  });
  return {
    /** Noch nicht hochgeladene Bilder, die im Text noch vorkommen: [[token, file]] */
    takePending: () => [...pending].filter(([token]) => textarea.value.includes(`](${token})`)),
  };
}

/** Text mit „upload-n“-Platzhaltern auf hochgeladene IDs umschreiben. */
export function replacePending(text, map) {
  let out = String(text);
  for (const [token, id] of map) out = out.split(`](${token})`).join(`](/api/attachments/${id})`);
  return out.replace(/!\[[^\]]*\]\(upload-\d+\)\n?/g, '');
}
