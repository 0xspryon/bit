import { Schema } from "effect";

export const Health = Schema.Struct({ status: Schema.Literal("ok") });
export type Health = typeof Health.Type;
