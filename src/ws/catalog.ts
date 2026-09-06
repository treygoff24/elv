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
  /** Whether `--duplex` can drive this route from stdin. */
  duplex: boolean;
  /**
   * What the first outbound message on this route has to be, and how a session on it
   * ends. Both restate the rules WsProtocolValidator enforces, which are hand-written
   * from ElevenLabs WebSocket documentation: the pinned OpenAPI snapshot defines no
   * WebSocket routes, so nothing in this repository can check them.
   */
  firstMessage: string;
  terminalRule: string;
  /** Query parameter this route accepts a single-use credential in, for --token-env. */
  tokenParam?: "token" | "single_use_token";
  /** ElevenLabs rejects the eleven_v3 model families on this route (documented, not in the snapshot). */
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
    duplex: true,
    firstMessage: 'Send {"text":" "} to open the stream before any real text.',
    terminalRule:
      'Send {"text":""} to force generation and end the context; {"type":"close"} then closes the socket.',
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
    duplex: true,
    firstMessage: 'Send {"text":" "} with the context_id you intend to use.',
    terminalRule:
      'Send {"close_context":true,"context_id":"..."} to end one context and {"close_socket":true} alone to end the socket.',
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
    duplex: true,
    firstMessage:
      'First send must declare 1 to 10 "voices" (exactly one for eleven_v3_conversational).',
    terminalRule: 'Send {"close_socket":true} to end the session.',
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
    duplex: true,
    firstMessage:
      'First send per context must carry "context_id" and 1 to 10 "voices", up to 5 contexts.',
    terminalRule:
      'Send {"close_context":true,"context_id":"..."} to end one context and {"close_socket":true} alone to end the socket.',
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
    duplex: true,
    firstMessage:
      'Send send_audio_file actions; "previous_text" is accepted only with the first chunk.',
    terminalRule: 'Send {"type":"close"} or close stdin to end the session.',
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
    duplex: true,
    firstMessage:
      'Any agent message, for example {"type":"send","data":{"type":"user_message","text":"..."}}; the agent may speak first.',
    terminalRule: 'Send {"type":"close"} or close stdin; the agent can also end the conversation.',
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
    duplex: true,
    firstMessage: "Receive-only by default; outbound control messages require --yes.",
    terminalRule: 'Send {"type":"close"} or close stdin to stop monitoring.',
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
