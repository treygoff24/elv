import type { Risk } from "../openapi/types";

export type WsProtocol = "tts" | "tts-multi" | "ttd" | "ttd-multi" | "stt" | "convai" | "monitor";

/**
 * How a route's cost can be bounded before connecting.
 *   tts_characters - estimated from the characters in the send script
 *   unbounded      - the provider decides how much is generated, so no estimate exists
 *   unknown        - nothing is known about the cost of the traffic on this route
 */
export type WsCostModel = "tts_characters" | "unbounded" | "unknown";

interface WsCatalogFields {
  urlTemplate: string;
  pathTemplate: string;
  requiredParams: string[];
  auth: string;
  scriptable: boolean;
  protocol: WsProtocol;
  costModel: WsCostModel;
  /** Query parameter this route accepts a single-use credential in, for --token-env. */
  tokenParam?: "token" | "single_use_token";
  /** ElevenLabs rejects the eleven_v3 model families on this route. */
  rejectsV3?: boolean;
  outboundRisk?: Extract<Risk, "external_side_effect" | "destructive">;
  notes?: string;
  defaultQuery?: Record<string, string>;
  /**
   * Encoding of the audio this route returns when the request does not set
   * output_format. ElevenLabs TTS and Text to Dialogue WebSockets default to
   * mp3_44100_128 (documented default; the pinned OpenAPI snapshot carries no
   * WebSocket definitions). Agent audio is configured server-side per agent, so
   * convai declares nothing and its bytes are written without a format label.
   */
  defaultAudioFormat?: string;
}

const WS_CATALOG = [
  {
    name: "tts-realtime",
    costModel: "tts_characters",
    tokenParam: "single_use_token",
    rejectsV3: true,
    urlTemplate:
      "wss://api.elevenlabs.io/v1/text-to-speech/{voice_id}/stream-input?model_id={model_id}",
    pathTemplate: "/v1/text-to-speech/{voice_id}/stream-input",
    requiredParams: ["voice_id"],
    auth: "xi-api-key header, single_use_token query, or xi_api_key in first message",
    scriptable: true,
    protocol: "tts",
    defaultAudioFormat: "mp3_44100_128",
    defaultQuery: { model_id: "eleven_flash_v2_5" },
  },
  {
    name: "tts-multi",
    costModel: "tts_characters",
    tokenParam: "single_use_token",
    rejectsV3: true,
    urlTemplate:
      "wss://api.elevenlabs.io/v1/text-to-speech/{voice_id}/multi-stream-input?model_id={model_id}",
    pathTemplate: "/v1/text-to-speech/{voice_id}/multi-stream-input",
    requiredParams: ["voice_id"],
    auth: "xi-api-key header, single_use_token query, or xi_api_key in first message",
    scriptable: true,
    protocol: "tts-multi",
    defaultAudioFormat: "mp3_44100_128",
    defaultQuery: { model_id: "eleven_flash_v2_5" },
  },
  {
    name: "ttd-realtime",
    costModel: "tts_characters",
    tokenParam: "single_use_token",
    urlTemplate: "wss://api.elevenlabs.io/v1/text-to-dialogue/stream-input?model_id={model_id}",
    pathTemplate: "/v1/text-to-dialogue/stream-input",
    requiredParams: [],
    auth: "xi-api-key or Authorization header, single_use_token query, or credential in first message",
    scriptable: true,
    protocol: "ttd",
    defaultAudioFormat: "mp3_44100_128",
    defaultQuery: { model_id: "eleven_v3_conversational" },
  },
  {
    name: "ttd-multi",
    costModel: "tts_characters",
    tokenParam: "single_use_token",
    urlTemplate:
      "wss://api.elevenlabs.io/v1/text-to-dialogue/multi-stream-input?model_id={model_id}",
    pathTemplate: "/v1/text-to-dialogue/multi-stream-input",
    requiredParams: [],
    auth: "xi-api-key or Authorization header, single_use_token query, or credential in first message",
    scriptable: true,
    protocol: "ttd-multi",
    defaultAudioFormat: "mp3_44100_128",
    defaultQuery: { model_id: "eleven_v3_conversational" },
  },
  {
    name: "stt-realtime",
    costModel: "unbounded",
    tokenParam: "token",
    urlTemplate: "wss://api.elevenlabs.io/v1/speech-to-text/realtime?model_id={model_id}",
    pathTemplate: "/v1/speech-to-text/realtime",
    requiredParams: [],
    auth: "xi-api-key header or token query",
    scriptable: true,
    protocol: "stt",
    defaultQuery: { model_id: "scribe_v2_realtime" },
  },
  {
    name: "convai",
    costModel: "unbounded",
    urlTemplate: "wss://api.elevenlabs.io/v1/convai/conversation?agent_id={agent_id}",
    pathTemplate: "/v1/convai/conversation",
    requiredParams: ["agent_id"],
    auth: "signed URL for private agents, or agent_id for public agents",
    scriptable: true,
    protocol: "convai",
    outboundRisk: "external_side_effect",
  },
  {
    name: "convai-monitor",
    costModel: "unknown",
    urlTemplate: "wss://api.elevenlabs.io/v1/convai/conversations/{conversation_id}/monitor",
    pathTemplate: "/v1/convai/conversations/{conversation_id}/monitor",
    requiredParams: ["conversation_id"],
    auth: "xi-api-key header; enterprise/workspace permission required",
    scriptable: true,
    protocol: "monitor",
    outboundRisk: "external_side_effect",
    notes:
      "Streams text and metadata. Outbound controls can end or transfer calls, inject context, or enable human takeover.",
  },
] as const satisfies readonly ({ name: string } & WsCatalogFields)[];

type WsCatalogName = (typeof WS_CATALOG)[number]["name"];

export interface WsCatalogEntry extends WsCatalogFields {
  name: WsCatalogName;
}

export function listWsCatalog(): WsCatalogEntry[] {
  return WS_CATALOG.map((entry: WsCatalogEntry) => ({
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
  for (const param of entry.requiredParams) {
    if (entry.pathTemplate.includes(`{${param}}`)) url.searchParams.delete(param);
  }
  return url;
}

export function wsBaseHost(baseUrl: string): string {
  return new URL(wsBase(baseUrl)).host;
}

export function wsUrlFromPath(path: string, baseUrl: string): URL {
  const base = new URL(wsBase(baseUrl));
  const url = new URL(path, base);
  if (url.host !== base.host) throw new Error("WebSocket path resolves outside configured host");
  return url;
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
