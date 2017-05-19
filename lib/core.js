let moment = require("moment");
let sprintf = require("sprintf-js").sprintf;
let chalk = require("chalk");
let emoji = require("node-emoji");
let winston = require("winston");

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

core.start = (commander) => {
  let logger;

  if (commander.debug) {
    logger = getLogger(commander.debug);
  }

  let token = commander.token;
  let slack = require("@slack/client");
  let RtmClient = slack.RtmClient;

  let RTM_EVENTS = slack.RTM_EVENTS;
  let CLIENT_EVENTS = slack.CLIENT_EVENTS;

  let rtm = new RtmClient(token);
  let channels = {};
  let users = {};
  let bots = {};
  let colors = ["red", "green", "yellow", "blue", "magenta", "cyan", "white"];

  rtm.start();

  rtm.on(CLIENT_EVENTS.RTM.AUTHENTICATED, (rtmStartData) => {
    console.log(
      `Logged in as ${rtmStartData.self.name} of team ${rtmStartData.team.name}, but not yet connected to a channel`
    );

    rtmStartData.users.forEach((v, i) => {
      v.color = colors[i % colors.length];
      users[v.id] = v;
    });

    rtmStartData.channels.forEach((v, i) => {
      v.color = colors[i % colors.length];
      channels[v.id] = v;
    });

    rtmStartData.bots.forEach((v, i) => {
      v.color = colors[i % colors.length];
      bots[v.id] = v;
    });
  });

  rtm.on(RTM_EVENTS.MESSAGE, (message) => {
    let name = (users[message.user]) ? chalk[users[message.user].color](users[message.user].name) : chalk.white("-");
    let channel = (channels[message.channel]) ? "#" + chalk[channels[message.channel].color](channels[message.channel].name) : chalk.white("-");
    let time = moment(message.ts * 1000);
    let text = message.text;

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
      case "reply_broadcast":
        return;
      case "file_comment":
        break;
      case "bot_message":
        name = (bots[message.bot_id]) ? chalk[bots[message.bot_id].color](bots[message.bot_id].name) : "[BOT]";
        break;
      case "pinned_item":
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
    }

    lines.forEach((line) => {
      let l =  emoji.emojify(line);

      console.log(
        "%s | %s | %s | %s",
        time.format("YYYY-MM-DD HH:mm:ss"),
        sprintf("%30s", channel),
        sprintf("%28s", name),
        l
      );

      name = chalk.white("|>");
    });
  });
};

module.exports = core;
