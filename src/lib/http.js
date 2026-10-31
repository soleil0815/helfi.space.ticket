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

export function str(v, max = 10000) {
  if (v === undefined || v === null) return '';
  return String(v).slice(0, max);
}

export function oneOf(v, allowed, def) {
  return allowed.includes(v) ? v : def;
}

export function int(v) {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
}
