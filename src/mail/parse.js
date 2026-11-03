// Hilfen zum Auswerten eingehender E-Mails.

/** Sucht "[HS-12]" im Betreff. Liefert { projectKey, number } oder null. */
export function ticketKeyFromSubject(subject) {
  const m = /\[([A-Z][A-Z0-9]{1,9})-(\d{1,9})\]/i.exec(String(subject || ''));
  return m ? { projectKey: m[1].toUpperCase(), number: Number(m[2]) } : null;
}

/** Entfernt "AW:", "Re:", "WG:", "Fwd:" usw. und die Ticketnummer aus dem Betreff. */
export function cleanSubject(subject) {
  let s = String(subject || '').trim();
  let prev;
  do {
    prev = s;
    s = s.replace(/^\s*((re|aw|antw|wg|fw|fwd|sv|vs|tr)\s*(\[\d+\])?\s*:\s*)/i, '');
    s = s.replace(/^\s*\[[A-Z][A-Z0-9]{1,9}-\d{1,9}\]\s*/i, '');
  } while (s !== prev);
  return s.trim();
}

export const MAX_QUOTE_LINE = 1000; // längere Zeilen sind nie eine Zitat-Kopfzeile (und würden die Prüfung verlangsamen)

/** „Am … schrieb …:“ / „On … wrote …:“ – ohne Regex mit verschachtelten Wiederholungen (linear). */
function isReplyHeader(l, caseInsensitiveStart = true) {
  if (l.length > 2 * MAX_QUOTE_LINE + 1) return false;
  if (!(caseInsensitiveStart ? /^(Am|On)\s/i : /^(Am|On)\s/).test(l)) return false;
  const end = l.trimEnd();
  if (!end.endsWith(':')) return false;
  // nach „Am “ mindestens ein Zeichen, dann schrieb/wrote, irgendwo vor dem letzten Doppelpunkt
  const w = /(schrieb|wrote)/i.exec(l.slice(4));
  return !!w && 4 + w.index + w[0].length <= end.length - 1;
}

/**
 * Schneidet zitierten Verlauf aus Antworten ab (Outlook, Gmail, Apple Mail, Thunderbird – de/en).
 * Bleibt danach nichts übrig, wird der Originaltext zurückgegeben.
 */
export function stripQuotedReply(text) {
  const lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
  const markers = [
    /^-{2,}\s*(Original Message|Ursprüngliche Nachricht|Originalnachricht|Forwarded message|Weitergeleitete Nachricht)\s*-{2,}/i,
    /^_{10,}\s*$/, // Outlook-Trennlinie
    (l) => isReplyHeader(l),
    /^(Von|From):\s.+$/i,
  ];
  let cut = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].trim();
    if (l.length > MAX_QUOTE_LINE) continue;
    if (markers.some((re) => (typeof re === 'function' ? re(l) : re.test(l)))) {
      // "Von:" nur als Kopf eines zitierten Blocks werten (folgende Zeile Gesendet/Sent/An/To/Datum)
      if (/^(Von|From):/i.test(l)) {
        const next = (lines[i + 1] || '').trim();
        if (!/^(Gesendet|Sent|An|To|Datum|Date|Cc|Betreff|Subject):/i.test(next)) continue;
      }
      cut = i;
      break;
    }
    // Zweizeilige Gmail-Variante: "Am Mo., 1. Jan. 2026 um 10:00 Uhr schrieb X <x@y>:" kann umbrechen
    const next = (lines[i + 1] || '').trim();
    if (next.length <= MAX_QUOTE_LINE && isReplyHeader(`${l} ${next}`, false)) { cut = i; break; }
  }
  let body = lines.slice(0, cut);
  // Zitatzeilen ">" am Ende entfernen
  while (body.length && (/^\s*>/.test(body[body.length - 1]) || body[body.length - 1].trim() === '')) body.pop();
  const result = body.join('\n').trim();
  return result || String(text || '').trim();
}

/** Automatische Antworten, Bounces und Massenmails erkennen (keine Tickets daraus, keine Mail-Schleifen). */
export function isAutomated(headers, fromAddress) {
  const get = (k) => {
    const v = headers?.get ? headers.get(k) : headers?.[k];
    if (v === undefined || v === null) return '';
    return typeof v === 'object' ? (v.value ?? v.text ?? JSON.stringify(v)) : String(v);
  };
  const autoSubmitted = get('auto-submitted').toLowerCase();
  if (autoSubmitted && autoSubmitted !== 'no') return true;
  if (/^(bulk|junk|list|auto_reply)$/i.test(get('precedence').trim())) return true;
  if (get('x-autoreply') || get('x-autorespond')) return true;
  if (/^(mailer-daemon|postmaster|no-?reply|noreply)@/i.test(String(fromAddress || ''))) return true;
  return false;
}

/** Einfache Prüfung einer E-Mail-Adresse. */
export function isEmail(v) {
  return /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(String(v || ''));
}

/**
 * Unzustellbarkeitsbericht (Bounce/NDR) oder Lesebestätigung erkennen.
 * raw: Anfang der Rohmail als Text (für Kopfzeilen, die mailparser verwirft, und den Teil
 * message/delivery-status). Liefert null oder { kind: 'bounce'|'receipt', failed: [Adressen], refs: [Message-IDs] }.
 */
export function deliveryReport(parsed, raw = '') {
  const ct = parsed?.headers?.get?.('content-type');
  const type = String(ct?.value || '').toLowerCase();
  const reportType = String(ct?.params?.['report-type'] || '').toLowerCase();
  const from = String(parsed?.from?.value?.[0]?.address || '').toLowerCase();
  const rp = parsed?.headers?.get?.('return-path');
  const nullSender = !!rp && !(rp.value || []).some((a) => a.address) && !/@/.test(String(rp.text || ''));
  const text = String(raw || '');
  // Kopfzeilen der obersten Ebene – nie den Mailtext (sonst sperrt jede Mail mit solchen Zeilen beliebige Adressen)
  const head = topHeaders(text);

  const deliveryStatus = type === 'multipart/report' && reportType === 'delivery-status';
  if (type === 'multipart/report' && reportType === 'disposition-notification') return { kind: 'receipt', failed: [], refs: [] };
  const bounce = deliveryStatus
    || /^x-ms-exchange-message-is-ndr:/im.test(head)
    || /^x-failed-recipients:/im.test(head)
    || /^(mailer-daemon|postmaster|microsoftexchange[0-9a-f]{32})@/i.test(from)
    || nullSender;
  if (!bounce) return null;

  const failed = new Set();
  // Final-Recipient/Original-Recipient nur aus dem Teil message/delivery-status eines multipart/report
  const status = deliveryStatus ? deliveryStatusParts(text, String(ct?.params?.boundary || '')) : '';
  for (const m of status.matchAll(/^(?:final|original)-recipient:\s*rfc822\s*;\s*<?([^\s<>;]+@[^\s<>;]+)>?/gim)) failed.add(m[1].toLowerCase());
  for (const m of head.matchAll(/^x-failed-recipients:[ \t]*(.+)$/gim)) {
    for (const a of m[1].split(/[,\s]+/)) if (/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(a)) failed.add(a.toLowerCase());
  }
  const refs = new Set();
  for (const r of [parsed?.inReplyTo, ...(Array.isArray(parsed?.references) ? parsed.references : [parsed?.references])]) {
    if (r) refs.add(String(r).replace(/[<>]/g, '').trim());
  }
  // Die zurückgekommene Originalmail steckt meist im Bericht (Message-ID einer Helfi-Mail)
  for (const m of text.matchAll(/<(helfi\.\d+\.\d+\.[0-9a-f]+(?:\.agent)?@[^>\s]+)>/gi)) refs.add(m[1]);
  return { kind: 'bounce', failed: [...failed], refs: [...refs] };
}

/** Kopfzeilen der obersten Ebene (bis zur ersten Leerzeile). */
function topHeaders(raw) {
  const m = /\r?\n\r?\n/.exec(raw);
  return m ? raw.slice(0, m.index) : raw;
}

/** Inhalt der Teile mit Content-Type message/delivery-status (bzw. message/global-delivery-status) eines multipart/report. */
function deliveryStatusParts(raw, boundary) {
  if (!boundary) return '';
  const body = raw.slice(topHeaders(raw).length);
  const out = [];
  for (const part of body.split(`--${boundary}`).slice(1)) {
    const p = part.replace(/^[ \t]*\r?\n/, '');
    const h = topHeaders(p);
    if (/^content-type:[ \t]*message\/(global-)?delivery-status\b/im.test(h)) out.push(p.slice(h.length));
  }
  return out.join('\n');
}
