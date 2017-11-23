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
  - https://api.slack.com/web

### settings

```
$ slack-cli-stream --settings setting.yaml
```

#### setting.yaml

```yaml
keywords:
  - abc
  - xyz
token: xoxp-xxxx-xxxx-xxxx-xxxx
```

## Contributing

1. Fork it!
2. Create your feature branch: `git checkout -b my-new-feature`
3. Commit your changes: `git commit -am 'Add some feature'`
4. Push to the branch: `git push origin my-new-feature`
5. Submit a pull request :D

## License

Apache-2.0

