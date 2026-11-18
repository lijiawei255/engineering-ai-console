# AGENTS.md — module boundaries, security invariants and verification contract

This file is for engineers (and local coding agents) who maintain this repository. It records the parts
that must not be changed casually: the `server.py` security boundary, the dual-protocol adapter layer,
the four-language dictionary contract, the Solarized scaling rules, and the commands that decide whether
a change is acceptable.

## 1. System purpose and hard boundary

The console is **Agent 1** in a four-step engineering loop. It reasons, drafts implementation instructions and
distills audit reports. It does not execute code, does not run tests, and does not edit the user's project.
The execution agent (Agent 2) and the adversarial audit agent (Agent 3) run in separate context-isolated
local windows, each in a clean context of its own, and communicate with Agent 1 only through the manual
copy/paste buffer operated by the human.

Consequences for contributors:

- Do not add tool-execution, shell, filesystem-wide or remote-control endpoints to the local service.
- Do not let the console "fix" code or claim it ran anything. It only produces text for a human.
- Keep the manual copy/paste boundary: no automatic paste-back, no auto-apply of audit suggestions.
- The engineering and industrial-safety boundary is stated in section 6 of all four READMEs
  (`Engineering & Safety Disclaimer`, `工程与工业安全免责声明`,
  `Avertissement d'ingénierie et de sécurité industrielle`,
  `Инженерная и промышленная оговорка по безопасности`); this contract does not loosen it.

Local Git discipline follows the same human boundary: once a round passes every local verification gate,
Agent 2 records the work as modular **local checkpoint commits** — rollback anchors for the human and clean
incremental diffs for Agent 3. Agent 3 is strictly read-only, and `git push`, remote `gh` writes or
destructive history rewriting stay with the human lead designer.

## 2. Repository map

```
src/app/                 application shell, theme/font-scale wiring, global UI state
src/components/          UI: top bar, action capsules, composer, messages, settings, sider
src/components/markdown/ markdown/KaTeX/Mermaid/Prism rendering (copied and adapted from upstream)
src/services/api/        URL normalization, dual-protocol serialization, SSE parsing, watchdogs, probes
src/services/attachments/ local text decoding, Office XML extraction, truncation guard
src/services/chat/       session store, IndexedDB persistence, drafts, reset, plain-text export
src/services/config/     channel/UI/prompt configuration, deterministic sanitizers, persistence
src/services/markdown/   parse/highlight/katex/mermaid loaders, code-fence balancer
src/services/search/     Exa retrieval client
src/prompts/             Agent 1 persona and the three capsule templates (EN/ZH/FR/RU)
src/i18n/                en.ts (source of truth), zh.ts, fr.ts, ru.ts, runtime translate helpers
server.py                single-file Python 3.9+ local micro-service
start.bat / start.sh     launchers: double-click runs windowless with --auto-exit, arguments stay foreground
scripts/                 build helpers (third-party license bundle)
tests/                   logic, browser-document, server-security and privacy self-tests
dist/                    committed production build; no source maps
```

## 3. `server.py` security invariants (red lines)

Any change here must keep all of the following true; the server self-test enforces most of them.

1. **Loopback only.** Bind `127.0.0.1`. Never `0.0.0.0`, never a LAN interface, never a configurable host.
   `allow_reuse_address` must remain disabled on Windows, otherwise two processes can bind the same port
   and port self-healing breaks.
2. **Origin + token for every `/api/*` call.** A per-process `SESSION_TOKEN` (48 hex chars) is injected as
   `<meta name="console-session-token">` into served HTML. Requests must send
   `X-Console-Token` and, if an `Origin` header is present, it must exactly equal
   `http://127.0.0.1:<actual port>`. The single deliberate exception is `GET /api/health`, which accepts a
   request without the token so the launcher can detect an already running instance; the Host check and
   the same-origin `Origin` check still apply to it, and every other `/api/*` route requires the token.
   Without `--port`, startup scans the whole `18765..18795` range for a live `/api/health` response that
   carries this console's service identity and reuses that exact port; only when nothing is found does it
   bind `18765` (or the next free port up to `18795`).
3. **Static files are read from `dist/` only.** Resolve with `Path.resolve()` and verify
   `relative_to(DIST_DIR)`; reject NUL bytes and traversal. No other disk reads are allowed.
4. **Configuration is written to the data directory only** (`--data-dir`, default `.console_data/`).
   No arbitrary file write API.
5. **Bounded request bodies.** Configuration endpoints: 1 MB. Chat and file forwarding: 32 MB.
   Always require a valid `Content-Length`; reject `Transfer-Encoding`; never call an unbounded
   `rfile.read()`.
6. **Explicit socket timeouts.** Chat forwarding, model ping/probe and file upload/delete pass
   `timeout=channel.requestTimeoutSec` (clamped 5..600 s). The opt-in Exa search handler
   (`handle_exa_search`) uses its own bounded 30-second timeout instead, so a slow search endpoint
   can never inherit a channel's larger budget.
7. **Streaming hygiene.** Flush each SSE chunk. On client disconnect
   (`BrokenPipeError` / `ConnectionResetError` / `ConnectionAbortedError`) close the upstream response in
   `finally` and exit the thread silently — no stack traces, no zombie connections. Once the `200
   text/event-stream` header is sent, a later upstream read failure must be reported as one standard
   `event: error` SSE frame; never write a second HTTP 500 response header or JSON error body into the
   stream, and never let the generic router exception handler emit one either. An upstream read failure
   (TCP reset, read timeout, chunked framing error) is not a client disconnect: it must still produce that
   frame, prefixed with a blank line so a partial newline-less chunk cannot swallow the event boundary.
8. **No naked arbitrary-target proxy.** Chat, ping and model probes take the upstream URL from the saved
   channel slot (or, for probe-only, a sanitized draft used strictly for that probe). The client cannot
   name an arbitrary URL for chat forwarding.
9. **Secrets never reach the page.** `/api/config` returns only `hasKey`, the last four characters,
   `envSet` and a 12-hex one-way `keyFingerprint` of the effectively resolved credential (never the
   plaintext). Keys live in `secrets.json`; `settings.json` never contains them. Environment variables
   configured by name take priority over stored keys. Custom header values follow the same rule: the plaintext
   lives only in `secrets.json`, `/api/config` returns `{name, mask}` for each header, and `settings.json`
   stores the name with an empty `value`. A non-empty value in a config POST replaces the stored one, an
   empty value keeps it, and a name missing from a slot's submitted list is deleted. A custom-header update
   payload only rewrites the slot(s) it actually contains; the other slot's `secrets.json` keys must be
   preserved verbatim. A whole-`settings` POST is never allowed to interpret empty header values as
   deletions for a slot.
10. **Atomic storage.** Under `CONFIG_LOCK`: write `<name>.<pid>.<random>.tmp` → `flush` + `os.fsync` →
    re-parse JSON → copy the previous valid file to `.bak` → `os.replace`; remove any leftover temp file.
    The pid plus random suffix keeps concurrent writers from sharing one temp path. POSIX secret files are
    `0600`. A corrupt primary file is recovered from `.bak` and flagged in the storage health payload.
    When one request changes both files, snapshot both original byte buffers first, write `secrets.json`
    first, then `settings.json`; if the second write fails, restore the secrets bytes inside the lock before
    raising. Clearing a key or deleting a header must also scrub the corresponding stale value from
    `secrets.json.bak`. Legacy plaintext-header migration writes and verifies `secrets.json` before erasing
    plaintext from `settings.json` / its `.bak`; a failed migration keeps the in-memory credential, leaves
    the plaintext on disk, and reports `storage.degraded` instead of silently swallowing the error. Once the
    migration write and the `settings.json` cleanup both succeed, the fresh `secrets.json` is immediately
    mirrored into `secrets.json.bak` (`_sync_backup_from_main_locked`) and the cleaned `settings.json` into
    `settings.json.bak`; `atomic_write_json` alone only copies the *previous* file into `.bak`, so without
    this explicit mirror a later crash would recover a backup that lacks the just-migrated header values.
    A failed mirror of either file sets its sticky dirty flag and keeps `storage.degraded` set. The
    pending credential stays in memory (`_legacy_migration_pending`) and the next ordinary save — even one
    that only changes a UI setting — merges it into that request, attempts `secrets.json` first, and fails
    with a 500 without rewriting `settings.json` while the secrets write cannot succeed.
    Backup cleanup is sticky: when the primary write succeeded but the `.bak` replacement failed, a
    `secrets_bak_dirty` / `settings_bak_dirty` flag is persisted as `<name>.bak.dirty` (so it survives a
    restart) and stays set, `storage.degraded` is never reset by a later read, the `.bak` overwrite is
    retried from the clean primary under `CONFIG_LOCK`, and the dirty backup is never used to recover
    state while the flag is set. A dirty flag may only be cleared after `_sync_backup_from_main_locked`
    atomically replaces the `.bak` with the exact current primary bytes; an unrelated slot save or the
    absence of a new deletion never clears it, and every successful primary write mirrors its current bytes
    into the matching `.bak`.
    Configuration error responses never echo local disk paths or temp file names; they return a stable
    redacted error code.
11. **Startup scripts stay minimal.** No registry access, no update checks, no service installation and no
    daemon that outlives the console page. An argument-free launch is the everyday path: `start.bat` verifies
    Python >= 3.9, resolves the sibling `pythonw.exe` and starts `server.py --auto-exit` detached with
    `start "" "<pythonw>" ...`, then exits the CMD window with status 0; `start.sh` passes `--auto-exit` for
    the same reason. With any argument (`start.bat --port 18770`, `start.bat --foreground`) both launchers stay
    in the foreground on `python.exe` so the real Python output and errors remain visible; `server.py`
    registers `--foreground` itself and forces the resident mode even when `--auto-exit` is also passed, and
    the launchers forward their arguments verbatim; a non-zero exit must
    keep that error visible and return non-zero, never claim that Python was not found. `server.py` must survive
    a console-less interpreter: at entry, a `sys.stdout` / `sys.stderr` that is `None` or unwritable is
    redirected to `os.devnull`, so `print()`, handler error logs and tracebacks can never turn a valid request
    into a crash. `start.sh` is fixed at mode `100755` in the Git index
    (`git ls-files -s start.sh` reports `100755`) and stays pure LF, so `git archive` exports the
    executable bit intact: the extracted file is `100755`, or `100775` when the caller's `tar.umask`
    widens the group/other write bits. Either result remains directly runnable as `./start.sh` after a
    fresh Linux/macOS/WSL clone or archive.
12. **Tag-lifecycle auto-exit is opt-in and page-driven.** Only `server.py --auto-exit` (what both launchers
    use) creates a lifecycle monitor; the default resident invocation (`python server.py --no-browser`, all
    automation, every other self-test) must keep running regardless of page state, and
    `--foreground` explicitly selects that resident mode even alongside `--auto-exit`. `GET /api/health`
    exposes `autoExit` and `activeTabs` (0 without a monitor), so the launcher probe and the production-entry
    self-test can tell whether a real page heartbeat has arrived. `POST /api/lifecycle`
    accepts `{"action": "heartbeat" | "leave", "tabId": "<id>"}`, requires the same `Host` / `Origin` /
    `X-Console-Token` checks as every other `/api/*` route, and is a 200 no-op when the monitor is absent. The
    monitor allows 60 s for the first heartbeat, waits a 5 s refresh buffer after the active tab table drops to
    zero (an F5 reload registers a new `tabId` well inside that window), treats 600 s of silence as a crashed
    browser, and calls `httpd.shutdown()` only when no `/api/chat` or `/api/config` request is in flight, so a
    normal close ends the process with exit code 0. The page side (`src/services/config/lifecycle.ts`, wired
    from `src/main.tsx` only in server mode) sends one heartbeat on mount, one every 20 s and on
    `visibilitychange` back to visible, and a keepalive `leave` on `pagehide`; the mount heartbeat reads the
    process token straight from the injected `<meta name="console-session-token">`, not from the config store,
    because `initConfig()` has not resolved yet at that point and an empty store token must never silently
    disable tracking; every lifecycle fetch failure is
    swallowed so page unload never produces an unhandled rejection.

## 4. Dual-protocol adapter layer

- `src/services/api/url.ts` — pure URL normalization for chat, models and files. OpenAI accepts host,
  `/v1`, or full `/chat/completions`; Anthropic accepts host, `/v1`, `/anthropic`, or full `/messages`.
  `lockRawUrl` bypasses joining and requires a complete URL. A base URL that already ends with `/messages`
  is handled explicitly: `normalize_files_url` replaces that suffix with `/files` instead of appending a
  new path segment, so the Anthropic Files API is never called as `.../v1/messages/v1/files`. Changing
  this must be mirrored in `server.py` (`normalize_chat_url`, `normalize_models_url`, `normalize_files_url`)
  and covered by both the logic self-test and `tests/server_selftest.py`.
- `src/services/api/serialize.ts` — neutral history → protocol body. Two invariants:
  1. OpenAI `messages[].content` must be a **plain string** whenever no inline images are present.
  2. History contains only user text and assistant text; reasoning blocks are never replayed. This is what
     makes a mid-conversation switch between OpenAI and Anthropic lossless.
- Thinking fields are driven exclusively by `thinkingParamMode`; never inject vendor-specific fields by
  default. The default OpenAI-compatible channel stays on `none` (standard passthrough), so even with
  the deep-thinking switch on the body carries only `model`, `messages` and `stream`; that switch only
  substitutes `thinkingModel` unless a request format is chosen in the channel's Advanced settings.
  `modalityMode` controls inline-image inclusion and the automatic downgrade path. Anthropic
  extended thinking and a custom `temperature` are mutually exclusive: when `anthropic_thinking` is
  actually active for the round, the custom temperature must be omitted rather than sent and rejected
  with a 400.
- Remote `file_id` ownership is a fingerprint of
  `channelSlot + normalizedFilesUrl + keyFingerprint` (`remoteFileFingerprint`). `keyFingerprint` is
  computed from the credential that will actually be sent: `server.py` applies `resolve_api_key()` and
  returns `hashlib.sha256(resolved_key).hexdigest()[:12]` (or `"none"`) in `/api/config`; static mode
  computes the same value locally with the bundled synchronous SHA-256. An `apiKeyEnv` name that is
  configured but not set (`envSet=false`) is not a credential and must never affect the fingerprint, so
  rotating the stored key changes it immediately. `serialize.ts` may emit an Anthropic `document` block
  only when the stored fingerprint matches the current channel; a slot, endpoint or effective-key change
  must degrade to the explicit re-upload notice instead of sending a stale file id. When
  `enableRemoteFileApi` is off, no `document` / `file_id` block may be emitted even if history still
  carries a matching fingerprint.
- `src/services/api/files.ts` — upload context carries the slot and effective-key fingerprint; deleting a
  remote file uses the original upload slot and that slot's custom headers. Never delete with the
  currently active channel when the attachment was uploaded through another slot.
  **Both `uploadRemoteFile()` and `deleteRemoteFile(context, origin, fileId)` call
  `await ensureConfigSynced()` before doing anything else**, then rebuild the effective context from the
  config store (channel, token, effective-key fingerprint) and recompute the ownership fingerprint from
  that synced state: a 350 ms debounced edit must never let a file upload hit the previous gateway or a
  DELETE target another endpoint/credential space. `ensureConfigSynced()` waits for **both** the debounced
  settings save and every in-flight credential write (`setSecret` / `clearSecret` / `setCustomHeaders`):
  rotating only the API key does not bump the settings revision, so without the credential barrier an
  upload could reach the service with the new key while the attachment still records the old
  `keyFingerprint`. `uploadRemoteFile` returns the fingerprint computed after the sync so
  `attachments/index.ts` records unwrapped ownership rather than a pre-sync snapshot. A credential
  write that fails with HTTP 500 (locked `secrets.json`, disk error) retains its intent in a pending
  patch; `ensureConfigSynced()` then performs at most one merged retry POST (pending credentials plus
  unsaved settings), applies the 200 snapshot and its new `keyFingerprint` on success, and throws
  immediately when the service is still unwritable so the upload / chat aborts instead of continuing
  on a stale credential. A single call never issues more than two configuration POSTs.
  `deleteRemoteFile` refuses to send anything when the uploaded slot's `enableRemoteFileApi` is now off
  (local removal only) or when the synced origin no longer matches. `ChatInput.removeAttachment` performs
  the same switch check before even constructing a context, so turning remote parsing off never produces
  an outbound request.
- `src/services/api/stream.ts` — dual SSE parsing, `</think>` / `reasoning_content` handling, first-byte
  and idle watchdogs, one transient retry (429/502/503/504, 1.2 s), one modality downgrade retry on
  400/415/422. The downgrade is refused when the latest user message of the round contains only images
  (no user text, no text-like attachment), no matter how much text earlier rounds carry: that case must
  surface `image-only`, roll the round back and restore the image draft instead of re-sending without
  images. A `200` response whose `Content-Type` is not `text/event-stream` is not fed to the SSE reader:
  `server.py` relays such a body with its real JSON / plain-text type and `parseNonSseBody()` turns it into
  one terminal frame (error message, full completion, or plain text), so a gateway that ignores
  `stream: true` produces a readable answer or error instead of “stream ended before a completion
  marker”. Gateway error payloads flattened at the top level (`{"code":30014,"message":"..."}`) must be
  understood as errors as well. Keep `ThinkTagSplitter`, `parseNonSseBody` and the frame parsers exported
  and pure so the logic self-test can exercise them without a browser.
- `src/services/api/headers.ts` — direct static-mode headers only. Server mode auth is built in
  `server.py`; never accept client-supplied auth headers for chat forwarding.
- Outbound requests in server mode carry a clean default client identity and protocol-matching `Accept`
  (`DEFAULT_USER_AGENT`, `text/event-stream` for chat, `application/json` for probes/files/search). The
  default is applied only when no non-empty custom header of the same name exists, so a user-supplied
  `User-Agent` or `Accept` always wins. This exists because `urllib`'s default `Python-urllib/3.x` is
  blocked by some WAFs on `POST /chat/completions` while `GET /models` still passes — the exact
  “connectivity passes, chat fails” trap.
- No vendor host, preset endpoint or model enum may be added anywhere. Exa's default endpoint is the only
  allowed external default (opt-in search).

### Outbound traffic inventory

The repository documents every request that can leave the machine. The list is split by stage so that
"attachments stay local" can never be misread as "nothing is sent once you press send":

- **Adding an attachment to the draft (before pressing send).** Source code, logs, configuration,
  Office documents (`.docx` / `.xlsx` / `.pptx`) and images are decoded, unzipped or encoded entirely
  in the browser and produce **no network request**. The only exception is a `.pdf` added or removed
  while a channel has the opt-in `enableRemoteFileApi` switch on: adding it sends `POST .../files`,
  removing a not-yet-sent draft PDF sends `DELETE .../files` to that channel's Files API endpoint.
- **Pressing send.** Locally extracted text (wrapped in `<attached_file>`) and inline image data, or a
  remote PDF's `file_id`, become part of the round's chat context and travel with the chat request to
  the model endpoint of the currently active channel.
- **Connectivity test and Fetch models.** Both send one `GET .../models` request carrying that
  channel's credentials (forwarded by `server.py` in server mode, direct in static mode).
- **Exa retrieval** (opt-in): search requests go to the configured Exa endpoint.
- **Remote PDF upload / removal** (opt-in, `enableRemoteFileApi`): the `POST` / `DELETE .../files`
  requests described above.

Nothing else initiates an outbound connection. The list counts **business requests**: in `file://`
pure-static direct mode the browser may first emit a credential-free `OPTIONS` preflight request under
the standard CORS rules before a cross-origin chat, model, Exa or Files request is issued. That preflight
carries no API key or custom header value; it is generated by the browser, not by the console.

## 5. Attachment pipeline

- Decode order is fixed: UTF-8 (`fatal: true`) → GB18030 (`fatal`) → windows-1252. Do not reorder.
- `.docx` / `.xlsx` / `.pptx` are parsed locally with `fflate.unzipSync` + native `DOMParser`,
  namespace-agnostic (`localName`) and deterministic. No regex-based binary guessing.
- Archive expansion is budgeted before any XML is inflated: entry names and declared sizes are collected
  with a `filter` callback only, then the parse is refused (`officeTooLarge`) when the archive has more
  than 500 entries, any single entry declares more than 4 MB, or the declared total exceeds 10 MB. After
  the guard passes, only the required XML parts are decompressed, still through a filtered `unzipSync`.
- Inline vision accepts only `image/png`, `image/jpeg`, `image/webp` and `image/gif`. `.svg` is handled by
  the plain-text XML path; other image types (`bmp`, `avif`, `tiff`, …) are rejected with an explicit
  unsupported-format message instead of being sent as image blocks. When the file system reports
  `application/octet-stream` but the extension / magic number identifies a supported image, the Base64
  Data URL header MIME must be rewritten to the real image type so the Anthropic serializer emits the
  correct `media_type`. A file with neither a MIME type nor an extension is sniffed from its first 12
  bytes (PNG / JPEG / GIF / RIFF-WEBP signatures) and then follows the normal image path.
- Remote Files API parsing is opt-in. Only `.pdf` is a valid remote `document` block; legacy binary
  `.doc` / `.xls` / `.ppt` and audio files stay deterministically rejected even when remote parsing is
  enabled. Remote file ownership follows the fingerprint rule in section 4.
- DOCX extraction walks `w:sdt` / `w:sdtContent` content controls recursively (paragraphs and tables, in
  document order). A table cell's text is collected in DOM child order and recurses into nested `w:tbl`
  tables inside that cell, so `[paragraph, nested table, paragraph]` becomes one flattened cell value
  instead of silently dropping the inner table. DOCX table construction and XLSX worksheet extraction /
  Markdown assembly each enforce a live 250,000-character output budget and append a truncation marker
  instead of first building a multi-megabyte intermediate string. DOCX rows are pre-checked as
  `currentLength + nextRowLength` before being appended, so the final text including the truncation
  marker stays strictly below 256,000 characters. XLSX sheets whose non-empty cells all sit beyond
  column 64 must report the column-limit truncation, never `(empty sheet)`.
- The three Office extractors additionally enforce **one document-wide UTF-8 byte budget** (240,000
  bytes, measured with `TextEncoder`) across paragraphs, tables, worksheets and slides. Once the
  accumulated bytes reach the budget, parsing of the remaining blocks stops, a document-level truncation
  marker is appended (`truncated: true`), and the whole intermediate string returned by `office.ts` stays
  strictly below 256,000 bytes even for multi-table / multi-sheet / multi-slide input. A per-table or
  per-sheet character budget alone is not enough: one huge block still exceeds the byte limit, and CJK
  text costs three bytes per character.
- Extracted text over 200 KB is truncated to first 120 KB + last 60 KB with a clear byte-count marker.
- Never send an attachment as a bare string without the `<attached_file name="...">` wrapper.

## 6. Four-language dictionary contract

- `src/i18n/en.ts` is the source of truth. `zh.ts`, `fr.ts`, `ru.ts` must satisfy
  `Record<keyof typeof en, string>` (compile-time) and additionally:
  - identical key sets,
  - no empty values,
  - identical `{placeholder}` sets per key.
- Default locale is **English (`en`)** when no saved setting exists. Never infer from the browser language.
- Language names in the selector are native self-names: `English`, `简体中文`, `Français`, `Русский`.
- FR/RU translation must be native engineering prose, not literal machine translation. Reference terms:
  `Réinitialisation douce / complète`, `Générer l'instruction d'exécution (Agent 2)`,
  `Générer l'audit critique (Agent 3)`, `Synthétiser le rapport`; `Мягкий / Полный сброс`,
  `Задание исполнителю (Агент 2)`, `Запрос на жёсткий аудит (Агент 3)`, `Сводка по отчёту`.
- The logic self-test fails the build if dictionaries drift; do not weaken those assertions.

## 7. Theme, typography and scaling

- Solarized palette only. Canonical values are listed at the top of `src/app/theme.css`; do not introduce
  pure black/white blocks or arbitrary accent colours. Code highlighting maps into Solarized via
  `src/components/markdown/highlight.css`.
- Scaling uses `--console-font-scale` (0.9 / 1 / 1.12 / 1.25) applied on `:root`. **Never use `zoom`.**
  All font sizes — including the 15 `--dsw-font-*` composite values — are `calc(Npx * var(--console-font-scale))`.
  Containers that can wrap use `flex-wrap` and `min-height`, not fixed heights.
- Content width is switched by `body[data-content-width='standard'|'wide']`; message width variables live in
  `src/app/global.css`.
- `reduceFlicker` (default on) maps to `body[data-reduce-flicker='true']` and must disable looping pulses,
  bouncing dots and shimmer. Streaming markdown must balance unclosed code fences in the temporary parse
  string only — never mutate stored message content.
- Mermaid uses Solarized `themeVariables`; keep it in sync when palette values change. Diagram-internal
  `%%{init: ...}%%` directives and a leading YAML frontmatter block are stripped before rendering and
  `themeCSS` stays empty, so diagram syntax cannot override the Solarized background or the scaled font
  size. External image references are stripped both before render and from the produced SVG.
- Streaming fence balancing only closes a fence whose info string is legal CommonMark: a backtick-opened
  fence whose info string contains a backtick is not a fence at all.

## 8. Build and verification commands

All commands run from the repository root.

```bash
pnpm install
pnpm type        # tsc, 0 errors — success signal: empty output, exit 0
pnpm lint        # oxlint, 0 errors — success signal: "0 warnings and 0 errors"
pnpm build       # rspack build + license bundle — success signal: dist/ populated, no *.map, dist/LICENSE has both copyright lines, dist/THIRD_PARTY_LICENSES.txt lists every runtime dependency and carries the embedded-notice scan
pnpm test        # orchestrates all four self-tests below
```

Individual checks:

```bash
node tests/run-logic-selftest.mjs   # 1600+ assertions; prints "SELFTEST RESULT: N passed, 0 failed"
node tests/run-browser-selftest.mjs # builds tests/.browser, serves it over http://127.0.0.1 and runs headless Edge/Chromium (EDGE_PATH/CHROME_PATH override)
python tests/server_selftest.py     # starts the real server on a free port; prints "SELFTEST RESULT: N passed, 0 failed"; the production-entry case also launches headless Edge/Chromium (EDGE_PATH/CHROME_PATH override)
node tests/privacy-scan.mjs         # prints "privacy scan: 0 hits"
```

The privacy scan checks source, tests and `dist/` for absolute user paths, the current username,
the upstream temp-directory residue (its mandated .gitignore rule is the only whitelisted occurrence), upstream vendor hosts, secret-shaped
strings and shipped source maps. The browser self-test needs a Chromium-family browser; the server
self-test needs Python 3.9+ and, for the real production-entry lifecycle case, the same
Chromium-family browser.

Self-test items added for the security and attachment hardening must stay covered:

- server self-test: token-less `GET /api/health` succeeds while a wrong `Origin` still gets 403, foreign
  `Host` headers are rejected, cross-origin redirects are refused without leaking auth or custom headers,
  custom-header values are masked in `/api/config` and absent from `settings.json`, and a second launcher
  instance detects the running service instead of binding a new port. It also covers: a primary-only
  custom-header update preserving the other slot's secret; a failing `settings.json` write rolling the
  `secrets.json` bytes back with no temp residue and a path-free 500 body; a failed legacy plaintext
  migration keeping the secret and reporting `storage.degraded`; clearing a key scrubbing
  `secrets.json.bak`; a foreign listener on `18765` still yielding reuse of an instance on `18766`; and a
  stream that starts then times out emitting one legal SSE `event: error` frame with no embedded HTTP 500.
  It also covers the sticky backup guard: clearing a key while the `.bak` replacement fails keeps
  `storage.degraded` true across later reads and refuses to recover state from the dirty backup, and an
  unlocked read resynchronizes `.bak` so the revoked key never reappears; the on-disk dirty marker is
  reloaded by a fresh `ConfigStore` (simulated process restart), which still refuses the dirty backup and
  finishes the resync once the replacement succeeds; plus upstream TCP resets and half-line read timeouts
  each emitting one legal blank-line-prefixed `event: error` frame. Newer coverage: a dirty `.bak` marker
  only clears after a byte-exact resync (including a missing `.bak`, and while another slot is saved with
  the backup still locked); an ordinary save during a pending legacy migration that cannot write
  `secrets.json` returns 500 and leaves the `settings.json` plaintext untouched; `/api/config` exposes a
  12-hex effective-key fingerprint that changes when the stored key rotates behind an unset `apiKeyEnv`;
  an upstream `Content-Length` that closes early emits the documented truncation frame while a complete
  body does not; the four READMEs and the built license bundle carry the remote-file / Node.js, mhchem /
  OFL and Thenable copyright statements as well as the acknowledgment / non-affiliation section. Latest
  coverage: the legacy-header migration immediately mirrors the fresh `secrets.json` into
  `secrets.json.bak` (and the cleaned `settings.json` into its `.bak`), a forced backup-mirror failure sets
  the sticky dirty marker and `storage.degraded`, a truncated `secrets.json` plus a fresh instance recovers
  the migrated header from `.bak` and a real forwarded chat request carries that header upstream; and a
  no-git source copy still lets `tests/privacy-scan.mjs` fall back to recursive traversal, scanning at
  least 230 files with zero hits. Latest documentation and packaging coverage: each of the four READMEs
  documents the two-stage attachment flow (draft stage sends nothing except the opt-in remote PDF
  upload / removal; the send stage transmits the extracted text and images with the chat request) and the
  `Fetch models` button's outbound `GET .../models` probe next to Test connection, chat, Exa and the
  Files API; the
  license bundle carries the Cure53 / KaTeX SVG glyph (Khan Academy, Design Science) / mhchem / Thenable
  attributions plus the pre-bundled upstream packages discovered by the source-map scan (js-yaml,
  path-browserify); and `git -c core.autocrlf=true archive HEAD` exports `start.sh` with no CR bytes and
  the executable bit preserved (tar mode `100755`, or `100775` under a permissive `tar.umask`). Latest
  configuration-recovery coverage: a real open-handle lock on `secrets.json` makes a key save return 500
  with the stable `configPersistFailed` code, no path echo, byte-identical secrets and no temp residue,
  and the same save succeeds with the new fingerprint once the lock is released; and the license section
  verifies both pre-bundled packages plus the zero-omission source-map audit result. Latest
  archive-integrity and outbound-documentation coverage: `git -c core.autocrlf=true archive HEAD` is
  extracted in memory and all 151 `dist/` files plus the root `LICENSE` match their `git cat-file` blobs
  byte-for-byte by SHA-256 (zero LF→CRLF conversions), and each of the four READMEs documents the
  credential-free `OPTIONS` CORS preflight as well as Exa's independent bounded 30-second timeout.
  Latest prompt, README and license coverage: each of the four READMEs explains why Agent 1 is still the
  cloud / pure-dialogue role (it mounts neither the local project directory nor a terminal) while Agents
  2 and 3 mount the project folder and drive the real compiler and test toolchain; and the license bundle
  carries the static JamaJS (NIST JAMA public domain) SVD-routine and jQuery (OpenJS Foundation, MIT)
  event-object source index as well as the KaTeX font-metadata line
  `Copyright (c) 2014-2018 Khan Academy`, kept distinct from the `2014-2017` SVG glyph notice. Latest
  outbound and lifecycle coverage: a recording mock upstream proves the model probe and chat forwarding
  carry the clean default `User-Agent` plus the protocol `Accept` while a user-supplied `User-Agent` wins;
  an upstream `403` with `{"code":30014,"message":"Token is invalid."}` surfaces the readable message and
  code instead of the raw JSON; a `200` JSON error body and a `200` JSON completion keep their real
  `Content-Type` and are relayed verbatim while a real SSE upstream is still relayed as
  `text/event-stream`; and an `--auto-exit` subprocess exits with code 0 about 5 s after the last
  `leave`, survives an F5-style heartbeat inside the buffer, answers `/api/config` afterwards and stops
  cleanly; the accelerated `LifecycleMonitor` unit cases cover the 60 s startup grace, refresh-buffer
  cancellation, the in-flight `/api/chat` guard, the silent-browser timeout and the auth failures of
  `/api/lifecycle`; `sys.stdout = None` / `sys.stderr = None` still serves `/api/config` and a config
  write without a crash, a real `pythonw.exe` subprocess answers `/api/health`, and both launchers are
  checked for the `--auto-exit` contract. Latest production-entry, launcher and lifecycle regression
  coverage: a real `server.py --auto-exit` process serving the built `dist/` is opened in a headless
  browser through the DevTools HTTP endpoints with no injected JavaScript, `/api/health` reports
  `activeTabs >= 1` within 3 s while the same page's `main.tsx` emits its mount heartbeat, and closing
  that real page makes the service exit with code 0 about 5 s later; `server.py --foreground --no-browser`
  and `start.bat --foreground --no-browser` both parse, start normally, and report `autoExit: false` even
  when `--auto-exit` is also passed; `/api/health` also exposes `activeTabs` as 0 for a resident service
  with no lifecycle monitor.
- browser self-test: Office archives over the entry/size budget are refused before decompression,
  `w:sdt` content controls are extracted recursively, wide DOCX tables stay inside the 250 KB budget,
  sparse workbooks do not allocate dense arrays and report the truncation marker, all-out-of-range XLSX
  columns report a column-limit truncation instead of `(empty sheet)`, presentation page order follows
  `sldIdLst`, absolute `Target` paths resolve correctly and formula-only cells are emitted as `=...`.
  It runs against a real HTTP origin with real IndexedDB: importing a session whose id is `toString` and
  switching to it does not crash, an atomic `.clear()` works while another connection stays open, a
  simulated quota error rolls the whole import back, a save callback never clears a newer draft, an
  octet-stream PNG gets a corrected Data URL MIME, a finished invalid formula shows the current raw text,
  and the retrieval block uses the same `<web_search_context>` tag as the system prompt. Streaming tests
  with a real SSE stream and IndexedDB cover: deleting a session mid-stream leaves zero session and
  summary records after a fresh database read and clears the matching draft; clearing all sessions
  mid-stream leaves both stores empty and does not resurrect anything; and an immediate retry after a
  soft reset is never overwritten by the stale cancellation. Repeated XLSX shared-string references stay
  inside the live 250 KB character budget. Newer transaction and import tests: an aborted session delete
  and an aborted clear-all keep every session, summary and draft; deleting an unrelated session never
  invalidates a pending load of another; a JSON import during a background stream keeps that stream, its
  cache entry and its unsent image draft; a stale attachment from a deleted same-id session is rejected
  after the re-import; extension-less PNG / JPEG / GIF / WebP files are recognised by magic bytes; and a
  12,000-row DOCX table stays under 256,000 characters with a truncation marker. Latest coverage: an
  aborted `deleteSessionRecord` / `clearDatabase` transaction rejects exactly once and the page observes
  **zero global `unhandledrejection` events**; a failed hard-reset database purge settles every
  pending/streaming assistant message to `stopped`, empties the streaming lock dictionary and keeps the
  console operable; the welcome page and the session IDs `target`, `s:target`, `__welcome__` and `new` keep
  strictly disjoint draft keys; and a simulated full `localStorage` under static mode rejects the save,
  rolls the in-memory/on-disk state back and shows the local-storage failure toast instead of "Saved".
  Latest hardening coverage: a final `saveSession` aborted mid-transaction is retried on a fresh
  transaction and the finished reply persists as `first-last` with **zero global `unhandledrejection`**; a
  database that rejects every write falls back to the `eac:unsaved:session:<id>` snapshot, and
  `selectSession` after a simulated refresh restores the full completed reply instead of a `pending`
  empty message; a v1→v2 summary-backfill transaction abort also leaks no unhandled rejection; a
  24-table DOCX, a two-huge-sheet XLSX and a 48-slide PPTX all return strings strictly below 256,000
  UTF-8 bytes; a cell of `[paragraph "Sensor", nested table "30 Hz", paragraph "Output"]` keeps all three
  strings; and in file:// static mode a full `localStorage` makes `ChannelEditor` show
  `saveFailedLocalStorage` instead of the server-side error. Hard-reset rescue coverage: after the final
  save and its automatic retry are both aborted natively, the exported rescue file still contains the
  complete `first-last` reply and the merged JSON backup includes the snapshot-only session; when the
  purge transaction is aborted, the emergency snapshot, the persisted draft and the in-memory reply all
  survive and `initChat` / `selectSession` after a simulated refresh restore the completed `done` reply
  before writing it back; a successful purge clears the emergency key, drafts, summaries, cache and
  IndexedDB only after commit. Server-mode configuration coverage: with `/api/config` returning 500,
  `ChannelEditor` shows `saveFailed` (not the browser-storage wording) even while a previous
  settings failure left `saveError` set, and once the service is writable the pending credential is
  flushed by exactly one merged config POST before the remote PDF upload. The same file is also checked
  for `path-browserify` / `js-yaml` pre-bundled notices, the zero-omission source-map audit result, and
  the tar.umask-dependent `start.sh` archive mode documented in this file. Latest abort-matrix and
  selection-race coverage: each of the seven read paths (the `versionchange` upgrade, the three startup
  summary-backfill reads, `listSessionSummaries`, `loadSession` including a production-page click, and
  `loadAllSessions`) is aborted with a real native `IDBTransaction.abort()`; every business promise
  rejects once and the page observes **zero global `unhandledrejection` events**, while falling back to
  the `db.get`-style shortcut or dropping the monotonic selection guard makes the suite fail; and
  releasing the stale old-A read before the same-id re-imported A-prime read keeps `activeId` on A-prime
  with A-prime content instead of falling back to the welcome page. Latest strict-rescue and startup-read
  coverage: with `cold` and `hot` sessions in IndexedDB — no cache in one run, only `hot` cached in
  another — a single native `sessions.getAll()` abort during the rescue read is retried on a fresh
  transaction and the exported rescue file contains both unique bodies (2/2); when the export read keeps
  aborting, `hardReset({ exportBackup: true })` returns `backupFailed` before `clearDatabase()`, downloads
  no partial file, and both sessions reread from the database with their full bodies intact; and an
  aborted startup `summaries.getAll()` makes the mounted App render the `sessionReadFailed` wording
  (never `saveFailed`) while its Retry button restores the summary list. Latest streaming-reset coverage:
  a real SSE stream is held after displaying `LIVE-HALF` (the database still holds a `pending` empty
  assistant message); two native `sessions.getAll()` aborts make `hardReset({ exportBackup: true })`
  return `backupFailed` with zero downloads and zero `clearDatabase()` calls, yet a fresh IndexedDB
  connection and a simulated refresh both restore `LIVE-HALF` as `stopped`; when the convergence
  `saveSession` is aborted as well, the `eac:unsaved:session:<id>` snapshot restores the same reply; and
  an aborted purge still downloads a rescue file containing `LIVE-HALF` and leaves the persisted
  `stopped` reply intact for the refresh. The same suite checks that a 501-row XLSX reports
  `truncated === true` on both the extraction result and the parsed attachment, and that a JSON export
  whose full database read aborts renders `sessionReadFailed`, never `saveFailed`. Latest lifecycle and
  draft-commit coverage: `startLifecycleTracking` emits one mount heartbeat with this page's tabId and
  token, an extra heartbeat on `visibilitychange` back to visible, then a keepalive `leave` on `pagehide`
  and nothing after `stop()`; typing an API key and clicking the connectivity check saves it through
  `/api/config` first and pings without a draft key; and pressing Escape in the settings dialog commits the
  unsaved key before closing instead of discarding it. Latest channel-editor coverage: a default channel
  renders exactly the Base URL / API key / model inputs plus the two-state protocol switch; the final
  request URL preview follows typing and protocol switches, including the empty and invalid states;
  Advanced settings is collapsed by default, its controls write the channel configuration and update the
  active-override counter; a manually chosen thinking format is not overwritten by a protocol switch;
  Fetch models lists and fills ids inline, Test connection reports its result in place; and the chat-input
  Deep thinking toggle still switches the global setting on a passthrough channel. Latest custom-header
  draft coverage: clicking `Add header` appends a blank name/value row that stays in component-local draft
  state, so no `/api/config` write is issued and the row survives 600 ms across the debounce and a
  server-style snapshot that filters empty-name rows; typing a name moves the row into the channel
  configuration and persists it, after which the next external snapshot still preserves a newly appended
  trailing blank draft row.
- logic self-test: four-language key and placeholder parity, JSON backup export/import round-trip and its
  size/count/timestamp budgets, rewind and retry trimming, draft revision monotonicity, prototype-chain
  key safety, Anthropic thinking/temperature exclusion, remote-file fingerprint changes, editable raw
  capsule templates, and the rule that the distillation capsule ignores the downstream language setting.
  Additional unit coverage: `withoutKey` keeps a `__proto__` key as own data without touching the
  prototype, Anthropic split `message_start` / `message_delta` usage frames merge input and output counts,
  a disabled remote Files API blocks historical `file_id` document blocks, Mermaid YAML frontmatter is
  stripped, and the remote-delete origin check rejects changed endpoints and keys. It also covers the
  round-scoped modality guard (only the latest user message decides whether images may be dropped, so a
  later pure-image round raises `image-only` and restores the draft), the effective-key fingerprint
  (including the configured-but-unset `apiKeyEnv` case), and the draft-key injective namespace: the
  welcome page always uses `eac:draft:welcome`, every session uses `eac:draft:session:` + its raw ID, and
  clearing one draft or all drafts can never touch another session or the welcome draft. Latest coverage:
  switching a channel endpoint from A to B and uploading immediately flushes the 350 ms debounce first
  (A receives zero uploads, B receives exactly one, and the recorded fingerprint belongs to B); a DELETE
  only fires when the synced origin still matches and the remote-document switch is on; and a static-mode
  `localStorage` quota failure rejects the key save, rolls back memory and reports the failure. Latest
  hardening coverage: rotating only the API key while the `/api/config` key save is still in flight makes
  `ensureConfigSynced()` wait for the credential write, so the PDF upload starts after the new effective
  `keyFingerprint` is applied, records that fingerprint, and the following chat request carries the
  `file_id` as a `document` block without the re-upload notice. Locked-secrets coverage: a credential
  save that hits 500 retains its pending intent, reports the server-side `saveFailed` key, and a sync
  against the still-locked service issues exactly one merged POST and fails fast instead of looping;
  after the lock clears, a PDF upload and a chat round each recover with one merged config POST (200)
  plus one business request, and the retried 200 snapshot advances the effective-key fingerprint.
  Latest prompt-template coverage: the EN/ZH system prompts state the reasoning-phase rule (no large
  source dumps) and the second-half audit-noise brake (plain language without jargon relay, cut
  self-serving complexity, tell the human to ship even when a report is labelled BLOCK); the
  four-language Agent 2 capsule requires a fully self-contained prompt for a window with no memory,
  forbids CI wiring and out-of-scope edits, and keeps the `{language}` scope; the Agent 3 capsule
  requires a zero-historical-prior falsification pass over the whole design plus anti-bloat slimming and
  forbids artificial chained faults; and the distillation capsule is a three-point traffic-light decision
  sheet that ends in stop-and-wait and carries no `{language}` placeholder. Latest gateway-parsing and
  lifecycle-format coverage: flattened gateway error payloads (`{"code":...,"message":...}`) become errors
  while a normal chunk is not misread, array-shaped `delta.content` is joined, a usage-only tail frame
  still yields usage, and `parseNonSseBody()` handles a non-SSE JSON error body, a full non-streaming
  completion, plain text, an empty body and a content-free JSON object; the lifecycle request shape keeps
  the token header, action and tabId, uses keepalive only for `leave`, issues one fetch, and never rejects
  when the service is already gone; and the credential-draft committer registry runs every registered
  draft save, stops after unregistering and propagates a failing commit to its caller. Latest channel
  coverage: the default OpenAI-compatible channel serializes only `model` / `messages` / `stream` even
  with deep thinking on, thinking-model substitution stays field-free, protocol switching follows only
  untouched thinking defaults, the active-advanced-option counter matches the changed fields,
  `thinkingToggleHintKey` explains the passthrough instead of the neutral toggle name,
  `delta.reasoning` parses like `reasoning_content`, and the neutral Base URL / model placeholders in
  every dictionary contain no vendor preset.

`scripts/third-party-licenses.mjs` runs as the last build step: it resolves the installed runtime
dependency tree from `package.json`, reads each package's license file (falling back to the `license`
field when no file exists) and writes `dist/THIRD_PARTY_LICENSES.txt` sorted by package name, without any
local absolute paths. It then appends an additional-notices section that reproduces the MathJax /
Martin Hensel mhchem notice embedded in the installed `katex` package, the KaTeX SVG glyph-geometry
attribution (Khan Academy / Design Science, SIL OFL 1.1) extracted from the installed `katex` sources,
the Thenable/1.0.7 copyright and MIT text embedded in the installed `cytoscape` package, the DOMPurify
upstream attribution (`Copyright 2015 Mario Heiderich, Cure53 and other contributors`, MPL-2.0 OR
Apache-2.0) for the bundled `dompurify`, and indexes the bundled KaTeX fonts under the SIL Open Font
License 1.1. The font entry also states the font-file metadata record
(`Copyright (c) 2014-2018 Khan Academy`, verified against the TTF name table in the installed font) and
keeps it distinct from the SVG glyph path data's separate `2014-2017` line. A static source index then
records that layout-base's SVD routine is adapted from JamaJS (a JavaScript port of the NIST JAMA
public-domain library, shipped with Apache-2.0 terms) and that cytoscape's event object is adapted from
jQuery (OpenJS Foundation, MIT); both claims are re-checked against the installed package sources so a
dependency swap cannot silently falsify them. Every `.map` file shipped inside the installed runtime
packages is then parsed for its `sources` array: each external `node_modules/<package>/` reference that is
not itself an installed dependency is treated as a pre-bundled upstream package, must appear in the
curated pre-bundled notice table (currently `js-yaml` 4.1.0 and `path-browserify` 1.0.1, with copyright
line and full MIT text), and any omission aborts the build. An automated scan then walks every
installed runtime dependency source file and every built `dist/static/js/**/*.js` bundle for copyright /
`@license` notices — both `/* */` blocks and `//` line comments, including the no-`(c)` form
`Copyright 2015 ...`. It extracts holders from
`Copyright ...` and `(c) Holder ...` forms, filters out notices already covered by a package-level
license text, and never skips a notice merely because the outer package uses the same license family
while a different holder is attributed. Any uncovered embedded notice is appended with its
package/version/file provenance. Keep the scan deterministic: sort directory entries and final notice
rows, and never let it depend on platform-specific optional packages.

## 9. Change recipe and common pitfalls

- **Adding a channel/UI field**: update `src/services/config/types.ts` (type + sanitizer), `server.py`
  (`sanitize_channel`/`sanitize_settings`), the settings UI, all four i18n dictionaries, and the READMEs if
  user-visible. Then run `pnpm type && pnpm test`.
- **Changing an upstream request**: keep both protocols valid; verify the OpenAI plain-string invariant and
  the modality downgrade path in the logic self-test.
- **Never commit runtime data**: `.console_data/`, drafts and `tests/.selftest/`, `tests/.browser/` are
  ignored; `dist/` is committed intentionally.
- **Never add external assets or links to the UI.** Logos and site badges, if added later, must be
  locally drawn.
- **No automatic clipboard writes.** Copy actions must be synchronous user gestures.
- **Keep Chinese/English comments focused on why, not what.** Do not add AI-oriented markers or role tags
  to production code or docs.
- **Draft keys stay a strict injective namespace.** v0.1.0 is the first release, so there is no legacy
  draft-key migration and no permissive prefix read: the welcome page is always `eac:draft:welcome`,
  every session is `eac:draft:session:` + the raw session ID (so IDs like `welcome`, `new`, `s:target`
  or `__welcome__` stay distinct), and `clearAllDrafts()` removes only those two namespaces. Do not
  reintroduce `legacyKeyOf`-style fallbacks; they are exactly what caused cross-session draft loss.
- **Remote file requests must sync configuration first.** Any new entry point that depends on a stored
  channel slot calls `ensureConfigSynced()` before using the slot and recomputes the ownership
  fingerprint afterwards; never trust a context captured before the 350 ms debounce or an in-flight
  credential save: `ensureConfigSynced()` also waits for `setSecret` / `clearSecret` /
  `setCustomHeaders`, so rotating only the key cannot let an upload record the old fingerprint. When the
  remote-document switch is off, removal stays local and produces no outbound request.
- **A storage write failure is never silent.** In static mode a `localStorage` write error rolls back
  the in-memory change, sets `saveError` / `saveFailure: 'local'` and shows `saveFailedLocalStorage`;
  callers must not render "Saved". The UI picks the local-storage wording only when the mode is static
  or the failure origin is the browser storage layer (`configSaveFailureKey()`); an HTTP-mode
  `/api/config` 500 (`configPersistFailed`) or network failure sets `saveFailure: 'server'` and must
  show the "check the local service" wording, never the local-storage one. In
  IndexedDB, a helper that awaits several requests must consume `tx.done` in a `catch` so an aborted
  transaction rejects exactly once and never leaks a global `unhandledrejection`. A session save is
  retried once on a fresh transaction while the session is still alive; if that also fails, the latest
  complete snapshot is written to `eac:unsaved:session:<id>` in `localStorage`, restored on
  `initChat` / `selectSession` when it is newer than the database record and written back to IndexedDB,
  and cleared on a successful save or when the session is deleted / all sessions are cleared / a hard
  reset has successfully purged the database. `updatedAt` is monotonic per session, so a
  same-millisecond write can never tie with an older record; every session update uses
  `max(previous + 1, Date.now())`. Backups (plain-text rescue file and JSON) merge IndexedDB, the
  emergency snapshot and the in-memory session cache by session ID and take the newest complete state,
  so a session whose first database writes all failed is still exported. **The database read behind an
  export is strictly complete.** `loadSessionsForBackup()` retries the full IndexedDB read once on a fresh
  readonly transaction after a transient transaction abort; in strict mode — enabled by every rescue
  export and every user-initiated plain-text / JSON export — a second failure throws
  `BackupReadIncompleteError` instead of silently stitching a partial result out of the cache and the
  emergency snapshots, and the merged result is additionally rejected when any undeleted session in the
  known summary list has no complete session record. Hard reset is strictly staged:
  stop streams and settle unfinished messages first, then export the merged rescue file, then clear the
  database, and only after that transaction commits are emergency snapshots, drafts, cached sessions
  and local configuration discarded; an aborted purge keeps all of them so a refresh can still restore
  the complete reply. If the rescue export throws, hard reset aborts before `clearDatabase()` and before
  any download, keeps every snapshot / draft / cached session and reports `backupFailed`; clearing a
  database that is genuinely unreadable therefore requires the user to uncheck the pre-reset export
  explicitly. Startup read failures are reported separately from save failures: when the initial
  IndexedDB summary read fails, `initChat()` records `initFailure: 'read'` and the UI shows
  `sessionReadFailed`, never `saveFailed`.
- **Check launcher file modes before committing.** `start.sh` must be recorded as `100755`
  (`git update-index --chmod=+x start.sh`) whenever the tree is rebuilt or the index is reset, and the
  root `.gitattributes` keeps `*.sh` at `eol=lf` (plus `*.py` / `*.mjs` / `*.ts` / `*.tsx` LF, `*.bat`
  CRLF, `LICENSE` / `*.md` / `*.json` / `*.txt` / `*.js` / `*.css` / `*.html` at `eol=lf`, the KaTeX font
  files as `binary` and the committed `dist/**` tree as `-text`) so Windows archives and GitHub source
  downloads still deliver a runnable `start.sh`, and `git -c core.autocrlf=true archive HEAD` exports all
  151 `dist/` files plus `LICENSE` byte-identical to their Git blobs.

## 10. License

MIT with dual attribution:

```
Copyright (c) 2026 Jiawei Li
Portions Copyright (c) 2026 DeepSeek (derived from deepseek-ai/chat-demo)
```

The upstream `deepseek-ai/chat-demo` is credited only for the Markdown/KaTeX/Mermaid/Prism rendering stack
and base UI primitives that were adapted; all console behaviour, channel management, local service, prompt
system and audit workflow are part of this repository.
