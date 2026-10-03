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

export const userMessage = (content: unknown) => ({
  type: "user" as const,
  message: { role: "user" as const, content },
  parent_tool_use_id: null,
  session_id: "",
});
