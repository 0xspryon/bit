/**
 * Who is calling an application-owned MCP tool.
 *
 * Provided per request by the transport's auth middleware from the presented bearer
 * credential, and by nothing else. A tool handler that wants to know the caller asks
 * for this service; it cannot be told by a tool argument.
 *
 * Pattern follows T3Code (MIT) `apps/server/src/mcp/McpInvocationContext.ts`.
 */
import { Context } from "effect";

import type { CallerContext } from "../persistence/store";

export class McpInvocation extends Context.Service<
  McpInvocation,
  CallerContext
>()("bit/mcp/McpInvocation") {}
