// Formatted comment field (tickets and knowledge articles): one toolbar with AI on the left,
// formatting, link, image, emoji and @ in the middle, canned responses on the right.
// Saved as text in the article format (see kbdoc.js) with format 'md'.
import { createKbEditor } from './kbeditor.js';
import { attachMentionsRich } from './mention.js';
import { enableEmojiShortcodesRich } from './emoji.js';
import { renderDoc } from './kbdoc.js';
import { richText } from './dom.js';

/**
 * opts: placeholder, label, value, onSubmit, uploadImage(file) → url (null = no images),
 * mention: { getKey, isInternal } (agents in tickets) or null.
 * Returns the editor API plus slots { left, right } and mentions.
 */
export function createCommentField({ placeholder = '', label = '', value = '', onSubmit = null, onChange = () => {}, uploadImage = null, mention = null } = {}) {
  const editor = createKbEditor({ variant: 'comment', value, placeholder, label, uploadImage, mention: !!mention, onSubmit, onChange });
  enableEmojiShortcodesRich(editor.area);
  const mentions = mention ? attachMentionsRich(editor, mention) : null;
  return { ...editor, mentions };
}

/** Show a comment: formatted ones in the article format, older/mail ones as plain text */
export function commentView(c) {
  if (c.format !== 'md') return richText(c.body);
  const doc = renderDoc(c.body);
  doc.classList.add('rich', 'cm-doc');
  return doc;
}
