import Database from 'better-sqlite3';

const db = new Database('alfred_memory.sqlite');

// Inizializza tabella generica per liste, note, spese e ricordi
db.exec(`
  CREATE TABLE IF NOT EXISTS items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    collection TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

export const dbTools = [
  {
    type: "function",
    function: {
      name: "save_to_memory",
      description: "Salva qualsiasi informazione o elemento in una collezione (es. lista_spesa, note, spese, libri).",
      parameters: {
        type: "object",
        properties: {
          collection: { type: "string", description: "Il nome della collezione (es. spesa, note, spese)" },
          content: { type: "string", description: "Il testo o i dettagli da salvare" }
        },
        required: ["collection", "content"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "read_memory",
      description: "Legge gli elementi salvati in una collezione specifica o cerca in tutta la memoria.",
      parameters: {
        type: "object",
        properties: {
          collection: { type: "string", description: "Nome collezione da leggere (opzionale)" },
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
    return `Elemento salvato con successo nella collezione "${collection}".`;
  },
  read_memory: async ({ collection, search }) => {
    let stmt, rows;
    if (collection) {
      stmt = db.prepare('SELECT id, content, created_at FROM items WHERE collection = ? ORDER BY id DESC');
      rows = stmt.all(collection.toLowerCase());
    } else if (search) {
      stmt = db.prepare('SELECT collection, content FROM items WHERE content LIKE ? ORDER BY id DESC');
      rows = stmt.all(`%${search}%`);
    } else {
      stmt = db.prepare('SELECT collection, content FROM items ORDER BY id DESC LIMIT 20');
      rows = stmt.all();
    }
    return rows.length > 0 ? JSON.stringify(rows) : "Nessun elemento trovato.";
  }
};
