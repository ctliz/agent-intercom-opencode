# Changelog

## 0.12.0-connect.4 - 2026-08-24

- Synchronize OpenCode, Pi, and Orchestrator install pins with the final Grok/AGY documentation release.

## 0.12.0-connect.3 - 2026-08-24

- Add the npm-packaged Grok Build and AGY MCP adapters to the synchronized Agent Intercom family documentation.
- Refresh npm and companion Pi/Orchestrator install examples to current releases.

## 0.12.0-connect.2 - 2026-08-23

- Explicitly disable shell execution for broker, fleet, Git, and clipboard child processes.
- Publish prerelease builds under their derived npm dist-tag instead of attempting to update `latest`.

## 0.12.0-connect.1 - 2026-08-15

- Self-contained production runtime (`networkRequired: false`): bundle exact reachable `@opencode-ai/plugin` tool and `zod` schema runtime into `dist/plugin.mjs`, eliminating all production runtime npm dependencies (`dependencies` is removed).
- Default-only production plugin entry shim (`opencode/plugin-entry.ts`) ensuring `dist/plugin.mjs` exports strictly a single callable `default` export with zero non-function named exports for OpenCode CLI 1.18.18 loader parity.
- Core remains the sole external runtime peer dependency (`@ctliz/agent-intercom-core` 0.2.0).
- Move `@opencode-ai/plugin` to devDependencies pinned at `1.18.18`.
- Bundle third-party MIT notices for `@opencode-ai/plugin` and `zod` in `licenses/` and record provenance in `THIRD_PARTY_NOTICES.md`.
- Support TmuxDeck Auto-Team manifest resolution (`AGENT_INTERCOM_TEAM_MANIFEST`), workspace live roster fallback, and managed coworker inbox resolution.

## 0.11.0-connect.2 - 2026-08-14

- First canonical `@ctliz/*` package namespace migration from legacy `@dataforxyz/*`.
- Introduce fail-closed namespace migration diagnostics and remove-before-install upgrade tooling across install surfaces.
- Align canonical GitHub owner to `ctliz`.

## 0.11.0-connect.1 - 2026-08-14

- Support Protocol v4 broker-enforced scope isolation (`AGENT_INTERCOM_SCOPE_ID`) and canonical `ctliz` distribution.
- Pin Core dependency to canonical commit `aad1985e125516b318181560293145bf2507cc6d` (`v0.1.0-connect.1`).
- Reject competing live runtimes that claim an active stable session ID while preserving legitimate reconnects and pending deliveries.
- Renew an owned worker's activity-bounded lifecycle only when the primary OpenCode manager receives a message from that exact worker, and expose manager acknowledgment for terminal `forget` operations.
- Add ID-free `oldest`/`latest` selection for multiple pending asks from one sender, hide protocol IDs from pending output, and refuse a second unresolved ask to the same recipient.
- Automatically reconnect the runtime with its stable Intercom identity after broker restarts and report reconnecting health state.
- Clarify that assignments and progress/status checkpoints use `intercom_send`, reserving `intercom_ask` for blocking decisions.

## 0.10.0 - 2026-07-16

- Add `intercom_team` for adoption-safe manager and same-manager coworker discovery.
- Expose orchestrator `versions` and source-aware `update` actions through the native OpenCode fleet bridge.

## 0.9.3 - 2026-07-15

- Expose the orchestrator's manager-scoped fleet listing and explicit `all` diagnostics option through the native OpenCode `agent_fleet` bridge.
- Coordinate the Agent Intercom family on the `0.9.3` release line.

## 0.9.2 - 2026-07-14

- Coordinate the Agent Intercom family on the `0.9.2` release line.
- Declare canonical GitHub repository metadata for npm provenance verification.

- Add CI for branches and pull requests.
- Add tag-driven npm trusted publishing with provenance and automatic GitHub Releases.

## 0.9.1 - 2026-07-14

- Publish the package under the public npm scope `@dataforxyz/agent-intercom-opencode`.
- Keep the Git repository and executable names unchanged.

## 0.9.0 - 2026-07-14

- Align the Agent Intercom family on one coordinated `0.9.0` release line.
- No behavior change from the immediately preceding AGPL release.

## 0.3.0 - 2026-07-14

- Change the current project license to `AGPL-3.0-or-later`. Previously published MIT versions remain under MIT, and original `pi-intercom` notices are preserved in `THIRD_PARTY_NOTICES.md`.
- Persist inbound messages before broker acknowledgement and replay unfinished injection after restart.
- Retain unresolved asks durably until a successful reply and keep a bounded delivered-ID ledger.
- Add OpenCode message metadata/markers plus session-history checks for crash-safe duplicate suppression.
- Queue and acknowledge inbound messages before long headless model turns, using `session.promptAsync` for both idle and busy server sessions.
- Publish atomic readiness/health metadata with Intercom state, server URL, OpenCode session ID, status, and errors.
- Support stable persistent-session resume through the orchestrator launcher.
- Add opt-in native `agent_fleet` management backed by the orchestrator package CLI; owned workers suppress recursive fleet creation by default.
- Correctly read SDK session status objects and separate Intercom IDs from OpenCode session IDs.
- Bound long-lived known-session and delivered-message sets.
- Support persistent `opencode serve` peers without broker delivery timeouts disconnecting otherwise healthy receivers.

## 0.2.0

- Upgrade the shared broker/client transport to strict intercom protocol v3.
- Add receiver acknowledgements and sender delivery IDs.
- Add durable sender outbox replay and incompatible-broker replacement.
- Add broker-confirmed ask defer/cancel behavior and late-reply support.
- Add the optional OpenCode TUI entry with Alt+I contact copying.
