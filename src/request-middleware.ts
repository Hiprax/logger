import type winston from "winston";
import type {
  LoggableMiddleware,
  LoggableNext,
  LoggableRequest,
  LoggableResponse,
  RequestLogEntry,
  RequestLoggerOptions,
  RequestLogEvent,
  RequestLoggingMode,
} from "./types";
import { createLogger } from "./logger";
import { redactValue, REDACTED } from "./redact";
import { bigintSafeReplacer } from "./serialize";
import { RequestLoggerOptionError } from "./errors";
import type { LogLevel } from "./types";

/**
 * Frozen tuple of every npm log level supported by Winston, in priority order.
 * Mirrored locally from `src/logger.ts` so this module can validate the
 * middleware's `level` option without importing the logger module's internals.
 */
const VALID_LOG_LEVELS = Object.freeze([
  "error",
  "warn",
  "info",
  "http",
  "verbose",
  "debug",
  "silly",
] as const);

const isValidLogLevel = (value: unknown): value is LogLevel =>
  typeof value === "string" && (VALID_LOG_LEVELS as readonly string[]).includes(value);

/**
 * Validates the static-string form of `RequestLoggerOptions.level`. The
 * function-form (`(statusCode) => LogLevel`) is accepted here without
 * up-front validation — its return value is validated at request time inside
 * `finalize()`: an invalid or `undefined` return falls back to
 * `determineLevel(statusCode)` so the log line is never silently dropped.
 */
const validateRequestLevelOption = (value: unknown): void => {
  if (value === undefined || typeof value === "function") {
    return;
  }
  if (!isValidLogLevel(value)) {
    throw new RequestLoggerOptionError(
      "INVALID_LEVEL",
      `Invalid \`level\` option: ${JSON.stringify(value)}. Expected one of: ${VALID_LOG_LEVELS.join(", ")} or a (statusCode) => LogLevel function.`,
    );
  }
};

/**
 * Validates that a mask-keys option is either an array of strings, the literal
 * `false` (when permitted by the option), or `undefined`. Throws
 * `RequestLoggerOptionError({ code: "INVALID_MASK" })` otherwise.
 *
 * @param label  Option name used in the error message (e.g. `"maskBodyKeys"`).
 * @param value  The caller-supplied option value.
 * @param allowFalse  When true, the literal `false` is accepted (used by
 *   `maskHeaderKeys` / `maskQueryKeys` to opt out of safe-defaults masking).
 */
const validateMaskKeysOption = (label: string, value: unknown, allowFalse: boolean): void => {
  if (value === undefined) {
    return;
  }
  if (allowFalse && value === false) {
    return;
  }
  if (!Array.isArray(value)) {
    throw new RequestLoggerOptionError(
      "INVALID_MASK",
      `Invalid \`${label}\` option: expected an array of strings${
        allowFalse ? " (or `false` to opt out)" : ""
      }, got ${typeof value}.`,
    );
  }
  const badIndex = value.findIndex((entry) => typeof entry !== "string");
  if (badIndex !== -1) {
    throw new RequestLoggerOptionError(
      "INVALID_MASK",
      `Invalid \`${label}\` option: every entry must be a string. Entry at index ${badIndex} is ${typeof value[badIndex]}.`,
    );
  }
};

/**
 * Validates `RequestLoggerOptions.maxBodyLength`. Accepts `undefined` (falls
 * back to `DEFAULT_BODY_LIMIT`). Otherwise requires a number that is not `NaN`
 * and is `> 0` — this rejects `0`, negatives, and non-numbers while preserving
 * `Infinity` as "unlimited" (body is never truncated). Throws
 * `RequestLoggerOptionError({ code: "INVALID_BODY_LIMIT" })` on bad input.
 */
const validateMaxBodyLength = (value: unknown): void => {
  if (value === undefined) {
    return;
  }
  if (typeof value !== "number" || isNaN(value) || value <= 0) {
    throw new RequestLoggerOptionError(
      "INVALID_BODY_LIMIT",
      `Invalid \`maxBodyLength\` option: expected a positive number or Infinity, got ${
        typeof value === "number" ? value : JSON.stringify(value)
      }.`,
    );
  }
};

const DEFAULT_BODY_LIMIT = 3000;
const DEFAULT_ENV_SOURCES = ["NODE_ENV", "APP_ENV", "ENV"];
const DEFAULT_DEV_VALUES = ["dev", "development", "local"];
const DEFAULT_PROD_VALUES = ["prod", "production", "live"];
const DEFAULT_TEST_VALUES = ["test", "testing", "qa", "staging"];

/**
 * Well-known symbol used to override the per-request start timestamp captured
 * by the middleware. Set `req[REQUEST_START_SYMBOL] = process.hrtime.bigint()`
 * from an upstream instrumentation hook (e.g., the very first piece of
 * middleware on the stack) to make `responseTimeMs` reflect the true
 * end-to-end latency rather than only the time spent inside this middleware
 * and its downstream handlers.
 *
 * The value MUST be a `bigint` produced by `process.hrtime.bigint()` — any
 * other type is silently ignored and the middleware falls back to capturing
 * its own start timestamp at entry time. This guards against accidental
 * misuse (e.g. assigning `Date.now()`) without crashing the request.
 *
 * Uses `Symbol.for("hiprax.request.start")` so multiple copies of this
 * package loaded into the same process (npm-link, mono-repos, dual ESM/CJS
 * resolution) all observe the same symbol.
 */
export const REQUEST_START_SYMBOL: unique symbol = Symbol.for("hiprax.request.start");

/**
 * Safe-defaults list of header names whose values are redacted when logging.
 * Opt-out (not opt-in) since these are the most common vectors for leaking
 * secrets via HTTP logs (bearer tokens, session cookies, API keys).
 */
const DEFAULT_MASKED_HEADER_KEYS: readonly string[] = [
  "authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "proxy-authorization",
];

/**
 * Safe-defaults list of query-string parameter names whose values are redacted
 * when logging the request URL. Covers the most common token/key/secret param
 * names used by OAuth callbacks, ad-hoc bearer tokens, and login forms.
 */
const DEFAULT_MASKED_QUERY_KEYS: readonly string[] = [
  "token",
  "access_token",
  "api_key",
  "apikey",
  "key",
  "code",
  "secret",
  "password",
];

const determineLevel = (statusCode: number): LogLevel => {
  if (statusCode >= 500) {
    return "error";
  }
  if (statusCode >= 400) {
    return "warn";
  }
  return "info";
};

/**
 * Reports whether `value` holds at most `maxLength` Unicode code points.
 *
 * **Bounded by design.** The walk stops the instant the count exceeds
 * `maxLength`, so the cost is O(`maxLength`) — never O(input length). That is
 * what lets `truncateString` measure a 200 kB body against a 3000-char limit
 * without materializing `Array.from(value)`, which would allocate one array
 * entry per code point purely to read its `.length` and defeat the very
 * O(`maxLength`) property the helper advertises.
 *
 * A string's `Symbol.iterator` yields code points (it is the same iterator
 * `for...of` and `Array.from` drive), so an astral-plane character counts as
 * the single character it is rather than as its two UTF-16 surrogate halves.
 * It is stepped directly here rather than through `for...of` because only the
 * count is wanted, never the code point itself.
 */
const isWithinCodePointLimit = (value: string, maxLength: number): boolean => {
  const iterator = value[Symbol.iterator]();
  let count = 0;
  while (!iterator.next().done) {
    count += 1;
    if (count > maxLength) {
      return false;
    }
  }
  return true;
};

/**
 * Truncates a string to fit within `maxLength` total characters, INCLUDING the
 * trailing ellipsis. Returns the input unchanged when it already fits. Result
 * length is exactly `maxLength` Unicode code points for any string longer than
 * the limit. When `maxLength <= 0` (a degenerate caller-supplied limit),
 * returns an empty string. When `maxLength === 1`, returns the single
 * ellipsis character.
 *
 * **Unicode contract.** This helper counts UTF-16 *code points* (handles
 * astral-plane / emoji surrogate pairs like `"😀"` correctly so a truncation
 * point that lands inside a surrogate pair never produces a lone half-pair).
 * It does NOT count *grapheme clusters*: a base character followed by one or
 * more combining marks (`"á" === "á"`, family ZWJ sequences, regional
 * indicator pairs) is treated as multiple code points, so a truncation
 * boundary may fall between a base character and its combining mark and
 * render as a separated form. Use `Intl.Segmenter` (Node 18+) for fully
 * grapheme-correct slicing if that matters for your data set.
 */
const truncateString = (value: string, maxLength: number): string => {
  // The fits-already guard MUST count the same unit as the truncation loop
  // below, or the two disagree on astral-plane input and this helper appends an
  // ellipsis to a string it never truncated: measuring here in code UNITS
  // (`value.length`) while the loop counts code POINTS made
  // `truncateString("[5 emoji]", 8)` return all five emoji plus a `…` — 5 code
  // points sit comfortably within the limit of 8, yet the log claimed
  // truncation and the output (11 code units) came out LONGER than the input
  // (10).
  //
  // `value.length <= maxLength` is retained purely as a cheap O(1) pre-check.
  // It is *sound* in the one direction that matters: a string can never hold
  // more code points than code units, so anything it accepts genuinely fits.
  // That keeps the common all-ASCII path walk-free; only when it fails do we
  // pay for the bounded count.
  if (value.length <= maxLength || isWithinCodePointLimit(value, maxLength)) {
    return value;
  }
  if (maxLength <= 0) {
    return "";
  }
  if (maxLength === 1) {
    return "…";
  }
  // Bounded for...of: stops after collecting maxLength - 1 code points so the
  // cost is O(maxLength) rather than O(input length). `for...of` over a string
  // iterates by Unicode code point (the same iterator `Array.from` uses), so
  // emoji surrogate pairs like `"😀"` are never torn in half at a boundary.
  let result = "";
  let count = 0;
  const limit = maxLength - 1;
  for (const codePoint of value) {
    if (count >= limit) {
      break;
    }
    result += codePoint;
    count++;
  }
  return `${result}…`;
};

interface TruncatedBodyEnvelope {
  _truncated: true;
  _originalLength: number;
  _preview: string;
}

/**
 * Builds the structured envelope returned in place of an over-limit object
 * body. Preserves valid JSON shape so downstream log shippers can ingest the
 * payload without special-casing strings vs. objects.
 */
const buildTruncatedEnvelope = (serialized: string, maxLength: number): TruncatedBodyEnvelope => ({
  _truncated: true,
  _originalLength: serialized.length,
  _preview: truncateString(serialized, maxLength),
});

/**
 * Substituted for `requestBody` when serializing the body fails outright.
 *
 * Logging is best-effort per this module's contract, and the body is the only
 * part of an entry built from arbitrary caller data — so its failure degrades
 * to this sentinel while the rest of the entry (method, url, status, duration)
 * is still logged.
 */
const UNSERIALIZABLE_BODY = "[UNSERIALIZABLE]";

const serializeBody = (
  body: unknown,
  maskKeys?: string[] | ReadonlySet<string>,
  maxLength = DEFAULT_BODY_LIMIT,
  bodyRedactPaths?: readonly string[],
) => {
  if (body === undefined || body === null) {
    return undefined;
  }

  // Accept either a pre-resolved Set (passed from the construction-time hot
  // path) or a plain array (used by __requestInternals direct test calls).
  // `Array.isArray` is the discriminant — it narrows `maskKeys` to `string[]`
  // in the true branch so `.map()` type-checks cleanly. In the else branch the
  // value is `ReadonlySet<string> | undefined`; we cast to `Set<string>` (all
  // ReadonlySet values are Set instances at runtime) and fall back to an empty
  // Set for the undefined case.
  const maskSet: Set<string> = Array.isArray(maskKeys)
    ? new Set(maskKeys.map((key) => key.toLowerCase()))
    : ((maskKeys as Set<string> | undefined) ?? new Set<string>());

  // Apply the keyword-based `maskBodyKeys` redaction. Returns a fresh object
  // for plain/data-bearing shapes but passes built-ins and `toJSON`-defining
  // instances through by identity (the documented redaction boundary — see
  // `src/redact.ts`).
  let masked = redactValue(body, maskSet, new WeakSet());

  // Apply body-scoped `redactPaths` BEFORE the truncation decision below, on a
  // fully-owned, `toJSON`-resolved deep copy of the masked graph. This closes
  // two problems at once:
  //   1. `_preview` leak — the post-assembly `redactPaths` pass in `finalize()`
  //      runs AFTER this function returns, by which point an over-limit body
  //      has already collapsed into `{ _truncated, _originalLength, _preview }`,
  //      a shape that no longer has the nested key the path targeted, so the
  //      redaction silently no-ops and a `redactPaths`-only secret survives
  //      inside `_preview`. Applying paths here, pre-truncation, closes that.
  //   2. Caller-object mutation — `redactEntryPath` writes in place, so it must
  //      never touch a node the caller still owns. `redactValue` shares
  //      built-ins and `toJSON`-defining instances (e.g. a DTO or a `moment`)
  //      by identity, so mutating them directly would corrupt the live
  //      `req.body`. Round-tripping through `JSON.parse(JSON.stringify(...))`
  //      first yields a graph that is (a) entirely fresh — nothing shared with
  //      the caller — and (b) shaped exactly as the final log serializer will
  //      render it: every `toJSON()` is resolved to its output (a
  //      `moment`/`Date` to its ISO string, a DTO to its serialized form), so
  //      an incidental built-in is never ballooned into its internal-state
  //      fields, and a secret exposed only through `toJSON()` (e.g. a private
  //      `#field`) is redacted rather than leaked.
  // The throw-away `{ requestBody: owned }` wrapper reuses `redactEntryPath`'s
  // `body.` → `requestBody.` alias and prototype-pollution guards; non-body
  // paths (`context.*`, header paths) no-op here and are applied by the
  // post-assembly loop in `finalize()`. `bigintSafeReplacer` is what keeps a
  // `BigInt` anywhere in the body from throwing here: without it a single
  // `BigInt` (an `express.json({ reviver })` product, a protobuf/gRPC adapter,
  // a 64-bit DB id) failed the round-trip, which — before the fail-closed
  // return below — meant the operator's mandated paths were silently skipped.
  if (bodyRedactPaths && bodyRedactPaths.length > 0 && masked && typeof masked === "object") {
    try {
      const owned: unknown = JSON.parse(JSON.stringify(masked, bigintSafeReplacer));
      const wrapper: Record<string, unknown> = { requestBody: owned };
      for (const path of bodyRedactPaths) {
        redactEntryPath(wrapper, path);
      }
      masked = wrapper.requestBody;
    } catch {
      // FAIL CLOSED. Reaching here means the operator configured `redactPaths`
      // and NONE of them could be applied to this body — `masked` is still the
      // graph those paths were meant to scrub. (The guard tests only that the
      // path list is non-empty, so a list holding purely non-body paths — e.g.
      // `["context.token"]` — degrades this body too. That is deliberate: the
      // direction is conservative, and the alternative renderings available
      // here are worthless anyway.) Falling through to the
      // `String(masked)` fallback would emit exactly the values the operator
      // ordered redacted: `String()` on an array invokes
      // `Array.prototype.join`, so `redactPaths: ["body.1"]` over
      // `["1", "SUPER-SECRET", 5n]` printed `"1,SUPER-SECRET,5"` in cleartext.
      // A body whose mandated redactions could not be applied must never be
      // emitted raw — the sentinel loses one diagnostic field, the fallback
      // loses the secret.
      return UNSERIALIZABLE_BODY;
    }
  }

  if (typeof masked === "string") {
    return truncateString(masked, maxLength);
  }

  try {
    // `bigintSafeReplacer` mirrors the pretty-mode formatter's `safeStringify`
    // and `logform/json.js`'s built-in replacer, so a BigInt renders as its
    // decimal string here instead of throwing and collapsing the whole body
    // into the `String(masked)` fallback (`"[object Object]"`). Note this
    // serialization is used for the length decision and the `_preview` text;
    // an under-limit body is returned as the live `masked` object, whose
    // BigInts the downstream logger renders through the same convention.
    const serialized = JSON.stringify(masked, bigintSafeReplacer);
    if (serialized.length > maxLength) {
      return buildTruncatedEnvelope(serialized, maxLength);
    }
    return masked;
  } catch {
    // Safe to render loosely: any `redactPaths` mandated for this body were
    // already applied above (a failure there returned the sentinel and never
    // reaches this point), so `masked` carries only `maskBodyKeys`-redacted
    // data.
    const fallback = String(masked);
    return truncateString(fallback, maxLength);
  }
};

/**
 * Returns a **fully-owned** copy of the `enrich()` context so the post-assembly
 * `redactPaths` pass — which writes in place via `redactEntryPath` — can never
 * mutate the caller's live object (typically `req.session` / `req.user`). The
 * result shares no reference with the caller, and this function never throws.
 *
 * A `JSON.parse(JSON.stringify(...))` round-trip is the primary strategy
 * (matching `serializeBody`'s body path): it yields a graph that shares nothing
 * with the caller and is `toJSON`-resolved exactly as the downstream log
 * serializer renders it, so a context that defines `toJSON` (a Mongoose
 * document, a class DTO, `req.user`) is copied BY VALUE — its fields stay
 * redactable by `redactPaths` instead of being passed through by identity and
 * mutated. A context carrying a `BigInt` (a snowflake id, a monetary amount)
 * makes the plain round-trip throw, so it is retried through a BigInt-coercing
 * replacer — still a fully-owned, `toJSON`-resolved copy. A context that
 * neither round-trip can express (a circular reference, or a value whose getter
 * / `toJSON` throws) degrades to a fresh owned `{ _unserializable: true }`
 * sentinel rather than sharing the caller's live graph or letting the failure
 * escape and drop the whole log line. `redactValue`'s `forceCopy` is
 * deliberately NOT used here: it passes a `toJSON`-defining instance through by
 * identity (a documented `redact.ts` boundary), which would leave a `toJSON`
 * DTO carrying a `BigInt` field shared with — and mutable on — the caller.
 */
const ownContext = (enriched: Record<string, unknown>): Record<string, unknown> => {
  try {
    return JSON.parse(JSON.stringify(enriched)) as Record<string, unknown>;
  } catch {
    // Fall through: a value is not JSON-expressible as-is (commonly a BigInt).
  }
  try {
    return JSON.parse(JSON.stringify(enriched, bigintSafeReplacer)) as Record<string, unknown>;
  } catch {
    // A circular reference, or a value whose getter / `toJSON` throws.
    return { _unserializable: true };
  }
};

/**
 * Property names that must NEVER be assigned through `acc[key] = …` when
 * rebuilding a header bag or walking a `redactPaths` segment. `__proto__`
 * invokes the prototype setter (mutating the local object's prototype chain
 * AND, when the path-walker reaches `Object.prototype`, the global prototype
 * itself). `constructor` / `prototype` are likewise structural fields whose
 * assignment can corrupt instanceof checks. Mirrors the deny-list inside
 * `src/redact.ts` for a single source of truth across the package.
 */
const FORBIDDEN_OBJECT_KEYS = new Set(["__proto__", "constructor", "prototype"]);

const applyHeaderMask = (
  headers: Record<string, unknown>,
  maskHeaderKeys: ReadonlySet<string> | undefined,
): Record<string, unknown> => {
  if (!maskHeaderKeys || maskHeaderKeys.size === 0) {
    return headers;
  }
  return Object.entries(headers).reduce<Record<string, unknown>>((acc, [key, val]) => {
    // Skip prototype-pollution vectors. See FORBIDDEN_OBJECT_KEYS docstring.
    if (FORBIDDEN_OBJECT_KEYS.has(key)) {
      return acc;
    }
    acc[key] = maskHeaderKeys.has(key.toLowerCase()) ? REDACTED : val;
    return acc;
  }, {});
};

/**
 * Returns a header value the package fully owns, so a later `redactEntryPath`
 * write cannot reach the caller's live state.
 *
 * **Rebuilding the header BAG was not enough, and the claim that it was is the
 * bug this closes.** `normalizeHeaders` rebuilds the bag but used to copy each
 * VALUE by reference, while `finalize()`'s post-assembly `redactPaths` pass
 * writes IN PLACE via `redactEntryPath`. So
 * `redactPaths: ["requestHeaders.x-tags.0"]` over
 * `req.headers["x-tags"] = ["TAG-SECRET", "b"]` wrote `"[REDACTED]"` into the
 * RUNNING APPLICATION's live request headers, not merely into the log line —
 * verified. The response side is the same and is worse by Node's own contract:
 * `res.getHeaders()` is documented as returning "a shallow copy of the current
 * outgoing headers… Since a shallow copy is used, array values may be mutated
 * without additional calls to various header-related http module methods" — so
 * the array reached from it is the very array the application handed to
 * `res.setHeader`.
 *
 * `set-cookie` hid this for a long time: it is in
 * {@link DEFAULT_MASKED_HEADER_KEYS}, so `applyHeaderMask` had already swapped
 * the whole array for a string before any path could walk into it. Every
 * array-valued header OUTSIDE that list was exposed.
 *
 * **One level is the whole realistic surface, not a partial fix.** Node types a
 * header value as `string | string[] | number | undefined`, so an array is the
 * only reference-typed shape that reaches here and its elements are strings.
 * **A one-level array copy is NOT enough, because a non-string header value is
 * reachable in plain Node.** Node's docs for `response.setHeader()` state that
 * "non-string values will be stored without modification. Therefore,
 * `response.getHeader()` may return non-string values" — verified: after
 * `res.setHeader("x-meta", live)` with an object, `res.getHeaders()["x-meta"]`
 * IS `live`, the same reference. So `redactPaths: ["responseHeaders.x-meta.a"]`
 * would write into the application's own object. `redactValue`'s `forceCopy`
 * mode exists for exactly this caller ("will mutate the returned value in place
 * afterward and must not risk that mutation landing on a caller-owned object"),
 * so it is reused here rather than hand-rolling a second deep-copy: it owns
 * plain objects, arrays, and class instances at every depth, renders cycles as
 * `"[Circular]"` instead of throwing, and strips `FORBIDDEN_KEYS`.
 *
 * Cost is negligible on the realistic surface: `redactValue` returns any
 * primitive from its first statement, so an ordinary all-string header bag is
 * walk-free, and only a reference-typed value pays for a copy. The mask set is
 * empty here — this call is purely for ownership; keyword masking is
 * `applyHeaderMask`'s job, and it runs afterwards over the owned bag.
 *
 * Boundary: `redactValue` returns `toJSON`-defining values (`Date`), binary
 * views (`Buffer` / typed arrays), and values with no enumerable own keys
 * (`Map`, `Set`, `RegExp`) by identity — its documented rule for values owning
 * no key-addressable *string* secret. Those are therefore still shared with the
 * caller by reference. That sharing is safe ONLY because {@link redactEntryPath}
 * refuses to write into any target that is not an owned plain object or array:
 * a `Buffer`'s writable integer indices and a `RegExp`'s writable `lastIndex`
 * DO pass a bare `hasOwnProperty` + writable-descriptor check, so the earlier
 * claim that "such a value exposes none a path would target" was false — the
 * guarantee is enforced at the write site, not by the shape of these values.
 */
const EMPTY_HEADER_MASK = new Set<string>();

const ownHeaderValue = (value: unknown): unknown =>
  redactValue(value, EMPTY_HEADER_MASK, new WeakSet(), true);

/**
 * Normalizes the header bag for logging. Returns a bag that shares no reference
 * with the caller, one level deep — see {@link ownHeaderValue} for why the
 * value copy (not just the bag rebuild) is load-bearing.
 */
const normalizeHeaders = (
  headers: Record<string, unknown> | undefined,
  include?: boolean | string[],
  maskHeaderKeys?: ReadonlySet<string>,
) => {
  if (!include) {
    return undefined;
  }

  const allowEmpty = include === true;
  const ensureReturn = (record: Record<string, unknown>) => {
    if (Object.keys(record).length > 0) {
      return record;
    }
    return allowEmpty ? {} : undefined;
  };

  if (!headers) {
    return allowEmpty ? {} : undefined;
  }

  const normalized = Object.entries(headers).reduce<Record<string, unknown>>((acc, [key, val]) => {
    // Skip prototype-pollution vectors before normalizing the key. See
    // FORBIDDEN_OBJECT_KEYS docstring.
    if (FORBIDDEN_OBJECT_KEYS.has(key)) {
      return acc;
    }
    // Own the VALUE, not just the key. This single site covers both the
    // `include === true` path and the allow-list path below, because the latter
    // reads out of `normalized`. `applyHeaderMask` deliberately does NOT repeat
    // the copy — it consumes `normalized`, whose values are already owned.
    acc[key.toLowerCase()] = ownHeaderValue(val);
    return acc;
  }, {});

  if (include === true) {
    const masked = applyHeaderMask(normalized, maskHeaderKeys);
    return ensureReturn(masked);
  }

  // By this point `include` is a non-empty `string[]` — `false`/`undefined`
  // were filtered out by `if (!include)` above and `true` returned by the
  // previous block. The static branch `Array.isArray(include) ? … : []` was
  // dead code and has been removed for honest coverage.
  const filtered = include.reduce<Record<string, unknown>>((acc, key) => {
    const normalizedKey = key.toLowerCase();
    // Skip prototype-pollution vectors. See FORBIDDEN_OBJECT_KEYS docstring.
    if (FORBIDDEN_OBJECT_KEYS.has(normalizedKey)) {
      return acc;
    }
    if (normalized[normalizedKey] !== undefined) {
      acc[normalizedKey] = normalized[normalizedKey];
    }
    return acc;
  }, {});

  return ensureReturn(applyHeaderMask(filtered, maskHeaderKeys));
};

const toNumber = (value: unknown): number | undefined => {
  if (value === undefined || value === null) {
    return undefined;
  }
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : undefined;
};

/**
 * Redacts query-string parameters whose names appear in `maskQueryKeys` from a
 * URL string. Operates directly on the raw query bytes without URL-parsing, so
 * every unmasked byte is preserved exactly: sibling-param encoding (`%20`,
 * `%5B`, `%5D`, `%2B`), the `//host` authority of protocol-relative URLs,
 * scheme and host of absolute URLs, and URL fragments are all left untouched.
 *
 * For each `key=value` pair the key is decoded with `decodeURIComponent` (for
 * case-insensitive comparison); if the lowercased decoded key matches an entry
 * in `maskQueryKeys`, the original raw key bytes are kept and only the value is
 * replaced with the literal `[REDACTED]` sentinel. Pairs without `=` (bare
 * flags) are left as-is. Malformed percent-encoding in a key is silently
 * treated as non-matching so the pair passes through unchanged.
 *
 * Returns the original URL unchanged when:
 * - `maskQueryKeys` is undefined or empty.
 * - The URL has no query component.
 * - No masked key is found.
 * We never throw on any input — logging must be best-effort and never the
 * cause of a request failure.
 */
const redactUrlQuery = (url: string, maskQueryKeys: ReadonlySet<string> | undefined): string => {
  if (!maskQueryKeys || maskQueryKeys.size === 0 || !url) {
    return url;
  }
  if (!url.includes("?")) {
    return url;
  }

  // Peel off the fragment (everything from the first `#`). It is re-appended
  // verbatim after the query portion is edited.
  const hashIdx = url.indexOf("#");
  const fragment = hashIdx === -1 ? "" : url.slice(hashIdx);
  const beforeFragment = hashIdx === -1 ? url : url.slice(0, hashIdx);

  // Split the pre-fragment part on the first `?`.
  const qIdx = beforeFragment.indexOf("?");
  if (qIdx === -1) {
    // The whole-URL `?` check above matched, but that `?` lives inside the
    // fragment (e.g. "token=secret#?x") — the fragment-free prefix has no
    // `?` of its own, so there is no real query component to redact. Without
    // this guard, `slice(0, -1)`/`slice(0)` below would drop the prefix's
    // last character and re-parse the whole prefix as a bogus query string.
    // Returning verbatim keeps this in agreement with the documented "no
    // query component" contract.
    return url;
  }
  const base = beforeFragment.slice(0, qIdx);
  const rawQuery = beforeFragment.slice(qIdx + 1);

  let mutated = false;
  const editedParts = rawQuery.split("&").map((pair) => {
    const eqIdx = pair.indexOf("=");
    if (eqIdx === -1) {
      // Bare flag param (no `=`) — leave untouched.
      return pair;
    }
    const rawKey = pair.slice(0, eqIdx);
    try {
      const decodedKey = decodeURIComponent(rawKey).toLowerCase();
      if (maskQueryKeys.has(decodedKey)) {
        mutated = true;
        return `${rawKey}=${REDACTED}`;
      }
    } catch {
      // Malformed percent-encoding in the key — treat as non-matching.
    }
    return pair;
  });

  if (!mutated) {
    return url;
  }

  return `${base}?${editedParts.join("&")}${fragment}`;
};

/**
 * Resolves the URL for `finalize()`'s error-path fallback message, with query
 * secrets masked exactly as the happy path masks them.
 *
 * Two properties are load-bearing:
 *
 * 1. **It redacts.** The fallback message is written to `console.error`, so
 *    building it from the raw `req.originalUrl` leaked precisely the
 *    query-string secrets `maskQueryKeys` promises to mask — a throwing
 *    `enrich` / `messageBuilder` / `logger.log` printed
 *    `?code=SUPER_SECRET_AUTH_CODE` to stderr in cleartext even though `code`
 *    is in {@link DEFAULT_MASKED_QUERY_KEYS}.
 * 2. **It degrades rather than throws.** The catch runs inside the `res`
 *    `"finish"` / `"close"` emitter, where an exception is an UNCAUGHT
 *    exception. Every value read here is caller-controlled (an exotic request
 *    adapter can expose a throwing `originalUrl` getter, or a non-string url
 *    that `redactUrlQuery` would choke on), so the resolution is self-guarded
 *    and degrades to `""` — leaving the method and the failure reason still
 *    reportable, which a guard around the whole message would not.
 *
 * The value is RECOMPUTED here rather than hoisted out of `finalize()`'s try
 * block. Both work — hoisting *this* (already guarded) call above the try would
 * be safe too — but recompute keeps the happy path byte-identical and pays
 * nothing per request for a value only the error path ever reads. What does NOT
 * work is hoisting a `let` that the try block assigns: a function-form `level`
 * throws before the URL is resolved, so at that throw position the value does
 * not exist yet and the message would lose the URL entirely (pinned by test).
 * `redactUrlQuery` is pure, so recomputing re-reads only `req.originalUrl` /
 * `req.url` — for any ordinary request object, the same value the entry carried.
 *
 * Boundary: this masks query secrets, which is what `maskQueryKeys` governs. A
 * `redactPaths` entry targeting `url` itself (e.g. to suppress a path segment
 * like `/users/<ssn>`) is NOT honored here, because this resolves from `req` and
 * never consults `entry.url`: the entry is block-scoped to the try, and for a
 * throw from `enrich` or a function-form `level` it does not exist yet at all.
 * (For a later throw — `messageBuilder`, `logger.log` — it does exist with `url`
 * already redacted, but reaching it would mean hoisting the entry out of the
 * try, beyond this helper's query-secret mandate.) So a path segment the
 * happy-path line redacts can still appear in the error-path message.
 */
const safeRedactedUrl = (
  req: LoggableRequest,
  maskQueryKeys: ReadonlySet<string> | undefined,
): string => {
  try {
    return redactUrlQuery(req.originalUrl ?? req.url ?? "", maskQueryKeys);
  } catch {
    return "";
  }
};

/**
 * Surgically redacts a value at the supplied dot-notation path on the entry
 * object. Missing intermediate keys are a no-op (we never create new sub-paths
 * just to write `[REDACTED]`). Mutates the passed object in place — callers
 * should construct the entry first and then apply path redaction once.
 *
 * Path examples:
 * - `body.user.password` → `entry.requestBody.user.password = "[REDACTED]"`
 *   (the leading `body` is rewritten to `requestBody` to match the public
 *   field name on `RequestLogEntry`).
 * - `requestBody.user.password` is also accepted as the explicit form.
 * - `context.user.token` → `entry.context.user.token = "[REDACTED]"`.
 *
 * The final assignment is **best-effort and never throws**: an array `length`
 * target, a getter-only / accessor property, a non-writable (frozen) slot, or
 * any other value whose write would raise (a `Proxy` with a throwing `set`
 * trap) is skipped rather than allowed to propagate. This is load-bearing —
 * `finalize()` applies these paths inside the same try block that assembles the
 * whole entry, so a throwing redaction would otherwise drop the ENTIRE log line
 * (method, url, status included) over one path. Callers that must guarantee the
 * caller's own object is never mutated by these in-place writes should pass a
 * fully-owned copy of the target sub-graph (as `finalize()` does for
 * `entry.context` and `serializeBody()` does for `entry.requestBody`).
 */
const redactEntryPath = (entry: Record<string, unknown>, path: string): void => {
  if (!path) {
    return;
  }
  const segments = path.split(".").filter(Boolean);
  if (segments.length === 0) {
    return;
  }
  // Prototype-pollution guard, part 1 — INTERMEDIATE segments. A path like
  // `body.__proto__.toString` would otherwise walk
  // `cursor[segments[i]]` into `Object.prototype` and then assign on the
  // (legitimate) final segment, mutating the global prototype. The deny-list
  // mirrors the FORBIDDEN_OBJECT_KEYS set used by the header accumulators and
  // the `redactValue` rebuild — single source of truth for prototype-pollution
  // hardening across the package. (Part 2, the final-segment check, lives
  // just above the assignment below.)
  for (let i = 0; i < segments.length - 1; i += 1) {
    if (FORBIDDEN_OBJECT_KEYS.has(segments[i])) {
      return;
    }
  }
  // Map the user-facing `body` alias to the on-entry `requestBody` field.
  if (segments[0] === "body") {
    segments[0] = "requestBody";
  }

  let cursor: unknown = entry;
  for (let i = 0; i < segments.length - 1; i += 1) {
    if (!cursor || typeof cursor !== "object") {
      return;
    }
    cursor = (cursor as Record<string, unknown>)[segments[i]];
  }
  if (!cursor || typeof cursor !== "object") {
    return;
  }
  const finalKey = segments[segments.length - 1];
  // Prototype-pollution guard, part 2 — FINAL segment. Blocks an assignment
  // of the form `target.__proto__ = "[REDACTED]"` (which would invoke the
  // setter and clobber `target`'s prototype chain). This guard runs BEFORE
  // the `hasOwnProperty` filter so CodeQL's taint flow for
  // `js/prototype-polluting-assignment` (CWE-1321) can statically prove the
  // assignment cannot reach a prototype slot.
  if (FORBIDDEN_OBJECT_KEYS.has(finalKey)) {
    return;
  }
  const target = cursor as Record<string, unknown>;
  if (!Object.prototype.hasOwnProperty.call(target, finalKey)) {
    return;
  }
  // Never overwrite an array's `length`. `hasOwnProperty(arr, "length")` is
  // `true`, but assigning a non-numeric value throws
  // `RangeError: Invalid array length`; without this guard
  // `redactPaths:["body.tags.length"]` would throw and `finalize()`'s catch
  // would drop the ENTIRE log entry over a single path.
  if (Array.isArray(target) && finalKey === "length") {
    return;
  }
  // Only ever write into a container the package FULLY OWNS: a plain object
  // (produced by the `ownContext` / `serializeBody` JSON round-trips or the
  // `normalizeHeaders` bag rebuild) or an array (an owned header/body array).
  // Every other reachable target is a value that `redactValue` handed back BY
  // IDENTITY — a `Date`, a `Buffer` / typed-array, a `RegExp`, a bare `Error`,
  // a `Map` / `Set` — i.e. STILL SHARED with the caller. Those are pass-through
  // precisely because they own no key-addressable *string* secret, but that is
  // not the same as owning no writable own key a numeric/reserved path could
  // hit: a binary view exposes writable integer-index data properties
  // (`Object.keys(Buffer.from([1,2,3]))` → `["0","1","2"]`) and a `RegExp` a
  // writable `lastIndex`, both of which pass the `hasOwnProperty` + writable-
  // descriptor guards below. Without this check
  // `redactPaths:["responseHeaders.x-buf.0"]` over a `Buffer`-valued response
  // header — reachable in plain Node, since `res.setHeader` stores non-string
  // values unmodified and `res.getHeaders()` hands the same reference back —
  // would coerce and zero a byte of the application's LIVE Buffer, the exact
  // caller-mutation `ownHeaderValue` exists to prevent. Restricting the write
  // to owned plain containers closes that whole class centrally and excludes
  // nothing legitimate: every value the package owns for redaction (after the
  // round-trips and the `forceCopy` header rebuild) is a plain object or an
  // array, never one of these pass-through built-ins. (`redactValue` rebuilds
  // every plain object into a fresh `{}` with `Object.prototype`, even an
  // `Object.create(null)` input, so a null-prototype target is unreachable here
  // and is not admitted — that keeps the guard's branches exactly the reachable
  // ones: array, `Object.prototype`, or skip.)
  if (!Array.isArray(target) && Object.getPrototypeOf(target) !== Object.prototype) {
    return;
  }
  // Only overwrite a writable data property. A frozen target
  // (`writable === false`), a getter-only / accessor property (`get` / `set`),
  // or any other non-assignable slot cannot be written — in strict mode the
  // assignment throws, and that throw would propagate to `finalize()`'s catch
  // and drop the whole entry. Logging is best-effort, so a redaction that
  // cannot be applied degrades to a no-op on that path instead.
  const descriptor = Object.getOwnPropertyDescriptor(target, finalKey);
  if (!descriptor || descriptor.get || descriptor.set || descriptor.writable === false) {
    return;
  }
  // Defense-in-depth: even a writable data property can throw on assignment
  // (an exotic host object, or a `Proxy` with a throwing `set` trap). A failed
  // redaction must never take the log line down with it.
  try {
    target[finalKey] = REDACTED;
  } catch {
    // best-effort: leave the value in place rather than dropping the entry
  }
};

/**
 * Resolves the `maskHeaderKeys` option (default | array | false) to a
 * lowercased `Set<string>` for fast membership checks, or `undefined` when
 * masking is disabled.
 */
const resolveMaskHeaderKeys = (
  option: string[] | false | undefined,
): ReadonlySet<string> | undefined => {
  if (option === false) {
    return undefined;
  }
  const list = option ?? DEFAULT_MASKED_HEADER_KEYS;
  return new Set(list.map((key) => key.toLowerCase()));
};

/**
 * Resolves the `maskQueryKeys` option (default | array | false) to a
 * lowercased `Set<string>` for fast membership checks, or `undefined` when
 * masking is disabled.
 */
const resolveMaskQueryKeys = (
  option: string[] | false | undefined,
): ReadonlySet<string> | undefined => {
  if (option === false) {
    return undefined;
  }
  const list = option ?? DEFAULT_MASKED_QUERY_KEYS;
  return new Set(list.map((key) => key.toLowerCase()));
};

const buildDefaultMessage = (entry: RequestLogEntry) => {
  const base = `${entry.method} ${entry.url}`;
  return `${base} ${entry.statusCode} ${entry.responseTimeMs.toFixed(2)}ms (${entry.event})`;
};

const resolveEnvValue = (sources: string[]): string | undefined => {
  for (const source of sources) {
    const value = process.env[source];
    if (typeof value === "string" && value.trim().length > 0) {
      return value;
    }
  }
  return undefined;
};

const matchesEnvRules = (sources: string[], allow: string[], fallback: boolean): boolean => {
  const current = resolveEnvValue(sources);
  if (!current) {
    return fallback;
  }
  const normalized = current.toLowerCase();
  const allowed = allow.map((entry) => entry.toLowerCase());
  return allowed.includes(normalized);
};

const shouldLogForEnvironment = (mode: RequestLoggingMode | undefined): boolean => {
  const selected = mode ?? "always";
  if (selected === "always") {
    return true;
  }
  if (selected === "never") {
    return false;
  }
  if (selected === "dev-only") {
    return matchesEnvRules(DEFAULT_ENV_SOURCES, DEFAULT_DEV_VALUES, false);
  }
  if (selected === "prod-only") {
    return matchesEnvRules(DEFAULT_ENV_SOURCES, DEFAULT_PROD_VALUES, false);
  }
  if (selected === "test-only") {
    return matchesEnvRules(DEFAULT_ENV_SOURCES, DEFAULT_TEST_VALUES, false);
  }

  const sources =
    Array.isArray(selected.sources) && selected.sources.length > 0
      ? selected.sources
      : DEFAULT_ENV_SOURCES;
  const allow =
    Array.isArray(selected.allow) && selected.allow.length > 0
      ? selected.allow
      : DEFAULT_DEV_VALUES;
  const fallback = selected.fallback ?? false;
  return matchesEnvRules(sources, allow, fallback);
};

/**
 * Creates a framework-agnostic HTTP request/response logging middleware that
 * works with Express, raw Node `http`/`https` servers, and any other adapter
 * exposing the {@link LoggableRequest} / {@link LoggableResponse} surface.
 *
 * The returned middleware logs structured request/response payloads using the
 * configured Winston logger (or an auto-created scoped logger when none is
 * provided).
 *
 * @example
 * ```ts
 * import express from "express";
 * import { createLogger, createRequestLogger } from "@hiprax/logger";
 *
 * const app = express();
 * const logger = createLogger({ moduleName: "api", level: "http" });
 *
 * app.use(
 *   createRequestLogger({
 *     logger,
 *     includeRequestHeaders: true,
 *     includeRequestBody: true,
 *     maskBodyKeys: ["password", "token"],
 *     includeHttpContext: true,
 *   }),
 * );
 *
 * app.post("/auth/login", (_req, res) => res.json({ ok: true }));
 * ```
 */
export const createRequestLogger = (options: RequestLoggerOptions = {}): LoggableMiddleware => {
  // Validate option shapes UP FRONT so misconfiguration surfaces synchronously
  // at middleware-creation time (not on the first request). Validation runs
  // BEFORE the `loggingEnabled` / `loggingMode` short-circuit so a misconfigured
  // mask is reported even when the resulting middleware is a pass-through.
  validateRequestLevelOption(options.level);
  validateMaskKeysOption("maskBodyKeys", options.maskBodyKeys, false);
  validateMaskKeysOption("maskHeaderKeys", options.maskHeaderKeys, true);
  validateMaskKeysOption("maskQueryKeys", options.maskQueryKeys, true);
  validateMaskKeysOption("redactPaths", options.redactPaths, false);
  validateMaxBodyLength(options.maxBodyLength);

  const { loggingEnabled = true, loggingMode } = options;
  const envAllowsLogging = shouldLogForEnvironment(loggingMode);

  if (!loggingEnabled || !envAllowsLogging) {
    return (_req: LoggableRequest, _res: LoggableResponse, next: LoggableNext) => next();
  }

  const {
    logger = createLogger({
      moduleName: options.label ? `http/${options.label}` : "http",
    }),
    level,
    messageBuilder = buildDefaultMessage,
    skip,
    enrich,
    includeRequestHeaders,
    includeResponseHeaders,
    includeRequestBody,
    maxBodyLength = DEFAULT_BODY_LIMIT,
    maskBodyKeys,
    maskHeaderKeys,
    maskQueryKeys,
    redactPaths,
    includeHttpContext = false,
  } = options;

  // Pre-resolve the mask sets once at middleware construction time so the
  // per-request hot path only does Set lookups rather than re-allocating
  // arrays/sets for every request.
  const headerMaskSet = resolveMaskHeaderKeys(maskHeaderKeys);
  const queryMaskSet = resolveMaskQueryKeys(maskQueryKeys);
  // Pre-resolve the body mask set alongside headerMaskSet/queryMaskSet.
  // An undefined or empty maskBodyKeys collapses to undefined so serializeBody
  // builds an empty Set only on the internal (array-based) test path.
  const bodyMaskSet: ReadonlySet<string> | undefined =
    Array.isArray(maskBodyKeys) && maskBodyKeys.length > 0
      ? new Set(maskBodyKeys.map((key) => key.toLowerCase()))
      : undefined;
  const resolvedRedactPaths = Array.isArray(redactPaths) ? redactPaths : [];

  return (req: LoggableRequest, res: LoggableResponse, next: LoggableNext) => {
    if (skip?.(req, res)) {
      return next();
    }

    // Honor an externally-provided start timestamp set by an earlier
    // instrumentation hook (e.g. the very first piece of middleware on the
    // stack). The override MUST be a `bigint` produced by
    // `process.hrtime.bigint()`; any other type is silently ignored to avoid
    // crashing the request on accidental misuse. The symbol is read with a
    // typed cast so we do not have to widen `LoggableRequest` to allow
    // arbitrary keys.
    const externalStart = (req as unknown as Record<symbol, unknown>)[REQUEST_START_SYMBOL];
    const start = typeof externalStart === "bigint" ? externalStart : process.hrtime.bigint();

    // Snapshot `req.body` at middleware ENTRY time so handler-time mutation
    // (e.g. `req.body = { redacted: true }`) does not change what gets logged.
    // We take a SHALLOW reference rather than a deep clone: deep cloning every
    // body for every request is a meaningful per-request cost, and the common
    // case is whole-pointer reassignment of `req.body`, which a shallow
    // reference already isolates against. Consumers who mutate properties
    // INSIDE the body object should redact those keys via `maskBodyKeys` /
    // `redactPaths` instead. `structuredClone` is not used by default for the
    // same reason — it is opt-in via user code if they truly need it.
    const bodySnapshot: unknown = includeRequestBody ? req.body : undefined;

    const finalize = (event: RequestLogEvent) => {
      // No double-fire guard required: `removeListener` is called below for
      // both events, AND `res.once(...)` is intrinsically one-shot. The
      // previous defensive `if (handled) return;` block was dead code and has
      // been removed for honest coverage.
      res.removeListener("finish", finishHandler);
      res.removeListener("close", closeHandler);

      try {
        const durationNs = Number(process.hrtime.bigint() - start);
        const durationMs = durationNs / 1_000_000;

        const statusCode = res.statusCode ?? 0;
        const candidateLevel =
          typeof level === "function" ? level(statusCode) : (level ?? determineLevel(statusCode));
        const resolvedLevel: LogLevel = isValidLogLevel(candidateLevel)
          ? candidateLevel
          : determineLevel(statusCode);

        const headerOrUndefined = (name: string): string | undefined => {
          const raw = req.headers[name];
          if (Array.isArray(raw)) {
            return raw.join(", ");
          }
          return typeof raw === "string" ? raw : undefined;
        };

        const lookupHeader = (name: string): string | undefined => {
          if (typeof req.get === "function") {
            // `req.get(name) ?? undefined` collapses an explicit `null` return
            // (some Express subclasses) to `undefined` so the `RequestLogEntry`
            // optional-string contract is preserved.
            return req.get(name) ?? undefined;
          }
          return headerOrUndefined(name);
        };

        const responseHeaders = res.getHeaders ? res.getHeaders() : undefined;

        // Resolve and redact the URL we will log. We prefer `originalUrl` (Express
        // semantics) and fall back to `url` (raw Node). URL redaction strips
        // sensitive query params (token/key/secret/etc.) per `maskQueryKeys`.
        const sourceUrl = req.originalUrl ?? req.url ?? "";
        const loggedUrl = redactUrlQuery(sourceUrl, queryMaskSet);

        // Capture transport-level lifecycle flags BEFORE refining the event.
        // `responseWritableEnded` indicates whether the response body was fully
        // written; combined with the raised `event === "close"` it lets us
        // distinguish a true client abort from a benign post-finish close.
        // `responseDestroyed` mirrors socket.destroyed for diagnostic context.
        // `requestAborted` is reported when the request adapter exposes it.
        const responseWritableEnded =
          typeof res.writableEnded === "boolean" ? res.writableEnded : undefined;
        const responseDestroyed = typeof res.destroyed === "boolean" ? res.destroyed : undefined;
        const requestAborted = typeof req.aborted === "boolean" ? req.aborted : undefined;

        // Refined classification: a `close` event is a true abort ONLY when the
        // response body was NOT fully written (`!res.writableEnded`). A `close`
        // after a normal `finish` (HTTP/1 keep-alive socket teardown, HTTP/2
        // stream end) sets `writableEnded === true` and is benign — it is
        // logged as `"completed"`. Adapters that do not surface
        // `writableEnded` (raw mocks, custom transports) treat the close as a
        // true abort to preserve the previous behavior.
        const refinedEvent: RequestLogEvent =
          event === "aborted" && !responseWritableEnded ? "aborted" : "completed";

        const entry: RequestLogEntry = {
          event: refinedEvent,
          method: req.method ?? "GET",
          url: loggedUrl,
          statusCode,
          responseTimeMs: Number(durationMs.toFixed(2)),
          // The RESPONSE's declared byte count only. This is a response-side
          // field (it sits alongside `statusCode` / `responseTimeMs`, all
          // computed at finalize time), so it must never fall back to the
          // request's `Content-Length`: a chunked/streamed response carries no
          // `Content-Length`, and reporting the uploaded request-body size there
          // mislabels egress (a 5000-byte upload answered by a 2-byte chunked
          // reply would log 5000) and would report bytes never sent on an abort.
          // `toNumber` yields `undefined` for a missing/non-finite header, which
          // is the honest value for a chunked/streamed/aborted response.
          contentLength: toNumber(res.getHeader("content-length")),
          ip: req.ip ?? req.socket?.remoteAddress ?? undefined,
          userAgent: lookupHeader("user-agent"),
          requestId: lookupHeader("x-request-id"),
        };

        if (responseWritableEnded !== undefined) {
          entry.responseWritableEnded = responseWritableEnded;
        }
        if (responseDestroyed !== undefined) {
          entry.responseDestroyed = responseDestroyed;
        }
        if (requestAborted !== undefined) {
          entry.requestAborted = requestAborted;
        }

        if (includeRequestBody) {
          // Use the body snapshot taken at middleware entry — see the comment on
          // `bodySnapshot` above for why we do not deep-clone by default.
          // Pass the pre-resolved Set (built once at construction time) instead
          // of the raw array so this hot path allocates no new Set per request.
          // Also pass `resolvedRedactPaths` so body-scoped paths are applied to
          // the object graph BEFORE any over-limit truncation collapses it into
          // the `_preview` envelope (see the comment inside `serializeBody`).
          // Serializing the body is the only step here that runs over
          // arbitrary caller-supplied data of arbitrary shape, so it is the
          // only step whose failure is plausible — a metadata getter throwing,
          // a hostile `toJSON`, a payload no serializer can express. Its
          // failure must not be allowed to reach the outer catch, which would
          // discard the ENTIRE entry: the method, url, status, and duration are
          // all already computed and never touched the body, so dropping them
          // over a body problem loses the record of a request that did happen.
          // (That was a cheap way to make a request structurally invisible in
          // the HTTP log — post a body the serializer chokes on.) Degrade the
          // body to a sentinel; log everything else.
          try {
            entry.requestBody = serializeBody(
              bodySnapshot,
              bodyMaskSet,
              maxBodyLength,
              resolvedRedactPaths,
            );
          } catch {
            entry.requestBody = UNSERIALIZABLE_BODY;
          }
        }

        entry.requestHeaders = normalizeHeaders(
          req.headers as Record<string, unknown>,
          includeRequestHeaders,
          headerMaskSet,
        );
        entry.responseHeaders = normalizeHeaders(
          responseHeaders as Record<string, unknown> | undefined,
          includeResponseHeaders,
          headerMaskSet,
        );

        if (enrich) {
          // `enrich(...) ?? undefined` collapses a `null` or `undefined` return
          // value to `undefined` so `entry.context` is never set to `null`.
          // `ownContext` then takes a fully-owned copy (see its doc): the
          // post-assembly `redactPaths` loop writes in place, so `entry.context`
          // must never be the object `enrich()` returned BY IDENTITY, or
          // `redactPaths:["context.token"]` would overwrite the caller's live
          // `req.session` / `req.user` in the running app.
          const enriched = enrich(req, res, durationMs) ?? undefined;
          entry.context = enriched === undefined ? undefined : ownContext(enriched);
        }

        // Surgical path-based redaction. Body-scoped paths (`body.*` /
        // `requestBody.*`) were ALREADY applied inside `serializeBody` above,
        // before any over-limit truncation could collapse the body into the
        // `{ _truncated, _originalLength, _preview }` envelope — re-applying
        // them here is a harmless idempotent no-op. This pass remains the ONLY
        // place `context.*` / `requestHeaders.*` / `responseHeaders.*` paths
        // are redacted, and it still runs LAST so it can override anything
        // that survived the keyword-based body/header masks. Every sub-graph it
        // writes into is package-owned:
        //   - `entry.requestBody` — `serializeBody` applies body paths on a
        //     `JSON.parse(JSON.stringify(...))` copy, and its guard is the SAME
        //     predicate as this loop's (`redactPaths` non-empty), so the
        //     round-trip has always run whenever this loop can write at all.
        //   - `entry.requestHeaders` / `entry.responseHeaders` —
        //     `normalizeHeaders` rebuilds the bag AND copies each value via
        //     `ownHeaderValue`. The bag rebuild alone was NOT enough, and the
        //     previous claim here that it was is the bug that fix closed:
        //     header values were shared by reference, so
        //     `redactPaths: ["requestHeaders.x-tags.0"]` wrote into the
        //     caller's live `req.headers` array, and Node documents
        //     `res.getHeaders()` as a shallow copy whose array values are the
        //     app's own arrays.
        //   - `entry.context` — `ownContext`'s round-trip copy.
        // So `redactEntryPath`'s in-place writes cannot reach the caller's live
        // objects. Missing intermediate segments, non-writable slots, and array
        // `length` targets are all graceful no-ops. BOUNDARY: `ownHeaderValue`
        // owns plain objects, arrays, and class instances at every depth, but
        // leaves `Date` / `Buffer` / `RegExp` / `Map`-shaped values shared by
        // identity — `redactValue`'s own rule for values owning no key-
        // addressable string secret. That is safe because `redactEntryPath`
        // writes ONLY into an owned plain object or array and refuses every
        // other target, so a path aimed at a shared `Buffer`'s writable integer
        // index (or a `RegExp`'s `lastIndex`) is a no-op instead of a write into
        // the caller's live value.
        if (resolvedRedactPaths.length > 0) {
          resolvedRedactPaths.forEach((path) =>
            redactEntryPath(entry as unknown as Record<string, unknown>, path),
          );
        }

        const message = messageBuilder(entry);

        const logEntry: winston.LogEntry & { http?: RequestLogEntry } = {
          level: resolvedLevel,
          message,
        };

        if (includeHttpContext) {
          logEntry.http = entry;
        }

        logger.log(logEntry);
      } catch (err) {
        // This handler runs inside the `res` "finish" / "close" emitter, where a
        // throw is an UNCAUGHT exception — it would escalate a dropped log line
        // into a crashed process. Every value read here is caller-controlled: an
        // exotic request adapter can expose throwing `method` / `originalUrl`
        // getters, and a custom `Error` subclass can expose a throwing `message`
        // getter (or be a value whose `String()` conversion throws). So the whole
        // assembly is guarded, with a last-resort message that reads nothing.
        try {
          const method = req.method ?? "GET";
          // Never build this message from the raw URL: it goes to `console.error`,
          // so an unredacted query string leaks the very secrets `maskQueryKeys`
          // masks on the happy path. `safeRedactedUrl` degrades the URL alone, so
          // a hostile url getter still leaves the method and reason reportable.
          const reqUrl = safeRedactedUrl(req, queryMaskSet);
          const reason = err instanceof Error ? err.message : String(err);
          console.error(
            `@hiprax/logger request logger failed while logging ${method} ${reqUrl}: ${reason}`,
          );
        } catch {
          console.error("@hiprax/logger request logger failed, and so did reporting the failure.");
        }
      }
    };

    const finishHandler = () => finalize("completed");
    const closeHandler = () => finalize("aborted");

    res.once("finish", finishHandler);
    res.once("close", closeHandler);

    return next();
  };
};

/** @internal */
export const __requestInternals = {
  determineLevel,
  redactValue,
  serializeBody,
  normalizeHeaders,
  applyHeaderMask,
  toNumber,
  buildDefaultMessage,
  shouldLogForEnvironment,
  truncateString,
  buildTruncatedEnvelope,
  redactUrlQuery,
  safeRedactedUrl,
  redactEntryPath,
  resolveMaskHeaderKeys,
  resolveMaskQueryKeys,
  validateRequestLevelOption,
  validateMaskKeysOption,
  validateMaxBodyLength,
  isValidLogLevel,
  VALID_LOG_LEVELS,
  DEFAULT_MASKED_HEADER_KEYS,
  DEFAULT_MASKED_QUERY_KEYS,
};
