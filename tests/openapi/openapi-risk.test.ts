import { describe, expect, it } from "vitest";
import { classifyRisk, costHintForOperationId } from "../../src/openapi/risk";
import type { OperationCard } from "../../src/core/types";

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
});
