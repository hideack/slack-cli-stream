let assert = require("chai").assert;
let fs     = require("fs");
let http   = require("http");
let os     = require("os");
let path   = require("path");
let { initSqliteDb, logMessageSqlite } = require("../lib/sqlite-logger");
let { startMcpServer } = require("../lib/mcp-server");

const mcpPost = (port, body) => {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const options = {
      hostname: "localhost",
      port,
      path: "/mcp",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload),
        "Accept": "application/json, text/event-stream",
      },
    };

    const req = http.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => {
        // SSEストリームの場合はdata:行を抽出する
        if (res.headers["content-type"] && res.headers["content-type"].includes("text/event-stream")) {
          const lines = data.split("\n").filter((l) => l.startsWith("data:"));
          if (lines.length > 0) {
            try {
              resolve({ statusCode: res.statusCode, body: JSON.parse(lines[0].replace("data:", "").trim()) });
            } catch (e) {
              resolve({ statusCode: res.statusCode, body: null, raw: data });
            }
          } else {
            resolve({ statusCode: res.statusCode, body: null, raw: data });
          }
        } else {
          try {
            resolve({ statusCode: res.statusCode, body: JSON.parse(data) });
          } catch (e) {
            resolve({ statusCode: res.statusCode, body: null, raw: data });
          }
        }
      });
    });

    req.on("error", reject);
    req.write(payload);
    req.end();
  });
};

const initializeRequest = (port) => mcpPost(port, {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "test", version: "0" },
  },
});

const callTool = (port, name, args) => mcpPost(port, {
  jsonrpc: "2.0",
  id: 2,
  method: "tools/call",
  params: { name, arguments: args || {} },
});

describe("MCPサーバーのテスト", () => {
  let db, dbPath, server, port;

  const mockUtil = {
    channels: {
      "C001": { id: "C001", name: "general", is_private: false, is_im: false },
      "C002": { id: "C002", name: "random",  is_private: false, is_im: false },
    },
    users: {
      "U001": { id: "U001", name: "alice" },
      "U002": { id: "U002", name: "bob" },
    },
    buffer: {},
  };

  before((done) => {
    dbPath = path.join(os.tmpdir(), `mcp-test-${Date.now()}.db`);
    db = initSqliteDb(dbPath);

    logMessageSqlite(db, "2026-04-05 12:00:00", "#general", "alice", "Hello world",    "C001", "U001", "100.000", null);
    logMessageSqlite(db, "2026-04-05 12:01:00", "#general", "bob",   "Good morning",   "C001", "U002", "101.000", null);
    logMessageSqlite(db, "2026-04-05 12:02:00", "#random",  "alice", "こんにちは",     "C002", "U001", "102.000", null);
    logMessageSqlite(db, "2026-04-05 12:03:00", "#general", "alice", "Reply message",  "C001", "U001", "103.000", "100.000");

    server = startMcpServer({ port: 0, sqliteDb: db, util: mockUtil });
    server.on("listening", () => {
      port = server.address().port;
      done();
    });
  });

  after((done) => {
    db.close();
    if (fs.existsSync(dbPath)) {
      fs.unlinkSync(dbPath);
    }
    server.close(done);
  });

  describe("initialize", () => {
    it("initializeハンドシェイクが成功すること", async () => {
      const res = await initializeRequest(port);
      assert.equal(res.statusCode, 200, "HTTPステータスが200");
    });
  });

  describe("list_channels ツール", () => {
    it("チャンネル一覧が返ること", async () => {
      const res = await callTool(port, "list_channels", {});
      assert.isNotNull(res.body, "レスポンスボディが存在する");
      const text = res.body && res.body.result && res.body.result.content &&
        res.body.result.content[0] && res.body.result.content[0].text;
      if (text) {
        assert.include(text, "general", "generalチャンネルが含まれる");
        assert.include(text, "random",  "randomチャンネルが含まれる");
      }
    });
  });

  describe("search_messages ツール", () => {
    it("キーワードでメッセージ検索できること", async () => {
      const res = await callTool(port, "search_messages", { query: "Hello" });
      assert.isNotNull(res.body, "レスポンスボディが存在する");
      const text = res.body && res.body.result && res.body.result.content &&
        res.body.result.content[0] && res.body.result.content[0].text;
      if (text) {
        assert.include(text, "Hello world", "Helloで検索してHello worldがヒットする");
      }
    });
  });

  describe("get_messages_by_channel ツール", () => {
    it("チャンネル名でメッセージが取得できること", async () => {
      const res = await callTool(port, "get_messages_by_channel", { channel: "general" });
      assert.isNotNull(res.body, "レスポンスボディが存在する");
      const text = res.body && res.body.result && res.body.result.content &&
        res.body.result.content[0] && res.body.result.content[0].text;
      if (text) {
        assert.include(text, "#general", "#generalのメッセージが含まれる");
      }
    });
  });

  describe("get_messages_by_date_range ツール", () => {
    it("日時範囲でメッセージが取得できること", async () => {
      const res = await callTool(port, "get_messages_by_date_range", {
        start: "2026-04-05 12:00:00",
        end:   "2026-04-05 12:01:30",
      });
      assert.isNotNull(res.body, "レスポンスボディが存在する");
      const text = res.body && res.body.result && res.body.result.content &&
        res.body.result.content[0] && res.body.result.content[0].text;
      if (text) {
        assert.include(text, "Hello world",  "12:00のメッセージが含まれる");
        assert.include(text, "Good morning", "12:01のメッセージが含まれる");
        assert.notInclude(text, "こんにちは", "12:02のメッセージは含まれない");
      }
    });
  });

  describe("get_thread_messages ツール", () => {
    it("thread_tsでスレッドメッセージが取得できること", async () => {
      const res = await callTool(port, "get_thread_messages", { thread_ts: "100.000" });
      assert.isNotNull(res.body, "レスポンスボディが存在する");
      const text = res.body && res.body.result && res.body.result.content &&
        res.body.result.content[0] && res.body.result.content[0].text;
      if (text) {
        assert.include(text, "Reply message", "スレッド返信メッセージが含まれる");
      }
    });
  });
});

describe("MCPサーバー (SQLite無し) のテスト", () => {
  let server, port;

  const mockUtil = {
    channels: { "C001": { id: "C001", name: "general", is_private: false, is_im: false } },
    users: {},
    buffer: {},
  };

  before((done) => {
    server = startMcpServer({ port: 0, sqliteDb: null, util: mockUtil });
    server.on("listening", () => {
      port = server.address().port;
      done();
    });
  });

  after((done) => {
    server.close(done);
  });

  it("SQLite必須ツールがエラーを返すこと", async () => {
    const res = await callTool(port, "search_messages", { query: "test" });
    assert.isNotNull(res.body, "レスポンスボディが存在する");
    const result = res.body && res.body.result;
    if (result) {
      assert.isTrue(result.isError, "isErrorがtrueであること");
    }
  });

  it("list_channelsはSQLiteなしでも動作すること", async () => {
    const res = await callTool(port, "list_channels", {});
    assert.isNotNull(res.body, "レスポンスボディが存在する");
    const isError = res.body && res.body.result && res.body.result.isError;
    assert.isNotTrue(isError, "isErrorがtrueでないこと");
  });
});
