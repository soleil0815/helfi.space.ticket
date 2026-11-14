// Assembles the Express application (without listening – so it can be tested).
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import helmet from 'helmet';
import { brandRoutes, isHexColor } from './brand.js';
import { createMobileSw } from './pwa.js';
import { createLinks } from './itil/links.js';
import { createMajor } from './itil/major.js';
import { createSla } from './itil/sla.js';
import { createReminders } from './itil/reminders.js';
import { createFields } from './itil/fields.js';
import { createProblems } from './itil/problems.js';
import { createApprovals } from './itil/approvals.js';
import { createChanges } from './itil/changes.js';
import { createKb } from './itil/kb.js';
import { createCatalog } from './itil/catalog.js';
import { createPortal } from './portal.js';
import { createCmdb } from './itil/cmdb.js';
import { createSurvey } from './itil/survey.js';
import { createItilReports } from './itil/itilReports.js';
import { createKbComments } from './itil/kbcomments.js';
import { createKbVotes } from './itil/kbvotes.js';
import { config, paths } from './config.js';
import { createSettings } from './settings.js';
import { createSessions, parseCookies, createLoginLimiter } from './auth/session.js';
import { createNetworkPolicy } from './auth/network.js';
import { createMfa } from './auth/mfa.js';
import { createPasskeys } from './auth/passkeys.js';
import { createUsers } from './users.js';
import { createTickets } from './tickets.js';
import { createMailer, wireNotifications } from './mail/smtp.js';
import { createMailProcessor, createImapPoller } from './mail/imap.js';
import { createSuppressions } from './mail/rules.js';
import { createCanned } from './canned.js';
import { createNews } from './news.js';
import { createReports } from './reports.js';
import { findByEmail as ldapFindByEmail, searchPeople as ldapSearchPeople, findByGuid as ldapFindByGuid, findBySid as ldapFindBySid } from './auth/ldap.js';
import { createJiraImporter } from './import/jira-import.js';
import { createImportCore } from './import/core.js';
import { createApi } from './routes/api.js';
import { createSelfService } from './auth/selfservice.js';
import { createAi } from './ai.js';
import { createAiClassifier } from './ai-classify.js';
import { createExamples } from './examples.js';
import { createAiDuplicates } from './ai-duplicates.js';
import { createOidcRoutes } from './routes/oidc.js';
import { HttpError } from './lib/http.js';
import { t, langFromHeader, normalizeLang, hasKey } from './i18n.js';
import { log } from './lib/log.js';
import { randomToken } from './lib/crypto.js';
import { httpsMiddleware, createHttpsHosts } from './https.js';

/**
 * Apply HELFI_TRUST_PROXY: list of addresses/networks or loopback/linklocal/uniquelocal.
 * "true"/"false"/plain numbers (hop count) and invalid values are NOT applied
 * ("true" would mean: trust every X-Forwarded-For) – warning in the log and default "loopback".
 * Returns the value actually used.
 */
export function applyTrustProxy(app, raw) {
  const value = String(raw ?? '').trim();
  const fallback = (why) => {
    log.warn(`HELFI_TRUST_PROXY="${value}" ${why} – using "loopback". Please specify the proxy address(es), e.g. "loopback, 10.0.10.5".`);
    app.set('trust proxy', 'loopback');
    return 'loopback';
  };
  if (!value) { app.set('trust proxy', 'loopback'); return 'loopback'; }
  if (/^(true|false|yes|no|ja|nein|on|off)$/i.test(value)) return fallback('is not a valid value (yes/no is not supported)');
  if (/^\d+$/.test(value)) return fallback('is not a valid value (number of proxies is not supported)');
  try { app.set('trust proxy', value); } catch (e) { return fallback(`is invalid (${e.message})`); }
  return value;
}

export function createApp(db) {
  fs.mkdirSync(paths.attachments, { recursive: true });
  const settings = createSettings(db);
  const policy = createNetworkPolicy(settings);
  const sessions = createSessions(db, { policy, settings });
  const users = createUsers(db);
  const tickets = createTickets(db, users, { settings });
  const links = createLinks(db, tickets);

  const suppressions = createSuppressions(db);
  const mailer = createMailer(db, settings, { suppressions });
  const processor = createMailProcessor({ db, settings, tickets, users, adLookup: ldapFindByEmail, suppressions });
  const poller = createImapPoller({ settings, processor });
  const limiter = createLoginLimiter();
  const mfa = createMfa({ db, settings, sessions, users, policy, limiter });
  // registered before the mails: the "Resolved" mail needs the freshly created survey
  const survey = createSurvey(db, tickets, settings);
  wireNotifications({ tickets, mailer, settings, users, survey });
  const major = createMajor(db, tickets);
  const fields = createFields(db, tickets);
  const problems = createProblems(db, tickets, fields);
  const approvals = createApprovals(db, users);
  const kb = createKb(db, tickets);
  const cmdb = createCmdb(db, tickets, users);
  const kbComments = createKbComments(db, kb, { mailer, users, settings, t, baseUrl: config.baseUrl });
  const kbVotes = createKbVotes(db, kb);
  const catalog = createCatalog(db, tickets, approvals, fields, settings, { mailer, users, baseUrl: config.baseUrl, t });
  const changes = createChanges(db, tickets, fields, approvals, settings, { mailer, users, baseUrl: config.baseUrl, t });
  const sla = createSla(db, tickets, settings, { mailer, users, baseUrl: config.baseUrl, t });
  const reminders = createReminders(db, settings, { mailer, users, baseUrl: config.baseUrl, t });
  const itilReports = createItilReports(db, sla);
  const portal = createPortal(db, { catalog, kb });

  // Initial setup: one-time code, only as long as there are no users
  const setup = { token: null };
  if (db.prepare('SELECT COUNT(*) n FROM users').get().n === 0) {
    setup.token = process.env.HELFI_SETUP_TOKEN || randomToken(9);
    const line = '='.repeat(64);
    console.log(`\n${line}\n  Helfi.Space – Ersteinrichtung / initial setup\n  Einrichtungscode / setup code:  ${setup.token}\n  ${config.baseUrl}/setup\n${line}\n`);
  }

  const importer = createImportCore({ db, tickets, users });
  const jiraImporter = createJiraImporter({ core: importer });
  const canned = createCanned(db);
  const news = createNews(db);
  const reports = createReports(db);
  const selfService = createSelfService({ db, settings, users, sessions, mailer, baseUrl: config.baseUrl });
  const ai = createAi({ db, settings, tickets });
  const aiClassifier = createAiClassifier({ db, settings, tickets, ai });
  const examples = createExamples({ db, canned, catalog, kb });
  const aiDuplicates = createAiDuplicates({ db, tickets, ai });
  const ctx = { links, major, sla, reminders, fields, problems, approvals, changes, kb, kbComments, kbVotes, catalog, portal, cmdb, survey, itilReports, db, settings, sessions, users, tickets, mailer, processor, poller, limiter, setup, jiraImporter, importer, policy, mfa, canned, news, reports, suppressions, selfService, ai, aiClassifier, aiDuplicates, examples, ldapCertWarning: null,
    // Directory for participants from AD (replaceable in tests)
    directory: { search: ldapSearchPeople, byGuid: ldapFindByGuid, bySid: ldapFindBySid, byEmail: ldapFindByEmail } };
  // Passkeys use ctx.directory at sign-in time (tests replace it)
  ctx.passkeys = createPasskeys(ctx);

  const app = express();
  app.disable('x-powered-by');
  config.trustProxy = applyTrustProxy(app, config.trustProxy);

  app.use(helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        'script-src': ["'self'"],
        'style-src': ["'self'"],
        'img-src': ["'self'", 'data:', 'blob:'],
        'connect-src': ["'self'"],
        // No web fonts (system fonts only) – no "https:"/"data:" from the Helmet defaults
        'font-src': ["'self'"],
        // Service worker of the installable mobile app (/m/sw.js)
        'worker-src': ["'self'"],
        'form-action': ["'self'"],
        'upgrade-insecure-requests': config.baseUrl.startsWith('https://') ? [] : null,
      },
    },
    // HSTS comes from httpsMiddleware below (only where Helfi.Space had to redirect itself – never twice)
    strictTransportSecurity: false,
    crossOriginOpenerPolicy: { policy: 'same-origin' },
    referrerPolicy: { policy: 'same-origin' },
  }));
  // Browser features the app never uses are switched off (ZAP 10063). Kept: clipboard-write (copy link/codes),
  // web-share (recovery codes on the phone), fullscreen for the own pages.
  app.use((_req, res, next) => {
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), display-capture=(), '
      + 'fullscreen=(self), clipboard-read=(), clipboard-write=(self), web-share=(self), browsing-topics=()');
    next();
  });

  // http:// → https:// and HSTS behind the reverse proxy – same rules as Catalytix and AssetLotse (see https.js).
  // The target always comes from HELFI_BASE_URL, never from the Host header (no open redirect). Direct requests
  // (port 8080, health check) are never redirected.
  const https = httpsMiddleware(app, { baseUrl: config.baseUrl, mode: config.forceHttps, hsts: config.hsts,
    hosts: createHttpsHosts(paths.httpsHosts) });
  if (https) app.use(https);

  app.get('/healthz', (_req, res) => {
    try { db.prepare('SELECT 1').get(); res.json({ ok: true, version: config.version }); }
    catch { res.status(503).json({ ok: false }); }
  });

  app.use(parseCookies);
  app.use(sessions.middleware);
  app.use(express.json({ limit: '2mb' }));
  // Express 5: without a JSON body req.body is undefined → always provide an object
  app.use((req, _res, next) => { if (!req.body || typeof req.body !== 'object') req.body = {}; next(); });

  // API answers (ticket data) are never stored by the browser; file routes set their own header
  app.use('/api', (_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  // CSRF protection: writing API calls need a custom header (browsers only send it
  // cross-site after a CORS grant, which does not exist here).
  app.use('/api', (req, _res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    if (req.get('X-Helfi-Request') !== '1') return next(new HttpError(403, 'err.csrf'));
    next();
  });

  app.use('/api', createApi(ctx));
  app.use('/api', (_req, _res, next) => next(new HttpError(404, 'err.notFound')));
  app.use('/auth/oidc', createOidcRoutes(ctx));

  // Branding (logo, colors) – public, also for the sign-in page
  brandRoutes(app, ctx.settings);

  // Web app manifest: "Add to home screen" / "Install app" (name and colour from the settings).
  // The app starts in the mobile UI (/m/, inside the service worker's scope, so a start without
  // connection shows the offline page); on tablets and computers /m/ forwards to the desktop UI.
  // id "/" keeps the identity of installations made before start_url pointed to /m/.
  app.get('/manifest.webmanifest', (_req, res) => {
    const name = String(ctx.settings.get('general.title') || 'Helfi.Space').slice(0, 60);
    const color = isHexColor(ctx.settings.get('brand.color')) ? ctx.settings.get('brand.color').toUpperCase() : null;
    // The mobile UI has a white top bar; a coloured header (brand setting) colours the window bar too
    const theme = color && ctx.settings.get('brand.header') === 'color' ? color : '#FFFFFF';
    res.setHeader('Content-Type', 'application/manifest+json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.send(JSON.stringify({
      id: '/', name, short_name: name.length <= 15 ? name : 'Helfi.Space',
      start_url: '/m/', scope: '/', display: 'standalone', orientation: 'any',
      background_color: '#FFFFFF', theme_color: theme,
      icons: [
        { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
        { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
        { src: '/icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
      ],
    }));
  });

  // Service worker of the mobile app: generated (shell list + version), never cached by the HTTP cache
  const mobileSw = createMobileSw(config.publicDir, () => config.version);
  app.get('/m/sw.js', (_req, res) => {
    res.setHeader('Content-Type', 'text/javascript; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.send(mobileSw.script());
  });

  // Mobile UI (phones): own entry page for /m and /m/… (app paths without a file extension;
  // its CSS/JS under /m/ come from the static files below)
  const mobileHtml = path.join(config.publicDir, 'm', 'index.html');
  // Start page with a slash: only /m/… lies inside the service worker's scope (offline page)
  app.get(/^\/m$/, (req, res) => {
    const q = req.originalUrl.indexOf('?');
    res.redirect(302, `/m/${q >= 0 ? req.originalUrl.slice(q) : ''}`);
  });
  app.get(/^\/m(?:\/(?:[^.]*))?$/, (_req, res) => {
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(mobileHtml);
  });

  // Static files + SPA
  // Always revalidate (ETag): after an update the new UI arrives immediately, unchanged files are not re-sent
  app.use(express.static(config.publicDir, { index: false, maxAge: 0, setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache') }));
  const indexHtml = path.join(config.publicDir, 'index.html');
  app.get(/^\/(?!api\/|auth\/).*/, (_req, res) => {
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(indexHtml);
  });

  // Error handling: code → text in the user's language
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
