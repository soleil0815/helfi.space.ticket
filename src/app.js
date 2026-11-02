// Baut die Express-Anwendung zusammen (ohne zu lauschen – so lässt sie sich testen).
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import helmet from 'helmet';
import { brandRoutes } from './brand.js';
import { createLinks } from './itil/links.js';
import { createMajor } from './itil/major.js';
import { createSla } from './itil/sla.js';
import { createFields } from './itil/fields.js';
import { createProblems } from './itil/problems.js';
import { createApprovals } from './itil/approvals.js';
import { createChanges } from './itil/changes.js';
import { createKb } from './itil/kb.js';
import { createCatalog } from './itil/catalog.js';
import { createCmdb } from './itil/cmdb.js';
import { createSurvey } from './itil/survey.js';
import { config, paths } from './config.js';
import { createSettings } from './settings.js';
import { createSessions, parseCookies, createLoginLimiter } from './auth/session.js';
import { createNetworkPolicy } from './auth/network.js';
import { createMfa } from './auth/mfa.js';
import { createUsers } from './users.js';
import { createTickets } from './tickets.js';
import { createMailer, wireNotifications } from './mail/smtp.js';
import { createMailProcessor, createImapPoller } from './mail/imap.js';
import { createSuppressions } from './mail/rules.js';
import { createCanned } from './canned.js';
import { createReports } from './reports.js';
import { findByEmail as ldapFindByEmail } from './auth/ldap.js';
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
  const links = createLinks(db, tickets);

  const suppressions = createSuppressions(db);
  const mailer = createMailer(db, settings, { suppressions });
  const processor = createMailProcessor({ db, settings, tickets, users, adLookup: ldapFindByEmail, suppressions });
  const poller = createImapPoller({ settings, processor });
  const limiter = createLoginLimiter();
  const mfa = createMfa({ db, settings, sessions, users, policy, limiter });
  // vor den Mails registriert: die „Erledigt“-Mail braucht die frisch angelegte Umfrage
  const survey = createSurvey(db, tickets, settings);
  wireNotifications({ tickets, mailer, settings, users, survey });
  const major = createMajor(db, tickets);
  const fields = createFields(db, tickets);
  const problems = createProblems(db, tickets, fields);
  const approvals = createApprovals(db, users);
  const kb = createKb(db, tickets);
  const cmdb = createCmdb(db, tickets, users);
  const catalog = createCatalog(db, tickets, approvals, fields, settings, { mailer, users, baseUrl: config.baseUrl, t });
  const changes = createChanges(db, tickets, fields, approvals, settings, { mailer, users, baseUrl: config.baseUrl, t });
  const sla = createSla(db, tickets, settings, { mailer, users, baseUrl: config.baseUrl, t });

  // Ersteinrichtung: einmaliger Code, nur solange es keine Benutzer gibt
  const setup = { token: null };
  if (db.prepare('SELECT COUNT(*) n FROM users').get().n === 0) {
    setup.token = process.env.HELFI_SETUP_TOKEN || randomToken(9);
    const line = '='.repeat(64);
    console.log(`\n${line}\n  Helfi.Space – Ersteinrichtung / initial setup\n  Einrichtungscode / setup code:  ${setup.token}\n  ${config.baseUrl}/setup\n${line}\n`);
  }

  const jiraImporter = createJiraImporter({ db, tickets, users });
  const canned = createCanned(db);
  const reports = createReports(db);
  const ctx = { links, major, sla, fields, problems, approvals, changes, kb, catalog, cmdb, survey, db, settings, sessions, users, tickets, mailer, processor, poller, limiter, setup, jiraImporter, policy, mfa, canned, reports, suppressions, ldapCertWarning: null };

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
        'form-action': ["'self'"],
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
  // Express 5: ohne JSON-Body ist req.body undefined → immer ein Objekt bereitstellen
  app.use((req, _res, next) => { if (!req.body || typeof req.body !== 'object') req.body = {}; next(); });

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

  // Erscheinungsbild (Logo, Farben) – öffentlich, auch für die Anmeldeseite
  brandRoutes(app, ctx.settings);

  // Statische Dateien + SPA
  // Immer kurz nachfragen (ETag): nach einem Update kommt sofort die neue Oberfläche, Unverändertes wird nicht neu übertragen
  app.use(express.static(config.publicDir, { index: false, maxAge: 0, setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache') }));
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
    res.status(status).json({ error: { code, message: hasKey(code) ? t(lang, code, { detail: err.detail ?? '' }) : code, detail: err.detail } });
  });

  return { app, ctx };
}
