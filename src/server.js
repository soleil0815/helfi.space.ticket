// Startpunkt: Datenbank öffnen, Hintergrundaufgaben starten, HTTP-Server.
import fs from 'node:fs';
import { config, paths } from './config.js';
import { openDatabase, backupDatabase, pruneBackups, DatabaseTooNewError, verifyKey, WrongKeyError } from './db.js';
import { initMasterKey } from './lib/crypto.js';
import { createApp } from './app.js';
import * as ldap from './auth/ldap.js';
import { log } from './lib/log.js';

async function main() {
  log.info(`Helfi.Space ${config.version} startet (Daten: ${config.dataDir})`);
  fs.mkdirSync(config.dataDir, { recursive: true });
  initMasterKey();

  let db;
  try {
    db = await openDatabase(paths.db);
    verifyKey(db);
  } catch (e) {
    if (e instanceof WrongKeyError) {
      log.error(e.message);
      process.exit(4);
    }
    if (e instanceof DatabaseTooNewError) {
      log.error(e.message);
      process.exit(3);
    }
    throw e;
  }

  const { app, ctx } = createApp(db);
  const server = app.listen(config.port, () => log.info(`Bereit auf Port ${config.port} – ${config.baseUrl}`));

  // E-Mail-Abruf
  ctx.poller.start();
  ctx.sla.start();

  // Alte Sicherungen gleich beim Start aufräumen (z. B. nach einem Update)
  try { pruneBackups(ctx.settings.get('backup.keep')); } catch (e) { log.warn('Sicherungen aufräumen fehlgeschlagen', { error: e.message }); }
  if (process.env.HELFI_BACKUP_KEEP_DAYS) log.warn('HELFI_BACKUP_KEEP_DAYS wird nicht mehr verwendet – die Anzahl der Sicherungen steht unter Administration → System.');

  // Täglich: Sicherung, alte Sitzungen, LDAPS-Zertifikat prüfen
  const daily = async () => {
    try {
      ctx.sessions.purgeExpired();
      ctx.suppressions.purgeExpired();
      await backupDatabase(db, 'taeglich');
      pruneBackups(ctx.settings.get('backup.keep'));
    } catch (e) { log.error('Tägliche Sicherung fehlgeschlagen', { error: e.message }); }
    await checkLdapCertificate(ctx).catch(() => {});
  };
  setTimeout(() => checkLdapCertificate(ctx).catch(() => {}), 10_000).unref();
  setInterval(daily, 24 * 3600 * 1000).unref();
  setTimeout(daily, 60 * 60 * 1000).unref(); // erste Sicherung eine Stunde nach Start

  const shutdown = (sig) => {
    log.info(`${sig} empfangen, beende ...`);
    ctx.poller.stop();
    server.close(() => { db.close(); process.exit(0); });
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

/** Prüft, ob das hinterlegte LDAPS-Zertifikat noch passt (z. B. nach Erneuerung am DC). */
async function checkLdapCertificate(ctx) {
  try {
    const cfg = ctx.settings.group('ldap');
    if (!cfg.enabled || cfg.security === 'none' || cfg.tlsMode !== 'pinned' || !cfg.host) return;
    const client = await ldap.connect(cfg);
    // StartTLS prüft bereits beim Verbinden; LDAPS spätestens beim ersten Befehl
    await ldap.readRootDse(client);
    await client.unbind().catch(() => {});
    ctx.ldapCertWarning = null;
    // Ablaufende Zertifikate frühzeitig melden
    for (const pem of ldap.splitPem(cfg.caPem)) {
      const c = ldap.describeCert(pem);
      const days = (new Date(c.validTo) - Date.now()) / 86400000;
      if (days < 30 && !c.isCA) {
        ctx.ldapCertWarning = { code: 'ldapCertExpiring', subject: c.subject, days: Math.max(0, Math.round(days)) };
      }
    }
  } catch (e) {
    ctx.ldapCertWarning = { code: 'ldapCertFailed', message: e.message };
    log.warn(`LDAPS-Verbindung mit hinterlegtem Zertifikat fehlgeschlagen: ${e.message}`);
  }
}

main().catch((e) => {
  log.error(`Start fehlgeschlagen: ${e.stack || e.message}`);
  process.exit(1);
});
