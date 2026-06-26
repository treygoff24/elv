import { describe, expect, it } from "vitest";
import { classifyRisk, costHintForOperationId } from "../../src/openapi/risk";
import type { OperationCard } from "../../src/openapi/types";

function op(operationId: string, method: OperationCard["method"]): OperationCard {
  return {
    operationId,
    method,
    pathTemplate: "/test",
    group: [],
    tags: [],
    risk: "mutate",
    pathParams: [],
    queryParams: [],
    headerParams: [],
    responses: [],
    returnsBinary: false,
    returnsJson: false,
    streamKind: "none",
    deprecated: false,
    examples: [],
  };
}

describe("risk classifier", () => {
  it("method ordering keeps reads ungated and DELETE destructive", () => {
    expect(classifyRisk(op("get_batch_call", "GET"))).toBe("read");
    expect(classifyRisk(op("delete_voice", "DELETE"))).toBe("destructive");
  });

  it("classifies the known credit-burning generation operations", () => {
    expect(classifyRisk(op("text_to_speech_full", "POST"))).toBe("generate");
    expect(classifyRisk(op("sound_generation", "POST"))).toBe("generate");
    expect(classifyRisk(op("audio_isolation", "POST"))).toBe("generate");
  });

  it("classifies outbound side effects and curated cost hints", () => {
    expect(classifyRisk(op("handle_twilio_outbound_call", "POST"))).toBe("external_side_effect");
    expect(classifyRisk(op("whatsapp_outbound_message", "POST"))).toBe("external_side_effect");
    expect(costHintForOperationId("text_to_speech_full")).toBe("characters");
    expect(costHintForOperationId("sound_generation")).toBe("per_generation");
    expect(costHintForOperationId("audio_isolation")).toBe("audio_seconds");
    expect(costHintForOperationId("get_voices")).toBe("unknown");
  });

  it("gates workspace/admin mutations with external side effects", () => {
    for (const operationId of [
      "create_auth_connection",
      "update_auth_connection",
      "create_workspace_webhook_route",
      "edit_workspace_webhook_route",
      "create_secret_route",
      "update_secret_route",
      "share_resource_endpoint",
      "unshare_resource_endpoint",
      "update_mcp_server_approval_policy_route",
      "add_mcp_server_tool_approval_route",
      "update_whatsapp_account",
    ]) {
      expect(classifyRisk(op(operationId, "POST")), operationId).toBe("external_side_effect");
    }
  });
});
