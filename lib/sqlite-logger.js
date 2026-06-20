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
  db.exec(`
    CREATE TABLE IF NOT EXISTS app_heartbeat (
      id           INTEGER PRIMARY KEY CHECK (id = 1),
      last_seen_at REAL NOT NULL
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

const updateAppHeartbeat = (db) => {
  db.prepare("INSERT OR REPLACE INTO app_heartbeat (id, last_seen_at) VALUES (1, ?)").run(Date.now() / 1000);
};

const getLastAppHeartbeat = (db) => {
  const row = db.prepare("SELECT last_seen_at FROM app_heartbeat WHERE id = 1").get();
  return row ? row.last_seen_at : null;
};

const getLastSlackTsPerChannel = (db) => {
  const rows = db.prepare(`
    SELECT channel_id, MAX(slack_ts) AS last_ts
    FROM messages
    WHERE channel_id IS NOT NULL AND slack_ts IS NOT NULL
    GROUP BY channel_id
  `).all();
  const map = {};
  rows.forEach(row => { map[row.channel_id] = row.last_ts; });
  return map;
};

// MCP(post_to_stream)等、Slack外から注入されたチャンネルは channel_id が
// "#label" 形式で記録される。それらのラベル一覧を取得する(Tab補完候補用)。
const getInjectedChannelLabels = (db) => {
  const rows = db.prepare(`
    SELECT DISTINCT channel_id
    FROM messages
    WHERE channel_id LIKE '#%'
    ORDER BY channel_id
  `).all();
  return rows.map((row) => row.channel_id);
};

module.exports = { initSqliteDb, logMessageSqlite, getLastSlackTsPerChannel, updateAppHeartbeat, getLastAppHeartbeat, getInjectedChannelLabels };
