import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { formatIntercomTeam, resolveIntercomTeam, resolveManagedInboxSession, type TeamSession } from "./team.ts";

const worker = (id: string, runId: string, managerSessionId: string, state = "running") => ({
  id,
  runId,
  harness: "opencode",
  role: "reviewer",
  state,
  owned: true,
  managerSessionId,
  intercomTarget: id,
});

test("team discovery follows the orchestrator owner instead of stale worker environment", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "opencode-team-"));
  const dir = join(agentDir, "intercom", "orchestrator");
  await mkdir(dir, { recursive: true });
  try {
    await writeFile(join(dir, "workers.json"), JSON.stringify({
      version: 1,
      workers: [
        worker("self", "run-self", "manager-new"),
        worker("peer", "run-peer", "manager-new"),
        worker("old", "run-old", "manager-old"),
      ],
    }));
    const team = await resolveIntercomTeam({
      selfId: "self",
      agentDir,
      env: {
        AGENT_INTERCOM_WORKER_ID: "self",
        AGENT_INTERCOM_RUN_ID: "run-self",
        AGENT_INTERCOM_MANAGER_SESSION_ID: "manager-old",
      },
      sessions: [{ id: "manager-new" }, { id: "peer" }],
    });
    assert.equal(team.source, "orchestrator");
    assert.equal(team.manager?.target, "manager-new");
    assert.equal(team.manager?.connected, true);
    assert.deepEqual(team.coworkers.map((entry) => entry.id), ["peer"]);
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
});

test("TmuxDeck manifest resolution correctly identifies Lead and Workers", async () => {
  const dir = await mkdtemp(join(tmpdir(), "opencode-manifest-"));
  if (process.platform !== "win32") {
    await chmod(dir, 0o700);
  }
  const manifestPath = join(dir, "team.json");
  const leadId = "tmuxdeck-11111111-1111-4111-8111-111111111111";
  const worker1 = "tmuxdeck-22222222-2222-4222-8222-222222222222";
  const worker2 = "tmuxdeck-33333333-3333-4333-8333-333333333333";
  const manifest = {
    version: "tmuxdeck.team.v1",
    backend: "tmuxdeck",
    runId: "team_44444444-4444-4444-8444-444444444444",
    leadId,
    members: [
      { sessionId: leadId, role: "lead" },
      { sessionId: worker1, role: "worker" },
      { sessionId: worker2, role: "worker" },
    ],
    createdAt: 1700000000000,
    capabilities: [],
  };
  await writeFile(manifestPath, JSON.stringify(manifest), { mode: 0o600 });
  if (process.platform !== "win32") {
    await chmod(manifestPath, 0o600);
  }

  try {
    const sessions: TeamSession[] = [
      { id: leadId, model: "opencode" },
      { id: worker1, model: "opencode" },
      { id: worker2, model: "claude" },
    ];

    // 1. Worker 1 view
    const workerTeam = await resolveIntercomTeam({
      selfId: worker1,
      env: { AGENT_INTERCOM_TEAM_MANIFEST: manifestPath },
      sessions,
    });
    assert.equal(workerTeam.source, "manifest");
    assert.equal(workerTeam.teamId, manifest.runId);
    assert.equal(workerTeam.self.isManager, false);
    assert.equal(workerTeam.manager?.target, leadId);
    assert.equal(workerTeam.manager?.connected, true);
    assert.deepEqual(workerTeam.coworkers.map((c) => c.id), [worker2]);

    // 2. Lead view
    const leadTeam = await resolveIntercomTeam({
      selfId: leadId,
      env: { AGENT_INTERCOM_TEAM_MANIFEST: manifestPath },
      sessions,
    });
    assert.equal(leadTeam.source, "manifest");
    assert.equal(leadTeam.teamId, manifest.runId);
    assert.equal(leadTeam.self.isManager, true);
    assert.equal(leadTeam.manager?.target, leadId);
    assert.deepEqual(leadTeam.coworkers.map((c) => c.id), [worker1, worker2]);
    assert.match(formatIntercomTeam(leadTeam), new RegExp(`You: ${leadId} \\[manager\\]`));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Invalid or unreadable TmuxDeck manifest fails closed without live fallback", async () => {
  // 1. Nonexistent manifest path
  await assert.rejects(
    async () => resolveIntercomTeam({
      selfId: "tmuxdeck-11111111-1111-4111-8111-111111111111",
      env: {
        AGENT_INTERCOM_TEAM_MANIFEST: "/nonexistent/manifest.json",
        AGENT_INTERCOM_SCOPE_ID: "a".repeat(48),
      },
      sessions: [{ id: "tmuxdeck-11111111-1111-4111-8111-111111111111" }, { id: "tmuxdeck-22222222-2222-4222-8222-222222222222" }],
    }),
    /ERR_TEAM_MANIFEST_UNAVAILABLE/,
  );

  // 2. Malformed JSON manifest
  const dir = await mkdtemp(join(tmpdir(), "opencode-bad-manifest-"));
  if (process.platform !== "win32") {
    await chmod(dir, 0o700);
  }
  const badJsonPath = join(dir, "bad.json");
  await writeFile(badJsonPath, "{ not valid json", { mode: 0o600 });
  if (process.platform !== "win32") {
    await chmod(badJsonPath, 0o600);
  }
  try {
    await assert.rejects(
      async () => resolveIntercomTeam({
        selfId: "tmuxdeck-11111111-1111-4111-8111-111111111111",
        env: {
          AGENT_INTERCOM_TEAM_MANIFEST: badJsonPath,
          AGENT_INTERCOM_SCOPE_ID: "a".repeat(48),
        },
        sessions: [{ id: "tmuxdeck-11111111-1111-4111-8111-111111111111" }],
      }),
      /ERR_TEAM_MANIFEST_INVALID/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }

  // 3. Empty or whitespace manifest env var throws ERR_TEAM_MANIFEST_INVALID
  for (const emptyVal of ["", "   ", "\t\n"]) {
    await assert.rejects(
      async () => resolveIntercomTeam({
        selfId: "tmuxdeck-11111111-1111-4111-8111-111111111111",
        env: {
          AGENT_INTERCOM_TEAM_MANIFEST: emptyVal,
          AGENT_INTERCOM_SCOPE_ID: "a".repeat(48),
        },
        sessions: [{ id: "tmuxdeck-11111111-1111-4111-8111-111111111111" }],
      }),
      /ERR_TEAM_MANIFEST_INVALID/,
    );
  }

  // 4. Valid manifest JSON but self is not in members throws ERR_TEAM_MANIFEST_INVALID
  const validDir = await mkdtemp(join(tmpdir(), "opencode-self-not-member-"));
  if (process.platform !== "win32") {
    await chmod(validDir, 0o700);
  }
  const notMemberPath = join(validDir, "manifest.json");
  await writeFile(
    notMemberPath,
    JSON.stringify({
      version: "tmuxdeck.team.v1",
      backend: "tmuxdeck",
      runId: "team_44444444-4444-4444-8444-444444444444",
      leadId: "tmuxdeck-11111111-1111-4111-8111-111111111111",
      members: [{ sessionId: "tmuxdeck-11111111-1111-4111-8111-111111111111", role: "lead" }],
      createdAt: 1700000000000,
      capabilities: [],
    }),
    { mode: 0o600 },
  );
  if (process.platform !== "win32") {
    await chmod(notMemberPath, 0o600);
  }
  try {
    await assert.rejects(
      async () => resolveIntercomTeam({
        selfId: "tmuxdeck-99999999-9999-4999-8999-999999999999",
        env: { AGENT_INTERCOM_TEAM_MANIFEST: notMemberPath },
        sessions: [{ id: "tmuxdeck-99999999-9999-4999-8999-999999999999" }],
      }),
      /ERR_TEAM_MANIFEST_INVALID/,
    );
  } finally {
    await rm(validDir, { recursive: true, force: true });
  }
});

test("Workspace live roster fallback discovers same-scope active non-human peers", async () => {
  const sessions: TeamSession[] = [
    { id: "lead-pane", model: "opencode" },
    { id: "worker-pane", model: "opencode" },
    { id: "me", model: "codex" }, // valid agent named "me"
    { id: "human-user", model: "human" }, // exact "human" session to be excluded
    { id: "human-caps", model: "Human" }, // non-exact "Human" model remains a peer
  ];

  // Worker pane view
  const workerTeam = await resolveIntercomTeam({
    selfId: "worker-pane",
    env: {
      AGENT_INTERCOM_SCOPE_ID: "b".repeat(48),
      AGENT_INTERCOM_MANAGER_TARGET: "lead-pane",
      AGENT_INTERCOM_ROLE: "worker",
    },
    sessions,
  });
  assert.equal(workerTeam.source, "live");
  assert.equal(workerTeam.self.isManager, false);
  assert.equal(workerTeam.manager?.target, "lead-pane");
  assert.equal(workerTeam.manager?.connected, true);
  // Exact "human" excluded, lead excluded, self excluded; "Human" and "me" retained
  assert.deepEqual(workerTeam.coworkers.map((c) => c.id), ["me", "human-caps"]);

  // Lead pane view
  const leadTeam = await resolveIntercomTeam({
    selfId: "lead-pane",
    env: {
      AGENT_INTERCOM_SCOPE_ID: "b".repeat(48),
      AGENT_INTERCOM_ROLE: "manager",
    },
    sessions,
  });
  assert.equal(leadTeam.source, "live");
  assert.equal(leadTeam.self.isManager, true);
  assert.equal(leadTeam.manager?.target, "lead-pane");
  assert.deepEqual(leadTeam.coworkers.map((c) => c.id), ["worker-pane", "me", "human-caps"]);
});

test("Inbox inspection resolveManagedInboxSession is restricted strictly to Orchestrator", async () => {
  const sessions: TeamSession[] = [{ id: "manager" }, { id: "worker-1" }];
  const orchestratorTeam = {
    teamId: "manager",
    self: { id: "manager", isManager: true },
    coworkers: [{ id: "worker-1", target: "worker-1", connected: true }],
    source: "orchestrator" as const,
  };
  const manifestTeam = { ...orchestratorTeam, source: "manifest" as const };
  const liveTeam = { ...orchestratorTeam, source: "live" as const };
  const standaloneTeam = { ...orchestratorTeam, source: "standalone" as const };
  const legacyUndefinedSourceTeam = {
    teamId: "manager",
    self: { id: "manager", isManager: true },
    coworkers: [{ id: "worker-1", target: "worker-1", connected: true }],
  } as unknown as import("./team.ts").IntercomTeam;

  // Orchestrator allowed
  assert.equal(
    resolveManagedInboxSession({ team: orchestratorTeam, sessions, requestedSession: "worker-1" }).id,
    "worker-1",
  );

  // Manifest denied
  assert.throws(
    () => resolveManagedInboxSession({ team: manifestTeam, sessions, requestedSession: "worker-1" }),
    /Pending-ask inbox access denied.*only permitted for Orchestrator-managed teams/,
  );

  // Live fallback denied
  assert.throws(
    () => resolveManagedInboxSession({ team: liveTeam, sessions, requestedSession: "worker-1" }),
    /Pending-ask inbox access denied.*only permitted for Orchestrator-managed teams/,
  );

  // Standalone denied
  assert.throws(
    () => resolveManagedInboxSession({ team: standaloneTeam, sessions, requestedSession: "worker-1" }),
    /Pending-ask inbox access denied.*only permitted for Orchestrator-managed teams/,
  );

  // Legacy undefined source denied
  assert.throws(
    () => resolveManagedInboxSession({ team: legacyUndefinedSourceTeam, sessions, requestedSession: "worker-1" }),
    /Pending-ask inbox access denied.*only permitted for Orchestrator-managed teams/,
  );
});

test("Orchestrator manager without workerId owns live workers with matching managerSessionId", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "opencode-orch-manager-"));
  const dir = join(agentDir, "intercom", "orchestrator");
  await mkdir(dir, { recursive: true });
  try {
    await writeFile(join(dir, "workers.json"), JSON.stringify({
      workers: [
        {
          id: "worker-a",
          managerSessionId: "manager-session",
          owned: true,
          state: "running",
          harness: "opencode",
          role: "worker",
          intercomTarget: "worker-a",
        },
      ],
    }));

    const sessions: TeamSession[] = [
      { id: "manager-session", model: "opencode" },
      { id: "worker-a", model: "opencode" },
    ];
    const team = await resolveIntercomTeam({
      selfId: "manager-session",
      agentDir,
      env: {}, // no AGENT_INTERCOM_WORKER_ID
      sessions,
    });
    assert.equal(team.source, "orchestrator");
    assert.equal(team.self.isManager, true);
    assert.equal(team.manager?.target, "manager-session");
    assert.deepEqual(team.coworkers.map((c) => c.id), ["worker-a"]);

    const inspected = resolveManagedInboxSession({
      team,
      sessions,
      requestedSession: "worker-a",
    });
    assert.equal(inspected.id, "worker-a");
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
});

test("Worker with missing managerSessionId in workers.json is never elevated to manager", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "opencode-orch-malformed-"));
  const dir = join(agentDir, "intercom", "orchestrator");
  await mkdir(dir, { recursive: true });
  try {
    await writeFile(join(dir, "workers.json"), JSON.stringify({
      workers: [
        {
          id: "worker-malformed",
          // missing managerSessionId
          state: "running",
          harness: "opencode",
          role: "worker",
        },
      ],
    }));

    const sessions: TeamSession[] = [
      { id: "worker-malformed", model: "opencode" },
    ];
    const team = await resolveIntercomTeam({
      selfId: "worker-malformed",
      agentDir,
      env: { AGENT_INTERCOM_WORKER_ID: "worker-malformed" },
      sessions,
    });
    assert.equal(team.source, "orchestrator");
    assert.equal(team.self.isManager, false);
    assert.deepEqual(team.coworkers, []);

    assert.throws(
      () => resolveManagedInboxSession({
        team,
        sessions,
        requestedSession: "worker-malformed",
      }),
      /Only a manager may inspect another session's pending-ask inbox/,
    );
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
});

test("Current worker record missing stored managerSessionId + AGENT_INTERCOM_MANAGER_TARGET=selfId + owned peer => source orchestrator but self false and inbox denied", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "opencode-orch-no-mgr-elev-"));
  const dir = join(agentDir, "intercom", "orchestrator");
  await mkdir(dir, { recursive: true });
  try {
    await writeFile(join(dir, "workers.json"), JSON.stringify({
      workers: [
        {
          id: "worker-me",
          // missing managerSessionId
          owned: true,
          state: "running",
          harness: "opencode",
          role: "worker",
          intercomTarget: "worker-me",
        },
        {
          id: "worker-peer",
          managerSessionId: "worker-me",
          owned: true,
          state: "running",
          harness: "opencode",
          role: "worker",
          intercomTarget: "worker-peer",
        },
      ],
    }));

    const sessions: TeamSession[] = [
      { id: "worker-me", model: "opencode" },
      { id: "worker-peer", model: "opencode" },
    ];
    const team = await resolveIntercomTeam({
      selfId: "worker-me",
      agentDir,
      env: {
        AGENT_INTERCOM_WORKER_ID: "worker-me",
        AGENT_INTERCOM_MANAGER_TARGET: "worker-me",
      },
      sessions,
    });
    assert.equal(team.source, "orchestrator");
    assert.equal(team.self.isManager, false);
    assert.equal(team.manager?.target, "worker-me");
    assert.deepEqual(team.coworkers.map((c) => c.id), ["worker-peer"]);

    assert.throws(
      () => resolveManagedInboxSession({
        team,
        sessions,
        requestedSession: "worker-peer",
      }),
      /Only a manager may inspect another session's pending-ask inbox/,
    );
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
});

test("Stale or unmatched worker ID + owned records targeting self => no orchestrator Manager/inbox; continue manifest/live/standalone resolution", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "opencode-stale-worker-"));
  const dir = join(agentDir, "intercom", "orchestrator");
  await mkdir(dir, { recursive: true });
  try {
    await writeFile(join(dir, "workers.json"), JSON.stringify({
      workers: [
        {
          id: "worker-owned",
          managerSessionId: "self-manager",
          owned: true,
          state: "running",
          harness: "opencode",
          role: "worker",
          intercomTarget: "worker-owned",
        },
      ],
    }));

    const sessions: TeamSession[] = [
      { id: "self-manager", model: "opencode" },
      { id: "worker-owned", model: "opencode" },
    ];
    // Stale/unmatched AGENT_INTERCOM_WORKER_ID present
    const team = await resolveIntercomTeam({
      selfId: "self-manager",
      agentDir,
      env: {
        AGENT_INTERCOM_WORKER_ID: "nonexistent-stale-worker",
        AGENT_INTERCOM_SCOPE_ID: "d".repeat(48),
      },
      sessions,
    });
    // Falls through to live roster resolution
    assert.equal(team.source, "live");
    assert.throws(
      () => resolveManagedInboxSession({
        team,
        sessions,
        requestedSession: "worker-owned",
      }),
      /Pending-ask inbox access denied: cross-session inbox inspection is only permitted for Orchestrator-managed teams/,
    );
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
});
