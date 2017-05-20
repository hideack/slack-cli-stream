let util = {};

util.users = {};
util.channels = {};
util.bots = {};

util.replaceId = (line) => {
  let res = line;
  let matchIds = line.match(/\<[^\>]*\>/g).map((s) => s.substring(2, s.length-1));

  for(let i=0; i<matchIds.length; i++) {
    if (util.users[matchIds[i]]) {
      res = res.replace("<@" + matchIds[i] + ">", "@" + util.users[matchIds[i]].name);
    }
  }

  return res;
};

module.exports = util;
