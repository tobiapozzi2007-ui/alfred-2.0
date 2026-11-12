import { randomBytes } from 'crypto';
import nodemailer from 'nodemailer';

// Le email NON partono mai direttamente:
//  1. draft_email prepara la bozza e la mostra all'utente (il testo lo scrive il codice, non l'IA);
//  2. confirm_send_email la invia solo se il messaggio successivo dell'utente è una conferma esplicita.
// Il controllo è nel codice, quindi non dipende da quanto l'IA ricorda le regole e vale anche
// contro istruzioni nascoste dentro email, pagine web o allegati.

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DRAFT_TTL_MS = 60 * 60 * 1000; // una bozza non confermata scade dopo un'ora
const MAX_CONFIRMATION_LENGTH = 60;

let pending = null; // una sola bozza in attesa
let notifyUser = null;

export function init(ctx) {
  notifyUser = ctx.notify; // serve a mostrare la bozza esatta all'utente
}

/* ------------------------------------------------------------------ */
/*  Riconoscimento della conferma                                      */
/* ------------------------------------------------------------------ */

const words = (text) =>
  String(text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

const AFFIRM_WORDS = new Set([
  'si', 'ok', 'okay', 'okey', 'ottimo', 'perfetto', 'perfetta', 'benissimo', 'bene', 'confermo', 'conferma',
  'confermato', 'confermata', 'invia', 'inviala', 'invialo', 'inviamela', 'manda', 'mandala', 'mandalo',
  'mandamela', 'spedisci', 'spediscila', 'procedi', 'vai', 'fallo', 'certo', 'certamente', 'esatto', 'giusto',
  'yes', 'yep'
]);
const AFFIRM_PHRASES = [
  'va bene', 'va benissimo', 'fai pure', 'manda pure', 'invia pure', 'tutto ok', 'd accordo', 'puoi inviarla',
  'puoi mandarla', 'puoi inviare', 'puoi mandare'
];
const NEGATIVE_WORDS = new Set([
  'no', 'non', 'aspetta', 'aspetti', 'annulla', 'annullare', 'modifica', 'modificala', 'cambia', 'cambiala',
  'cambiare', 'correggi', 'ferma', 'fermati', 'stop', 'rifai', 'riscrivi', 'togli', 'aggiungi', 'invece', 'pero', 'ma'
]);

// Vero solo per risposte brevi e chiare come "sì", "va bene, invia", "conferma"
export function isConfirmation(text) {
  const raw = String(text || '');
  if (!raw.trim() || raw.length > MAX_CONFIRMATION_LENGTH) return false;

  if (raw.includes('?')) return false; // una domanda non è una conferma

  const norm = words(raw);
  const tokens = norm.split(' ').filter(Boolean);
  if (tokens.length > 6) return false;
  if (tokens.some((t) => NEGATIVE_WORDS.has(t))) return false;

  if (raw.includes('👍')) return true;
  if (tokens.some((t) => AFFIRM_WORDS.has(t))) return true;
  return AFFIRM_PHRASES.some((p) => ` ${norm} `.includes(` ${p} `));
}

/* ------------------------------------------------------------------ */
/*  Destinatari                                                        */
/* ------------------------------------------------------------------ */

const SELF_WORDS = new Set(['me', 'a me', 'io', 'me stesso', 'me stessa', 'myself', 'mio indirizzo', 'mia email', 'la mia email']);

function resolveRecipients(to) {
  const own = process.env.EMAIL_USER;
  const list = String(to || '')
    .split(/[,;]/)
    .map((r) => r.trim())
    .filter(Boolean)
    .map((r) => (SELF_WORDS.has(words(r)) && own ? own : r));
  return list;
}

function formatDraft(d) {
  return [
    '✉️ Bozza dell\'email (NON ancora inviata)',
    `A: ${d.to.join(', ')}`,
    `Oggetto: ${d.subject}`,
    '',
    d.body,
    '',
    'Rispondi "conferma" per inviarla, oppure dimmi cosa vuoi cambiare.'
  ].join('\n');
}

/* ------------------------------------------------------------------ */
/*  Tool                                                               */
/* ------------------------------------------------------------------ */

export const tools = [
  {
    type: 'function',
    function: {
      name: 'draft_email',
      description:
        'Prepara la bozza di un\'email e la mostra all\'utente: NON la invia. Usalo ogni volta che l\'utente vuole mandare un\'email (anche a sé stesso: per "a me" metti to="me"), appena hai destinatario, oggetto e testo. Se manca qualcosa chiedilo prima. Dopo la bozza scrivi una sola riga che chiede se va bene o cosa cambiare. Se l\'utente chiede modifiche, richiama questo strumento con il testo corretto.',
      parameters: {
        type: 'object',
        properties: {
          to: {
            type: 'string',
            description: 'Indirizzo del destinatario (o più indirizzi separati da virgola). Per l\'utente stesso: "me".'
          },
          subject: { type: 'string', description: 'Oggetto della email.' },
          body: {
            type: 'string',
            description: 'Testo completo della email, già pronto per essere inviato (con saluto e firma secondo le regole dell\'utente).'
          }
        },
        required: ['to', 'subject', 'body']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'confirm_send_email',
      description:
        'Invia davvero la bozza in attesa, SOLO dopo che l\'utente ha risposto con una conferma esplicita ("sì", "conferma", "invia"). Se l\'utente chiede modifiche o non ha ancora risposto non usarlo: prepara una nuova bozza o chiedi conferma.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Id della bozza, restituito da draft_email (opzionale).' }
        }
      }
    }
  }
];

export const handlers = {
  async draft_email({ to, subject, body }) {
    const recipients = resolveRecipients(to);
    if (recipients.length === 0 || !recipients.every((r) => EMAIL_REGEX.test(r))) {
      return {
        success: false,
        error: 'Indirizzo del destinatario non valido o mancante: chiedilo all\'utente (per se stesso basta "me").'
      };
    }
    if (!subject || !String(subject).trim() || !body || !String(body).trim()) {
      return { success: false, error: 'Servono oggetto e testo: chiedili all\'utente.' };
    }

    pending = {
      id: randomBytes(3).toString('hex'),
      to: recipients,
      subject: String(subject).trim(),
      body: String(body).trim(),
      createdAt: Date.now()
    };

    // La bozza esatta viene mostrata dal codice, non riscritta dall'IA
    if (notifyUser) {
      try {
        await notifyUser(formatDraft(pending));
        return {
          stato: 'bozza_mostrata_all_utente',
          id: pending.id,
          istruzione:
            'La bozza completa è già stata mostrata all\'utente e NON è stata inviata. Rispondi con una sola riga che chiede se va bene o cosa cambiare, senza ripetere il testo. Non dire di aver inviato nulla.'
        };
      } catch (err) {
        console.error('[email] Impossibile mostrare la bozza:', err.message);
      }
    }
    return {
      stato: 'bozza_da_mostrare',
      id: pending.id,
      bozza: { a: pending.to, oggetto: pending.subject, testo: pending.body },
      istruzione:
        'Mostra all\'utente la bozza completa (destinatario, oggetto e testo) e chiedi conferma. NON è stata inviata: non dire di averla inviata.'
    };
  },

  async confirm_send_email({ id } = {}, turn = {}) {
    if (!pending || Date.now() - pending.createdAt > DRAFT_TTL_MS) {
      pending = null;
      return { success: false, error: 'Non c\'è nessuna bozza in attesa (o è scaduta): preparane una nuova con draft_email.' };
    }
    if (id && id !== pending.id) {
      return { success: false, error: 'Quella bozza non è più valida: la bozza in attesa è un\'altra. Mostrala di nuovo e chiedi conferma.' };
    }
    if (turn.source !== 'user') {
      return { success: false, error: 'Un\'email può partire solo da una conferma dell\'utente in un suo messaggio.' };
    }
    // La conferma deve arrivare in un messaggio dell'utente successivo alla bozza
    if (!(turn.startedAt > pending.createdAt)) {
      return {
        success: false,
        error: 'Non puoi confermare nello stesso messaggio in cui hai preparato la bozza: mostrala e aspetta la risposta dell\'utente.'
      };
    }
    if (!isConfirmation(turn.userText)) {
      return {
        success: false,
        error:
          'L\'ultimo messaggio dell\'utente non è una conferma esplicita. Se chiede modifiche, prepara una nuova bozza; altrimenti chiedigli di rispondere "sì", "conferma" o "invia".'
      };
    }

    // Credenziali lette dall'ambiente al momento dell'invio
    const user = process.env.EMAIL_USER;
    const pass = process.env.EMAIL_PASS;
    if (!user || !pass) {
      return { success: false, error: 'EMAIL_USER o EMAIL_PASS non configurati nel file .env.' };
    }

    const draft = pending;
    const transporter = nodemailer.createTransport({ service: 'gmail', auth: { user, pass } });
    const info = await transporter.sendMail({
      from: user,
      to: draft.to.join(', '),
      subject: draft.subject,
      text: draft.body
    });

    pending = null;
    return {
      success: true,
      messageId: info.messageId,
      destinatari: draft.to,
      accettati: info.accepted,
      rifiutati: info.rejected
    };
  }
};
