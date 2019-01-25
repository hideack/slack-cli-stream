let utility = {};

let chalk = require("chalk");
let nconf = require("nconf");
let yaml = require("js-yaml");

utility.users = {};
utility.channels = {};
utility.bots = {};
utility.keywords = [];
utility.token = "";
utility.hook = "";
utility.hooks = [];
utility.buffer = {};

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

  if (message.hasOwnProperty("text")) {
    response = message.text;
  }

  if (response == "") {
    if (message.hasOwnProperty("attachments")) {
      if (message.attachments[0].hasOwnProperty("text")) {
        response = message.attachments[0].text;
      } else if (message.attachments[0].hasOwnProperty("pretext")) {
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
        parse: yaml.safeLoad,
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

      if (readHook.hook) {
        utility.hooks.push(readHook);
      }
    }
  }
};

utility.decolateText = (message) => {
  let response = message;

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
