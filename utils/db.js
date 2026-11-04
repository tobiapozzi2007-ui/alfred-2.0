import Database from 'better-sqlite3';

const db = new Database('alfred_memory.sqlite');

// Tabella 1: Memoria a lungo termine (liste, note, preferenze utente)
db.exec(`
  CREATE TABLE IF NOT EXISTS items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    collection TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

// Tabella 2: Memoria a breve termine (cronologia chat di Telegram)
db.exec(`
  CREATE TABLE IF NOT EXISTS chat_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

export const saveChatMessage = (chatId, role, content) => {
  const stmt = db.prepare('INSERT INTO chat_history (chat_id, role, content) VALUES (?, ?, ?)');
  stmt.run(chatId.toString(), role, content);
};

export const getRecentHistory = (chatId, limit = 10) => {
  const stmt = db.prepare(`
    SELECT role, content FROM (
      SELECT role, content, id FROM chat_history 
      WHERE chat_id = ? 
      ORDER BY id DESC LIMIT ?
    ) ORDER BY id ASC
  `);
  return stmt.all(chatId.toString(), limit);
};

export const dbTools = [
  {
    type: "function",
    function: {
      name: "save_to_memory",
      description: "Salva informazioni permanenti o preferenze dell'utente (es. email, liste, note, spese).",
      parameters: {
        type: "object",
        properties: {
          collection: { type: "string", description: "Collezione (es. profilo, spesa, note)" },
          content: { type: "string", description: "L'informazione esatta da salvare" }
        },
        required: ["collection", "content"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "read_memory",
      description: "Cerca e legge informazioni salvate nel database di memoria.",
      parameters: {
        type: "object",
        properties: {
          collection: { type: "string", description: "Collezione specifica da consultare (opzionale)" },
          search: { type: "string", description: "Parola chiave da cercare (opzionale)" }
        }
      }
    }
  }
];

export const dbHandlers = {
  save_to_memory: async ({ collection, content }) => {
    const stmt = db.prepare('INSERT INTO items (collection, content) VALUES (?, ?)');
    stmt.run(collection.toLowerCase(), content);
    return `Ho salvato correttamente l'informazione ("${content}") nella memoria "${collection}".`;
  },
  read_memory: async ({ collection, search }) => {
    let stmt, rows;
    if (collection) {
      stmt = db.prepare('SELECT content FROM items WHERE collection = ? ORDER BY id DESC');
      rows = stmt.all(collection.toLowerCase());
    } else if (search) {
      stmt = db.prepare('SELECT collection, content FROM items WHERE content LIKE ? ORDER BY id DESC');
      rows = stmt.all(`%${search}%`);
    } else {
      stmt = db.prepare('SELECT collection, content FROM items ORDER BY id DESC LIMIT 20');
      rows = stmt.all();
    }
    return rows.length > 0 ? JSON.stringify(rows) : "Nessuna informazione trovata in memoria.";
  }
};
