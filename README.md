# slack-cli-stream
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
  - keyword: 特定のキーワードのみにフックさせる場合に指定
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
    cron: "*/5 12-23 * * *"
    hook: "curl -X POST -d "fizz=buzz2" http://requestbin.fullcontact.com/xxxxxxx"
theme:
  text: green
  date: green
```

## Contributing

1. Fork it!
2. Create your feature branch: `git checkout -b my-new-feature`
3. Commit your changes: `git commit -am 'Add some feature'`
4. Push to the branch: `git push origin my-new-feature`
5. Submit a pull request :D

## License

Apache-2.0

