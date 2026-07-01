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
  if (value.length <= maxLength) {
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
  // post-assembly loop in `finalize()`. A non-JSON-serializable body (e.g. one
  // carrying a `BigInt`) throws in `JSON.stringify`; the catch leaves `masked`
  // as the keyword-masked graph so the `String()` fallback below still runs.
  if (bodyRedactPaths && bodyRedactPaths.length > 0 && masked && typeof masked === "object") {
    try {
      const owned: unknown = JSON.parse(JSON.stringify(masked));
      const wrapper: Record<string, unknown> = { requestBody: owned };
      for (const path of bodyRedactPaths) {
        redactEntryPath(wrapper, path);
      }
      masked = wrapper.requestBody;
    } catch {
      // Body is not JSON-serializable (e.g. a `BigInt` value) — leave `masked`
      // as the keyword-masked graph; the `String()` fallback below handles it.
    }
  }

  if (typeof masked === "string") {
    return truncateString(masked, maxLength);
  }

  try {
    const serialized = JSON.stringify(masked);
    if (serialized.length > maxLength) {
      return buildTruncatedEnvelope(serialized, maxLength);
    }
    return masked;
  } catch {
    const fallback = String(masked);
    return truncateString(fallback, maxLength);
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
    acc[key.toLowerCase()] = val;
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
  target[finalKey] = REDACTED;
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

    const initialContentLength = toNumber(req.headers["content-length"]);

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
          contentLength: toNumber(res.getHeader("content-length")) ?? initialContentLength,
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
          entry.requestBody = serializeBody(
            bodySnapshot,
            bodyMaskSet,
            maxBodyLength,
            resolvedRedactPaths,
          );
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
          entry.context = enrich(req, res, durationMs) ?? undefined;
        }

        // Surgical path-based redaction. Body-scoped paths (`body.*` /
        // `requestBody.*`) were ALREADY applied inside `serializeBody` above,
        // before any over-limit truncation could collapse the body into the
        // `{ _truncated, _originalLength, _preview }` envelope — re-applying
        // them here is a harmless idempotent no-op. This pass remains the ONLY
        // place `context.*` / `requestHeaders.*` / `responseHeaders.*` paths
        // are redacted, and it still runs LAST so it can override anything
        // that survived the keyword-based body/header masks. Missing
        // intermediate segments are a graceful no-op.
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
        const method = req.method ?? "GET";
        const reqUrl = req.originalUrl ?? req.url ?? "";
        const reason = err instanceof Error ? err.message : String(err);
        console.error(
          `@hiprax/logger request logger failed while logging ${method} ${reqUrl}: ${reason}`,
        );
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
