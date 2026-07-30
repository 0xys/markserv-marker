# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```console
npm test                          # full ava suite
npx ava tests/comments-api.test.js       # one test file
npx ava tests/comments-api.test.js -m 'snapshots*'   # tests matching a title pattern
npm run lint                      # xo (config in package.json, tuned for CommonJS)

node lib/cli.js <file.md>         # register a file (auto-starts the daemon), print URL
node lib/cli.js daemon            # run the daemon in the foreground (logs)
node lib/cli.js status --json     # daemon health + registered files
node lib/cli.js stop              # stop the daemon
```

Templates and browser assets (`lib/templates/*.html|js|css`) are read from disk per request — edits show up on browser reload without restarting the daemon. Changes to `lib/*.js` (server, registry, api…) require a daemon restart (`stop`, then re-register files; comments are in-memory and are lost on restart by design).

## Architecture

markserv-marker is a fork of markserv v1.18.0 (first commit is the pristine import). One daemon on a fixed port (default 7642) serves every registered file; the CLI is only a thin client.

**Process/flow**: `lib/cli.js` probes `GET /api/health` (the response must have `name: "markserv-marker"`), spawns `lib/daemon.js` detached if nothing answers, then registers via `POST /api/files` and prints the URL. Two CLIs racing to start the daemon is resolved in `startHTTPServer` (lib/server.js): on `EADDRINUSE` the losing daemon probes health and exits 0.

**Request handling** (`lib/server.js`): no router — a connect middleware stack: `{markserv}`-prefixed bundled-asset handler → `/api` (lib/api.js, hand-rolled method+regex table) → `/f` (registered-file handler) → `/` (index page, favicon, 404). Files are served at `/f/<id>/<path>` where `id = sha1(realpath).slice(0,10)`; the file's **parent directory** is the serve root (relative images and sibling links work), guarded against path traversal by `resolveWithin`.

**State** (`lib/registry.js`): a module-level singleton holding registrations and their comments, in memory only. It is an EventEmitter (`register`/`unregister`) so the hot-reload watcher lifecycle can follow it. Comment ids are `<fileId>-cN`; threads are one level deep (a reply to a reply is re-parented to the root).

**Comment anchoring** — three cooperating mechanisms:
- `lib/source-line.js` (markdown-it plugin) stamps rendered blocks with `data-source-line(-end)`. It must stay **last** in the `.use()` chain: markdown-it-highlightjs replaces the fence renderer and drops token attrs, so fences get attributes injected by wrapping the renderer.
- On comment creation, `registry.narrowRange` shrinks the UI-reported block range to the lines the selected text (`quote`) actually touches, and a `snapshot` of those lines is stored. A short quote can occur several times in one block, so the browser also sends `quoteIndex`, the 0-based occurrence it selected counted over the block's rendered text; `narrowRange` and `highlightQuote` both honour it, clamping when source and rendered text disagree on the count. Absent `quoteIndex` means occurrence 0, which is what pre-existing comments get.
- `getThreads` recomputes `currentText`/`changed` per read and **re-anchors**: stored line numbers are frozen at creation, so when the snapshot text no longer sits at them but is found intact elsewhere, the thread reports the lines it occupies now and `changed` stays false. The copy nearest the original anchor wins, ties going to the earlier one. `snapshot.lineStart/lineEnd` keep recording where the comment was written, and threads are sorted on the re-anchored lines because the browser relies on that order for several comments on one block.

**Hot reload** (`startHotReload` in lib/server.js): one `ws` server; watchers are per-registration-root and refcounted. Messages are JSON envelopes `{type:'reload', html}` / `{type:'comments', fileId}`. The browser swaps `#marker-content` innerHTML and dispatches `marker:reload` / `marker:comments` CustomEvents, which `lib/templates/comments.js` listens to — it rebuilds all widgets idempotently (everything it creates is marked `data-marker-ui`) and preserves in-progress drafts in module state.

**Comment UI** (`lib/templates/comments.js`, vanilla JS, no build step): selection → floating Comment button (mousedown, not click, so the selection survives) → posts line range + quote. Quote highlights are re-found by whitespace-normalized text match, so they survive edits and reloads. View modes (all/unresolved/mark/plain) persist in localStorage.

## Testing gotchas

- The registry singleton is shared within a test file — tests are `test.serial` and clean up via `registry.reset()` or explicit unregister.
- ws clients in tests must connect to `ws://127.0.0.1:<port>`, not `localhost`: ava runs test files in parallel processes and the same port number can be bound on IPv4 by one file and IPv6 by another.
- `tests/comment-ui.test.js` runs the real `comments.js` inside jsdom with a mocked `fetch`; jsdom lacks `Range.getBoundingClientRect` and `scrollIntoView`, which the UI code guards for — keep those guards.
- Snapshot/diff tests write to their fixture files and must restore them, since later tests assert on content.
- `xo --fix` can be overeager (it once rewrote a string index loop to `String.entries()`, which doesn't exist) — rerun the tests after any autofix.

## Workflow rules (important)

- Do **not** commit, push, or update the installed Claude Code plugin on your own. Make the changes, report, and wait for the user to ask.
- Work happens on a branch, never directly on `main`. Branch off `main` and name it after the version the work belongs to, `vX.Y.Z-dev`. `main` receives the work by merge, and only a release commit is expected to land on it directly.
- A release ships **code, skills and plugin together** and may span any number of commits. The invariant is the end state, not the commit shape: when the release is cut, `package.json` version == `plugins/markserv-marker/.claude-plugin/plugin.json` version == the `vX.Y.Z` git tag, and the tag points at a commit where both files agree. Never leave one of the three bumped alone.
- Cutting a release means: bump both version files, tag `vX.Y.Z`, push with tags, create the GitHub Release for the tag (`gh release create vX.Y.Z`), and update the installed plugin.
- Releases happen only when the user asks. When release-worthy changes have accumulated, ask the user instead of releasing automatically.

## Review workflow skills / plugin

`plugins/markserv-marker/skills/` defines the human-in-the-loop review flow this tool exists for, split into two skills: `open-markdown` serves a file for a human to comment on in the browser; `review-markdown` reads unresolved threads from the API, edits the file, replies as `author: "claude"` (in the session language) and resolves each thread. Use them when asked to have a markdown file reviewed or to process review comments.

Inside this repo they are available as the project skills `/open-markdown` and `/review-markdown` (via `.claude/skills/` symlinks). The repo is also a Claude Code plugin marketplace (`.claude-plugin/marketplace.json` + `plugins/markserv-marker/`): installed as a plugin, they are `/markserv-marker:open-markdown` and `/markserv-marker:review-markdown`.
