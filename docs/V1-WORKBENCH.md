# Agent Workbench v1.0.0-rc.1

Status: development candidate. Do not tag as v1.0 GA before the remaining acceptance gates below pass. Existing Windows file management, repository synchronization, rewards and the A2A mailbox remain available.

## Implemented

- Add the Agent 工作台 page with multi-instance configuration, account credentials, durable conversations, streamed responses, per-operation approval cards, cancellation, archive, usage display and context hashes.
- Separate instance IDs from the legacy provider IDs. On first use, import seven `legacy.<provider>` instances in a SQLite transaction; do not rewrite or expand the permissions in `config.json`. Existing messages and bridge credentials stay in their original encrypted stores.
- Use built-in `node:sqlite` with WAL and versioned schema. Record payloads (including accounts, context, events, messages and approvals) are encrypted with the host SecretCodec; opaque record IDs/types are plaintext. No plaintext fallback. Live records become `interrupted` after restart and are not rerun. Do not copy a live DB without its WAL; close the application before backup.
- API Agent: configurable complete Chat Completions endpoint, streamed tool calls, bounded multi-turn loop, individually approved workspace read/write and MCP tools. Existing files receive an adjacent `.agent-backup-*` before replacement. Modification during approval rejects the write. Approved writes may create parent directories inside the workspace.
- Claude CLI: revalidate the already authorized native/npm installation, parse structured output, keep `session_id`, resume conversations. This candidate deliberately uses `--safe-mode`, disables slash commands, sets `--tools ''`, denies MCP tools, and supplies an empty strict MCP configuration: **Claude native tools are not enabled**. API Agents provide the implemented local tool loop. Managed organizational policy still applies in Claude safe mode. CLI versions lacking these flags fail rather than silently falling back to unrestricted execution.
- OpenClaw: use its documented Chat Completions compatibility endpoint with stable `user=sessionId`. Send only the newest turn to avoid replaying the Gateway's history. Gateway tools/approvals belong to OpenClaw. After failure/cancellation, create a new console session after checking the Gateway; local abort does not prove remote termination.
- Resolve selected memory and SKILL.md files into immutable per-run context snapshots. Only explicitly selected files are injected. Skill companion scripts/dependency installation are not executed. Review assistant text before saving a new file under `memories/shared/`; commit via the existing repository UI.
- MCP: reuse encrypted template variables; pin the v1 SDK to 1.26.0 and connect through Streamable HTTP or a directly authorized native Windows EXE. Review the resolved connection before launch and approve each call. Legacy SSE templates remain deployable but are not executed by the new native runtime. A fixture test connects the real SDK client to the existing authenticated bridge.
- A2A: explicitly approve a pending mailbox task and select a matching provider instance; persist task-to-run mapping before claiming, refuse duplicate execution, reconcile output to the bridge. Replies keep `console-user` provenance and do not impersonate a vendor Agent. Canceling a bridge task stops the associated local run during reconciliation (up to five seconds). No unattended execution policy is enabled.
- Account secrets are bound to their exact endpoint. APIs return only metadata. Stream redaction retains trailing characters to prevent known secrets escaping across chunk boundaries. Endpoint calls use DNS validation/pinning, no redirects, deadline and AbortSignal.
- Four concurrent runs maximum; overlapping workspaces are serialized. Create an independent `git worktree` and cloned instance for parallel development. Review tracked Git diffs and untracked filenames. Git executable must be installed; commit, test execution and cleanup remain user actions.
- Token budgets perform conservative local reservation before starting a run, then record reported input/output usage. Unknown/failed outcomes retain their reservation. This is a local control, **not provider billing enforcement**: tokenization, tool charging and provider behavior vary. Balance sampling remains separate, with no fabricated conversion into token usage or currency. Budget is cumulative and disabled by default.

## Quick start

1. Run `npm ci`, `npm run build`, then `npm start` on Windows. Open **Agent 工作台**.
2. Add an account with its complete endpoint, e.g. `https://your-provider.example/v1/chat/completions`, and API key. The example domain is not a service. For local OpenClaw, configure and enable its HTTP compatibility endpoint separately, then use `http://127.0.0.1:18789/v1/chat/completions` and your Gateway token.
3. Create an instance. Choose API, Claude or OpenClaw; set a real provider model ID or an OpenClaw target such as `openclaw/default`. Explicitly allow loopback for local endpoints. For Claude, first bind the executable in the existing Claude card and choose a workspace.
4. Choose memory/SKILL.md files and MCP services intentionally. The candidate rejects symlink/junction context paths; select the real target file. Save the instance and review its authorization dialog.
5. Start a session, send a task, approve requested tools. Use **运行追踪与上下文版本** to inspect the assets and events used. Use **查看 Git 变更** to review local changes.
6. For A2A, enable the existing bridge and its ACLs; in the workbench select an instance whose provider equals the receiving mailbox ID, review the incoming task, then approve dispatch.

Once an instance has a session, changing its model/account/runtime/workspace requires a new instance. This prevents silently attaching an existing external session to another identity. Credentials can be rotated after associated runs finish; the form accepts an empty secret to revoke.

## Source map

| Area | Files |
| --- | --- |
| Contract and UI | `src/workbench-types.ts`, `src/WorkbenchPanel.tsx`, `src/workbench.css` |
| Main/IPC boundary | `electron/workbench/ipc.ts`, `electron/preload.ts`, `electron/main.ts` |
| Instances, sessions, runs, approvals, dispatch | `electron/workbench/service.ts` |
| Encrypted SQLite records | `electron/workbench/store.ts` |
| API/OpenClaw/Claude adapters | `electron/workbench/runtime.ts` |
| DNS-pinned HTTP/SSE | `electron/workbench/network.ts` |
| File tools and MCP SDK | `electron/workbench/tools.ts` |
| Incremental secret redaction | `electron/workbench/redaction.ts` |
| Existing MCP/bridge extension | `electron/mcp-share.ts`, `electron/agent-bridge.ts` |
| Tests | `tests/workbench.test.ts`, `tests/workbench-ui.cjs` |

## Validation and GA gates

Executed in Linux development environment:

- TypeScript renderer and main compilation; production Vite build.
- Unit/integration suite, including real loopback HTTP/SSE and authenticated MCP bridge fixtures.
- Browser renderer smoke with mocked IPC: create session, send/receive messages, save another instance, no JavaScript errors and no horizontal overflow at desktop width. This does not validate Electron IPC or native APIs.
- Two pre-existing baseline failures were reproduced at 7868ec1 and repaired: reject raw UNC links before resolution on every platform; synchronize the worker-audit test with the actual audit request instead of assuming a 75 ms duration.

Still required before GA:

- [ ] Windows Electron 45 smoke: SQLite module availability, DPAPI encryption/restart, dialog/IPC approval, close-to-tray and process cleanup.
- [ ] Windows portable packaging and upgrade/rollback rehearsal using a copy of v0.7.1 user data.
- [ ] Real installed Claude CLI flag/version and resume compatibility; native Claude tool approval integration.
- [ ] Real provider and OpenClaw account smoke, disconnect/timeout reconciliation and usage accuracy.
- [ ] Complete A2A continuing-input/run mapping and native runtime result provenance; bridge history archival beyond the existing 500-task cap.
- [ ] Unified migration of legacy MCP/bridge credentials into the new account vault, with rollback. Current stores remain separately encrypted.
- [ ] Skill dependency manifests and executable asset snapshots, automated test-result review, and account-level budget policy administration.
- [ ] Load tests and indexed/paged retrieval for large encrypted histories. Current candidate queries decrypt records; intended for small local histories.

Do not advertise unsupported desktop vendors as native runtime integrations. No release binaries or GA tag are produced by this change.

## Protocol references

- Claude CLI: https://code.claude.com/docs/en/cli-reference
- OpenClaw compatibility endpoint: https://docs.openclaw.ai/gateway/openai-http-api
- MCP v1 TypeScript client: https://ts.sdk.modelcontextprotocol.io/client
