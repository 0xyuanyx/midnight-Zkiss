import { z } from "zod";
export interface Config {
  mode: "demo" | "real";
  databaseUrl: string;
  host: string;
  port: number;
  origin?: string;
  midnightAdapterModule?: string;
  midnightOperatorModule?: string;
  aiProviderModule?: string;
  aiMode?: "real" | "demo";
  geminiApiKey?: string;
  geminiModel?: string;
  geminiImageModel?: string;
  requireGeneratedImage?: boolean;
  autoCreateEvent?: boolean;
  snsOnly?: boolean;
  admissionMode?: "open" | "midnight";
  defaultEventId?: string;
  midnightNetwork?: string;
  midnightContractAddress?: string;
  midnightEventScope?: string;
  secureCookies: boolean;
  sessionHours: number;
  aiTimeoutMs: number;
  sessionRateLimit: number;
}
export const localConfig: Config = {
  mode: "demo",
  admissionMode: "midnight",
  databaseUrl: "postgres://zkiss:local-development-only@127.0.0.1:55432/zkiss",
  host: "127.0.0.1",
  port: 3001,
  secureCookies: false,
  sessionHours: 12,
  aiTimeoutMs: 30000,
  sessionRateLimit: 30,
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const mode = z.enum(["real", "demo"]).default("real").parse(env.ZKISS_MODE);
  const integer = (key: string, fallback: number, min: number, max: number) =>
    z.coerce
      .number()
      .int()
      .min(min)
      .max(max)
      .parse(env[key] ?? fallback);
  const databaseUrl = z
    .string()
    .url()
    .regex(/^postgres(?:ql)?:\/\//)
    .parse(
      env.DATABASE_URL ??
        (mode === "demo" ? localConfig.databaseUrl : undefined),
    );
  const secureCookies =
    z
      .enum(["true", "false"])
      .parse(env.SECURE_COOKIES ?? (mode === "real" ? "true" : "false")) ===
    "true";
  if (mode === "real" && !secureCookies)
    throw new Error("SECURE_COOKIES_REQUIRED");
  const publicOrigin = env.PUBLIC_ORIGIN ?? env.RENDER_EXTERNAL_URL;
  const origin = publicOrigin
    ? new URL(publicOrigin).origin
    : undefined;
  if (mode === "real" && origin && !origin.startsWith("https://"))
    throw new Error("HTTPS_ORIGIN_REQUIRED");
  return {
    mode,
    databaseUrl,
    secureCookies,
    origin,
    host: env.HOST ?? "127.0.0.1",
    port: integer("PORT", 3001, 1, 65535),
    sessionHours: integer("SESSION_HOURS", 12, 1, 168),
    aiTimeoutMs: integer("AI_TIMEOUT_MS", 120000, 100, 300000),
    sessionRateLimit: integer("SESSION_RATE_LIMIT", 30, 1, 10000),
    midnightAdapterModule: env.MIDNIGHT_ADAPTER_MODULE,
    midnightOperatorModule: env.MIDNIGHT_OPERATOR_MODULE,
    aiProviderModule: env.AI_PROVIDER_MODULE,
    aiMode: z.enum(["real", "demo"]).optional().parse(env.AI_MODE),
    geminiApiKey: env.GEMINI_API_KEY,
    geminiModel: env.GEMINI_MODEL,
    geminiImageModel: env.GEMINI_IMAGE_MODEL,
    requireGeneratedImage: (env.AI_MODE ?? mode) === "real",
    autoCreateEvent: env.AUTO_CREATE_EVENT !== 'false',
    snsOnly: env.MIDNIGHT_PROTOCOL === 'zkiss-sns-v1',
    admissionMode: z.enum(["open", "midnight"]).default("open").parse(env.ADMISSION_MODE),
    defaultEventId: z.string().min(1).max(200).default("evt_mvp").parse(env.DEFAULT_EVENT_ID),
    midnightNetwork: env.MIDNIGHT_NETWORK,
    midnightContractAddress: env.MIDNIGHT_CONTRACT_ADDRESS,
    midnightEventScope: env.MIDNIGHT_EVENT_SCOPE,
  };
}
