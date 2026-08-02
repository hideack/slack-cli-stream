let assert = require("chai").assert;
let mentionPane = require("../lib/mention-pane.js");

describe("parsePaneLinesのテスト", () => {
  it("正の整数の文字列を数値として受理できること", () => {
    assert.equal(mentionPane.parsePaneLines("10"), 10);
    assert.equal(mentionPane.parsePaneLines("1"), 1);
  });

  it("0を拒否すること", () => {
    assert.isNull(mentionPane.parsePaneLines("0"));
  });

  it("負の数を拒否すること", () => {
    assert.isNull(mentionPane.parsePaneLines("-3"));
  });

  it("小数を拒否すること", () => {
    assert.isNull(mentionPane.parsePaneLines("3.5"));
  });

  it("数値以外の文字列を拒否すること", () => {
    assert.isNull(mentionPane.parsePaneLines("abc"));
  });

  it("undefined/nullをnullとして扱うこと(オプション未指定)", () => {
    assert.isNull(mentionPane.parsePaneLines(undefined));
    assert.isNull(mentionPane.parsePaneLines(null));
  });
});

describe("isRelevantのテスト(自分宛メンション判定)", () => {
  it("自分のユーザIDへのメンションを含む場合はtrueを返すこと", () => {
    let data = { lines: ["<@U123> お願いします"] };
    assert.isTrue(mentionPane.isRelevant(data, { selfUserId: "U123", usergroupMemberIds: new Set() }));
  });

  it("他人のユーザIDへのメンションのみの場合はfalseを返すこと", () => {
    let data = { lines: ["<@U999> お願いします"] };
    assert.isFalse(mentionPane.isRelevant(data, { selfUserId: "U123", usergroupMemberIds: new Set() }));
  });

  it("<!channel>は所属に関係なく常にtrueを返すこと", () => {
    let data = { lines: ["<!channel> 全員に連絡"] };
    assert.isTrue(mentionPane.isRelevant(data, { selfUserId: "U999", usergroupMemberIds: new Set() }));
  });

  it("<!here>は所属に関係なく常にtrueを返すこと", () => {
    let data = { lines: ["<!here> 至急"] };
    assert.isTrue(mentionPane.isRelevant(data, { selfUserId: "U999", usergroupMemberIds: new Set() }));
  });

  it("<!everyone>は所属に関係なく常にtrueを返すこと", () => {
    let data = { lines: ["<!everyone> お知らせ"] };
    assert.isTrue(mentionPane.isRelevant(data, { selfUserId: "U999", usergroupMemberIds: new Set() }));
  });

  it("所属しているユーザーグループ宛メンションはtrueを返すこと", () => {
    let data = { lines: ["<!subteam^S111|@team-design> レビューお願いします"] };
    assert.isTrue(mentionPane.isRelevant(data, { selfUserId: "U999", usergroupMemberIds: new Set(["S111"]) }));
  });

  it("所属していないユーザーグループ宛メンションはfalseを返すこと", () => {
    let data = { lines: ["<!subteam^S222> レビューお願いします"] };
    assert.isFalse(mentionPane.isRelevant(data, { selfUserId: "U999", usergroupMemberIds: new Set(["S111"]) }));
  });

  it("無関係なメッセージはfalseを返すこと", () => {
    let data = { lines: ["ただの雑談です"] };
    assert.isFalse(mentionPane.isRelevant(data, { selfUserId: "U999", usergroupMemberIds: new Set(["S111"]) }));
  });

  it("linesが省略表示(--- snip ---)されていてもfullLinesの全文を判定に使うこと", () => {
    let data = {
      lines: ["1行目", "2行目", "--- snip ---"],
      fullLines: ["1行目", "2行目", "3行目", "4行目", "5行目", "6行目", "7行目", "<@U123> ここにメンション"]
    };
    assert.isTrue(mentionPane.isRelevant(data, { selfUserId: "U123", usergroupMemberIds: new Set() }));
  });

  it("selfUserIdが未設定(未認証)の場合は自分宛メンション判定をfalseとして扱うこと", () => {
    let data = { lines: ["<@U123> お願いします"] };
    assert.isFalse(mentionPane.isRelevant(data, { selfUserId: null, usergroupMemberIds: new Set() }));
  });
});

describe("extractMemberUsergroupIdsのテスト", () => {
  it("自分が所属するユーザーグループIDの集合を抽出できること", () => {
    let response = {
      usergroups: [
        { id: "S111", users: ["U123", "U456"] },
        { id: "S222", users: ["U789"] }
      ]
    };
    let ids = mentionPane.extractMemberUsergroupIds(response, "U123");
    assert.isTrue(ids.has("S111"));
    assert.isFalse(ids.has("S222"));
    assert.equal(ids.size, 1);
  });

  it("所属するグループが無ければ空集合を返すこと", () => {
    let response = { usergroups: [{ id: "S111", users: ["U456"] }] };
    let ids = mentionPane.extractMemberUsergroupIds(response, "U123");
    assert.equal(ids.size, 0);
  });

  it("不正なレスポンス形状でも空集合を返すこと", () => {
    assert.equal(mentionPane.extractMemberUsergroupIds(null, "U123").size, 0);
    assert.equal(mentionPane.extractMemberUsergroupIds({}, "U123").size, 0);
    assert.equal(mentionPane.extractMemberUsergroupIds({ usergroups: [] }, null).size, 0);
  });
});
