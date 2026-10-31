// Baut die Express-Anwendung zusammen (ohne zu lauschen – so lässt sie sich testen).
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import helmet from 'helmet';
import { config, paths } from './config.js';
import { createSettings } from './settings.js';
import { createSessions, parseCookies, createLoginLimiter } from './auth/session.js';
import { createNetworkPolicy } from './auth/network.js';
import { createMfa } from './auth/mfa.js';
import { createUsers } from './users.js';
import { createTickets } from './tickets.js';
import { createMailer, wireNotifications } from './mail/smtp.js';
import { createMailProcessor, createImapPoller } from './mail/imap.js';
import { createJiraImporter } from './import/jira-import.js';
import { createApi } from './routes/api.js';
import { createOidcRoutes } from './routes/oidc.js';
import { HttpError } from './lib/http.js';
import { t, langFromHeader, normalizeLang, hasKey } from './i18n.js';
import { log } from './lib/log.js';
import { randomToken } from './lib/crypto.js';

export function createApp(db) {
  fs.mkdirSync(paths.attachments, { recursive: true });
  const settings = createSettings(db);
  const policy = createNetworkPolicy(settings);
  const sessions = createSessions(db, { policy });
  const users = createUsers(db);
  const tickets = createTickets(db, users);
  const mailer = createMailer(db, settings);
  const processor = createMailProcessor({ db, settings, tickets, users });
  const poller = createImapPoller({ settings, processor });
  const limiter = createLoginLimiter();
  const mfa = createMfa({ db, settings, sessions, users, policy, limiter });
  wireNotifications({ tickets, mailer, settings, users });

  // Ersteinrichtung: einmaliger Code, nur solange es keine Benutzer gibt
  const setup = { token: null };
  if (db.prepare('SELECT COUNT(*) n FROM users').get().n === 0) {
    setup.token = process.env.HELFI_SETUP_TOKEN || randomToken(9);
    const line = '='.repeat(64);
    console.log(`\n${line}\n  Helfi.Space – Ersteinrichtung / initial setup\n  Einrichtungscode / setup code:  ${setup.token}\n  ${config.baseUrl}/setup\n${line}\n`);
  }

  const jiraImporter = createJiraImporter({ db, tickets, users });
  const ctx = { db, settings, sessions, users, tickets, mailer, processor, poller, limiter, setup, jiraImporter, policy, mfa, ldapCertWarning: null };

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);

  app.use(helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        'script-src': ["'self'"],
        'style-src': ["'self'"],
        'img-src': ["'self'", 'data:', 'blob:'],
        'connect-src': ["'self'"],
        'form-action': ["'self'", 'https:'],
        'upgrade-insecure-requests': config.baseUrl.startsWith('https://') ? [] : null,
      },
    },
    strictTransportSecurity: config.baseUrl.startsWith('https://'),
    crossOriginOpenerPolicy: { policy: 'same-origin' },
    referrerPolicy: { policy: 'same-origin' },
  }));

  app.get('/healthz', (_req, res) => {
    try { db.prepare('SELECT 1').get(); res.json({ ok: true, version: config.version }); }
    catch { res.status(503).json({ ok: false }); }
  });

  app.use(parseCookies);
  app.use(sessions.middleware);
  app.use(express.json({ limit: '2mb' }));

  // CSRF-Schutz: schreibende API-Aufrufe brauchen einen eigenen Header (Browser senden ihn
  // fremdseitig nur nach CORS-Freigabe, die es hier nicht gibt).
  app.use('/api', (req, _res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    if (req.get('X-Helfi-Request') !== '1') return next(new HttpError(403, 'err.csrf'));
    next();
  });

  app.use('/api', createApi(ctx));
  app.use('/api', (_req, _res, next) => next(new HttpError(404, 'err.notFound')));
  app.use('/auth/oidc', createOidcRoutes(ctx));

  // Statische Dateien + SPA
  app.use(express.static(config.publicDir, { index: false, maxAge: '1h' }));
  const indexHtml = path.join(config.publicDir, 'index.html');
  app.get(/^\/(?!api\/|auth\/).*/, (_req, res) => {
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(indexHtml);
  });

  // Fehlerbehandlung: Code → Text in der Sprache des Benutzers
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => {
    const lang = normalizeLang(req.user?.language || langFromHeader(req.get('accept-language')));
    let status = err.status || err.statusCode || 500;
    let code = err instanceof HttpError ? err.code : (status === 400 ? 'err.badRequest' : 'err.internal');
    if (err.type === 'entity.parse.failed') { status = 400; code = 'err.badRequest'; }
    if (status >= 500) log.error(`${req.method} ${req.originalUrl}: ${err.stack || err.message}`);
    res.status(status).json({ error: { code, message: hasKey(code) ? t(lang, code) : code, detail: err.detail } });
  });

  return { app, ctx };
}
