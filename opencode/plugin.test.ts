import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { IntercomClient } from "../broker/client.ts";
import { DurableInboundStore } from "./inbound-store.ts";
import { OpenCodeIntercomRuntime } from "./runtime.ts";
import { OpenCodeIntercomPlugin } from "./plugin.ts";

class TestIntercomClient extends EventEmitter {
  connected = false;
  connectCount = 0;
  sessionId: string | null = null;
  registrations: any[] = [];
  presences: Array<{ name?: string; status?: string; model?: string }> = [];

  isConnected(): boolean { return this.connected; }
  async connect(registration?: unknown, sessionId?: string): Promise<void> {
    this.connected = true;
    this.connectCount += 1;
    this.sessionId = sessionId ?? "fake-session";
    if (registration) this.registrations.push(registration);
  }
  updatePresence(updates: { name?: string; status?: string; model?: string }): void {
    this.presences.push(updates);
  }
  async listSessions(): Promise<any[]> {
    return [];
  }
  async disconnect(): Promise<void> {
    this.connected = false;
    this.sessionId = null;
  }
  acknowledgeMessage(): void {}
  drop(): void {
    this.connected = false;
    this.sessionId = null;
    this.emit("disconnected", new Error("broker dropped"));
  }
}

function createMockClient(sessions: any[] = []) {
  const sessionMap = new Map<string, any>(sessions.map((s) => [s.id, s]));
  return {
    session: {
      list: async () => ({ data: Array.from(sessionMap.values()) }),
      get: async ({ path }: { path: { id: string } }) => {
        const found = sessionMap.get(path.id);
        if (!found) return { data: undefined };
        return { data: found };
      },
      promptAsync: async () => ({ response: { ok: true } }),
      messages: async () => ({ data: [] }),
    },
    tui: {
      showToast: async () => ({ data: true }),
      appendPrompt: async () => ({ data: true }),
      submitPrompt: async () => ({ data: true }),
    },
  };
}

test("plugin syncs native title from initial SDK session and preserves name on reconnect", async () => {
  const dir = await mkdtemp(join(tmpdir(), "opencode-plugin-initial-"));
  const firstClient = new TestIntercomClient();
  const secondClient = new TestIntercomClient();
  const clients = [firstClient, secondClient];

  const initialSessions = [
    {
      id: "ses-initial",
      title: "Feature: Add Dark Mode",
      directory: dir,
      time: { created: 100, updated: 200 },
    },
  ];
  const mockClient = createMockClient(initialSessions);

  const runtime = new OpenCodeIntercomRuntime(
    { sessionId: "stable-opencode-id", name: "fallback-name", cwd: dir, model: "test", startedAt: 1 },
    dir,
    undefined,
    new DurableInboundStore(join(dir, "inbound.json")),
    {
      prepareConnection: async () => {},
      reconnectDelays: [1],
      clientFactory: () => clients.shift() as unknown as IntercomClient,
    },
  );

  const plugin = await OpenCodeIntercomPlugin(
    { client: mockClient as any, directory: dir, serverUrl: new URL("http://localhost:3000") },
    { runtime },
  );

  try {
    // Wait for eager startup connection and initial session resolution
    await new Promise((resolve) => setTimeout(resolve, 30));

    const system = { system: [] as string[] };
    await plugin["experimental.chat.system.transform"]?.({ model: {} as any }, system);
    assert.match(system.system.join("\n"), /ask once/);
    assert.match(system.system.join("\n"), /Wait for approval/);
    assert.match(system.system.join("\n"), /Membership is additive/);
    const properties = (name: string) => (plugin.tool![name]!.args as any);
    assert.ok(properties("intercom_join").members);
    assert.ok(properties("intercom_join").work);
    for (const name of ["intercom_team", "intercom_send", "intercom_ask", "intercom_reply"]) assert.ok(properties(name).team);
    assert.ok(properties("intercom_reply").askId);
    assert.ok(properties("intercom_reply").contextId);
    assert.equal(runtime.getIdentity().name, "Feature: Add Dark Mode");
    assert.equal(runtime.getIdentity().sessionId, "stable-opencode-id");
    assert.deepEqual(firstClient.presences, [{ name: "Feature: Add Dark Mode" }]);

    // Trigger reconnect and verify remembered name and stable session ID are preserved
    firstClient.drop();
    await new Promise((resolve) => setTimeout(resolve, 30));

    assert.equal(secondClient.connectCount, 1);
    assert.equal(secondClient.sessionId, "stable-opencode-id");
    assert.equal(secondClient.registrations[0].name, "Feature: Add Dark Mode");
  } finally {
    await plugin.dispose?.();
    await rm(dir, { recursive: true, force: true });
  }
});

test("plugin syncs title on session.created and session.updated without empty-title overwrites", async () => {
  const dir = await mkdtemp(join(tmpdir(), "opencode-plugin-events-"));
  const client = new TestIntercomClient();

  const mockClient = createMockClient();
  const runtime = new OpenCodeIntercomRuntime(
    { sessionId: "ses-events-id", name: "initial-opencode-name", cwd: dir, model: "test", startedAt: 1 },
    dir,
    undefined,
    new DurableInboundStore(join(dir, "inbound.json")),
    {
      prepareConnection: async () => {},
      clientFactory: () => client as unknown as IntercomClient,
    },
  );

  const plugin = await OpenCodeIntercomPlugin(
    { client: mockClient as any, directory: dir, serverUrl: new URL("http://localhost:3000") },
    { runtime },
  );

  try {
    await new Promise((resolve) => setTimeout(resolve, 30));

    // session.created with initial title
    await plugin.event?.({
      event: {
        type: "session.created",
        properties: {
          info: {
            id: "ses-main",
            title: "Task: Fix Login",
            directory: dir,
            time: { created: 10, updated: 10 },
          },
        },
      } as any,
    });

    assert.equal(runtime.getIdentity().name, "Task: Fix Login");
    assert.equal(client.presences[client.presences.length - 1]?.name, "Task: Fix Login");

    // session.updated with updated title
    await plugin.event?.({
      event: {
        type: "session.updated",
        properties: {
          info: {
            id: "ses-main",
            title: "Task: Fix Login and 2FA",
            directory: dir,
            time: { created: 10, updated: 20 },
          },
        },
      } as any,
    });

    assert.equal(runtime.getIdentity().name, "Task: Fix Login and 2FA");
    assert.equal(client.presences[client.presences.length - 1]?.name, "Task: Fix Login and 2FA");

    // session.updated with empty/whitespace title must NOT overwrite
    for (const emptyTitle of ["", "   ", "\t"]) {
      await plugin.event?.({
        event: {
          type: "session.updated",
          properties: {
            info: {
              id: "ses-main",
              title: emptyTitle,
              directory: dir,
              time: { created: 10, updated: 30 },
            },
          },
        } as any,
      });
      assert.equal(runtime.getIdentity().name, "Task: Fix Login and 2FA");
    }
  } finally {
    await plugin.dispose?.();
    await rm(dir, { recursive: true, force: true });
  }
});

test("subagents and unrelated sessions cannot hijack active session ID or title", async () => {
  const dir = await mkdtemp(join(tmpdir(), "opencode-subagent-isolation-"));
  const client = new TestIntercomClient();

  const mockClient = createMockClient();
  const runtime = new OpenCodeIntercomRuntime(
    { sessionId: "ses-isolation-id", name: "authoritative-session", cwd: dir, model: "test", startedAt: 1 },
    dir,
    undefined,
    new DurableInboundStore(join(dir, "inbound.json")),
    {
      prepareConnection: async () => {},
      clientFactory: () => client as unknown as IntercomClient,
    },
  );

  const plugin = await OpenCodeIntercomPlugin(
    { client: mockClient as any, directory: dir, serverUrl: new URL("http://localhost:3000") },
    { runtime },
  );

  try {
    await new Promise((resolve) => setTimeout(resolve, 30));

    // Establish main session
    await plugin.event?.({
      event: {
        type: "session.created",
        properties: {
          info: {
            id: "ses-main",
            title: "Authoritative Task",
            directory: dir,
            time: { created: 10, updated: 10 },
          },
        },
      } as any,
    });

    assert.equal(runtime.getIdentity().name, "Authoritative Task");

    // Subagent session.created with parentID must be ignored
    await plugin.event?.({
      event: {
        type: "session.created",
        properties: {
          info: {
            id: "ses-subagent-1",
            parentID: "ses-main",
            title: "Subagent: Code Search",
            directory: dir,
            time: { created: 15, updated: 15 },
          },
        },
      } as any,
    });

    assert.equal(runtime.getIdentity().name, "Authoritative Task");

    // Subagent session.updated with parentID must be ignored
    await plugin.event?.({
      event: {
        type: "session.updated",
        properties: {
          info: {
            id: "ses-subagent-1",
            parentID: "ses-main",
            title: "Subagent: Completed",
            directory: dir,
            time: { created: 15, updated: 25 },
          },
        },
      } as any,
    });

    assert.equal(runtime.getIdentity().name, "Authoritative Task");

    // Unrelated session ID on session.updated must be ignored
    await plugin.event?.({
      event: {
        type: "session.updated",
        properties: {
          info: {
            id: "ses-unrelated-foreign",
            title: "Foreign Task",
            directory: dir,
            time: { created: 5, updated: 30 },
          },
        },
      } as any,
    });

    assert.equal(runtime.getIdentity().name, "Authoritative Task");

    // Unrelated directory on session.created must be ignored
    await plugin.event?.({
      event: {
        type: "session.created",
        properties: {
          info: {
            id: "ses-other-dir",
            title: "Other Directory Project",
            directory: "/completely/different/workspace",
            time: { created: 40, updated: 40 },
          },
        },
      } as any,
    });

    assert.equal(runtime.getIdentity().name, "Authoritative Task");

    // Subagent status/idle events must not alter main session status
    await plugin.event?.({
      event: {
        type: "session.status",
        properties: {
          sessionID: "ses-subagent-1",
          status: { type: "busy" },
        },
      } as any,
    });

    // Main session status was idle, should remain idle
    const statusCalls = client.presences.filter((p) => p.status !== undefined);
    assert.equal(statusCalls.some((p) => p.status === "busy"), false);
  } finally {
    await plugin.dispose?.();
    await rm(dir, { recursive: true, force: true });
  }
});

test("target session pinned via env cannot be hijacked by other sessions", async () => {
  const dir = await mkdtemp(join(tmpdir(), "opencode-pinned-"));
  const client = new TestIntercomClient();
  const previousPinned = process.env.OPENCODE_INTERCOM_TARGET_SESSION;
  process.env.OPENCODE_INTERCOM_TARGET_SESSION = "pinned-target-session";

  const initialSessions = [
    {
      id: "pinned-target-session",
      title: "Pinned Mandate",
      directory: dir,
      time: { created: 10, updated: 10 },
    },
  ];
  const mockClient = createMockClient(initialSessions);
  const runtime = new OpenCodeIntercomRuntime(
    { sessionId: "ses-pinned-intercom", name: "fallback-pinned", cwd: dir, model: "test", startedAt: 1 },
    dir,
    undefined,
    new DurableInboundStore(join(dir, "inbound.json")),
    {
      prepareConnection: async () => {},
      clientFactory: () => client as unknown as IntercomClient,
    },
  );

  const plugin = await OpenCodeIntercomPlugin(
    { client: mockClient as any, directory: dir, serverUrl: new URL("http://localhost:3000") },
    { runtime },
  );

  try {
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(runtime.getIdentity().name, "Pinned Mandate");

    // Another session created must not hijack active session
    await plugin.event?.({
      event: {
        type: "session.created",
        properties: {
          info: {
            id: "ses-other-contender",
            title: "Contender Title",
            directory: dir,
            time: { created: 50, updated: 50 },
          },
        },
      } as any,
    });

    assert.equal(runtime.getIdentity().name, "Pinned Mandate");

    // Tool execution context for a different session cannot hijack
    const whoamiTool = plugin.tool.intercom_whoami;
    await whoamiTool.execute({}, { sessionID: "ses-other-contender" });
    assert.equal(runtime.getIdentity().name, "Pinned Mandate");
  } finally {
    if (previousPinned === undefined) delete process.env.OPENCODE_INTERCOM_TARGET_SESSION;
    else process.env.OPENCODE_INTERCOM_TARGET_SESSION = previousPinned;
    await plugin.dispose?.();
    await rm(dir, { recursive: true, force: true });
  }
});

test("resolveActiveSessionID returns undefined and ignores candidates when only subagents exist", async () => {
  const dir = await mkdtemp(join(tmpdir(), "opencode-only-subagents-"));
  const client = new TestIntercomClient();
  const subagentOnlySessions = [
    {
      id: "ses-child-1",
      parentID: "ses-nonexistent-root",
      title: "Subagent Task 1",
      directory: dir,
      time: { created: 10, updated: 20 },
    },
    {
      id: "ses-child-2",
      parentID: "ses-nonexistent-root",
      title: "Subagent Task 2",
      directory: dir,
      time: { created: 30, updated: 40 },
    },
  ];
  const mockClient = createMockClient(subagentOnlySessions);
  const runtime = new OpenCodeIntercomRuntime(
    { sessionId: "ses-stable", name: "initial-top-level", cwd: dir, model: "test", startedAt: 1 },
    dir,
    undefined,
    undefined,
    {
      prepareConnection: async () => {},
      clientFactory: () => client as unknown as IntercomClient,
    },
  );

  const plugin = await OpenCodeIntercomPlugin(
    { client: mockClient as any, directory: dir, serverUrl: new URL("http://localhost:3000") },
    { runtime },
  );

  try {
    await new Promise((resolve) => setTimeout(resolve, 30));
    // Name should NOT have been overwritten by any subagent task
    assert.equal(runtime.getIdentity().name, "initial-top-level");
  } finally {
    await plugin.dispose?.();
    await rm(dir, { recursive: true, force: true });
  }
});

test("stale startup session.list cannot overwrite an already-received rename or new-session event", async () => {
  const dir = await mkdtemp(join(tmpdir(), "opencode-stale-list-"));
  const client = new TestIntercomClient();
  let resolveSessionList: (() => void) | undefined;

  const mockClient = {
    session: {
      list: async () => {
        await new Promise<void>((resolve) => {
          resolveSessionList = resolve;
        });
        return {
          data: [
            {
              id: "ses-stale-list",
              title: "Old Stale Title From List",
              directory: dir,
              time: { created: 10, updated: 10 },
            },
          ],
        };
      },
      get: async () => ({ data: undefined }),
      promptAsync: async () => ({ response: { ok: true } }),
      messages: async () => ({ data: [] }),
    },
    tui: {
      showToast: async () => ({ data: true }),
      appendPrompt: async () => ({ data: true }),
      submitPrompt: async () => ({ data: true }),
    },
  };

  const runtime = new OpenCodeIntercomRuntime(
    { sessionId: "ses-race", name: "initial-runtime-name", cwd: dir, model: "test", startedAt: 1 },
    dir,
    undefined,
    undefined,
    {
      prepareConnection: async () => {},
      clientFactory: () => client as unknown as IntercomClient,
    },
  );

  const plugin = await OpenCodeIntercomPlugin(
    { client: mockClient as any, directory: dir, serverUrl: new URL("http://localhost:3000") },
    { runtime },
  );

  try {
    // Wait until runtime connects and session.list is pending
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok(resolveSessionList, "session.list must be in flight");

    // An event arrives while session.list is still pending
    await plugin.event?.({
      event: {
        type: "session.created",
        properties: {
          info: {
            id: "ses-live-event",
            title: "Fresh Event Title",
            directory: dir,
            time: { created: 50, updated: 50 },
          },
        },
      } as any,
    });

    assert.equal(runtime.getIdentity().name, "Fresh Event Title");

    // Now let the stale startup session.list complete
    resolveSessionList!();
    await new Promise((resolve) => setTimeout(resolve, 30));

    // Stale startup session.list must NOT have overwritten the event's title
    assert.equal(runtime.getIdentity().name, "Fresh Event Title");
  } finally {
    await plugin.dispose?.();
    await rm(dir, { recursive: true, force: true });
  }
});
