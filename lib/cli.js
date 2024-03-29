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
      self.handler[cmd].call(rli, args, function(err) {
        if (err) {
          console.error("エラー発生: " + err.message);
          rli.prompt();
          return;
        }
        rli.prompt();
      });
    } else if (cmd.length > 0) {
      console.log("コマンドが見つかりません。");
      rli.prompt();
    } else {
      rli.prompt();
    }
  }).on("close", function() {
    console.log("");
    process.stdin.destroy();
  });

  rli.prompt();
};

module.exports = Cli;
