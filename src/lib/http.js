// Hilfen für Fehler und Eingabeprüfung in der API.
export class HttpError extends Error {
  /** @param {number} status @param {string} code i18n-Schlüssel, z. B. 'err.notFound' */
  constructor(status, code, detail) {
    super(code);
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

export const notFound = () => new HttpError(404, 'err.notFound');
export const forbidden = () => new HttpError(403, 'err.forbidden');
export const badRequest = (detail) => new HttpError(400, 'err.badRequest', detail);

/** Text aus Eingabe: nur Zeichenketten und Zahlen, alles andere (Objekte, Arrays) wird zu '' */
export function str(v, max = 10000) {
  if (typeof v === 'string') return v.slice(0, max);
  if (typeof v === 'number' && Number.isFinite(v)) return String(v).slice(0, max);
  if (typeof v === 'boolean') return String(v);
  return '';
}

/** JJJJ-MM-TT oder null */
export function isoDate(v) {
  const s = str(v, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s)) ? s : null;
}

export function oneOf(v, allowed, def) {
  return allowed.includes(v) ? v : def;
}

export function int(v) {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
}
