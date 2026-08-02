let utility = {};

let chalk = require("chalk");
let nconf = require("nconf");
let yaml = require("js-yaml");
let cronParser = require("cron-parser");
let moment = require("moment");
let sprintf = require("sprintf-js").sprintf;
let emoji = require("node-emoji");

let initialize = () => {
  utility.users = {};
  utility.channels = {};
  utility.bots = {};
  utility.keywords = [];
  utility.token = "";
  utility.hook = "";
  utility.hooks = [];
  utility.buffer = {};
  utility.theme = {};
  utility.logging = {};
  utility.mcp = {};
  utility.selfUserId = null;
  utility.usergroupMemberIds = new Set();
};

initialize();

utility.replaceSlackId = (line) => {
  let res = line;

  try {
    let matchIds = line.match(/<[^>]*>/g).map((s) => s.substring(2, s.length-1));

    for(let i=0; i<matchIds.length; i++) {
      if (utility.users[matchIds[i]]) {
        res = res.replace("<@" + matchIds[i] + ">", "@" + utility.users[matchIds[i]].name);
      }
    }
  } catch(e) {
    // no operation
  }

  return res;
};

utility.parseText = (message) => {
  let response = "";

  if (Object.prototype.hasOwnProperty.call(message, "text")) {
    response = message.text;
  }

  if (response == "" && Object.prototype.hasOwnProperty.call(message, "attachments")) {
    if (Array.isArray(message.attachments) && message.attachments.length > 0) {
      if (Object.prototype.hasOwnProperty.call(message.attachments[0], "text")) {
        response = message.attachments[0].text;
      } else if (Object.prototype.hasOwnProperty.call(message.attachments[0], "pretext")) {
        response = message.attachments[0].pretext;
      }
    }
  }

  return response;
};

utility.hasHooks = (message) => {
  let returnHooks = [];

  for(let i=0; i<utility.hooks.length; i++) {
    let hook = utility.hooks[i];

    const keywordMatch = typeof hook.keyword === "undefined" || hook.keyword == message.text;
    const prefixMatch = typeof hook.prefix === "undefined" || (typeof message.text === "string" && message.text.startsWith(hook.prefix));
    if (keywordMatch && prefixMatch) {
      if (!utility.users[message.user]) continue;

      if (hook.user) {
        if (hook.user != utility.users[message.user].name) {
          continue;
        }
      }

      if (hook.channel) {
        if (!utility.channels[message.channel]) continue;

        if (hook.channel != utility.channels[message.channel].name) {
          continue;
        }
      }

      if (hook.interval) {
        let messageTime = moment(message.ts * 1000);

        if (messageTime.isBefore(hook.interval._date)) {
          continue;
        } else {
          utility.hooks[i].interval = utility.hooks[i].parsedCron.next();
        }
      }

      returnHooks.push(hook.hook);
    }
  }

  return returnHooks;
};

utility.parseSettingFile = (path) => {
  nconf.use(
    "file",
    {
      file: path,
      format: {
        parse: yaml.load,
        stringify: yaml.safeDump
      }
    }
  );

  let settings = nconf.load();

  if (settings.keywords) {
    utility.keywords = settings.keywords;
  }

  if (settings.token) {
    utility.token = settings.token;
  }

  if (settings.hook) {
    utility.hook = settings.hook;
  }

  if (settings.hooks) {
    utility.hooks = [];

    for (let i=0; i<settings.hooks.length; i++) {
      let readHook = settings.hooks[i];

      // cron setting parse
      if (readHook.cron) {
        readHook.parsedCron = cronParser.parseExpression(readHook.cron);
        readHook.interval = readHook.parsedCron.next();
      }

      if (readHook.hook) {
        utility.hooks.push(readHook);
      }
    }
  }

  if (settings.theme) {
    if (settings.theme.text) {
      utility.theme.text = settings.theme.text;
    }

    if (settings.theme.date) {
      utility.theme.date = settings.theme.date;
    }
  }

  utility.logging = {};
  if (settings.logging) {
    if (settings.logging.file) {
      utility.logging.file = settings.logging.file;
    }
    if (settings.logging.sqlite) {
      utility.logging.sqlite = settings.logging.sqlite;
    }
  }

  utility.mcp = {};
  if (settings.mcp) {
    if (settings.mcp.port) {
      utility.mcp.port = settings.mcp.port;
    }
  }
};

utility.decolateText = (message) => {
  let response = message;

  // default text.scheme
  if (utility.theme.text) {
    response = chalk[utility.theme.text](message);
  }

  // Bold
  let boldTexts = response.match(/\*(.+?)\*/g);

  if (boldTexts) {
    for (let i=0; i<boldTexts.length; i++) {
      let text = boldTexts[i];
      response = response.replace(boldTexts[i], chalk.bold(text.substring(1, text.length-1)));
    }
  }

  // quote (>)
  if (response.substring(0,4) == "&gt;") {
    response = ">" + chalk.italic(response.substring(4));
  }

  // keywords
  for (let i=0; i<utility.keywords.length; i++) {
    response = response.replace(utility.keywords[i], chalk.red.bold(utility.keywords[i]));
  }

  return response;
};

// core.display() とペイン(lib/mention-pane.js)の双方が同じ表示フォーマットに
// なるよう、チャンネル/ユーザー名解決と1行分の整形ロジックをここに集約する。

utility.resolveChannelName = (channelId) => {
  let channel = utility.channels[channelId];

  if (!channel) {
    return null;
  }

  if (channel.is_im && channel.user) {
    let dmUser = utility.users[channel.user];
    return (dmUser && dmUser.name) ? dmUser.name : channel.user;
  }

  if (channel.name) {
    return channel.name;
  }

  return channelId;
};

utility.resolveChannelLabelDisplay = (channelId) => {
  let channel = utility.channels[channelId];

  if (!channel) {
    return chalk.white(channelId || "-");
  }

  let name = utility.resolveChannelName(channelId);

  if (channel.is_im && channel.user) {
    return "@" + chalk[channel.color](name);
  }

  if (channel.name) {
    const prefix = channel.is_private ? "🔐#" : "#";
    return prefix + chalk[channel.color](name);
  }

  return chalk.white(name || "-");
};

utility.resolveChannelLabelKey = (channelId) => {
  let channel = utility.channels[channelId];

  if (!channel) {
    return "-";
  }

  let name = utility.resolveChannelName(channelId);

  if (channel.is_im && channel.user) {
    return "@" + name;
  }

  if (channel.name) {
    return "#" + name;
  }

  return name || "-";
};

// メッセージの表示用チャンネルラベル・ユーザー名を解決する。
// data.synthetic (MCP等からの注入メッセージ)の場合は ID 解決をバイパスする。
utility.resolveDisplayIdentity = (data) => {
  let name, channel;

  if (data.synthetic) {
    let channelLabel = typeof data.channel == "string" ? data.channel : "-";
    name = chalk.cyan(typeof data.user == "string" ? data.user : "-");
    channel = chalk.cyan("[MCP] " + channelLabel);
  } else {
    if (utility.users[data.user]) {
      name = chalk[utility.users[data.user].color](utility.users[data.user].name);
    } else if (typeof data.user == "string") {
      name = chalk.white(data.user);
    } else {
      name = chalk.white("-");
    }

    if (typeof data.channel == "string") {
      channel = utility.resolveChannelLabelDisplay(data.channel);
    } else {
      channel = chalk.white("-");
    }
  }

  return { name, channel };
};

// 絵文字化・Slack ID置換・装飾(太字/引用/キーワード強調)を1行分適用する。
utility.decorateLine = (line) => {
  let l = emoji.emojify(line);
  l = utility.replaceSlackId(l);
  l = utility.decolateText(l);
  return l;
};

// 日付部分の整形(テーマ色指定時は着色する)。
utility.formatDisplayDate = (time) => {
  let dateFormat = time.format("YYYY-MM-DD HH:mm:ss");

  if (utility.theme.date) {
    dateFormat = chalk[utility.theme.date](dateFormat);
  }

  return dateFormat;
};

// "日付 | チャンネル | ユーザー | メッセージ" の1行分の表示フォーマット。
utility.formatDisplayLine = (dateFormat, channel, name, line) => {
  return sprintf("%s | %s | %s | %s", dateFormat, sprintf("%30s", channel), sprintf("%28s", name), line);
};

utility.addMessageBuffer = (data) => {
  if (utility.buffer[data.bufferKey]) {
    utility.buffer[data.bufferKey].push(data);

    if (utility.buffer[data.bufferKey].length > 20) {
      utility.buffer[data.bufferKey].shift();
    }

  } else {
    utility.buffer[data.bufferKey] = require("fifo")();
    utility.buffer[data.bufferKey].push(data);
  }
};


module.exports = utility;
