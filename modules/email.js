import nodemailer from 'nodemailer';

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  }
});

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
    try {
      await transporter.sendMail({
        from: process.env.EMAIL_USER,
        to,
        subject,
        text: body
      });
      return `Email inviata con successo a ${to}.`;
    } catch (err) {
      return `Errore nell'invio dell'email: ${err.message}`;
    }
  }
};
