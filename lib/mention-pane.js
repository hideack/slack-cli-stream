let ansiEscapes = require("ansi-escapes");
let nodeUtil = require("util");
let chalk = require("chalk");

// 端末を「上: 全チャンネルログ(スクロール)」「区切り線(1行)」
// 「自分宛メンションの固定ペイン」「下: コマンド入力行」の4段に分割するための
// DECSTBM ベースの実装。tmux 等の外部マルチプレクサを使わず、単一プロセス内で完結させる。

const PANE_LINES_RE = /^[1-9][0-9]*$/;
// ペイン有効化に最低限必要な余白行数(メインログ1行 + 区切り線1行 + 入力行1行)
const MIN_ROWS_MARGIN = 3;
// メッセージ本文の長さを見積もる際に差し引く、日付/チャンネル/ユーザー欄の
// 表示幅(core.display() の "%s | %30s | %28s | %s" 相当、区切り記号込みで86文字)。
const FIXED_PREFIX_WIDTH_ESTIMATE = 87;

const ESCAPE_REGEXP_RE = /[.*+?^${}()|[\]\\]/g;
let escapeRegExp = (str) => String(str).replace(ESCAPE_REGEXP_RE, "\\$&");

let BROADCAST_MENTION_RE = /<!(?:channel|here|everyone)>/;

// "--mention-pane <lines>" の値検証。正の整数のみ受理し、それ以外は null。
let parsePaneLines = (raw) => {
  if (raw === undefined || raw === null) {
    return null;
  }

  let str = String(raw).trim();

  if (!PANE_LINES_RE.test(str)) {
    return null;
  }

  return parseInt(str, 10);
};

// メッセージが「自分宛」かどうかを判定する。
// data.lines/data.fullLines は core.display() 内のローカル変換(絵文字化・
// replaceSlackId・装飾)の影響を受けない生の Slack マークアップを保持しているため、
// <@USERID> / <!channel> 等をそのまま正規表現で判定できる。
let isRelevant = (data, ctx) => {
  let context = ctx || {};
  let selfUserId = context.selfUserId;
  let usergroupMemberIds = context.usergroupMemberIds;
  let source = (data && (data.fullLines || data.lines)) || [];
  let text = source.join("\n");

  if (selfUserId) {
    let selfMentionRe = new RegExp("<@" + escapeRegExp(selfUserId) + "(?:\\|[^>]*)?>");
    if (selfMentionRe.test(text)) {
      return true;
    }
  }

  if (BROADCAST_MENTION_RE.test(text)) {
    return true;
  }

  if (usergroupMemberIds && usergroupMemberIds.size > 0) {
    let usergroupRe = /<!subteam\^([A-Z0-9]+)(?:\|[^>]*)?>/g;
    let match;
    while ((match = usergroupRe.exec(text)) !== null) {
      if (usergroupMemberIds.has(match[1])) {
        return true;
      }
    }
  }

  return false;
};

// usergroups.list({ include_users: true }) のレスポンスから、
// 自分が所属しているユーザーグループIDの集合を抽出する(純粋関数)。
let extractMemberUsergroupIds = (usergroupsListResponse, selfUserId) => {
  let ids = new Set();

  if (!usergroupsListResponse || !Array.isArray(usergroupsListResponse.usergroups) || !selfUserId) {
    return ids;
  }

  usergroupsListResponse.usergroups.forEach((group) => {
    if (group && Array.isArray(group.users) && group.users.indexOf(selfUserId) !== -1) {
      ids.add(group.id);
    }
  });

  return ids;
};

// core.display() と同一の "日付 | チャンネル | ユーザー | メッセージ" フォーマットで
// 1行分整形する(lib/utility.js に集約された共通ロジックを再利用)。
let formatPaneLine = (data, util, columns) => {
  let identity = util.resolveDisplayIdentity(data);
  let sourceLines = data.lines || data.fullLines || [""];
  let rawFirstLine = String(sourceLines[0] || "");
  let maxMessageWidth = (Number.isFinite(columns) && columns > 0) ? Math.max(10, columns - FIXED_PREFIX_WIDTH_ESTIMATE) : 110;

  if (rawFirstLine.length > maxMessageWidth) {
    rawFirstLine = rawFirstLine.slice(0, Math.max(0, maxMessageWidth - 1)) + "…";
  }

  let decoratedLine = util.decorateLine(rawFirstLine);
  let dateFormat = util.formatDisplayDate(data.time);

  return util.formatDisplayLine(dateFormat, identity.channel, identity.name, decoratedLine);
};

// ペインと本体ログの境界を視覚的に分かりやすくするための区切り線。
let buildDividerLine = (columns) => {
  let cols = (Number.isFinite(columns) && columns > 0) ? columns : 80;
  let label = " Mentions ";

  if (cols <= label.length) {
    return chalk.dim("─".repeat(cols));
  }

  let leftDashes = 2;
  let rightDashes = Math.max(0, cols - leftDashes - label.length);

  return chalk.dim("─".repeat(leftDashes) + label + "─".repeat(rightDashes));
};

// 自分宛メンションペインのコントローラを生成する。
// height: ペインの行数
// stdout: process.stdout
// util: lib/utility.js のシングルトン(selfUserId / usergroupMemberIds / 表示フォーマットを都度参照する)
let createMentionPane = ({ height, stdout, util }) => {
  let active = false;
  let rli = null;
  let geom = null;
  let ringBuffer = [];
  let origConsoleLog = null;
  let origConsoleError = null;
  let origStdoutWrite = null;
  let realWrite = null;
  let inWrite = false;
  let resizeHandler = null;

  let computeGeometry = () => {
    let rows = stdout.rows;
    let columns = stdout.columns;

    if (!Number.isFinite(rows) || !Number.isFinite(columns) || rows < height + MIN_ROWS_MARGIN) {
      return null;
    }

    let inputRow = rows;
    let paneTop = rows - height;
    let dividerRow = paneTop - 1;
    let mainBottom = dividerRow - 1;

    return { rows, columns, inputRow, paneTop, dividerRow, mainBottom };
  };

  let writeIntoMainRegion = (text) => {
    if (inWrite || !geom) {
      realWrite(text);
      return;
    }

    inWrite = true;
    try {
      realWrite(ansiEscapes.cursorTo(0, geom.mainBottom - 1));
      realWrite(text);
      realWrite(ansiEscapes.cursorTo(0, geom.inputRow - 1));
      if (rli) {
        rli.prompt(true);
      }
    } finally {
      inWrite = false;
    }
  };

  let installPatches = () => {
    if (origStdoutWrite) {
      return; // すでにパッチ済み
    }

    origConsoleLog = console.log;
    origConsoleError = console.error;
    origStdoutWrite = stdout.write;
    realWrite = origStdoutWrite.bind(stdout);

    console.log = (...args) => {
      writeIntoMainRegion(nodeUtil.format(...args) + "\n");
    };

    console.error = (...args) => {
      writeIntoMainRegion(nodeUtil.format(...args) + "\n");
    };

    stdout.write = (chunk, encoding, callback) => {
      let cb = callback;
      let enc = encoding;

      if (typeof encoding === "function") {
        cb = encoding;
        enc = undefined;
      }

      let text = typeof chunk === "string" ? chunk : chunk.toString(enc);
      writeIntoMainRegion(text);

      if (typeof cb === "function") {
        cb();
      }

      return true;
    };
  };

  let uninstallPatches = () => {
    if (origConsoleLog) {
      console.log = origConsoleLog;
    }
    if (origConsoleError) {
      console.error = origConsoleError;
    }
    if (origStdoutWrite) {
      stdout.write = origStdoutWrite;
    }

    origConsoleLog = null;
    origConsoleError = null;
    origStdoutWrite = null;
    realWrite = null;
  };

  let setScrollRegion = () => {
    realWrite("\x1b[1;" + geom.mainBottom + "r");
  };

  let resetScrollRegion = () => {
    realWrite("\x1b[r");
  };

  let redrawPane = () => {
    if (!geom || !realWrite) {
      return;
    }

    let displayLines = ringBuffer.slice(-height);
    let out = ansiEscapes.cursorSavePosition;

    out += ansiEscapes.cursorTo(0, geom.dividerRow - 1) + ansiEscapes.eraseLine + buildDividerLine(geom.columns);

    for (let i = 0; i < height; i++) {
      let row = geom.paneTop + i;
      out += ansiEscapes.cursorTo(0, row - 1) + ansiEscapes.eraseLine;

      let line = displayLines[i];
      if (line) {
        out += line;
      }
    }

    out += ansiEscapes.cursorRestorePosition;
    realWrite(out);
  };

  let activateWithGeometry = (nextGeom) => {
    geom = nextGeom;
    installPatches();
    active = true;
    setScrollRegion();
    redrawPane();
    realWrite(ansiEscapes.cursorTo(0, geom.inputRow - 1));
    if (rli) {
      rli.prompt(true);
    }
  };

  let deactivate = () => {
    resetScrollRegion();
    uninstallPatches();
    active = false;
    geom = null;
  };

  let onResize = () => {
    let nextGeom = computeGeometry();

    if (!active) {
      if (nextGeom) {
        activateWithGeometry(nextGeom);
      }
      return;
    }

    if (!nextGeom) {
      deactivate();
      return;
    }

    geom = nextGeom;
    setScrollRegion();
    redrawPane();
    realWrite(ansiEscapes.cursorTo(0, geom.inputRow - 1));
    if (rli) {
      rli.prompt(true);
    }
  };

  let enable = (rliInstance) => {
    if (!stdout.isTTY || !process.stdin.isTTY) {
      return false; // パイプ/リダイレクト等では無音でフォールバック
    }

    rli = rliInstance;
    resizeHandler = onResize;
    stdout.on("resize", resizeHandler);

    let initialGeom = computeGeometry();
    if (!initialGeom) {
      console.error(`--mention-pane: 端末が狭すぎるため無効化しました(必要: ${height + MIN_ROWS_MARGIN}行以上)`);
      return false;
    }

    activateWithGeometry(initialGeom);
    return true;
  };

  let feed = (data) => {
    if (!active) {
      return;
    }

    let relevant = isRelevant(data, {
      selfUserId: util.selfUserId,
      usergroupMemberIds: util.usergroupMemberIds
    });

    if (!relevant) {
      return;
    }

    ringBuffer.push(formatPaneLine(data, util, geom ? geom.columns : stdout.columns));
    if (ringBuffer.length > height) {
      ringBuffer = ringBuffer.slice(ringBuffer.length - height);
    }

    redrawPane();
  };

  let disable = () => {
    if (resizeHandler) {
      stdout.removeListener("resize", resizeHandler);
      resizeHandler = null;
    }

    if (active) {
      resetScrollRegion();
      realWrite(ansiEscapes.cursorTo(0, geom ? geom.rows - 1 : 0) + "\n");
    }

    uninstallPatches();
    active = false;
    geom = null;
    ringBuffer = [];
  };

  return { enable, feed, disable };
};

module.exports = {
  parsePaneLines,
  isRelevant,
  extractMemberUsergroupIds,
  createMentionPane
};
