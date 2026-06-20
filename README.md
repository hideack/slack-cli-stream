# slack-cli-stream

[![Node.js CI](https://github.com/hideack/slack-cli-stream/actions/workflows/node.js.yml/badge.svg)](https://github.com/hideack/slack-cli-stream/actions/workflows/node.js.yml)

## Installation

```
$ npm install -g slack-cli-stream
```

## Usage
### default

```
$ slack-cli-stream --token xoxp-**********
```

- You can generate a tokens here: 
  - https://api.slack.com/custom-integrations/legacy-tokens

### settings

```
$ slack-cli-stream --settings setting.yaml
```

#### setting.yaml
- token: 【必須】Slackトークン
- twitter: 【任意】twitter APIのconsumer, accessのそれぞれのkey, secret
- hooks
  - user: フックさせる際に対象ユーザーを固定する場合に指定
  - channel: フックさせる際に対象チャンネルを固定する場合に指定
  - keyword: 特定のキーワードのみにフックさせる場合に指定（完全一致）
  - prefix: 特定の文字列で始まるメッセージにフックさせる場合に指定（前方一致）
  - cron: 設定に記載したhookの発動条件をcron表記で指定
  - hook: フック条件に合致し、発火した場合に実行するコマンドを記述
- theme
  - text: メッセージ表示色
  - date: 日付表示職

```yaml
token: xoxp-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
twitter:
  consumer_key: ***
  consumer_secret: ***
  access_token_key: ***
  access_token_secret: ***
hooks:
  -
    user: hideack
    hook: curl -X PUT https://pixe.la/v1/users/hideack/graphs/slack-message/increment -H 'X-USER-TOKEN:xxxx' -H 'Content-Length:0'
  -
    user: hideack
    channel: general
    keyword: hello
    hook: say hello
  -
    user: hideack
    channel: general
    prefix: "!deploy"
    hook: /path/to/deploy.sh
  -
    cron: "*/5 12-23 * * *"
    hook: "curl -X POST -d "fizz=buzz2" http://requestbin.fullcontact.com/xxxxxxx"
theme:
  text: green
  date: green
```

### MCP server

`--mcp-port` を指定すると、メッセージ履歴を検索・取得するための MCP (Model Context Protocol) サーバーを `http://localhost:<port>/mcp` で起動します。Claude などの MCP クライアントから接続できます。

```
$ slack-cli-stream --token xoxp-********** --log-sqlite ./slack.db --mcp-port 3737
```

`mcp.port` は setting.yaml でも指定できます。

```yaml
mcp:
  port: 3737
```

> **Note (セキュリティ)**: MCP サーバーは認証を行いません。`post_to_stream` による表示注入・SQLite 書き込みや、保存済みメッセージ履歴の読み取りが、ポートに到達できる相手なら誰でも可能です。`localhost` バインドのまま利用し、`0.0.0.0` での公開やポートフォワードは避けてください。

提供ツール:

- `search_messages` / `get_messages_by_channel` / `get_messages_by_date_range` / `get_thread_messages` — SQLite に保存した履歴の検索・取得（`--log-sqlite` 必須）
- `get_recent_messages` / `list_channels` — メモリ上のバッファ・チャンネル情報の取得
- `post_to_stream` — **AIエージェントから任意のメッセージを slack-cli-stream のコンソールに表示**。Slack のライブメッセージと時系列でマージ表示され、`--log-sqlite` 有効時は SQLite にも記録されます。

#### post_to_stream（AIエージェントのメッセージ表示）

Claude を loop 等でエージェント的に稼働させているとき、進捗・判断・通知などを Slack 経由ではなく直接このプログラムに流して、Slack メッセージと並べて眺められます。

引数:

- `text`（必須）: 表示する本文（改行可）
- `channel`（任意）: 表示するチャンネル名相当ラベル（例: `agent-log`）。既定値 `claude`
- `user`（任意）: 表示する発言ユーザー名相当ラベル（例: `claude`）。既定値 `claude`

##### セットアップ手順

Claude を loop でエージェント的に動かし、その発言を slack-cli-stream に流す全体の流れです。

**1. ターミナルA: slack-cli-stream を MCP サーバー付きで起動**

```
$ slack-cli-stream --token xoxp-********** --log-sqlite ./slack.db --mcp-port 3737
[MCP] Server listening on http://localhost:3737/mcp
```

**2. Claude Code に MCP サーバーを登録**（初回のみ）

```
$ claude mcp add --transport http slack-stream http://localhost:3737/mcp
```

登録できているかは `claude mcp list` で確認できます。

**3. ターミナルB: Claude を loop で起動し、流すよう指示する**

```
$ claude
> /loop 〜タスクの内容〜。進捗・重要な判断・完了時には slack-stream の
  post_to_stream ツールを channel="agent-log" user="claude" を指定して
  1〜2行で流すこと。冗長な思考過程は流さない。
```

恒久的に効かせたい場合は、プロジェクトの `CLAUDE.md` に同様の方針を書いておくとループごとに指示する必要がなくなります。

##### 表示イメージ

ターミナルA には Slack のライブメッセージと Claude のメッセージが受信順（時系列）で混ざって表示されます。

```
2026-06-20 21:36:01 |                       #general |                       hideack | デプロイお願いします
2026-06-20 21:36:53 |                     #agent-log |                        claude | テスト実行中… 58 passing
2026-06-20 21:37:10 |                     #agent-log |                        claude | デプロイ完了。本番反映を確認しました
2026-06-20 21:37:42 |                       #general |                       hideack | ありがとう！
```

`--log-sqlite` を有効にしていれば Claude の発言も `messages` テーブルに保存され、`search_messages` 等の MCP ツールや SQLite から後で横断検索できます（Slack 由来のメッセージと違い `slack_ts` は空なので、バックフィル処理には影響しません）。

## Contributing

1. Fork it!
2. Create your feature branch: `git checkout -b my-new-feature`
3. Commit your changes: `git commit -am 'Add some feature'`
4. Push to the branch: `git push origin my-new-feature`
5. Submit a pull request :D

## License

Apache-2.0

