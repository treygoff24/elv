import { afterEach, describe, expect, it, vi } from "vitest";
import { runOperation } from "../../src/core/client";

describe("runner dry-run", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("returns after validation and before gates/network", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);

    const env = await runOperation(
      "text_to_speech_full",
      { path: { voice_id: "voice_1" }, body: { text: "hi" } },
      { dryRun: true, maxCredits: 0 },
    );

    expect(env.ok).toBe(true);
    if (!env.ok) throw new Error("expected success");
    expect(fetch).not.toHaveBeenCalled();
    expect(env).toMatchObject({ ok: true, operation_id: "text_to_speech_full" });
    expect((env.data as Record<string, unknown>).dry_run).toBe(true);
  });
});
