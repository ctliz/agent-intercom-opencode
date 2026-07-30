import { types as nodeUtilTypes } from "node:util";
import { BROKER_PROTECTED_PROVIDER_ROOT } from "@dataforxyz/agent-intercom-core/boss";

export const OPENCODE_BOSS_PROTECTED_PROVIDER_ID = "opencode" as const;
export const OPENCODE_BOSS_PROTECTED_PROVIDER_PACKAGE = "@dataforxyz/agent-intercom-opencode" as const;
export const OPENCODE_BOSS_PROTECTED_PROVIDER_ARTIFACT_PATH =
  `${BROKER_PROTECTED_PROVIDER_ROOT}${OPENCODE_BOSS_PROTECTED_PROVIDER_ID}/provider.mjs` as const;
export const BOSS_PROTECTED_SERVICE_UNAVAILABLE = "BOSS_PROTECTED_SERVICE_UNAVAILABLE" as const;

const OPENCODE_BOSS_PROTECTED_PROVIDER_MODE = "0555" as const;
const CANONICAL_SEMANTIC_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const CANDIDATE_KEYS = [
  "adapterId",
  "providerPackage",
  "providerVersion",
  "providerDigest",
  "artifactPath",
  "artifactOwnerUid",
  "artifactOwnerGid",
  "artifactMode",
] as const;

export interface OpenCodeBossProtectedProviderArtifactCandidate {
  adapterId: typeof OPENCODE_BOSS_PROTECTED_PROVIDER_ID;
  providerPackage: typeof OPENCODE_BOSS_PROTECTED_PROVIDER_PACKAGE;
  providerVersion: string;
  providerDigest: string;
  artifactPath: typeof OPENCODE_BOSS_PROTECTED_PROVIDER_ARTIFACT_PATH;
  artifactOwnerUid: 0;
  artifactOwnerGid: 0;
  artifactMode: typeof OPENCODE_BOSS_PROTECTED_PROVIDER_MODE;
}

export type OpenCodeBossProtectedServiceErrorCode =
  | "INVALID_OPENCODE_PROTECTED_PROVIDER_CANDIDATE"
  | typeof BOSS_PROTECTED_SERVICE_UNAVAILABLE;

export class OpenCodeBossProtectedServiceError extends Error {
  readonly code: OpenCodeBossProtectedServiceErrorCode;
  readonly path: string;

  constructor(code: OpenCodeBossProtectedServiceErrorCode, path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = "OpenCodeBossProtectedServiceError";
    this.code = code;
    this.path = path;
  }
}

function invalid(path: string, message: string): never {
  throw new OpenCodeBossProtectedServiceError(
    "INVALID_OPENCODE_PROTECTED_PROVIDER_CANDIDATE",
    path,
    message,
  );
}

function assertExactOwnDataCandidate(value: unknown): asserts value is Record<string, unknown> {
  const path = "$candidate";
  if (
    typeof value !== "object"
    || value === null
    || nodeUtilTypes.isProxy(value)
    || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
  ) {
    invalid(path, "must be a non-proxy plain data object");
  }

  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== CANDIDATE_KEYS.length
    || keys.some((key) => typeof key !== "string" || !CANDIDATE_KEYS.includes(key as typeof CANDIDATE_KEYS[number]))
  ) {
    invalid(path, "must contain exactly the canonical unsigned OpenCode provider candidate fields");
  }

  for (const key of CANDIDATE_KEYS) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      descriptor === undefined
      || !descriptor.enumerable
      || !Object.hasOwn(descriptor, "value")
    ) {
      invalid(`${path}.${key}`, "must be an own enumerable data property");
    }
  }
}

function ownValue(value: Record<string, unknown>, key: typeof CANDIDATE_KEYS[number]): unknown {
  return Object.getOwnPropertyDescriptor(value, key)!.value;
}

function readProviderVersion(value: unknown): string {
  if (
    typeof value !== "string"
    || value.length > 128
    || /[\r\n\u2028\u2029]/.test(value)
    || !CANONICAL_SEMANTIC_VERSION.test(value)
  ) {
    invalid("$candidate.providerVersion", "must be a canonical semantic version");
  }
  return value;
}

function readProviderDigest(value: unknown): string {
  if (typeof value !== "string" || value.length !== 64 || !/^[a-f0-9]{64}$/.test(value)) {
    invalid("$candidate.providerDigest", "must be a lowercase SHA-256 digest");
  }
  return value;
}

/**
 * Normalize an unsigned release candidate for the packaged OpenCode provider.
 * This parser cannot verify installation, signatures, service identities, or
 * authority. Its frozen result remains explicitly non-authoritative.
 */
export function parseOpenCodeBossProtectedProviderArtifactCandidate(
  value: unknown,
): Readonly<OpenCodeBossProtectedProviderArtifactCandidate> {
  assertExactOwnDataCandidate(value);

  if (ownValue(value, "adapterId") !== OPENCODE_BOSS_PROTECTED_PROVIDER_ID) {
    invalid("$candidate.adapterId", "must identify the OpenCode provider");
  }
  if (ownValue(value, "providerPackage") !== OPENCODE_BOSS_PROTECTED_PROVIDER_PACKAGE) {
    invalid("$candidate.providerPackage", "must identify the canonical OpenCode package");
  }
  if (ownValue(value, "artifactPath") !== OPENCODE_BOSS_PROTECTED_PROVIDER_ARTIFACT_PATH) {
    invalid("$candidate.artifactPath", "must equal the canonical protected OpenCode provider path");
  }
  if (ownValue(value, "artifactOwnerUid") !== 0 || ownValue(value, "artifactOwnerGid") !== 0) {
    invalid("$candidate.artifactOwnerUid", "must describe a root:root artifact");
  }
  if (ownValue(value, "artifactMode") !== OPENCODE_BOSS_PROTECTED_PROVIDER_MODE) {
    invalid("$candidate.artifactMode", "must be read/execute-only mode 0555");
  }

  return Object.freeze({
    adapterId: OPENCODE_BOSS_PROTECTED_PROVIDER_ID,
    providerPackage: OPENCODE_BOSS_PROTECTED_PROVIDER_PACKAGE,
    providerVersion: readProviderVersion(ownValue(value, "providerVersion")),
    providerDigest: readProviderDigest(ownValue(value, "providerDigest")),
    artifactPath: OPENCODE_BOSS_PROTECTED_PROVIDER_ARTIFACT_PATH,
    artifactOwnerUid: 0,
    artifactOwnerGid: 0,
    artifactMode: OPENCODE_BOSS_PROTECTED_PROVIDER_MODE,
  });
}

/**
 * Production ensure is intentionally unavailable until a protected
 * provisioner supplies release and service identity facts outside caller data.
 * The request is never inspected while that provisioner is absent.
 */
export function ensureOpenCodeBossProtectedService(_request: unknown): never {
  throw new OpenCodeBossProtectedServiceError(
    BOSS_PROTECTED_SERVICE_UNAVAILABLE,
    "$provisioner",
    "the protected OpenCode broker service provisioner is not installed",
  );
}
