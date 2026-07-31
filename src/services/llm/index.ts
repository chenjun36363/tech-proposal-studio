import type { LlmProtocol } from "../../core/types";
import { anthropicMessagesAdapter } from "./protocols/anthropic";
import { googleGenerativeAiAdapter } from "./protocols/google";
import { openaiCompletionsAdapter, openaiResponsesAdapter } from "./protocols/openai";
import type { ProtocolAdapter } from "./types";

const ADAPTERS: Record<LlmProtocol, ProtocolAdapter> = {
  "openai-completions": openaiCompletionsAdapter,
  "openai-responses": openaiResponsesAdapter,
  "anthropic-messages": anthropicMessagesAdapter,
  "google-generative-ai": googleGenerativeAiAdapter,
};

export function protocolAdapter(protocol: LlmProtocol): ProtocolAdapter {
  return ADAPTERS[protocol] ?? openaiCompletionsAdapter;
}

export * from "./resolve";
export * from "./defaults";
export * from "./types";
