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

    it("logged_atインデックスが作成されること", () => {
      const row = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_logged_at'"
      ).get();
      assert.equal(row.name, "idx_logged_at", "idx_logged_atインデックスが存在する");
    });

    it("channelインデックスが作成されること", () => {
      const row = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_channel'"
      ).get();
      assert.equal(row.name, "idx_channel", "idx_channelインデックスが存在する");
    });

    it("userインデックスが作成されること", () => {
      const row = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_user'"
      ).get();
      assert.equal(row.name, "idx_user", "idx_userインデックスが存在する");
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
      logMessageSqlite(db, "2026-04-05 12:00:00", "#general", "alice", "Hello");
      const rows = db.prepare("SELECT * FROM messages").all();
      assert.equal(rows.length, 1, "1件のレコードが存在する");
    });

    it("INSERTしたメッセージの各フィールドが正しく保存されること", () => {
      logMessageSqlite(db, "2026-04-05 12:00:00", "#general", "alice", "Hello");
      const row = db.prepare("SELECT * FROM messages").get();
      assert.equal(row.logged_at, "2026-04-05 12:00:00", "logged_atが一致する");
      assert.equal(row.channel,   "#general",             "channelが一致する");
      assert.equal(row.user,      "alice",                "userが一致する");
      assert.equal(row.message,   "Hello",                "messageが一致する");
    });

    it("複数件のメッセージをINSERTできること", () => {
      logMessageSqlite(db, "2026-04-05 12:00:00", "#general", "alice", "Hello");
      logMessageSqlite(db, "2026-04-05 12:00:01", "#general", "bob",   "Hi");
      logMessageSqlite(db, "2026-04-05 12:00:02", "#random",  "alice", "Hey");
      const rows = db.prepare("SELECT * FROM messages").all();
      assert.equal(rows.length, 3, "3件のレコードが存在する");
    });

    it("idがAUTOINCREMENTで連番になること", () => {
      logMessageSqlite(db, "2026-04-05 12:00:00", "#general", "alice", "first");
      logMessageSqlite(db, "2026-04-05 12:00:01", "#general", "alice", "second");
      const rows = db.prepare("SELECT id FROM messages ORDER BY id").all();
      assert.equal(rows[0].id, 1, "1件目のidは1");
      assert.equal(rows[1].id, 2, "2件目のidは2");
    });

    it("created_atが自動セットされること", () => {
      logMessageSqlite(db, "2026-04-05 12:00:00", "#general", "alice", "Hello");
      const row = db.prepare("SELECT created_at FROM messages").get();
      assert.isString(row.created_at, "created_atが文字列として存在する");
      assert.isNotEmpty(row.created_at, "created_atが空でない");
    });

    it("日本語メッセージが正しく保存されること", () => {
      logMessageSqlite(db, "2026-04-05 12:00:00", "#general", "alice", "こんにちは世界");
      const row = db.prepare("SELECT message FROM messages").get();
      assert.equal(row.message, "こんにちは世界", "日本語メッセージが一致する");
    });

    it("channelがnullでもINSERTできること", () => {
      logMessageSqlite(db, "2026-04-05 12:00:00", null, "alice", "Hello");
      const row = db.prepare("SELECT * FROM messages").get();
      assert.isNull(row.channel, "channelがnull");
    });
  });
});
