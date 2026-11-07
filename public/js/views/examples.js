// "Take over examples" dialog for shared canned responses, catalog offerings and knowledge
// articles (like the example components): pick, choose the language, take over.
import { api } from '../api.js';
import { h, icon, modal, toast } from '../dom.js';
import { t, getLang } from '../i18n.js';

/** Button that opens the dialog; onDone runs after something was taken over */
export function examplesButton(kind, onDone) {
  return h('button.btn.btn-subtle', { type: 'button', 'data-examples': kind, onclick: () => examplesDialog(kind, onDone) }, icon('sparkle'), t('examples.button'));
}

export async function examplesDialog(kind, onDone) {
  let list;
  try { ({ examples: list } = await api.examples(kind)); } catch (e) { toast(e.message, 'error'); return; }
  let lang = getLang() === 'en' ? 'en' : 'de';
  const boxes = [];
  const listBox = h('div.examples-list');
  const draw = () => {
    boxes.length = 0;
    listBox.replaceChildren(...list.map((x) => {
      const box = h('input', { type: 'checkbox', value: x.key, checked: true });
      boxes.push(box);
      return h('label.comp-example', box, h('span', x.emoji ? `${x.emoji} ` : '', h('strong', x[lang].title), h('span.muted.block', x[lang].description)));
    }));
  };
  draw();
  const langSel = h('div.segmented.examples-lang', { role: 'group', 'aria-label': t('examples.language') },
    ['de', 'en'].map((l) => h('button.seg', {
      type: 'button', class: l === lang ? 'active' : '', 'aria-pressed': String(l === lang),
      onclick: (e) => { lang = l; [...langSel.children].forEach((b) => { b.classList.toggle('active', b === e.currentTarget); b.setAttribute('aria-pressed', String(b === e.currentTarget)); }); draw(); },
    }, l === 'de' ? 'Deutsch' : 'English')));
  const allBtn = h('button.btn.btn-subtle.small', { type: 'button', onclick: () => { const on = boxes.some((b) => !b.checked); boxes.forEach((b) => { b.checked = on; }); } }, t('comp.exampleAll'));
  const dlg = modal(t(`examples.${kind}.title`), h('div',
    h('p.muted', t(`examples.${kind}.intro`)),
    h('div.examples-head', langSel, allBtn),
    listBox), {
    wide: true,
    footer: [h('span.spacer'), h('button.btn.btn-subtle', { type: 'button', onclick: () => dlg.close() }, t('app.cancel')),
      h('button.btn.btn-primary', {
        type: 'button',
        onclick: async () => {
          const keys = boxes.filter((b) => b.checked).map((b) => b.value);
          if (!keys.length) { dlg.close(); return; }
          try {
            const r = await api.takeExamples(kind, keys, lang);
            dlg.close();
            toast(r.skipped.length ? t('examples.addedSkipped', { n: r.added.length, m: r.skipped.length }) : t('examples.added', { n: r.added.length }), 'success');
            onDone?.(r);
          } catch (e) { toast(e.message, 'error'); }
        },
      }, t('comp.examplesTake'))],
  });
}
