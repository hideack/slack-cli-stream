let assert = require("chai").assert;
let util = require("../lib/utility.js");

describe("ユーティリティのテスト", () => {
  beforeEach( () => {
    util.users['U0XXYYZZ0'] =  {name: "alice"};
    util.users['U0XXYYZZ1'] =  {name: "bob"};
  });

  it("Slack message中の1ユーザに対するメンションのユーザIDを置換できること", () => {
    assert.equal(util.replaceSlackId("<@U0XXYYZZ0> Hello."), "@alice Hello.", "Slack IDに置換できている");
  });

  it("Slack message中の2ユーザに対するメンションのユーザIDを置換できること", () => {
    assert.equal(util.replaceSlackId("<@U0XXYYZZ0> <@U0XXYYZZ1> Hello."), "@alice @bob Hello.", "Slack IDに置換できている");
  });

  it("Slack message中にメンションが無い場合はそのまま出力されること", () => {
    assert.equal(util.replaceSlackId("Hello."), "Hello.", "渡した文字列がそのまま変える");
  });
});
