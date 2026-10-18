# glafka Elaia plugin

Lets [Elaia](https://github.com/MikeNats/elaia) drive glafka. glafka itself knows nothing about
Elaia: this plugin does the work.

```
glafka  ◄── glafka CLI ──  this plugin  ◄── MCP ──  Elaia
```

- It is an **MCP server** (stdio). Each of Elaia's plugin tools (`describe`, `tickets`, `next`,
  `close`, …) is one MCP tool here. It answers by running the glafka CLI.
- It turns glafka's own JSON into Elaia's ticket shape. A ticket is `ready` only when the
  review is clean **and** glafka's own push check (`qaGap` in `poreia --json`) says the QA pass
  still covers the current code.

## Install

```bash
cd elaia-plugin
npm install        # builds dist/plugin.cjs
npm link           # puts the `glafka-elaia` command on your PATH
```

Then, in Elaia, add a project. When it asks which workflow tool to use, type in its main chat:

```
glafka-elaia
```

glafka not on your `PATH`? Give the plugin its path: `GLAFKA_BIN=/path/to/glafka`.

## Develop

```bash
npm run typecheck
npm test            # the plugin over MCP, against a fake glafka
npm run test:real   # against the real glafka on PATH
```

`src/contract/` is a copy of Elaia's plugin contract (version 2). Elaia checks every answer
against its own copy, so keep the two in step.
