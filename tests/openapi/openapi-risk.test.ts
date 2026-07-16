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

  it("classifies the POST knowledge-base query as read-only", () => {
    expect(classifyRisk(op("query_agent_knowledge_base_rag_route", "POST"))).toBe("read");
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
      "create_mcp_server_route",
      "update_mcp_server_config_route",
      "update_mcp_server_approval_policy_route",
      "add_mcp_server_tool_approval_route",
      "add_mcp_tool_config_override_route",
      "update_mcp_tool_config_override_route",
      "update_whatsapp_account",
    ]) {
      expect(classifyRisk(op(operationId, "POST")), operationId).toBe("external_side_effect");
    }
  });

  it("uses naming and path heuristics for newly added side-effect operations", () => {
    expect(classifyRisk(op("rotate_service_account_api_key", "POST"))).toBe("external_side_effect");
    expect(classifyRisk(op("future_member_invite", "POST"))).toBe("external_side_effect");
    expect(
      classifyRisk({
        ...op("http", "POST"),
        pathTemplate: "/v1/private/outbound-message",
      }),
    ).toBe("external_side_effect");
    expect(classifyRisk(op("delete_legacy_token", "POST"))).toBe("destructive");
  });
});
