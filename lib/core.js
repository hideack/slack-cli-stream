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
const { initSqliteDb, logMessageSqlite } = require("./sqlite-logger");
const { startMcpServer } = require("./mcp-server");

let sqliteDb = null;

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

  if (util.users[data.user]) {
    name = chalk[util.users[data.user].color](util.users[data.user].name);
  } else {
    if (typeof data.user == "string") {
      name = chalk.white(data.user);
    } else {
      name = chalk.white("-");
    }
  }

  if (typeof data.channel == "string") {
    channel = resolveChannelLabelDisplay(data.channel);
  } else {
    channel = chalk.white("-");
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

  if (options.logSqlite) {
    sqliteDb = initSqliteDb(options.logSqlite);
  }

  const mcpPort = options.mcpPort
    ? parseInt(options.mcpPort, 10)
    : (util.mcp && util.mcp.port ? util.mcp.port : null);

  if (mcpPort) {
    startMcpServer({ port: mcpPort, sqliteDb, util });
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

  // complete 
  rtm.start();
};

// Declare cli-handler
function handler() {}

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

(new cli(new handler())).run(); 

module.exports = core;
