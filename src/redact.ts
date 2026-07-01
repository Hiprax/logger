/**
 * Shared deep-redaction primitive used by BOTH the core logger (for
 * `LoggerOptions.maskMetaKeys`) and the request-logging middleware (for
 * `RequestLoggerOptions.maskBodyKeys` / `redactPaths`). Lives in its own
 * module so the two consumers do not have to import each other to share the
 * implementation.
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
 *     - The value has zero enumerable own string keys (`Map`, `Set`, `RegExp`,
 *       `Promise`, a vanilla `Error` with no extra props) — no key can match.
 *     Not adding these to `seen` means built-ins are never subject to cycle
 *     tracking at all — the same built-in referenced by two keys (e.g.
 *     `{ a: date, b: date }`) has always rendered both occurrences fully.
 *   - **Data-bearing instances** (class DTOs, `Error` subclasses with
 *     enumerable props) — walked via their own enumerable string keys. Keys
 *     whose lowercased form is in `maskKeys` are replaced with `"[REDACTED]"`;
 *     others are recursed into. Returns the **original by identity** when
 *     nothing changed (no key matched and every recursed child is `===` its
 *     original). Returns a fresh **plain** object only when a redaction
 *     actually occurred; downstream is always JSON serialization, so a plain
 *     rebuild is output-equivalent.
 * - **Cycle detection is active-path tracking, not all-visited tracking.**
 *   The per-call `WeakSet` (`seen`) records only the objects on the CURRENT
 *   recursion path: the array, plain-object, and data-bearing-instance
 *   branches each add their `value` to `seen` on entry and remove it again
 *   immediately before returning, once that value's own subtree has finished
 *   processing. Consequences:
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
 * **Redaction boundary (limitation).** Values that define their own `toJSON()`
 * (including `Date`, `URL`, and any class with a custom serializer) are
 * returned by identity and NOT key-redacted — the downstream serializer will
 * invoke `toJSON` and the resulting primitive bypasses key inspection. Use
 * `redactPaths` for surgical path-based replacement of such values, or
 * normalize them to a plain object before passing to the logger.
 *
 * The result is always a fresh object/array (or the original value when no
 * redaction is needed); the input is never mutated.
 */
export const REDACTED = "[REDACTED]";

/**
 * Property names that must NEVER be assigned through `acc[key] = …` during a
 * deep rebuild. `__proto__` triggers the prototype setter (corrupts the local
 * object's prototype chain); `constructor` and `prototype` are likewise
 * structural fields whose assignment can break instanceof checks and downstream
 * key enumeration. Centralized here so both this module and the middleware
 * `redactEntryPath` walker share a single deny-list.
 */
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export const redactValue = (
  value: unknown,
  maskKeys: Set<string>,
  seen: WeakSet<object>,
): unknown => {
  if (!value || typeof value !== "object") {
    return value;
  }

  if (Array.isArray(value)) {
    if (seen.has(value as object)) return "[Circular]";
    seen.add(value as object);
    const mapped = value.map((item) => redactValue(item, maskKeys, seen));
    seen.delete(value as object);
    return mapped;
  }

  const proto = Object.getPrototypeOf(value);
  const isPlain = proto === null || proto === Object.prototype;

  if (!isPlain) {
    // Non-plain object (class instance, Error subclass, built-in, etc.)
    //
    // Pass built-ins through by identity WITHOUT adding to `seen`. This fixes
    // a latent bug where the same Date/URL/etc. referenced by two keys in an
    // outer plain object would yield "[Circular]" on the second reference.
    const hasToJSON = typeof (value as Record<string, unknown>).toJSON === "function";
    if (hasToJSON || ArrayBuffer.isView(value) || Object.keys(value as object).length === 0) {
      return value;
    }

    // Data-bearing instance (class DTO, Error subclass with enumerable props).
    // Walk own enumerable string keys, redact matched ones, recurse into the
    // rest. Return the original by identity when nothing changed so the
    // documented pass-through for instances holding no masked key is preserved.
    if (seen.has(value as object)) return "[Circular]";
    seen.add(value as object);

    const ownKeys = Object.keys(value as Record<string, unknown>);
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
        const recursed = redactValue(original, maskKeys, seen);
        result[key] = recursed;
        if (recursed !== original) changed = true;
      }
    }

    seen.delete(value as object);
    return changed ? result : value;
  }

  // Plain object branch — always rebuilds a fresh plain object so callers that
  // rely on `out !== input` identity continue to work.
  if (seen.has(value as object)) return "[Circular]";
  seen.add(value as object);

  const rebuilt = Object.entries(value as Record<string, unknown>).reduce<Record<string, unknown>>(
    (acc, [key, val]) => {
      // Skip prototype-pollution vectors. See FORBIDDEN_KEYS docstring.
      if (FORBIDDEN_KEYS.has(key)) {
        return acc;
      }
      acc[key] = maskKeys.has(key.toLowerCase()) ? REDACTED : redactValue(val, maskKeys, seen);
      return acc;
    },
    {},
  );
  seen.delete(value as object);
  return rebuilt;
};
