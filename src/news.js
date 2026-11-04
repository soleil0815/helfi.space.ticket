// What's new per version (src/news.json): shown once after an update, all versions can be looked up.
// Entry with version "" = the version currently built (config.version) – so nothing needs to be changed at release.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { log } from './lib/log.js';

export const AUDIENCES = ['all', 'agent', 'admin'];

export function loadNews(file = fileURLToPath(new URL('./news.json', import.meta.url))) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(data.entries) ? data.entries : [];
  } catch (e) {
    log.warn('News not readable', { error: e.message });
    return [];
  }
}

/** Which audiences does this role see? Users: all; agents: + agent; admins: everything */
export function audiencesFor(role) {
  if (role === 'admin') return new Set(AUDIENCES);
  if (role === 'agent') return new Set(['all', 'agent']);
  return new Set(['all']);
}

export function createNews(db, { entries = loadNews(), version = config.version } = {}) {
  const resolved = entries.map((e) => ({ ...e, version: e.version || version }));

  /** Entries for this account, newest first, only matching items; texts in both languages */
  function list(user) {
    const aud = audiencesFor(user.role);
    return resolved
      .map((e) => ({ version: e.version, date: e.date || null, items: (e.items || []).filter((i) => aud.has(i.audience)).map((i) => ({ de: i.de, en: i.en })) }))
      .filter((e) => e.items.length);
  }

  /** News of the current version that this account has not seen yet (otherwise null) */
  function unseen(user) {
    if (!user || user.news_seen === version) return null;
    return list(user).find((e) => e.version === version) || null;
  }

  function markSeen(user) {
    db.prepare('UPDATE users SET news_seen=? WHERE id=?').run(version, user.id);
  }

  return { list, unseen, markSeen, version };
}
