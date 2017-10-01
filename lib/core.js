let moment = require("moment");
let sprintf = require("sprintf-js").sprintf;
let chalk = require("chalk");
let emoji = require("node-emoji");
let winston = require("winston");
let util = require("./utility.js");
let cli = require("./cli.js");

let getLogger = (path) => {
  let settings = {
    transports: [
      new winston.transports.File({ filename: path, json: true})
    ],
    exceptionHandlers: [
      new winston.transports.File({ filename: path, json: true})
    ]
  };

  return new (winston.Logger)(settings);
};

let core = {};

core.display = (lines, time, channel, name)  => {
  lines.forEach((line) => {
    let l;
    l = emoji.emojify(line);
    l = util.replaceSlackId(l);
    l = util.decolateText(l);

    console.log(
      "%s | %s | %s | %s",
      time.format("YYYY-MM-DD HH:mm:ss"),
      sprintf("%30s", channel),
      sprintf("%28s", name),
      l
    );

    name = chalk.white("|>");
  });
};

core.start = (commander) => {
  let logger;
  let token = commander.token;

  if (commander.debug) {
    logger = getLogger(commander.debug);
  }

  if (commander.settings) {
    util.parseSettingFile(commander.settings);

    if (util.token) {
      token = util.token;
    }
  }

  let slack = require("@slack/client");
  let RtmClient = slack.RtmClient;

  let RTM_EVENTS = slack.RTM_EVENTS;
  let CLIENT_EVENTS = slack.CLIENT_EVENTS;

  let rtm = new RtmClient(token);

  util.channels = {};
  util.users = {};
  util.bots = {};

  let colors = ["red", "green", "yellow", "blue", "magenta", "cyan", "white", "redBright", "greenBright", "yellowBright", "blueBright", "magentaBright", "cyanBright", "whiteBright"];

  rtm.start();

  rtm.on(CLIENT_EVENTS.RTM.AUTHENTICATED, (rtmStartData) => {
    console.log(
      `Logged in as ${chalk.bold(rtmStartData.self.name)} of team ${chalk.green.bold(rtmStartData.team.name)}, but not yet connected to a channel`
    );

    rtmStartData.users.forEach((v, i) => {
      v.color = colors[i % colors.length];
      util.users[v.id] = v;
    });
    console.log(`Update ${rtmStartData.users.length} users information...`);

    rtmStartData.channels.forEach((v, i) => {
      v.color = colors[i % colors.length];
      util.channels[v.id] = v;
    });
    console.log(`Update ${rtmStartData.channels.length} channels information...`);

    rtmStartData.bots.forEach((v, i) => {
      v.color = colors[i % colors.length];
      util.bots[v.id] = v;
    });
    console.log(`Update ${rtmStartData.bots.length} bots information...`);

    console.log(`Activate ${chalk.bold(util.keywords.length)} keywords.`);
  });

  rtm.on(RTM_EVENTS.MESSAGE, (message) => {
    let name = (util.users[message.user]) ? chalk[util.users[message.user].color](util.users[message.user].name) : chalk.white("-");
    let channel = (util.channels[message.channel]) ? "#" + chalk[util.channels[message.channel].color](util.channels[message.channel].name) : chalk.white("-");
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
        name = (util.bots[message.bot_id]) ? chalk[util.bots[message.bot_id].color](util.bots[message.bot_id].name) : "[BOT]";
        break;
      case "pinned_item":
        break;
      case "slackbot_response":
        break;
      case "file_mention":
        break;
      default:
        if (commander.debug) {
          logger.error(message);
        }
        return;
      }
    }

    if (text == "") {
      text = message.attachments[0].text;
    }

    let lines;

    if (typeof(text) == "string") {
      lines = text.split(/\r\n|\r|\n/);
    } else {
      lines = [""];

      if (commander.debug) {
        logger.error(message);
      }
    }

    if (lines.length > 8) {
      lines = lines.slice(0, 5);
      lines.push("--- snip ---");
    }

    // buffering
    let data = {
      lines: lines,
      time: time,
      ch: "#" + util.channels[message.channel].name,
      name: util.users[message.user].name
    };

    util.addMessageBuffer(data);
    core.display(lines, time, channel, name);
  });
};

// Declare cli-handler
function handler() {}

handler.prototype.recent = function(args, fn) {
  console.log(args[0]);
  console.log(buffer[args[0]]);
  fn(null, args);
};

handler.prototype.echo = function(args, fn) {
  fn(null, args);
};

handler.prototype.exit = function(args, fn) {
  console.log('bye!');
  this.emit('close');
};

(new cli(new handler())).run(); 

module.exports = core;
