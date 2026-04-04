let assert = require("chai").assert;
let fs = require("fs");
let os = require("os");
let path = require("path");
let { initSqliteDb, logMessageSqlite } = require("../lib/sqlite-logger");

describe("SQLiteロガーのテスト", () => {
  let db;
  let dbPath;

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `slack-test-${Date.now()}.db`);
    db = initSqliteDb(dbPath);
  });

  afterEach(() => {
    db.close();
    if (fs.existsSync(dbPath)) {
      fs.unlinkSync(dbPath);
    }
  });

  describe("initSqliteDb", () => {
    it("DBファイルが作成されること", () => {
      assert.isTrue(fs.existsSync(dbPath), "DBファイルが存在する");
    });

    it("messagesテーブルが作成されること", () => {
      const row = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='messages'"
      ).get();
      assert.equal(row.name, "messages", "messagesテーブルが存在する");
    });

    it("messages_fts仮想テーブルが作成されること", () => {
      const row = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='messages_fts'"
      ).get();
      assert.equal(row.name, "messages_fts", "messages_fts仮想テーブルが存在する");
    });

    it("messages_fts_insertトリガーが作成されること", () => {
      const row = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='trigger' AND name='messages_fts_insert'"
      ).get();
      assert.equal(row.name, "messages_fts_insert", "messages_fts_insertトリガーが存在する");
    });

    it("logged_atインデックスが作成されること", () => {
      const row = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_logged_at'"
      ).get();
      assert.equal(row.name, "idx_logged_at");
    });

    it("channelインデックスが作成されること", () => {
      const row = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_channel'"
      ).get();
      assert.equal(row.name, "idx_channel");
    });

    it("userインデックスが作成されること", () => {
      const row = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_user'"
      ).get();
      assert.equal(row.name, "idx_user");
    });

    it("slack_tsインデックスが作成されること", () => {
      const row = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_slack_ts'"
      ).get();
      assert.equal(row.name, "idx_slack_ts");
    });

    it("thread_tsインデックスが作成されること", () => {
      const row = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_thread_ts'"
      ).get();
      assert.equal(row.name, "idx_thread_ts");
    });

    it("既存DBに対して再度initしてもエラーにならないこと", () => {
      assert.doesNotThrow(() => {
        const db2 = initSqliteDb(dbPath);
        db2.close();
      });
    });
  });

  describe("logMessageSqlite", () => {
    it("メッセージが1件INSERTされること", () => {
      logMessageSqlite(db, "2026-04-05 12:00:00", "#general", "alice", "Hello", "C0123", "U0456", "1234567890.000100", null);
      const rows = db.prepare("SELECT * FROM messages").all();
      assert.equal(rows.length, 1, "1件のレコードが存在する");
    });

    it("INSERTしたメッセージの各フィールドが正しく保存されること", () => {
      logMessageSqlite(db, "2026-04-05 12:00:00", "#general", "alice", "Hello", "C0123", "U0456", "1234567890.000100", null);
      const row = db.prepare("SELECT * FROM messages").get();
      assert.equal(row.logged_at,  "2026-04-05 12:00:00",   "logged_atが一致する");
      assert.equal(row.channel,    "#general",               "channelが一致する");
      assert.equal(row.user,       "alice",                  "userが一致する");
      assert.equal(row.message,    "Hello",                  "messageが一致する");
      assert.equal(row.channel_id, "C0123",                  "channel_idが一致する");
      assert.equal(row.user_id,    "U0456",                  "user_idが一致する");
      assert.equal(row.slack_ts,   "1234567890.000100",      "slack_tsが一致する");
      assert.isNull(row.thread_ts,                           "thread_tsがnull");
    });

    it("スレッドメッセージのthread_tsが保存されること", () => {
      logMessageSqlite(db, "2026-04-05 12:00:00", "#general", "alice", "Reply", "C0123", "U0456", "1234567891.000200", "1234567890.000100");
      const row = db.prepare("SELECT thread_ts FROM messages").get();
      assert.equal(row.thread_ts, "1234567890.000100", "thread_tsが一致する");
    });

    it("複数件のメッセージをINSERTできること", () => {
      logMessageSqlite(db, "2026-04-05 12:00:00", "#general", "alice", "Hello",   "C0001", "U0001", "100.000", null);
      logMessageSqlite(db, "2026-04-05 12:00:01", "#general", "bob",   "Hi",      "C0001", "U0002", "101.000", null);
      logMessageSqlite(db, "2026-04-05 12:00:02", "#random",  "alice", "Hey",     "C0002", "U0001", "102.000", null);
      const rows = db.prepare("SELECT * FROM messages").all();
      assert.equal(rows.length, 3, "3件のレコードが存在する");
    });

    it("idがAUTOINCREMENTで連番になること", () => {
      logMessageSqlite(db, "2026-04-05 12:00:00", "#general", "alice", "first",  "C0001", "U0001", "100.000", null);
      logMessageSqlite(db, "2026-04-05 12:00:01", "#general", "alice", "second", "C0001", "U0001", "101.000", null);
      const rows = db.prepare("SELECT id FROM messages ORDER BY id").all();
      assert.equal(rows[0].id, 1, "1件目のidは1");
      assert.equal(rows[1].id, 2, "2件目のidは2");
    });

    it("created_atが自動セットされること", () => {
      logMessageSqlite(db, "2026-04-05 12:00:00", "#general", "alice", "Hello", "C0001", "U0001", "100.000", null);
      const row = db.prepare("SELECT created_at FROM messages").get();
      assert.isString(row.created_at,   "created_atが文字列として存在する");
      assert.isNotEmpty(row.created_at, "created_atが空でない");
    });

    it("日本語メッセージが正しく保存されること", () => {
      logMessageSqlite(db, "2026-04-05 12:00:00", "#general", "alice", "こんにちは世界", "C0001", "U0001", "100.000", null);
      const row = db.prepare("SELECT message FROM messages").get();
      assert.equal(row.message, "こんにちは世界", "日本語メッセージが一致する");
    });

    it("channelがnullでもINSERTできること", () => {
      logMessageSqlite(db, "2026-04-05 12:00:00", null, "alice", "Hello", null, "U0001", "100.000", null);
      const row = db.prepare("SELECT * FROM messages").get();
      assert.isNull(row.channel,    "channelがnull");
      assert.isNull(row.channel_id, "channel_idがnull");
    });
  });

  describe("FTS5全文検索のテスト", () => {
    beforeEach(() => {
      logMessageSqlite(db, "2026-04-05 12:00:00", "#general", "alice", "Hello world",       "C0001", "U0001", "100.000", null);
      logMessageSqlite(db, "2026-04-05 12:00:01", "#general", "bob",   "Good morning",      "C0001", "U0002", "101.000", null);
      logMessageSqlite(db, "2026-04-05 12:00:02", "#random",  "alice", "こんにちは世界",    "C0002", "U0001", "102.000", null);
    });

    it("FTS5でキーワード検索できること", () => {
      const rows = db.prepare(
        "SELECT m.* FROM messages m JOIN messages_fts f ON m.id = f.rowid WHERE messages_fts MATCH ?"
      ).all("Hello");
      assert.equal(rows.length, 1, "1件ヒットする");
      assert.equal(rows[0].message, "Hello world", "メッセージが一致する");
    });

    it("FTS5で日本語キーワード検索できること", () => {
      const rows = db.prepare(
        "SELECT m.* FROM messages m JOIN messages_fts f ON m.id = f.rowid WHERE messages_fts MATCH ?"
      ).all("こんにちは世界");
      assert.equal(rows.length, 1, "1件ヒットする");
      assert.equal(rows[0].message, "こんにちは世界", "日本語メッセージが一致する");
    });

    it("FTS5で存在しないキーワードは0件になること", () => {
      const rows = db.prepare(
        "SELECT m.* FROM messages m JOIN messages_fts f ON m.id = f.rowid WHERE messages_fts MATCH ?"
      ).all("notexist");
      assert.equal(rows.length, 0, "0件ヒットする");
    });
  });
});
