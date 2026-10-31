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

/**
 * Schneidet zitierten Verlauf aus Antworten ab (Outlook, Gmail, Apple Mail, Thunderbird – de/en).
 * Bleibt danach nichts übrig, wird der Originaltext zurückgegeben.
 */
export function stripQuotedReply(text) {
  const lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
  const markers = [
    /^-{2,}\s*(Original Message|Ursprüngliche Nachricht|Originalnachricht|Forwarded message|Weitergeleitete Nachricht)\s*-{2,}/i,
    /^_{10,}\s*$/, // Outlook-Trennlinie
    /^(Am|On)\s.+(schrieb|wrote)\s*.*:\s*$/i,
    /^(Von|From):\s.+$/i,
  ];
  let cut = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].trim();
    if (markers.some((re) => re.test(l))) {
      // "Von:" nur als Kopf eines zitierten Blocks werten (folgende Zeile Gesendet/Sent/An/To/Datum)
      if (/^(Von|From):/i.test(l)) {
        const next = (lines[i + 1] || '').trim();
        if (!/^(Gesendet|Sent|An|To|Datum|Date|Cc|Betreff|Subject):/i.test(next)) continue;
      }
      cut = i;
      break;
    }
    // Zweizeilige Gmail-Variante: "Am Mo., 1. Jan. 2026 um 10:00 Uhr schrieb X <x@y>:" kann umbrechen
    if (/^(Am|On)\s/.test(l) && /(schrieb|wrote).*:\s*$/i.test(`${l} ${(lines[i + 1] || '').trim()}`)) { cut = i; break; }
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
