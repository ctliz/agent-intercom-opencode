import {
  INTERCOM_PROTOCOL_NAME,
  INTERCOM_PROTOCOL_V4_SEMANTICS_HASH,
  INTERCOM_PROTOCOL_V4_VECTOR_SCHEMA_VERSION,
  INTERCOM_PROTOCOL_V4_VECTORS,
  INTERCOM_PROTOCOL_VERSION,
  INTERCOM_SCOPE_ENV,
  INTERCOM_SCOPE_ID_PATTERN,
  INTERCOM_SCOPE_ID_PATTERN_SOURCE,
  sameIntercomScope,
} from "@dataforxyz/agent-intercom-core/protocol-v4";

export {
  INTERCOM_PROTOCOL_NAME,
  INTERCOM_PROTOCOL_V4_SEMANTICS_HASH,
  INTERCOM_PROTOCOL_V4_VECTOR_SCHEMA_VERSION,
  INTERCOM_PROTOCOL_V4_VECTORS,
  INTERCOM_PROTOCOL_VERSION,
  INTERCOM_SCOPE_ENV,
  INTERCOM_SCOPE_ID_PATTERN,
  INTERCOM_SCOPE_ID_PATTERN_SOURCE,
  sameIntercomScope,
};

export function parseIntercomScopeId(value: unknown, path = "identifier"): string | undefined {
  if (value === undefined || value === "") return undefined;
  if (typeof value !== "string" || !INTERCOM_SCOPE_ID_PATTERN.test(value)) {
    throw new Error("Invalid identifier");
  }
  return value;
}

export function intercomScopeIdFromEnv(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const val = env[INTERCOM_SCOPE_ENV];
  return parseIntercomScopeId(val, INTERCOM_SCOPE_ENV);
}
