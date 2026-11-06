// @-mentions in comments: stored as "@[Display name](user:ID)" in the comment text.
// The ID is what counts (notification, "Mentions me" filter); the name is only for display
// and is replaced with the current display name when saving.

// Bounded quantifiers, no nested repetition: linear on any input
export const MENTION_RE = /@\[([^\]\n]{1,120})\]\(user:(\d{1,10})\)/g;

/** Text with mentions shown as "@Name" (mails, AI, search). */
export function mentionsAsText(text) {
  return String(text ?? '').replace(MENTION_RE, (m, name) => `@${name}`);
}

/**
 * Checks every mention: allowed(user) → keep (with the current name), otherwise "@Name" as plain text.
 * getUser(id) → user row or null. Returns { text, ids } (ids without duplicates, in order).
 */
export function normalizeMentions(text, { getUser, allowed, max = 20 }) {
  const ids = [];
  const out = String(text ?? '').replace(MENTION_RE, (m, name, rawId) => {
    const u = getUser(Number(rawId));
    if (!u || !allowed(u) || (ids.length >= max && !ids.includes(u.id))) return `@${name}`;
    if (!ids.includes(u.id)) ids.push(u.id);
    const shown = String(u.display_name || u.username || name).replace(/[\]\n]/g, ' ').slice(0, 120).trim() || name;
    return `@[${shown}](user:${u.id})`;
  });
  return { text: out, ids };
}
