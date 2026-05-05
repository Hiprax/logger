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
 *   `"[REDACTED]"`. Other values are recursed into.
 * - For NON-PLAIN objects (built-in classes like `Date`, `Map`, `Set`,
 *   `RegExp`, `URL`, `Error`, `Buffer`, `Promise`, typed arrays, custom class
 *   instances, etc.) the value is returned AS-IS. The previous implementation
 *   walked these via `Object.entries`, which returns `[]` for built-ins whose
 *   data lives behind non-enumerable accessors (`Date#getTime`,
 *   `Map#entries`, `Buffer#toString`, the `RegExp` source/flags getters,
 *   etc.), silently rebuilding them as the empty object `{}`. The "is plain
 *   object" guard is the standard
 *   `Object.getPrototypeOf(value) === Object.prototype || === null` check —
 *   anything else passes through untouched so timestamps / IDs as `Map` /
 *   sets of tags / regex patterns / `URL` instances reach the log line with
 *   their original shape intact.
 * - Detects circular references via a per-call `WeakSet` and writes the
 *   literal string `"[Circular]"` in their place — the function never throws
 *   on a self-referencing object.
 * - **Prototype-pollution hardened.** Own keys named `__proto__`, `constructor`,
 *   or `prototype` are skipped during the rebuild. Direct assignment via
 *   `acc[key] = …` would otherwise invoke the `__proto__` setter (mutating
 *   the local object's prototype chain) or overwrite `constructor`, dropping
 *   sibling keys that fall after the offending entry. The skip is the
 *   simplest fix that keeps the result a plain `Object.prototype`-prototyped
 *   object so downstream `JSON.stringify`, `for-in`, and `Object.entries`
 *   consumers behave identically to pre-hardening.
 *
 * The result is always a fresh object/array (or the original built-in value);
 * the input is never mutated.
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

  if (seen.has(value as object)) {
    return "[Circular]";
  }
  seen.add(value as object);

  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, maskKeys, seen));
  }

  // "Is plain object" guard. Built-in classes (`Date`, `Map`, `Set`,
  // `RegExp`, `URL`, `Error`, `Buffer`, `Promise`, typed arrays, custom
  // class instances) expose their data through non-enumerable accessors —
  // `Object.entries(...)` returns `[]` for them and the rebuild below would
  // silently produce `{}`. The standard "is plain object" check (prototype
  // is `Object.prototype` OR `null`) lets the recursion proceed for plain
  // objects only; everything else passes through untouched so timestamps,
  // maps, sets, regex patterns, URLs, and Error instances reach the log line
  // with their original shape and `toJSON` / `Symbol.toPrimitive` behavior
  // intact.
  const proto = Object.getPrototypeOf(value);
  if (proto !== null && proto !== Object.prototype) {
    return value;
  }

  return Object.entries(value as Record<string, unknown>).reduce<Record<string, unknown>>(
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
};
