// A small stand-in for an OpenAI-compatible model server (like Ollama): fixed, plausible answers
// for the AI pictures, so that no real model is needed.
import http from 'node:http';

export async function startFakeAi(lang) {
  const de = lang === 'de';
  const T = (a, b) => (de ? a : b);
  const models = [
    { name: 'qwen3:14b', size: 9276198565, details: { parameter_size: '14.8B', quantization_level: 'Q4_K_M' } },
    { name: 'gemma3:12b', size: 8149190253, details: { parameter_size: '12.2B', quantization_level: 'Q4_K_M' } },
    { name: 'gpt-oss:20b', size: 13780173839, details: { parameter_size: '20.9B', quantization_level: 'MXFP4' } },
    { name: 'gpt-oss:120b-cloud', size: 384, remote_host: 'https://ollama.com:443', details: { parameter_size: '116.8B', quantization_level: 'MXFP4' } },
    { name: 'nomic-embed-text:latest', size: 274302450, details: { family: 'nomic-bert', families: ['nomic-bert'] } },
  ];
  const answer = (system, user) => {
    if (system.startsWith('Reply with the single word OK')) return 'OK';
    if (system.startsWith('You help IT support agents. Summarize')) {
      return T(`**Worum es geht**\n- Drucker PR-0001 im 2. OG meldet „Papierstau Fach 2“, obwohl kein Papier klemmt.\n\n**Bisher passiert**\n- Tritt auch beim Drucken vom Handy auf.\n- Ursache: verschmutzter Sensor in Fach 2, Ersatzteil bestellt.\n\n**Offen / nächster Schritt**\n- Ersatzteil am Donnerstag einbauen und die Kundin informieren.`,
        `**What it is about**\n- Printer PR-0001 on the 2nd floor reports "Paper jam tray 2" although nothing is stuck.\n\n**What happened so far**\n- Also happens when printing from the phone.\n- Cause: dirty sensor in tray 2, spare part ordered.\n\n**Open / next step**\n- Fit the spare part on Thursday and inform the requester.`);
    }
    if (system.startsWith('You help IT support agent')) {
      return T('vielen Dank für Ihre Geduld. Der Sensor in Fach 2 ist verschmutzt; das Ersatzteil kommt am Donnerstag und wir bauen es direkt ein. Bis dahin drucken Sie bitte über Fach 1 – dort tritt der Fehler nicht auf. Wir melden uns, sobald der Drucker wieder normal läuft.',
        'thank you for your patience. The sensor in tray 2 is dirty; the spare part arrives on Thursday and we will fit it right away. Until then, please print from tray 1 – the error does not occur there. We will let you know as soon as the printer works normally again.');
    }
    if (system.startsWith('You sort IT support tickets into components')) {
      const names = [...system.matchAll(/^\d+\. ([^–\n(]+?)(?: –| \(|$)/gm)].map((m) => m[1].trim());
      const rules = [
        [/vpn|zu ?hause|from home|forticlient/i, /VPN/, T('Zugriff von zu Hause auf das Firmennetz', 'Access to the company network from home')],
        [/drucker|printer|toner|scanner|ausdruck|copies/i, /Drucker|Print/, T('Problem mit Ausdrucken', 'Problem with printouts')],
        [/monitor|laptop|notebook|heiß|hot|gerät|device/i, /Arbeitsplatz|Workplace/, T('Problem mit dem Gerät am Arbeitsplatz', 'Problem with the workplace device')],
        [/outlook|kalender|calendar|termin|appointment/i, /E-Mail|Email/, T('Termine im Kalender betroffen', 'Calendar appointments affected')],
        [/einlogg|log on|kennwort|password/i, /Benutzerkonto|User account/, T('Anmeldung am Konto', 'Signing in to the account')],
      ];
      for (const [re, comp, reason] of rules) {
        if (re.test(user)) {
          const name = names.find((n) => comp.test(n));
          if (name) return JSON.stringify({ component: name, reason });
        }
      }
      return JSON.stringify({ component: null, reason: '' });
    }
    if (system.startsWith('You check IT support tickets for duplicates')) {
      const title = (/\] (.*)/.exec(user) || [])[1] || '';
      const words = title.toLowerCase().split(/\W+/).filter((w) => w.length > 4);
      for (const m of system.matchAll(/^\[([A-Z][A-Z0-9]*-\d+)\] (.*)$/gm)) {
        if (words.some((w) => m[2].toLowerCase().includes(w))) return JSON.stringify({ duplicate: m[1], reason: T('Gleicher Drucker, gleiche Fehlermeldung', 'Same printer, same error message') });
      }
      return JSON.stringify({ duplicate: null, reason: '' });
    }
    if (/Suggest a short, searchable title/.test(system)) return JSON.stringify({ title: T('VPN im Homeoffice verbinden', 'Connect to the VPN from home'), category: 'VPN' });
    if (/You turn a solved IT support ticket into a knowledge base article/.test(system)) return T('## Problem\nDer Drucker meldet „Papierstau“, obwohl kein Papier klemmt.\n\n## Lösung\nSensor in Fach 2 reinigen.', '## Problem\nThe printer reports a paper jam although nothing is stuck.\n\n## Solution\nClean the sensor in tray 2.');
    // Rewrite, shorten, translate, step-by-step: return the text tidied up a little
    return user.replace(/\s+/g, ' ').trim();
  };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (req.url.endsWith('/api/tags')) return res.end(JSON.stringify({ models }));
      if (req.url.endsWith('/models')) return res.end(JSON.stringify({ data: models.map((m) => ({ id: m.name })) }));
      let j = {}; try { j = JSON.parse(body || '{}'); } catch { /* empty */ }
      const system = j.messages?.find((m) => m.role === 'system')?.content || '';
      const user = j.messages?.filter((m) => m.role === 'user').map((m) => m.content).join('\n') || '';
      return res.end(JSON.stringify({ model: j.model || 'qwen3:14b', choices: [{ message: { role: 'assistant', content: answer(system, user) } }] }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}/v1`, close: () => server.close() };
}
