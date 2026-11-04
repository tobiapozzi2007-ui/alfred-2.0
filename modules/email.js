import nodemailer from 'nodemailer';

export const tools = [
  {
    type: "function",
    function: {
      name: "send_email",
      description: "Invia un'email a un destinatario.",
      parameters: {
        type: "object",
        properties: {
          to: { type: "string", description: "Indirizzo email del destinatario" },
          subject: { type: "string", description: "Oggetto dell'email" },
          body: { type: "string", description: "Testo dell'email" }
        },
        required: ["to", "subject", "body"]
      }
    }
  }
];

export const handlers = {
  send_email: async ({ to, subject, body }) => {
    const user = process.env.EMAIL_USER;
    const pass = process.env.EMAIL_PASS;

    if (!user || !pass) {
      return "❌ Errore: EMAIL_USER o EMAIL_PASS non sono state trovate nel file .env!";
    }

    try {
      const transporter = nodemailer.createTransport({
        service: 'gmail',
        auth: {
          user: user.trim(),
          pass: pass.trim()
        }
      });

      await transporter.sendMail({
        from: user,
        to,
        subject,
        text: body
      });

      return `📧 Email inviata con successo a ${to}!`;
    } catch (err) {
      return `❌ Errore nell'invio dell'email: ${err.message}`;
    }
  }
};
