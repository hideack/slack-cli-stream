const Database = require("better-sqlite3");

// 1メッセージは行ごとに複数レコードへ分割して記録されるため、
// (channel_id, slack_ts) だけでは一意にならない。行番号を加えて一意キーとする。
const ensureLineNoColumn = (db) => {
  const columns = db.prepare("PRAGMA table_info(messages)").all();
  if (!columns.some((column) => column.name === "line_no")) {
    db.exec("ALTER TABLE messages ADD COLUMN line_no INTEGER");
  }
};

// 一意インデックス。既存行の line_no は NULL であり、SQLite では NULL 同士は
// 重複と見なされないため、移行前のDBでも作成自体は成功する
// (移行前の行は保護対象外。bin/dedupe-sqlite-messages で解消する)。
const ensureDedupeIndex = (db) => {
  try {
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_dedupe
      ON messages (channel_id, slack_ts, line_no)
    `);
    return true;
  } catch (e) {
    console.error(
      "Warning: 重複行が残っているため一意インデックスを作成できませんでした。" +
      "bin/dedupe-sqlite-messages <db-path> を実行してください:",
      e.message
    );
    return false;
  }
};

// line_no 未設定(= 重複排除の保護対象外)の行が残っているかを安価に判定する。
// 全件走査を避けるため、最も古い Slack 由来の行だけを見る。
const hasUnmigratedRows = (db) => {
  const row = db.prepare(`
    SELECT line_no
    FROM messages
    WHERE slack_ts IS NOT NULL
    ORDER BY id
    LIMIT 1
  `).get();
  return !!row && row.line_no === null;
};

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
      line_no    INTEGER,
      created_at TEXT DEFAULT (datetime('now', 'localtime'))
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS app_heartbeat (
      id           INTEGER PRIMARY KEY CHECK (id = 1),
      last_seen_at REAL NOT NULL
    )
  `);
  ensureLineNoColumn(db);
  db.exec("CREATE INDEX IF NOT EXISTS idx_logged_at  ON messages (logged_at)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_channel    ON messages (channel)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_user       ON messages (user)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_slack_ts   ON messages (slack_ts)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_thread_ts  ON messages (thread_ts)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_channel_ts ON messages (channel_id, slack_ts, id)");
  ensureDedupeIndex(db);

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
  // 外部コンテンツ FTS のため、行削除時は FTS 側も明示的に削除する必要がある
  // (重複排除スクリプトが messages から DELETE するため)。
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS messages_fts_delete
    AFTER DELETE ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, message) VALUES ('delete', old.id, old.message);
    END
  `);

  return db;
};

const logMessageSqlite = (db, time, channel, user, message, channelId, userId, slackTs, threadTs, lineNo) => {
  // 同一メッセージの再取得(バックフィルの窓が重なる場合など)を握り潰す。
  // 一意キーは (channel_id, slack_ts, line_no)。
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO messages (logged_at, channel, user, message, channel_id, user_id, slack_ts, thread_ts, line_no)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(
    time,
    channel,
    user,
    message,
    channelId  || null,
    userId     || null,
    slackTs    || null,
    threadTs   || null,
    (typeof lineNo === "number") ? lineNo : null
  );
};

const updateAppHeartbeat = (db) => {
  db.prepare("INSERT OR REPLACE INTO app_heartbeat (id, last_seen_at) VALUES (1, ?)").run(Date.now() / 1000);
};

const getLastAppHeartbeat = (db) => {
  const row = db.prepare("SELECT last_seen_at FROM app_heartbeat WHERE id = 1").get();
  return row ? row.last_seen_at : null;
};

// 最後に「実際に記録できた」Slackメッセージの時刻(Unix秒)。
// ハートビートはプロセスの生存しか表さないため、取り込みが死んでいるかの判定に使う。
const getLastMessageTs = (db) => {
  const row = db.prepare(`
    SELECT slack_ts
    FROM messages
    WHERE slack_ts IS NOT NULL
    ORDER BY slack_ts DESC
    LIMIT 1
  `).get();
  if (!row) return null;
  const ts = parseFloat(row.slack_ts);
  return Number.isFinite(ts) ? ts : null;
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

module.exports = {
  initSqliteDb,
  logMessageSqlite,
  getLastSlackTsPerChannel,
  updateAppHeartbeat,
  getLastAppHeartbeat,
  getLastMessageTs,
  getInjectedChannelLabels,
  hasUnmigratedRows,
  ensureDedupeIndex
};
