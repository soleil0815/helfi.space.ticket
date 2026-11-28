// Files attached to a knowledge article (PDF, documents …): list below the article and the
// "Attachments" block in the editor. Shared by the desktop and the mobile view.
import { api } from './api.js';
import { h, icon, toast, fmtSize } from './dom.js';
import { t } from './i18n.js';

const KIND = [
  [/\.pdf$/i, 'PDF'], [/\.(docx?|odt|rtf)$/i, 'DOC'], [/\.(xlsx?|ods|csv)$/i, 'XLS'], [/\.(pptx?|odp)$/i, 'PPT'],
  [/\.(zip|7z|rar|tar|gz)$/i, 'ZIP'], [/\.(png|jpe?g|gif|webp|svg)$/i, 'IMG'], [/\.(txt|md|log)$/i, 'TXT'],
];
/** Short type label from the file name ("PDF", "DOC" …) – the stored type comes from the browser */
export const fileKind = (name) => KIND.find(([re]) => re.test(name || ''))?.[1] || '';

function fileRow(f, extra = null) {
  const kind = fileKind(f.name);
  return h('li.kb-file', { 'data-kb-file': f.token },
    h('span.kb-file-icon', { 'aria-hidden': 'true' }, icon('file'), kind ? h('span.kb-file-kind', kind) : null),
    h('span.kb-file-main',
      f.url ? h('a.kb-file-name', { href: f.url, download: f.name, title: t('kb.files.download', { name: f.name }) }, f.name) : h('span.kb-file-name', f.name),
      h('span.muted.small', fmtSize(f.size))),
    extra);
}

/** Read view: list of the article's files (nothing if there are none) */
export function filesSection(files, { compact = false } = {}) {
  if (!files?.length) return null;
  return h(`section.kb-files${compact ? '.compact' : ''}`, { 'data-kb-files': '' },
    h('h3', icon('paperclip'), t('kb.files.title'), h('span.count', files.length)),
    h('ul', files.map((f) => fileRow(f))));
}

/**
 * Editor block: attach (button or drop), remove; value() is the list of tokens in order.
 * New uploads that are not saved can be discarded again (discardNew on cancel).
 */
export function filesEditor(initial = [], { onChange = () => {} } = {}) {
  let files = [...initial];
  const fresh = new Set(); // uploaded in this editor, not saved yet
  const input = h('input', { type: 'file', multiple: true, hidden: true, 'data-kb-file-input': '' });
  const list = h('ul');
  const busy = h('span.muted.small.kb-files-busy');
  const box = h('section.kb-files.kb-files-edit', { 'data-kb-files-edit': '' },
    h('div.kb-files-head',
      h('h3', icon('paperclip'), t('kb.files.title')),
      h('button.btn.btn-subtle.small', { type: 'button', onclick: () => input.click(), 'data-kb-file-add': '' }, icon('plus'), t('kb.files.add')),
      busy),
    h('p.muted.small.kb-files-hint', t('kb.files.hint')),
    list, input);
  const render = () => {
    list.replaceChildren(...files.map((f) => fileRow(f, h('button.btn-icon.small', {
      type: 'button', title: t('kb.files.remove'), 'aria-label': t('kb.files.removeName', { name: f.name }),
      onclick: () => {
        files = files.filter((x) => x.token !== f.token);
        if (fresh.has(f.token)) { fresh.delete(f.token); api.kbFileDiscard(f.token).catch(() => {}); }
        render(); onChange();
      },
    }, icon('trash')))));
    box.classList.toggle('empty', !files.length);
  };
  async function upload(list2) {
    const picked = [...(list2 || [])];
    if (!picked.length) return;
    busy.textContent = t('kb.files.uploading');
    try {
      const r = await api.kbFiles(picked);
      for (const f of r.files) { files.push(f); fresh.add(f.token); }
      render(); onChange();
    } catch (e) { toast(e.message, 'error'); } finally { busy.textContent = ''; input.value = ''; }
  }
  input.addEventListener('change', () => upload(input.files));
  box.addEventListener('dragover', (e) => { if ([...(e.dataTransfer?.types || [])].includes('Files')) { e.preventDefault(); box.classList.add('drop'); } });
  box.addEventListener('dragleave', () => box.classList.remove('drop'));
  box.addEventListener('drop', (e) => { if (!e.dataTransfer?.files?.length) return; e.preventDefault(); box.classList.remove('drop'); upload(e.dataTransfer.files); });
  render();
  return {
    el: box,
    value: () => files.map((f) => f.token),
    changed: () => files.map((f) => f.token).join() !== initial.map((f) => f.token).join(),
    saved: () => fresh.clear(),
    discardNew: () => { for (const tk of fresh) api.kbFileDiscard(tk).catch(() => {}); fresh.clear(); },
  };
}
