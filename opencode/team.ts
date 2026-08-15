import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDirPath } from "../broker/paths.ts";
import { readTeamManifestAsync, TeamManifestError } from "@ctliz/agent-intercom-core/team-manifest";

export type TeamSource = "orchestrator" | "manifest" | "live" | "standalone";

export interface TeamSession {
  id: string;
  name?: string;
  model?: string;
  origin?: "local" | "remote";
}

interface StoredWorker {
  id?: unknown;
  runId?: unknown;
  harness?: unknown;
  role?: unknown;
  state?: unknown;
  owned?: unknown;
  managerSessionId?: unknown;
  intercomTarget?: unknown;
}

export interface TeamMember {
  id: string;
  target: string;
  harness?: string;
  role?: string;
  state?: string;
  connected: boolean;
}

export interface IntercomTeam {
  teamId?: string;
  self: { id: string; workerId?: string; isManager: boolean };
  manager?: { target: string; connected: boolean };
  coworkers: TeamMember[];
  source: TeamSource;
}

const LIVE_STATES = new Set(["provisioning", "running", "idle", "needs_attention", "stopping"]);
const stringValue = (value: unknown): string | undefined => typeof value === "string" && value.trim() ? value.trim() : undefined;
const connectedTo = (sessions: TeamSession[], target: string): boolean => {
  const normalized = target.toLowerCase();
  return sessions.some((session) => session.id === target || session.name?.toLowerCase() === normalized);
};

async function readWorkers(agentDir: string): Promise<StoredWorker[]> {
  try {
    const parsed = JSON.parse(await readFile(join(agentDir, "intercom", "orchestrator", "workers.json"), "utf8")) as { workers?: unknown };
    return Array.isArray(parsed.workers) ? parsed.workers as StoredWorker[] : [];
  } catch {
    return [];
  }
}

async function resolveNonAuthoritativeTeam(
  input: { selfId: string; sessions: TeamSession[] },
  env: NodeJS.ProcessEnv,
): Promise<IntercomTeam> {
  if (env.AGENT_INTERCOM_TEAM_MANIFEST !== undefined) {
    const rawPath = env.AGENT_INTERCOM_TEAM_MANIFEST.trim();
    if (!rawPath) {
      throw new TeamManifestError("ERR_TEAM_MANIFEST_INVALID");
    }
    const manifest = await readTeamManifestAsync(rawPath);
    if (!manifest) {
      throw new TeamManifestError("ERR_TEAM_MANIFEST_INVALID");
    }
    const selfMember = manifest.members.find((m) => m.sessionId === input.selfId);
    if (!selfMember) {
      throw new TeamManifestError("ERR_TEAM_MANIFEST_INVALID");
    }

    const isManager = input.selfId === manifest.leadId;
    const managerTarget = manifest.leadId;
    const managerConnected = connectedTo(input.sessions, managerTarget);

    const coworkers: TeamMember[] = manifest.members
      .filter((m) => m.sessionId !== input.selfId)
      .filter((m) => isManager || m.sessionId !== managerTarget)
      .map((m) => {
        const live = input.sessions.find((s) => s.id === m.sessionId || s.name === m.sessionId);
        return {
          id: m.sessionId,
          target: m.sessionId,
          role: m.role,
          connected: Boolean(live),
        };
      });

    return {
      teamId: manifest.runId,
      self: { id: input.selfId, isManager },
      manager: { target: managerTarget, connected: managerConnected },
      coworkers,
      source: "manifest",
    };
  }

  if (stringValue(env.AGENT_INTERCOM_SCOPE_ID)) {
    const managerTarget = stringValue(env.AGENT_INTERCOM_MANAGER_TARGET)
      ?? stringValue(env.AGENT_INTERCOM_MANAGER_SESSION_ID);
    const role = stringValue(env.AGENT_INTERCOM_ROLE)?.toLowerCase();

    const isManager = role === "manager"
      || (managerTarget !== undefined && managerTarget === input.selfId)
      || (managerTarget === undefined && role !== "worker");

    const effectiveManagerTarget = isManager ? input.selfId : managerTarget;

    const coworkers: TeamMember[] = input.sessions
      .filter((session) => session.id !== input.selfId)
      .filter((session) => session.model !== "human")
      .filter((session) => session.id !== effectiveManagerTarget)
      .map((session): TeamMember => ({
        id: session.id,
        target: session.id,
        ...(session.model ? { harness: session.model } : {}),
        connected: true,
      }));

    const manager = effectiveManagerTarget
      ? {
          target: effectiveManagerTarget,
          connected: isManager ? true : connectedTo(input.sessions, effectiveManagerTarget),
        }
      : undefined;

    return {
      teamId: effectiveManagerTarget ?? input.selfId,
      self: { id: input.selfId, isManager },
      ...(manager ? { manager } : {}),
      coworkers,
      source: "live",
    };
  }

  const managerTarget = stringValue(env.AGENT_INTERCOM_MANAGER_TARGET)
    ?? stringValue(env.AGENT_INTERCOM_MANAGER_SESSION_ID);
  return {
    teamId: managerTarget ?? input.selfId,
    self: { id: input.selfId, isManager: !managerTarget },
    manager: managerTarget
      ? { target: managerTarget, connected: connectedTo(input.sessions, managerTarget) }
      : { target: input.selfId, connected: true },
    coworkers: [],
    source: "standalone",
  };
}

export async function resolveIntercomTeam(input: {
  selfId: string;
  sessions: TeamSession[];
  env?: NodeJS.ProcessEnv;
  agentDir?: string;
}): Promise<IntercomTeam> {
  const env = input.env ?? process.env;
  const workers = await readWorkers(input.agentDir ?? getAgentDirPath());
  const workerId = stringValue(env.AGENT_INTERCOM_WORKER_ID);
  const runId = stringValue(env.AGENT_INTERCOM_RUN_ID);
  const current = workerId
    ? workers.find((worker) => stringValue(worker.id) === workerId && (!runId || stringValue(worker.runId) === runId))
    : undefined;

  if (current) {
    const managerTarget = stringValue(current.managerSessionId)
      ?? stringValue(env.AGENT_INTERCOM_MANAGER_TARGET)
      ?? stringValue(env.AGENT_INTERCOM_MANAGER_SESSION_ID);
    if (!managerTarget) {
      return {
        self: { id: input.selfId, ...(workerId ? { workerId } : {}), isManager: false },
        coworkers: [],
        source: "orchestrator",
      };
    }
    const coworkers = workers
      .filter((worker) => worker.owned === true)
      .filter((worker) => {
        const mgr = stringValue(worker.managerSessionId);
        return mgr !== undefined && mgr === managerTarget;
      })
      .filter((worker) => LIVE_STATES.has(stringValue(worker.state) ?? ""))
      .filter((worker) => stringValue(worker.id) !== workerId && stringValue(worker.id) !== input.selfId)
      .map((worker): TeamMember | undefined => {
        const id = stringValue(worker.id);
        if (!id) return undefined;
        const target = stringValue(worker.intercomTarget) ?? id;
        return {
          id,
          target,
          ...(stringValue(worker.harness) ? { harness: stringValue(worker.harness) } : {}),
          ...(stringValue(worker.role) ? { role: stringValue(worker.role) } : {}),
          ...(stringValue(worker.state) ? { state: stringValue(worker.state) } : {}),
          connected: connectedTo(input.sessions, target),
        };
      })
      .filter((member): member is TeamMember => Boolean(member));

    return {
      teamId: managerTarget,
      self: { id: input.selfId, ...(workerId ? { workerId } : {}), isManager: false },
      manager: { target: managerTarget, connected: connectedTo(input.sessions, managerTarget) },
      coworkers,
      source: "orchestrator",
    };
  }

  if (workerId === undefined) {
    const ownedCoworkers = workers
      .filter((worker) => worker.owned === true)
      .filter((worker) => {
        const mgr = stringValue(worker.managerSessionId);
        return mgr !== undefined && mgr === input.selfId;
      })
      .filter((worker) => LIVE_STATES.has(stringValue(worker.state) ?? ""))
      .filter((worker) => stringValue(worker.id) !== input.selfId)
      .map((worker): TeamMember | undefined => {
        const id = stringValue(worker.id);
        if (!id) return undefined;
        const target = stringValue(worker.intercomTarget) ?? id;
        return {
          id,
          target,
          ...(stringValue(worker.harness) ? { harness: stringValue(worker.harness) } : {}),
          ...(stringValue(worker.role) ? { role: stringValue(worker.role) } : {}),
          ...(stringValue(worker.state) ? { state: stringValue(worker.state) } : {}),
          connected: connectedTo(input.sessions, target),
        };
      })
      .filter((member): member is TeamMember => Boolean(member));

    if (ownedCoworkers.length > 0) {
      return {
        teamId: input.selfId,
        self: { id: input.selfId, isManager: true },
        manager: { target: input.selfId, connected: true },
        coworkers: ownedCoworkers,
        source: "orchestrator",
      };
    }
  }

  return resolveNonAuthoritativeTeam(input, env);
}

/** Authorizes a read-only local inbox lookup using exact orchestrator ownership. */
export function resolveManagedInboxSession(input: {
  team: IntercomTeam;
  sessions: TeamSession[];
  requestedSession: string;
}): TeamSession {
  if (input.team.source !== "orchestrator") {
    throw new Error("Pending-ask inbox access denied: cross-session inbox inspection is only permitted for Orchestrator-managed teams");
  }
  if (!input.team.self.isManager) {
    throw new Error("Only a manager may inspect another session's pending-ask inbox");
  }
  const member = input.team.coworkers.find((entry) => entry.target === input.requestedSession);
  if (!member) {
    throw new Error(`Pending-ask inbox access denied for "${input.requestedSession}"; select an owned coworker target returned by intercom_team`);
  }
  const liveSession = input.sessions.find((session) => session.id === input.requestedSession);
  if (!liveSession) {
    throw new Error(`Pending-ask inbox access denied for "${input.requestedSession}"; the owned coworker target must equal an exact connected stable session ID`);
  }
  if (liveSession.origin === "remote") {
    throw new Error(`Pending-ask inbox "${input.requestedSession}" is remote and cannot be read from this host`);
  }
  return liveSession;
}

export function formatIntercomTeam(team: IntercomTeam): string {
  const lines = [
    `Manager: ${team.manager ? `${team.manager.target} [${team.manager.connected ? "connected" : "not connected"}]` : "unknown"}`,
    `You: ${team.self.id}${team.self.isManager ? " [manager]" : ""}`,
  ];
  if (!team.coworkers.length) lines.push("Coworkers: none");
  else {
    lines.push("Coworkers:");
    for (const coworker of team.coworkers) {
      const metadata = [coworker.harness, coworker.role, coworker.state].filter(Boolean).join(", ");
      lines.push(`- ${coworker.id} target=${coworker.target}${metadata ? ` (${metadata})` : ""} [${coworker.connected ? "connected" : "not connected"}]`);
    }
  }
  return lines.join("\n");
}
