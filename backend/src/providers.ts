import type { MidnightRelay } from './adapters/relay.js';
import { createGeminiProvider } from "./adapters/gemini.js";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import type { Config } from "./config.js";
import type { MidnightAdapter, MidnightOperator } from "./adapters/midnight.js";
import type { AiProvider } from "./adapters/ai.js";
/** Modules are trusted operator-installed code, never URLs or user input. */
export async function loadProviders(config: Config, options: { includeRelay?: boolean } = {}) {
  const load = async (path: string) => {
    if (/^[a-z]+:/i.test(path)) throw new Error("LOCAL_MODULE_REQUIRED");
    return (await import(pathToFileURL(resolve(path)).href)).default;
  };
  const midnight: MidnightAdapter | undefined = config.midnightAdapterModule
    ? await load(config.midnightAdapterModule)
    : undefined;
  const ai: AiProvider | undefined = config.aiProviderModule
    ? await load(config.aiProviderModule)
    : config.geminiApiKey
      ? createGeminiProvider(config.geminiApiKey, config.geminiModel ?? "", fetch, { attemptTimeoutMs: config.aiTimeoutMs })
      : undefined;
  if (
    midnight &&
    (midnight.mode !== config.mode ||
      typeof midnight.prepare !== "function" ||
      typeof midnight.verify !== "function" ||
      typeof midnight.revealTerms !== "function" ||
      typeof midnight.revealStatus !== "function" ||
      !midnight.capabilities)
  )
    throw new Error("INVALID_MIDNIGHT_ADAPTER");
  if (ai && (ai.mode !== (config.aiMode ?? config.mode) || typeof ai.analyze !== "function"))
    throw new Error("INVALID_AI_PROVIDER");
  const relay: MidnightRelay | undefined = options.includeRelay !== false && config.midnightRelayModule ? await load(config.midnightRelayModule) : undefined;
  if (relay && (config.mode !== 'real' || relay.mode !== 'real' || ['info','balance','submit'].some(k => typeof (relay as any)[k] !== 'function'))) throw new Error('INVALID_MIDNIGHT_RELAY');
  return { midnight, ai, relay };
}

/** Kept separate so the API process never imports an operator secret-bearing module. */
export async function loadOperator(
  config: Config,
): Promise<MidnightOperator | undefined> {
  if (!config.midnightOperatorModule) return undefined;
  if (/^[a-z]+:/i.test(config.midnightOperatorModule))
    throw new Error("LOCAL_MODULE_REQUIRED");
  const operator = (
    await import(pathToFileURL(resolve(config.midnightOperatorModule)).href)
  ).default;
  if (
    !operator ||
    operator.mode !== config.mode ||
    [
      "issueTicket",
      "openRoom",
      "closeRoom",
      "isTicketIssued",
      "roomState",
    ].some((k) => typeof operator[k] !== "function")
  )
    throw new Error("INVALID_MIDNIGHT_OPERATOR");
  return operator;
}
