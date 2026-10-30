/**
 * The id a steer carries, derived rather than minted, and how each driver spells it.
 *
 * ## Why a steer needs an id at all
 *
 * A steer is a second message into a session that is already running, and unlike a
 * session's opening prompt it is a thing that can legitimately be **retried**: the goal
 * agent's `steer_planner` tool takes an `operation_id` exactly as `add_intent` does, so an
 * MCP call whose answer was lost can be repeated safely. Repeated delivery of a directive
 * is not safe — "ignore the previous instruction and look at the login flow instead" is a
 * different conversation when it arrives twice — so the retry has to be recognisable.
 *
 * DECISIONS.md §24.1 records that T3 Code does this at the same seam and for the same
 * reason: its OpenCode adapter derives the inbox id from the session and message id "so a
 * retry cannot double-deliver". {@link derivedMessageId} is that derivation, and
 * `AgentHarness.prompt` is where the dedupe is kept.
 *
 * ## Why the value is hex and not either driver's format
 *
 * The two drivers want incompatible ids: OpenCode's `SessionMessage.ID` is checked for a
 * `msg_` prefix (`@opencode/schema`'s `Schema.isStartingWith("msg_")`) and the Claude Agent
 * SDK's `uuid` is a UUID — the spike sent `crypto.randomUUID()`. A single string cannot be
 * both, so the application's own id is **128 bits of lowercase hex and nothing else**, and
 * each client maps it into its own id space with a total, stable function:
 * {@link openCodeMessageId} and {@link claudeCodeMessageId}.
 *
 * The seam's promise is therefore ours rather than either driver's — the same application
 * message id is delivered at most once per session, enforced in the client — and the
 * driver-side id is the second line of defence it happens to also get.
 */

/** How many hex characters a derived id has: 128 bits, like a UUID's payload. */
export const MESSAGE_ID_HEX = 32;

/**
 * The message id one steer gets, from the caller and the operation it belongs to.
 *
 * Deterministic and collision-resistant in the one way that matters: two *different*
 * operations by the same caller get different ids, and the same operation retried gets the
 * same one byte for byte. The caller scope is in the hash so two callers using the same
 * operation id do not collide — the same argument `derivedIntentId` makes in
 * `mcp/plannerTools.ts`, which this mirrors deliberately so there is one pattern for
 * "derived, never minted" in this codebase rather than two.
 *
 * It is **not** sortable, carries no timestamp and cannot be parsed back. Nothing reads
 * anything out of it: it is an equality key.
 */
export const derivedMessageId = (
  callerScope: string,
  operationId: string,
): string =>
  new Bun.CryptoHasher("sha256")
    .update(`${callerScope}:${operationId}`)
    .digest("hex")
    .slice(0, MESSAGE_ID_HEX);

/** Whether a value is in the shape {@link derivedMessageId} produces. */
export const isDerivedMessageId = (value: string): boolean =>
  value.length === MESSAGE_ID_HEX && /^[0-9a-f]+$/.test(value);

/**
 * The same id in OpenCode's message-id space.
 *
 * `msg_` plus the hex. The brand's only check is that prefix, so this is valid for any
 * value and the mapping is total — an id that is not in the derived shape is still
 * prefixed rather than replaced, because the client's own dedupe is keyed on the
 * application value and silently substituting a different id here would make the two
 * disagree.
 */
export const openCodeMessageId = (messageId: string): string =>
  `msg_${messageId}`;

/**
 * The same id as a syntactically valid UUID, for the Claude Agent SDK.
 *
 * **Version 8 — "custom" — with the RFC variant bits set**, because that is what a UUID
 * derived from a hash honestly is. Claiming version 4 would be claiming randomness this
 * value does not have, and leaving the version and variant nibbles as whatever the hash
 * produced would risk a parser that validates them.
 *
 * A value that is not in the derived shape is **not** mapped: it falls back to a random
 * UUID, so a caller that passed something else still gets a well-formed id. That costs the
 * driver-side idempotency for that one call and keeps ours, which is the right way round —
 * see this module's header on which of the two is the promise.
 */
export const claudeCodeMessageId = (messageId: string): string => {
  if (!isDerivedMessageId(messageId)) return crypto.randomUUID();
  const hex = messageId;
  const version = `8${hex.slice(13, 16)}`;
  // 0b10xx: the RFC 9562 variant. The low two bits of the nibble are kept from the hash.
  const variant = (8 + (Number.parseInt(hex[16] ?? "0", 16) & 0x3)).toString(
    16,
  );
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${version}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};
