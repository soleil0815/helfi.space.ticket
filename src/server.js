// Startpunkt: Datenbank öffnen, Hintergrundaufgaben starten, HTTP-Server.
import fs from 'node:fs';
import { config, paths } from './config.js';
import { openDatabase, backupDatabase, pruneBackups, DatabaseTooNewError } from './db.js';
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
  } catch (e) {
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

  // Täglich: Sicherung, alte Sitzungen, LDAPS-Zertifikat prüfen
  const daily = async () => {
    try {
      ctx.sessions.purgeExpired();
      await backupDatabase(db, 'taeglich');
      pruneBackups(config.backupKeepDays);
    } catch (e) { log.error('Tägliche Sicherung fehlgeschlagen', { error: e.message }); }
    await checkLdapCertificate(ctx);
  };
  setTimeout(() => checkLdapCertificate(ctx), 10_000).unref();
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
  const cfg = ctx.settings.group('ldap');
  if (!cfg.enabled || cfg.security === 'none' || cfg.tlsMode !== 'pinned' || !cfg.host) return;
  try {
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
        ctx.ldapCertWarning = `Das hinterlegte LDAPS-Zertifikat (${c.subject}) läuft in ${Math.max(0, Math.round(days))} Tagen ab.`;
      }
    }
  } catch (e) {
    ctx.ldapCertWarning = `LDAPS-Verbindung mit hinterlegtem Zertifikat fehlgeschlagen: ${e.message}`;
    log.warn(ctx.ldapCertWarning);
  }
}

main().catch((e) => {
  log.error(`Start fehlgeschlagen: ${e.stack || e.message}`);
  process.exit(1);
});
