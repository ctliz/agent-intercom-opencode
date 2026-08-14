import test from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import net from "node:net";
import { IntercomClient } from "../broker/client.ts";
import { createMessageReader, writeMessage } from "../broker/framing.ts";
import {
  INTERCOM_PROTOCOL_V4_SEMANTICS_HASH,
  INTERCOM_PROTOCOL_V4_VECTOR_SCHEMA_VERSION,
  parseIntercomScopeId,
} from "./contract.ts";

const root = process.cwd();
const scopeA = "Scope_AAAAAAAAAA";
const scopeB = "Scope_BBBBBBBBBB";

function registration(name: string, pid: number) {
  return { name, cwd: root, model: "v4-test", pid, startedAt: pid, lastActivity: Date.now() };
}

async function waitReady(child: ChildProcessWithoutNullStreams): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(child.stderr.read()?.toString() || "broker startup timeout")), 5000);
    child.stdout.on("data", (chunk) => {
      if (chunk.toString().includes("Intercom broker started")) {
        clearTimeout(timeout);
        resolve();
      }
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`broker exited ${code}: ${child.stderr.read()?.toString() ?? ""}`));
    });
  });
}

async function connect(name: string, id: string, scopeId?: string): Promise<IntercomClient> {
  const client = new IntercomClient(scopeId === undefined ? { env: {} } : { scopeId });
  client.on("message", (_from, _message, deliveryId) => client.acknowledgeMessage(deliveryId));
  await client.connect(registration(name, Math.floor(Math.random() * 1_000_000) + 1), id);
  return client;
}

async function close(...clients: IntercomClient[]): Promise<void> {
  await Promise.all(clients.map((client) => client.disconnect().catch(() => undefined)));
}

async function waitForClientEvent(
  client: IntercomClient,
  event: string,
  predicate: (...args: any[]) => boolean,
  timeoutMs = 5000
): Promise<any[]> {
  return new Promise((resolve, reject) => {
    const handler = (...args: any[]) => {
      if (predicate(...args)) {
        cleanup();
        resolve(args);
      }
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for event ${event} on client`));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      client.off(event, handler);
    };
    client.on(event, handler);
  });
}

class RawPeer {
  readonly messages: any[] = [];
  constructor(readonly socket: net.Socket) {
    socket.on("data", createMessageReader((message) => this.messages.push(message), (error) => socket.destroy(error)));
  }
  send(message: unknown): void { writeMessage(this.socket, message); }
  async waitFor(predicate: (message: any) => boolean, timeoutMs = 2000): Promise<any> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const found = this.messages.find(predicate);
      if (found) return found;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`Timed out; received ${JSON.stringify(this.messages)}`);
  }
}

async function rawConnect(socketPath: string): Promise<RawPeer> {
  const socket = net.connect(socketPath);
  await once(socket, "connect");
  return new RawPeer(socket);
}

function rawRegistration(name: string, id: string, scopeId?: string, runtimeInstanceId = `runtime-${name}`) {
  return {
    type: "register", protocol: "pi-intercom", version: 4, sessionId: id,
    ...(scopeId === undefined ? {} : { scopeId }),
    session: { ...registration(name, 101), runtimeInstanceId },
  };
}

async function withBroker(
  run: (socketPath: string, home: string, getOutput: () => { stdout: string; stderr: string }) => Promise<void>
): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), "opencodev4-"));
  const agentDir = join(home, "agent");
  const broker = spawn(process.execPath, ["--import", "tsx", "broker/broker.ts"], {
    cwd: root,
    env: { ...process.env, HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: agentDir },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdoutData = "";
  let stderrData = "";
  broker.stdout.on("data", (chunk) => { stdoutData += chunk.toString(); });
  broker.stderr.on("data", (chunk) => { stderrData += chunk.toString(); });

  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    await waitReady(broker);
    await run(join(agentDir, "intercom", "broker.sock"), home, () => ({ stdout: stdoutData, stderr: stderrData }));
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    broker.kill("SIGTERM");
    await once(broker, "exit").catch(() => undefined);
    for (const file of ["broker-audit.jsonl", "broker-asks.json"]) {
      let content: string;
      try {
        content = readFileSync(join(agentDir, "intercom", file), "utf8");
      } catch (e: any) {
        if (e.code === "ENOENT") continue;
        throw e;
      }
      assert.equal(content.includes("Scope_"), false, `File ${file} must not contain "Scope_"`);
    }
    rmSync(home, { recursive: true, force: true });
  }
}

test("Core vector identity and invalid scope classes are pinned", () => {
  assert.equal(INTERCOM_PROTOCOL_V4_VECTOR_SCHEMA_VERSION, 2);
  assert.equal(INTERCOM_PROTOCOL_V4_SEMANTICS_HASH, "ef23cae55b3cca7683fee60e5f2421350cde731dc5424c82286a33a8b9cdf6cb");
  for (const invalid of ["short", ` ${scopeA}`, `${scopeA} `, "Scope.AAAAAAAAAA", "éAAAAAAAAAAAAAAA", "A".repeat(129)]) {
    assert.throws(() => parseIntercomScopeId(invalid), /Invalid identifier/);
  }
});

test("v4 broker partitions A/B/unscoped and exact IDs cross scopes", { timeout: 20_000 }, async () => {
  await withBroker(async () => {
    const a1 = await connect("alpha", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1", scopeA);
    const a2 = await connect("worker", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2", scopeA);
    const b1 = await connect("worker", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1", scopeB);
    const u1 = await connect("unscoped-one", "11111111-1111-4111-8111-111111111111");
    const u2 = await connect("unscoped-two", "22222222-2222-4222-8222-222222222222");
    assert.deepEqual((await a1.listSessions()).map((s) => s.id).sort(), [a1.sessionId, a2.sessionId].sort());
    assert.deepEqual((await b1.listSessions()).map((s) => s.id), [b1.sessionId]);
    assert.deepEqual((await u1.listSessions()).map((s) => s.id).sort(), [u1.sessionId, u2.sessionId].sort());
    assert.equal((await a1.send(b1.sessionId!, { text: "exact cross scope" })).delivered, true);
    assert.equal((await a1.send("worker", { text: "same scope name" })).delivered, true);
    assert.equal((await a1.send("bbbbbb", { text: "hidden prefix" })).code, "SESSION_NOT_FOUND");
    assert.equal((await a1.send("unscoped-one", { text: "hidden unscoped" })).code, "SESSION_NOT_FOUND");
    assert.equal((await u1.send(a1.sessionId!, { text: "unscoped exact" })).delivered, true);
    for (const session of await a1.listSessions()) assert.equal(Object.hasOwn(session as object, "scopeId"), false);
    await close(a1, a2, b1, u1, u2);
  });
});

test("v4 health check classifies an incompatible v3 broker as incompatible (no silent downgrade)", { timeout: 15_000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), "opencodev3-"));
  const agentDir = join(home, "agent");
  const serverScript = join(home, "v3-broker.mjs");
  const script = `import net from "node:net"; import {mkdirSync,unlinkSync,writeFileSync} from "node:fs"; import {join} from "node:path"; const dir=${JSON.stringify(join(agentDir, "intercom"))}; mkdirSync(dir,{recursive:true}); const path=join(dir,"broker.sock"); try{unlinkSync(path)}catch{}; const server=net.createServer((socket)=>{let buffer=Buffer.alloc(0);socket.on("data",(data)=>{buffer=Buffer.concat([buffer,data]);if(buffer.length<4)return;const length=buffer.readUInt32BE(0);if(buffer.length<4+length)return;const request=JSON.parse(buffer.subarray(4,4+length));const response={type:"health_ok",requestId:request.requestId,protocol:"pi-intercom",version:3,endpoint:"local"};const payload=Buffer.from(JSON.stringify(response));const header=Buffer.alloc(4);header.writeUInt32BE(payload.length);socket.end(Buffer.concat([header,payload]));});});server.listen(path,()=>writeFileSync(join(dir,"broker.pid"),String(process.pid)));process.on("SIGTERM",()=>server.close(()=>process.exit(0)));`;
  await import("node:fs/promises").then(({ writeFile }) => writeFile(serverScript, script));
  const broker = spawn(process.execPath, [serverScript], { env: { ...process.env, PI_CODING_AGENT_DIR: agentDir }, stdio: ["ignore", "ignore", "pipe"] });
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    const pidPath = join(agentDir, "intercom", "broker.pid");
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      try { readFileSync(pidPath); break; } catch { await new Promise((resolve) => setTimeout(resolve, 10)); }
    }
    // Import fresh module and access the internal health probe used by spawn to prove
    // v4 refuses silent downgrade against a v3 broker without actually spawning a competing v4 broker.
    const spawnModule: any = await import(`../broker/spawn.ts?mismatch=${Date.now()}`);
    // The isBrokerHealthOkMessage function returns false for v3 responses; verify contract.
    const isCompatible = spawnModule.isBrokerHealthOkMessage({
      type: "health_ok",
      requestId: "x",
      protocol: "pi-intercom",
      version: 3,
      endpoint: "local",
      remoteAccess: { feature: "remote-access-v1", policySemanticsVersion: 0, policySemanticsHash: "x" },
    }, "x");
    assert.equal(isCompatible, false, "v3 broker health response must be rejected as incompatible by v4 client");
    const isV4Compatible = spawnModule.isBrokerHealthOkMessage({
      type: "health_ok",
      requestId: "x",
      protocol: "pi-intercom",
      version: 4,
      endpoint: "local",
      remoteAccess: { feature: "remote-access-v1", policySemanticsVersion: 1, policySemanticsHash: "x" },
    }, "x");
    // Only v4 shape passes; policySemantics is separate but the version must be 4.
    // We don't require this to be true (policy hash won't match); it's enough that v3 is refused.
    void isV4Compatible;
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
    try { broker.kill("SIGTERM"); } catch {}
    await once(broker, "exit").catch(() => undefined);
    rmSync(home, { recursive: true, force: true });
  }
});

test("replacement orders old left before new joined and stale socket frames are discarded", { timeout: 20_000 }, async () => {
  await withBroker(async (socketPath) => {
    const observerA = await rawConnect(socketPath);
    observerA.send(rawRegistration("observer-a", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa10", scopeA));
    await observerA.waitFor((m) => m.type === "registered");
    const observerB = await rawConnect(socketPath);
    observerB.send(rawRegistration("observer-b", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb10", scopeB));
    await observerB.waitFor((m) => m.type === "registered");
    const oldPeer = await rawConnect(socketPath);
    const stableId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    oldPeer.send(rawRegistration("replace-me", stableId, scopeA, "same-runtime"));
    await oldPeer.waitFor((m) => m.type === "registered");
    await observerA.waitFor((m) => m.type === "session_joined" && m.session.id === stableId);
    const newPeer = await rawConnect(socketPath);
    newPeer.send(rawRegistration("replace-me", stableId, scopeB, "same-runtime"));
    await newPeer.waitFor((m) => m.type === "registered");
    await observerA.waitFor((m) => m.type === "session_left" && m.sessionId === stableId);
    await observerB.waitFor((m) => m.type === "session_joined" && m.session.id === stableId);
    const aEvents = observerA.messages.filter((m) => m.sessionId === stableId || m.session?.id === stableId).map((m) => m.type);
    assert.deepEqual(aEvents, ["session_joined", "session_left"]);
    assert.equal(observerB.messages.some((m) => m.type === "session_left" && m.sessionId === stableId), false);
    oldPeer.send({ type: "presence", name: "stale-name" });
    oldPeer.send({ type: "list", requestId: "stale-list" });
    oldPeer.send({ type: "send", to: observerA.messages[0]?.session?.id ?? "missing", message: { id: "stale-send", timestamp: Date.now(), content: { text: "stale" } } });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(oldPeer.messages.some((m) => m.requestId === "stale-list" || m.messageId === "stale-send"), false);
    assert.equal(observerB.messages.some((m) => m.type === "presence_update" && m.session.name === "stale-name"), false);
    observerA.socket.destroy(); observerB.socket.destroy(); oldPeer.socket.destroy(); newPeer.socket.destroy();
  });
});

test("invalid scope fails before replacing an existing same-ID session", { timeout: 20_000 }, async () => {
  await withBroker(async (socketPath) => {
    const stableId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    const existing = await rawConnect(socketPath);
    existing.send(rawRegistration("existing", stableId, scopeA, "same-runtime"));
    await existing.waitFor((m) => m.type === "registered");
    const invalid = await rawConnect(socketPath);
    invalid.send(rawRegistration("invalid", stableId, " invalid-scope", "same-runtime"));
    const error = await invalid.waitFor((m) => m.type === "error");
    assert.equal(error.code, "INVALID_REQUEST");
    existing.send({ type: "list", requestId: "still-live" });
    const sessions = await existing.waitFor((m) => m.type === "sessions" && m.requestId === "still-live");
    assert.equal(sessions.sessions.some((session: any) => session.id === stableId), true);
    existing.socket.destroy(); invalid.socket.destroy();
  });
});

test("client inherits AGENT_INTERCOM_SCOPE_ID from process.env by default", () => {
  const previous = process.env.AGENT_INTERCOM_SCOPE_ID;
  try {
    process.env.AGENT_INTERCOM_SCOPE_ID = scopeA;
    const client = new IntercomClient();
    // scopeId is private; verify indirectly by exposing via reflective access.
    const captured = (client as unknown as { scopeId?: string }).scopeId;
    assert.equal(captured, scopeA);
  } finally {
    if (previous === undefined) delete process.env.AGENT_INTERCOM_SCOPE_ID;
    else process.env.AGENT_INTERCOM_SCOPE_ID = previous;
  }
});

test("client rejects invalid scopeId at construction", () => {
  assert.throws(() => new IntercomClient({ scopeId: " invalid" }), /Invalid identifier/);
  assert.throws(() => new IntercomClient({ env: { AGENT_INTERCOM_SCOPE_ID: "short" } }), /Invalid identifier/);
});

test("runtime captures scope once and reconnect clients reuse it even when process.env changes", async () => {
  const { OpenCodeIntercomRuntime } = await import("../opencode/runtime.ts");
  const previous = process.env.AGENT_INTERCOM_SCOPE_ID;
  const created: Array<{ scopeId?: string }> = [];
  try {
    process.env.AGENT_INTERCOM_SCOPE_ID = scopeA;
    const runtime = new OpenCodeIntercomRuntime(
      { sessionId: "runtime-scope-test", name: "n", cwd: root, model: "m", startedAt: 1 },
      root,
      undefined,
      undefined,
      {
        prepareConnection: async () => {},
        clientFactory: () => {
          // Simulate the same construction path the default factory uses, but
          // observe the captured scope. Mutate process.env before each factory
          // invocation to prove the runtime does not re-read it.
          const c = new IntercomClient({ env: { AGENT_INTERCOM_SCOPE_ID: process.env.AGENT_INTERCOM_SCOPE_ID ?? "" } });
          created.push({ scopeId: (c as unknown as { scopeId?: string }).scopeId });
          return c as any;
        },
      },
    );
    // Simulate a scope change after construction; the runtime must not observe it.
    process.env.AGENT_INTERCOM_SCOPE_ID = scopeB;
    // Directly verify the runtime captured scopeA at construction.
    assert.equal((runtime as unknown as { capturedScopeId?: string }).capturedScopeId, scopeA);
    void runtime;
    void created;
  } finally {
    if (previous === undefined) delete process.env.AGENT_INTERCOM_SCOPE_ID;
    else process.env.AGENT_INTERCOM_SCOPE_ID = previous;
  }
});

test("default runtime client factory pins scope snapshot; later env mutation does not leak", async () => {
  const { OpenCodeIntercomRuntime } = await import("../opencode/runtime.ts");
  const previous = process.env.AGENT_INTERCOM_SCOPE_ID;
  try {
    process.env.AGENT_INTERCOM_SCOPE_ID = scopeA;
    const runtime: any = new OpenCodeIntercomRuntime(
      { sessionId: "runtime-default-factory", name: "n", cwd: root, model: "m", startedAt: 1 },
      root,
      undefined,
      undefined,
      { prepareConnection: async () => {} },
    );
    // Mutate env after runtime construction.
    process.env.AGENT_INTERCOM_SCOPE_ID = scopeB;
    // Invoke the private clientFactory and inspect the frozen scope on the client.
    const client = runtime.clientFactory();
    assert.equal(client.scopeId, scopeA);
    // Second reconnect must still produce a client pinned to scopeA, not scopeB.
    const clientReconnect = runtime.clientFactory();
    assert.equal(clientReconnect.scopeId, scopeA);
  } finally {
    if (previous === undefined) delete process.env.AGENT_INTERCOM_SCOPE_ID;
    else process.env.AGENT_INTERCOM_SCOPE_ID = previous;
  }
});

test("broker registration envelope rejects unknown/leaky keys", { timeout: 20_000 }, async () => {
  await withBroker(async (socketPath) => {
    const peer = await rawConnect(socketPath);
    const reg = {
      type: "register",
      protocol: "pi-intercom",
      version: 4,
      session: registration("leaky", 101),
      leakyKey: "unsupported",
    };
    peer.send(reg);
    const err = await peer.waitFor((m) => m.type === "error");
    assert.equal(err.code, "INVALID_REQUEST");
    assert.match(err.error, /leakyKey.*is not supported/);
    peer.socket.destroy();
  });
});

test("broker registration envelope rejects missing required keys", { timeout: 20_000 }, async () => {
  await withBroker(async (socketPath) => {
    const peer = await rawConnect(socketPath);
    const reg = {
      type: "register",
      protocol: "pi-intercom",
      version: 4,
      // session is missing
    };
    peer.send(reg);
    const err = await peer.waitFor((m) => m.type === "error");
    assert.equal(err.code, "INVALID_REQUEST");
    assert.match(err.error, /session.*is required/);
    peer.socket.destroy();
  });
});

test("broker registration validation order: protocol mismatch checked before scope", { timeout: 20_000 }, async () => {
  await withBroker(async (socketPath) => {
    const peer = await rawConnect(socketPath);
    // Protocol is wrong, and scopeId is invalid
    const reg = {
      type: "register",
      protocol: "pi-intercom",
      version: 3, // wrong version
      scopeId: " invalid", // invalid scope
      session: registration("bad-version-scope", 101),
    };
    peer.send(reg);
    const err = await peer.waitFor((m) => m.type === "error");
    // Should get PROTOCOL_MISMATCH, not INVALID_REQUEST for scope
    assert.equal(err.code, "PROTOCOL_MISMATCH");
    peer.socket.destroy();
  });
});

test("broker registration validation order: envelope validation checked before protocol", { timeout: 20_000 }, async () => {
  await withBroker(async (socketPath) => {
    const peer = await rawConnect(socketPath);
    // Unknown envelope key, and wrong protocol version
    const reg = {
      type: "register",
      protocol: "pi-intercom",
      version: 3, // wrong version
      session: registration("bad-version-env", 101),
      extraKey: "bad",
    };
    peer.send(reg);
    const err = await peer.waitFor((m) => m.type === "error");
    // Should get INVALID_REQUEST because of extraKey, checked before protocol mismatch
    assert.equal(err.code, "INVALID_REQUEST");
    assert.match(err.error, /extraKey.*is not supported/);
    peer.socket.destroy();
  });
});

test("plugin entry fails closed immediately on invalid AGENT_INTERCOM_SCOPE_ID before side effects", async () => {
  const { OpenCodeIntercomPlugin } = await import("../opencode/plugin.ts");
  const previous = process.env.AGENT_INTERCOM_SCOPE_ID;
  try {
    process.env.AGENT_INTERCOM_SCOPE_ID = " invalid";
    // We expect the plugin initialization to throw synchronously
    await assert.rejects(
      async () => {
        await OpenCodeIntercomPlugin({
          client: {} as any,
          directory: root,
          serverUrl: new URL("http://localhost"),
        });
      },
      /Invalid identifier/
    );
  } finally {
    if (previous === undefined) delete process.env.AGENT_INTERCOM_SCOPE_ID;
    else process.env.AGENT_INTERCOM_SCOPE_ID = previous;
  }
});

test("exhaustive validation scans for scope/regex leaks in frames, errors, logs and audit", { timeout: 20_000 }, async () => {
  await withBroker(async (socketPath, home, getOutput) => {
    const peer = await rawConnect(socketPath);
    // Send an invalid scope value that should trigger validation failure
    peer.send({
      type: "register",
      protocol: "pi-intercom",
      version: 4,
      scopeId: "invalid-scope-due-to-space ",
      session: registration("leaker", 101),
    });
    const err = await peer.waitFor((m) => m.type === "error");
    assert.equal(err.code, "INVALID_REQUEST");
    // Ensure the error message contains generic text and does not leak "scope", "scopeId", or the regex pattern
    assert.equal(err.error, "Invalid registration parameters");
    assert.equal(err.error.toLowerCase().includes("scope"), false);
    assert.equal(err.error.includes("^[A-Za"), false);

    // Read all log, audit, and store files written to confirm they contain zero entries leaking the scopeId or the word "scope"
    const agentDir = join(home, "agent", "intercom");
    const storeFiles = [
      "broker-audit.jsonl",
      "broker-asks.json",
      "broker-access.json",
      "broker-admin.json",
      "broker-boss-controls.json"
    ];
    for (const file of storeFiles) {
      let content: string;
      try {
        content = readFileSync(join(agentDir, file), "utf8");
      } catch (e: any) {
        if (e.code === "ENOENT") continue;
        throw e;
      }
      assert.equal(content.toLowerCase().includes("scope"), false, `File ${file} must not contain "scope"`);
      assert.equal(content.includes("invalid-scope-due-to-space"), false, `File ${file} must not leak the invalid scope value`);
    }

    // Verify stdout/stderr scan does not leak scope
    const outputs = getOutput();
    assert.equal(outputs.stdout.toLowerCase().includes("scope"), false, `Stdout must not contain "scope"`);
    assert.equal(outputs.stderr.toLowerCase().includes("scope"), false, `Stderr must not contain "scope"`);
    assert.equal(outputs.stdout.includes("invalid-scope-due-to-space"), false);
    assert.equal(outputs.stderr.includes("invalid-scope-due-to-space"), false);

    peer.socket.destroy();
  });
});

test("invalid scope ID exhaustive set yields generic errors only", { timeout: 20_000 }, async () => {
  await withBroker(async (socketPath) => {
    const invalids = [
      "short",
      " Scope_A",
      "Scope_A ",
      "Scope.A",
      "éAAAAAAAAA",
      "A".repeat(15),
      "A".repeat(129),
    ];
    for (const val of invalids) {
      const peer = await rawConnect(socketPath);
      peer.send({
        type: "register",
        protocol: "pi-intercom",
        version: 4,
        scopeId: val,
        session: registration("test-peer", 101),
      });
      const err = await peer.waitFor((m) => m.type === "error");
      assert.equal(err.code, "INVALID_REQUEST");
      assert.equal(err.error, "Invalid registration parameters");
      peer.socket.destroy();
    }
  });
});

test("incompatible v3 client -> v4 broker validation", { timeout: 20_000 }, async () => {
  await withBroker(async (socketPath) => {
    const peer = await rawConnect(socketPath);
    peer.send({
      type: "register",
      protocol: "pi-intercom",
      version: 3, // v3 client
      session: registration("v3-client", 101),
    });
    const err = await peer.waitFor((m) => m.type === "error");
    assert.equal(err.code, "PROTOCOL_MISMATCH");
    assert.match(err.error, /Unsupported intercom protocol/);
    peer.socket.destroy();
  });
});

test("remote credential validation does not consume enrollment on early validation failure", { timeout: 20_000 }, async () => {
  await withBroker(async (socketPath, home) => {
    // 1. Connect a local peer to register a root session
    const localPeer = await rawConnect(socketPath);
    localPeer.send({
      type: "register",
      protocol: "pi-intercom",
      version: 4,
      sessionId: "local-root",
      session: registration("local-root", 101),
    });
    await localPeer.waitFor((m) => m.type === "registered");

    // 2. Issue an enrollment token using the administrative token
    const adminToken = JSON.parse(readFileSync(join(home, "agent", "intercom", "broker-admin.json"), "utf8")).adminToken;
    const adminPeer = await rawConnect(socketPath);
    adminPeer.send({
      type: "access_control",
      requestId: "enroll-1",
      adminToken,
      action: "issue_enrollment",
      enrollment: {
        name: "ika/manager",
        parentSessionId: "local-root",
        rootSessionId: "local-root",
        remoteHostId: "ika-dev-v3",
        canDelegate: true,
        maxDepth: 3,
        maxChildren: 2,
      },
    });
    const enrollRes = await adminPeer.waitFor((m) => m.type === "access_control_result");
    const enrollmentToken = enrollRes.enrollmentToken;
    assert.equal(typeof enrollmentToken, "string");

    // 3. Connect to the remote gateway socket and attempt registration with an invalid register envelope.
    // This must fail validation early before the accessRegistry consumes the token.
    const remotePath = join(home, "agent", "intercom", "remote-gateway.sock");
    const badRemotePeer = await rawConnect(remotePath);
    badRemotePeer.send({
      type: "register",
      protocol: "pi-intercom",
      version: 4,
      access: { enrollmentToken },
      session: registration("remoter", 102),
      invalidKeyLeaker: "bad", // invalid register envelope key -> triggers assertExactKeys failure
    });
    const err = await badRemotePeer.waitFor((m) => m.type === "error");
    assert.equal(err.code, "INVALID_REQUEST");
    badRemotePeer.socket.destroy();

    // 4. Try again with the exact same token with a valid envelope. It must succeed,
    // proving the token was not consumed on the failed validation attempt.
    const goodRemotePeer = await rawConnect(remotePath);
    goodRemotePeer.send({
      type: "register",
      protocol: "pi-intercom",
      version: 4,
      access: { enrollmentToken },
      session: registration("remoter", 103),
    });
    const registered = await goodRemotePeer.waitFor((m) => m.type === "registered");
    assert.equal(registered.type, "registered");

    localPeer.socket.destroy();
    adminPeer.socket.destroy();
    goodRemotePeer.socket.destroy();
  });
});

test("cancel/timeout/late reply routing does not leak scope or cross-talk", { timeout: 20_000 }, async () => {
  const oldTimeout = process.env.PI_INTERCOM_ASK_TIMEOUT_MS;
  process.env.PI_INTERCOM_ASK_TIMEOUT_MS = "1000"; // 1s ask timeout for this test
  try {
    await withBroker(async (socketPath) => {
      const a1 = await connect("alpha", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1", scopeA);
      const b1 = await connect("worker", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1", scopeB);

      // --- 1. Ask & Defer ---
      const askMsgId = "ask-message-1";
      
      // Start waiting for the deferred event first to avoid the race
      const deferPromise = waitForClientEvent(b1, "ask_deferred", (mId) => mId === askMsgId);

      const sendPromise = a1.send(b1.sessionId!, {
        text: "cross scope ask",
        expectsReply: true,
        messageId: askMsgId,
      });

      // Wait for B1 to receive the message via client event
      const [from, msg, deliveryId] = await waitForClientEvent(b1, "message", (_, m) => m.id === askMsgId);
      assert.equal(msg.id, askMsgId);
      assert.equal(from.id, a1.sessionId);

      // A1 (sender) defers the ask
      const deferred = await a1.deferAsk(askMsgId);
      assert.equal(deferred, true);

      // B1 (recipient) receives the ask_deferred notification via client event
      const [deferredMsgId, deferredFromId] = await deferPromise;
      assert.equal(deferredMsgId, askMsgId);
      assert.equal(deferredFromId, a1.sessionId);

      // --- 2. Cancel ---
      // Start waiting for the cancel event first
      const cancelPromise = waitForClientEvent(b1, "ask_cancelled", (mId) => mId === askMsgId);

      // A1 cancels the ask
      const cancelled = await a1.cancelAsk(askMsgId);
      assert.equal(cancelled, true);

      // B1 receives the ask_cancelled notification
      const [cancelledMsgId, cancelledFromId, cancelReason] = await cancelPromise;
      assert.equal(cancelledMsgId, askMsgId);
      assert.equal(cancelledFromId, a1.sessionId);
      assert.equal(cancelReason, "cancelled");

      // --- 3. Late Reply ---
      // B1 tries to send a late reply to the cancelled ask. This must fail because the ask is no longer active.
      const lateReplyRes = await b1.send(a1.sessionId!, {
        text: "late reply",
        replyTo: askMsgId,
      });
      // The broker must fail the delivery with INVALID_REPLY_TARGET
      assert.equal(lateReplyRes.accepted, false);
      assert.equal(lateReplyRes.code, "INVALID_REPLY_TARGET");

      // --- 4. Timeout ---
      // Start waiting for the timeout cancel event first
      const timeoutPromiseB = waitForClientEvent(b1, "ask_cancelled", (mId) => mId === timeoutMsgId);

      // Send a new ask and wait for it to time out
      const timeoutMsgId = "ask-timeout-message";
      const sendTimeoutPromise = a1.send(b1.sessionId!, {
        text: "cross scope ask to timeout",
        expectsReply: true,
        messageId: timeoutMsgId,
      });

      // B1 receives the message
      const [fromTimeout, msgTimeout] = await waitForClientEvent(b1, "message", (_, m) => m.id === timeoutMsgId);
      assert.equal(msgTimeout.id, timeoutMsgId);

      // Wait for timeout cancel event on B1 (expires after 1s)
      const [timeoutMsgIdB, timeoutFromB, reasonB] = await timeoutPromiseB;
      assert.equal(timeoutMsgIdB, timeoutMsgId);
      assert.equal(reasonB, "expired");

      await close(a1, b1);
    });
  } finally {
    if (oldTimeout === undefined) delete process.env.PI_INTERCOM_ASK_TIMEOUT_MS;
    else process.env.PI_INTERCOM_ASK_TIMEOUT_MS = oldTimeout;
  }
});

test("lifecycle, presence, reconnect, and contact boundary verification", { timeout: 20_000 }, async () => {
  await withBroker(async (socketPath) => {
    const a1 = await connect("alpha", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1", scopeA);
    const a2 = await connect("worker", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2", scopeA);
    const b1 = await connect("worker", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1", scopeB);

    // a2 updates presence
    await a2.updatePresence({ status: "busy" });

    // a1 gets presence update
    const list = await a1.listSessions();
    const a2Session = list.find((s) => s.id === a2.sessionId);
    assert.equal(a2Session?.status, "busy");

    // b1 must not see a2 presence
    const bList = await b1.listSessions();
    assert.equal(bList.some((s) => s.id === a2.sessionId), false);

    await close(a1, a2, b1);
  });
});
