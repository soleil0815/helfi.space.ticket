// Erscheinungsbild (Corporate Design): Logo, Hauptfarbe, Kopfzeile.
// Das Logo liegt im Datenordner; Farben kommen als /brand.css (aus den Einstellungen erzeugt).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.js';
import { HttpError } from './lib/http.js';

export const DEFAULT_COLOR = '#0C66E4';
export const LOGO_MAX_BYTES = 512 * 1024;
const brandDir = () => path.join(config.dataDir, 'brand');
const logoFile = (type) => path.join(brandDir(), `logo.${type}`);

export const isHexColor = (v) => /^#[0-9a-f]{6}$/i.test(String(v || ''));

const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const toHex = (c) => `#${c.map((x) => Math.round(Math.max(0, Math.min(255, x))).toString(16).padStart(2, '0')).join('')}`.toUpperCase();
/** Farbe mit einer anderen mischen (amount 0…1 Anteil von other) */
export const mix = (hex, other, amount) => toHex(rgb(hex).map((v, i) => v + (rgb(other)[i] - v) * amount));

function luminance(hex) {
  const [r, g, b] = rgb(hex).map((v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
/** Kontrastverhältnis nach WCAG (1 … 21) */
export function contrast(a, b) {
  const [l1, l2] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (l1 + 0.05) / (l2 + 0.05);
}

/** CSS mit den Farben aus den Einstellungen */
export function brandCss(settings) {
  const raw = settings.get('brand.color');
  const color = isHexColor(raw) ? raw.toUpperCase() : DEFAULT_COLOR;
  const lines = [];
  if (color !== DEFAULT_COLOR) {
    lines.push(`:root { --blue: ${color}; --blue-hover: ${mix(color, '#000000', 0.15)}; --blue-press: ${mix(color, '#000000', 0.45)}; --blue-subtle: ${mix(color, '#FFFFFF', 0.9)}; }`);
    lines.push(
      `input:focus, select:focus, textarea:focus { border-color: ${color}; }`,
      `.project-avatar { background: ${color}; }`,
      `.auth-brand { color: var(--blue-hover); }`,
      `.auth-page { background: linear-gradient(180deg, #F7F8F9 0%, var(--blue-subtle) 100%); }`,
    );
  }
  if (settings.get('brand.header') === 'color') {
    // Bei sehr hellen Farben dunkle Schrift in der Kopfzeile
    const fg = contrast(color, '#FFFFFF') >= 3 ? '#FFFFFF' : '#172B4D';
    const veil = fg === '#FFFFFF' ? '#FFFFFF26' : '#091E4224';
    lines.push(
      `.topbar { background: var(--blue); border-bottom-color: transparent; }`,
      `.topbar .brand, .topbar .topnav a, .topbar .topnav a:hover, .topbar .topnav a.active { color: ${fg}; }`,
      `.topbar .topnav a.active { border-bottom-color: ${fg}; }`,
      `.topbar .brand:hover, .topbar .topnav a:hover, .topbar .topbar-user:hover { background: ${veil}; }`,
      `.topbar .btn-primary { background: ${fg}; color: ${fg === '#FFFFFF' ? 'var(--blue)' : '#FFFFFF'}; }`,
      `.topbar .btn-primary:hover { background: ${fg}; opacity: .9; }`,
      `.topbar-search input { border-color: transparent; }`,
      // Logos sind oft in der Hauptfarbe gehalten → auf hellem Grund, damit sie sichtbar bleiben
      `.topbar .brand-logo { background: #FFFFFF; border-radius: 4px; padding: 3px 6px; box-sizing: content-box; }`,
    );
  }
  return `${lines.join('\n')}\n`;
}

/** SVG prüfen: keine Skripte, Ereignisse, eingebetteten Fremdinhalte oder externen Verweise */
export function checkSvg(buf) {
  const text = buf.toString('utf8');
  if (!/<svg[\s>/]/i.test(text)) return 'err.brandNotSvg';
  const bad = [
    /<script/i, /<foreignObject/i, /<iframe/i, /<embed/i, /<object/i, /<!ENTITY/i,
    /\son[a-z]+\s*=/i, /javascript:/i, /data:text\/html/i,
    /(?:xlink:)?href\s*=\s*["']\s*(?!#|data:image\/(?:png|jpeg|gif|webp);)/i,
    /url\(\s*["']?\s*(?!#)/i, /@import/i,
    // dieselben Elemente mit Namensraum-Präfix (<h:script xmlns:h="…/xhtml">)
    /<[\w.-]+:(?:script|foreignObject|iframe|embed|object)/i,
    // Zeichenreferenzen in Attributwerten (jav&#x61;script:, &colon;) – nur die fünf XML-Grundformen
    /=\s*"[^"]*&(?!(?:amp|lt|gt|quot|apos);)/i, /=\s*'[^']*&(?!(?:amp|lt|gt|quot|apos);)/i,
    // CSS-Escapes im style-Attribut (style="fill:u\72l(…)")
    /\sstyle\s*=\s*"[^"]*\\/i, /\sstyle\s*=\s*'[^']*\\/i,
  ];
  if (bad.some((re) => re.test(text))) return 'err.brandUnsafeSvg';
  // CSS: keine Escapes/Zeichenreferenzen (u\72l( ergibt url( und umginge die Prüfung oben)
  const css = [...text.matchAll(/<style[\s>][\s\S]*?(?:<\/style\s*>|$)/gi)].map((m) => m[0]);
  if (css.some((c) => /\\|&#/.test(c))) return 'err.brandUnsafeSvg';
  return null;
}

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Logo aus data-URL speichern → Wert für brand.logo ("png:abc123") */
export function saveLogo(dataUrl) {
  const m = /^data:image\/(png|svg\+xml);base64,([A-Za-z0-9+/=\s]+)$/.exec(String(dataUrl || ''));
  if (!m) throw new HttpError(400, 'err.brandType');
  const type = m[1] === 'png' ? 'png' : 'svg';
  const buf = Buffer.from(m[2], 'base64');
  if (!buf.length) throw new HttpError(400, 'err.brandType');
  if (buf.length > LOGO_MAX_BYTES) throw new HttpError(400, 'err.brandSize');
  if (type === 'png' && !buf.subarray(0, 8).equals(PNG_MAGIC)) throw new HttpError(400, 'err.brandType');
  if (type === 'svg') { const err = checkSvg(buf); if (err) throw new HttpError(400, err); }
  fs.mkdirSync(brandDir(), { recursive: true });
  removeLogo();
  const tmp = `${logoFile(type)}.tmp`;
  fs.writeFileSync(tmp, buf, { mode: 0o640 });
  fs.renameSync(tmp, logoFile(type));
  return `${type}:${crypto.createHash('sha256').update(buf).digest('hex').slice(0, 12)}`;
}

export function removeLogo() {
  for (const type of ['png', 'svg']) fs.rmSync(logoFile(type), { force: true });
}

/** Routen außerhalb von /api: /brand/logo und /brand.css (öffentlich, auch für die Anmeldeseite) */
export function brandRoutes(app, settings) {
  const defaultLogo = path.join(config.publicDir, 'logo.svg');
  app.get('/brand/logo', (req, res) => {
    const [type] = String(settings.get('brand.logo') || '').split(':');
    const file = type && fs.existsSync(logoFile(type)) ? logoFile(type) : defaultLogo;
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // Auch bei direktem Aufruf eines SVG nichts ausführen
    res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox");
    res.type(file.endsWith('.png') ? 'image/png' : 'image/svg+xml');
    res.sendFile(file);
  });
  app.get('/brand.css', (req, res) => {
    const css = brandCss(settings);
    const etag = `"${crypto.createHash('sha1').update(css).digest('hex').slice(0, 16)}"`;
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('ETag', etag);
    if (req.get('If-None-Match') === etag) return res.status(304).end();
    res.type('text/css').send(css);
  });
}
