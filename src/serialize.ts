/**
 * Shared JSON-serialization primitives used by BOTH the core logger
 * (`src/logger.ts`, for the pretty-mode `safeStringify` pipeline) and the
 * request-logging middleware (`src/request-middleware.ts`, for `serializeBody`
 * and `ownContext`). Lives in its own module — rather than in `src/redact.ts` —
 * because JSON expressibility is a distinct concern from redaction: nothing
 * here decides what is a secret, and `redact.ts`'s contract is entirely about
 * the deep-redaction walk. The two consumers therefore share this without
 * importing each other, matching the one-concern-per-module split the rest of
 * `src/` already follows.
 */

/**
 * `JSON.stringify` replacer that renders `BigInt` values as their decimal
 * string representation. `JSON.stringify` has no built-in `BigInt` support, so
 * without this replacer any caller-supplied payload carrying one throws
 * `TypeError: Do not know how to serialize a BigInt`.
 *
 * BigInts reach a logger from ordinary sources — `express.json({ reviver })`,
 * a protobuf / gRPC adapter, a DB driver returning a 64-bit id, or plain
 * `logger.info("Order", { orderId: 123n })` — so every stringify call in this
 * package that runs over caller data must pass this replacer. Where it is
 * missing, the failure is never a clean error: in the pretty-mode formatter the
 * `TypeError` surfaces synchronously back at the application's own
 * `logger.info(...)` call, and in the middleware's `serializeBody` it collapses
 * the entire request body to the useless `String(body)` rendering
 * (`"[object Object]"`), silently discarding every diagnostic field.
 *
 * String coercion (rather than emitting a JSON number) is the conservative
 * choice for two reasons:
 * - JSON numbers are IEEE-754 doubles; values above `2^53 - 1`
 *   (`Number.MAX_SAFE_INTEGER`) round-trip with precision loss. Order IDs,
 *   user IDs, and Twitter / X-style snowflake IDs routinely exceed the safe
 *   range — emitting them as strings preserves fidelity end-to-end.
 * - It matches the convention used by `logform/json.js`'s built-in `replacer`
 *   for `winston.format.json()`, which also string-coerces BigInts for the same
 *   fidelity reason — so pretty mode, JSON mode, and the middleware all agree
 *   on how a BigInt renders.
 */
export const bigintSafeReplacer = (_key: string, value: unknown): unknown =>
  typeof value === "bigint" ? value.toString() : value;
