import { readFile } from "node:fs/promises";

type ParseFile = (
  filePath: string,
  options: { duration: boolean; skipCovers: boolean },
) => Promise<{ format: { duration?: number } }>;

export async function probeDurationSeconds(filePath: string): Promise<number | null> {
  try {
    return (await wavDurationSeconds(filePath)) ?? (await metadataDurationSeconds(filePath));
  } catch {
    return null;
  }
}

async function wavDurationSeconds(filePath: string): Promise<number | null> {
  const buffer = await readFile(filePath);
  if (
    buffer.length < 44 ||
    buffer.toString("ascii", 0, 4) !== "RIFF" ||
    buffer.toString("ascii", 8, 12) !== "WAVE"
  ) {
    return null;
  }

  let byteRate: number | null = null;
  let dataBytes: number | null = null;
  for (let offset = 12; offset + 8 <= buffer.length; ) {
    const id = buffer.toString("ascii", offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const dataOffset = offset + 8;
    if (id === "fmt " && dataOffset + 12 <= buffer.length)
      byteRate = buffer.readUInt32LE(dataOffset + 8);
    if (id === "data") dataBytes = size;
    offset = dataOffset + size + (size % 2);
  }

  return byteRate && dataBytes !== null ? dataBytes / byteRate : null;
}

async function metadataDurationSeconds(filePath: string): Promise<number | null> {
  try {
    const { parseFile } = (await import("music-metadata")) as unknown as { parseFile: ParseFile };
    const metadata = await parseFile(filePath, { duration: true, skipCovers: true });
    return Number.isFinite(metadata.format.duration) ? (metadata.format.duration ?? null) : null;
  } catch {
    return null;
  }
}
