let moment = require("moment");
let sprintf = require("sprintf-js").sprintf;
let chalk = require("chalk");
let emoji = require("node-emoji");
let winston = require("winston");
let util = require("./utility.js");
let cli = require("./cli.js");

const path = require("path");
const fs = require("fs");
const exec = require("child_process").exec;
const { initSqliteDb, logMessageSqlite, getLastSlackTsPerChannel, updateAppHeartbeat, getLastAppHeartbeat, getInjectedChannelLabels } = require("./sqlite-logger");
const { startMcpServer } = require("./mcp-server");

let sqliteDb = null;
// 起動時に SQLite から読み込む、MCP等の注入チャンネルラベル一覧(Tab補完候補用)
let injectedChannelLabels = [];

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

let resolveChannelName = (channelId) => {
  let channel = util.channels[channelId];

  if (!channel) {
    return null;
  }

  if (channel.is_im && channel.user) {
    let dmUser = util.users[channel.user];
    return (dmUser && dmUser.name) ? dmUser.name : channel.user;
  }

  if (channel.name) {
    return channel.name;
  }

  return channelId;
};

let resolveChannelLabelDisplay = (channelId) => {
  let channel = util.channels[channelId];

  if (!channel) {
    return chalk.white(channelId || "-");
  }

  let name = resolveChannelName(channelId);

  if (channel.is_im && channel.user) {
    return "@" + chalk[channel.color](name);
  }

  if (channel.name) {
    const prefix = channel.is_private ? "🔐#" : "#";
    return prefix + chalk[channel.color](name);
  }

  return chalk.white(name || "-");
};

let resolveChannelLabelKey = (channelId) => {
  let channel = util.channels[channelId];

  if (!channel) {
    return "-";
  }

  let name = resolveChannelName(channelId);

  if (channel.is_im && channel.user) {
    return "@" + name;
  }

  if (channel.name) {
    return "#" + name;
  }

  return name || "-";
};

core.display = (data, options)  => {
  let name, channel;

  if (data.synthetic) {
    // Claude(AI)など、Slack外のソースから注入されたメッセージ。
    // data.channel / data.user は Slack ID ではなく任意のラベル文字列なので
    // util.users / resolveChannelLabelDisplay による ID 解決はバイパスする。
    name = chalk.cyan(typeof data.user == "string" ? data.user : "-");
    channel = chalk.cyan(typeof data.channel == "string" ? data.channel : "-");
  } else {
    if (util.users[data.user]) {
      name = chalk[util.users[data.user].color](util.users[data.user].name);
    } else if (typeof data.user == "string") {
      name = chalk.white(data.user);
    } else {
      name = chalk.white("-");
    }

    if (typeof data.channel == "string") {
      channel = resolveChannelLabelDisplay(data.channel);
    } else {
      channel = chalk.white("-");
    }
  }

  data.lines.forEach((line) => {
    let l;

    l = emoji.emojify(line);
    l = util.replaceSlackId(l);
    l = util.decolateText(l);

    let dateFormat = data.time.format("YYYY-MM-DD HH:mm:ss");

    if (util.theme.date) {
      dateFormat = chalk[util.theme.date](dateFormat);
    }

    console.log(
      "%s | %s | %s | %s",
      dateFormat,
      sprintf("%30s", channel),
      sprintf("%28s", name),
      l
    );

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

    (data.fullLines || data.lines).forEach((line) => {
      let l = emoji.emojify(line);
      l = util.replaceSlackId(l);
      l = util.decolateText(l);
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
          data.threadTs || null
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
  let lastHeartbeatTs = null; // 前回ハートビートのUnixタイムスタンプ(秒)

  let forceSince = null; // --backfill-from で指定された開始時刻(Unixタイムスタンプ秒)
  if (options.backfillFrom) {
    const parsed = moment(options.backfillFrom, ["YYYY-MM-DD HH:mm", "YYYY-MM-DD"], true);
    if (!parsed.isValid()) {
      console.error(`Error: --backfill-from の日時形式が不正です: "${options.backfillFrom}" (例: "2026-05-28" または "2026-05-28 09:00")`);
      process.exit(1);
    }
    forceSince = parsed.unix();
  }

  if (options.logSqlite) {
    sqliteDb = initSqliteDb(options.logSqlite);
    const lastHeartbeat = getLastAppHeartbeat(sqliteDb);
    if (lastHeartbeat !== null) {
      lastHeartbeatTs = lastHeartbeat;
      backfillGapSeconds = Date.now() / 1000 - lastHeartbeat;
    }
    updateAppHeartbeat(sqliteDb);
    setInterval(() => updateAppHeartbeat(sqliteDb), 60 * 1000);

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
    if (isReconnecting) {
      console.log("RTM reconnected successfully");
      isReconnecting = false;
    }

    if (!util.startUp) {
      console.log(
        `Logged in as ${chalk.bold(rtmStartData.self.name)} of team ${chalk.green.bold(rtmStartData.team.name)}, but not yet connected to a channel`
      );
      util.startUp = true;
    }
  });

  rtm.on("unable_to_rtm_start", (error) => {
    console.error("Unable to start RTM:", error.message || error);
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
  const {WebClient} = require("@slack/client");
  const web = new WebClient(token, {logLevel: "error"});

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

  await refreshSlackData();
  setInterval(refreshSlackData, refreshIntervalMinutes * 60 * 1000);

  let isBackfilling = false;

  const runBackfill = async (label, manualSince) => {
    if (isBackfilling || !sqliteDb) return;
    isBackfilling = true;
    try {
      const lastTsMap = getLastSlackTsPerChannel(sqliteDb);

      let channelIds;
      if (manualSince !== undefined && manualSince !== null) {
        // 手動バックフィル: カットオフフィルターをスキップして全チャンネルを対象にする
        channelIds = Object.keys(lastTsMap);
      } else {
        // 前回ハートビート時刻を基準に24時間前をカットオフとする。
        // 固定の「現在-24h」にすると停止期間が24h超の場合に全チャンネルが除外されるため。
        const anchor = lastHeartbeatTs !== null ? lastHeartbeatTs : Date.now() / 1000;
        const cutoff = anchor - 24 * 3600;
        channelIds = Object.keys(lastTsMap).filter(id => parseFloat(lastTsMap[id]) > cutoff);
      }

      if (channelIds.length === 0) return;

      const sinceLabel = manualSince !== undefined && manualSince !== null
        ? ` from ${moment(manualSince * 1000).format("YYYY-MM-DD HH:mm")}`
        : "";
      process.stdout.write(`${label} Backfilling messages for ${channelIds.length} channel(s)${sinceLabel} in background...\n`);
      let totalFetched = 0;
      let processedChannels = 0;
      let earliestTs = null;
      let latestTs = null;
      const fetchedPerChannel = {};
      const CONCURRENCY = 5;

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
        (data.fullLines || data.lines).forEach((line) => {
          let l = emoji.emojify(line);
          l = util.replaceSlackId(l);
          l = util.decolateText(l);
          const plainLine = removeEscapeSequences(l);
          if (options.log) {
            logMessage(options.log, plainDateFormat, plainChannel, plainName, plainLine);
          }
          if (options.logSqlite && sqliteDb) {
            logMessageSqlite(sqliteDb, plainDateFormat, plainChannel, plainName, plainLine,
              channelId, data.user || null, data.slackTs, data.threadTs);
          }
        });

        totalFetched++;
        fetchedPerChannel[channelId] = (fetchedPerChannel[channelId] || 0) + 1;

        const ts = parseFloat(message.ts);
        if (earliestTs === null || ts < earliestTs) earliestTs = ts;
        if (latestTs === null   || ts > latestTs)   latestTs   = ts;
      };

      const printProgress = () => {
        const pct = Math.round(processedChannels / channelIds.length * 100);
        process.stdout.write(
          `Backfill progress: ${processedChannels}/${channelIds.length} channels (${pct}%), ${totalFetched} messages fetched\n`
        );
      };

      const fetchChannel = async (channelId) => {
        const dbLastTs = lastTsMap[channelId];
        // 手動指定時: max(manualSince, dbLastTs) で重複挿入を防ぐ
        const oldest = (manualSince !== undefined && manualSince !== null)
          ? (dbLastTs && parseFloat(dbLastTs) > manualSince ? dbLastTs : String(manualSince))
          : dbLastTs;
        let cursor;
        let channelMessages = [];

        try {
          do {
            const params = { channel: channelId, oldest, limit: 200 };
            if (cursor) params.cursor = cursor;
            const res = await web.conversations.history(params);
            channelMessages = channelMessages.concat(res.messages || []);
            cursor = res.has_more ? res.response_metadata.next_cursor : null;
          } while (cursor);
        } catch (err) {
          return;
        }

        // 古い順に並べ替えて表示
        channelMessages.reverse().forEach(msg => processMessage(msg, channelId));
        processedChannels++;
      };

      const progressInterval = setInterval(printProgress, 30 * 1000);

      for (let i = 0; i < channelIds.length; i += CONCURRENCY) {
        await Promise.all(channelIds.slice(i, i + CONCURRENCY).map(fetchChannel));
        printProgress();
      }

      clearInterval(progressInterval);
      if (totalFetched > 0) {
        process.stdout.write(`Backfill complete: ${totalFetched} message(s) fetched.\n`);
        Object.entries(fetchedPerChannel)
          .sort((a, b) => b[1] - a[1])
          .forEach(([chId, count]) => {
            process.stdout.write(`  ${resolveChannelLabelKey(chId)}: ${count} message(s)\n`);
          });
      } else {
        process.stdout.write("Backfill complete: no new messages.\n");
      }
    } finally {
      isBackfilling = false;
    }
  };

  // 手動バックフィル: --backfill-from が指定された場合は強制実行
  if (sqliteDb && forceSince !== null) {
    if (!options.logSqlite) {
      console.error("Error: --backfill-from requires --log-sqlite");
      process.exit(1);
    }
    runBackfill("[Manual]", forceSince).catch(() => {});
  } else if (sqliteDb && backfillGapSeconds !== null && backfillGapSeconds > BACKFILL_GAP_THRESHOLD) {
    // 起動時差分バックフィル: 前回停止からのギャップが閾値を超えた場合のみ実行
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
        lastHeartbeatTs = (now - elapsed) / 1000;
        process.stdout.write("System resume detected. Running backfill...\n");
        runBackfill("[Resume]").catch(() => {});
      }
    }, SLEEP_DETECT_INTERVAL_MS);
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

(new cli(new handler(), { completer: channelCompleter })).run();

module.exports = core;
