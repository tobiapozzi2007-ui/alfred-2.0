import dgram from 'dgram';
import net from 'net';
import fetch from 'node-fetch';
import { execFile } from 'child_process';
import { promisify } from 'util';
import db from '../utils/db.js';
import { nowParts } from '../utils/time.js';

// Controllo del PC fisso (Smart Display) dalla rete locale:
//  - /accendi: pacchetto Wake-on-LAN al MAC del PC
//  - /spegni: ordine di spegnimento all'agente installato sul PC (porta HTTP locale, protetta da token)
//  - ogni sera, se il PC è ancora acceso, messaggio con pulsanti "Sì, spegni" / "No, lascialo acceso"
//
// Configurazione nel file .env del NAS:
//   PC_IP=192.168.1.50            indirizzo locale del PC (meglio se fisso, con prenotazione DHCP sul router)
//   PC_MAC=AA:BB:CC:DD:EE:FF      indirizzo fisico della scheda di rete cablata del PC
//   PC_AGENT_TOKEN=...            stringa segreta, uguale a quella dello script sul PC
//   PC_AGENT_PORT=8766            (facoltativo) porta dell'agente sul PC (la 8765 è usata dalla grafica)
//   PC_BROADCAST=192.168.1.255    (facoltativo) indirizzo di broadcast della rete
//   PC_EVENING_TIME=22:30         (facoltativo) ora del controllo serale
//   PC_LATE_TIME=23:55            (facoltativo) ora del secondo controllo, se il PC è ancora acceso

const run = promisify(execFile);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

db.exec('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
const getSetting = (key, fallback = null) => db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value ?? fallback;
const setSetting = (key, value) =>
  db
    .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, String(value));

// Letta a ogni uso: si può cambiare il .env senza toccare il codice
const cfg = () => ({
  ip: (process.env.PC_IP || '').trim(),
  mac: (process.env.PC_MAC || '').trim(),
  token: process.env.PC_AGENT_TOKEN || '',
  port: Number(process.env.PC_AGENT_PORT) || 8766,
  broadcast: (process.env.PC_BROADCAST || '').trim(),
  wolPort: Number(process.env.PC_WOL_PORT) || 9
});

const MISSING_CONFIG =
  'Il PC fisso non è ancora configurato: nel file .env del NAS servono PC_IP, PC_MAC e PC_AGENT_TOKEN (poi riavvia Alfred).';

const TIME_RE = /^([01]?\d|2[0-3]):([0-5]\d)$/;
const EVENING_GRACE_MINUTES = 30;
const BUTTON_TTL_MS = 6 * 3600_000;

let ctxRef = null;
let watching = false;

/* ------------------------------------------------------------------ */
/*  Wake-on-LAN                                                        */
/* ------------------------------------------------------------------ */

// Pacchetto magico: 6 byte a 0xFF seguiti dal MAC ripetuto 16 volte (102 byte)
export function buildMagicPacket(mac) {
  const hex = String(mac || '').replace(/[^0-9a-f]/gi, '');
  if (!/^[0-9a-f]{12}$/i.test(hex)) {
    throw new Error('Indirizzo MAC non valido: servono 12 cifre esadecimali, per esempio AA:BB:CC:DD:EE:FF.');
  }
  const bytes = Buffer.from(hex, 'hex');
  return Buffer.concat([Buffer.alloc(6, 0xff), ...Array(16).fill(bytes)]);
}

export async function sendWol() {
  const { ip, mac, broadcast, wolPort } = cfg();
  const packet = buildMagicPacket(mac);

  // Broadcast generale, quello indicato dall'utente e quello della sottorete /24 del PC
  const targets = new Set([broadcast || '255.255.255.255']);
  const subnet = /^(\d+\.\d+\.\d+)\.\d+$/.exec(ip);
  if (subnet) targets.add(`${subnet[1]}.255`);

  const socket = dgram.createSocket('udp4');
  await new Promise((resolve, reject) => {
    socket.once('error', reject);
    socket.bind(() => {
      try {
        socket.setBroadcast(true);
        resolve();
      } catch (err) {
        reject(err);
      }
    });
  });

  let sent = 0;
  const errors = [];
  try {
    for (const address of targets) {
      for (const port of new Set([wolPort, 7])) {
        try {
          await new Promise((resolve, reject) => socket.send(packet, 0, packet.length, port, address, (e) => (e ? reject(e) : resolve())));
          sent++;
        } catch (err) {
          errors.push(`${address}:${port} ${err.code || err.message}`);
        }
      }
    }
  } finally {
    socket.close();
  }
  if (!sent) throw new Error(`nessun pacchetto partito (${errors.join('; ')})`);
  return { packets: sent, targets: [...targets] };
}

/* ------------------------------------------------------------------ */
/*  Il PC è acceso? (ping + porta dell'agente)                         */
/* ------------------------------------------------------------------ */

// Windows di default non risponde al ping: per questo si prova anche la porta dell'agente.
// "Connessione rifiutata" vuol dire che il PC c'è ma l'agente non è in ascolto.
const pingHost = (ip) => run('ping', ['-c', '1', '-W', '2', ip], { timeout: 6000 }).then(() => true, () => false);

function probePort(ip, port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: ip, port });
    let finished = false;
    const end = (value) => {
      if (finished) return;
      finished = true;
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(2500, () => end('timeout'));
    socket.once('connect', () => end('open'));
    socket.once('error', (err) => end(err.code === 'ECONNREFUSED' ? 'refused' : 'error'));
  });
}

// Le due prove sono sostituibili nei test (la rete di prova risponde "rifiutato" a qualunque indirizzo)
export const probes = { ping: pingHost, port: probePort };

export async function isPcOn() {
  const { ip, port } = cfg();
  const [ping, probe] = await Promise.all([probes.ping(ip), probes.port(ip, port)]);
  return { on: ping || probe === 'open' || probe === 'refused', ping, agent: probe === 'open', probe };
}

const PROBE_LABEL = {
  open: 'raggiungibile',
  refused: 'porta chiusa ma il PC risponde',
  timeout: 'nessuna risposta',
  error: 'irraggiungibile'
};

/* ------------------------------------------------------------------ */
/*  Azioni                                                             */
/* ------------------------------------------------------------------ */

function watchBoot() {
  if (watching || !ctxRef?.notify) return;
  watching = true;
  const maxMs = (Number(process.env.PC_BOOT_WAIT_SECONDS) || 150) * 1000;
  const pollMs = (Number(process.env.PC_BOOT_POLL_SECONDS) || 5) * 1000;

  (async () => {
    const started = Date.now();
    try {
      while (Date.now() - started < maxMs) {
        await sleep(pollMs);
        if ((await isPcOn()).on) {
          await ctxRef.notify('✅ Il PC fisso è acceso.');
          return;
        }
      }
      await ctxRef.notify(
        '⚠️ Ho inviato il segnale di accensione ma il PC non risponde ancora. Controlla che il Wake-on-LAN sia attivo (BIOS e scheda di rete), che l\'avvio rapido di Windows sia disattivato e che il PC sia collegato con il cavo di rete.'
      );
    } catch (err) {
      console.error('[pc] Controllo dell\'accensione non riuscito:', err.message);
    } finally {
      watching = false;
    }
  })();
}

export async function powerOn() {
  const { ip, mac } = cfg();
  if (!ip || !mac) return { success: false, message: MISSING_CONFIG };

  const state = await isPcOn();
  if (state.on) return { success: true, already: true, message: 'Il PC fisso è già acceso.' };

  try {
    await sendWol();
  } catch (err) {
    return { success: false, message: `Non sono riuscito a inviare il segnale di accensione: ${err.message}` };
  }
  watchBoot();
  return { success: true, message: '📡 Ho inviato il segnale di accensione. Ti scrivo appena il PC risponde.' };
}

export async function shutdownPc() {
  const { ip, token, port } = cfg();
  if (!ip || !token) return { success: false, message: MISSING_CONFIG };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6000);
  try {
    const res = await fetch(`http://${ip}:${port}/shutdown`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal
    });
    if (res.ok) return { success: true, message: '✅ Ho inviato lo spegnimento: il PC si spegnerà tra pochi secondi.' };
    if (res.status === 401 || res.status === 403) {
      return {
        success: false,
        message: 'Il PC ha rifiutato l\'ordine: il token non coincide. Controlla che PC_AGENT_TOKEN nel .env del NAS sia uguale a quello dello script sul PC.'
      };
    }
    return { success: false, message: `Il PC ha risposto con un errore (${res.status}).` };
  } catch (err) {
    const state = await isPcOn();
    if (!state.on) return { success: false, message: 'Il PC fisso risulta già spento (non risponde in rete).' };
    return {
      success: false,
      message: `Il PC è acceso ma l'agente di spegnimento non risponde. Controlla che sia avviato sul PC e che il firewall di Windows permetta la porta ${port} dal NAS.`
    };
  } finally {
    clearTimeout(timer);
  }
}

async function statusMessage() {
  const { ip } = cfg();
  if (!ip) return MISSING_CONFIG;
  const s = await isPcOn();
  const detail = `(ping: ${s.ping ? 'risponde' : 'nessuna risposta'}; agente: ${PROBE_LABEL[s.probe] || s.probe})`;
  if (!s.on) return `⚫ Il PC fisso è spento (non risponde in rete).\n${detail}`;
  return s.agent
    ? `🟢 Il PC fisso è acceso e l'agente di spegnimento risponde.\n${detail}`
    : `🟡 Il PC fisso è acceso, ma l'agente di spegnimento non risponde: così non potrei spegnerlo da qui.\n${detail}`;
}

async function askShutdown(text = 'Vuoi che spenga il PC fisso?') {
  if (!ctxRef?.sendButtons) {
    return { success: false, message: 'I pulsanti non sono disponibili: usa il comando /spegni.' };
  }
  const stamp = Date.now();
  await ctxRef.sendButtons(text, [
    [
      { text: 'Sì, spegni', callback_data: `pc:off:${stamp}` },
      { text: 'No, lascialo acceso', callback_data: `pc:keep:${stamp}` }
    ]
  ]);
  return { success: true };
}

// Pressione dei pulsanti (registrata con ctx.onCallback)
async function onPcButton(data) {
  const [, action, stamp] = String(data).split(':');
  if (!(Date.now() - Number(stamp) < BUTTON_TTL_MS)) {
    return { toast: 'Questo pulsante è scaduto.', text: 'Pulsante scaduto: se vuoi spegnere il PC usa /spegni.' };
  }
  if (action === 'keep') return { toast: 'Va bene', text: 'Va bene, lo lascio acceso.' };
  if (action === 'off') {
    const result = await shutdownPc();
    return { toast: result.success ? 'Spegnimento inviato' : 'Non riuscito', text: result.message };
  }
  return { toast: 'Pulsante non riconosciuto.' };
}

/* ------------------------------------------------------------------ */
/*  Tool (linguaggio naturale) e comandi Telegram                      */
/* ------------------------------------------------------------------ */

export const tools = [
  {
    type: 'function',
    function: {
      name: 'pc_status',
      description: 'Dice se il PC fisso di casa (lo Smart Display) è acceso o spento.',
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'pc_power_on',
      description:
        'Accende il PC fisso di casa con Wake-on-LAN. Usalo quando l\'utente chiede di accendere il PC o lo Smart Display. Il messaggio di conferma "acceso" arriva da solo quando il PC risponde.',
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'pc_ask_shutdown_confirmation',
      description:
        'Quando l\'utente chiede di spegnere il PC fisso, mostra due pulsanti ("Sì, spegni" / "No, lascialo acceso") per confermare: il PC si spegne solo se l\'utente preme il pulsante. Non puoi spegnerlo direttamente. Dopo aver usato questo strumento scrivi una sola riga che invita a premere un pulsante.',
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'set_pc_evening_reminder',
      description:
        'Modifica i controlli serali del PC fisso: l\'orario del primo controllo (default 22:30), quello del secondo controllo di fine serata (default 23:55) oppure attivarli o disattivarli. Se il PC è acceso arriva il messaggio con i pulsanti per spegnerlo; il secondo controllo parte solo se dopo il primo il PC è ancora acceso.',
      parameters: {
        type: 'object',
        properties: {
          time: { type: 'string', description: 'Orario "HH:MM" del primo controllo (24 ore).' },
          late_time: { type: 'string', description: 'Orario "HH:MM" del secondo controllo di fine serata (24 ore).' },
          enabled: { type: 'boolean', description: 'true per attivare i controlli, false per disattivarli entrambi.' },
          late_enabled: { type: 'boolean', description: 'true/false per attivare o disattivare solo il secondo controllo.' }
        }
      }
    }
  }
];

export const handlers = {
  pc_status: async () => ({ stato: await statusMessage() }),

  pc_power_on: async () => powerOn(),

  async pc_ask_shutdown_confirmation() {
    const r = await askShutdown();
    return r.success ? { stato: 'pulsanti_mostrati_all_utente', istruzione: 'I pulsanti sono già sul telefono dell\'utente: invitalo a premere "Sì, spegni" o "No, lascialo acceso". Non dire che il PC è stato spento.' } : r;
  },

  set_pc_evening_reminder({ time, late_time, enabled, late_enabled } = {}) {
    for (const [key, value] of [['pc_evening_time', time], ['pc_late_time', late_time]]) {
      if (value === undefined) continue;
      const m = TIME_RE.exec(String(value).trim());
      if (!m) return { success: false, error: 'Orario non valido: usa il formato HH:MM.' };
      setSetting(key, `${m[1].padStart(2, '0')}:${m[2]}`);
    }
    if (enabled !== undefined) setSetting('pc_evening_enabled', enabled ? '1' : '0');
    if (late_enabled !== undefined) setSetting('pc_late_enabled', late_enabled ? '1' : '0');
    return {
      success: true,
      controlli_attivi: getSetting('pc_evening_enabled', '1') === '1',
      primo_controllo: getSetting('pc_evening_time', process.env.PC_EVENING_TIME || '22:30'),
      secondo_controllo_attivo: getSetting('pc_late_enabled', '1') === '1',
      secondo_controllo: getSetting('pc_late_time', process.env.PC_LATE_TIME || '23:55')
    };
  }
};

// Comandi Telegram del modulo: compaiono nel menù e in /aiuto senza toccare il resto del codice
export const commands = [
  {
    command: 'accendi',
    description: 'Accende il PC fisso (Wake-on-LAN)',
    help: '/accendi — accende il PC fisso con Wake-on-LAN',
    handler: async () => (await powerOn()).message
  },
  {
    command: 'spegni',
    description: 'Spegne il PC fisso',
    help: '/spegni — spegne subito il PC fisso',
    handler: async () => (await shutdownPc()).message
  },
  {
    command: 'pc',
    description: 'Dice se il PC fisso è acceso',
    help: '/pc — dice se il PC fisso è acceso o spento',
    handler: statusMessage
  }
];

/* ------------------------------------------------------------------ */
/*  Controllo serale (hook init)                                       */
/* ------------------------------------------------------------------ */

const parseTime = (value) => {
  const m = TIME_RE.exec(String(value || '').trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};

async function askAndNotify(question) {
  const sent = await askShutdown(question);
  if (!sent.success && ctxRef?.notify) await ctxRef.notify(`${question} (usa /spegni per spegnerlo)`);
}

// Due controlli al giorno:
//  1) alla sera (22:30): se il PC è acceso chiede se spegnerlo;
//  2) a fine serata (23:55): se dopo il primo controllo il PC è ancora acceso (risposta "No" o nessuna risposta) lo richiede.
//     Se anche lì la risposta è "No", non chiede più fino alla sera dopo.
async function eveningCheck() {
  const { ip, token } = cfg();
  if (!ip || !token) return;
  if (getSetting('pc_evening_enabled', '1') !== '1') return;

  const now = nowParts();
  const first = parseTime(getSetting('pc_evening_time', process.env.PC_EVENING_TIME || '22:30'));
  const late = parseTime(getSetting('pc_late_time', process.env.PC_LATE_TIME || '23:55'));

  if (first !== null && now.minutes >= first && now.minutes < first + EVENING_GRACE_MINUTES && getSetting('pc_evening_last_date') !== now.date) {
    setSetting('pc_evening_last_date', now.date); // prima di tutto: una sola volta al giorno
    const state = await isPcOn();
    if (!state.on) {
      console.log('[pc] Controllo serale: il PC è spento, nessun messaggio.');
      return;
    }
    setSetting('pc_evening_asked_date', now.date);
    await askAndNotify('Alfred è ancora acceso. Vuoi che lo spenga?');
    return;
  }

  if (
    getSetting('pc_late_enabled', '1') === '1' &&
    late !== null &&
    now.minutes >= late && // la finestra finisce a mezzanotte
    getSetting('pc_evening_asked_date') === now.date &&
    getSetting('pc_late_last_date') !== now.date
  ) {
    setSetting('pc_late_last_date', now.date);
    const state = await isPcOn();
    if (!state.on) return; // nel frattempo è stato spento
    await askAndNotify('È quasi mezzanotte. Alfred è ancora acceso. Vuoi che lo spenga?');
  }
}

export function init(ctx) {
  ctxRef = ctx;
  ctx.onCallback?.('pc', onPcButton);

  const { ip, mac, token } = cfg();
  if (!ip || !mac || !token) {
    console.log('[pc] PC fisso non configurato (PC_IP, PC_MAC, PC_AGENT_TOKEN nel .env): comandi attivi ma inutilizzabili.');
  }

  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      await eveningCheck();
    } catch (err) {
      console.error('[pc] Errore nel controllo serale:', err.message);
    } finally {
      busy = false;
    }
  };
  setInterval(tick, 60_000);
  tick();

  console.log(
    `[pc] Attivo: controlli alle ${getSetting('pc_evening_time', process.env.PC_EVENING_TIME || '22:30')} e alle ${getSetting('pc_late_time', process.env.PC_LATE_TIME || '23:55')}.`
  );
}
