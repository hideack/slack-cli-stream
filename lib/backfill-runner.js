// バックフィルの実行制御(タイムアウト付き待機と簡易ワーカーキュー)。
// core.js から切り出してテストできるようにしている。

// promise が ms 以内に解決しなければ Error で reject する。
// Slack SDK のリトライは最大数分ブロックしうるため、呼び出し側が
// 永久に待たされないようにするための保険。
const withTimeout = (promise, ms, message) => {
  let timer = null;
  const clear = () => { if (timer) clearTimeout(timer); };

  return Promise.race([
    promise,
    new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
    })
  ]).then(
    (value) => { clear(); return value; },
    (error) => { clear(); throw error; }
  );
};

// items を concurrency 本のワーカーで処理する。
//
// - バッチ単位の Promise.all ではなくキューから順に取り出すので、
//   1件が詰まっても他のワーカーは進み続ける。
// - deadlineAt を過ぎたら新しい取り出しをやめる。さらに、詰まったままの
//   ワーカーは見捨てて返る(呼び出し側の実行中フラグが永久に立ちっぱなしに
//   なるのを防ぐため)。
// - handler が投げた例外は onError に渡し、他のアイテムの処理は続行する。
//
// 戻り値の completed は「処理が終わったアイテム数」(失敗も含む)、
// abandoned は「期限切れでワーカーを見捨てたかどうか」。
const runWithWorkers = async (items, handler, options) => {
  const opts = options || {};
  const concurrency = Math.max(1, Math.min(opts.concurrency || 1, items.length));
  const deadlineAt = (typeof opts.deadlineAt === "number") ? opts.deadlineAt : null;
  const onError = opts.onError || (() => {});

  if (items.length === 0) {
    return { completed: 0, abandoned: false };
  }

  let nextIndex = 0;
  let completed = 0;

  const worker = async () => {
    for (;;) {
      if (deadlineAt !== null && Date.now() > deadlineAt) return;

      const index = nextIndex++;
      if (index >= items.length) return;

      try {
        await handler(items[index], index);
      } catch (error) {
        onError(error, items[index]);
      }
      completed++;
    }
  };

  // onError 自身が投げた場合でも未処理の rejection にならないようにする
  const workers = Promise.all(Array.from({ length: concurrency }, () => worker())).catch(() => {});

  if (deadlineAt === null) {
    await workers;
    return { completed, abandoned: false };
  }

  // 全体の期限。ワーカーが1本ハングしても、ここで必ず制御を返す。
  let deadlineTimer = null;
  let abandoned = true;
  const deadline = new Promise((resolve) => {
    deadlineTimer = setTimeout(resolve, Math.max(0, deadlineAt - Date.now()));
  });

  await Promise.race([
    workers.then(() => { abandoned = false; }),
    deadline
  ]);
  if (deadlineTimer) clearTimeout(deadlineTimer);

  return { completed, abandoned };
};

module.exports = { withTimeout, runWithWorkers };
