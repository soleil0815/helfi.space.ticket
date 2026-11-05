// Files for a reply or a new ticket: attach sheet (camera / file), downscale large photos
// before uploading, upload with progress.
import { h, icon } from '/js/dom.js';
import { t } from '/js/i18n.js';
import { state } from '/js/state.js';
import { openSheet } from './sheet.js';

export const MAX_EDGE = 2560;
export const JPEG_QUALITY = 0.85;
export const MAX_FILES = 10;
// Re-encoding these is safe; GIFs (animation) and everything else stay untouched
const SCALABLE = /^image\/(jpeg|png|webp)$/;
export const isPicture = (type) => /^image\/(png|jpeg|gif|webp)$/.test(type || '');

/**
 * Photos larger than MAX_EDGE on the long side become a JPEG of at most MAX_EDGE px.
 * Drawing into a canvas drops all metadata (EXIF incl. GPS position); the orientation from
 * EXIF is applied first so the picture stays upright. Returns { file, resized }.
 */
export async function downscale(file) {
  if (!SCALABLE.test(file.type) || typeof createImageBitmap !== 'function') return { file, resized: false };
  let bmp;
  try { bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }); }
  catch { return { file, resized: false }; } // not decodable here: upload as it is
  try {
    const long = Math.max(bmp.width, bmp.height);
    if (long <= MAX_EDGE) return { file, resized: false };
    const f = MAX_EDGE / long;
    const w = Math.max(1, Math.round(bmp.width * f));
    const hgt = Math.max(1, Math.round(bmp.height * f));
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = hgt;
    const g = canvas.getContext('2d');
    // JPEG has no transparency: white instead of black behind transparent PNG areas
    g.fillStyle = '#fff';
    g.fillRect(0, 0, w, hgt);
    g.imageSmoothingQuality = 'high';
    g.drawImage(bmp, 0, 0, w, hgt);
    const blob = await new Promise((res) => canvas.toBlob(res, 'image/jpeg', JPEG_QUALITY));
    if (!blob) return { file, resized: false };
    const name = `${(file.name || 'foto').replace(/\.[^.]+$/, '') || 'foto'}.jpg`;
    return { file: new File([blob], name, { type: 'image/jpeg', lastModified: Date.now() }), resized: true, width: w, height: hgt };
  } finally {
    bmp.close?.();
  }
}

/**
 * Upload one file as a draft of the ticket (the same endpoint as the desktop UI).
 * kind: '1' = picture (shown in the text), 'file' = any file (claimed by the comment),
 * null = regular attachment of the ticket (visible at once, e.g. for a new ticket).
 * onProgress(0..1). Resolves to the attachment id; rejects with the server message.
 */
export function uploadDraft(key, file, kind, onProgress) {
  return new Promise((resolve, reject) => {
    const fd = new FormData();
    if (kind) fd.append('draft', kind);
    fd.append('files', file, file.name);
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/tickets/${encodeURIComponent(key)}/attachments`);
    xhr.setRequestHeader('X-Helfi-Request', '1');
    xhr.setRequestHeader('Accept', 'application/json');
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress?.(e.loaded / e.total); };
    xhr.onload = () => {
      let data = null;
      try { data = JSON.parse(xhr.responseText); } catch { /* empty */ }
      if (xhr.status >= 200 && xhr.status < 300 && data?.ids?.length) { onProgress?.(1); resolve(data.ids[0]); return; }
      if (xhr.status === 401) window.dispatchEvent(new CustomEvent('helfi:unauthorized'));
      const err = new Error(data?.error?.message || `HTTP ${xhr.status}`);
      err.status = xhr.status;
      reject(err);
    };
    xhr.onerror = () => reject(new Error(t('m.offline')));
    xhr.send(fd);
  });
}

/**
 * File inputs outside the app root: while a sheet is open the app is inert, and an inert
 * input would not open the camera/file chooser. One pair is shared; each use sets onchange.
 */
let inputs = null;
export function fileInputs() {
  if (inputs?.camInput.isConnected) return inputs;
  const camInput = h('input.m-file-input', { type: 'file', accept: 'image/*', capture: 'environment', tabindex: '-1', 'aria-hidden': 'true' });
  const fileInput = h('input.m-file-input', { type: 'file', multiple: true, tabindex: '-1', 'aria-hidden': 'true' });
  document.body.append(h('div.m-file-inputs', camInput, fileInput));
  inputs = { camInput, fileInput };
  return inputs;
}

/** Choose a file input and open it: input.click() runs in the tap that triggered it */
export function pickFiles(which, onFiles) {
  const { camInput, fileInput } = fileInputs();
  const input = which === 'camera' ? camInput : fileInput;
  input.value = '';
  input.onchange = () => { const list = [...(input.files || [])]; input.value = ''; if (list.length) onFiles(list); };
  input.click();
}

/** Sheet "Add attachment": take a photo or pick a file */
export function openAttachSheet(onFiles) {
  const row = (ic, label, text, which) => h('button.m-action', {
    type: 'button', onclick: () => { pickFiles(which, onFiles); sheet.close(); },
  }, h('span.m-action-icon', icon(ic)), h('span.m-action-text', h('span.m-action-label', label), h('span.m-action-hint', text)));
  const max = state.boot?.maxUploadMb;
  const sheet = openSheet({
    title: t('m.reply.attachTitle'),
    className: 'm-sheet-actions',
    content: h('div.m-actions-list',
      row('camera', t('m.reply.photo'), t('m.reply.photoText'), 'camera'),
      row('paperclip', t('m.reply.file'), t('m.reply.fileText'), 'file'),
      h('p.m-sheet-note', icon('image'), h('span', t('m.reply.photoHint'), max ? ` ${t('m.reply.maxSize', { max, n: MAX_FILES })}` : ''))),
  });
  return sheet;
}
