import { Schema } from "effect";

export const Health = Schema.Struct({ status: Schema.Literal("ok") });
export type Health = typeof Health.Type;

export * from "./http";
export * from "./api";
export * from "./observation";
export * from "./briefing";
export * from "./asset";
export * from "./intent";
export * from "./event";
export * from "./unknownField";
