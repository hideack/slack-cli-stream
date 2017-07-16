let utility = {};

let chalk = require("chalk");
let nconf = require("nconf");
let yaml = require("js-yaml");

utility.users = {};
utility.channels = {};
utility.bots = {};
utility.keywords = [];

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

utility.parseKeywordsFile = (path) => {
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

  utility.keywords = nconf.load().keywords;
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

module.exports = utility;
