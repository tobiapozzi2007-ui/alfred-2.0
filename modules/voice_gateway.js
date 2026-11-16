import crypto from 'crypto';
import http from 'http';

// Riceve dal PC (Smart Display) il testo di ciò che hai detto e lo fa elaborare ad Alfred:
//   1. il testo compare nella chat Telegram come "🎤 ..." (un bot non può scrivere con il tuo nome);
//   2. Alfred lo elabora come se lo avessi scritto tu;
//   3. la risposta compare su Telegram e torna al PC, che la mostra e la legge ad alta voce.
//
// Configurazione nel file .env del NAS:
//   PC_AGENT_TOKEN=...     lo stesso segreto usato per lo spegnimento (obbligatorio)
//   VOICE_PORT=8787        (facoltativo) porta su cui il NAS ascolta
//   VOICE_ALLOWED_IPS=...  (facoltativo) indirizzi ammessi, separati da virgola; di default PC_IP
//
// Per sicurezza una richiesta arrivata dalla voce non può confermare l'invio di una email:
// la conferma va data su Telegram.

const MAX_BODY_BYTES = 16 * 1024;
const MAX_TEXT_CHARS = 1000;

let server = null;

export const getPort = () => server?.address()?.port ?? null;

const tokenMatches = (given, expected) => {
  const a = Buffer.from(String(given || ''));
  const b = Buffer.from(String(expected || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};

const clientIp = (req) => String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
const isLoopback = (ip) => ip === '127.0.0.1' || ip === '::1';

// Se si passa anche req, dopo la risposta la connessione viene chiusa (serve per i corpi troppo grandi)
function reply(res, status, body, req = null) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    ...(req ? { Connection: 'close' } : {})
  });
  if (req) res.on('finish', () => req.socket.destroy());
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let tooBig = false;
    req.on('data', (chunk) => {
      if (tooBig) return; // il resto viene scartato
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        tooBig = true;
        reject(Object.assign(new Error('Richiesta troppo grande'), { status: 413 }));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export function init(ctx) {
  const token = process.env.PC_AGENT_TOKEN;
  if (!token) {
    console.log('[voice] Non attivo: manca PC_AGENT_TOKEN nel file .env.');
    return;
  }

  const port = process.env.VOICE_PORT !== undefined && process.env.VOICE_PORT !== '' ? Number(process.env.VOICE_PORT) : 8787;
  const host = process.env.VOICE_HOST || '0.0.0.0';
  const allowed = (process.env.VOICE_ALLOWED_IPS || process.env.PC_IP || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  server = http.createServer(async (req, res) => {
    try {
      const ip = clientIp(req);
      if (allowed.length && !allowed.includes(ip) && !isLoopback(ip)) {
        console.warn(`[voice] Richiesta da ${ip} rifiutata: non è tra gli indirizzi ammessi.`);
        return reply(res, 403, { error: 'indirizzo non ammesso' });
      }

      const bearer = /^Bearer (.+)$/.exec(req.headers.authorization || '')?.[1];
      if (!tokenMatches(bearer, token)) return reply(res, 401, { error: 'non autorizzato' });

      const path = (req.url || '').split('?')[0];
      if (req.method === 'GET' && path === '/health') return reply(res, 200, { ok: true });

      if (req.method === 'POST' && path === '/voice') {
        let data;
        try {
          data = JSON.parse((await readBody(req)) || '{}');
        } catch (err) {
          return reply(res, err.status || 400, { error: err.status ? err.message : 'JSON non valido' }, err.status ? req : null);
        }

        const text = String(data.text || '').trim();
        if (!text) return reply(res, 400, { error: 'testo mancante' });
        if (text.length > MAX_TEXT_CHARS) return reply(res, 413, { error: 'testo troppo lungo' });
        if (!ctx.ask) return reply(res, 503, { error: 'Alfred non è pronto' });

        console.log(`[voice] Dal PC: "${text.slice(0, 80)}"`);
        await ctx.send?.(`🎤 ${text}`).catch?.(() => {});
        const answer = await ctx.ask(text, { source: 'voice' });
        await ctx.send?.(answer).catch?.(() => {});
        return reply(res, 200, { reply: answer });
      }

      return reply(res, 404, { error: 'non trovato' });
    } catch (err) {
      console.error('[voice] Errore:', err);
      if (!res.headersSent) reply(res, 500, { error: 'errore interno' });
    }
  });

  server.on('error', (err) => console.error('[voice] Server non avviato:', err.message));
  server.listen(port, host, () => console.log(`[voice] In ascolto sulla porta ${server.address().port} per la voce dal PC.`));
}
