// Paste images from the clipboard (e.g. screenshots) into text fields.
// The image is uploaded as a draft and inserted as ![Name](/api/attachments/ID) at the cursor position;
// it only becomes visible to others once the text is saved.
import { t, getLang } from './i18n.js';
import { toast } from './dom.js';

function screenshotName(type, i) {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const ext = { 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' }[type] || 'png';
  return `${getLang() === 'en' ? 'Screenshot' : 'Bildschirmfoto'}-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}${i ? `-${i + 1}` : ''}.${ext}`;
}

/** Images from a paste event (pure images only – copied text with an image stays text). */
export function imagesFromPaste(e) {
  const items = [...(e.clipboardData?.items || [])];
  if (items.some((it) => it.type === 'text/plain' || it.type === 'text/html')) return [];
  return items.filter((it) => it.kind === 'file' && /^image\/(png|jpeg|gif|webp)$/.test(it.type))
    .map((it, i) => { const f = it.getAsFile(); return f ? new File([f], screenshotName(f.type, i), { type: f.type }) : null; })
    .filter(Boolean);
}

/**
 * Enable pasting for a text field.
 * upload(files) → Promise<ids>; without upload (e.g. no ticket yet) the field remembers the files
 * as “pending:n” – fetch them with takePending() and replace later.
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
    /** Images not yet uploaded that still occur in the text: [[token, file]] */
    takePending: () => [...pending].filter(([token]) => textarea.value.includes(`](${token})`)),
  };
}

/** Rewrite text with “upload-n” placeholders to the uploaded IDs. */
export function replacePending(text, map) {
  let out = String(text);
  for (const [token, id] of map) out = out.split(`](${token})`).join(`](/api/attachments/${id})`);
  return out.replace(/!\[[^\]]*\]\(upload-\d+\)\n?/g, '');
}
