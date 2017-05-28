let assert = require("chai").assert;
let util = require("../lib/utility.js");

describe("Slack ID置換のテスト", () => {
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

describe("Slack messageのテキストパーサーのテスト", () => {
  let twitterBotMessage = {"bot_id":"XXE0S2FXX","attachments":[{"fallback":"<https://twitter.com/hideack@hideack>: Test message","ts":1495864801,"author_name":"hideack","author_link":"https://twitter.com/hideack/status/868346031640989696","author_icon":"https://pbs.twimg.com/profile_images/hideack/hideack_normal.png","author_subname":"@hideack","pretext":"<https://twitter.com/hideack/status/868346031640989696>","text":"Test message","service_name":"twitter","service_url":"https://twitter.com/","from_url":"https://twitter.com/hideack/status/868346031640989696","image_url":"https://pbs.twimg.com/media/DAv6DVjUIAAVlrY.jpg","image_width":1200,"image_height":800,"image_bytes":273940,"id":1,"footer":"Twitter","footer_icon":"https://a.slack-edge.com/6e067/img/services/twitter_pixel_snapped_32.png"}],"type":"message","subtype":"bot_message","team":"XX3GLB4XX","channel":"XXNQBEEXX","event_ts":"1495864803.324462","ts":"1495864803.324462","level":"error","message":"","timestamp":"2017-05-27T06:00:04.121Z"};

  let message = {type: 'message', channel: 'XXEGEXXS0', user: 'XX3NKUBXX', text: 'normal message', ts: '1495868089.515753',source_team: 'XXYGLB4ZZ', team: 'ZZ3GLB4XX' };

  let noTextMessage = {type: 'message', channel: 'XXEGEXXS0', user: 'XX3NKUBXX', ts: '1495868089.515753',source_team: 'XXYGLB4ZZ', team: 'ZZ3GLB4XX' };

  it("通常のメッセージの場合はtextプロパティ参照", () => {
    assert.equal(util.parseText(message), "normal message", "メッセージ中のtextが抽出できている");
  });

  it("bot_messageでtextが無く、attachmentsプロパティの中にtextがある場合、その部分をテキストとして抽出できること", () => {
    assert.equal(util.parseText(twitterBotMessage), "Test message", "botメッセージ中のattachmentsからtextが抽出できている");
  });

  it("messageでtextが無く、attachmentsプロパティの中にtextも無い場合、空文字列が返ること", () => {
    assert.equal(util.parseText(noTextMessage), "");
  });
});

