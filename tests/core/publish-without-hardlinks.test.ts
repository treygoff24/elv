import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OutTargetError, writeBufferToFile } from "../../src/core/files";

// exFAT/FAT32, SMB without Unix extensions and several FUSE backends reject link(2).
// Publication must still never replace an occupied path on those targets.
const fs = vi.hoisted(() => ({
  linkCode: undefined as string | undefined,
  openFailure: undefined as { suffix: string; code: string } | undefined,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    link: async (...args: Parameters<typeof actual.link>) => {
      if (fs.linkCode) throw Object.assign(new Error("link refused"), { code: fs.linkCode });
      return actual.link(...args);
    },
    open: async (...args: Parameters<typeof actual.open>) => {
      const target = String(args[0]);
      if (fs.openFailure && target.endsWith(fs.openFailure.suffix))
        throw Object.assign(new Error("open refused"), { code: fs.openFailure.code });
      return actual.open(...args);
    },
  };
});

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "elv-nolink-"));
  fs.linkCode = "EPERM";
  fs.openFailure = undefined;
});

afterEach(() => {
  fs.linkCode = undefined;
  fs.openFailure = undefined;
  rmSync(dir, { recursive: true, force: true });
});

describe("publication on filesystems without hard links", () => {
  it.each(["EPERM", "ENOTSUP", "EOPNOTSUPP", "EXDEV", "EMLINK", "ENOSYS"])(
    "publishes through exclusive create when link fails with %s",
    async (code) => {
      fs.linkCode = code;
      const path = join(dir, "out.bin");

      expect(await writeBufferToFile(Buffer.from("payload"), path, { mode: 0o600 })).toBe(path);

      expect(readFileSync(path, "utf8")).toBe("payload");
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(readdirSync(dir)).toEqual(["out.bin"]);
    },
  );

  it("chooses a collision name instead of replacing an occupied path", async () => {
    const path = join(dir, "out.bin");
    await writeBufferToFile(Buffer.from("first"), path, { mode: 0o600 });

    const second = await writeBufferToFile(Buffer.from("second"), path, { mode: 0o600 });

    expect(second).not.toBe(path);
    expect(readFileSync(path, "utf8")).toBe("first");
    expect(readFileSync(second, "utf8")).toBe("second");
    expect(statSync(second).mode & 0o777).toBe(0o600);
    expect(readdirSync(dir)).toHaveLength(2);
  });

  it("reuses an identical published file rather than writing a duplicate", async () => {
    const path = join(dir, "out.bin");
    await writeBufferToFile(Buffer.from("same"), path, { mode: 0o600 });

    expect(await writeBufferToFile(Buffer.from("same"), path, { mode: 0o600 })).toBe(path);
    expect(readdirSync(dir)).toEqual(["out.bin"]);
  });

  it("does not weaken an occupied path's mode when the request wants 0600", async () => {
    const path = join(dir, "out.bin");
    await writeBufferToFile(Buffer.from("same"), path);
    chmodSync(path, 0o644);

    const published = await writeBufferToFile(Buffer.from("same"), path, { mode: 0o600 });

    expect(published).not.toBe(path);
    expect(statSync(path).mode & 0o777).toBe(0o644);
    expect(statSync(published).mode & 0o777).toBe(0o600);
  });

  it("reports an out-target error with a hint when neither link nor create works", async () => {
    fs.openFailure = { suffix: ".bin", code: "EROFS" };
    const path = join(dir, "out.bin");

    const error = await writeBufferToFile(Buffer.from("payload"), path, { mode: 0o600 }).catch(
      (failure: unknown) => failure,
    );

    expect(error).toBeInstanceOf(OutTargetError);
    const outTarget = error as InstanceType<typeof OutTargetError>;
    expect(outTarget.code).toBe("invalid_out_target");
    expect(outTarget.message).toContain("EROFS");
    expect(outTarget.hint).toContain("--out");
  });

  it("reports an out-target error when link fails for an unrelated reason", async () => {
    fs.linkCode = "ENOSPC";
    const path = join(dir, "out.bin");

    const error = await writeBufferToFile(Buffer.from("payload"), path).catch(
      (failure: unknown) => failure,
    );

    expect(error).toBeInstanceOf(OutTargetError);
    expect((error as InstanceType<typeof OutTargetError>).message).toContain("ENOSPC");
  });
});
