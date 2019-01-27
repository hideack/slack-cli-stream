# slack-cli-stream

[![Greenkeeper badge](https://badges.greenkeeper.io/hideack/slack-cli-stream.svg)](https://greenkeeper.io/)
[![CircleCI](https://circleci.com/gh/hideack/slack-cli-stream.svg?style=svg)](https://circleci.com/gh/hideack/slack-cli-stream)

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
- token: Slackトークン
- hooks
  - user: フックさせる際に対象ユーザーを固定する場合に指定
  - channel: フックさせる際に対象チャンネルを固定する場合に指定
  - keyword: 特定のキーワードのみにフックさせる場合に指定
  - hook: フック条件に合致し、発火した場合に実行するコマンドを記述


```yaml
token: xoxp-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
hooks:
  -
    user: hideack
    hook: curl -X PUT https://pixe.la/v1/users/hideack/graphs/slack-message/increment -H 'X-USER-TOKEN:xxxx' -H 'Content-Length:0'
  -
    user: hideack
    channel: general
    keyword: hello
    hook: say hello
```

## Contributing

1. Fork it!
2. Create your feature branch: `git checkout -b my-new-feature`
3. Commit your changes: `git commit -am 'Add some feature'`
4. Push to the branch: `git push origin my-new-feature`
5. Submit a pull request :D

## License

Apache-2.0

