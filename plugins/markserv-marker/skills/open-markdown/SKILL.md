---
name: open-markdown
description: Serve a markdown file with markserv-marker and open it in the browser so a human can review it and leave selection-anchored comments. Use when asked to open/preview a markdown file for review.
argument-hint: "[file-path | localhost URL | inferred from context if empty]"
allowed-tools: Read, Glob, Grep, Bash
---

Open a markdown file for human review
===

[markserv-marker](https://github.com/0xys/markserv-marker) runs a single local daemon (default `http://localhost:7642`) that renders markdown with GitHub styling and lets a human select text in the browser and leave threaded review comments. This skill covers the serving side; processing the comments afterwards is `/markserv-marker:review-markdown`.

**Prerequisite**: the `markserv-marker` command must be on PATH. If it is missing, tell the user to install it and stop. Either way works:

```console
$ npm i -g markserv-marker
```

or from source:

```console
$ git clone https://github.com/0xys/markserv-marker.git
$ cd markserv-marker && npm install && npm link
```

# Steps

1. Determine the target markdown file from the argument or the conversation context. If given a localhost URL (`http://localhost:7642/f/<id>/<name>`), the file is already registered — extract the `<id>`, confirm it with `GET /api/files/<id>`, and skip to step 3 with its `url`. If nothing identifies a file, ask the user.
2. Register it and capture the registration:
   ```console
   $ markserv-marker <path> --no-browser --json
   {"id":"<fileId>","url":"http://localhost:7642/f/<fileId>/<name>", ...}
   ```
   The daemon starts automatically if it is not running. Registration is idempotent — re-registering the same file returns the same `id` and `url`.
3. Open the page for the user: `open "<url>"` (macOS). If that fails, just show the URL.
4. Report to the user:
   - the preview URL (and that the index of all served files is at `http://localhost:7642/`),
   - how to comment: select any text in the rendered page and press the floating Comment button; threads support replies and resolve,
   - that they should invoke `/markserv-marker:review-markdown` when they are done commenting, so the feedback gets applied.

# CLI reference

```console
$ markserv-marker <file-or-dir>      # register (auto-starts the daemon), open browser, print URL
$ markserv-marker <path> --json      # machine-readable: {"id","url","path","created",...} on one line
$ markserv-marker status             # daemon health + registered files (supports --json)
$ markserv-marker stop               # stop the daemon
$ markserv-marker daemon             # run the daemon in the foreground (to see logs)
```

Flags: `--port/-p` (default `7642`), `--address/-a` (default `localhost`), `--no-browser`, `--json`, `--theme dark|light|synthwave|solarized`, `--no-hotreload`, `--silent`, `--verbose`.

Registration is idempotent (`id` = hash of the file's realpath). Registering a file serves its whole parent directory under `/f/<id>/`, so relative images and sibling links work. Comments live in daemon memory only — `stop` discards them.
