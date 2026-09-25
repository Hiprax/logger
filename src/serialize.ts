/**
 * Shared JSON-serialization primitives used by BOTH the core logger
 * (`src/logger.ts`, for the pretty-mode `safeStringify` pipeline and the json
 * serializer) and the request-logging middleware (`src/request-middleware.ts`,
 * for `serializeBody` and `ownContext`): `bigintSafeReplacer`, the
 * `Error`-aware replacer built on it, and the stringify-with-fallback helper
 * the caller-data stringify sites go through. Also the structural helpers the
 * redaction walk in `src/redact.ts` shares with them (`FORBIDDEN_KEYS`,
 * `isErrorLike`, `errorToPlain`), so masking and serialization read an `Error`
 * through the SAME view. Lives in its own module, rather than in
 * `src/redact.ts`, because JSON expressibility is a distinct concern from
 * redaction: nothing here decides what is a secret, and `redact.ts`'s contract
 * is entirely about the deep-redaction walk. The consumers therefore share
 * this without importing each other, matching the one-concern-per-module split
 * the rest of `src/` already follows.
 *
 * Dependency direction: this module imports nothing from `src/`. `redact.ts`
 * imports from it (and re-exports `FORBIDDEN_KEYS` so existing imports keep
 * working), never the reverse, so there is no import cycle.
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
 * package that runs over caller data must pass this replacer, directly or
 * through {@link createErrorAwareReplacer}, which delegates every non-Error
 * value to it (see {@link errorAwareStringify}). Where it is
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

/**
 * Property names that must NEVER be assigned through `acc[key] = …` during a
 * rebuild into a fresh object. `__proto__` triggers the prototype setter
 * (corrupts the local object's prototype chain); `constructor` and `prototype`
 * are likewise structural fields whose assignment can break `instanceof`
 * checks and downstream key enumeration. Centralized here so every rebuild in
 * the package (`redactValue` in `redact.ts`, the per-key rebuilds in
 * `logger.ts`, and `errorToPlain` below) shares a single deny-list;
 * `redact.ts` re-exports it.
 */
export const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/**
 * Reports whether `value` is an `Error`, including one created in another
 * realm (a `vm` context, a worker's structured clone target, an iframe), where
 * `instanceof Error` is `false` because each realm has its own `Error`
 * constructor. `Object.prototype.toString` reports `"[object Error]"` for any
 * object carrying the `[[ErrorData]]` internal slot, whatever realm made it,
 * so the two tests together cover same-realm subclasses and cross-realm
 * errors alike.
 *
 * Total: it never throws. Both tests can run caller code (a Proxy's
 * `getPrototypeOf` trap for `instanceof`, a `Symbol.toStringTag` getter for
 * `toString`), and the predicate is called from inside the redaction walk and
 * the serializers, so a throw is answered with `false` (the value is then
 * treated as an ordinary object, exactly as before this predicate existed).
 * A plain object that merely has `name` / `message` keys is NOT error-like.
 */
export const isErrorLike = (value: unknown): value is Error => {
  if (value === null || typeof value !== "object") {
    return false;
  }
  try {
    return value instanceof Error || Object.prototype.toString.call(value) === "[object Error]";
  } catch {
    return false;
  }
};

/** Marks a property read that threw inside `errorToPlain`. */
const UNREADABLE = Symbol("unreadable");

const readProperty = (source: object, key: string): unknown => {
  try {
    return (source as Record<string, unknown>)[key];
  } catch {
    return UNREADABLE;
  }
};

const listOwnEnumerableKeys = (source: object): string[] => {
  try {
    return Object.keys(source);
  } catch {
    return [];
  }
};

const hasOwnProperty = (source: object, key: string): boolean => {
  try {
    return Object.prototype.hasOwnProperty.call(source, key);
  } catch {
    return false;
  }
};

/** Standard `Error` fields, read first (own or inherited) in this fixed order. */
const STANDARD_ERROR_FIELDS = ["name", "message", "stack"] as const;

/** Non-enumerable own slots ES2022 defines on errors: `cause` and `AggregateError`'s `errors`. */
const OWN_ERROR_SLOTS = ["cause", "errors"] as const;

/**
 * Converts an `Error` into a fresh plain object that a serializer or the
 * redaction walk can read by its own enumerable keys. The single converter
 * both consumers share, so a nested `Error` is masked and rendered through
 * the SAME view.
 *
 * Why it is needed: an `Error`'s `message` and `stack` are own
 * NON-enumerable properties, `name` is inherited from the prototype, and the
 * ES2022 `cause` (the `new Error(msg, { cause })` form) and
 * `AggregateError`'s `errors` are own non-enumerable properties too. Every
 * key-based walk (`Object.keys`, `JSON.stringify`, `safe-stable-stringify`)
 * therefore sees none of them, which is why a nested `Error` renders as `{}`.
 *
 * Field order is fixed: `name`, `message`, `stack` (each read through the
 * prototype chain, and omitted when `undefined`), then every own enumerable
 * string key in `Object.keys` order (an `undefined` value is kept, as the
 * walk over any other object keeps it), then `cause` and `errors` when they
 * are OWN properties, enumerable or not. `errors` is gated on being an own
 * property rather than on `instanceof AggregateError`, so a cross-realm
 * `AggregateError` is covered; an enumerable `errors` / `cause` (a
 * validation error's `this.errors = …`) is already listed with the own keys.
 * Each key is read at most once, even when its read threw: an own
 * enumerable `name` (set by `this.name = …` in a subclass constructor) keeps
 * the first slot, and a getter, if any, runs once.
 *
 * Getter-safe and total: every read is guarded, and a throwing accessor
 * (or a Proxy trap) drops ONLY that field. Own keys named in
 * `FORBIDDEN_KEYS` are skipped, so the result is always an
 * `Object.prototype`-prototyped object whose prototype no payload can
 * repoint. Symbol-keyed properties are not included (no serializer emits
 * them). Values are copied by reference: nothing is walked, so a nested
 * `cause` stays an `Error` for the caller (the redaction walk or a
 * serializer's replacer) to convert in turn. The input is never mutated, and
 * the result is never the input.
 */
export const errorToPlain = (err: object): Record<string, unknown> => {
  const plain: Record<string, unknown> = {};
  const attempted = new Set<string>();
  const take = (key: string, keepUndefined: boolean): void => {
    if (FORBIDDEN_KEYS.has(key) || attempted.has(key)) {
      return;
    }
    attempted.add(key);
    const value = readProperty(err, key);
    if (value === UNREADABLE || (value === undefined && !keepUndefined)) {
      return;
    }
    plain[key] = value;
  };
  for (const key of STANDARD_ERROR_FIELDS) {
    take(key, false);
  }
  for (const key of listOwnEnumerableKeys(err)) {
    take(key, true);
  }
  for (const key of OWN_ERROR_SLOTS) {
    if (hasOwnProperty(err, key)) {
      take(key, true);
    }
  }
  return plain;
};

/**
 * Builds a `JSON.stringify` / `safe-stable-stringify` replacer that renders
 * every `Error` it meets (detected with {@link isErrorLike}, so a cross-realm
 * one too) through {@link errorToPlain}, and hands every other value to
 * {@link bigintSafeReplacer}. Without it a nested `Error` serializes as `{}`
 * (its `name`, `message`, `stack`, `cause` and `errors` are all
 * non-enumerable or inherited); the returned view is then serialized like any
 * object, so the replacer runs again on its fields and a `cause` chain or an
 * `AggregateError`'s members are converted in turn. An Error-free payload
 * renders byte-identically to `bigintSafeReplacer` alone.
 *
 * Both serializers call a value's `toJSON` BEFORE the replacer, so an `Error`
 * subclass defining `toJSON` renders its `toJSON` output as before; the
 * conversion applies to that output only when it is itself an Error (an
 * Error subclass whose `toJSON` returns `this` renders its view). The masking
 * walk in `src/redact.ts` reads a `toJSON` output the same way.
 *
 * The conversion is memoized per replacer: the same `Error` always maps to
 * the SAME view object. That is what keeps each serializer's own cycle
 * detection working, because both compare the value the replacer returned
 * against the objects on the current path: a self-referencing `cause` then
 * meets its own view again (`JSON.stringify` throws its circular-structure
 * `TypeError`, `safe-stable-stringify` writes `"[Circular]"`). With a fresh
 * view per visit the walk would stop only at the stack limit, whose
 * `RangeError` the total guards in `isErrorLike` / `errorToPlain` absorb, so it
 * would emit thousands of nested copies instead of failing. The memo lives only
 * as long as one replacer, so build a FRESH one for every stringify call; a
 * shared one would keep a view built from an earlier state of an `Error`.
 */
export const createErrorAwareReplacer = (): ((key: string, value: unknown) => unknown) => {
  let views: WeakMap<object, Record<string, unknown>> | undefined;
  return (key: string, value: unknown): unknown => {
    if (!isErrorLike(value)) {
      return bigintSafeReplacer(key, value);
    }
    if (views === undefined) {
      views = new WeakMap();
    }
    let view = views.get(value);
    if (view === undefined) {
      view = errorToPlain(value);
      views.set(value, view);
    }
    return view;
  };
};

/**
 * `JSON.stringify(value, <fresh error-aware replacer>, space)`, retried as
 * `JSON.stringify(value, bigintSafeReplacer, space)` when that throws. The
 * error-aware pass can fail where the plain one succeeds, because it makes
 * fields visible that were never serialized before: a cycle through a
 * NON-enumerable `cause`, or a throwing getter / `toJSON` inside one. The
 * retry reproduces the exact pre-existing rendering (an `Error` as `{}`), so
 * no value renders worse than it did before nested Errors were converted.
 * A throw from the retry propagates, exactly as the plain call's did, so
 * each caller keeps its own last-resort fallback. An `undefined` result (a
 * function, a symbol, a `toJSON` returning `undefined`) is returned as is
 * and not retried. Cost of the retry: every getter and `toJSON` the first
 * pass reached before it threw runs again in the second, so a stateful one
 * can observe two reads and render its second value.
 */
export const errorAwareStringify = (value: unknown, space?: number): string | undefined => {
  try {
    return JSON.stringify(value, createErrorAwareReplacer(), space);
  } catch {
    return JSON.stringify(value, bigintSafeReplacer, space);
  }
};
