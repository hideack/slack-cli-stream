var readline = require("readline");

function Cli(handler) {
  this.handler = handler;
}

Cli.prototype.run = function() {
  var self = this;
  var rli = readline.createInterface(process.stdin, process.stdout);
  rli.setPrompt("> ");

  rli.on("line", function(line) {
    var args = line.split(/\s+/), cmd = args.shift();

    if (self.handler[cmd]) {
      self.handler[cmd].call(rli, args, function(err, res) {
        rli.prompt();
      });
    } else if (cmd.length > 0) {
      console.log("cmd not found.");
      rli.prompt();
    } else {
      rli.prompt();
    }
    rli.prompt();
  }).on("close", function() {
    console.log("");
    process.stdin.destroy();
  });

  rli.prompt();
};


module.exports = Cli;
