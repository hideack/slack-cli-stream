let assert = require("chai").assert;
let fs = require("fs");
let os = require("os");
let path = require("path");
let { initSqliteDb, logMessageSqlite } = require("../lib/sqlite-logger");
let { planGroupDedupe, dedupeMessages } = require("../lib/dedupe");

describe("重複排除のテスト", () => {
  describe("planGroupDedupe", () => {
    it("行が空なら何も残らないこと", () => {
      const plan = planGroupDedupe([]);
      assert.deepEqual(plan.keepIds,   [], "残す行がない");
      assert.deepEqual(plan.deleteIds, [], "削除する行がない");
    });

    it("重複のない1行メッセージはそのまま残ること", () => {
      const plan = planGroupDedupe([
        { id: 1, message: "hello", created_at: "2026-08-16 11:00:00" }
      ]);
      assert.deepEqual(plan.keepIds,   [1], "1行残る");
      assert.deepEqual(plan.deleteIds, [],  "削除なし");
    });

    it("同一メッセージが3回INSERTされていたら2回ぶんが削除されること", () => {
      const plan = planGroupDedupe([
        { id: 1, message: "hello", created_at: "2026-08-16 11:00:00" },
        { id: 2, message: "hello", created_at: "2026-08-16 12:00:00" },
        { id: 3, message: "hello", created_at: "2026-08-16 13:00:00" }
      ]);
      assert.deepEqual(plan.keepIds,   [1],    "最初の1件が残る");
      assert.deepEqual(plan.deleteIds, [2, 3], "後続2件が削除される");
    });

    it("複数行メッセージがブロック単位で削除されること", () => {
      const plan = planGroupDedupe([
        { id: 1, message: "line1", created_at: "2026-08-16 11:00:00" },
        { id: 2, message: "line2", created_at: "2026-08-16 11:00:00" },
        { id: 3, message: "line1", created_at: "2026-08-16 12:00:00" },
        { id: 4, message: "line2", created_at: "2026-08-16 12:00:00" }
      ]);
      assert.deepEqual(plan.keepIds,   [1, 2], "1メッセージぶん(2行)が残る");
      assert.deepEqual(plan.deleteIds, [3, 4], "重複ブロックが削除される");
    });

    it("同じ行を2行含む1メッセージが壊されないこと", () => {
      // 1回のINSERTで書かれた行は created_at が揃うため、重複ではなく
      // 「同じ文字列の行を2行持つ1メッセージ」と判定される必要がある
      const plan = planGroupDedupe([
        { id: 1, message: "same", created_at: "2026-08-16 11:00:00" },
        { id: 2, message: "same", created_at: "2026-08-16 11:00:00" }
      ]);
      assert.deepEqual(plan.keepIds,   [1, 2], "2行とも残る");
      assert.deepEqual(plan.deleteIds, [],     "削除なし");
    });

    it("先頭ブロックと一致しない行は削除されないこと", () => {
      const plan = planGroupDedupe([
        { id: 1, message: "line1", created_at: "2026-08-16 11:00:00" },
        { id: 2, message: "other", created_at: "2026-08-16 12:00:00" }
      ]);
      assert.deepEqual(plan.keepIds,   [1, 2], "一致しない行は温存される");
      assert.deepEqual(plan.deleteIds, [],     "削除なし");
    });
  });

  describe("dedupeMessages", () => {
    let db;
    let dbPath;

    beforeEach(() => {
      dbPath = path.join(os.tmpdir(), `slack-dedupe-test-${Date.now()}-${Math.random()}.db`);
      db = initSqliteDb(dbPath);
      // 移行前(line_no が NULL)の重複行を直接作る
      const insert = db.prepare(`
        INSERT INTO messages (logged_at, channel, user, message, channel_id, user_id, slack_ts, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      insert.run("2026-08-16 11:00:00", "#alert", "bot", "alarm", "C0001", "U0001", "100.000100", "2026-08-16 11:00:00");
      insert.run("2026-08-16 11:00:00", "#alert", "bot", "alarm", "C0001", "U0001", "100.000100", "2026-08-16 12:00:00");
      insert.run("2026-08-16 11:00:00", "#alert", "bot", "alarm", "C0001", "U0001", "100.000100", "2026-08-16 13:00:00");
      insert.run("2026-08-16 11:00:05", "#alert", "bot", "other", "C0001", "U0001", "105.000100", "2026-08-16 11:00:05");
    });

    afterEach(() => {
      db.close();
      if (fs.existsSync(dbPath)) {
        fs.unlinkSync(dbPath);
      }
    });

    it("重複行が削除されること", () => {
      const result = dedupeMessages(db);
      assert.equal(result.deleted, 2, "2行削除される");
      const rows = db.prepare("SELECT * FROM messages ORDER BY id").all();
      assert.equal(rows.length, 2, "2行残る");
      assert.equal(rows[0].id, 1, "最初に記録された行が残る");
    });

    it("残った行に line_no が振られること", () => {
      dedupeMessages(db);
      const rows = db.prepare("SELECT line_no FROM messages ORDER BY id").all();
      assert.equal(rows[0].line_no, 0, "1メッセージ目の行番号は0");
      assert.equal(rows[1].line_no, 0, "別メッセージの行番号も0から");
    });

    it("dry-run では削除されないこと", () => {
      const result = dedupeMessages(db, { dryRun: true });
      assert.isTrue(result.dryRun, "dryRunフラグが返る");
      assert.equal(result.deleted, 0, "削除件数は0");
      const count = db.prepare("SELECT COUNT(*) AS count FROM messages").get().count;
      assert.equal(count, 4, "行数が変わらない");
    });

    it("削除後もFTSインデックスが整合していること", () => {
      dedupeMessages(db);
      const rows = db.prepare(
        "SELECT m.id FROM messages m JOIN messages_fts f ON m.id = f.rowid WHERE messages_fts MATCH ?"
      ).all("alarm");
      assert.equal(rows.length, 1, "削除済みの行はFTSからもヒットしない");
    });

    it("実行後は同じメッセージを再INSERTしても増えないこと", () => {
      dedupeMessages(db);
      logMessageSqlite(db, "2026-08-16 11:00:00", "#alert", "bot", "alarm", "C0001", "U0001", "100.000100", null, 0);
      const count = db.prepare("SELECT COUNT(*) AS count FROM messages").get().count;
      assert.equal(count, 2, "一意インデックスで重複INSERTが無視される");
    });

    it("2回実行しても壊れないこと", () => {
      dedupeMessages(db);
      const result = dedupeMessages(db);
      assert.equal(result.deleted, 0, "2回目は削除対象がない");
      const count = db.prepare("SELECT COUNT(*) AS count FROM messages").get().count;
      assert.equal(count, 2, "行数が変わらない");
    });
  });
});
