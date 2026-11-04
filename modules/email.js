import nodemailer from 'nodemailer';

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const tools = [
  {
    type: 'function',
    function: {
      name: 'send_email',
      description:
        'Invia una email dall\'account Gmail dell\'utente. Richiede destinatario, oggetto e testo. Prima di inviare assicurati di avere tutti e tre i dati.',
      parameters: {
        type: 'object',
        properties: {
          to: {
            type: 'string',
            description: 'Indirizzo email del destinatario (o più indirizzi separati da virgola).'
          },
          subject: { type: 'string', description: 'Oggetto della email.' },
          body: { type: 'string', description: 'Testo della email.' }
        },
        required: ['to', 'subject', 'body']
      }
    }
  }
];

export const handlers = {
  async send_email({ to, subject, body }) {
    // Credenziali lette dall'ambiente al momento dell'invio
    const user = process.env.EMAIL_USER;
    const pass = process.env.EMAIL_PASS;

    if (!user || !pass) {
      return { success: false, error: 'EMAIL_USER o EMAIL_PASS non configurati nel file .env.' };
    }

    const recipients = String(to || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    if (recipients.length === 0 || !recipients.every((r) => EMAIL_REGEX.test(r))) {
      return { success: false, error: 'Indirizzo email del destinatario non valido.' };
    }
    if (!subject || !body) {
      return { success: false, error: 'Oggetto e testo sono obbligatori.' };
    }

    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: { user, pass }
    });

    const info = await transporter.sendMail({
      from: user,
      to: recipients.join(', '),
      subject: String(subject),
      text: String(body)
    });

    return {
      success: true,
      messageId: info.messageId,
      destinatari: recipients,
      accettati: info.accepted,
      rifiutati: info.rejected
    };
  }
};
