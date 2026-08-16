let assert = require("chai").assert;
let { withTimeout, runWithWorkers } = require("../lib/backfill-runner");

const delay = (ms, value) => new Promise((resolve) => setTimeout(() => resolve(value), ms));
const never = () => new Promise(() => {});

describe("バックフィル実行制御のテスト", () => {
  describe("withTimeout", () => {
    it("期限内に解決すれば値がそのまま返ること", async () => {
      const value = await withTimeout(delay(5, "ok"), 200, "timed out");
      assert.equal(value, "ok", "解決値が返る");
    });

    it("期限を過ぎたらrejectされること", async () => {
      let error = null;
      try {
        await withTimeout(never(), 20, "timed out");
      } catch (e) {
        error = e;
      }
      assert.isNotNull(error, "エラーになる");
      assert.equal(error.message, "timed out", "指定したメッセージでrejectされる");
    });

    it("元のpromiseのrejectがそのまま伝わること", async () => {
      let error = null;
      try {
        await withTimeout(Promise.reject(new Error("boom")), 200, "timed out");
      } catch (e) {
        error = e;
      }
      assert.equal(error.message, "boom", "元のエラーが伝わる");
    });
  });

  describe("runWithWorkers", () => {
    it("全アイテムが処理されること", async () => {
      const processed = [];
      const result = await runWithWorkers([1, 2, 3, 4, 5], async (item) => {
        await delay(1);
        processed.push(item);
      }, { concurrency: 2 });

      assert.equal(result.completed, 5, "5件処理される");
      assert.isFalse(result.abandoned, "見捨てられたワーカーはない");
      assert.deepEqual(processed.sort(), [1, 2, 3, 4, 5], "全アイテムが処理される");
    });

    it("空配列でも即座に返ること", async () => {
      const result = await runWithWorkers([], async () => {}, { concurrency: 3 });
      assert.equal(result.completed, 0, "0件");
      assert.isFalse(result.abandoned, "見捨てられたワーカーはない");
    });

    it("1件が失敗しても他のアイテムが処理されること", async () => {
      const processed = [];
      const errors = [];
      const result = await runWithWorkers([1, 2, 3], async (item) => {
        if (item === 2) throw new Error("failed");
        processed.push(item);
      }, {
        concurrency: 1,
        onError: (error, item) => errors.push(item)
      });

      assert.deepEqual(processed, [1, 3], "失敗しなかったアイテムは処理される");
      assert.deepEqual(errors, [2], "失敗したアイテムがonErrorに渡る");
      assert.equal(result.completed, 3, "失敗したアイテムも処理済みとして数える");
    });

    it("1件が詰まっても他のアイテムが処理されること", async () => {
      const processed = [];
      const result = await runWithWorkers([1, 2, 3, 4], async (item) => {
        if (item === 1) return never(); // 1件だけ永久に終わらない
        await delay(1);
        processed.push(item);
      }, { concurrency: 2, deadlineAt: Date.now() + 300 });

      assert.deepEqual(processed.sort(), [2, 3, 4], "他のアイテムは完走する");
      assert.isTrue(result.abandoned, "詰まったワーカーは見捨てられる");
    });

    it("全ワーカーが詰まっても期限で必ず制御が戻ること", async () => {
      const startedAt = Date.now();
      const result = await runWithWorkers([1, 2], () => never(), {
        concurrency: 2,
        deadlineAt: Date.now() + 100
      });

      assert.isTrue(result.abandoned, "見捨てて返る");
      assert.isBelow(Date.now() - startedAt, 3000, "期限付近で制御が戻る");
    });

    it("期限を過ぎたら残りのアイテムを取り出さないこと", async () => {
      const processed = [];
      await runWithWorkers([1, 2, 3, 4, 5], async (item) => {
        await delay(30);
        processed.push(item);
      }, { concurrency: 1, deadlineAt: Date.now() + 50 });

      assert.isBelow(processed.length, 5, "全件は処理されない");
      assert.isAbove(processed.length, 0, "期限までに処理できたぶんは処理される");
    });
  });
});
