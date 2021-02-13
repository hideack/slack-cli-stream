let utility = {};

let chalk = require("chalk");
let nconf = require("nconf");
let yaml = require("js-yaml");
let cronParser = require("cron-parser");
let moment = require("moment");

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
  utility.twitter = {};
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

  if (response == "") {
    if (Object.prototype.hasOwnProperty.call(message, "attachments")) {
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

    if (typeof hook.keyword === "undefined" || hook.keyword == message.text) {
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

  utility.twitter = false;
  if (settings.twitter) {
    if (settings.twitter.consumer_key && settings.twitter.consumer_secret && settings.twitter.access_token_key && settings.twitter.access_token_secret) {
      utility.twitter = settings.twitter;
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
