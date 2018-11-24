let moment = require("moment");
let sprintf = require("sprintf-js").sprintf;
let chalk = require("chalk");
let emoji = require("node-emoji");
let winston = require("winston");
let util = require("./utility.js");
let cli = require("./cli.js");

const exec = require("child_process").exec;

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

core.display = (data)  => {
  let name = (util.users[data.user]) ? chalk[util.users[data.user].color](util.users[data.user].name) : chalk.white("-");
  let channel = (util.channels[data.channel]) ? "#" + chalk[util.channels[data.channel].color](util.channels[data.channel].name) : chalk.white("-");

  data.lines.forEach((line) => {
    let l;

    l = emoji.emojify(line);
    l = util.replaceSlackId(l);
    l = util.decolateText(l);

    console.log(
      "%s | %s | %s | %s",
      data.time.format("YYYY-MM-DD HH:mm:ss"),
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

  const {RTMClient} = require("@slack/client");
  const rtm = new RTMClient(token, {logLevel: "error"});

  let colors = ["red", "green", "yellow", "blue", "magenta", "cyan", "white", "redBright", "greenBright", "yellowBright", "blueBright", "magentaBright", "cyanBright", "whiteBright"];

  util.channels = {};
  util.users = {};
  util.bots = {};
  util.startUp = false;


  rtm.on("authenticated", (rtmStartData) => {
    if (!util.startUp) {
      console.log(
        `Logged in as ${chalk.bold(rtmStartData.self.name)} of team ${chalk.green.bold(rtmStartData.team.name)}, but not yet connected to a channel`
      );

      util.startUp = true;
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
        if (commander.debug) {
          logger.error(message);
        }
        return;
      }
    }

    if (text == "") {
      if (message.hasOwnProperty("attachments")) {
        text = message.attachments[0].text;
      } else {
        text = "";
      }
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

    // Display only specific users. (-u option)
    if (commander.user) {
      let messageUser = util.users[message.user].name;
      if (commander.user != messageUser) {
        return;
      }
    }

    // buffering
    let data = {
      bufferKey: (util.channels[message.channel]) ? "#" + util.channels[message.channel].name : "-",
      lines: lines,
      time: time,
      channel: message.channel,
      user: message.user
    };

    util.addMessageBuffer(data);
    core.display(data);

    // hook
    if (commander.hook) {
      if (util.hook) {
        exec(util.hook, (err) => {
          if (err) {
            console.log(err);
          }
        });
      }
    }
  });

  // Setup
  const {WebClient} = require("@slack/client");
  const web = new WebClient(token, {logLevel: "error"});

  web.users.list().then((response) => {
    response.members.forEach((v, i) => {
      v.color = colors[i % colors.length];
      util.users[v.id] = v;
    });

    return web.channels.list();
  }).then((response) => {
    response.channels.forEach((v, i) => {
      v.color = colors[i % colors.length];
      util.channels[v.id] = v;
    });

    // [pending] bots list
    //return web.bots.info();
  }).then(() => {
    // complete 
    rtm.start();
  }).catch((error) => {
    console.log(error);
  });
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
