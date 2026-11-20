# AgentTrace

English | [简体中文](README.zh-CN.md)

AgentTrace is a local viewer for Codex rollout JSONL files. Replay conversations and tool calls, inspect raw records, and compare session metrics with attached Codex Trace data. Files you upload are parsed in the browser and are not sent to the local server.

## Get started

With Node.js 18 or later, run:

```sh
npm ci
npm start
```

Open [http://127.0.0.1:8789](http://127.0.0.1:8789). The server builds and serves the Vue page in memory. You do not need a separate build command or a `dist/` directory. To change the port, run `npm start -- --port 8790`.

1. Click **Upload session files**, or drop `.jsonl` files onto the page.
2. Select a session in the sidebar. Use the search field to filter sessions by filename or model.
3. Use **Conversation**, **Events**, **Tools**, **Tokens**, and **Trace** to inspect the session. **Overview**, **Metrics**, and **Details** show information about the whole session.

## Scan local session and Trace directories

Open **Settings** to enter the Codex session directory, any additional session directories, and the Trace directory. Save your settings, then refresh the session list. You can also enable automatic refresh every 10 seconds. AgentTrace recursively scans the session directories for `rollout-*.jsonl` files. The list loads metadata first. Selecting a session loads the full rollout and its matching Trace bundles.

The server stores settings locally in `.agenttrace/settings.json` and listens only on the loopback address. To set the initial Trace directory before any settings have been saved, run:

```sh
CODEX_ROLLOUT_TRACE_ROOT="/path/to/codex-traces" npm start
```

A Trace directory can contain a single bundle or subdirectories with multiple bundles. Each bundle includes `manifest.json`, `trace.jsonl`, and any referenced payload files. AgentTrace reads only the files the bundle references. The session identity in the first nonempty Trace record must match the rollout's `session_meta` and agree with the manifest. AgentTrace reports missing, conflicting, or ambiguous matches in the directory diagnostics. It does not match by filename or timestamp.

Use **Trace** to view model requests and responses, response token counts, tool execution stages, threads, and diagnostics. Open **Request payload** to inspect a request snapshot. Trace response usage is shown separately from rollout totals.

## Replay and inspect a session

- **Conversation** keeps model messages from `response_item` separate from client messages from `event_msg`. It defaults to model messages when present and falls back to client messages. Switching the source does not change the session's message count. **Events** lists runtime records separately.
- Sessions open at the end of the timeline. Press **Space** or **K** to play or pause, and use the left and right arrow keys to move between event boundaries. You can also drag the timeline or change playback speed. Events with the same timestamp appear together.
- Tool arguments appear when the call starts. Results appear only when the matching result reaches the playback position. Seeking backward hides results that have not arrived yet. The session metrics do not change with the playback position.
- Open **Details → Browse raw records** to search and filter the entire JSONL, including malformed lines. The viewer shows 50 records per page. Expand an inline preview to change the display language, switch between formatted and raw text, toggle wrapping, or copy the full source. Logs display as text; AgentTrace does not execute commands or scripts from logs.

## Export an offline report

Select a session and click **Export**. The downloaded HTML contains the viewer, the selected session's original JSONL, and its attached Trace bundles. Open the file directly in a browser without the local server or a network connection. Export does not modify the original logs or include other sessions.

## Understand the metrics

| Metric | How AgentTrace calculates it |
| --- | --- |
| Recorded span | The time between the first and last valid recorded timestamps. |
| Turn duration | The reported `duration_ms` when present, otherwise the time between the turn boundaries. |
| Messages | User and assistant messages, excluding reasoning and tools. Model messages take precedence over client messages. |
| Tool duration | The interval between a call and its result, paired by call identity. Runtime and tool-reported durations are shown separately. Overlapping calls are not additive wall-clock time. |
| Tokens | Increments in `total_token_usage`, without counting repeated snapshots twice. Cached input and reasoning output are subsets, not extra tokens. Missing totals are not estimated. |

Recorded message timestamps do not measure model generation time. If a session lacks timestamps needed for replay, the viewer labels its timeline as presentation time and does not use that time for recorded durations.

## Development and verification

| Directory | Contents |
| --- | --- |
| [`src/client/`](src/client/) | Vue components, browser state, HTML template, and styles. |
| [`src/core/`](src/core/) | Shared rollout and Trace parsers, replay logic, and document formatting. The page embeds these modules for offline use, and Node can load them directly. |
| [`src/server/`](src/server/) | Local HTTP API, session library, Trace file loader, and in-memory page assembly. |
| [`tests/`](tests/) and [`checks/`](checks/) | Node tests and Playwright browser checks. |

`npm start` runs `src/server/start.mjs`. The root holds project configuration and documentation. Keep `package-lock.json` in Git. The [`.gitignore`](.gitignore) excludes installed dependencies, local settings and work files, environment files, test output, `rollout-*.jsonl` logs, and exported `*-replay.html` reports. Do not commit custom-named logs or reports that contain private data.

```sh
npm test
npm run verify:framework
```

The Node suite covers parsing, replay, Trace matching, and the local API. The framework check verifies that the assembled page has no external scripts or stylesheets and that embedded log text remains data. With Playwright available to Node and Chromium installed, run `npm run test:browser` to exercise the local service and exported HTML in a real browser.

For the Codex log format, see the [App Server documentation](https://developers.openai.com/codex/app-server/) and [rollout persistence policy](https://github.com/openai/codex/blob/main/codex-rs/rollout/src/policy.rs).
