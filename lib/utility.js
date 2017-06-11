let utility = {};

let chalk = require("chalk");

utility.users = {};
utility.channels = {};
utility.bots = {};

utility.replaceSlackId = (line) => {
  let res = line;

  try {
    let matchIds = line.match(/\<[^\>]*\>/g).map((s) => s.substring(2, s.length-1));

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

  try {
    response = message.text || message.attachments[0].text;
  } catch(e) {
    // no operation
  }

  return response;
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

  return response;
};

module.exports = utility;
