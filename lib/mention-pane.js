let ansiEscapes = require("ansi-escapes");
let nodeUtil = require("util");

// 端末を「上: 全チャンネルログ(スクロール)」「中: 自分宛メンションの固定ペイン」
// 「下: コマンド入力行」の3段に分割するための DECSTBM ベースの実装。
// tmux 等の外部マルチプレクサを使わず、単一プロセス内で完結させる。

const PANE_LINES_RE = /^[1-9][0-9]*$/;
// ペイン有効化に最低限必要な余白行数(メインログ1行 + 入力行1行)
const MIN_ROWS_MARGIN = 2;

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

let formatPaneLine = (data, resolveChannelLabel, columns) => {
  let time = (data.time && typeof data.time.format === "function") ? data.time.format("HH:mm:ss") : "--:--:--";
  let channelLabel = (typeof data.channel === "string" && typeof resolveChannelLabel === "function")
    ? (resolveChannelLabel(data.channel) || data.channel)
    : (typeof data.channel === "string" ? data.channel : "-");
  let userLabel = typeof data.user === "string" ? data.user : "-";
  let sourceLines = data.lines || data.fullLines || [""];
  let firstLine = String(sourceLines[0] || "").replace(/\s+/g, " ").trim();
  let raw = `${time} ${channelLabel} ${userLabel}: ${firstLine}`;
  let maxCols = (Number.isFinite(columns) && columns > 0) ? columns : 200;

  return raw.length > maxCols ? raw.slice(0, Math.max(0, maxCols - 1)) + "…" : raw;
};

// 自分宛メンションペインのコントローラを生成する。
// height: ペインの行数
// stdout: process.stdout
// resolveChannelLabel: channelId -> 表示用チャンネルラベル(色コード無しの平文推奨)
// util: lib/utility.js のシングルトン(selfUserId / usergroupMemberIds を都度参照する)
let createMentionPane = ({ height, stdout, resolveChannelLabel, util }) => {
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
    let mainBottom = paneTop - 1;

    return { rows, columns, inputRow, paneTop, mainBottom };
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

    ringBuffer.push(formatPaneLine(data, resolveChannelLabel, geom ? geom.columns : stdout.columns));
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
