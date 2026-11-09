// Record of the emergency command helfi-admin (src/cli.js), shown under Administration → System.
export const EMERGENCY_LOG_KEY = 'security.emergencyLog';

/** Last uses, newest first – only well-formed entries. */
export function readEmergencyLog(db) {
  try {
    const raw = db.prepare('SELECT value FROM settings WHERE key=?').get(EMERGENCY_LOG_KEY)?.value;
    const list = JSON.parse(raw || '[]');
    if (!Array.isArray(list)) return [];
    return list.filter((e) => e && typeof e.at === 'string' && ['reset', 'create'].includes(e.action))
      .map((e) => ({ at: e.at, action: e.action, username: String(e.username || '').slice(0, 64), mfaReset: !!e.mfaReset }));
  } catch { return []; }
}

/** Adds an entry (keeps the last 20). */
export function addEmergencyLog(db, entry) {
  const list = readEmergencyLog(db);
  list.unshift(entry);
  db.prepare('INSERT INTO settings(key,value,secret) VALUES(?,?,0) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
    .run(EMERGENCY_LOG_KEY, JSON.stringify(list.slice(0, 20)));
}
