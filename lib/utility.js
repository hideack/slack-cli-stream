let utility = {};

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
  return message.text || message.attachments[0].text;
};

module.exports = utility;
