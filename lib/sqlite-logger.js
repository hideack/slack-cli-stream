const Database = require("better-sqlite3");

const initSqliteDb = (dbPath) => {
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      logged_at  TEXT NOT NULL,
      channel    TEXT,
      user       TEXT,
      message    TEXT,
      created_at TEXT DEFAULT (datetime('now', 'localtime'))
    )
  `);
  db.exec("CREATE INDEX IF NOT EXISTS idx_logged_at ON messages (logged_at)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_channel   ON messages (channel)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_user      ON messages (user)");
  return db;
};

const logMessageSqlite = (db, time, channel, user, message) => {
  const stmt = db.prepare("INSERT INTO messages (logged_at, channel, user, message) VALUES (?, ?, ?, ?)");
  stmt.run(time, channel, user, message);
};

module.exports = { initSqliteDb, logMessageSqlite };
