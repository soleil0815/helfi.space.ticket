// Is there a newer version? For installations that do not update their container automatically.
// Once shortly after the start and then daily, the server asks GitHub for the latest release – a plain
// GET without any data about this installation. Errors are only noted (diagnosis package), never shown.
// Admins see a notice; "Skip this version" hides it until the next one.
import { config } from './config.js';
import { log } from './lib/log.js';

const DEFAULT_URL = 'https://api.github.com/repos/soleil0815/helfi.space.ticket/releases/latest';
const RELEASES = 'https://github.com/soleil0815/helfi.space.ticket/releases';

/** "1.52.0" / "v1.52.0" → [1, 52, 0]; anything else (dev builds, pre-releases) → null */
export function parseVersion(v) {
  const m = /^v?(\d{1,4})\.(\d{1,4})\.(\d{1,4})$/.exec(String(v || '').trim());
  return m ? m.slice(1).map(Number) : null;
}

export function newer(a, b) {
  const x = parseVersion(a); const y = parseVersion(b);
  if (!x || !y) return false;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
}

/**
 * Version pinned in .env (HELFI_VERSION=1.51.1) – then "docker compose pull" alone fetches the old one again.
 * "latest" or empty: not pinned.
 */
export function pinnedVersion(env = process.env) {
  const v = String(env.HELFI_VERSION || '').trim();
  return parseVersion(v) ? v.replace(/^v/, '') : null;
}

export function createUpdateCheck({ settings, version = config.version, url = process.env.HELFI_UPDATE_URL || DEFAULT_URL, fetchImpl = (...a) => fetch(...a), env = process.env } = {}) {
  // Only http(s); an override (forks, tests) must not point anywhere else
  if (!/^https?:\/\/[^\s"'<>]+$/i.test(url)) url = DEFAULT_URL;
  const state = { latest: null, notes: null, checkedAt: null, error: null };
  let running = null;
  let timers = [];

  const enabled = () => !!settings.get('update.check');

  async function check() {
    if (running) return running;
    running = (async () => {
      try {
        const res = await fetchImpl(url, {
          headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Helfi.Space' },
          signal: AbortSignal.timeout(15000), redirect: 'error',
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const text = await res.text();
        if (text.length > 512 * 1024) throw new Error('answer too large');
        const j = JSON.parse(text);
        if (!parseVersion(j.tag_name)) throw new Error('no version in the answer');
        state.latest = String(j.tag_name).trim().replace(/^v/, '');
        // Only links to the release page on GitHub
        const tag = encodeURIComponent(`v${state.latest}`);
        state.notes = `${RELEASES}/tag/${tag}`;
        state.error = null;
        if (newer(state.latest, version)) log.info(`Update check: version ${state.latest} is available (installed: ${version})`);
      } catch (e) {
        state.error = String(e.message || e).slice(0, 200);
        log.warn('Update check failed', { error: state.error });
      } finally {
        state.checkedAt = Date.now();
        running = null;
      }
    })();
    return running;
  }

  return {
    check,

    /** Shortly after the start, then daily – only if switched on (asked anew each time) */
    start({ firstAfterMs = 60_000 } = {}) {
      const run = () => { if (enabled()) check(); };
      timers = [setTimeout(run, firstAfterMs), setInterval(run, 24 * 3600 * 1000)];
      for (const tm of timers) tm.unref?.();
    },
    stop() { for (const tm of timers) clearTimeout(tm); timers = []; },

    /** For admins: what is available (null if nothing, switched off, skipped or a dev build) */
    available() {
      if (!enabled() || !parseVersion(version) || !state.latest || !newer(state.latest, version)) return null;
      if (settings.get('update.skip') === state.latest) return null;
      return { version: state.latest, installed: version, notes: state.notes, pinned: pinnedVersion(env) };
    },

    /** Panel in Administration → System */
    status() {
      return { enabled: enabled(), installed: version, latest: state.latest, notes: state.notes, checkedAt: state.checkedAt, failed: !!state.error, skipped: settings.get('update.skip') || null, available: this.available() };
    },

    /** For the diagnosis package (no URL, no answer text) */
    diagnostics() {
      return {
        enabled: enabled() ? 'yes' : 'no',
        installed: version,
        latest: state.latest || '–',
        'last check': state.checkedAt ? new Date(state.checkedAt).toISOString() : 'not yet',
        'last check failed': state.error ? `yes (${state.error})` : 'no',
        'pinned in .env': pinnedVersion(env) || 'no',
        skipped: settings.get('update.skip') || '–',
      };
    },
  };
}
