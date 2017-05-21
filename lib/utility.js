let utility = {};

utility.users = {};
utility.channels = {};
utility.bots = {};

utility.replaceSlackId = (line) => {
  let res = line;
  let matchIds = line.match(/\<[^\>]*\>/g).map((s) => s.substring(2, s.length-1));

  for(let i=0; i<matchIds.length; i++) {
    if (utility.users[matchIds[i]]) {
      res = res.replace("<@" + matchIds[i] + ">", "@" + utility.users[matchIds[i]].name);
    }
  }

  return res;
};

module.exports = utility;
