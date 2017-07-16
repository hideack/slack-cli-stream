let assert = require("chai").assert;
let util = require("../lib/utility.js");

describe("Slack ID置換のテスト", () => {
  beforeEach( () => {
    util.users['U0XXYYZZ0'] =  {name: "alice"};
    util.users['U0XXYYZZ1'] =  {name: "bob"};
    util.keywords = ["hideack", "nice"];
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
  let ghBotMessage = {"text":"","bot_id":"B5VPUMFGD","attachments":[{"fallback":"[foo/bar] Pull request submitted: .....","pretext":"[foo/bar] Pull request submitted by hideack","title":"#180 foobar","id":1,"title_link":"https://github.com/foo/bar/pull/180","color":"6CC644","mrkdwn_in":["text","pretext"]}],"type":"message","subtype":"bot_message","team":"T03GLB4LV","channel":"C03Q6TDDE","event_ts":"1498197665.915869","ts":"1498197665.915869","level":"error","message":"","timestamp":"2017-06-23T06:01:05.397Z"};

  let twitterBotMessage = {"bot_id":"XXE0S2FXX","attachments":[{"fallback":"<https://twitter.com/hideack@hideack>: Test message","ts":1495864801,"author_name":"hideack","author_link":"https://twitter.com/hideack/status/868346031640989696","author_icon":"https://pbs.twimg.com/profile_images/hideack/hideack_normal.png","author_subname":"@hideack","pretext":"<https://twitter.com/hideack/status/868346031640989696>","text":"Test message","service_name":"twitter","service_url":"https://twitter.com/","from_url":"https://twitter.com/hideack/status/868346031640989696","image_url":"https://pbs.twimg.com/media/DAv6DVjUIAAVlrY.jpg","image_width":1200,"image_height":800,"image_bytes":273940,"id":1,"footer":"Twitter","footer_icon":"https://a.slack-edge.com/6e067/img/services/twitter_pixel_snapped_32.png"}],"type":"message","subtype":"bot_message","team":"XX3GLB4XX","channel":"XXNQBEEXX","event_ts":"1495864803.324462","ts":"1495864803.324462","level":"error","message":"","timestamp":"2017-05-27T06:00:04.121Z"};

  let message = {type: 'message', channel: 'XXEGEXXS0', user: 'XX3NKUBXX', text: 'normal message', ts: '1495868089.515753',source_team: 'XXYGLB4ZZ', team: 'ZZ3GLB4XX' };

  let noTextMessage = {type: 'message', channel: 'XXEGEXXS0', user: 'XX3NKUBXX', ts: '1495868089.515753',source_team: 'XXYGLB4ZZ', team: 'ZZ3GLB4XX' };

  it("通常のメッセージの場合はtextプロパティ参照", () => {
    assert.equal(util.parseText(message), "normal message", "メッセージ中のtextが抽出できている");
  });

  it("bot_messageでtextが無く、attachmentsプロパティの中にtextがある場合、その部分をテキストとして抽出できること", () => {
    assert.equal(util.parseText(twitterBotMessage), "Test message", "botメッセージ中のattachmentsからtextが抽出できている");
  });

  it("bot_messageでtextが無く、attachmentsプロパティの中にtextも無いがpretextがある場合、その部分をテキストとして抽出できること", () => {
    assert.equal(util.parseText(ghBotMessage), "[foo/bar] Pull request submitted by hideack", "botメッセージ中のattachmentsからpretextが抽出できている");
  });

  it("messageでtextが無く、attachmentsプロパティの中にtext, pretextも無い場合、空文字列が返ること", () => {
    assert.equal(util.parseText(noTextMessage), "");
  });
});

describe("テキスト装飾のテスト", () => {
  it("装飾文字列が含まれない場合はそのままテキストが返ってくること", () => {
    assert.equal(util.decolateText("Hello slack"), "Hello slack", "そのまま文字列が返ってくる");
  });

  it("協調表記された文字が太文字になること", () => {
    let expectedText = "Hello \u001b[1mworld\u001b[22m";

    assert.equal(util.decolateText("Hello *world*"), expectedText, "worldという単語が太文字になっている");
  });

  it("引用表記された文字が > になり、以降イタリック表記されること", () => {
    let expectedText = ">\u001b[3m Hey\u001b[23m";

    assert.equal(util.decolateText("&gt; Hey"), expectedText);
  });

  it("キーワード指定された文字が赤太文字となること", () => {
    let expectedText = "Hello \u001b[31m\u001b[1mhideack\u001b[22m\u001b[39m. Have a \u001b[31m\u001b[1mnice\u001b[22m\u001b[39m day";
    assert.equal(util.decolateText("Hello hideack. Have a nice day"), expectedText, "hideackとniceという単語が赤太文字になっている");
  });
});

describe("設定ファイル読み込みのテスト", () => {
  it("設定ファイルを読み込み強調キーワードが更新されていること", () => {
    util.parseKeywordsFile('./test/settings_sample.yaml');
    assert.deepEqual(util.keywords, ["abc", "xyz"], "キーワードが設定ファイルに基いて更新されている");
  });
});
