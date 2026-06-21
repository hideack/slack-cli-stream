var readline = require("readline");

function Cli(handler, opts) {
  this.handler = handler;
  this.opts = opts || {};
}

Cli.prototype.run = function() {
  var self = this;
  var rliOpts = { input: process.stdin, output: process.stdout };

  // # 入力時にチャンネル名候補を Tab 補完する
  if (typeof self.opts.completer === "function") {
    rliOpts.completer = self.opts.completer;
  }

  var rli = readline.createInterface(rliOpts);
  rli.setPrompt("> ");

  rli.on("line", function(line) {
    var trimmed = line.trim();

    // "#channel" で始まる入力は該当チャンネルの直近ログ表示にルーティングする
    if (trimmed.charAt(0) === "#" && typeof self.handler.channelRecent === "function") {
      self.handler.channelRecent.call(rli, trimmed, function(err) {
        if (err) {
          console.error("エラー発生: " + err.message);
        }
        rli.prompt();
      });
      return;
    }

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
