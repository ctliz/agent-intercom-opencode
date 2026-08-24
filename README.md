# OpenCode Intercom

**Agent Intercom** is a cross-harness, same-machine messaging system for coding agents. Its Pi, Codex, Claude Code, OpenCode, Grok Build, and AGY adapters share one local broker and protocol, so sessions can discover and message each other regardless of which harness they run in.

| Harness | Repository |
|---|---|
| Core / Protocol | [`agent-intercom-core`](https://github.com/ctliz/agent-intercom-core) |
| Pi | [`agent-intercom-pi`](https://github.com/ctliz/agent-intercom-pi) |
| Codex | [`agent-intercom-codex`](https://github.com/ctliz/agent-intercom-codex) |
| Claude Code | [`agent-intercom-claude`](https://github.com/ctliz/agent-intercom-claude) |
| OpenCode | [`agent-intercom-opencode`](https://github.com/ctliz/agent-intercom-opencode) |
| Grok Build | [`agent-intercom-grok`](https://github.com/ctliz/agent-intercom-grok) |
| AGY | [`agent-intercom-agy`](https://github.com/ctliz/agent-intercom-agy) |
| Fleet lifecycle | [`agent-intercom-orchestrator`](https://github.com/ctliz/agent-intercom-orchestrator) |

Grok Build and AGY use lightweight npm-packaged MCP launchers backed by the Claude MCP runtime. They retain inbound messages for `intercom_pending` polling but do not provide wake-on-message.

## Maintenance & Upstream Provenance

- **Maintained by `ctliz`**: This distribution is maintained independently by [ctliz](https://github.com/ctliz).
- **Upstream Heritage**: Agent Intercom grew from [Nico Bailon's original `pi-intercom`](https://github.com/nicobailon/pi-intercom) and the upstream [`dataforxyz/agent-intercom-*`](https://github.com/dataforxyz/agent-intercom-opencode) repositories. This project is not officially endorsed by or affiliated with upstream organizations.
- **Package Namespace History**:
  1. `0.11.0-connect.1`: Historical `@dataforxyz/*` namespace line
  2. `0.11.0-connect.2`: First canonical `@ctliz/*` package namespace migration line
  3. `0.12.0-connect.1`: Coordinated canonical Auto-Team line with self-contained production runtime (`networkRequired=false`) and default-only OpenCode CLI loader safety
- The **Agent Intercom** branding and the `intercom_*` API surface are unchanged.

## Protocol v4 & Broker-Enforced Scope

Agent Intercom protocol v4 introduces **broker-enforced scope routing** via `AGENT_INTERCOM_SCOPE_ID`:

- **Registration**: The client submits its `scopeId` once in the top-level registration payload.
- **Broker Enforcement**: The shared local broker stores the scope in its private `ConnectedSession` record and enforces same-scope discovery (`intercom_list`), naming, and prefix matching.
- **Cross-Scope Routing**: Cross-scope messaging is fail-closed; communication across different scopes is permitted only when addressing an explicit full session ID.
- **UX Routing Isolation**: Scope is designed for same-OS-user workflow isolation (e.g. per-project or per-workspace agent teams), **not** as a cryptographic security principal, tenant boundary, or authentication credential.
- **Leak-Free**: The raw `scopeId` value never enters `SessionInfo`, list payloads, lifecycle events, frontend displays, or execution logs.
- **Standalone First**: `AGENT_INTERCOM_SCOPE_ID` is a general shell/IDE/service launcher contract. Agent Intercom works completely standalone in any terminal, tmux window, or script; TmuxDeck is optional visual tooling.

## Origin and thanks

Agent Intercom grew from [Nico Bailon's original `pi-intercom`](https://github.com/nicobailon/pi-intercom). A sincere thank you to Nico and the original contributors for creating the Pi extension and the foundation this cross-harness family builds on.

This repository contains the OpenCode adapter. It gives OpenCode native intercom tools, durable wakeable sessions, and an optional `agent_fleet` manager tool backed by [`agent-intercom-orchestrator`](https://github.com/ctliz/agent-intercom-orchestrator). OpenCode can now participate as either a persistent coworker or an explicitly configured primary manager.

## What It Does

- registers the current OpenCode session with the shared local broker
- lists Pi, Codex, Claude, and OpenCode peers
- sends and receives inter-agent messages
- supports blocking ask/reply flows
- injects inbound messages back into OpenCode so the receiving session can wake up and continue from the message
- persists inbound messages before broker acknowledgement and replays unfinished injection after restart
- publishes run-specific readiness, health, and active OpenCode session metadata
- resumes a stable OpenCode session after an orchestrator-owned worker restart
- optionally exposes the same systemd-owned `agent_fleet` lifecycle tool used by Pi

## Status

Protocol-v4 compatible with the matching Pi, Codex, and Claude Code adapters.

Proven working:

- OpenCode plugin loads in real `opencode run`
- startup registration works without needing an intercom tool call first
- fresh Pi and Codex peers can be reached from OpenCode
- fresh OpenCode receivers can be reached from Pi
- busy headless `opencode run` receivers can wake after their current turn
  finishes
- verified durable inbound delivery with receiver deduplication in headless run mode
- verified crash-safe durable inbound replay and unresolved-ask retention
- verified persistent worker restart with the same OpenCode session ID and retained memory
- verified OpenCode-manager spawn, status, logs, cgroup cleanup, and forget through native `agent_fleet`
- headless server receivers persist and acknowledge queued messages, then inject asynchronously so long model turns do not make the broker evict a healthy peer
- sends survive reconnects in a durable sender outbox and replay with the same ID
- incompatible older brokers fail closed without killing, downgrading, or creating second islands
- ask defer/cancel controls are broker-acknowledged, and timed-out asks remain late-replyable

## Practical Pi parity

OpenCode now has operational parity for the behaviors that matter to a persistent manager or coworker:

- durable inbound delivery and ask recovery
- explicit Intercom/session readiness before an owned spawn succeeds
- stable session ID capture and restart/resume
- model-specific variant discovery and validation through the orchestrator
- the same `agent_fleet` actions, store, leases, adoption, systemd cgroups, logs, and cleanup used by Pi
- recursive fleet creation disabled in ordinary owned workers

The harnesses still present differently. Pi has native extension commands, a scoped footer, and `/agents` menus; OpenCode exposes equivalent lifecycle operations as model-callable tools and uses separate server/TUI plugins. This is a UI/API difference, not a separate ownership implementation.

## Install

Install from GitHub at the exact release tag under OpenCode's configuration directory:

```bash
mkdir -p ~/.config/opencode
cd ~/.config/opencode
npm install @ctliz/agent-intercom-opencode@0.12.0-connect.3
```

> The production bundle `dist/plugin.mjs` is self-contained with zero production runtime npm dependencies on `@opencode-ai/plugin`, `zod`, `effect`, or `@ai-sdk/provider`. It requires only the peer dependency `@ctliz/agent-intercom-core@0.2.0`.

The packaged `dist` files are prebuilt. Add the server plugin to your normal OpenCode config (usually `~/.config/opencode/opencode.json`), replacing `/home/you` with your absolute home path:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    "/home/you/.config/opencode/node_modules/@ctliz/agent-intercom-opencode/dist/plugin.mjs"
  ]
}
```

To add the native intercom picker and copy command, put the separate TUI plugin in
`~/.config/opencode/tui.json`:

```json
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": [
    "/home/you/.config/opencode/node_modules/@ctliz/agent-intercom-opencode/dist/tui.mjs"
  ]
}
```

OpenCode keeps server and TUI plugins in separate configuration files. Do not
put `dist/tui.mjs` in `opencode.json`: the server plugin loader will reject it.
Restart OpenCode after changing either config.

For source development instead, clone the GitHub repository, run `npm install && npm run build`, and point both plugin entries at that checkout's `dist` files.

The TUI plugin talks to the already-connected server plugin through a private
local control bridge. It does not open another broker connection or register a
second intercom identity. Both plugin entries are therefore required for the
native commands.

No wrapper alias is required for OpenCode as a worker: once both config files are present, plain `opencode` has the shortcuts and slash commands. This differs from hosts whose terminal wrappers are responsible for their keybindings.

### Use Pi as the fleet manager

Install both Pi packages, then restart Pi or run `/reload`:

```bash
pi install git:github.com/ctliz/agent-intercom-pi@v0.12.0-connect.4
pi install git:github.com/ctliz/agent-intercom-orchestrator@v0.12.0-connect.2
```

Inside Pi, run `agent_fleet({ action: "doctor" })` to confirm this OpenCode plugin is visible in OpenCode's resolved configuration. The orchestrator Pi package provides the `agent_fleet` tool, `/agents*` commands, scoped footer, and bundled manager Agent Skill.

### Enable OpenCode as the primary fleet manager

Install the orchestrator package so its `agent-intercom-fleet` executable is available:

```bash
pi install git:github.com/ctliz/agent-intercom-orchestrator@v0.12.0-connect.2
```

Then start the one OpenCode session that should own persistent coworker creation:

```bash
OPENCODE_INTERCOM_FLEET=1 \
OPENCODE_INTERCOM_NAME=opencode-manager \
OPENCODE_INTERCOM_SESSION_ID=opencode-manager \
opencode
```

For a source checkout instead, point directly at the packaged CLI:

```bash
AGENT_INTERCOM_FLEET_COMMAND=/path/to/agent-intercom-orchestrator/src/agent-fleet-cli.mjs
```

Fleet management is opt-in. Orchestrator-owned OpenCode workers receive `AGENT_INTERCOM_OWNED=1`, which suppresses recursive `agent_fleet` registration even if the manager environment is inherited. Do not enable `OPENCODE_INTERCOM_FLEET_ALLOW_NESTED=1` unless recursive ownership is deliberately required.

## TUI Commands

| Action | Slash command | Shortcut |
|---|---|---|
| Choose a connected agent, compose, and send a message | `/intercom` | **Alt+M** |
| Copy this session's exact intercom target | `/intercom-id` | **Alt+I** |

`/intercom-contact` remains an alias for `/intercom-id`. The copy command uses
the identity owned by the server plugin, so it remains correct even when the
TUI and OpenCode server run in different processes. If no system clipboard
helper is installed, the target is displayed in a toast instead. Linux support
uses `wl-copy`, `xclip`, or `xsel`; macOS uses `pbcopy`, and Windows uses
`clip.exe`.

## Tools

- `intercom_whoami`: show this session's intercom ID, name, cwd, and model
- `intercom_team`: show the current manager and live coworkers owned by that manager
- `intercom_status`: show connection status and pending message counts
- `intercom_list`: list local Pi, Codex, Claude, and OpenCode sessions in your scope (protocol v4 is same-scope; cross-scope contact requires an exact full session ID)
- `intercom_set_summary`: publish a short discoverable status
- `intercom_send`: send a non-blocking message
- `intercom_ask`: send a question and wait briefly for the target's reply
- `intercom_pending`: read queued inbound messages and unresolved asks
- `intercom_reply`: reply to a pending inbound ask; use `to` plus `which: "oldest" | "latest"` if one sender has multiple unresolved asks

Pending output never exposes protocol message IDs. Keep at most one unresolved `intercom_ask` to the same recipient; the broker rejects a second ask and recommends `intercom_send` for a non-blocking follow-up. Use `intercom_send`—not `intercom_ask`—for assignments and progress/status checkpoints.

The OpenCode runtime automatically reconnects its stable Intercom identity after a broker restart and reports the temporary reconnecting state through peer health metadata.
- `agent_fleet` *(opt-in manager only)*: create, inspect, adopt, renew, stop, and clean up owned coworkers; inspect coordinated adapter versions and preview or execute source-aware updates using the same implementation as Pi. Manager-received messages from an owned worker automatically renew that exact worker's activity-bounded lease. Deleting a stopped record with `forget` requires `acknowledge: true`.

## Inbound Delivery Model

Inbound messages always reach the runtime queue. From there, the plugin tries to
deliver them into the active OpenCode session.

Current delivery strategy:

1. atomically persist the inbound message before acknowledging it to the broker
2. restore pending injection and unresolved asks from disk after restart
3. show a toast
4. if OpenCode is running with a real TUI, try prompt append + submit
5. in headless run/server mode, use `session.promptAsync` so broker delivery does not wait for the model turn
6. attach `metadata.intercomMessageId` and a prompt marker to submitted turns
7. before replay, inspect recent session messages for that ID so a crash after accepted submission does not duplicate the turn
8. retain asks durably until `intercom_reply` succeeds
9. cap the durable delivered-ID ledger and in-memory session sets

Protocol delivery has two states: `accepted` means the broker assigned a delivery ID; `delivered` means this receiver durably stored the message and acknowledged it.
Model completion and an ask reply are separate later events. This distinction is
necessary for persistent headless servers because a model turn can outlive the
broker's receiver-ack deadline.
The sender outbox is stored below the shared intercom runtime directory and is
replayed automatically after reconnect.

That means busy `opencode run` sessions can now receive a real follow-up turn
after their original tool call completes.

## Quick Verification

Start a long-lived receiver:

```bash
OPENCODE_CONFIG_CONTENT='{"$schema":"https://opencode.ai/config.json","plugin":["/path/to/agent-intercom-opencode/dist/plugin.mjs"],"permission":{"bash":"allow"}}' \
OPENCODE_INTERCOM_NAME=opencode-live-test \
OPENCODE_INTERCOM_SESSION_ID=opencode-live-test \
opencode run --auto --format json "Run bash command sleep 60. Then output done. Do not call any intercom tools."
```

Confirm it registered from Pi:

```bash
PI_INTERCOM_SESSION_ID=pi-list-test \
pi --no-extensions --extension /path/to/agent-intercom-pi/index.ts --no-skills --mode json --print "Use the intercom tool with action list once. Output only the tool result."
```

Send a message from Pi while the receiver is still in `sleep`:

```bash
PI_INTERCOM_SESSION_ID=pi-send-test \
pi --no-extensions --extension /path/to/agent-intercom-pi/index.ts --no-skills --mode json --print "Use the intercom tool with action send to send this exact message to opencode-live-test: hello from pi live test. Output only the tool result."
```

Then inspect the receiver session:

```bash
opencode export <session-id>
```

Expected result:

- the original `sleep` turn finishes
- a new user turn appears with the inbound intercom text
- the inbound prompt appears exactly once

## Debugging

Enable inject-path logging with:

```bash
OPENCODE_INTERCOM_DEBUG=1
```

When enabled, the plugin writes structured injection logs to:

```bash
/tmp/intercom-inject.log
```

Useful things to inspect there:

- whether the receiver was busy
- whether TUI injection was skipped because the run was headless
- whether `session.promptAsync` returned `204`
- whether delivery was recorded exactly once

## Environment

| Variable | Purpose |
|----------|---------|
| `OPENCODE_INTERCOM_NAME` | Discoverable session name |
| `OPENCODE_INTERCOM_SESSION_ID` | Stable intercom id |
| `OPENCODE_INTERCOM_MODEL` | Model label shown to peers |
| `OPENCODE_INTERCOM_DEBUG` | Enable `/tmp/intercom-inject.log` diagnostics when set to `1` |
| `OPENCODE_INTERCOM_FLEET` | Register the native `agent_fleet` manager tool when set to `1` |
| `AGENT_INTERCOM_FLEET_COMMAND` | Override the `agent-intercom-fleet` executable path |
| `AGENT_INTERCOM_FLEET_TIMEOUT_MS` | Fleet CLI timeout; default 120000 |
| `OPENCODE_INTERCOM_FLEET_ALLOW_NESTED` | Explicitly permit fleet management inside an owned worker; unsafe by default |
| `OPENCODE_INTERCOM_TARGET_SESSION` | Internal persistent-peer target session used during resume |
| `OPENCODE_INTERCOM_INBOUND_STATE` | Override durable inbound state path |
| `AGENT_INTERCOM_OPENCODE_HEALTH_PATH` | Orchestrator-provided readiness/health file |
| `AGENT_INTERCOM_OPENCODE_STATE_PATH` | Orchestrator-provided persistent OpenCode session state file |
| `PI_INTERCOM_ASK_TIMEOUT_MS` | Shared default blocking-ask timeout, max 120000 |
| `PI_CODING_AGENT_DIR` | Shared broker socket/config base, default `~/.pi/agent` |

## Development

```bash
npm install
npm run build
npm run typecheck
npm test
```

See also:

- `HANDOFF.md`
- `NEXT_STEPS.md`
- `PLAN.md`

## Releasing

Releases are automated from version tags. Update `package.json`, the lockfile when
present, and `CHANGELOG.md` on `main`, then push an annotated tag that exactly
matches the package version:

```bash
git tag -a vX.Y.Z -m "vX.Y.Z"
git push origin vX.Y.Z
```

The release workflow verifies that the tag points into `main`, runs typecheck,
tests, and the build, publishes the public npm package with trusted OIDC
provenance, and creates the GitHub Release. Existing npm versions and GitHub
Releases are skipped safely when a workflow is rerun.

## Compatibility, Migration & Rollback

- **Single Shared Broker**: The broker-capable adapters on the machine — `pi`, `claude`, `codex`, and `opencode` — connect to one local broker over a Unix domain socket (`~/.pi/agent/intercom/broker.sock` or `$PI_CODING_AGENT_DIR/intercom/broker.sock`).
- **Coordinated Upgrade Set**: Protocol v4 changes broker negotiation, so the broker-capable adapters that are *actually installed and enabled on this machine* must be upgraded together in one maintenance window. Adapters you do not use do not need to be installed to satisfy the upgrade. `@ctliz/agent-intercom-core` is an internal dependency that arrives with the adapters and is never installed or upgraded on its own.
- **Orchestrator is Optional**: `agent-intercom-orchestrator` is an optional Linux/systemd lifecycle component. It does not implement or start a Broker and is not part of the Broker compatibility set. Omitting it — for example on macOS, or when using TmuxDeck — is a fully supported configuration and is **not** a mixed or unsupported state. If it is installed on a supported Linux host, or on WSL with a systemd user manager enabled, update it together with the adapters it manages.
- **Fail-Closed Legacy Handling**: An incompatible legacy (v3) broker or client fails closed. It is rejected at negotiation and never killed, never downgraded, and never allowed to form a second broker island.
- **Rollback**: Rolling back covers only the components that were actually installed on this machine before the upgrade. Restore the exact specs and lockfiles you backed up, then reload the affected agent sessions. Roll Orchestrator back only if it was installed to begin with. There is no published pre-v4 tag under `ctliz`, so a pre-upgrade backup of the exact installed specs/locks is the supported rollback material. Leaving some installed broker-capable adapters on the old protocol while others are upgraded is an unsupported mixed state.

## License

The current project is licensed under the [GNU Affero General Public License
v3.0 or later](LICENSE) (`AGPL-3.0-or-later`). If you modify this software and
make the modified version available to users over a network, the AGPL requires
you to offer those users the corresponding source code.

Portions derived from the original MIT-licensed `pi-intercom` project, `@opencode-ai/plugin`, and `zod` retain
their original notices. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and
[`licenses/`](licenses/). Versions already
published under MIT remain available under their original terms. See
[LICENSE_TRANSITION.md](LICENSE_TRANSITION.md) for the exact commit and tag boundary.

## Upgrading from `connect.1` to `connect.2`

`connect.2` renames the package namespace from `@dataforxyz/*` to `@ctliz/*`. The two namespaces are different packages to npm. Pi Git package installations deduplicate by repository URL without ref, but running agent sessions continue to execute legacy code in memory, and npm or global installs along with binary links can coexist and conflict. Operators must stop active sessions, clean active install surfaces, and follow remove-before-install — side-by-side installation is not supported.

1. Back up the exact specs, lock files, and settings of every installed component.
2. Stop or close the installed broker-capable adapters.
3. Remove the old `@dataforxyz/*` specs, packages, and binary links that are actually installed.
4. Assert the old identity is gone from the **active install surfaces of the current OS user**: Pi settings and extension specs, resolved managed install roots, actual `node_modules` installations, and conflicting binary links that the current `PATH` would resolve. Do not scan or delete unrelated source checkouts, historical documentation, or other users' files — a `@dataforxyz/*` string in an unrelated development clone is not an installation.
5. Install the `@ctliz/*` `connect.2` exact tags for the components you actually use (v0.11.0-connect.2).
6. Reload or restart, then verify exactly one broker is running.

**Classification rule.** Migration-aware `connect.2` setup and update tooling must classify an old-namespace-only install surface as `MIGRATION_REQUIRED`, and the simultaneous presence of both namespaces as a duplicate/dual-load hard error that refuses setup, update, and further installation. This tooling does not exist for every platform and adapter combination; where it is not available, apply the same two rules manually against the surfaces in step 4. Do not assume every adapter emits this code automatically.

**Rollback** reverses this and covers only the components that were installed on this machine before the upgrade: remove the `@ctliz/*` packages, then restore the backed-up exact `@dataforxyz/*` specs and locks. Roll Orchestrator back only if it was installed to begin with.

The `connect.1` tags, source commits, and published release assets are immutable and are not modified by this migration. Release notes may carry an explicit erratum, which corrects the description only and never moves a tag or replaces an asset.

Install from the exact GitHub tags, packaged tarballs, or registered release assets as shown above.
