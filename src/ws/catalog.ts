export type WsCatalogName = "tts-realtime" | "tts-multi" | "stt-realtime" | "convai";

export interface WsCatalogEntry {
  name: WsCatalogName;
  urlTemplate: string;
  pathTemplate: string;
  requiredParams: string[];
  auth: string;
  scriptable: boolean;
  defaultQuery?: Record<string, string>;
}

export const WS_CATALOG: readonly WsCatalogEntry[] = [
  {
    name: "tts-realtime",
    urlTemplate:
      "wss://api.elevenlabs.io/v1/text-to-speech/{voice_id}/stream-input?model_id={model_id}",
    pathTemplate: "/v1/text-to-speech/{voice_id}/stream-input",
    requiredParams: ["voice_id"],
    auth: "xi-api-key header, single_use_token query, or xi_api_key in first message",
    scriptable: true,
    defaultQuery: { model_id: "eleven_flash_v2_5" },
  },
  {
    name: "tts-multi",
    urlTemplate:
      "wss://api.elevenlabs.io/v1/text-to-speech/{voice_id}/multi-stream-input?model_id={model_id}",
    pathTemplate: "/v1/text-to-speech/{voice_id}/multi-stream-input",
    requiredParams: ["voice_id"],
    auth: "xi-api-key header, single_use_token query, or xi_api_key in first message",
    scriptable: true,
    defaultQuery: { model_id: "eleven_flash_v2_5" },
  },
  {
    name: "stt-realtime",
    urlTemplate: "wss://api.elevenlabs.io/v1/speech-to-text/realtime?model_id={model_id}",
    pathTemplate: "/v1/speech-to-text/realtime",
    requiredParams: [],
    auth: "xi-api-key header or single_use_token query",
    scriptable: true,
    defaultQuery: { model_id: "scribe_v2_realtime" },
  },
  {
    name: "convai",
    urlTemplate: "wss://api.elevenlabs.io/v1/convai/conversation?agent_id={agent_id}",
    pathTemplate: "/v1/convai/conversation",
    requiredParams: ["agent_id"],
    auth: "signed URL for private agents, or agent_id for public agents",
    scriptable: false,
  },
] as const;

export function listWsCatalog(): WsCatalogEntry[] {
  return WS_CATALOG.map((entry) => ({
    ...entry,
    requiredParams: [...entry.requiredParams],
    defaultQuery: entry.defaultQuery ? { ...entry.defaultQuery } : undefined,
  }));
}

export function getWsCatalogEntry(name: string): WsCatalogEntry | undefined {
  return listWsCatalog().find((entry) => entry.name === name);
}

export function buildCatalogUrl(
  entry: WsCatalogEntry,
  options: { baseUrl: string; query?: Record<string, string> },
): URL {
  const query = { ...entry.defaultQuery, ...options.query };
  for (const param of entry.requiredParams) {
    if (!query[param]) throw new Error(`Missing required WS query parameter: ${param}`);
  }

  let template = withBaseHost(entry.urlTemplate, options.baseUrl);
  for (const [key, value] of Object.entries(query)) {
    template = template.replaceAll(`{${key}}`, encodeURIComponent(value));
  }
  const url = new URL(template);
  for (const [key, value] of Object.entries(query)) {
    if (!entry.urlTemplate.includes(`{${key}}`)) url.searchParams.set(key, value);
  }
  for (const param of entry.requiredParams) url.searchParams.delete(param);
  return url;
}

export function wsUrlFromPath(path: string, baseUrl: string): URL {
  return new URL(path, wsBase(baseUrl));
}

function withBaseHost(template: string, baseUrl: string): string {
  const base = new URL(baseUrl);
  const protocol = base.protocol === "http:" ? "ws:" : "wss:";
  return template.replace(/^wss?:\/\/[^/]+/u, `${protocol}//${base.host}`);
}

function wsBase(baseUrl: string): string {
  const base = new URL(baseUrl);
  base.protocol = base.protocol === "http:" ? "ws:" : "wss:";
  return base.toString();
}
