import { FORBIDDEN_KEYS, errorToPlain, isErrorLike } from "./serialize";

/**
 * Shared deep-redaction primitive used by BOTH the core logger (for
 * `LoggerOptions.maskMetaKeys`) and the request-logging middleware (for
 * `RequestLoggerOptions.maskBodyKeys` / `redactPaths`). Lives in its own
 * module so the two consumers do not have to import each other to share the
 * implementation. It imports its structural helpers (`FORBIDDEN_KEYS`,
 * `isErrorLike`, `errorToPlain`) from `src/serialize.ts`, which imports
 * nothing from `src/`, so the dependency runs one way only.
 *
 * Behavior:
 * - Returns primitives unchanged.
 * - Walks arrays, recursing into each element.
 * - For PLAIN objects (created via `{}` / `Object.create(null)`), replaces
 *   values whose key (lowercased) is in `maskKeys` with the literal string
 *   `"[REDACTED]"`. Other values are recursed into. Always returns a fresh
 *   plain object so callers that rely on `out !== input` identity are not
 *   affected (the one exception, an own `toJSON` method under a mask, is
 *   described below).
 * - For NON-PLAIN objects the handling depends on whether the instance
 *   carries key-addressable secrets in its own enumerable fields:
 *   - **Pass-through built-ins** — returned AS-IS (same reference, NOT added
 *     to `seen`) when any of the following is true:
 *     - The value is an `ArrayBuffer` view (typed arrays, `DataView`,
 *       `Buffer`) — data lives in the underlying memory, not in enumerable
 *     own keys. Checked first, so a `Buffer`'s inherited `toJSON` is never
 *     called here.
 *     - The value defines a `toJSON` method and `maskKeys` is EMPTY: there is
 *       nothing to mask, so the serializer resolves it exactly as before and
 *       the walk never calls it.
 *     - The value has zero enumerable own string keys and is not an `Error`
 *       (`Map`, `Set`, `RegExp`, `Promise`) — no key can match.
 *     Not adding these to `seen` means built-ins are never subject to cycle
 *     tracking at all — the same built-in referenced by two keys (e.g.
 *     `{ a: date, b: date }`) has always rendered both occurrences fully.
 *   - **Values that define `toJSON`, under a non-empty mask** (a class DTO,
 *     an HTTP-client error such as axios's, a `moment`, a `Date`, and a plain
 *     object with an own `toJSON` method) — the serializers call `toJSON`
 *     once and print its OUTPUT, so that output is what gets masked. The walk
 *     makes the call itself, once, with the property key the serializer
 *     passes (the optional 6th parameter `key`): on the real instance for a
 *     non-plain value (so a `toJSON` reading `#private` fields works), and on
 *     the masked rebuild for a plain object (the copy the serializer would
 *     call it on, so a field it reads through `this` is already masked). A
 *     primitive result (a `Date`'s ISO string) has no key to mask: the value
 *     is handed back as is (the masked rebuild for a plain object) and the
 *     serializer resolves it again, so such a `toJSON` runs twice (as does
 *     one whose object result the walk hands back unchanged). An object
 *     result is read the way the serializer reads it, by its own keys and
 *     without calling a `toJSON` on the result ({@link redactToJSONOutput}),
 *     and an error-like result through the Error walk below, as the
 *     serializers' Error-aware replacer renders it (an own `toJSON` method of
 *     such an error is left out of the rebuild, as the serializers leave it
 *     out of its view); when that walk hands the
 *     result back unchanged, the value itself is returned so the serializer
 *     makes the same call and reads what the no-mask line reads. A `toJSON`
 *     that throws, or a `toJSON` lookup that throws (a getter, a Proxy trap),
 *     FAILS CLOSED to `REDACTION_FAILED` for that value only; with an empty
 *     mask a throwing lookup reaches the caller as before. While the output is
 *     walked the value stays on the active path, so an output that leads back
 *     to it renders `"[Circular]"`. Before this rule, such values were passed
 *     through by identity even under a mask, so the serializer printed every
 *     masked key of their output, and once nested Errors rendered their
 *     `cause` / `errors`, a value such as an axios error wrapped as a `cause`
 *     printed its request headers under a mask that listed them.
 *   - **Errors** (`isErrorLike`: same-realm, subclass, or cross-realm; checked
 *     AFTER the binary-view and `toJSON` rules above, so an `Error` subclass
 *     with its own `toJSON` is rendered by that method and a rebuild never
 *     exposes the fields its `toJSON` hides) — data-bearing even with zero enumerable
 *     keys. The walk reads the `errorToPlain` view (`src/serialize.ts`, the
 *     same converter the serializers use): `name`, `message`, `stack`, every
 *     own enumerable property, and the non-enumerable own `cause` /
 *     `AggregateError` `errors`. Masked keys become `"[REDACTED]"`; every
 *     other field recurses, so masking reaches the whole `cause` chain and
 *     every `AggregateError` member BEFORE any serializer makes them visible.
 *     A throw while walking one field (a throwing getter inside a `cause`)
 *     replaces THAT field with `REDACTION_FAILED` and counts as a change;
 *     the rest of the value still renders. Those subtrees were invisible
 *     before, so failing the whole value there would render a line worse
 *     than it rendered before the walk reached them.
 *     Returns the original **by identity** when nothing changed (every view
 *     field is a primitive or came back by identity, and no own enumerable
 *     key was left out of the view); otherwise (or under `forceCopy`) a fresh
 *     plain object in the view's field order, so `name` / `message` /
 *     `stack` survive the rebuild. An own enumerable key missing from the
 *     view (a `FORBIDDEN_KEYS` name, or an accessor that threw) counts as a
 *     change: returning the original would let the serializer read that
 *     accessor again. Because arrays and plain objects always rebuild, an
 *     `AggregateError`, or an `Error` whose `cause` / own field is a plain
 *     object or array, comes back rebuilt even with nothing to mask (same
 *     view, owned copy), and a self-referencing `cause` renders
 *     `"[Circular]"`.
 *   - **Data-bearing instances** (class DTOs) — walked via their own
 *     enumerable string keys. Keys
 *     whose lowercased form is in `maskKeys` are replaced with `"[REDACTED]"`;
 *     others are recursed into. Returns the **original by identity** when
 *     nothing changed (no key matched and every recursed child is `===` its
 *     original). Returns a fresh **plain** object only when a redaction
 *     actually occurred; downstream is always JSON serialization, so a plain
 *     rebuild is output-equivalent. The optional 4th parameter `forceCopy`
 *     (default `false`) overrides this identity-preserving return for this
 *     branch only: when `true`, a data-bearing instance is always rebuilt
 *     into a fresh plain object, even when nothing on it changed. Threaded
 *     through every recursive call so nested class instances at any depth are
 *     covered too; plain objects and arrays are unaffected since they already
 *     always rebuild. It is a general-purpose deep-copy option for callers
 *     that will mutate the returned value in place afterward and must not risk
 *     that mutation landing on a caller-owned object that `maskKeys` alone
 *     left untouched. (Note: `request-middleware.ts`'s `serializeBody` does
 *     NOT rely on this for `redactPaths`; it applies paths on a
 *     `toJSON`-resolved `JSON.parse(JSON.stringify(...))` copy instead, which
 *     is both mutation-safe and renders built-ins via their `toJSON()`.)
 * - **Cycle detection is active-path tracking, not all-visited tracking.**
 *   The per-call `WeakSet` (`seen`) records only the objects on the CURRENT
 *   recursion path: the array, plain-object, Error, data-bearing-instance and
 *   `toJSON` branches each add their `value` to `seen` on entry and remove it again in
 *   a `finally` on the way out, once that value's own subtree has finished
 *   processing, so the entry is removed even when the subtree throws (a
 *   caught throw, such as the Error walk's per-field one, never leaves a stale
 *   entry that would misreport a later reference as `"[Circular]"`).
 *   Consequences:
 *   - A value that is its own ancestor on the active path — a true
 *     self-cycle (`obj.self = obj`) or an indirect/mutual cycle
 *     (`a.b = b; b.a = a`) — still renders as the literal string
 *     `"[Circular]"`, and the function never throws on a self-referencing
 *     object.
 *   - A shared (non-circular) value reached via two independent paths — the
 *     same object under two sibling keys, repeated in an array, nested at
 *     different depths, or assigned to two different top-level metadata keys
 *     that share one `seen` instance (as `buildMetaRedactor` in `logger.ts`
 *     does across a single log call) — is fully walked and redacted on EVERY
 *     occurrence instead of collapsing to `"[Circular]"` after the first.
 * - **Prototype-pollution hardened.** Own keys named `__proto__`, `constructor`,
 *   or `prototype` are skipped during the rebuild. Direct assignment via
 *   `acc[key] = …` would otherwise invoke the `__proto__` setter (mutating
 *   the local object's prototype chain) or overwrite `constructor`, dropping
 *   sibling keys that fall after the offending entry. The skip is the
 *   simplest fix that keeps the result a plain `Object.prototype`-prototyped
 *   object so downstream `JSON.stringify`, `for-in`, and `Object.entries`
 *   consumers behave identically to pre-hardening.
 *
 * - **Depth boundary.** The walk is bounded at `MAX_REDACT_DEPTH` (256) nesting
 *   levels. An object or array found deeper than that is replaced with the
 *   literal string `"[MaxDepth]"` instead of being walked. This is a hard
 *   safety bound, not a tuning knob: the walk is plain recursion, so an
 *   unbounded one overflows the JavaScript stack (`RangeError: Maximum call
 *   stack size exceeded`) at roughly HALF the nesting depth `JSON.stringify`
 *   itself tolerates — measured on V8, `redactValue` throws at depth 2000 while
 *   `JSON.stringify` is still fine at 4000. Because winston runs its formats
 *   synchronously inside `logger.log()`, an unbounded overflow surfaces as a
 *   `RangeError` thrown back at the APPLICATION from an ordinary
 *   `logger.info()` call — i.e. enabling redaction would make a deep payload
 *   (a parsed request body ~18KB of JSON is enough) crash the caller. The
 *   ceiling is set far above any realistic log payload and far below the
 *   engine's frame limit, so the sentinel is only ever reached by data no
 *   human would read anyway. Primitives are never affected: the depth check
 *   sits after the primitive fast-path, so a scalar leaf always renders.
 *
 * **What masking cannot reach.** Masking matches property KEYS, never text:
 * a string is printed as it is, so a value that a `toJSON` copies from a
 * masked field into a string or under another key name, on a class instance
 * whose `toJSON` runs on the instance, is printed, and so is an `Error`
 * `message` built from its own fields (a validation error that lists the
 * rejected input). Values with no enumerable own keys (`Map`, `Set`,
 * `RegExp`) and binary values (a `Buffer`'s `type` / `data`, typed arrays)
 * render as their serializer renders them. A FUNCTION carrying its own `toJSON`
 * is returned untouched (primitives and functions are never walked), and
 * `JSON.stringify` (the pretty chain, the middleware round-trips) calls that
 * `toJSON` and prints its output; `safe-stable-stringify` (json mode) drops a
 * function. A plain object's own `toJSON` runs on the masked copy, where a
 * nested value whose `toJSON` returned a plain object or an array is already
 * that masked output, so one that calls a method on such a value throws there
 * and fails closed to `REDACTION_FAILED`. A
 * mask naming `toJSON` itself replaces a plain object's own method, so its own
 * keys print. Use `redactPaths` in the middleware for surgical replacement, or
 * log only the fields you need.
 *
 * Top-level entries are resolved by their callers, not here: `logger.ts`'s
 * `buildMetaRedactor` resolves a top-level `toJSON` of the log entry on the
 * real entry object, and the pretty formatter resolves an own `toJSON` of its
 * metadata bag itself, on the masked copy (it walks the bag with
 * {@link redactEntries}, which leaves that method alone).
 *
 * The result is always a fresh object/array (or the original value when no
 * redaction is needed); the input is never mutated.
 */
export const REDACTED = "[REDACTED]";

/**
 * Property names that must NEVER be assigned through `acc[key] = …` during a
 * deep rebuild (see its docstring in `src/serialize.ts`, where it lives so
 * `errorToPlain` can share it without importing this module). Re-exported
 * here so existing `import { FORBIDDEN_KEYS } from "./redact"` sites keep
 * working.
 */
export { FORBIDDEN_KEYS };

/**
 * Substituted for a value whose redaction walk threw: by `logger.ts` for a
 * metadata value, a message, or a stack, and by `redactValue` itself for one
 * field of an `Error` (see the Errors entry in the module docstring).
 *
 * The redaction walk is not total: reading an own enumerable key invokes a
 * getter, and a getter is caller code that may throw (as may a `toJSON` on a
 * proxied value). Since winston runs its formats synchronously inside
 * `logger.log()`, an escaping exception would surface as a throw from an
 * ordinary `logger.info()` — the caller's own logging call crashing on account
 * of the data it tried to log.
 *
 * The substitution FAILS CLOSED: it replaces the value with this sentinel
 * rather than falling back to the raw one. Emitting the unredacted value would
 * turn a redaction failure into a secret disclosure — precisely the outcome
 * `maskMetaKeys` exists to prevent — so a value that could not be proven
 * redacted is never written to the log.
 */
export const REDACTION_FAILED = "[RedactionFailed]";

/**
 * Maximum nesting depth `redactValue` will walk before substituting
 * `MAX_DEPTH`. See the module docstring's "Depth boundary" section for why an
 * unbounded walk is a caller-facing crash rather than a mere inefficiency.
 */
export const MAX_REDACT_DEPTH = 256;

/** Substituted for any object/array nested deeper than `MAX_REDACT_DEPTH`. */
export const MAX_DEPTH = "[MaxDepth]";

export const redactValue = (
  value: unknown,
  maskKeys: Set<string>,
  seen: WeakSet<object>,
  forceCopy = false,
  depth = 0,
  key = "",
): unknown => {
  if (!value || typeof value !== "object") {
    return value;
  }

  // Bound the recursion. Placed AFTER the primitive fast-path so a scalar leaf
  // at any depth still renders — only a value that would itself recurse is
  // traded for the sentinel.
  if (depth > MAX_REDACT_DEPTH) {
    return MAX_DEPTH;
  }

  if (Array.isArray(value)) {
    // An array with its own `toJSON` is printed through it, like any other
    // value (see the module docstring's "Values that define `toJSON`" entry).
    if (maskKeys.size > 0) {
      const resolved = maskedToJSON(value, maskKeys, seen, forceCopy, depth, key);
      if (resolved !== NO_TO_JSON) return resolved;
    }
    if (seen.has(value as object)) return "[Circular]";
    seen.add(value as object);
    try {
      return redactArrayItems(value, maskKeys, seen, forceCopy, depth);
    } finally {
      seen.delete(value as object);
    }
  }

  const proto = Object.getPrototypeOf(value);
  const isPlain = proto === null || proto === Object.prototype;

  if (!isPlain) {
    // Non-plain object (class instance, Error subclass, built-in, etc.)
    //
    // Pass built-ins through by identity WITHOUT adding to `seen`. This fixes
    // a latent bug where the same Date/URL/etc. referenced by two keys in an
    // outer plain object would yield "[Circular]" on the second reference.
    // `forceCopy` does NOT deep-copy these — they are returned by identity by
    // design (a binary view, a `toJSON`-defining value with no mask to apply,
    // a `toJSON` returning a primitive, or no enumerable own keys to walk).
    // Note the safety of handing them back to a
    // `forceCopy` caller that later applies in-place path writes is NOT that they
    // own no key such a write could reach: a `Buffer`'s integer indices and a
    // `RegExp`'s `lastIndex` are writable own properties. It is that the sole
    // in-place write site — `request-middleware.ts`'s `redactEntryPath` — writes
    // ONLY into an owned plain object or array and treats any other target
    // (these pass-throughs included) as a graceful no-op.
    if (ArrayBuffer.isView(value)) {
      return value;
    }
    if (maskKeys.size > 0) {
      // With a mask, the serializer's `toJSON` call is made here instead, on
      // the real instance (so a `toJSON` reading `#private` fields works), and
      // its OUTPUT is masked (see the module docstring's "Values that define
      // `toJSON`" entry).
      const resolved = maskedToJSON(value as object, maskKeys, seen, forceCopy, depth, key);
      if (resolved !== NO_TO_JSON) return resolved;
    } else if (typeof (value as Record<string, unknown>).toJSON === "function") {
      // Without one there is nothing to mask, and the value passes through
      // untouched as before (a throwing lookup reaches the caller, as it always has).
      return value;
    }

    const ownKeys = Object.keys(value as Record<string, unknown>);

    // An Error is data-bearing even with zero enumerable keys: its `message`,
    // `stack`, `cause`, and `AggregateError` `errors` are non-enumerable, and
    // a secret inside a `cause` or a member must be masked before a
    // serializer that renders them ever sees it. Walk the shared
    // `errorToPlain` view (see the module docstring's "Errors" entry).
    if (isErrorLike(value)) {
      if (seen.has(value as object)) return "[Circular]";
      seen.add(value as object);
      try {
        return redactErrorFields(value, ownKeys, maskKeys, seen, forceCopy, depth);
      } finally {
        seen.delete(value as object);
      }
    }

    if (ownKeys.length === 0) {
      return value;
    }

    // Data-bearing instance (class DTO).
    // Walk own enumerable string keys, redact matched ones, recurse into the
    // rest. Return the original by identity when nothing changed so the
    // documented pass-through for instances holding no masked key is
    // preserved — UNLESS `forceCopy` is set, in which case a fresh plain
    // object is always returned even when nothing changed. `forceCopy` exists
    // for callers (see `serializeBody` in `request-middleware.ts`) that will
    // mutate the returned value in place afterward (e.g. to apply
    // `redactPaths`) and must not risk touching a caller-owned object that
    // `maskKeys` alone left untouched.
    if (seen.has(value as object)) return "[Circular]";
    seen.add(value as object);

    try {
      let changed = false;
      const result: Record<string, unknown> = {};
      for (const ownKey of ownKeys) {
        if (FORBIDDEN_KEYS.has(ownKey)) {
          changed = true; // dropping a forbidden key is a structural change
          continue;
        }
        const original = (value as Record<string, unknown>)[ownKey];
        if (maskKeys.has(ownKey.toLowerCase())) {
          result[ownKey] = REDACTED;
          changed = true;
        } else {
          const recursed = redactValue(original, maskKeys, seen, forceCopy, depth + 1, ownKey);
          result[ownKey] = recursed;
          if (recursed !== original) changed = true;
        }
      }
      return changed || forceCopy ? result : value;
    } finally {
      seen.delete(value as object);
    }
  }

  // Plain object branch — always rebuilds a fresh plain object so callers that
  // rely on `out !== input` identity continue to work.
  if (seen.has(value as object)) return "[Circular]";
  seen.add(value as object);
  try {
    const rebuilt = redactEntries(
      value as Record<string, unknown>,
      maskKeys,
      seen,
      forceCopy,
      depth,
    );
    // An own `toJSON` method survives the rebuild as a plain value, and the
    // serializer would call it on the rebuilt copy and print its output. With
    // a mask that output is masked here, the call made on the copy exactly as
    // the serializer makes it, so a field it reads through `this` is already
    // masked (see the module docstring's "Values that define `toJSON`" entry).
    if (maskKeys.size > 0 && typeof rebuilt.toJSON === "function") {
      return redactToJSONValue(rebuilt, rebuilt, maskKeys, seen, forceCopy, depth, key);
    }
    return rebuilt;
  } finally {
    seen.delete(value as object);
  }
};

/**
 * The plain-object rebuild at the heart of {@link redactValue}: a fresh plain
 * object holding `value`'s own enumerable string keys, `FORBIDDEN_KEYS`
 * skipped, masked keys replaced with `REDACTED`, and every other value walked
 * one level deeper under its own key. Unlike `redactValue` it does not touch
 * `seen` for `value` itself and does not resolve an own `toJSON` on `value`, so
 * a caller that renders such a method itself (the pretty formatter's metadata
 * block) keeps doing so.
 */
export const redactEntries = (
  value: Record<string, unknown>,
  maskKeys: Set<string>,
  seen: WeakSet<object>,
  forceCopy = false,
  depth = 0,
): Record<string, unknown> =>
  Object.entries(value).reduce<Record<string, unknown>>((acc, [childKey, val]) => {
    // Skip prototype-pollution vectors. See FORBIDDEN_KEYS docstring.
    if (FORBIDDEN_KEYS.has(childKey)) {
      return acc;
    }
    acc[childKey] = maskKeys.has(childKey.toLowerCase())
      ? REDACTED
      : redactValue(val, maskKeys, seen, forceCopy, depth + 1, childKey);
    return acc;
  }, {});

/**
 * The Error walk (see the module docstring's "Errors" entry): masks and walks
 * the fields of `value`'s `errorToPlain` view, the view the serializers render.
 * The caller keeps `value` on the active path while it runs.
 */
const redactErrorFields = (
  value: object,
  ownKeys: string[],
  maskKeys: Set<string>,
  seen: WeakSet<object>,
  forceCopy: boolean,
  depth: number,
): unknown => {
  const view = errorToPlain(value);
  // An own enumerable key the view left out (forbidden, or an accessor that
  // threw) is a structural change: the original must not reach the
  // serializer, which would read that accessor again.
  let changed = ownKeys.some((ownKey) => !Object.prototype.hasOwnProperty.call(view, ownKey));
  const rebuilt: Record<string, unknown> = {};
  for (const field of Object.keys(view)) {
    const original = view[field];
    if (maskKeys.has(field.toLowerCase())) {
      rebuilt[field] = REDACTED;
      changed = true;
      continue;
    }
    // An own `toJSON` method of an error the serializers render through its
    // view (a `toJSON` result) is a field they omit, as they omit every
    // function value; left on the rebuild it would be CALLED and printed.
    if (field === "toJSON" && typeof original === "function") {
      continue;
    }
    // The view exposes subtrees no serializer showed before (`cause`,
    // `errors`), so a throw inside one fails closed for THIS field only
    // instead of failing the whole value: a line that rendered before must
    // not render worse now.
    let recursed: unknown;
    try {
      recursed = redactValue(original, maskKeys, seen, forceCopy, depth + 1, field);
    } catch {
      recursed = REDACTION_FAILED;
    }
    rebuilt[field] = recursed;
    if (recursed !== original) changed = true;
  }
  return changed || forceCopy ? rebuilt : value;
};

/** The element walk of an array: each element walked one level deeper under its index. */
const redactArrayItems = (
  value: unknown[],
  maskKeys: Set<string>,
  seen: WeakSet<object>,
  forceCopy: boolean,
  depth: number,
): unknown[] =>
  value.map((item, index) =>
    redactValue(item, maskKeys, seen, forceCopy, depth + 1, String(index)),
  );

/**
 * Runs `walk` with `value` on the active path. A `toJSON` result can be the
 * value itself (`toJSON() { return this; }`), already on the path; it is then
 * walked, not reported as its own cycle.
 */
const onActivePath = <T>(value: object, seen: WeakSet<object>, walk: () => T): T => {
  const added = !seen.has(value);
  if (added) seen.add(value);
  try {
    return walk();
  } finally {
    if (added) seen.delete(value);
  }
};

/** Returned by {@link maskedToJSON} for a value that defines no `toJSON`. */
const NO_TO_JSON = Symbol("no-toJSON");

/**
 * Under a non-empty mask: the masked `toJSON` output of a non-plain value or an
 * array that defines `toJSON` ({@link redactToJSONValue}, called on the value
 * itself), or `NO_TO_JSON` when it defines none. The lookup runs caller code (a
 * getter, a Proxy trap), so a throw FAILS CLOSED to `REDACTION_FAILED` for this
 * value only.
 */
const maskedToJSON = (
  value: object,
  maskKeys: Set<string>,
  seen: WeakSet<object>,
  forceCopy: boolean,
  depth: number,
  key: string,
): unknown => {
  let hasToJSON: boolean;
  try {
    hasToJSON = typeof (value as Record<string, unknown>).toJSON === "function";
  } catch {
    return REDACTION_FAILED;
  }
  return hasToJSON
    ? redactToJSONValue(value, value, maskKeys, seen, forceCopy, depth, key)
    : NO_TO_JSON;
};

/**
 * Resolves the `toJSON` of `target` the way a serializer does, once and with
 * the property key it would pass, and masks the result. `original` is what
 * the caller hands back when the result needs no rebuild, so the serializer
 * makes the same call itself and reads exactly what the no-mask line reads.
 *
 * - a throwing `toJSON` FAILS CLOSED to `REDACTION_FAILED` for this value only;
 * - a primitive (or `null`) result has no key to mask: `original` is returned
 *   (a `Date`, a `URL`, a `moment` render exactly as before);
 * - an object result is read by its own keys, once ({@link redactToJSONOutput});
 *   when that hands it back unchanged, `original` is returned.
 *
 * While the result is walked, `original` is on the active path, so a result
 * that leads back to it renders `"[Circular]"`.
 */
const redactToJSONValue = (
  target: object,
  original: object,
  maskKeys: Set<string>,
  seen: WeakSet<object>,
  forceCopy: boolean,
  depth: number,
  key: string,
): unknown => {
  // A value met again inside its own `toJSON` output (`toJSON() { return
  // { self: this }; }`) would mint a fresh output on every visit, so no other
  // cycle check could stop it.
  if (seen.has(original)) return "[Circular]";
  let produced: unknown;
  try {
    produced = (target as { toJSON: (key: string) => unknown }).toJSON(key);
  } catch {
    return REDACTION_FAILED;
  }
  if (produced === null || typeof produced !== "object") {
    return original;
  }
  seen.add(original);
  try {
    const redacted = redactToJSONOutput(produced, maskKeys, seen, forceCopy, depth);
    return redacted === produced ? original : redacted;
  } finally {
    seen.delete(original);
  }
};

/**
 * Masks the OUTPUT of a `toJSON()` call, reading it the way the serializer
 * will. `JSON.stringify` and winston's json serializer (`safe-stable-stringify`,
 * "Prevent calling `toJSON` again") call `toJSON` ONCE and then serialize its
 * result by the result's own enumerable keys; a `toJSON` on the result is never
 * called. So a non-array result that DEFINES `toJSON` (a
 * `toJSON() { return this; }` instance, a `Date`) is rebuilt key by key into a
 * plain object, dropping a function-valued `toJSON` key (the serializer omits
 * a function value; on the rebuild it would be CALLED). Every other result (an
 * array, a plain object, a class instance, a boxed primitive, a binary view)
 * has no `toJSON` for the serializer to skip, so `redactValue` handles it like
 * any other value. Nested values keep `redactValue`'s rules (their own
 * `toJSON` IS called by the serializer). Shared by `redactValue` and by
 * `logger.ts`'s message / top-level handling. Throws propagate to the caller.
 */
export const redactToJSONOutput = (
  produced: object,
  maskKeys: ReadonlySet<string>,
  seen: WeakSet<object> = new WeakSet<object>(),
  forceCopy = false,
  depth = 0,
): unknown => {
  const mask = maskKeys as Set<string>;
  if (isErrorLike(produced)) {
    // The serializers' Error-aware replacer renders an error-like result
    // through its field view, whether or not it defines `toJSON` itself.
    return onActivePath(produced, seen, () =>
      redactErrorFields(produced, Object.keys(produced), mask, seen, forceCopy, depth),
    );
  }
  if (Array.isArray(produced)) {
    // Read by its elements, never through a `toJSON` of its own (the
    // serializer does not call one on a result).
    return onActivePath(produced, seen, () =>
      redactArrayItems(produced, mask, seen, forceCopy, depth),
    );
  }
  if (
    ArrayBuffer.isView(produced) ||
    typeof (produced as Record<string, unknown>).toJSON !== "function"
  ) {
    return redactValue(produced, mask, seen, forceCopy, depth);
  }
  const rebuilt: Record<string, unknown> = {};
  for (const childKey of Object.keys(produced)) {
    if (FORBIDDEN_KEYS.has(childKey)) {
      continue;
    }
    if (mask.has(childKey.toLowerCase())) {
      rebuilt[childKey] = REDACTED;
      continue;
    }
    const child = (produced as Record<string, unknown>)[childKey];
    if (childKey === "toJSON" && typeof child === "function") {
      continue;
    }
    rebuilt[childKey] = redactValue(child, mask, seen, forceCopy, depth + 1, childKey);
  }
  return rebuilt;
};
