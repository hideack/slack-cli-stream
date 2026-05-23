const Database = require("better-sqlite3");
const fs = require("fs");
const chalk = require("chalk");

const BAR_MAX = 20;

function makeBar(value, max) {
  if (max === 0) return "";
  return "█".repeat(Math.round((value / max) * BAR_MAX));
}

function formatRelativeTime(seconds) {
  if (seconds < 60) return `${Math.round(seconds)} seconds ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} minutes ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)} hours ago`;
  return `${Math.round(seconds / 86400)} days ago`;
}

function formatBytes(bytes) {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const showStatus = (dbPath) => {
  let db;
  try {
    db = new Database(dbPath, { readonly: true });
  } catch (e) {
    console.error(chalk.red(`Cannot open database: ${e.message}`));
    process.exit(1);
  }

  let dbSize = "";
  try {
    dbSize = formatBytes(fs.statSync(dbPath).size);
  } catch (_) { /* ignore stat errors */ }

  const heartbeatRow = db.prepare("SELECT last_seen_at FROM app_heartbeat WHERE id = 1").get();
  let heartbeatStr = chalk.dim("N/A");
  if (heartbeatRow) {
    const diff = Date.now() / 1000 - heartbeatRow.last_seen_at;
    heartbeatStr = diff < 180
      ? chalk.green(formatRelativeTime(diff))
      : chalk.yellow(formatRelativeTime(diff));
  }

  const total7d = db.prepare(`
    SELECT COUNT(*) as count FROM messages
    WHERE logged_at >= datetime('now', '-7 days', 'localtime')
  `).get().count;

  const todayCount = db.prepare(`
    SELECT COUNT(*) as count FROM messages
    WHERE date(logged_at) = date('now', 'localtime')
  `).get().count;

  const dayRows = db.prepare(`
    SELECT date(logged_at) as day, COUNT(*) as count
    FROM messages
    WHERE logged_at >= datetime('now', '-7 days', 'localtime')
    GROUP BY day
    ORDER BY day
  `).all();

  const channelRows = db.prepare(`
    SELECT channel, COUNT(*) as count
    FROM messages
    WHERE logged_at >= datetime('now', '-7 days', 'localtime')
    GROUP BY channel
    ORDER BY count DESC
    LIMIT 7
  `).all();

  const userRows = db.prepare(`
    SELECT user, COUNT(*) as count
    FROM messages
    WHERE logged_at >= datetime('now', '-7 days', 'localtime')
    GROUP BY user
    ORDER BY count DESC
    LIMIT 7
  `).all();

  db.close();

  const avg7d = total7d > 0 ? Math.round(total7d / 7) : 0;

  console.log();
  console.log(chalk.bold.green("● Slack Stream Status"));
  console.log();

  console.log(chalk.bold("  App Health"));
  console.log(`  ├─ Last heartbeat : ${heartbeatStr}`);
  console.log(`  └─ Database       : ${chalk.cyan(dbPath)} ${chalk.dim(`(${dbSize})`)}`);
  console.log();

  console.log(chalk.bold("  Messages — Last 7 Days"));
  console.log(`  ├─ Total          : ${chalk.cyan(total7d.toLocaleString())} messages`);
  console.log(`  ├─ Daily average  : ${chalk.cyan(avg7d.toLocaleString())} messages/day`);
  console.log(`  └─ Today          : ${chalk.cyan(todayCount.toLocaleString())} messages`);
  console.log();

  if (dayRows.length > 0) {
    console.log(chalk.bold("  Activity by Day"));
    const maxDay = Math.max(...dayRows.map(r => r.count));
    for (const row of dayRows) {
      const label = row.day.slice(5).replace("-", "/");
      const bar = makeBar(row.count, maxDay).padEnd(BAR_MAX);
      const count = String(row.count).padStart(5);
      console.log(`  ${label}  ${chalk.green(bar)}  ${chalk.dim(count)}`);
    }
    console.log();
  }

  if (channelRows.length > 0) {
    console.log(chalk.bold("  Top Active Channels (Last 7 Days)"));
    const maxCh = channelRows[0].count;
    for (const row of channelRows) {
      const name = (row.channel || "(unknown)").padEnd(22);
      const bar = makeBar(row.count, maxCh).padEnd(BAR_MAX);
      const count = String(row.count).padStart(5);
      console.log(`  ${name}  ${chalk.blue(bar)}  ${chalk.dim(count)}`);
    }
    console.log();
  }

  if (userRows.length > 0) {
    console.log(chalk.bold("  Top Active Users (Last 7 Days)"));
    const maxU = userRows[0].count;
    for (const row of userRows) {
      const name = (row.user || "(unknown)").padEnd(22);
      const bar = makeBar(row.count, maxU).padEnd(BAR_MAX);
      const count = String(row.count).padStart(5);
      console.log(`  ${name}  ${chalk.yellow(bar)}  ${chalk.dim(count)}`);
    }
    console.log();
  }
};

module.exports = { showStatus };
