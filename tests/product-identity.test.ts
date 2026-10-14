import assert from "node:assert/strict";
import test from "node:test";

import {
  AGENT_BRIDGE_PRODUCT_IDENTITY,
  getAgentBridgeCommercialName,
} from "../src/index.js";

test("commercial naming stays separate from stable Agent Bridge technical identity", () => {
  assert.equal(AGENT_BRIDGE_PRODUCT_IDENTITY.technicalId, "agent-bridge");
  assert.equal(AGENT_BRIDGE_PRODUCT_IDENTITY.technicalName, "Agent Bridge");
  assert.equal(getAgentBridgeCommercialName("es"), "Integración de agentes de IA");
  assert.equal(getAgentBridgeCommercialName("en"), "AI Integration");
});
