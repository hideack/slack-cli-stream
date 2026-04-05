"use strict";

const { McpServer }                     = require("@modelcontextprotocol/sdk/server/mcp.js");
const { StreamableHTTPServerTransport } = require("@modelcontextprotocol/sdk/server/streamableHttp.js");
const express = require("express");
const { z }   = require("zod");

const NO_SQLITE_ERROR = {
  content: [{ type: "text", text: "SQLite logging is not enabled. Start with --log-sqlite <path> to use this tool." }],
  isError: true,
};

const formatRowsResult = (rows, summary) => {
  if (rows.length === 0) {
    return { content: [{ type: "text", text: summary + "\n(no results)" }] };
  }
  const lines = rows.map((r) =>
    `[${r.logged_at}] ${r.channel} | ${r.user}: ${r.message}` +
    (r.thread_ts ? ` (thread: ${r.thread_ts})` : "")
  );
  return { content: [{ type: "text", text: summary + "\n\n" + lines.join("\n") }] };
};

const formatObjectsResult = (items, summary) => {
  const text = summary + "\n\n" + JSON.stringify(items, null, 2);
  return { content: [{ type: "text", text }] };
};

const registerTools = (server, sqliteDb, util) => {
  server.tool(
    "search_messages",
    "Full-text search across Slack message history stored in SQLite using FTS5. Requires --log-sqlite.",
    {
      query:   z.string().describe("Search keyword or phrase"),
      channel: z.string().optional().describe("Filter by channel name (e.g. 'general')"),
      start:   z.string().optional().describe("Start datetime filter, format: YYYY-MM-DD HH:mm:ss"),
      end:     z.string().optional().describe("End datetime filter, format: YYYY-MM-DD HH:mm:ss"),
      limit:   z.number().int().min(1).max(200).default(50).describe("Maximum number of results"),
    },
    ({ query, channel, start, end, limit }) => {
      if (!sqliteDb) return NO_SQLITE_ERROR;
      let sql = [
        "SELECT m.logged_at, m.channel, m.user, m.message, m.thread_ts, m.slack_ts",
        "FROM messages m",
        "JOIN messages_fts f ON m.id = f.rowid",
        "WHERE messages_fts MATCH ?"
      ].join(" ");
      const params = [query];
      if (channel) { sql += " AND m.channel LIKE ?"; params.push("%" + channel + "%"); }
      if (start)   { sql += " AND m.logged_at >= ?"; params.push(start); }
      if (end)     { sql += " AND m.logged_at <= ?"; params.push(end); }
      sql += " ORDER BY m.logged_at DESC LIMIT ?";
      params.push(limit);

      const rows = sqliteDb.prepare(sql).all(...params);
      return formatRowsResult(rows, `search_messages: ${rows.length} result(s) for "${query}"`);
    }
  );

  server.tool(
    "get_recent_messages",
    "Get recently received Slack messages from the in-memory buffer (up to 20 per channel). Always available.",
    {
      channel: z.string().optional().describe("Filter by channel buffer key, e.g. '#general'"),
      limit:   z.number().int().min(1).max(100).default(20).describe("Maximum number of messages"),
    },
    ({ channel, limit }) => {
      const results = [];
      const bufferKeys = channel
        ? (util.buffer[channel] ? [channel] : [])
        : Object.keys(util.buffer);

      for (const key of bufferKeys) {
        const q = util.buffer[key];
        if (!q) continue;
        q.forEach((data) => {
          results.push({
            channel: key,
            time: data.time ? data.time.format("YYYY-MM-DD HH:mm:ss") : "",
            user: data.user || "",
            message: (data.lines || []).join("\n"),
          });
        });
      }

      results.sort((a, b) => (b.time > a.time ? 1 : -1));
      const sliced = results.slice(0, limit);
      return formatObjectsResult(sliced, `get_recent_messages: ${sliced.length} message(s)`);
    }
  );

  server.tool(
    "list_channels",
    "List all Slack channels known to the running instance (from in-memory metadata).",
    {},
    () => {
      const channels = Object.values(util.channels).map((ch) => ({
        id:         ch.id,
        name:       ch.name || ch.id,
        is_private: ch.is_private || false,
        is_im:      ch.is_im || false,
      }));
      return formatObjectsResult(channels, `list_channels: ${channels.length} channel(s)`);
    }
  );

  server.tool(
    "get_messages_by_channel",
    "Retrieve message history for a specific channel from SQLite. Requires --log-sqlite.",
    {
      channel: z.string().describe("Channel name to query (e.g. 'general')"),
      start:   z.string().optional().describe("Start datetime, format: YYYY-MM-DD HH:mm:ss"),
      end:     z.string().optional().describe("End datetime, format: YYYY-MM-DD HH:mm:ss"),
      limit:   z.number().int().min(1).max(500).default(100).describe("Maximum number of results"),
    },
    ({ channel, start, end, limit }) => {
      if (!sqliteDb) return NO_SQLITE_ERROR;
      let sql = "SELECT logged_at, channel, user, message, thread_ts, slack_ts FROM messages WHERE channel LIKE ?";
      const params = ["%" + channel + "%"];
      if (start) { sql += " AND logged_at >= ?"; params.push(start); }
      if (end)   { sql += " AND logged_at <= ?"; params.push(end); }
      sql += " ORDER BY logged_at DESC LIMIT ?";
      params.push(limit);

      const rows = sqliteDb.prepare(sql).all(...params);
      return formatRowsResult(rows, `get_messages_by_channel(${channel}): ${rows.length} message(s)`);
    }
  );

  server.tool(
    "get_messages_by_date_range",
    "Retrieve messages within a datetime range from SQLite, with optional channel filter. Requires --log-sqlite.",
    {
      start:   z.string().describe("Start datetime (inclusive), format: YYYY-MM-DD HH:mm:ss"),
      end:     z.string().describe("End datetime (inclusive), format: YYYY-MM-DD HH:mm:ss"),
      channel: z.string().optional().describe("Optional channel name filter"),
      limit:   z.number().int().min(1).max(500).default(100).describe("Maximum number of results"),
    },
    ({ start, end, channel, limit }) => {
      if (!sqliteDb) return NO_SQLITE_ERROR;
      let sql = "SELECT logged_at, channel, user, message, thread_ts, slack_ts FROM messages WHERE logged_at >= ? AND logged_at <= ?";
      const params = [start, end];
      if (channel) { sql += " AND channel LIKE ?"; params.push("%" + channel + "%"); }
      sql += " ORDER BY logged_at ASC LIMIT ?";
      params.push(limit);

      const rows = sqliteDb.prepare(sql).all(...params);
      return formatRowsResult(rows, `get_messages_by_date_range(${start} to ${end}): ${rows.length} message(s)`);
    }
  );

  server.tool(
    "get_thread_messages",
    "Retrieve all messages belonging to a Slack thread by its root thread_ts timestamp. Requires --log-sqlite.",
    {
      thread_ts: z.string().describe("Slack thread timestamp (e.g. '1234567890.000100')"),
    },
    ({ thread_ts }) => {
      if (!sqliteDb) return NO_SQLITE_ERROR;
      const rows = sqliteDb.prepare(
        "SELECT logged_at, channel, user, message, slack_ts, thread_ts FROM messages WHERE thread_ts = ? ORDER BY logged_at ASC"
      ).all(thread_ts);
      return formatRowsResult(rows, `get_thread_messages(${thread_ts}): ${rows.length} message(s)`);
    }
  );
};

const buildMcpServer = (sqliteDb, util) => {
  const server = new McpServer({
    name: "slack-cli-stream",
    version: require("../package.json").version,
  });
  registerTools(server, sqliteDb, util);
  return server;
};

const startMcpServer = ({ port, sqliteDb, util }) => {
  const app = express();
  app.use(express.json());

  app.all("/mcp", async (req, res) => {
    try {
      const server = buildMcpServer(sqliteDb, util);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error("[MCP] Error handling request:", err.message || err);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
    }
  });

  const httpServer = app.listen(port, () => {
    console.log(`[MCP] Server listening on http://localhost:${port}/mcp`);
  });

  return httpServer;
};

module.exports = { startMcpServer };
