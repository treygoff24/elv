import { describe, expect, it } from "vitest";
import { waitForOperation } from "../../src/core/wait-operation";
import { success } from "../../src/core/envelope";

describe("wait operation runtime selection", () => {
  it("passes the selected profile and base URL to every operation poll", async () => {
    const seen: unknown[] = [];
    await waitForOperation(
      {
        operation: "get_dubbing",
        json: "{}",
        statusPath: "$.data.status",
        success: "done",
        profile: "work",
        baseUrl: "https://api.eu.residency.elevenlabs.io",
      },
      {
        runOperation: async (_operation, _input, opts) => {
          seen.push(opts);
          return success({ cmd: "elv call get_dubbing", data: { status: "done" } });
        },
      },
    );

    expect(seen).toEqual([{ profile: "work", baseUrl: "https://api.eu.residency.elevenlabs.io" }]);
  });
});
