// Entry point: open the database, start background tasks, HTTP server.
import fs from 'node:fs';
import { config, paths } from './config.js';
import { openDatabase, backupDatabase, pruneBackups, DatabaseTooNewError, verifyKey, WrongKeyError } from './db.js';
import { initMasterKey } from './lib/crypto.js';
import { createApp } from './app.js';
import * as ldap from './auth/ldap.js';
import { log } from './lib/log.js';

async function main() {
  log.info(`Helfi.Space ${config.version} starting (data: ${config.dataDir})`);
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
  const server = app.listen(config.port, () => log.info(`Ready on port ${config.port} – ${config.baseUrl}`));

  // Email fetching
  ctx.poller.start();
  ctx.sla.start();

  // Clean up old backups right at startup (e.g. after an update)
  try { pruneBackups(ctx.settings.get('backup.keep')); } catch (e) { log.warn('Backup cleanup failed', { error: e.message }); }
  if (process.env.HELFI_BACKUP_KEEP_DAYS) log.warn('HELFI_BACKUP_KEEP_DAYS is no longer used – the number of backups is set under Administration → System.');

  // Daily: backup, old sessions, check LDAPS certificate
  const daily = async () => {
    try {
      ctx.sessions.purgeExpired();
      ctx.suppressions.purgeExpired();
      // Unsent uploads (pasted images, files for a reply) that nobody claimed within a day
      const drafts = ctx.tickets.purgeDrafts();
      if (drafts) log.info(`Removed ${drafts} unsent attachment draft(s)`);
      await backupDatabase(db, 'taeglich');
      pruneBackups(ctx.settings.get('backup.keep'));
    } catch (e) { log.error('Daily backup failed', { error: e.message }); }
    await checkLdapCertificate(ctx).catch(() => {});
  };
  setTimeout(() => checkLdapCertificate(ctx).catch(() => {}), 10_000).unref();
  setInterval(daily, 24 * 3600 * 1000).unref();
  setTimeout(daily, 60 * 60 * 1000).unref(); // first backup one hour after start

  const shutdown = (sig) => {
    log.info(`${sig} received, shutting down ...`);
    ctx.poller.stop();
    server.close(() => { db.close(); process.exit(0); });
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

/** Checks whether the stored LDAPS certificate still matches (e.g. after renewal on the DC). */
async function checkLdapCertificate(ctx) {
  try {
    const cfg = ctx.settings.group('ldap');
    if (!cfg.enabled || cfg.security === 'none' || cfg.tlsMode !== 'pinned' || !cfg.host) return;
    const client = await ldap.connect(cfg);
    // StartTLS checks when connecting; LDAPS at the latest on the first command
    await ldap.readRootDse(client);
    await client.unbind().catch(() => {});
    ctx.ldapCertWarning = null;
    // Report expiring certificates early
    for (const pem of ldap.splitPem(cfg.caPem)) {
      const c = ldap.describeCert(pem);
      const days = (new Date(c.validTo) - Date.now()) / 86400000;
      if (days < 30 && !c.isCA) {
        ctx.ldapCertWarning = { code: 'ldapCertExpiring', subject: c.subject, days: Math.max(0, Math.round(days)) };
      }
    }
  } catch (e) {
    ctx.ldapCertWarning = { code: 'ldapCertFailed', message: e.message };
    log.warn(`LDAPS connection with stored certificate failed: ${e.message}`);
  }
}

main().catch((e) => {
  log.error(`Startup failed: ${e.stack || e.message}`);
  process.exit(1);
});
