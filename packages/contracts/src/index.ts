import { Schema } from "effect";

export const Health = Schema.Struct({ status: Schema.Literal("ok") });
export type Health = typeof Health.Type;

export * from "./http";
export * from "./api";
export * from "./modelOption";
export * from "./observation";
export * from "./briefing";
export * from "./asset";
export * from "./scope";
export * from "./scopeImport";
export * from "./agentSessions";
export * from "./agents";
export * from "./intent";
export * from "./goal";
export * from "./plan";
export * from "./goalAgent";
export * from "./goalUpload";
export * from "./event";
export * from "./live";
export * from "./mcpToolName";
export * from "./unknownField";
