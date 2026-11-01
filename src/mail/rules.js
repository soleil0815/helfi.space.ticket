// Schutz vor Mail-Schleifen: Absender-Regeln und vorübergehend gesperrte Empfänger.
import { log } from '../lib/log.js';

export const SUPPRESS_DAYS = 7;
export const RULE_ACTIONS = ['noreply', 'ignore'];
const MAX_RULES = 200;

/**
 * Absender-Regeln aus der Einstellung imap.senderRules (JSON-Liste).
 * pattern: Adresse oder Muster mit * (z. B. "*@zabbix.firma.local"), Groß-/Kleinschreibung egal.
 * action: noreply = Ticket anlegen, aber nie Mails an diese Adresse schicken; ignore = Mail nicht verarbeiten.
 * project: optional Projektschlüssel für neue Tickets.
 */
export function parseRules(json) {
  let list;
  try { list = JSON.parse(json || '[]'); } catch { return []; }
  if (!Array.isArray(list)) return [];
  return list.slice(0, MAX_RULES).map((r) => ({
    pattern: String(r?.pattern || '').trim().toLowerCase().slice(0, 254),
    action: RULE_ACTIONS.includes(r?.action) ? r.action : 'noreply',
    project: String(r?.project || '').trim().toUpperCase().slice(0, 10),
  })).filter((r) => r.pattern && /[^*]/.test(r.pattern));
}

function patternToRegExp(pattern) {
  const esc = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^\\s]*');
  return new RegExp(`^${esc}$`, 'i');
}

/** Erste passende Regel für eine Adresse (oder null). */
export function matchRule(rules, address) {
  const a = String(address || '').trim().toLowerCase();
  if (!a) return null;
  return rules.find((r) => patternToRegExp(r.pattern).test(a)) || null;
}

export function createSuppressions(db) {
  const getStmt = db.prepare('SELECT * FROM mail_suppressions WHERE address=? AND until>?');
  return {
    /** Adresse für SUPPRESS_DAYS Tage sperren (verlängert eine bestehende Sperre). */
    add(address, reason = '') {
      const a = String(address || '').trim().toLowerCase();
      if (!a) return;
      const until = new Date(Date.now() + SUPPRESS_DAYS * 864e5).toISOString();
      db.prepare(`INSERT INTO mail_suppressions(address,reason,until) VALUES(?,?,?)
        ON CONFLICT(address) DO UPDATE SET reason=excluded.reason, until=excluded.until`).run(a, String(reason).slice(0, 300), until);
      log.info(`Empfänger ${a} für ${SUPPRESS_DAYS} Tage gesperrt (unzustellbar)`);
    },
    isBlocked(address) {
      return !!getStmt.get(String(address || '').trim().toLowerCase(), new Date().toISOString());
    },
    list() {
      return db.prepare('SELECT address, reason, until, created_at FROM mail_suppressions WHERE until>? ORDER BY created_at DESC')
        .all(new Date().toISOString()).map((r) => ({ address: r.address, reason: r.reason, until: r.until, createdAt: r.created_at }));
    },
    remove(address) {
      db.prepare('DELETE FROM mail_suppressions WHERE address=?').run(String(address || '').trim().toLowerCase());
    },
    purgeExpired() { db.prepare('DELETE FROM mail_suppressions WHERE until<=?').run(new Date().toISOString()); },
  };
}
