import { query } from "@anthropic-ai/claude-agent-sdk";

export {
  createSdkMcpServer,
  type OutputFormat,
  type Query,
  type SDKUserMessage,
  tool,
} from "@anthropic-ai/claude-agent-sdk";

export type QueryFn = typeof query;
export const sdkQuery: QueryFn = query;
