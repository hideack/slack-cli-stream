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
      channel_id TEXT,
      user_id    TEXT,
      slack_ts   TEXT,
      thread_ts  TEXT,
      created_at TEXT DEFAULT (datetime('now', 'localtime'))
    )
  `);
  db.exec("CREATE INDEX IF NOT EXISTS idx_logged_at  ON messages (logged_at)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_channel    ON messages (channel)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_user       ON messages (user)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_slack_ts   ON messages (slack_ts)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_thread_ts  ON messages (thread_ts)");

  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts
    USING fts5(message, content='messages', content_rowid='id')
  `);
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS messages_fts_insert
    AFTER INSERT ON messages BEGIN
      INSERT INTO messages_fts(rowid, message) VALUES (new.id, new.message);
    END
  `);

  return db;
};

const logMessageSqlite = (db, time, channel, user, message, channelId, userId, slackTs, threadTs) => {
  const stmt = db.prepare(`
    INSERT INTO messages (logged_at, channel, user, message, channel_id, user_id, slack_ts, thread_ts)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(
    time,
    channel,
    user,
    message,
    channelId  || null,
    userId     || null,
    slackTs    || null,
    threadTs   || null
  );
};

module.exports = { initSqliteDb, logMessageSqlite };
