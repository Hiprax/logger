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
 *   affected.
 * - For NON-PLAIN objects the handling depends on whether the instance
 *   carries key-addressable secrets in its own enumerable fields:
 *   - **Pass-through built-ins** — returned AS-IS (same reference, NOT added
 *     to `seen`) when any of the following is true:
 *     - The value defines a custom `toJSON` method (`Date`, `URL`, `Buffer`,
 *       moment, etc. — the serializer will call `toJSON` and the result is a
 *       plain value that cannot be key-redacted here).
 *     - The value is an `ArrayBuffer` view (typed arrays, `DataView`,
 *       `Buffer`) — data lives in the underlying memory, not in enumerable
 *     own keys.
 *     - The value has zero enumerable own string keys and is not an `Error`
 *       (`Map`, `Set`, `RegExp`, `Promise`) — no key can match.
 *     Not adding these to `seen` means built-ins are never subject to cycle
 *     tracking at all — the same built-in referenced by two keys (e.g.
 *     `{ a: date, b: date }`) has always rendered both occurrences fully.
 *   - **Errors** (`isErrorLike`: same-realm, subclass, or cross-realm; checked
 *     AFTER the `toJSON` / binary-view pass-through, so an `Error` subclass
 *     with its own `toJSON` keeps that path and a rebuild never exposes the
 *     fields its `toJSON` hides) — data-bearing even with zero enumerable
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
 *   recursion path: the array, plain-object, Error, and data-bearing-instance
 *   branches each add their `value` to `seen` on entry and remove it again in
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
 * **Redaction boundary (limitation).** NESTED values that define their own
 * `toJSON()` (including `Date`, `URL`, and any class with a custom serializer)
 * are returned by identity and NOT key-redacted — the downstream serializer
 * will invoke `toJSON` and the resulting primitive bypasses key inspection. Use
 * `redactPaths` for surgical path-based replacement of such values, or
 * normalize them to a plain object before passing to the logger.
 *
 * Note the deliberate asymmetry: `logger.ts`'s `buildMetaRedactor` does NOT
 * inherit this limitation at the TOP level. It resolves a top-level `toJSON`
 * itself and redacts the output, because (a) a plain rebuild there would
 * otherwise discard the info's prototype and emit the fields `toJSON`
 * withheld — making `maskMetaKeys` disclose more when enabled than when off —
 * and (b) `createLogger` has no `redactPaths` escape hatch, so the remedy this
 * boundary points at does not exist for `maskMetaKeys`. Here the escape hatch
 * does exist, and the value is reached mid-walk where invoking a caller's
 * `toJSON` for every nested built-in would be both costly and surprising.
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
    if (seen.has(value as object)) return "[Circular]";
    seen.add(value as object);
    try {
      return value.map((item) => redactValue(item, maskKeys, seen, forceCopy, depth + 1));
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
    // design (a `toJSON` output bypasses key inspection downstream, or there are
    // no enumerable own keys to walk). Note the safety of handing them back to a
    // `forceCopy` caller that later applies in-place path writes is NOT that they
    // own no key such a write could reach: a `Buffer`'s integer indices and a
    // `RegExp`'s `lastIndex` are writable own properties. It is that the sole
    // in-place write site — `request-middleware.ts`'s `redactEntryPath` — writes
    // ONLY into an owned plain object or array and treats any other target
    // (these pass-throughs included) as a graceful no-op.
    const hasToJSON = typeof (value as Record<string, unknown>).toJSON === "function";
    if (hasToJSON || ArrayBuffer.isView(value)) {
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
        const view = errorToPlain(value as object);
        // An own enumerable key the view left out (forbidden, or an accessor
        // that threw) is a structural change: the original must not reach the
        // serializer, which would read that accessor again.
        let changed = ownKeys.some((key) => !Object.prototype.hasOwnProperty.call(view, key));
        const rebuilt: Record<string, unknown> = {};
        for (const key of Object.keys(view)) {
          const original = view[key];
          if (maskKeys.has(key.toLowerCase())) {
            rebuilt[key] = REDACTED;
            changed = true;
            continue;
          }
          // The view exposes subtrees no serializer showed before (`cause`,
          // `errors`), so a throw inside one fails closed for THIS field only
          // instead of failing the whole value: a line that rendered before
          // must not render worse now.
          let recursed: unknown;
          try {
            recursed = redactValue(original, maskKeys, seen, forceCopy, depth + 1);
          } catch {
            recursed = REDACTION_FAILED;
          }
          rebuilt[key] = recursed;
          if (recursed !== original) changed = true;
        }
        return changed || forceCopy ? rebuilt : value;
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
      for (const key of ownKeys) {
        if (FORBIDDEN_KEYS.has(key)) {
          changed = true; // dropping a forbidden key is a structural change
          continue;
        }
        const original = (value as Record<string, unknown>)[key];
        if (maskKeys.has(key.toLowerCase())) {
          result[key] = REDACTED;
          changed = true;
        } else {
          const recursed = redactValue(original, maskKeys, seen, forceCopy, depth + 1);
          result[key] = recursed;
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
    return Object.entries(value as Record<string, unknown>).reduce<Record<string, unknown>>(
      (acc, [key, val]) => {
        // Skip prototype-pollution vectors. See FORBIDDEN_KEYS docstring.
        if (FORBIDDEN_KEYS.has(key)) {
          return acc;
        }
        acc[key] = maskKeys.has(key.toLowerCase())
          ? REDACTED
          : redactValue(val, maskKeys, seen, forceCopy, depth + 1);
        return acc;
      },
      {},
    );
  } finally {
    seen.delete(value as object);
  }
};
