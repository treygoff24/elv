import { describe, expect, it } from "vitest";
import { normalizeProviderError } from "../src/core/error-normalizer";

describe("provider error normalization", () => {
  it("normalizes FastAPI array detail", () => {
    const err = normalizeProviderError(
      { detail: [{ loc: ["body", "model_id"], msg: "bad model", type: "value_error" }] },
      422,
      new Headers({ "request-id": "req_1" }),
    );
    expect(err).toMatchObject({
      type: "validation_error",
      code: "validation_error",
      message: "body: bad model",
      param: "model_id",
      request_id: "req_1",
    });
    expect(err.raw).toEqual({
      detail: [{ loc: ["body", "model_id"], msg: "bad model", type: "value_error" }],
    });
  });

  it("normalizes rich object detail", () => {
    const err = normalizeProviderError(
      {
        detail: {
          type: "validation_error",
          code: "invalid_parameters",
          message: "bad",
          request_id: "req_2",
          param: "keyterms",
        },
      },
      400,
      new Headers(),
    );
    expect(err).toMatchObject({
      type: "validation_error",
      code: "invalid_parameters",
      message: "bad",
      param: "keyterms",
      request_id: "req_2",
    });
  });

  it("normalizes legacy object detail", () => {
    const err = normalizeProviderError(
      { detail: { status: "invalid_api_key", message: "Invalid API key" } },
      401,
      new Headers(),
    );
    expect(err).toMatchObject({
      type: "authentication_error",
      code: "invalid_api_key",
      message: "Invalid API key",
      param: null,
    });
  });

  it("normalizes bare string detail", () => {
    const err = normalizeProviderError(
      { detail: "try later" },
      429,
      new Headers({ "request-id": "req_3" }),
    );
    expect(err).toMatchObject({
      type: "rate_limit_error",
      code: "rate_limit_exceeded",
      message: "try later",
      param: null,
      request_id: "req_3",
    });
  });
});
