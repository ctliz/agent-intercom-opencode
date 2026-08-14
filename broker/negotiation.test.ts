import assert from "node:assert/strict";
import test from "node:test";
import { INTERCOM_BASE_PROTOCOL_VERSION } from "@dataforxyz/agent-intercom-core/boss";
import { INTERCOM_PROTOCOL_VERSION } from "./paths.ts";
import {
  DORMANT_BROKER_CAPABILITIES,
  ORDINARY_BASE3_COMPATIBILITY,
  negotiateBrokerCompatibility,
} from "./negotiation.ts";

test("OpenCode negotiates the exact Core base contract while Boss stays dormant", () => {
  assert.equal(INTERCOM_PROTOCOL_VERSION, 4);
  assert.equal(INTERCOM_PROTOCOL_VERSION, INTERCOM_BASE_PROTOCOL_VERSION);
  assert.deepEqual(DORMANT_BROKER_CAPABILITIES, { baseProtocolVersion: 4, features: [] });
  assert.deepEqual(negotiateBrokerCompatibility(ORDINARY_BASE3_COMPATIBILITY), {
    compatible: true,
    mode: "ordinary",
  });
});

test("negotiation rejects alternate base versions and incomplete Boss requests", () => {
  assert.deepEqual(negotiateBrokerCompatibility({
    clientKind: "ordinary",
    supportedBaseProtocolVersions: [2],
  }), { compatible: false, code: "BASE_PROTOCOL_UNSUPPORTED" });
  assert.deepEqual(negotiateBrokerCompatibility({
    clientKind: "boss",
    supportedBaseProtocolVersions: [4],
    requiredFeature: "boss-run-v1",
  }), { compatible: false, code: "INVALID_COMPATIBILITY_REQUEST" });
});
