---
name: review
description: Human-in-the-loop markdown review via markserv-marker. `open` serves a markdown file in the browser for a human to leave selection-anchored comments; `resolve` reads the comments back over the API, fixes the file accordingly, replies and resolves each thread.
argument-hint: "[ open | resolve ] [file-path]"
allowed-tools: Read, Edit, Glob, Grep, Bash
---

markserv-marker review skill
===

[markserv-marker](https://github.com/0xys/markserv-marker) runs a single local daemon (default `http://localhost:7642`) that renders markdown with GitHub styling and lets a human select text in the browser and leave threaded review comments. Everything the browser UI does is also available as a JSON API, which makes this loop possible:

1. the agent serves a markdown file (`open`),
2. a human reviews it in the browser and leaves comments,
3. the agent reads the comments, edits the file, replies and resolves (`resolve`).

| Mode | Section | Description |
|------|---------|-------------|
| `open` | "Open mode" below | Register a markdown file with the daemon and open it in the browser for review. |
| `resolve` | "Resolve mode" below | Read unresolved comments, address each one by editing the file, then reply and resolve. |

**Prerequisite**: the `markserv-marker` command must be on PATH. If it is missing, tell the user to install it with `npm i -g markserv-marker` (or `npm link` from a checkout of the repository) and stop.

# Open mode

1. Determine the target markdown file from the argument or the conversation context. If neither identifies a file, ask the user.
2. Register it and capture the registration:
   ```console
   $ markserv-marker <path> --no-browser --json
   {"id":"<fileId>","url":"http://localhost:7642/f/<fileId>/<name>", ...}
   ```
   The daemon starts automatically if it is not running. Registration is idempotent — re-registering the same file returns the same `id` and `url`. Remember the `id`; `resolve` mode needs it.
3. Open the page for the user: `open "<url>"` (macOS). If that fails, just show the URL.
4. Report to the user:
   - the preview URL (and that the index of all served files is at `http://localhost:7642/`),
   - how to comment: select any text in the rendered page and press the floating Comment button; threads support replies and resolve,
   - that they should invoke this skill's `resolve` mode when they are done commenting.

# Resolve mode

1. Identify the target file: from the argument or context. If unknown, list the candidates with `GET http://localhost:7642/api/files` (each entry has `id`, `path`, and `comments: {total, unresolved}`) and pick the obvious one, or ask the user.
2. Fetch the work:
   - `GET /api/files/<id>/comments?resolved=false` — unresolved threads. Each thread has `lineStart`/`lineEnd` (1-based source lines), `quote` (the text the human selected), `body`, `author`, `replies`, and staleness info: `snapshot` (the lines as they were when the comment was written), `currentText` and `changed`.
   - `GET /api/files/<id>/content` — the current markdown source, for mapping line numbers to text.
3. Treat every thread as one review task. When there are several threads, track them as individual tasks so none is dropped. For each thread:
   - Understand what is being asked from `body`, `quote` and the anchored lines. If `changed` is `true`, the text has been edited since the comment was written — compare `snapshot.text` with `currentText` before acting; the feedback may already be outdated.
   - If the request is clear: edit the markdown file accordingly with the Edit tool. Do not touch content unrelated to the comment.
   - If the request is ambiguous, out of scope, or already outdated: do **not** guess. Post a reply asking for clarification (or explaining why no change was made) and leave the thread unresolved.
4. After addressing a thread, reply and resolve it:
   ```console
   $ curl -s -X POST http://localhost:7642/api/files/<id>/comments \
       -H 'content-type: application/json' \
       -d '{"parentId":"<threadId>","body":"<summary of the change>","author":"claude"}'
   $ curl -s -X PATCH http://localhost:7642/api/comments/<threadId> \
       -H 'content-type: application/json' -d '{"resolved":true}'
   ```
   - **Reply language**: write replies in the language of the current session (or the language the user has explicitly asked for). When in doubt, match the language of the comment you are replying to.
5. File edits reach the human's browser instantly via hot reload — no manual refresh is needed on their side.
6. Finish with a summary: how many threads were fixed and resolved, and which were left open with the reason (clarification asked, out of scope, outdated).

# Reference

## CLI

```console
$ markserv-marker <file-or-dir>      # register (auto-starts the daemon), open browser, print URL
$ markserv-marker <path> --json      # machine-readable: {"id","url","path","created",...} on one line
$ markserv-marker status             # daemon health + registered files (supports --json)
$ markserv-marker stop               # stop the daemon
$ markserv-marker daemon             # run the daemon in the foreground (to see logs)
```

Flags: `--port/-p` (default `7642`), `--address/-a` (default `localhost`), `--no-browser`, `--json`, `--theme dark|light|synthwave|solarized`, `--no-hotreload`, `--silent`, `--verbose`.

Registration is idempotent (`id` = hash of the file's realpath). Registering a file serves its whole parent directory under `/f/<id>/`, so relative images and sibling links work. Comments live in daemon memory only — `stop` discards them.

## API

Base URL `http://localhost:7642`. All bodies are JSON.

| Method & path | Description |
|---|---|
| `GET /api/health` | `{name:"markserv-marker", version, pid, startedAt, port, files}` — also how to detect the daemon |
| `GET /api/files` | Registered files: `{id, path, name, type, url, registeredAt, comments:{total,unresolved}}` |
| `POST /api/files` | `{path}` → `201 {id, url, created:true}` (`200` + `created:false` if already registered) |
| `GET /api/files/:id` | One registration |
| `DELETE /api/files/:id` | Unregister (drops its comments) |
| `GET /api/files/:id/content` | `{path, lines, content}` — raw markdown source for line mapping |
| `GET /api/files/:id/comments` | Threads; filters: `?resolved=true\|false`, `?since=<ISO 8601>` |
| `POST /api/files/:id/comments` | Root: `{line}` or `{lineStart, lineEnd}` + `{body, author}`, optional `{quote}`. Reply: `{parentId, body, author}` |
| `PATCH /api/comments/:id` | `{resolved: true\|false}` and/or `{body}` — resolve works on thread roots only |
| `DELETE /api/comments/:id` | Delete a comment (a root takes its replies with it) |
| `POST /api/shutdown` | Stop the daemon |

Comment object shape (threads returned by `GET .../comments` are roots with a `replies` array):

```json
{
  "id": "<fileId>-c1",              // globally unique; threads are one level deep
  "lineStart": 12, "lineEnd": 14,   // 1-based source lines, inclusive
  "quote": "selected text",         // what the human selected (null if none)
  "snapshot": {"lineStart": 12, "lineEnd": 14, "text": "..."},  // the lines at comment time
  "currentText": "...",             // those line numbers now
  "changed": false,                 // true when the commented lines were edited since
  "parentId": null,                 // set on replies
  "author": "reviewer", "body": "...", "createdAt": "<ISO>", "resolved": false
}
```

Validation errors come back as `{"error": {"code", "message"}}` with a 4xx status.

# Constraints

## MUST
- Reply with `"author": "claude"` on every comment this skill posts.
- Reply before resolving, so the human can see what was done to each thread.
- Write replies in the session language (or the user-specified language); match the original comment's language when in doubt.
- Keep edits scoped to what each comment asks for.
- Report threads that were intentionally left unresolved.

## MUST NOT
- Resolve a thread whose feedback was not actually addressed.
- Guess at ambiguous feedback — ask via a reply instead.
- Rewrite unrelated parts of the document while addressing a comment.
- Delete or edit the human's comments.
