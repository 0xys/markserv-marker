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

node scripts/marker-state.js backup  state.json   # registrations + comments to a file
node scripts/marker-state.js restore state.json   # put them back into a fresh daemon
```

## Restarting the daemon without losing comments

Comments live in the daemon's memory only, so any restart discards them —
including the restart a change to `lib/*.js` requires. **Check
`lib/cli.js status` for unresolved comments before stopping.** If there are
any, carry the state across instead of asking the user to re-type it:

```console
node scripts/marker-state.js backup /tmp/marker-state.json
node lib/cli.js stop
node lib/cli.js <the oldest registered path> --no-browser --json   # restarts the daemon
node scripts/marker-state.js restore /tmp/marker-state.json
```

`restore` re-registers oldest-first so the index ordering is unchanged, then
recreates each thread, its replies and its resolved state, and finally reads
the daemon back and diffs it against the backup. It exits non-zero and leaves
the backup in place if anything failed to come back. Registration ids are
`sha1(realpath)` so URLs survive; `createdAt` and the per-file comment ids do
not, because the API assigns those on create.

Templates and browser assets (`lib/templates/*.html|js|css`) are read from disk per request — edits show up on browser reload without restarting the daemon. Changes to `lib/*.js` (server, registry, api…) require a daemon restart (`stop`, then re-register files). Comments are in-memory and a restart discards them by design — see "Restarting the daemon without losing comments" above before stopping a daemon someone is reviewing on. `lib/vendor/*` is served with an ETag, so replacing a vendored bundle needs a hard reload.

## Architecture

markserv-marker is a fork of markserv v1.18.0 (first commit is the pristine import). One daemon on a fixed port (default 7642) serves every registered file; the CLI is only a thin client.

**Process/flow**: `lib/cli.js` probes `GET /api/health` (the response must have `name: "markserv-marker"`), spawns `lib/daemon.js` detached if nothing answers, then registers via `POST /api/files` and prints the URL. Two CLIs racing to start the daemon is resolved in `startHTTPServer` (lib/server.js): on `EADDRINUSE` the losing daemon probes health and exits 0.

**Request handling** (`lib/server.js`): no router — a connect middleware stack: `{markserv}`-prefixed bundled-asset handler → `/api` (lib/api.js, hand-rolled method+regex table) → `/f` (registered-file handler) → `/` (index page, favicon, 404). Files are served at `/f/<id>/<path>` where `id = sha1(realpath).slice(0,10)`; the file's **parent directory** is the serve root (relative images and sibling links work), guarded against path traversal by `resolveWithin`.

**State** (`lib/registry.js`): a module-level singleton holding registrations and their comments, in memory only. It is an EventEmitter (`register`/`unregister`) so the hot-reload watcher lifecycle can follow it. Comment ids are `<fileId>-cN`; threads are one level deep (a reply to a reply is re-parented to the root).

**Comment anchoring** — three cooperating mechanisms:
- `lib/source-line.js` (markdown-it plugin) stamps rendered blocks with `data-source-line(-end)`. It must come **after** markdown-it-highlightjs, which replaces the fence renderer and drops token attrs, so fences get attributes injected by wrapping the renderer. That injection only reaches a `<pre>` at the very start of the fence output. `lib/mermaid.js` is the one plugin that takes a fence over completely, which is why it comes after source-line and stamps the same attributes itself. A fence plugin has three choices: sit before source-line and emit a bare leading `<pre>`, sit after it and stamp its own attributes, or sit after it and wrap what the captured renderer returns, which is what `lib/diff-fence.js` does and which needs no stamping at all.
- On comment creation, `registry.narrowRange` shrinks the UI-reported block range to the lines the selected text (`quote`) actually touches, and a `snapshot` of those lines is stored. A short quote can occur several times in one block, so the browser also sends `quoteIndex`, the 0-based occurrence it selected counted over the block's rendered text; `narrowRange` and `highlightQuote` both honour it, clamping when source and rendered text disagree on the count. Absent `quoteIndex` means occurrence 0, which is what pre-existing comments get.
- `getThreads` recomputes `currentText`/`changed` per read and **re-anchors**: stored line numbers are frozen at creation, so when the snapshot text no longer sits at them but is found intact elsewhere, the thread reports the lines it occupies now and `changed` stays false. The copy nearest the original anchor wins, ties going to the earlier one. `snapshot.lineStart/lineEnd` keep recording where the comment was written, and threads are sorted on the re-anchored lines because the browser relies on that order for several comments on one block.

**Hot reload** (`startHotReload` in lib/server.js): one `ws` server; watchers are per-registration-root and refcounted. Messages are JSON envelopes `{type:'reload', html}` / `{type:'comments', fileId}`. The browser swaps `#marker-content` innerHTML and dispatches `marker:reload` / `marker:comments` CustomEvents, which `lib/templates/comments.js` listens to — it rebuilds all widgets idempotently (everything it creates is marked `data-marker-ui`) and preserves in-progress drafts in module state.

**Comment UI** (`lib/templates/comments.js`, vanilla JS, no build step): selection → floating Comment button (mousedown, not click, so the selection survives) → posts line range + quote. Quote highlights are re-found by whitespace-normalized text match, so they survive edits and reloads. Each comment carries a `delete` link, and the thread head carries a 🗑 button that takes the whole thread — the head is the only part a collapsed thread shows, which is the state a thread worth deleting is usually in. Both confirm first, and both stop the click from reaching the head, which would otherwise collapse the thread as well. A 204 to that `DELETE` is logged by Chrome as `net::ERR_ABORTED` because `api()` never reads the empty body; the request succeeds. View modes (all/unresolved/mark/plain) persist in localStorage. `render()` ends by dispatching a `marker:rendered` event, which is how features that read the widgets and highlights stay decoupled from it.

**Mermaid blocks** (`lib/mermaid.js` on the server, `lib/templates/mermaid.js` in the browser, bundle vendored at `lib/vendor/mermaid.min.js`): the server only wraps the fence in `<div class="marker-mermaid" data-marker-wrapper>`, leaving the `<pre><code>` inside byte-for-byte the shape every other fence has, so comments work on the mermaid source with no special case. The browser draws the diagram beside it and adds a per-block toggle. Three constraints hold this together. Everything the browser adds is `data-marker-ui`, because `textEntries` in comments.js would otherwise fold diagram labels into the quote-matching corpus and shift `quoteIndex` counting document-wide. The wrapper itself is **not** `data-marker-ui`, or its source would stop being commentable. And `insertionPoint` climbs out of `[data-marker-wrapper]` parents so thread widgets land after the whole block instead of among the diagram controls. `data-mode` is set by the browser only after a render succeeds, so a failed render or a missing bundle leaves the source visible. Per-block mode is keyed by the block's ordinal among the document's mermaid blocks, because hot reload replaces `#marker-content` wholesale.

**Diff blocks** (`lib/diff-fence.js` and `renderDiff`/`diffToHTML` in lib/server.js on the server, `lib/templates/diff-block.js` + `diff-block.css` in the browser, word diff shared through `lib/templates/diff-core.js`): a ```diff or ```patch fence is wrapped in `<div class="marker-diffblock" data-marker-wrapper>` and the browser draws a GitHub-style two-column comparison beside the source, toggling per block. It follows the mermaid pattern above, with three differences worth knowing. The plugin **wraps the previous renderer's output instead of replacing it**, so highlight.js still colours the source and source-line's attributes are already on the `<pre>` — a third option beyond the two the source-line note describes, and the reason it must sit after `./source-line`. `.diff` and `.patch` files get a page of their own through the same template, with content built by handing a synthetic fence token to the real fence renderer, so the file path and the fence path cannot drift; the whole file is one block stamped `data-source-line="1"` to its last line, because `registry.narrowRange` reads the real file and a synthetic markdown wrapper would shift every line by one. And the comparison is `data-marker-ui`, so comments are made on the unified source, exactly as with mermaid. Only the view being shown is in the DOM: hiding the comparison with CSS instead left it between the source and the toggle, and a selection dragged past the end of a line — which is where the toggle floats — ran on through it, pulling the other side's text and the line numbers into the quote and landing its endpoint inside `data-marker-ui`, where `blockOf` refuses to offer the Comment button at all. The source cannot be removed the same way, being what comments anchor to, so in split mode it is hidden and made `user-select: none`; the toggle carries the same, or ending a drag on it would take the endpoint into UI. Inside the comparison, a selection that leaves the cell it started in becomes a cell selection and the browser hands over every cell it touches, so dragging down one column copied the other column's text along with it, tab-separated. Each cell and gutter therefore carries `marker-diffblock-old` or `-new`, a `mousedown` listener marks the view `select-old`/`select-new` for the side the drag started on, and CSS makes the other side `user-select: none` — GitHub's trick for the same problem. A drag starting on a file or hunk header locks to the old side, since locking to neither is what the bug looked like. The parser ends hunks by counting the `@@` header's own line counts rather than by pattern, which is what lets `---` inside a hunk body be an ordinary deletion; a block with no header at all is treated as one hunk with no line numbers, since that is what most hand-written fences look like. Combined merge diffs and blocks past `ROW_CAP` rows are left as source with a note saying why. The CSS carries a `.marker-diffblock` prefix throughout because the github-markdown themes style `.markdown-body table td` and would otherwise turn the comparison into a bordered data grid. The block occupies exactly the width a paragraph does and long lines wrap inside their cell: a full-bleed treatment that broke out of the 978px body column was tried and reverted, because a block hanging outside the page frame reads as broken at any window width, and the page already has a width button for a reader who wants the room. Wrapping is also what keeps the two sides row-aligned, a table row sizing to its taller cell. Its colours are translucent overlays, one set for all four themes, the way the snapshot diff in comments.css does it; the unified source keeps highlight.js's own per-theme diff colours. The two palettes therefore differ, which was tried both ways: giving the comparison the `hljs-deletion`/`hljs-addition` classes matches it to the source exactly, and pushing these values onto those classes matches the source to the comparison, but that second one leaves the unified view too faint to read. The toggle's label names **the view being shown**, not what a click does — read as an action it looks like a state, and mistaking the two costs more than the wording saves; the tooltip carries the action.

**Markdown HTML comments** (`lib/templates/md-comments.js` + `md-comments.css`, browser-only — the server passes `<!-- ... -->` through verbatim, pinned in tests/source-line.test.js): each DOM comment node under `#marker-content` gets a `data-marker-ui` span inserted after it, holding the note as a real text node so it can be selected and copied; the `<!--`/`-->` delimiters are CSS pseudo-elements, so a copy picks up the note alone. `data-marker-ui` is what keeps the note out of the quote corpus (`quoteIndex` for existing threads never shifts) and keeps a selection inside it from spawning the Comment button. A selection straddling a note does pull the note's text into the quote, which then matches nothing — the thread still anchors to its lines, just without a highlight. A small toggle at the right end of the strip above the page frame (a `.marker-md-toggle` child of the `<article>`, created only when the document has comments) toggles `marker-md-comments-hidden` on `<body>`; the body class and the article sit outside `#marker-content`, so both survive hot reload. Persistence is localStorage `markserv-marker-md-comments`, absent = shown. `decorate()` rebuilds idempotently on `marker:reload`. The strip itself — `body.marker-doc` top margin, the positioned article, and the file-path display on the left (long paths collapse their middle segments to `…`, hover shows the full path in a tooltip below the bar, click copies it) — is laid out by markserv.css and rendered by an inline script in markdown.html.

## Testing gotchas

- The registry singleton is shared within a test file — tests are `test.serial` and clean up via `registry.reset()` or explicit unregister.
- ws clients in tests must connect to `ws://127.0.0.1:<port>`, not `localhost`: ava runs test files in parallel processes and the same port number can be bound on IPv4 by one file and IPv6 by another.
- `tests/comment-ui.test.js` runs the real `comments.js` inside jsdom with a mocked `fetch`; jsdom lacks `Range.getBoundingClientRect` and `scrollIntoView`, which the UI code guards for — keep those guards.
- `tests/mermaid-ui.test.js` does the same for `lib/templates/mermaid.js`, with a stubbed `window.mermaid` set before the eval. jsdom cannot run the real library, which is why `ensureLib` checks `window.mermaid` before injecting the bundle — keep that seam. What the diagram looks like and whether `display: none` hides anything are not tested there; jsdom has no stylesheets.
- `tests/source-line.test.js` shares one `fixture` whose line numbers every assertion hardcodes. Add a test with its own document rather than editing it.
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
