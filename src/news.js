// Neuigkeiten je Version (src/news.json): nach einem Update einmal anzeigen, alle Versionen nachlesbar.
// Eintrag mit version "" = die gerade gebaute Version (config.version) – so muss beim Release nichts angepasst werden.
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
    log.warn('Neuigkeiten nicht lesbar', { error: e.message });
    return [];
  }
}

/** Welche Zielgruppen sieht diese Rolle? Benutzer: all; Bearbeiter: + agent; Admins: alles */
export function audiencesFor(role) {
  if (role === 'admin') return new Set(AUDIENCES);
  if (role === 'agent') return new Set(['all', 'agent']);
  return new Set(['all']);
}

export function createNews(db, { entries = loadNews(), version = config.version } = {}) {
  const resolved = entries.map((e) => ({ ...e, version: e.version || version }));

  /** Einträge für dieses Konto, neueste zuerst, nur passende Punkte; Texte in beiden Sprachen */
  function list(user) {
    const aud = audiencesFor(user.role);
    return resolved
      .map((e) => ({ version: e.version, date: e.date || null, items: (e.items || []).filter((i) => aud.has(i.audience)).map((i) => ({ de: i.de, en: i.en })) }))
      .filter((e) => e.items.length);
  }

  /** Neuigkeiten der aktuellen Version, die dieses Konto noch nicht gesehen hat (sonst null) */
  function unseen(user) {
    if (!user || user.news_seen === version) return null;
    return list(user).find((e) => e.version === version) || null;
  }

  function markSeen(user) {
    db.prepare('UPDATE users SET news_seen=? WHERE id=?').run(version, user.id);
  }

  return { list, unseen, markSeen, version };
}
