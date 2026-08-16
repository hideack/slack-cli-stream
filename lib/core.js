let moment = require("moment");
let chalk = require("chalk");
let emoji = require("node-emoji");
let winston = require("winston");
let util = require("./utility.js");
let cli = require("./cli.js");

const path = require("path");
const fs = require("fs");
const exec = require("child_process").exec;
const { initSqliteDb, logMessageSqlite, getLastSlackTsPerChannel, updateAppHeartbeat, getLastAppHeartbeat, getLastMessageTs, getInjectedChannelLabels, hasUnmigratedRows } = require("./sqlite-logger");
const { startMcpServer } = require("./mcp-server");
const { parsePaneLines, extractMemberUsergroupIds, createMentionPane } = require("./mention-pane");
const { withTimeout, runWithWorkers } = require("./backfill-runner");

let sqliteDb = null;
// 起動時に SQLite から読み込む、MCP等の注入チャンネルラベル一覧(Tab補完候補用)
let injectedChannelLabels = [];
// lib/cli.js の readline インターフェース。--mention-pane 有効時に
// core.start から参照するため、モジュールスコープに保持する。
let rli = null;
// 自分宛メンション観測ペイン(--mention-pane)のコントローラ
let mentionPane = null;

let getLogger = (filePath) => {
  return winston.createLogger({
    transports: [
      new winston.transports.File({ filename: filePath })
    ],
    exceptionHandlers: [
      new winston.transports.File({ filename: filePath })
    ]
  });
};

// ログファイルにメッセージを記録する関数
const logMessage = (directory, time, channel, user, message) => {
  const date = moment().format("YYYYMMDD");
  const logFilePath = path.join(directory, `${date}.tsv`);
  const logLine = `${time}\t${channel}\t${user}\t${message}\n`;

  fs.appendFile(logFilePath, logLine, (err) => {
    if (err) {
      console.error("ログファイルに書き込めませんでした:", err);
    }
  });
};

const removeEscapeSequences = (text) => {
  return text.replace(/\x1B\[[0-9;]*[mG]/g, "");
};

let core = {};

// util.resolveChannelLabelKey 等は core.js 内の多数の箇所から
// 素の関数名で参照されているため、既存呼び出し箇所の変更を避けるべく
// ローカル名として再エクスポートする(実体は lib/utility.js に集約)。
let resolveChannelName = util.resolveChannelName;
let resolveChannelLabelKey = util.resolveChannelLabelKey;

core.display = (data, options)  => {
  let { name, channel } = util.resolveDisplayIdentity(data);

  data.lines.forEach((line) => {
    let l = util.decorateLine(line);
    let dateFormat = util.formatDisplayDate(data.time);

    console.log(util.formatDisplayLine(dateFormat, channel, name, l));

    name = chalk.white("|>");
  });

  if (options && (options.log || options.logSqlite)) {
    const plainDateFormat = data.time.format("YYYY-MM-DD HH:mm:ss");
    const plainChannel = removeEscapeSequences(channel);
    const plainName = removeEscapeSequences(
      util.users[data.user]
        ? chalk[util.users[data.user].color](util.users[data.user].name)
        : (typeof data.user === "string" ? data.user : "-")
    );

    (data.fullLines || data.lines).forEach((line, lineNo) => {
      let l = util.decorateLine(line);
      const plainLine = removeEscapeSequences(l);

      if (options.log) {
        logMessage(options.log, plainDateFormat, plainChannel, plainName, plainLine);
      }
      if (options.logSqlite && sqliteDb) {
        logMessageSqlite(
          sqliteDb,
          plainDateFormat,
          plainChannel,
          plainName,
          plainLine,
          data.channel  || null,
          data.user     || null,
          data.slackTs  || null,
          data.threadTs || null,
          lineNo
        );
      }
    });
  }
};

core.start = async (commander) => {
  const options = commander.opts();

  let logger;
  let token = options.token;

  if (options.debug) {
    logger = getLogger(options.debug);
  }

  if (options.settings) {
    util.parseSettingFile(options.settings);

    if (util.token) {
      token = util.token;
    }

    if (!options.log && util.logging.file) {
      options.log = util.logging.file;
    }
    if (!options.logSqlite && util.logging.sqlite) {
      options.logSqlite = util.logging.sqlite;
    }
  }

  const BACKFILL_GAP_THRESHOLD = 5 * 60; // 5分以上のギャップがあればバックフィルを実行
  let backfillGapSeconds = null;
  // 「最後に取り込みが生きていた」時刻(Unixタイムスタンプ秒)。
  // バックフィルの開始位置はこの値を基準にする。
  let ingestionAnchorTs = null;
  // RTM が接続済みかどうか。ハートビートは接続中のみ更新する。
  let rtmConnected = false;

  let forceSince = null; // --backfill-from で指定された開始時刻(Unixタイムスタンプ秒)
  if (options.backfillFrom) {
    const parsed = moment(options.backfillFrom, ["YYYY-MM-DD HH:mm", "YYYY-MM-DD"], true);
    if (!parsed.isValid()) {
      console.error(`Error: --backfill-from の日時形式が不正です: "${options.backfillFrom}" (例: "2026-05-28" または "2026-05-28 09:00")`);
      process.exit(1);
    }
    forceSince = parsed.unix();
  }

  let mentionPaneLines = null; // --mention-pane で指定されたペインの行数
  if (options.mentionPane !== undefined) {
    mentionPaneLines = parsePaneLines(options.mentionPane);
    if (mentionPaneLines === null) {
      console.error(`Error: --mention-pane には正の整数を指定してください (指定値: "${options.mentionPane}")`);
      process.exit(1);
    }
  }

  if (options.logSqlite) {
    sqliteDb = initSqliteDb(options.logSqlite);

    // ハートビートは「プロセスの生存」しか表さない。RTM の取り込みが死んだまま
    // プロセスだけ生き続けたケースでは、ハートビートだけを見ると穴を検知できない。
    // そのため「実際に記録できた最後のメッセージ時刻」と併せ、古い方を基準にする。
    const lastHeartbeat = getLastAppHeartbeat(sqliteDb);
    const lastMessageTs = getLastMessageTs(sqliteDb);
    const anchors = [lastHeartbeat, lastMessageTs].filter((ts) => ts !== null);
    if (anchors.length > 0) {
      ingestionAnchorTs = Math.min.apply(null, anchors);
      backfillGapSeconds = Date.now() / 1000 - ingestionAnchorTs;
    }

    // 接続前にハートビートを進めると「取り込みが生きていた」誤った証拠を残すため、
    // RTM が接続されている間だけ更新する。
    setInterval(() => {
      if (rtmConnected) {
        updateAppHeartbeat(sqliteDb);
      }
    }, 60 * 1000);

    if (hasUnmigratedRows(sqliteDb)) {
      console.log(
        "Note: 重複排除キー(line_no)が未設定の既存行があります。" +
        "重複の掃除と保護のため `bin/dedupe-sqlite-messages " + options.logSqlite + "` を一度実行してください。"
      );
    }

    // 過去セッションで注入された MCP 等のチャンネルも Tab 補完候補に含める
    try {
      injectedChannelLabels = getInjectedChannelLabels(sqliteDb);
    } catch (e) {
      injectedChannelLabels = [];
    }
  }

  // Slack 以外のソース(Claude等のAIエージェント)から任意のメッセージを
  // 表示パイプライン(コンソール表示 + バッファ + SQLite記録)へ注入する。
  // channel / user は Slack ID ではなく、そのまま表示する任意ラベル。
  core.postToStream = (text, opts = {}) => {
    const channelLabel = opts.channel || "claude";
    const userLabel = opts.user || "claude";
    const fullLines = String(text).split("\n");
    const bufferKey = (channelLabel.startsWith("#") || channelLabel.startsWith("@"))
      ? channelLabel
      : "#" + channelLabel;

    const data = {
      synthetic: true,
      bufferKey: bufferKey,
      lines: fullLines,
      fullLines: fullLines,
      time: moment(),
      channel: bufferKey,
      user: userLabel,
      slackTs: null,
      threadTs: null
    };

    core.display(data, { log: options.log, logSqlite: options.logSqlite });
    util.addMessageBuffer(data);
    if (mentionPane) {
      mentionPane.feed(data);
    }
  };

  const mcpPort = options.mcpPort
    ? parseInt(options.mcpPort, 10)
    : (util.mcp && util.mcp.port ? util.mcp.port : null);

  if (mcpPort) {
    startMcpServer({ port: mcpPort, sqliteDb, util, postToStream: core.postToStream });
  }

  const {RTMClient} = require("@slack/client");
  const rtm = new RTMClient(token, {
    logLevel: "error",
    retryConfig: {
      retries: 3,
      factor: 2
    }
  });

  // エラーログのスロットリング用変数
  let lastErrorTime = 0;
  let errorCount = 0;
  const ERROR_THROTTLE_MS = 300000; // 5分間隔でのみエラーログを表示

  // RTMClient の内部エラーをキャッチするためのグローバルハンドラ
  process.on("uncaughtException", (error) => {
    const now = Date.now();
    
    // RTMClient.js からのエラーを検出
    if (error && error.stack && error.stack.includes("RTMClient.js")) {
      errorCount++;
      if (now - lastErrorTime > ERROR_THROTTLE_MS) {
        lastErrorTime = now;
        errorCount = 0;
      }
      return;
    }
    
    // "Cannot read properties of null" エラーを直接キャッチ
    if (error && error.message && error.message.includes("Cannot read properties of null")) {
      errorCount++;
      if (now - lastErrorTime > ERROR_THROTTLE_MS) {
        if (errorCount > 1) {
          console.error(`Null property access errors occurred (${errorCount} times since last report)`);
        } else {
          console.error("Null property access error caught:", error.message);
        }
        lastErrorTime = now;
        errorCount = 0;
      }
      return;
    }
    
    // ネットワークエラー (WebClient.js からの DNS/接続エラー) はリトライ対象
    if (isNetworkError && isNetworkError(error)) {
      errorCount++;
      if (now - lastErrorTime > ERROR_THROTTLE_MS) {
        if (errorCount > 1) {
          console.error(`RTM network errors occurred (${errorCount} times since last report)`);
        } else {
          console.error("RTM network error caught:", error.message || "Unknown network error");
        }
        lastErrorTime = now;
        errorCount = 0;
      }
      if (!isReconnecting) {
        isReconnecting = true;
        scheduleRtmRestart();
      }
      return;
    }

    // その他の予期しないエラーは通常通り処理
    throw error;
  });

  let colors = ["red", "green", "yellow", "blue", "magenta", "cyan", "white", "redBright", "greenBright", "yellowBright", "blueBright", "magentaBright", "cyanBright", "whiteBright"];

  util.channels = {};
  util.users = {};
  util.bots = {};
  util.startUp = false;


  rtm.on("error", (error) => {
    if (error && typeof error === "object") {
      console.error("RTM connection error:", error.message || JSON.stringify(error));
    } else if (error) {
      console.error("RTM connection error:", String(error));
    } else {
      console.error("RTM connection error: Unknown error");
    }
  });

  let isReconnecting = false;
  let rtmRestartAttempts = 0;
  const RTM_RESTART_BASE_DELAY_MS = 5000;
  const RTM_RESTART_MAX_DELAY_MS = 60000;

  function scheduleRtmRestart() {
    const delay = Math.min(
      RTM_RESTART_BASE_DELAY_MS * Math.pow(2, rtmRestartAttempts),
      RTM_RESTART_MAX_DELAY_MS
    );
    rtmRestartAttempts++;
    console.log(`Retrying RTM connection in ${delay / 1000}s... (attempt ${rtmRestartAttempts})`);
    setTimeout(() => {
      rtm.start();
    }, delay);
  }

  function isNetworkError(error) {
    if (!error) return false;
    const msg = error.message || String(error);
    return (
      error.code === "ENOTFOUND" ||
      error.code === "ECONNREFUSED" ||
      error.code === "ETIMEDOUT" ||
      msg.includes("ENOTFOUND") ||
      msg.includes("ECONNREFUSED") ||
      msg.includes("ETIMEDOUT") ||
      msg.includes("getaddrinfo")
    );
  }

  rtm.on("disconnect", () => {
    rtmConnected = false;
    if (!isReconnecting) {
      console.log("RTM connection disconnected. Attempting to reconnect...");
      isReconnecting = true;
    }
  });

  rtm.on("connecting", () => {
    if (isReconnecting) {
      console.log("RTM reconnecting...");
    }
  });

  rtm.on("authenticated", (rtmStartData) => {
    rtmRestartAttempts = 0;
    rtmConnected = true;
    if (sqliteDb) {
      updateAppHeartbeat(sqliteDb);
    }
    if (isReconnecting) {
      console.log("RTM reconnected successfully");
      isReconnecting = false;
    }

    util.selfUserId = rtmStartData.self.id;

    if (!util.startUp) {
      console.log(
        `Logged in as ${chalk.bold(rtmStartData.self.name)} of team ${chalk.green.bold(rtmStartData.team.name)}, but not yet connected to a channel`
      );
      util.startUp = true;

      // 起動直後の refreshSlackData() は authenticated 発火前(selfUserId 未確定)
      // に一度実行されるため、初回ログイン時点でユーザーグループ所属を
      // 反映させるためにここで一度だけ追い打ちする。
      if (mentionPaneLines) {
        refreshUsergroupMembership().catch(() => {});
      }
    }
  });

  rtm.on("unable_to_rtm_start", (error) => {
    console.error("Unable to start RTM:", error.message || error);
    rtmConnected = false;
    isReconnecting = false;
    if (isNetworkError(error)) {
      scheduleRtmRestart();
    }
  });

  rtm.on("message", (message) => {
    let time = moment(message.ts * 1000);
    let text = util.parseText(message);

    if (message.subtype) {
      switch(message.subtype) {
      case "message_deleted":
      case "message_changed":
        return;
      case "file_share":
        break;
      case "message_replied":
        return;
      case "channel_join":
        break;
      case "channel_leave":
        break;
      case "group_leave":
        break;
      case "reply_broadcast":
        return;
      case "file_comment":
        break;
      case "bot_message":
        break;
      case "pinned_item":
        break;
      case "slackbot_response":
        break;
      case "file_mention":
        break;
      default:
        if (options.debug) {
          logger.error(message);
        }
        return;
      }
    }

    // textが空の場合、attachmentsからテキストを取得
    if (text === "" && message.attachments && message.attachments.length > 0) {
      text = message.attachments[0].text || "";
    }

    let lines;

    if (typeof(text) == "string") {
      lines = text.split(/\r\n|\r|\n/);
    } else {
      lines = [""];

      if (options.debug) {
        logger.error(message);
      }
    }

    let fullLines = lines;
    if (lines.length > 8) {
      lines = lines.slice(0, 5);
      lines.push("--- snip ---");
    }

    // Display only specific users. (-u option)
    if (options.user) {
      let messageUser = (util.users[message.user]) ? util.users[message.user].name : "-";
      if (options.user != messageUser) {
        return;
      }
    }

    // buffering
    let data = {
      bufferKey: (typeof message.channel == "string") ? resolveChannelLabelKey(message.channel) : "-",
      lines: lines,
      fullLines: fullLines,
      time: time,
      channel: message.channel,
      user: message.user,
      slackTs: message.ts || null,
      threadTs: message.thread_ts || null
    };

    util.addMessageBuffer(data);
    core.display(data, options);
    if (mentionPane) {
      mentionPane.feed(data);
    }

    // hook
    if (options.hook) {
      if (util.hook) {
        exec(util.hook, (err) => {
          if (err) {
            console.log(err);
          }
        });
      }
    }

    // hooks
    let hooks = util.hasHooks(message);

    hooks.forEach((hook) => {
      exec(hook, (err) => {
        if (err) {
          console.log(err);
        }
      });
    });
  });

  // Setup
  const {WebClient, retryPolicies} = require("@slack/client");
  // デフォルトの retryConfig は tenRetriesInAboutThirtyMinutes のため、
  // レートリミット(429)を食らうと最大約30分サイレントにリトライし続けてハングする。
  // バックフィルが固まる原因になるので、上限の短いリトライポリシーに変更する。
  const web = new WebClient(token, {
    logLevel: "error",
    retryConfig: retryPolicies.fiveRetriesInFiveMinutes
  });

  let isRefreshing = false;
  let refreshIntervalMinutes = parseInt(options.refreshInterval, 10);
  if (!Number.isFinite(refreshIntervalMinutes) || refreshIntervalMinutes <= 0) {
    refreshIntervalMinutes = 15;
  }
  const applyChannels = (channels) => {
    channels.forEach((v, i) => {
      v.color = colors[i % colors.length];
      util.channels[v.id] = v;
    });
  };

  const applyUsers = (members) => {
    if (!Array.isArray(members)) return;
    members.forEach((v, i) => {
      v.color = colors[i % colors.length];
      if (!v.name) {
        v.name = v.real_name || (v.profile && v.profile.display_name) || v.id;
      }
      util.users[v.id] = v;
    });
  };

  const refreshSlackData = async () => {
    if (isRefreshing) {
      return;
    }
    isRefreshing = true;
    try {
      let response = await web.conversations.list({
        limit: 1000,
        types: "public_channel,private_channel,im,mpim"
      });
      applyChannels(response.channels);

      while (response.response_metadata.next_cursor != "") {
        response = await web.conversations.list({
          limit: 1000,
          types: "public_channel,private_channel,im,mpim",
          cursor: response.response_metadata.next_cursor
        });
        applyChannels(response.channels);
      }

      response = await web.users.list();
      applyUsers(response.members);

      while (response.response_metadata && response.response_metadata.next_cursor != "") {
        response = await web.users.list({
          limit: 1000,
          cursor: response.response_metadata.next_cursor
        });
        applyUsers(response.members);
      }
    } catch (error) {
      console.error("Failed to refresh Slack metadata:", error.message || error);
    } finally {
      isRefreshing = false;
    }
  };

  // --mention-pane 有効時のみ、自分が所属するユーザーグループIDを
  // usergroups.list({ include_users: true }) から都度キャッシュし直す。
  // 機能無効時は usergroups:read スコープ相当のAPIを一切呼ばない。
  const refreshUsergroupMembership = async () => {
    if (!mentionPaneLines || !util.selfUserId) {
      return;
    }
    try {
      const response = await web.usergroups.list({ include_users: true });
      util.usergroupMemberIds = extractMemberUsergroupIds(response, util.selfUserId);
    } catch (error) {
      console.error("Failed to refresh usergroup membership:", error.message || error);
    }
  };

  await refreshSlackData();
  await refreshUsergroupMembership();
  setInterval(() => {
    refreshSlackData();
    refreshUsergroupMembership();
  }, refreshIntervalMinutes * 60 * 1000);

  // conversations.history はレートリミット(Tier 3)が厳しく、メッセージ量の多い
  // チャンネルでは長時間ブロックされうる。1チャンネルの詰まりが全体を止めないよう、
  // ワーカーキュー方式にしたうえでリクエスト・チャンネル・全体それぞれに上限を設ける。
  const BACKFILL_CONCURRENCY = 3;
  const BACKFILL_REQUEST_TIMEOUT_MS = 2 * 60 * 1000;
  const BACKFILL_CHANNEL_TIMEOUT_MS = 5 * 60 * 1000;
  const BACKFILL_CHANNEL_MAX_PAGES = 200; // 1チャンネルあたり最大 40,000 件
  const BACKFILL_CHANNEL_RECENCY_SEC = 30 * 24 * 3600; // 対象に含める「直近に記録のあった」期間
  const BACKFILL_TOTAL_TIMEOUT_MS = 30 * 60 * 1000;
  const BACKFILL_MAX_LOOKBACK_SEC = 24 * 3600; // 自動バックフィルで遡る上限
  const BACKFILL_PROGRESS_INTERVAL_MS = 30 * 1000;
  const BACKFILL_STALL_WARN_MS = 3 * 60 * 1000;

  let isBackfilling = false;
  let pendingBackfill = null;

  // バックフィル対象チャンネルの決定。
  //
  // 旧実装は「停止直前24時間に発言があったチャンネル」に絞っていたため、
  // 停止直前がたまたま静かで停止中に発言があったチャンネルが永久に埋まらなかった。
  // かわりに「直近30日に記録があるチャンネル」と「参加中のチャンネル」を対象にする。
  // (全チャンネルを対象にすると、放置されたグループDMを含め数千件になり、
  //  conversations.history のレートリミットで現実的な時間に終わらない)
  const selectBackfillChannels = (lastTsMap, nowSec) => {
    const ids = new Set();
    const recencyCutoff = nowSec - BACKFILL_CHANNEL_RECENCY_SEC;

    // DBに直近の記録があるチャンネル(DM・グループDMを含む)
    Object.keys(lastTsMap).forEach((id) => {
      // MCP(post_to_stream)等の注入チャンネルは Slack API の対象外
      if (id.charAt(0) === "#") return;
      if (parseFloat(lastTsMap[id]) <= recencyCutoff) return;
      const channel = util.channels[id];
      if (channel && channel.is_archived) return;
      // 退出済みのチャンネルは取得できないので対象外
      if (channel && !channel.is_im && !channel.is_mpim && !channel.is_member) return;
      ids.add(id);
    });

    // 参加中のチャンネル。DBに記録がなくても、停止中に初めて発言があった場合に
    // 取りこぼさないため対象に含める(DM・グループDMは数が多すぎるので上の条件のみ)。
    Object.keys(util.channels).forEach((id) => {
      const channel = util.channels[id];
      if (!channel || channel.is_archived) return;
      if (channel.is_im || channel.is_mpim) return;
      if (!channel.is_member) return;
      ids.add(id);
    });

    // 打ち切り時の取りこぼしを減らすため、最終発言が新しい順に処理する
    return Array.from(ids).sort((a, b) => {
      return (parseFloat(lastTsMap[b]) || 0) - (parseFloat(lastTsMap[a]) || 0);
    });
  };

  const backfillErrorReason = (err) => {
    return (err && err.data && err.data.error) || (err && err.code) || (err && err.message) || "unknown";
  };

  const runBackfillOnce = async (label, manualSince) => {
    const nowSec = Date.now() / 1000;
    const isManual = manualSince !== undefined && manualSince !== null;

    // 取得開始位置。チャンネルごとの最終記録時刻ではなく、ギャップの開始時刻を使う。
    // (チャンネルごとの最終記録時刻を使うと、停止後にライブで新しいメッセージを
    //  1件でも記録した時点で、その手前のギャップが二度と埋まらなくなる)
    let windowStart;
    if (isManual) {
      windowStart = manualSince;
    } else {
      const anchor = ingestionAnchorTs !== null ? ingestionAnchorTs : nowSec;
      windowStart = Math.max(anchor, nowSec - BACKFILL_MAX_LOOKBACK_SEC);
      if (anchor < nowSec - BACKFILL_MAX_LOOKBACK_SEC) {
        console.log(`${label} Gap exceeds ${BACKFILL_MAX_LOOKBACK_SEC / 3600}h. Backfilling the most recent ${BACKFILL_MAX_LOOKBACK_SEC / 3600}h only (use --backfill-from for the rest).`);
      }
    }
    // Slack の oldest は境界値を含む(inclusive)。取得済みメッセージの再取得を
    // 避けるため 1マイクロ秒ぶん進めて排他にする。
    const oldest = (windowStart + 0.000001).toFixed(6);

    const lastTsMap = getLastSlackTsPerChannel(sqliteDb);
    const channelIds = selectBackfillChannels(lastTsMap, nowSec);
    if (channelIds.length === 0) return;

    console.log(`${label} Backfilling messages for ${channelIds.length} channel(s) from ${moment(windowStart * 1000).format("YYYY-MM-DD HH:mm:ss")} in background...`);

    let totalFetched = 0;
    let processedChannels = 0;
    let earliestTs = null;
    let latestTs = null;
    const fetchedPerChannel = {};
    const inFlight = new Set();
    const deadlineAt = Date.now() + BACKFILL_TOTAL_TIMEOUT_MS;

    const processMessage = (message, channelId) => {
      if (message.subtype) {
        switch (message.subtype) {
        case "message_deleted":
        case "message_changed":
        case "message_replied":
        case "reply_broadcast":
          return;
        }
      }

      let text = util.parseText(message);
      if (text === "" && message.attachments && message.attachments.length > 0) {
        text = message.attachments[0].text || "";
      }

      let lines = typeof text === "string" ? text.split(/\r\n|\r|\n/) : [""];
      let fullLines = lines;
      if (lines.length > 8) {
        lines = lines.slice(0, 5);
        lines.push("--- snip ---");
      }

      if (options.user) {
        const messageUser = util.users[message.user] ? util.users[message.user].name : "-";
        if (options.user !== messageUser) return;
      }

      const data = {
        bufferKey: resolveChannelLabelKey(channelId),
        lines,
        fullLines,
        time: moment(parseFloat(message.ts) * 1000),
        channel: channelId,
        user: message.user,
        slackTs: message.ts || null,
        threadTs: message.thread_ts || null
      };

      util.addMessageBuffer(data);

      // バックフィル時は標準出力を省略し、ログへの書き込みのみ行う
      const plainDateFormat = data.time.format("YYYY-MM-DD HH:mm:ss");
      const plainChannel = resolveChannelLabelKey(channelId);
      const plainName = util.users[data.user]
        ? util.users[data.user].name
        : (typeof data.user === "string" ? data.user : "-");
      (data.fullLines || data.lines).forEach((line, lineNo) => {
        let l = emoji.emojify(line);
        l = util.replaceSlackId(l);
        l = util.decolateText(l);
        const plainLine = removeEscapeSequences(l);
        if (options.log) {
          logMessage(options.log, plainDateFormat, plainChannel, plainName, plainLine);
        }
        if (options.logSqlite && sqliteDb) {
          logMessageSqlite(sqliteDb, plainDateFormat, plainChannel, plainName, plainLine,
            channelId, data.user || null, data.slackTs, data.threadTs, lineNo);
        }
      });

      totalFetched++;
      fetchedPerChannel[channelId] = (fetchedPerChannel[channelId] || 0) + 1;

      const ts = parseFloat(message.ts);
      if (earliestTs === null || ts < earliestTs) earliestTs = ts;
      if (latestTs === null   || ts > latestTs)   latestTs   = ts;
    };

    // 進捗が動いているときだけ出力する。動いていない場合は、どのチャンネルで
    // 詰まっているかを明示する(同じ進捗を延々と出し続けても原因が分からないため)。
    let lastProgressKey = "";
    let lastProgressAt = Date.now();
    const printProgress = () => {
      const progressKey = `${processedChannels}/${totalFetched}`;
      if (progressKey !== lastProgressKey) {
        lastProgressKey = progressKey;
        lastProgressAt = Date.now();
        const pct = Math.round(processedChannels / channelIds.length * 100);
        console.log(
          `Backfill progress: ${processedChannels}/${channelIds.length} channels (${pct}%), ${totalFetched} messages fetched`
        );
      } else if (Date.now() - lastProgressAt > BACKFILL_STALL_WARN_MS) {
        lastProgressAt = Date.now();
        const stalled = Array.from(inFlight).map(resolveChannelLabelKey).join(", ") || "(none)";
        console.log(
          `Backfill stalled at ${processedChannels}/${channelIds.length} channels. Waiting on: ${stalled}`
        );
      }
    };

    const fetchChannel = async (channelId) => {
      const channelDeadlineAt = Math.min(Date.now() + BACKFILL_CHANNEL_TIMEOUT_MS, deadlineAt);
      const messages = [];
      let cursor = null;
      let pages = 0;

      for (;;) {
        const params = { channel: channelId, oldest: oldest, limit: 200 };
        if (cursor) params.cursor = cursor;

        const res = await withTimeout(
          web.conversations.history(params),
          BACKFILL_REQUEST_TIMEOUT_MS,
          `conversations.history timed out after ${BACKFILL_REQUEST_TIMEOUT_MS / 1000}s`
        );

        (res.messages || []).forEach((message) => messages.push(message));
        pages++;
        cursor = (res.has_more && res.response_metadata) ? res.response_metadata.next_cursor : null;
        if (!cursor) break;

        if (pages >= BACKFILL_CHANNEL_MAX_PAGES) {
          console.log(`Backfill truncated on ${resolveChannelLabelKey(channelId)}: page limit (${BACKFILL_CHANNEL_MAX_PAGES}) reached, ${messages.length} message(s) fetched.`);
          break;
        }
        if (Date.now() > channelDeadlineAt) {
          console.log(`Backfill timed out on ${resolveChannelLabelKey(channelId)}: ${messages.length} message(s) fetched, giving up on the rest.`);
          break;
        }
      }

      return messages;
    };

    // ワーカーキュー: 詰まったチャンネルが他チャンネルの処理を止めないようにする
    const handleChannel = async (channelId) => {
      inFlight.add(channelId);
      try {
        const messages = await fetchChannel(channelId);
        // 古い順に処理する
        messages.reverse().forEach((message) => processMessage(message, channelId));
      } finally {
        inFlight.delete(channelId);
        processedChannels++;
      }
    };

    const progressInterval = setInterval(printProgress, BACKFILL_PROGRESS_INTERVAL_MS);
    let result;
    try {
      result = await runWithWorkers(channelIds, handleChannel, {
        concurrency: BACKFILL_CONCURRENCY,
        deadlineAt: deadlineAt,
        // エラーを握りつぶすと原因(ratelimited / missing_scope / not_in_channel 等)が
        // 分からなくなるため、チャンネルラベル付きで出力する。
        onError: (err, channelId) => {
          console.log(`Backfill error on ${resolveChannelLabelKey(channelId)}: ${backfillErrorReason(err)}`);
        }
      });
    } finally {
      clearInterval(progressInterval);
    }

    const skipped = channelIds.length - processedChannels;
    if (skipped > 0 || result.abandoned) {
      console.log(`Backfill deadline (${BACKFILL_TOTAL_TIMEOUT_MS / 60000}m) reached: ${skipped} channel(s) were not processed.`);
    }

    if (totalFetched > 0) {
      const range = (earliestTs !== null && latestTs !== null)
        ? ` (${moment(earliestTs * 1000).format("YYYY-MM-DD HH:mm")} - ${moment(latestTs * 1000).format("YYYY-MM-DD HH:mm")})`
        : "";
      console.log(`Backfill complete: ${totalFetched} message(s) fetched${range}.`);
      Object.entries(fetchedPerChannel)
        .sort((a, b) => b[1] - a[1])
        .forEach(([chId, count]) => {
          console.log(`  ${resolveChannelLabelKey(chId)}: ${count} message(s)`);
        });
    } else {
      console.log("Backfill complete: no new messages.");
    }
  };

  const runBackfill = async (label, manualSince) => {
    if (!sqliteDb) return;

    if (isBackfilling) {
      // 実行中に来た要求は捨てずに保留する。捨てると、その間に起きた
      // スリープ復帰ぶんのギャップが埋まらないままになる。
      const since = (manualSince === undefined) ? null : manualSince;
      if (!pendingBackfill || (since !== null && (pendingBackfill.since === null || since < pendingBackfill.since))) {
        pendingBackfill = { label, since };
      }
      console.log(`${label} Backfill is already running. Queued to run after the current one finishes.`);
      return;
    }

    isBackfilling = true;
    try {
      await runBackfillOnce(label, manualSince);
    } catch (err) {
      // ここで必ず isBackfilling を戻す。戻し損ねると以降のバックフィルが
      // プロセスの生涯にわたって no-op になる。
      console.log(`${label} Backfill aborted: ${backfillErrorReason(err)}`);
    } finally {
      isBackfilling = false;
    }

    if (pendingBackfill) {
      const next = pendingBackfill;
      pendingBackfill = null;
      await runBackfill(next.label, next.since === null ? undefined : next.since);
    }
  };

  // 手動バックフィル: --backfill-from が指定された場合は強制実行
  if (forceSince !== null) {
    if (!sqliteDb) {
      console.error("Error: --backfill-from requires --log-sqlite");
      process.exit(1);
    }
    runBackfill("[Manual]", forceSince).catch(() => {});
  } else if (sqliteDb && backfillGapSeconds !== null && backfillGapSeconds > BACKFILL_GAP_THRESHOLD) {
    // 起動時差分バックフィル: 前回の取り込みからのギャップが閾値を超えた場合のみ実行
    console.log(`[Startup] Detected a ${Math.round(backfillGapSeconds / 60)} minute ingestion gap.`);
    runBackfill("[Startup]").catch(() => {});
  }

  // レジューム検出: タイマードリフトでスリープからの復帰を検知し、5分以上経過していればバックフィル発動
  if (sqliteDb) {
    const SLEEP_DETECT_INTERVAL_MS = 30 * 1000;
    const RESUME_THRESHOLD_MS = BACKFILL_GAP_THRESHOLD * 1000;
    let lastSleepCheckAt = Date.now();

    setInterval(() => {
      const now = Date.now();
      const elapsed = now - lastSleepCheckAt;
      lastSleepCheckAt = now;

      if (elapsed > RESUME_THRESHOLD_MS) {
        ingestionAnchorTs = (now - elapsed) / 1000;
        console.log("System resume detected. Running backfill...");
        runBackfill("[Resume]").catch(() => {});
      }
    }, SLEEP_DETECT_INTERVAL_MS);
  }

  // 自分宛メンション観測ペイン(--mention-pane)の有効化
  if (mentionPaneLines) {
    mentionPane = createMentionPane({
      height: mentionPaneLines,
      stdout: process.stdout,
      util: util
    });
    mentionPane.enable(rli);

    process.on("SIGINT", () => {
      mentionPane.disable();
      process.exit(130);
    });
    process.on("exit", () => {
      mentionPane.disable();
    });
  }

  // complete
  rtm.start();
};

// "#" 入力時のチャンネル名 Tab 補完
let channelCompleter = (line) => {
  // "#" で始まる入力のみ補完対象
  if (line.charAt(0) !== "#") {
    return [[], line];
  }

  let prefix = line.slice(1).toLowerCase();
  let names = [];

  Object.keys(util.channels).forEach((id) => {
    let ch = util.channels[id];
    if (ch.is_im) {
      return; // DM は対象外
    }
    let name = resolveChannelName(id);
    if (name) {
      names.push("#" + name);
    }
  });

  // MCP(post_to_stream)由来など、Slack外から注入されたチャンネルラベルも候補に含める。
  // これらは util.channels には存在せず、バッファキー("#claude"等)としてのみ現れる。
  Object.keys(util.buffer || {}).forEach((key) => {
    if (key.charAt(0) === "#") {
      names.push(key);
    }
  });

  // 今セッションでまだ受信していない、過去の注入チャンネルも SQLite から候補に含める
  injectedChannelLabels.forEach((label) => {
    if (label && label.charAt(0) === "#") {
      names.push(label);
    }
  });

  names = Array.from(new Set(names)).sort();

  let hits = names.filter((n) => n.toLowerCase().indexOf("#" + prefix) === 0);

  return [hits.length ? hits : names, line];
};

// 指定チャンネルの直近ログを再表示する。SQLite を優先し、無効時はメモリバッファにフォールバック。
core.showRecent = (labelKey, channelId, limit) => {
  let label = {
    lines: [`--- Show recent (${labelKey}) ---`],
    time: moment()
  };
  core.display(label);

  let shown = false;

  // Slackチャンネルは解決済みID、MCP等の注入チャンネルは labelKey("#claude") が
  // そのまま channel_id として記録されているため、未解決時は labelKey で引く。
  let queryChannelId = channelId || labelKey;

  if (sqliteDb && queryChannelId) {
    try {
      let rows = sqliteDb.prepare(`
        SELECT logged_at, channel, user, message
        FROM messages
        WHERE channel_id = ?
        ORDER BY id DESC
        LIMIT ?
      `).all(queryChannelId, limit);

      rows.reverse().forEach((row) => {
        core.display({
          lines: [row.message || ""],
          time: moment(row.logged_at, "YYYY-MM-DD HH:mm:ss"),
          channel: row.channel,
          user: row.user
        });
      });

      shown = rows.length > 0;
    } catch (e) {
      // SQLite 取得に失敗した場合はメモリバッファへフォールバック
    }
  }

  if (!shown && util.buffer[labelKey]) {
    util.buffer[labelKey].forEach((data) => {
      core.display(data);
    });
    shown = true;
  }

  label.lines = shown ? ["--- finish ---"] : ["(ログがありません)"];
  core.display(label);
};

// Declare cli-handler
function handler() {}

handler.prototype.channelRecent = function(line, fn) {
  // line 例: "#general" または "#general 50" (件数指定)
  let parts = line.split(/\s+/);
  let labelKey = parts[0];           // "#general"
  let limit = parseInt(parts[1], 10);
  if (isNaN(limit) || limit <= 0) {
    limit = 20;
  }

  let name = labelKey.slice(1);      // "general"
  let channelId = null;

  if (name.length > 0) {
    Object.keys(util.channels).forEach((id) => {
      if (channelId === null && resolveChannelName(id) === name) {
        channelId = id;
      }
    });
  }

  core.showRecent(labelKey, channelId, limit);
  fn(null, line);
};

handler.prototype.recent = function(args, fn) {
  if (util.buffer[args[0]]) {
    let messageBuffer = util.buffer[args[0]];

    let label = {
      lines: [`--- Show buffer (#${args[0]}) ---`],
      time: moment()
    };

    core.display(label);

    messageBuffer.forEach((data) => {
      core.display(data);
    });

    label.lines = ["--- finish ---"];
    core.display(label);

  }

  fn(null, args);
};

handler.prototype.echo = function(args, fn) {
  fn(null, args);
};

handler.prototype.exit = function(args, fn) {
  fn(null, args);
  this.emit("close");
};

rli = (new cli(new handler(), { completer: channelCompleter })).run();

module.exports = core;
