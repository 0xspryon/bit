/**
 * The derived message id, and the two id spaces it has to live in.
 *
 * Small claims, and each of them is load-bearing somewhere a test cannot easily reach. The
 * seam's promise is that the same message id is delivered at most once per session
 * (`claudeCodeClient.test.ts` asserts the dedupe itself); what is asserted here is that a
 * *retry* presents the same id at all, that two different operations do not, and that the
 * two per-driver mappings produce values the drivers will actually accept — a UUID for the
 * Claude Agent SDK, and a `msg_`-prefixed string for OpenCode's branded
 * `SessionMessage.ID`. A mapping that produced an invalid id would fail at the one moment
 * nobody is watching: a steer into a live round.
 */
import { describe, expect, test } from "bun:test";

import {
  MESSAGE_ID_HEX,
  claudeCodeMessageId,
  derivedMessageId,
  isDerivedMessageId,
  openCodeMessageId,
} from "./messageId";

const SCOPE = "alpha/goal/goal_1";

describe("deriving a steer's message id", () => {
  test("the same caller and operation derive the same id, every time", () => {
    // The whole point: a retried `steer_planner` has to present the id the session already
    // accepted, or the directive arrives twice.
    expect(derivedMessageId(SCOPE, "op-1")).toBe(
      derivedMessageId(SCOPE, "op-1"),
    );
  });

  test("a different operation, or a different caller, derives a different id", () => {
    expect(derivedMessageId(SCOPE, "op-1")).not.toBe(
      derivedMessageId(SCOPE, "op-2"),
    );
    // The scope is in the hash so two goals using the same operation id do not collide,
    // which is the argument `derivedIntentId` makes for intents.
    expect(derivedMessageId(SCOPE, "op-1")).not.toBe(
      derivedMessageId("alpha/goal/goal_2", "op-1"),
    );
  });

  test("it is 128 bits of lowercase hex and nothing else", () => {
    const id = derivedMessageId(SCOPE, "op-1");
    expect(id).toHaveLength(MESSAGE_ID_HEX);
    expect(id).toMatch(/^[0-9a-f]{32}$/);
    expect(isDerivedMessageId(id)).toBe(true);
    expect(isDerivedMessageId("not-hex")).toBe(false);
  });
});

describe("the same id in each driver's own space", () => {
  test("OpenCode gets the `msg_` prefix its brand checks for", () => {
    // `@opencode/schema`'s `SessionMessage.ID` is `Schema.isStartingWith("msg_")`, so this
    // is the whole of what it requires — and the mapping is total, so an id that is not in
    // the derived shape is still prefixed rather than replaced.
    expect(openCodeMessageId(derivedMessageId(SCOPE, "op-1"))).toMatch(
      /^msg_[0-9a-f]{32}$/,
    );
    expect(openCodeMessageId("anything")).toBe("msg_anything");
  });

  test("Claude Code gets a syntactically valid UUID, and the same one every time", () => {
    const id = derivedMessageId(SCOPE, "op-1");
    const uuid = claudeCodeMessageId(id);
    // Version 8 — "custom" — with the RFC variant bits set, because a UUID derived from a
    // hash is honestly neither random nor time-based. Claiming version 4 would claim
    // randomness this value does not have.
    expect(uuid).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(claudeCodeMessageId(id)).toBe(uuid);
    expect(claudeCodeMessageId(derivedMessageId(SCOPE, "op-2"))).not.toBe(uuid);
  });

  test("a value that is not a derived id still becomes a well-formed UUID", () => {
    // The fallback is a random UUID, which costs the *driver's* idempotency for that call
    // and keeps ours — the dedupe is keyed on the application value. Said in the module
    // header; asserted here so the shape is still valid rather than, say, empty.
    expect(claudeCodeMessageId("short")).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });
});
