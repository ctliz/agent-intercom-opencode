import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { IntercomClient } from "../broker/client.ts";
import { DurableInboundStore } from "./inbound-store.ts";
import { buildOpenCodeRuntimeIdentity, formatSessionDisplay, formatSessionList, OpenCodeIntercomRuntime, selectPendingAsk, type PendingInboundMessage } from "./runtime.ts";

class FakeIntercomClient extends EventEmitter {
  connected = false;
  connectCount = 0;
  sessionId: string | null = null;

  isConnected(): boolean { return this.connected; }
  async connect(_registration: unknown, sessionId?: string): Promise<void> {
    this.connected = true;
    this.connectCount += 1;
    this.sessionId = sessionId ?? "fake-session";
  }
  async disconnect(): Promise<void> {
    this.connected = false;
    this.sessionId = null;
  }
  acknowledgeMessage(): void {}
  drop(): void {
    this.connected = false;
    this.sessionId = null;
    this.emit("disconnected", new Error("broker restarted"));
  }
}

test("Intercom identity does not conflate the OpenCode session namespace", () => {
  const identity = buildOpenCodeRuntimeIdentity({ OPENCODE_INTERCOM_SESSION_ID: "intercom-worker", OPENCODE_SESSION_ID: "ses_open_code" }, "/repo", 42);
  assert.equal(identity.sessionId, "intercom-worker");
  const fallback = buildOpenCodeRuntimeIdentity({ OPENCODE_SESSION_ID: "ses_open_code" }, "/repo", 42);
  assert.notEqual(fallback.sessionId, "ses_open_code");
});

test("buildOpenCodeRuntimeIdentity supports generic AGENT_INTERCOM_SESSION_ID and NAME", () => {
  const identity = buildOpenCodeRuntimeIdentity({
    AGENT_INTERCOM_SESSION_ID: "tmuxdeck-1a2b3c4d-5e6f-47a8-b9c0-d1e2f3a4b5c6",
    AGENT_INTERCOM_SESSION_NAME: "workspace · OpenCode 01",
    PWD: "/tmp/repo",
  }, "/ignored", 123);

  assert.equal(identity.sessionId, "tmuxdeck-1a2b3c4d-5e6f-47a8-b9c0-d1e2f3a4b5c6");
  assert.equal(identity.name, "workspace · OpenCode 01");
});

test("buildOpenCodeRuntimeIdentity prefers harness-specific ID/name over generic", () => {
  const identity = buildOpenCodeRuntimeIdentity({
    OPENCODE_INTERCOM_SESSION_ID: "opencode-specific-id",
    OPENCODE_INTERCOM_NAME: "opencode-specific-name",
    AGENT_INTERCOM_SESSION_ID: "invalid generic id with spaces",
    AGENT_INTERCOM_SESSION_NAME: "generic-name",
    PWD: "/tmp/repo",
  }, "/ignored", 123);

  assert.equal(identity.sessionId, "opencode-specific-id");
  assert.equal(identity.name, "opencode-specific-name");
});

test("buildOpenCodeRuntimeIdentity treats whitespace-only generic ID and name as absent", () => {
  for (const empty of ["", "   ", "\t\n"]) {
    const identity = buildOpenCodeRuntimeIdentity({
      AGENT_INTERCOM_SESSION_ID: empty,
      AGENT_INTERCOM_SESSION_NAME: empty,
      PWD: "/tmp/project",
    }, "/tmp/project", 42);

    assert.match(identity.sessionId, /^opencode-42-[0-9a-f]{8}$/);
    assert.equal(identity.name, "opencode-project-42");
  }
});

test("buildOpenCodeRuntimeIdentity fails closed on invalid non-empty generic AGENT_INTERCOM_SESSION_ID", () => {
  for (const invalid of ["bad session id with spaces", "bad$symbol!", "a".repeat(129)]) {
    assert.throws(
      () => buildOpenCodeRuntimeIdentity({ AGENT_INTERCOM_SESSION_ID: invalid }, "/tmp", 123),
      (err: any) => {
        assert.equal(err.message, "Invalid AGENT_INTERCOM_SESSION_ID: must match ^[A-Za-z0-9_-]{1,128}$");
        assert.equal(err.message.includes(invalid), false);
        return true;
      },
      `must reject invalid generic session ID: ${invalid}`,
    );
  }
});

test("remote session provenance is visible in model-facing labels", () => {
  const remote = { id: "remote", name: "worker", cwd: "/repo", model: "test", pid: 1, startedAt: 1, lastActivity: 1, origin: "remote" as const, remoteHostId: "ika-dev-v3" };
  assert.equal(formatSessionDisplay(remote), "worker [remote:ika-dev-v3]");
  assert.match(formatSessionList([remote], null, "/other"), /worker \[remote:ika-dev-v3\]/);
});

test("selectPendingAsk uses oldest/latest without exposing message IDs", () => {
  const from = { id: "sender-1", name: "sender", cwd: "/repo", model: "test", pid: 1, startedAt: 1, lastActivity: 1 };
  const pending = (id: string, receivedAt: number): PendingInboundMessage => ({
    from,
    message: { id, timestamp: receivedAt, expectsReply: true, content: { text: id } },
    deliveryId: `delivery-${id}`,
    receivedAt,
    read: false,
  });
  const asks = [pending("ask-1", 10), pending("ask-2", 20)];

  assert.throws(() => selectPendingAsk(asks, "sender"), /specify `which`/);
  assert.equal(selectPendingAsk(asks, "sender", "oldest").message.id, "ask-1");
  assert.equal(selectPendingAsk(asks, "sender", "latest").message.id, "ask-2");
});

test("runtime reconnects automatically and reports connection state after the broker drops", async () => {
  const dir = await mkdtemp(join(tmpdir(), "opencode-intercom-reconnect-"));
  try {
    const first = new FakeIntercomClient();
    const second = new FakeIntercomClient();
    const clients = [first, second];
    const runtime = new OpenCodeIntercomRuntime(
      { sessionId: "reconnect-opencode", name: "reconnect-opencode", cwd: "/repo", model: "test", startedAt: Date.now() },
      "/repo",
      undefined,
      new DurableInboundStore(join(dir, "inbound.json")),
      {
        clientFactory: () => clients.shift() as unknown as IntercomClient,
        prepareConnection: async () => {},
        reconnectDelays: [1],
      },
    );
    const states: boolean[] = [];
    runtime.setConnectionStateHandler((connected) => states.push(connected));

    await runtime.connect();
    first.drop();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(second.connectCount, 1);
    assert.equal(second.sessionId, "reconnect-opencode");
    assert.deepEqual(states, [true, false, true]);
    await runtime.disconnect();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("inbound delivery is durably queued and acknowledged before model injection completes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "opencode-intercom-runtime-"));
  try {
    let finishInjection!: () => void;
    const injection = new Promise<void>((resolve) => { finishInjection = resolve; });
    const store = new DurableInboundStore(join(dir, "inbound.json"));
    const activity: string[] = [];
    const runtime = new OpenCodeIntercomRuntime(
      { sessionId: "receiver", name: "receiver", cwd: "/repo", model: "test", startedAt: 1 },
      "/repo",
      async () => injection,
      store,
      { onInboundActivity: (from) => { activity.push(from.id); } },
    );
    const acknowledgements: string[] = [];
    (runtime as any).client = {
      acknowledgeMessage(deliveryId: string) {
        acknowledgements.push(deliveryId);
        return true;
      },
    };

    (runtime as any).handleIncomingMessage(
      { id: "sender", name: "sender", cwd: "/repo", model: "test", pid: 1, startedAt: 1, lastActivity: 1 },
      { id: "message-1", content: { text: "hello" }, timestamp: 1 },
      "delivery-1",
    );

    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(acknowledgements, ["delivery-1"]);
    assert.deepEqual(activity, ["sender"]);
    assert.deepEqual(new DurableInboundStore(store.path).pendingInjection().map((entry) => entry.message.id), ["message-1"]);
    (runtime as any).handleIncomingMessage(
      { id: "sender", name: "sender", cwd: "/repo", model: "test", pid: 1, startedAt: 1, lastActivity: 1 },
      { id: "message-1", content: { text: "hello" }, timestamp: 1 },
      "delivery-retry",
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(activity, ["sender"], "durable duplicate replay must not renew activity twice");
    finishInjection();
    await injection;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
