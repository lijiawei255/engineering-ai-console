# Engineering AI Console

[English](README.md) · [简体中文](README_ZH.md) · [Français](README_FR.md) · [Русский](README_RU.md)

**A local master console for a four-step engineering loop: think, dispatch, build, audit.**
No vendor preset, no model whitelist, no telemetry. OpenAI-compatible and
Anthropic-compatible endpoints are both first-class; any model ID can be typed by hand.

---

## 1. What this is, and the loop it is built for

```
        ┌──────────────────────── cloud console ───────────────────────────┐
        │  Agent 1: Engineering Chief of Staff                             │
        │  blunt reasoning · action capsules · report distillation         │
        └───────────────▲──────────────────────────────────────┬───────────┘
                        │  manual copy / paste buffer          │
                        │                                      ▼
        ┌───────────────┴──────────────┐        ┌──────────────────────────────┐
        │ Agent 2: stateless executor  │        │ Agent 3: adversarial auditor │
        │ fresh local window, writes   │        │ fresh local window, audits   │
        │ code, reports changes/errors │        │ the whole idea, never edits  │
        └──────────────────────────────┘        └──────────────────────────────┘
```

The console listens on a loopback address of your own machine, yet Agent 1 is still the
**cloud / pure-dialogue** role because it mounts neither your local project directory nor a
terminal: that keeps the top-level reasoning context clean instead of flooding it with source
code and logs. Agents 2 and 3 are local agents — they mount the project folder directly and
drive the real compiler and test toolchain on this machine.

Agent 1 is this console. It reasons through the problem in plain engineering language,
keeps the plan small and inspectable, and turns it into two ready-to-paste prompts:

1. **Generate the Agent 2 execution instruction** — a strict build prompt with a bounded
   file scope, no invented abstractions, a mandatory change list and an exception report.
2. **Generate the Agent 3 audit request** — a non-leading, falsification-first audit prompt:
   top-level soundness, hidden assumptions, real-time/concurrency/physical failure modes,
   required experiments and over-design to cut.
3. Paste the build result or the audit report back and click **Distill the returned report**
   to get a three-point plain-language traffic-light decision sheet: whether the work can be
   signed off, what really has to change, and which nitpicks to throw away.

Once a round passes every local verification gate, Agent 2 records it as modular
**local checkpoint commits** — instant rollback anchors for the human and clean incremental
diffs for Agent 3. Agent 3 stays strictly read-only; nothing is pushed to a remote until the
human signs off.

The copy/paste steps are deliberate. That manual buffer is a **human-in-the-loop circuit
breaker**: only the engineer moves text across it, so an AI cannot rewrite its own audit trail
or silently touch hardware.

---

## 2. Thirty-second quick start

### Way A — local Python service (recommended)

Requirement: **Python 3.9 or newer, no third-party packages, no Node.js.**

- **Windows:** double-click `start.bat`.
- **Linux / macOS:** `./start.sh` (or `python3 server.py`).
- On Windows the launcher starts the service in the background through `pythonw.exe` — no resident
  console window — and the CMD window closes at once; `start.sh` runs `server.py --auto-exit` in the
  terminal. Both open the default browser at the local page, bind loopback only, and a second launch
  reuses the already running instance instead of starting a duplicate.
- Closing every console tab stops the background service about 5 seconds later; refreshing the page
  (F5) reconnects inside that buffer and is never mistaken for a close. Add arguments (for example
  `start.bat --port 18770` or `start.bat --foreground`) to keep a visible foreground window when you
  want to read the terminal output.
- If no qualified Python interpreter exists, the launcher simply opens the static page
  instead. A non-zero exit from `server.py` keeps the real Python error visible.

### Way B — pure static direct mode (zero installation)

Double-click `dist/index.html` and the console runs entirely in the browser. Configuration
lives in this browser's local storage, and requests go straight from the page to your
endpoint (subject to normal browser CORS rules). This mode applies only when the page is
opened from a local file (`file://`); a page served over http(s) without the local service
stays in server mode and shows an offline banner instead of silently downgrading.

### First channel in four steps

Open **Settings → Channels** and pick `Primary` or `Backup`, then:

1. Choose the protocol with the two-state segmented switch (**OpenAI Compatible** /
   **Anthropic Messages**).
2. Paste the Base URL. The **Final request URL** line below the field updates with every
   keystroke and protocol change, so it is obvious whether `/v1` is added for you before the
   first request.
3. Paste the API key **before** probing the endpoint. It is saved automatically when the field
   loses focus or the dialog closes; only the last four characters stay visible.
4. Type any model ID — no list is imposed and no default is hidden — or press **Fetch models**
   to fill it from the endpoint, then press **Test connection**. Everything for special
   gateways (raw URL lock, thinking fields, key environment variable, custom headers, request
   timeout, remote PDF parsing) sits in the collapsed **Advanced settings** panel, whose title
   carries a counter of the overrides currently active.

**Deep thinking** is standard passthrough on a default OpenAI-compatible channel: the request
carries only `model`, `messages` and `stream`, so an unknown gateway cannot reject it with a
400 for an unrequested vendor field. The switch only substitutes the configured thinking
model; pick an explicit thinking request format in Advanced settings when a gateway needs one.

---

## 3. What everyday use feels like

- **One-click hot switch between the primary and backup channels.** Both slots share the same
  request builder, the same attachment pipeline and the same safety boundary, so switching
  never changes what the request looks like.
- **Local, deterministic parsing that never guesses.** Source code, config files and shifted
  industrial logs (UTF-8 → GB18030 → windows-1252) are decoded locally; `.docx` / `.xlsx` /
  `.pptx` are read from their XML without any cloud service; images are passed inline as data
  URLs. A 200 KB truncation guard keeps huge logs from flooding the context.
- **Multimodal errors degrade automatically instead of failing the round.** If an endpoint
  rejects image blocks with HTTP 400/415/422, the image blocks are stripped, an explicit
  omission notice is added and the request is retried as text once. A pure-image message
  stops safely and restores its draft instead.
- **Per-message context slimming and single-step rewind.** Any message can be compacted
  while its original stays readable on screen, and the conversation can be rewound to any
  point to try a cleaner branch.
- **Graded reset instead of a single nuclear button.** A soft reset drops the local streams
  immediately (the upstream side is reclaimed when that channel's read timeout expires) and
  keeps chats, drafts and keys. A hard reset offers a plain-text rescue export, then clears
  all IndexedDB sessions in one transaction and clears the local draft cache.
- **Solarized Light/Dark, four lossless font scales, standard/wide content width and a
  flicker-reduction mode.** The UI is available in English, 简体中文, Français and Русский.

---

## 4. Technical boundaries, privacy and secondary-development reference

### 4.1 Privacy and the complete outbound-traffic list

The console is built to be auditable, not to phone home.

- The local service binds **`127.0.0.1` only** — never `0.0.0.0`, never a LAN interface.
  Without `--port`, it scans the whole `18765..18795` range via the token-less
  `GET /api/health`; if this console's service identity answers, it opens that exact
  instance instead of binding a duplicate. Otherwise it binds `18765` (or the next free port
  up to `18795`).
- Every `/api/*` call requires the per-process `X-Console-Token` injected into the served
  HTML, plus an exact same-origin `Origin` check and a loopback `Host` check. The single
  deliberate exception is `GET /api/health` (single-instance probing): it accepts a request
  without the token, but the `Host` and same-origin `Origin` checks still apply.
- The only page-lifecycle traffic is local: `POST /api/lifecycle` on `127.0.0.1` (one heartbeat
  on mount, one every 20 seconds, and one keepalive `leave` when the page is hidden). It never
  leaves the machine and follows the same token / origin checks. Only `server.py --auto-exit`
  acts on it: closing every console tab ends the background service about 5 seconds later,
  while a refresh inside that window keeps it alive.
- Static files are served from `dist/` only. Path resolution is checked against that
  directory, and directory traversal / NUL bytes are rejected.
- Request bodies are bounded: 1 MB for configuration endpoints, 32 MB for chat and file
  forwarding. A missing or lying `Content-Length` is rejected instead of being streamed.
- API keys and custom-header values live in `secrets.json` in the data directory
  (`--data-dir`, default `.console_data/`); `settings.json` never contains them. The page
  only ever sees `hasKey`, the last four characters and a 12-hex one-way fingerprint. On
  POSIX, secret files are `0600`. Environment variables configured by name take priority
  over stored keys.
- The UI loads **no external links, fonts, icons or badges**, and never writes to the
  clipboard on its own; every copy action is an explicit click.
- Outbound requests are split strictly by stage, and this is the complete list:
  - **Adding an attachment to the draft, before you press send.** Source code, logs,
    configuration, Office documents (`.docx` / `.xlsx` / `.pptx`) and images are decoded,
    unzipped or encoded entirely in the browser and produce **no network request**. The only
    exception is a `.pdf` added or removed while a channel's opt-in **remote document parsing
    (Anthropic Files API)** switch is on (channel config field `enableRemoteFileApi`): adding
    it sends `POST .../files`, removing a not-yet-sent draft PDF sends `DELETE .../files`.
  - **Pressing send.** The text extracted locally (wrapped in `<attached_file>`), inline image
    data and any remote PDF's `file_id` become part of this round's chat context and travel with
    the chat request to the model endpoint of the currently active channel.
  - **The connectivity test** and the **Fetch models** button in a channel's settings:
    each sends one `GET .../models` request carrying that channel's credentials.
  - **Exa retrieval**, when enabled: search requests go to the configured Exa endpoint.
  - **Remote PDF upload / removal**, only with `enableRemoteFileApi` on, as described above.
- Two network details complete this list. In `file://` pure-static direct mode the browser may
  first emit a credential-free `OPTIONS` preflight request under the standard CORS rules before a
  cross-origin chat, model, Exa or Files business request; that preflight carries no API key or
  custom header value and is generated by the browser, not by the console. Exa retrieval
  (`/api/search/exa`) uses its own bounded 30-second timeout, so it is not affected by a channel's
  custom stream timeout.
- When you switch a channel's endpoint, protocol or key and then immediately upload or
  delete a remote file, the file API entry point first flushes the pending 350 ms settings
  queued write into the local service, then recomputes the remote-file ownership fingerprint
  from that synced configuration. A file is never uploaded to the previous gateway, and a
  remote delete is never sent to a different endpoint or credential space.
- During startup, a legacy plaintext custom header found in `settings.json` is migrated into
  `secrets.json`; the freshly written `secrets.json` is immediately mirrored into
  `secrets.json.bak` (and the cleaned `settings.json` into its `.bak`). If any backup
  replacement fails, the console keeps a persistent dirty marker and reports degraded
  storage until an exact re-sync succeeds — so a later crash can never resurrect stale
  plaintext or lose the migrated credential.

### 4.2 Primary/backup capability intersection

Both slots run through the same serializer, the same attachment pipeline and the same
security boundary. The differences are limited and explicit:

- **Text history is protocol-neutral.** A conversation can move from OpenAI to Anthropic and
  back mid-thread because every request is re-serialized from the same neutral history.
- **Reasoning blocks are never replayed.** Only user text and assistant text enter the next
  request; a thinking trace shown in the UI never travels to the other protocol.
- **Remote PDF parsing and the DeepSeek native web-search tool need the Anthropic protocol.**
  Remote files also need an endpoint that serves the Anthropic Files API; native search needs
  a gateway that explicitly declares support for `deepseek_web_search`. "Anthropic-
  compatible" alone is not a promise: without that declaration the gateway may reject the
  request or ignore the tool. OpenAI-compatible slots can still use local attachment parsing
  and Exa retrieval.
- Thinking fields are opt-in by strategy (off, Anthropic extended thinking, DeepSeek
  reasoning, OpenAI reasoning effort, enable-thinking); no vendor field is injected by
  default. The default OpenAI-compatible channel therefore stays on the passthrough setting,
  and every other strategy is an explicit override listed in Advanced settings. Anthropic
  extended thinking and a custom temperature are mutually exclusive.

### 4.3 Reset, backup and data rules

- **Soft reset** aborts every local stream immediately and unlocks the UI; chats, drafts and
  keys are untouched. The server-side upstream connection is closed when that channel's
  read timeout expires.
- **Hard reset** optionally exports a plain-text rescue file first, then clears all session
  records in a single IndexedDB read/write transaction (no database deletion, so other open
  tabs keep working), clears the local draft cache synchronously, and reloads the page.
  Configuration returns to defaults; stored local keys can be kept if you choose to.
- If the destructive phase fails, the page does not reload: interrupted messages are settled
  to `stopped` and the streaming locks are cleared, so the console never freezes in a
  half-dead "Generating" state with no stop or retry button.
- **JSON backup import** is strictly validated before anything is written: 32 MB file size
  limit, bounded session/message counts and a plausible timestamp range, written in one
  atomic transaction. Existing chats are kept; colliding IDs are re-generated.
- Draft storage uses two disjoint namespaces: the welcome page uses `eac:draft:welcome`,
  and every session uses `eac:draft:session:` + the session ID. Deleting or clearing any
  session can never touch another session's draft or the welcome draft.

### 4.4 Build from source and repository layout

Requirements: **Node.js `20.19+` or `22.12+`**, plus `pnpm` (or `corepack pnpm` / `npx pnpm`).

```bash
pnpm install
pnpm type     # TypeScript, 0 errors
pnpm lint     # oxlint, 0 warnings and 0 errors
pnpm build    # rspack build + third-party license bundle, no source maps
pnpm test     # logic, browser, server-security and privacy self-tests
```

`dist/` is committed on purpose: a machine with only a browser can run the console offline,
and a machine with only Python can run the local service. End users do not need a build
toolchain. The license bundle at `dist/THIRD_PARTY_LICENSES.txt` reproduces every runtime
dependency's license, plus known embedded notices (KaTeX's mhchem extension,
Cytoscape's Thenable implementation) and the result of an automated scan for embedded
copyright notices that no package-level license file covers.

```
src/                    React + TypeScript front end
  services/api/         URL normalization, dual-protocol serialization, SSE parsing, watchdogs
  services/chat/        sessions, drafts, compaction, reset, backup, plain-text export
  services/config/      channel/UI/prompt configuration, sanitizers, server/static persistence
  services/attachments/ local decoding, Office XML extraction, truncation guard
  components/           UI: top bar, action capsules, composer, messages, settings, sider
  i18n/                 en.ts (source of truth), zh.ts, fr.ts, ru.ts
server.py               single-file Python 3.9+ local service
start.bat / start.sh    launchers (windowless auto-exit on double-click, foreground with arguments; start.sh is executable, mode 100755)
scripts/                build helpers, including the third-party license bundle
tests/                  logic, browser-document, server-security and privacy self-tests
dist/                   committed production build; no source maps
```

The local service is a convenience proxy with a narrow trust model: it trusts the local
browser and the local user. Any process that can read `.console_data/` can read
`secrets.json`; protecting an already compromised host is out of scope. Do not expose the
service port through a reverse proxy or port forward.

---

## 5. Acknowledgments & Non-Affiliation

The clean, lightweight streaming-chat front end that this console started from was kindly
open-sourced by [**deepseek-ai/chat-demo**](https://github.com/deepseek-ai/chat-demo). It gave
this project a solid, readable base for the Markdown/KaTeX/Mermaid rendering stack and the
basic conversation UI primitives. On top of that base, this project grew its own
de-vendorized channel layer, dual-protocol fault tolerance, local security architecture and
the four-step engineering workflow. Thank you to the upstream authors and contributors.

**This project is an independent community open-source derivative. It has no affiliation,
partnership, authorization or endorsement relationship with DeepSeek.** All console
behaviour, channel management, the local service, the prompt system, the audit workflow and
every change in this repository are maintained by this project's own contributors. The
DeepSeek name appears only to credit the upstream open-source project and to describe
protocol compatibility.

---

## 6. Engineering & Safety Disclaimer

This tool exists to support early engineering exploration, to surface blind spots early, and
to keep prototype code from ballooning past what a human can review. It deliberately pushes
for minimal, inspectable implementations.

**A strict audit prompt is not an industrial safety endorsement.** This software has not been
certified under IEC 61508, ISO 26262, IEC 62304, DO-178C or any other functional-safety,
medical, automotive or aerospace standard. AI reasoning cannot substitute for physical
verification and may miss real-time deadlocks, race conditions, sampling/timing conflicts,
numerical instability or hardware boundary failures. Before any output reaches a controller,
test rig or industrial machine, a qualified engineer must review it line by line and complete
independent simulation, bench testing and hardware-level protective design. You remain
responsible for every decision made with this tool.

---

## 7. License

MIT. See [LICENSE](LICENSE).

```
Copyright (c) 2026 Jiawei Li
Portions Copyright (c) 2026 DeepSeek (derived from deepseek-ai/chat-demo)
```

The upstream `deepseek-ai/chat-demo` is credited for the Markdown/KaTeX/Mermaid/Prism
rendering stack and base UI primitives that were adapted; all console behaviour, channel
management, local service, prompt system and audit workflow are part of this repository.
