import fs from "node:fs";
import path from "node:path";
import winston from "winston";
import DailyRotateFile from "winston-daily-rotate-file";
import moment from "moment-timezone";
import { InvalidTimezoneError, LoggerOptionError } from "./errors";
import { redactValue } from "./redact";
import type { LoggerOptions, TimestampContext, LogLevel, RotationStrategy } from "./types";

/**
 * Frozen tuple of every npm log level supported by Winston, in priority order
 * (lowest priority value = highest severity). Used as the source of truth for
 * `LoggerOptions.level` / `LoggerOptions.consoleLevel` validation.
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

/**
 * Field-specific validators for `RotationStrategy`. The two patterns mirror the
 * upstream contract enforced by `winston-daily-rotate-file`'s internal
 * `getMaxSize` / max-files parsers exactly — inputs the upstream library would
 * silently drop (e.g. `"20mb"`, `"100b"`, bare numbers for `maxSize`,
 * unit-suffixed `maxFiles`) are rejected synchronously by `createLogger()`
 * with `LoggerOptionError({ code: "INVALID_ROTATION" })` instead of producing
 * a logger whose rotation has been silently disabled.
 *
 * - {@link MAX_SIZE_PATTERN} — `^(?:0\.)?\d+[kmg]$` (case-insensitive). Matches
 *   numeric byte sizes with a single-letter `k` / `m` / `g` suffix, optionally
 *   prefixed by a leading `0.` for fractional values (`"0.5m"`). Bare numbers
 *   and the long-form `kb` / `mb` / `gb` suffixes are NOT accepted by upstream
 *   — `getMaxSize("20mb")` returns `null` and rotation is silently disabled.
 * - {@link MAX_FILES_PATTERN} — `^\d+d?$` (case-insensitive). Matches bare
 *   numeric file counts (`"7"`, `"500"`) and day-suffixed retention windows
 *   (`"14d"`, `"30d"`). Size suffixes are NOT accepted — `parseInt("20m")`
 *   silently coerces to `20` and the rotation interprets it as "20 files".
 */
const MAX_SIZE_PATTERN = /^(?:0\.)?\d+[kmg]$/i;
const MAX_FILES_PATTERN = /^\d+d?$/i;

const isValidLogLevel = (value: unknown): value is LogLevel =>
  typeof value === "string" && (VALID_LOG_LEVELS as readonly string[]).includes(value);

const validateLogLevelOption = (label: "level" | "consoleLevel", value: unknown): void => {
  if (value === undefined) {
    return;
  }
  if (!isValidLogLevel(value)) {
    throw new LoggerOptionError(
      "INVALID_LEVEL",
      `Invalid \`${label}\` option: ${JSON.stringify(value)}. Expected one of: ${VALID_LOG_LEVELS.join(", ")}.`,
    );
  }
};

/**
 * Frozen tuple of every valid `format` value. Mirrors the `LoggerOptions.format`
 * union in `types.ts`. Used by `validateFormatOption` to reject typos like
 * `"JSON"` or `"plain"` synchronously instead of silently falling through to
 * the default `"pretty"` branch.
 */
const VALID_FORMATS = Object.freeze(["pretty", "json"] as const);

const validateFormatOption = (value: unknown): void => {
  if (value === undefined) {
    return;
  }
  if (typeof value !== "string" || !(VALID_FORMATS as readonly string[]).includes(value)) {
    throw new LoggerOptionError(
      "INVALID_FORMAT",
      `Invalid \`format\` option: ${JSON.stringify(value)}. Expected one of: ${VALID_FORMATS.join(", ")}.`,
    );
  }
};

/**
 * Validates `maskMetaKeys` up front — before the cache lookup — so a bad
 * value always throws a structured {@link LoggerOptionError} even when a
 * logger is already cached for the same `moduleName` + `logDirectory`. A bare
 * string (the natural typo `"password"` instead of `["password"]`), `null`,
 * or an array containing a non-string entry all throw `INVALID_MASK`.
 * `undefined` is accepted and treated as the default `[]`.
 */
const validateMaskMetaKeysOption = (value: unknown): void => {
  if (value === undefined) {
    return;
  }
  if (!Array.isArray(value)) {
    throw new LoggerOptionError(
      "INVALID_MASK",
      `Invalid \`maskMetaKeys\` option: expected an array of strings, but received ${typeof value}.`,
    );
  }
  for (let i = 0; i < value.length; i++) {
    if (typeof value[i] !== "string") {
      throw new LoggerOptionError(
        "INVALID_MASK",
        `Invalid \`maskMetaKeys\` option: entry at index ${i} must be a string (got ${typeof value[i]}).`,
      );
    }
  }
};

const validateRotationField = (label: string, value: unknown, pattern: RegExp): void => {
  if (value === undefined) {
    return;
  }
  // Each field has its own contract — emit a tailored hint listing the suffixes
  // the upstream `winston-daily-rotate-file` parser actually honors so the
  // consumer can fix the value without spelunking the source.
  const isMaxSize = pattern === MAX_SIZE_PATTERN;
  const hint = isMaxSize
    ? `Expected a numeric byte size with a single-letter k/m/g suffix (case-insensitive), optionally prefixed by "0." — for example "20m", "500k", "1g", or "0.5m". Bare numbers and the long-form kb/mb/gb/b suffixes are NOT accepted by winston-daily-rotate-file.`
    : `Expected a bare numeric file count (e.g. "7", "500") or a day-suffixed retention window (e.g. "14d", "30d"). Size suffixes (k/m/g/kb/mb/gb) are NOT accepted by winston-daily-rotate-file.`;
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new LoggerOptionError(
      "INVALID_ROTATION",
      `Invalid \`${label}\` option: ${JSON.stringify(value)}. ${hint}`,
    );
  }
};

const validateRotationStrategy = (label: string, rotation: RotationStrategy | undefined): void => {
  if (!rotation) {
    return;
  }
  validateRotationField(`${label}.maxSize`, rotation.maxSize, MAX_SIZE_PATTERN);
  validateRotationField(`${label}.maxFiles`, rotation.maxFiles, MAX_FILES_PATTERN);
};

const TIMESTAMP_FORMAT = "YYYY-MM-DD HH:mm:ss";
const DEFAULT_LOG_DIR = path.resolve(process.cwd(), "logs");

const isWindows = (): boolean => process.platform === "win32";

/**
 * String props that the proxy returns `undefined` for instead of falling back
 * to the unknown-method warning shim. These are well-known engine/framework
 * probes that must not turn the logger into a thenable, a function-bag, or a
 * Vue/React component look-alike.
 *
 * `toJSON` is handled separately (see `proxyToJSON`) so that
 * `JSON.stringify(logger)` returns valid JSON instead of throwing on the
 * circular stream internals that winston's `DerivedLogger` carries.
 */
const DENIED_PROXY_PROPS: ReadonlySet<string> = new Set([
  // Promise / await machinery
  "then",
  "catch",
  "finally",
  // DOM / framework probes
  "nodeType",
  "tagName",
  "nodeName",
  "_isVue",
  "$$typeof",
  // Module / CJS-ESM interop
  "__esModule",
  // Jest / Jasmine probes
  "_isMockFunction",
  "asymmetricMatch",
  // util.inspect / Node REPL probes
  "inspect",
  "nodeUtilInspect",
  // JS engine introspection probes — `Function.name`, `Function.prototype`,
  // `Function.length`, `Function.arguments`, `Function.caller`, and
  // `Function.prototype.bind` are read by reflective code paths
  // (`obj.constructor.name`, `Function.length` arity sniffing, prototype
  // walks, `.bind(...)` rewrappers). Returning `undefined` here keeps the
  // proxy from minting a no-op shim that emits a spurious unknown-method
  // warning when one of these names is read or invoked.
  "name",
  "prototype",
  "length",
  "arguments",
  "caller",
  "bind",
]);

/**
 * Regex used to validate that a prop name looks like a legitimate public log
 * method identifier before the proxy treats it as an unknown-method fallback
 * (e.g. `success`, `notice`, `audit`). Alphabetic start, identifier chars
 * thereafter, length <= 32. Anything else returns `undefined`.
 */
const FALLBACK_METHOD_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_$]{0,31}$/;

interface RegistryEntry {
  logger: winston.Logger;
  optionsSignature: string;
  additionalTransportCount: number;
  warned: boolean;
}

const loggerRegistry = new Map<string, RegistryEntry>();

/**
 * Resolves a `logDirectory` to a stable absolute form suitable for cache key
 * comparisons. The resolved path:
 * - Is absolute (`path.resolve`).
 * - Collapses symlinks via `fs.realpathSync.native` when the directory exists.
 * - Is lowercased on Windows for case-insensitive equality.
 *
 * The lowercased form must NEVER be used for filesystem operations — those use
 * the resolved-but-original-case path returned by `resolveLogDirectory`.
 */
const resolveLogDirectory = (logDirectory: string): string => {
  const absolute = path.resolve(logDirectory);
  try {
    return fs.realpathSync.native(absolute);
  } catch {
    return absolute;
  }
};

const buildRegistryKey = (moduleName: string, resolvedLogDirectory: string): string => {
  const normalized = isWindows() ? resolvedLogDirectory.toLowerCase() : resolvedLogDirectory;
  return `${normalized}::${moduleName}`;
};

/**
 * Frozen default rotation strategy applied to both the module-scoped and the
 * shared global rotating-file transports when no `rotation` / `globalRotation`
 * override is supplied. Exposed publicly so consumers can spread it into their
 * own override (e.g. `{ ...defaultRotation, maxFiles: "30d" }`) without having
 * to copy the literal.
 *
 * The exported object is `Object.freeze`'d — direct mutation throws in strict
 * mode. Use {@link getDefaultRotation} to obtain a mutable deep copy if you
 * need to mutate the result.
 *
 * @example
 * ```ts
 * import { createLogger, defaultRotation } from "@hiprax/logger";
 *
 * const logger = createLogger({
 *   rotation: { ...defaultRotation, maxFiles: "30d" },
 * });
 * ```
 */
export const defaultRotation: Readonly<RotationStrategy> = Object.freeze({
  maxSize: "20m",
  maxFiles: "14d",
  datePattern: "YYYY-MM-DD",
  zippedArchive: false,
});

/**
 * Returns a fresh, **mutable** deep copy of {@link defaultRotation}. Useful
 * for consumers who want to start from the package defaults and then mutate
 * one or two fields without spreading manually:
 *
 * @example
 * ```ts
 * import { createLogger, getDefaultRotation } from "@hiprax/logger";
 *
 * const rotation = getDefaultRotation();
 * rotation.maxFiles = "30d";
 *
 * const logger = createLogger({ rotation });
 * ```
 */
export const getDefaultRotation = (): RotationStrategy => ({
  maxSize: defaultRotation.maxSize,
  maxFiles: defaultRotation.maxFiles,
  datePattern: defaultRotation.datePattern,
  zippedArchive: defaultRotation.zippedArchive,
});

/**
 * Builds a stable canonical JSON representation of the *resolved* logger
 * options used for warning-on-mismatch detection in the registry. Includes all
 * options that affect runtime behavior: `level`, `consoleLevel`,
 * `includeConsole`, `includeFile`, `includeGlobalFile`, `globalModuleName`,
 * `extraTimezones` (sorted to be order-independent), `rotation`,
 * `globalRotation`. Does NOT include `additionalTransports` — function/class
 * instances are not stably comparable; the registry tracks their count
 * separately and the warning surfaces it as a caveat.
 */
const buildOptionsSignature = (resolved: {
  level: LogLevel;
  consoleLevel: LogLevel;
  includeConsole: boolean;
  includeFile: boolean;
  includeGlobalFile: boolean;
  globalModuleName: string;
  extraTimezones: string[];
  rotation: RotationStrategy;
  globalRotation: RotationStrategy;
  escapeMessageNewlines: boolean;
  format: "pretty" | "json";
}): string => {
  return JSON.stringify({
    level: resolved.level,
    consoleLevel: resolved.consoleLevel,
    includeConsole: resolved.includeConsole,
    includeFile: resolved.includeFile,
    includeGlobalFile: resolved.includeGlobalFile,
    globalModuleName: resolved.globalModuleName,
    extraTimezones: [...resolved.extraTimezones].sort(),
    rotation: resolved.rotation,
    globalRotation: resolved.globalRotation,
    escapeMessageNewlines: resolved.escapeMessageNewlines,
    format: resolved.format,
  });
};

/**
 * Diffs two canonical option signatures (the JSON strings produced by
 * `buildOptionsSignature`) and returns the list of top-level keys whose values
 * differ. Used to compose the human-readable mismatch warning.
 */
const diffSignatures = (cached: string, incoming: string): string[] => {
  const a = JSON.parse(cached) as Record<string, unknown>;
  const b = JSON.parse(incoming) as Record<string, unknown>;
  const keys = new Set<string>([...Object.keys(a), ...Object.keys(b)]);
  const divergent: string[] = [];
  keys.forEach((key) => {
    if (JSON.stringify(a[key]) !== JSON.stringify(b[key])) {
      divergent.push(key);
    }
  });
  return divergent;
};

const ensureDirectory = (dir: string) => {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (err) {
    throw new LoggerOptionError(
      "LOG_DIRECTORY_UNWRITABLE",
      `Failed to create or access log directory ${JSON.stringify(dir)}: ${
        err instanceof Error ? err.message : String(err)
      }`,
      { cause: err },
    );
  }
};

const sanitizeSegment = (value: string) => {
  const cleaned = value
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "-")
    .replace(/\s+/g, "-")
    .replace(/\.+/g, "-")
    .replace(/-+/g, "-")
    // The preceding `/-+/g` collapse guarantees runs of `-` are already a
    // single character, so `^-|-$` (without the `+` quantifier) is
    // semantically equivalent to `^[-]+|[-]+$` here. The non-quantified form
    // avoids the polynomial-regex pattern CodeQL flags as `js/polynomial-redos`
    // (CWE-1333) — the engine no longer has to backtrack over candidate
    // start positions for an anchored `[-]+$` match on inputs with many `-`s.
    .replace(/^-|-$/g, "")
    .trim();
  return cleaned || "logs";
};

const buildLogFilePath = (baseDir: string, name: string) => {
  const segments = name
    .split(/[\\/]+/)
    .filter(Boolean)
    .map((segment) => sanitizeSegment(segment));

  const relative = segments.length ? segments.join(path.sep) : sanitizeSegment(name || "logs");
  return path.join(baseDir, `${relative}-%DATE%.log`);
};

const normalizeTimezones = (zones?: string | string[]): string[] => {
  if (!zones) {
    return [];
  }

  const list = Array.isArray(zones) ? zones : [zones];
  const unique = Array.from(new Set(list.map((zone) => zone.trim()).filter(Boolean)));

  unique.forEach((zone) => {
    if (!moment.tz.zone(zone)) {
      throw new InvalidTimezoneError(zone);
    }
  });

  return unique;
};

interface FormatOptions {
  includeTimestamps?: boolean;
  /**
   * When provided, the printf formatter wraps the rendered `[LEVEL]` token in
   * the ANSI codes resolved by winston's `colorize()` colorizer for that
   * level. When omitted, the level token is emitted as plain uppercase text.
   * File transports never receive a colorizer; the option is intended for the
   * console transport only.
   */
  levelColorizer?: { colorize: (level: string, message: string) => string };
  /**
   * Lowercased set of metadata keys whose values should be replaced with
   * `"[REDACTED]"` BEFORE the metadata is serialized into the log line.
   * Resolved once at logger construction time from the user-facing
   * `LoggerOptions.maskMetaKeys` array (no per-log allocation in the hot path).
   * Empty / undefined means no redaction.
   */
  maskMetaKeys?: ReadonlySet<string>;
  /**
   * When `true`, the printf replaces every `\r` and `\n` byte in a string-typed
   * `info.message` with the literal escape sequences `"\\r"` / `"\\n"` BEFORE
   * concatenating the message into the rendered log line. See the
   * `LoggerOptions.escapeMessageNewlines` JSDoc for the full threat model.
   * Defaults to `false`.
   */
  escapeMessageNewlines?: boolean;
}

/**
 * Resolves the user-facing `colorize` option to a normalized
 * `{ level, message }` flag pair. The flags are honored independently by the
 * console pipeline:
 * - `level: true` wraps the `[LEVEL]` token in winston colorize ANSI codes.
 * - `message: true` runs winston's `format.colorize({ message: true })` over
 *   the message body.
 *
 * Special-case behavior:
 * - `undefined` / `true` → `{ level: true, message: true }` (back-compat-ish
 *   default; the level token also gets colorized now).
 * - `false` → `{ level: false, message: false }` (no colorize transform on
 *   the console transport).
 * - object with `all: true` → both flags are forced `true`, overriding the
 *   per-flag values.
 * - object with `all: false` → both flags are forced `false`.
 * - object without `all` → individual `level`/`message` flags honored, with
 *   `false` defaults for any flag not explicitly set.
 */
const resolveColorizeFlags = (
  option: LoggerOptions["colorize"],
): { level: boolean; message: boolean } => {
  if (option === undefined || option === true) {
    return { level: true, message: true };
  }
  if (option === false) {
    return { level: false, message: false };
  }
  if (option.all === true) {
    return { level: true, message: true };
  }
  if (option.all === false) {
    return { level: false, message: false };
  }
  return {
    level: option.level === true,
    message: option.message === true,
  };
};

/**
 * Builds a Winston `format.timestamp()` formatter that captures the event time
 * via the supplied `clock` (or the live `Date` constructor when no clock is
 * provided) and writes the canonical `TIMESTAMP_FORMAT`-formatted UTC string
 * to `info.timestamp`. Capturing here — at the moment `logger.info()` runs
 * and pushes the entry through the pipeline — guarantees the rendered string
 * reflects the call time, NOT the format/flush time.
 */
const buildTimestampCapture = (clock: () => Date) =>
  winston.format((info) => {
    info.timestamp = moment.utc(clock()).format(TIMESTAMP_FORMAT);
    return info;
  })();

/**
 * Custom Winston format used in `format: "json"` mode that runs the shared
 * deep `redactValue` primitive over `info` BEFORE `winston.format.json()`
 * serializes it. The redaction skips `level`, `message`, `timestamp`, `stack`,
 * and any Symbol-keyed slots (winston's `MESSAGE` / `LEVEL` / `SPLAT` Symbols)
 * so the canonical fields and the engine's internal bookkeeping pass through
 * untouched; every other own key is treated as caller-supplied metadata and
 * walked recursively to mask matched values.
 *
 * When `maskMetaKeys` is empty (no redaction configured) the format is a
 * no-op pass-through — winston's pipeline still sees the original `info`
 * shape with zero allocation in the hot path.
 */
const RESERVED_INFO_KEYS = new Set(["level", "message", "timestamp", "stack"]);

const buildMetaRedactor = (maskMetaKeys?: ReadonlySet<string>) =>
  winston.format((info) => {
    if (!maskMetaKeys || maskMetaKeys.size === 0) {
      return info;
    }
    const seen = new WeakSet<object>();
    const ownKeys = Object.keys(info);
    for (const key of ownKeys) {
      if (RESERVED_INFO_KEYS.has(key)) {
        continue;
      }
      const original = (info as Record<string, unknown>)[key];
      if (maskMetaKeys.has(key.toLowerCase())) {
        (info as Record<string, unknown>)[key] = "[REDACTED]";
        continue;
      }
      (info as Record<string, unknown>)[key] = redactValue(
        original,
        maskMetaKeys as Set<string>,
        seen,
      );
    }
    return info;
  })();

/**
 * `JSON.stringify` replacer that converts `BigInt` values to their decimal
 * string representation. Without this replacer, any caller-supplied payload
 * carrying a `BigInt` (e.g. `logger.info("Order", { orderId: 123n })`) would
 * crash the pretty-mode formatter synchronously back at the caller via
 * `TypeError: Do not know how to serialize a BigInt` — `JSON.stringify` has
 * no built-in `BigInt` support.
 *
 * String coercion (rather than emitting a JSON number) is the conservative
 * choice for two reasons:
 * - JSON numbers are IEEE-754 doubles; values above `2^53 - 1`
 *   (`Number.MAX_SAFE_INTEGER`) round-trip with precision loss. Order IDs,
 *   user IDs, and Twitter / X-style snowflake IDs routinely exceed the safe
 *   range — emitting them as strings preserves fidelity end-to-end.
 * - The pretty-mode formatter is consumed by humans reading log files; the
 *   `"123"` string form is unambiguous and matches the convention used by
 *   `logform/json.js`'s built-in `replacer` for `winston.format.json()`
 *   (which also string-coerces BigInts for the same fidelity reason).
 *
 * Usage: pass as the second argument to every `JSON.stringify(...)` call in
 * the pretty-mode pipeline — the message stringification, the stack
 * stringification, and the metadata stringification.
 */
const bigintSafeReplacer = (_key: string, value: unknown): unknown =>
  typeof value === "bigint" ? value.toString() : value;

const formatMessage = (ctx: TimestampContext, options: FormatOptions = {}) =>
  winston.format.printf((info) => {
    const {
      includeTimestamps = true,
      levelColorizer,
      maskMetaKeys,
      escapeMessageNewlines = false,
    } = options;
    // Strip any ANSI codes a previous colorize() pass may have wrapped around
    // `info.level` so the uppercase form is clean. winston's colorize()
    // appends the codes around the LOWERCASE level value when run before this
    // formatter — re-wrapping is the responsibility of the consumer below.
    // The strip pattern matches the full ANSI SGR sequence (`\x1b[<digits>m`);
    // the leading `\x1b` (ESC, 0x1B) is required so the regex actually removes
    // the codes instead of leaving the bare ESC byte behind.
    const rawLevel = typeof info.level === "string" ? info.level : "info";
    const strippedLevel = rawLevel.replace(/\x1b\[[0-9;]*m/g, "");
    const level = strippedLevel.toUpperCase();
    const label = ctx.label;
    const rawMessage =
      typeof info.message === "string"
        ? info.message
        : typeof info.message === "bigint"
          ? info.message.toString()
          : (JSON.stringify(info.message, bigintSafeReplacer, 2) ?? String(info.message));
    // When `escapeMessageNewlines` is on AND the original message was a string,
    // rewrite embedded `\r` / `\n` to their visible escape sequences so a
    // user-supplied payload like `"alice\n[ERROR] (admin)\nfake event"` cannot
    // forge an extra log line that is byte-for-byte indistinguishable from one
    // the application itself produced. Non-string messages are already
    // serialized through `JSON.stringify` (which escapes newlines), so the
    // option only acts on the string branch.
    const message =
      escapeMessageNewlines && typeof info.message === "string"
        ? rawMessage.replace(/\r/g, "\\r").replace(/\n/g, "\\n")
        : rawMessage;

    const { stack, level: _level, message: _msg, timestamp: capturedTimestamp, ...metadata } = info;
    // When the consumer configured `maskMetaKeys`, deep-redact the metadata
    // BEFORE serialization so secrets never reach the log line. The redaction
    // is purely functional (returns a fresh object), so the original `info`
    // shape is left untouched for any subsequent formatter in the pipeline.
    const redactedMetadata =
      maskMetaKeys && maskMetaKeys.size > 0
        ? (redactValue(metadata, maskMetaKeys as Set<string>, new WeakSet()) as Record<
            string,
            unknown
          >)
        : metadata;
    const cleanedMeta = Object.keys(redactedMetadata).length > 0 ? redactedMetadata : undefined;

    const lines: string[] = [];

    if (includeTimestamps) {
      // Prefer the captured-at-log-time string written by
      // `buildTimestampCapture`; fall back to a fresh `moment.utc()` only when
      // the formatter was invoked outside the logger pipeline (e.g. unit tests
      // that call `formatMessage(...).transform(...)` directly).
      const utcString =
        typeof capturedTimestamp === "string"
          ? capturedTimestamp
          : moment.utc().format(TIMESTAMP_FORMAT);
      // Parse the captured UTC string back into a moment instant so extra
      // timezones reflect the SAME captured event time, not the live clock.
      const capturedMoment = moment.utc(utcString, TIMESTAMP_FORMAT);
      const additionalZones = ctx.timezones.map(
        (zone) => `${zone}: ${capturedMoment.clone().tz(zone).format(TIMESTAMP_FORMAT)}`,
      );
      lines.push(`UTC: ${utcString}`, ...additionalZones.map((entry) => entry));
    }

    // When a level colorizer is supplied (console pipeline with
    // `colorize.level === true`), wrap the `[LEVEL]` token in the ANSI codes
    // resolved by winston's colorize() colorizer for that level. The colorize
    // call is forwarded the LOWERCASE level (winston's color map keys are
    // lowercased) but applies the codes around the supplied display string,
    // which preserves our uppercase token form.
    const levelToken = levelColorizer
      ? levelColorizer.colorize(strippedLevel, `[${level}]`)
      : `[${level}]`;
    lines.push(`${levelToken} (${label})`, message);

    if (stack) {
      lines.push(typeof stack === "string" ? stack : JSON.stringify(stack, bigintSafeReplacer, 2));
    }

    if (cleanedMeta) {
      lines.push(JSON.stringify(cleanedMeta, bigintSafeReplacer, 2));
    }

    return `${lines.join("\n")}\n`;
  });

const buildRotateTransport = (options: {
  filename: string;
  level: LogLevel;
  rotation?: typeof defaultRotation | RotationStrategy;
  handleExceptions?: boolean;
  handleRejections?: boolean;
}) => {
  const rotation = { ...defaultRotation, ...options.rotation };

  return new DailyRotateFile({
    filename: options.filename,
    datePattern: rotation.datePattern,
    maxSize: rotation.maxSize,
    maxFiles: rotation.maxFiles,
    zippedArchive: rotation.zippedArchive,
    level: options.level,
    handleExceptions: options.handleExceptions,
    handleRejections: options.handleRejections,
  });
};

const MAX_TRACKED_TRANSPORT_ERRORS = 10;

/**
 * Cap on the per-logger `warnedMethods` Set used by the proxy's unknown-method
 * fallback shim. Each unique unknown method name (e.g. `logger.success(...)`,
 * `logger.audit(...)`) is recorded so the warning fires only once per name
 * per logger. Without a cap the set grows monotonically when a misbehaving
 * consumer funnels arbitrary input into method names (e.g.
 * `logger[req.headers["x-action"]]()`). When the set reaches this size we
 * clear it (cap-and-reset, matching the {@link MAX_TRACKED_TRANSPORT_ERRORS}
 * pattern) so genuinely new typos after a long run still surface a warning.
 *
 * 50 is chosen as a generous ceiling over the realistic count of distinct
 * method-name typos a long-lived process is likely to encounter.
 */
const MAX_TRACKED_UNKNOWN_METHODS = 50;

/**
 * Duck-types `value` as a Winston-compatible transport: must expose a `.log`
 * method (function) AND an `.on` method (EventEmitter contract). This is
 * deliberately lenient — `instanceof winston.Transport` would reject custom
 * transports built without extending the base class.
 */
const isWinstonCompatibleTransport = (value: unknown): value is winston.transport => {
  if (!value || (typeof value !== "object" && typeof value !== "function")) {
    return false;
  }
  const candidate = value as { log?: unknown; on?: unknown };
  return typeof candidate.log === "function" && typeof candidate.on === "function";
};

/**
 * Validates each entry of `additionalTransports` synchronously. Throws a clear
 * `TypeError` listing the offending index when an entry does not duck-type as
 * a Winston-compatible transport.
 */
const validateAdditionalTransports = (transports: readonly unknown[]): void => {
  transports.forEach((transport, index) => {
    if (!isWinstonCompatibleTransport(transport)) {
      throw new TypeError(
        `additionalTransports[${index}] must be a Winston-compatible transport (an object with \`log\` and \`on\` methods).`,
      );
    }
  });
};

/**
 * Attaches a defensive `error` listener to a transport. Errors are routed to
 * the user-provided `onTransportError` callback when present (inside a
 * try/catch so a buggy callback cannot crash the process); otherwise (or on
 * callback failure) they are written to the bare `console.error` to avoid
 * recursing back into the logger's own transports.
 *
 * Repeated identical error messages are deduplicated via a per-logger
 * `Set<string>` of seen `err.message` values, capped at
 * `MAX_TRACKED_TRANSPORT_ERRORS` unique messages. When the cap is reached the
 * tracker resets so genuinely new errors after a long run are still surfaced.
 */
const attachTransportErrorHandler = (
  transport: winston.transport,
  seenErrors: Set<string>,
  onTransportError: ((err: Error, transport: winston.transport) => void) | undefined,
  callbackFailureWarned: { value: boolean },
): void => {
  transport.on("error", (err: Error) => {
    const message = err && typeof err.message === "string" ? err.message : String(err);
    if (seenErrors.has(message)) {
      return;
    }
    if (seenErrors.size >= MAX_TRACKED_TRANSPORT_ERRORS) {
      seenErrors.clear();
    }
    seenErrors.add(message);

    const rawName = (transport as unknown as { name?: unknown }).name;
    const transportName = typeof rawName === "string" && rawName ? rawName : "unknown";

    if (onTransportError) {
      try {
        onTransportError(err, transport);
        return;
      } catch (callbackErr) {
        if (!callbackFailureWarned.value) {
          callbackFailureWarned.value = true;
          console.error(
            `@hiprax/logger onTransportError callback threw; falling back to console.error. Callback error:`,
            callbackErr,
          );
        }
      }
    }

    console.error(`@hiprax/logger transport "${transportName}" error: ${message}`);
  });
};

/**
 * Creates a fully configured Winston logger with safe defaults, rotating files,
 * UTC timestamps, and optional timezone mirrors.
 *
 * @example
 * ```ts
 * import { createLogger } from '@hiprax/logger';
 *
 * const securityLogger = createLogger({
 *   moduleName: 'security/failedLogins',
 *   extraTimezones: ['Europe/London'],
 *   logDirectory: './logs'
 * });
 *
 * securityLogger.warn('Failed login attempt detected');
 * ```
 */
export const createLogger = (options: LoggerOptions = {}): winston.Logger => {
  const {
    moduleName = "global",
    logDirectory = DEFAULT_LOG_DIR,
    level = "info",
    consoleLevel = level,
    includeConsole = true,
    includeFile = true,
    includeGlobalFile = true,
    globalModuleName = "all-logs",
    extraTimezones,
    rotation = defaultRotation,
    globalRotation,
    additionalTransports = [],
    onTransportError,
    clock = () => new Date(),
    captureUncaught = true,
    colorize,
    maskMetaKeys = [],
    escapeMessageNewlines = false,
    format = "pretty",
  } = options;

  // Validate `level` / `consoleLevel` / `format` BEFORE the cache lookup so
  // bad strings surface immediately even when a logger is already cached for
  // the same module + directory.
  validateLogLevelOption("level", level);
  validateLogLevelOption("consoleLevel", consoleLevel);
  validateFormatOption(format);

  // Validate `maskMetaKeys` BEFORE the cache lookup so a non-array or an
  // array-with-non-string entry throws a structured LoggerOptionError even
  // when a logger is already cached for the same module + directory.
  validateMaskMetaKeysOption(maskMetaKeys as unknown);

  // Validate `rotation` and `globalRotation` shapes (lenient regex on
  // `maxSize`/`maxFiles`) BEFORE the cache lookup. Rejects garbage values like
  // `"abc"` while accepting `"20m"`, `"500"`, `"14d"`, etc.
  validateRotationStrategy("rotation", rotation);
  validateRotationStrategy("globalRotation", globalRotation);

  // Validate every entry of `additionalTransports` BEFORE the cache lookup so
  // bad inputs surface synchronously even when a logger is already cached for
  // the same module + directory. Then take a defensive copy so the caller
  // mutating the input array later cannot affect the logger's transports.
  validateAdditionalTransports(additionalTransports);
  const additionalTransportsCopy: winston.transport[] = [...additionalTransports];

  // Normalize and validate timezones BEFORE the cache lookup so a second call
  // with bogus timezones still throws InvalidTimezoneError, even when a logger
  // is already cached for the same module + logDirectory.
  const timezones = normalizeTimezones(extraTimezones);

  // Normalize logDirectory BEFORE constructing the cache key so that
  // `"./logs"` and `path.resolve("./logs")` collapse to a single entry, and on
  // Windows mixed-case paths (`C:\Logs` vs `c:\logs`) collide too. The
  // resolved (case-preserving) path is what we hand to the filesystem; the
  // (possibly lowercased) cache key only exists for equality comparisons.
  const resolvedLogDirectory = resolveLogDirectory(logDirectory);
  const registryKey = buildRegistryKey(moduleName, resolvedLogDirectory);

  const resolvedRotation: RotationStrategy = { ...defaultRotation, ...rotation };
  const resolvedGlobalRotation: RotationStrategy = {
    ...defaultRotation,
    ...(globalRotation ?? rotation),
  };

  const optionsSignature = buildOptionsSignature({
    level,
    consoleLevel,
    includeConsole,
    includeFile,
    includeGlobalFile,
    globalModuleName,
    extraTimezones: timezones,
    rotation: resolvedRotation,
    globalRotation: resolvedGlobalRotation,
    escapeMessageNewlines,
    format,
  });

  const cached = loggerRegistry.get(registryKey);
  if (cached) {
    if (!cached.warned) {
      const signatureDiffers = cached.optionsSignature !== optionsSignature;
      const transportCountDiffers =
        cached.additionalTransportCount !== additionalTransportsCopy.length;
      if (signatureDiffers || transportCountDiffers) {
        cached.warned = true;
        const divergent = signatureDiffers
          ? diffSignatures(cached.optionsSignature, optionsSignature)
          : [];
        if (transportCountDiffers) {
          divergent.push("additionalTransports(count)");
        }
        const lines = [
          `[@hiprax/logger] createLogger() called with conflicting options for cache key "${registryKey}".`,
          `Returning the cached instance; the new options were ignored.`,
          `Differing fields: ${divergent.join(", ")}.`,
        ];
        if (transportCountDiffers) {
          lines.push(
            `Note: additionalTransports are compared by count only (function/class instances are not deeply equal-checked).`,
          );
        }
        console.warn(lines.join(" "));
      }
    }
    return cached.logger;
  }

  // Lazy directory creation: only touch the filesystem when at least one file
  // transport is enabled. This keeps `createLogger({ includeFile: false,
  // includeGlobalFile: false })` side-effect-free for tests, AWS Lambda
  // (where the project root is read-only), and stream-only setups against a
  // non-existent or read-only `logDirectory`.
  if (includeFile || includeGlobalFile) {
    ensureDirectory(resolvedLogDirectory);
  }

  const label = moduleName === "global" ? "GLOBAL" : moduleName;
  const ctx: TimestampContext = { label, timezones };
  const timestampCapture = buildTimestampCapture(clock);
  // Resolve `maskMetaKeys` once at construction time into a lowercased Set so
  // the printf hot path only does Set lookups. Empty arrays collapse to
  // `undefined` so the redaction branch is fully skipped when not configured.
  const maskMetaKeySet =
    maskMetaKeys.length > 0
      ? new Set<string>(maskMetaKeys.map((key) => key.toLowerCase()))
      : undefined;
  // Resolve the colorize option to per-flag booleans. `level: true` causes
  // the printf below to wrap `[LEVEL]` in ANSI codes via a standalone
  // colorizer instance; `message: true` adds winston's standard
  // `colorize({ message: true })` transform to the console pipeline. The
  // colorize flags are resolved unconditionally so the value is available
  // for both the `pretty` branch (used inline) and the `json` branch (which
  // ignores them — JSON output never gets colorized regardless).
  const colorizeFlags = resolveColorizeFlags(colorize);

  let sharedFormat: winston.Logform.Format;
  let consoleFormat: winston.Logform.Format;

  if (format === "json") {
    // JSON branch — emit one JSON object per log line for log shippers like
    // Datadog, Loki, ELK, Splunk, Vector. The timestamp capture writes the
    // canonical `info.timestamp` first; `errors({ stack: true })` resolves
    // Error instances to `{ message, stack, ...rest }` so the stack survives
    // the JSON serialization; `buildMetaRedactor` runs the shared deep
    // redaction over caller-supplied metadata BEFORE `json()` serializes —
    // so secrets never reach the line.
    //
    // The Console transport receives a SEPARATE format chain that intentionally
    // omits `timestampCapture`. Winston applies the logger-level `sharedFormat`
    // first (writing `info.timestamp` via the single `clock()` call), then
    // pipes a shallow clone of the transformed info to each transport's own
    // format. If the Console transport's format also included `timestampCapture`,
    // `clock()` would fire a second time and overwrite `info.timestamp` with a
    // new value — making the console JSON timestamp diverge from the file JSON
    // timestamp. Omitting it here means `json()` serializes the timestamp that
    // was already captured at log-call time, keeping all outputs identical.
    sharedFormat = winston.format.combine(
      timestampCapture,
      winston.format.errors({ stack: true }),
      buildMetaRedactor(maskMetaKeySet),
      winston.format.json(),
    );
    consoleFormat = winston.format.combine(
      winston.format.errors({ stack: true }),
      buildMetaRedactor(maskMetaKeySet),
      winston.format.json(),
    );
  } else {
    // Pretty branch — preserves the existing human-readable printf output
    // for backward compatibility. The timestamp capture runs FIRST so
    // `info.timestamp` is set at log-call time, before any subsequent
    // formatter (errors, printf) can be deferred by back-pressured
    // transports. The printf in `formatMessage` then prefers the captured
    // `info.timestamp` over a live `moment.utc()` read.
    const fileFormat = formatMessage(ctx, {
      maskMetaKeys: maskMetaKeySet,
      escapeMessageNewlines,
    });
    sharedFormat = winston.format.combine(
      timestampCapture,
      winston.format.errors({ stack: true }),
      fileFormat,
    );
    // `winston.format.colorize()` returns a Format-shaped object that ALSO
    // exposes a public `colorize(level, message)` helper used to wrap an
    // arbitrary string in the ANSI codes for a given level. We use that
    // helper directly inside the printf so the `[LEVEL]` token is colored
    // without pulling the colorize transform into the pipeline (which would
    // replace `info.level` with the colored string and break the
    // formatter's strip pass).
    const levelColorizer = colorizeFlags.level
      ? (winston.format.colorize() as unknown as {
          colorize: (level: string, message: string) => string;
        })
      : undefined;
    const consoleMessageFormat = formatMessage(ctx, {
      includeTimestamps: false,
      levelColorizer,
      maskMetaKeys: maskMetaKeySet,
      escapeMessageNewlines,
    });
    const consoleFormatPieces: winston.Logform.Format[] = [winston.format.errors({ stack: true })];
    if (colorizeFlags.message) {
      consoleFormatPieces.push(winston.format.colorize({ message: true }));
    }
    consoleFormatPieces.push(consoleMessageFormat);
    consoleFormat = winston.format.combine(...consoleFormatPieces);
  }

  const transports: winston.transport[] = [];

  // Per-logger dedup set + callback-failure latch shared across every
  // transport's error listener (Console + module file + global file + each
  // additional transport). Caps at MAX_TRACKED_TRANSPORT_ERRORS unique
  // messages tracked at any moment, then resets to surface fresh errors.
  const seenTransportErrors = new Set<string>();
  const transportErrorCallbackFailureWarned = { value: false };
  const registerTransport = (transport: winston.transport): void => {
    attachTransportErrorHandler(
      transport,
      seenTransportErrors,
      onTransportError,
      transportErrorCallbackFailureWarned,
    );
    transports.push(transport);
  };

  // Decide which transport(s) carry the uncaught-exception/rejection handlers.
  // Prefer FILE transports so the trace is persisted across restarts. When
  // neither file transport is enabled, fall back to the Console transport so
  // crash output is at least visible. When ALL built-in transports are off,
  // attach the handlers to every additionalTransports entry. When
  // `captureUncaught` is `false`, no transport is given the flags.
  const exceptionHandlerTarget: "file" | "console" | "additional" | "none" = !captureUncaught
    ? "none"
    : includeFile || includeGlobalFile
      ? "file"
      : includeConsole
        ? "console"
        : additionalTransportsCopy.length
          ? "additional"
          : "none";

  if (includeConsole) {
    registerTransport(
      new winston.transports.Console({
        level: consoleLevel,
        handleExceptions: exceptionHandlerTarget === "console",
        handleRejections: exceptionHandlerTarget === "console",
        format: consoleFormat,
      }),
    );
  }

  const moduleFilename = buildLogFilePath(resolvedLogDirectory, moduleName);
  const globalFilename = buildLogFilePath(resolvedLogDirectory, globalModuleName);

  if (includeFile) {
    ensureDirectory(path.dirname(moduleFilename));
    registerTransport(
      buildRotateTransport({
        filename: moduleFilename,
        level,
        rotation,
        handleExceptions: exceptionHandlerTarget === "file",
        handleRejections: exceptionHandlerTarget === "file",
      }),
    );
  }

  if (includeGlobalFile) {
    ensureDirectory(path.dirname(globalFilename));
    registerTransport(
      buildRotateTransport({
        filename: globalFilename,
        level,
        rotation: globalRotation ?? rotation,
        handleExceptions: exceptionHandlerTarget === "file",
        handleRejections: exceptionHandlerTarget === "file",
      }),
    );
  }

  if (additionalTransportsCopy.length) {
    additionalTransportsCopy.forEach((transport) => {
      // When the only available transports are the additionalTransports, set
      // `handleExceptions` / `handleRejections` on each entry so an uncaught
      // exception still has somewhere to land. We mutate the transport's
      // `.handleExceptions` / `.handleRejections` properties directly because
      // these are the documented winston-transport flags read by
      // `winston.Logger.exceptions.handle()` / `rejections.handle()`.
      if (exceptionHandlerTarget === "additional") {
        const t = transport as winston.transport & {
          handleExceptions?: boolean;
          handleRejections?: boolean;
        };
        t.handleExceptions = true;
        t.handleRejections = true;
      }
      registerTransport(transport);
    });
  }

  const baseLogger = winston.createLogger({
    level,
    format: sharedFormat,
    transports,
    exitOnError: false,
  });

  // Winston re-emits each transport's `error` event on the logger itself
  // (`Logger._onEvent` in winston/lib/winston/logger.js). Without an `error`
  // listener attached here, that re-emit would terminate the Node process via
  // EventEmitter's unhandled-error contract — defeating the per-transport
  // handlers above. Attach a no-op listener so the re-emit is "handled"; the
  // actual reporting/dedup/callback logic lives in the per-transport
  // listeners installed by `attachTransportErrorHandler`.
  baseLogger.on("error", () => {
    /* handled per-transport */
  });

  const warnedMethods = new Set<string>();

  const emitUnknownMethodWarning = (method: string) => {
    if (warnedMethods.has(method)) {
      return;
    }
    // Cap-and-reset to prevent unbounded growth when a misbehaving consumer
    // funnels arbitrary input into method names (e.g. `logger[req.headers["x-action"]]()`).
    // Mirrors the pattern used by the per-logger transport-error tracker
    // (`MAX_TRACKED_TRANSPORT_ERRORS`); after the cap is reached the set is
    // cleared so genuinely new typos after a long run still surface a warning.
    if (warnedMethods.size >= MAX_TRACKED_UNKNOWN_METHODS) {
      warnedMethods.clear();
    }
    warnedMethods.add(method);
    const warningMessage = `Unknown logger method "${method}" called. Falling back to info().`;
    if (typeof baseLogger.warn === "function") {
      baseLogger.warn(warningMessage);
    } else {
      console.warn(warningMessage);
    }
  };

  const ensureLogArgs = (incoming: unknown[]): [any, ...any[]] => {
    if (incoming.length === 0) {
      return [""];
    }
    return incoming as [any, ...any[]];
  };

  const toMessageString = (value: unknown): string => {
    if (typeof value === "string") {
      return value;
    }
    try {
      const serialized = JSON.stringify(value);
      if (typeof serialized === "string") {
        return serialized;
      }
    } catch {
      // fall through to final string coercion
    }
    return String(value ?? "");
  };

  const invokeInfoFallback = (args: unknown[]) => {
    const infoArgs = ensureLogArgs(args);
    if (typeof baseLogger.info === "function") {
      return (baseLogger.info as (...inner: any[]) => winston.Logger)(...infoArgs);
    }
    if (typeof baseLogger.log === "function") {
      const [message, ...rest] = infoArgs;
      const normalizedMessage = toMessageString(message);
      if (rest.length > 0) {
        return (baseLogger.log as winston.LeveledLogMethod)("info", normalizedMessage, ...rest);
      }
      return baseLogger.log({
        level: "info",
        message: normalizedMessage,
      });
    }
    console.warn("Logger fallback invoked but no info/log method was available.");
    return undefined;
  };

  // Returns a safe summary used by `JSON.stringify(logger)`. The raw winston
  // logger has circular stream internals (DerivedLogger -> ExceptionHandler ->
  // logger) that throw on direct serialization, so we expose a curated view.
  const proxyToJSON = (): Record<string, unknown> => ({
    type: "@hiprax/logger",
    moduleName,
    label,
    level: baseLogger.level,
    transports: baseLogger.transports.length,
  });

  const proxied = new Proxy(baseLogger, {
    get(target, prop, receiver) {
      // 1. Provide a safe `toJSON` so `JSON.stringify(logger)` cannot throw on
      //    the circular stream internals of the underlying winston logger.
      if (prop === "toJSON") {
        return proxyToJSON;
      }

      // 2. Pass-through to base logger for any prop that already exists on the
      //    underlying winston logger (own or inherited).
      if (Reflect.has(target, prop)) {
        const value = Reflect.get(target, prop, receiver);
        if (typeof value === "function") {
          return value.bind(target);
        }
        return value;
      }

      // 3. Symbol props that are not on the base logger return undefined so the
      //    logger is not thenable, not iterable, and not picked up by inspectors
      //    that probe for `Symbol.toPrimitive`, `util.inspect.custom`, etc.
      if (typeof prop === "symbol") {
        return undefined;
      }

      // 4. Hard deny-list of well-known engine/framework probes so the logger is
      //    NOT a thenable, NOT serializable as a function-bag, and NOT mistaken
      //    for a Vue/React component or a Jest mock.
      if (DENIED_PROXY_PROPS.has(prop)) {
        return undefined;
      }

      // 5. Validate the prop name shape before treating it as a logging
      //    fallback method. Reject anything that does not look like a public
      //    method identifier.
      if (!FALLBACK_METHOD_NAME_PATTERN.test(prop)) {
        return undefined;
      }

      // 6. Existing fallback warning behavior for legitimate typos like
      //    `logger.success("ok")` — emit the one-time warning and route the
      //    call to `info()`.
      return (...args: unknown[]) => {
        emitUnknownMethodWarning(prop);
        return invokeInfoFallback(args);
      };
    },
    has(target, prop) {
      // Defer to the base logger so `'foo' in logger` matches the wrapped
      // logger's surface (and does NOT report `then`, `toJSON`, etc. as present).
      return Reflect.has(target, prop);
    },
    getOwnPropertyDescriptor(target, prop) {
      // Defer to the base logger so `Object.keys(logger)`, `Object.entries`,
      // and `JSON.stringify(logger)` see only the wrapped logger's own keys.
      return Reflect.getOwnPropertyDescriptor(target, prop);
    },
    ownKeys(target) {
      return Reflect.ownKeys(target);
    },
  }) as winston.Logger;

  loggerRegistry.set(registryKey, {
    logger: proxied,
    optionsSignature,
    additionalTransportCount: additionalTransportsCopy.length,
    warned: false,
  });
  return proxied;
};

/**
 * Clears the internal logger registry, allowing fresh instances to be created.
 * Useful for testing or hot-reload scenarios.
 *
 * After calling this, the next `createLogger(...)` call for any previously
 * cached `moduleName` + `logDirectory` combination will build a brand-new
 * logger (with brand-new transports / file handles). Existing references to
 * the previously cached logger remain valid but are detached from the
 * registry.
 *
 * @example
 * ```ts
 * import { createLogger, resetLoggerRegistry } from "@hiprax/logger";
 *
 * afterEach(() => {
 *   // Clear cached loggers between tests so each test gets a fresh instance.
 *   resetLoggerRegistry();
 * });
 *
 * test("emits a custom level", () => {
 *   const logger = createLogger({ moduleName: "audit", level: "debug" });
 *   // ...
 * });
 * ```
 */
export const resetLoggerRegistry = (): void => {
  loggerRegistry.clear();
};

/**
 * Frozen tuple of every winston log level method name that the no-op logger
 * exposes as a no-op. Includes both the npm log levels (`error`, `warn`,
 * `info`, `http`, `verbose`, `debug`, `silly`) and the generic `log` method
 * so callers using either the leveled-method or the `log()`-with-level form
 * get a consistent silent surface.
 */
const NOOP_LEVEL_METHODS = Object.freeze([
  "error",
  "warn",
  "info",
  "http",
  "verbose",
  "debug",
  "silly",
  "log",
] as const);

/**
 * Frozen tuple of EventEmitter / Writable methods that the no-op logger
 * exposes as chainable no-ops. Covers the surface the request-middleware
 * (and most consumer code that adapts winston loggers) typecheck against —
 * `end()` / `close()` for shutdown, `on()` / `once()` / `removeListener()`
 * for event subscription. Each method returns `this` so chained calls like
 * `logger.on("error", h).on("close", h)` continue to work.
 */
const NOOP_LIFECYCLE_METHODS = Object.freeze([
  "on",
  "once",
  "off",
  "removeListener",
  "removeAllListeners",
  "addListener",
  "prependListener",
  "prependOnceListener",
  "emit",
] as const);

let cachedNoopLogger: winston.Logger | undefined;

/**
 * Returns a stateless, **structurally winston-compatible** logger that drops
 * every log call on the floor. Useful for libraries / SSR pipelines / test
 * harnesses that want a silent default when no caller-supplied logger is
 * available — without taking on a Winston-style `[winston] Attempt to write
 * logs with no transports` warning, without registering with the internal
 * registry, and without minting any transports / file handles.
 *
 * **Surface guarantees:**
 * - Every npm log-level method (`error`, `warn`, `info`, `http`, `verbose`,
 *   `debug`, `silly`) plus the generic `log()` method is a no-op. Calls
 *   accept any number of arguments (including `Error` instances, metadata
 *   objects, format strings — anything winston accepts) and return the
 *   logger itself for chainability.
 * - `end()`, `close()`, `on()`, `once()`, `removeListener()` (and the
 *   remaining `EventEmitter` lifecycle methods) are no-ops returning the
 *   logger so caller code that subscribes to or tears down the logger
 *   continues to work.
 * - `transports` is a frozen empty array — consumers iterating over the
 *   transport list (e.g. `shutdownLogger`) see no entries and the iteration
 *   is a no-op without throwing.
 * - `level` is the literal string `"silent"` so consumers who introspect the
 *   level for diagnostics can distinguish a no-op logger from a real one.
 *
 * **Singleton.** This function returns the SAME instance on every call —
 * the no-op logger is stateless (no per-instance metadata, no transports,
 * no registry membership) so a singleton is safe across any number of
 * consumers. The singleton is NOT registered with the logger registry, so
 * `resetLoggerRegistry()` does not affect it; nor is it returned by
 * `shutdownAllLoggers()` (it has no transports to flush anyway).
 *
 * The returned object is typed as `winston.Logger` for drop-in compatibility
 * with consumers that expect a real winston logger; under the hood it is a
 * Proxy that returns a chainable no-op for ANY method invocation, so
 * winston-side changes that add new log methods do not break consumers.
 *
 * @example
 * ```ts
 * import { createLogger, createNoopLogger } from "@hiprax/logger";
 *
 * // Library default — silent unless the consumer wires up a real logger.
 * export const init = (logger = createNoopLogger()) => {
 *   logger.info("Library initialized");
 * };
 *
 * // Consumer-side opt-in to real logging.
 * init(createLogger({ moduleName: "my-app" }));
 * ```
 */
export const createNoopLogger = (): winston.Logger => {
  if (cachedNoopLogger) {
    return cachedNoopLogger;
  }
  const noop = (..._args: unknown[]): unknown => undefined;
  // Backing object exposes the well-known surface as own properties so
  // `Reflect.has(target, "info")` (used by inspectors and the request
  // middleware's typecheck) returns `true`. The Proxy below catches anything
  // not on this surface and returns a chainable no-op so consumers using
  // winston methods we do not know about (or new methods added in future
  // winston releases) still get silent behavior.
  const target: Record<string | symbol, unknown> = {
    level: "silent",
    transports: Object.freeze([]),
    silent: true,
  };

  const noopLogger: winston.Logger = new Proxy(target, {
    get(t, prop, _receiver) {
      const bag = t as Record<string | symbol, unknown>;
      // 1. Fast path for the well-known own surface.
      if (prop in bag) {
        const value = bag[prop as string];
        if (typeof value === "function") {
          return value;
        }
        return value;
      }
      // 2. Symbol probes (Promise machinery, `util.inspect.custom`,
      //    iterator probes) all return `undefined` so the no-op logger is
      //    not thenable, not iterable, and not picked up by inspectors.
      if (typeof prop === "symbol") {
        return undefined;
      }
      // 3. Level methods — return the no-op AND record it on the target
      //    so subsequent reads find it as an own property.
      const propStr = prop as string;
      if ((NOOP_LEVEL_METHODS as readonly string[]).includes(propStr)) {
        const fn = (..._args: unknown[]) => noopLogger;
        bag[propStr] = fn;
        return fn;
      }
      // 4. Lifecycle / EventEmitter methods — return chainable no-ops.
      if ((NOOP_LIFECYCLE_METHODS as readonly string[]).includes(propStr)) {
        const fn = (..._args: unknown[]) => noopLogger;
        bag[propStr] = fn;
        return fn;
      }
      // 5. `end` / `close` for graceful-shutdown compatibility.
      if (propStr === "end" || propStr === "close") {
        const fn = (..._args: unknown[]) => noopLogger;
        bag[propStr] = fn;
        return fn;
      }
      // 6. Anything else — return a chainable no-op so even unknown winston
      //    methods do not throw. This makes the no-op logger forward-
      //    compatible with future winston versions.
      return noop;
    },
  }) as unknown as winston.Logger;

  cachedNoopLogger = noopLogger;
  return noopLogger;
};

const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5000;

/**
 * Tracks loggers that have already been (or are currently being) shut down so
 * `shutdownLogger()` is idempotent: calling it twice on the same logger
 * resolves with the same outcome as the first call instead of attempting a
 * second `logger.end()` (which can throw on a logger whose transports are
 * already closed).
 */
const shutdownPromises = new WeakMap<winston.Logger, Promise<void>>();

export interface ShutdownOptions {
  /** Maximum time (in ms) to wait for every transport to flush. Default 5000. */
  timeoutMs?: number;
}

/**
 * Awaits the `finish` event on a single transport, resolving as soon as it
 * fires. The returned promise is wired into a `Promise.race` against a timeout
 * by the caller — never used standalone — so it does NOT reject on its own.
 *
 * Some legacy `winston-transport`-derived transports never emit `finish` (e.g.
 * the bare `Console` transport, some custom in-memory stubs). To keep those
 * from blocking the overall flush, we ALSO listen for `close` and resolve when
 * either fires first. We prefer `finish` because it is the documented winston
 * contract; `close` is a defensive secondary signal.
 *
 * Returns the awaiter promise alongside a `cleanup()` function the caller can
 * invoke to remove BOTH `finish`/`close` listeners from the transport's
 * EventEmitter. This is critical for the timeout branch in {@link shutdownLogger}:
 * when `Promise.race([flushAll, timeout])` rejects via the timeout, the per-
 * transport `once` listeners would otherwise leak (each one closes over the
 * `resolve` slot of a never-fulfilled promise). Calling `cleanup()` after the
 * race settles — win or lose — guarantees the transport's listener count
 * returns to its pre-shutdown baseline.
 */
const awaitTransportFlush = (
  transport: winston.transport,
): { promise: Promise<void>; cleanup: () => void } => {
  // Holder pattern: the `settle` closure is mutually-recursive with the
  // listener-attach calls (it must reference itself for `removeListener`), so
  // we hoist it out of the Promise executor and bind it after both `once`
  // calls have run. The Promise executor runs synchronously inside `new
  // Promise(...)`, so by the time `awaitTransportFlush` returns `settle` is
  // guaranteed to be assigned — the definite-assignment assertion (`!`) is
  // safe and avoids a never-called placeholder arrow that would be
  // incorrectly counted as a function with 0% coverage.
  let settle!: () => void;
  const promise = new Promise<void>((resolve) => {
    settle = (): void => {
      transport.removeListener("finish", settle);
      transport.removeListener("close", settle);
      resolve();
    };
    transport.once("finish", settle);
    transport.once("close", settle);
  });
  const cleanup = (): void => {
    transport.removeListener("finish", settle);
    transport.removeListener("close", settle);
  };
  return { promise, cleanup };
};

/**
 * Gracefully shuts down a logger by calling `logger.end()` (winston's flush
 * API) and awaiting `finish` on every transport. Resolves once every transport
 * has flushed, or rejects with a clear timeout error after `timeoutMs` ms
 * (default 5000).
 *
 * **Idempotent for successful shutdowns:** a second call after the first
 * resolves returns the same cached resolved promise — `logger.end()` is never
 * issued a second time.
 *
 * **Retryable after a timeout:** a timed-out shutdown evicts its cached promise
 * so a subsequent call can retry the flush with a fresh `timeoutMs`. This
 * allows callers to escalate: call first with a short deadline, catch the
 * timeout, then call again with a longer one. Concurrent same-tick calls still
 * share one in-flight promise regardless of which `timeoutMs` value reaches the
 * `WeakMap` first.
 *
 * After a successful shutdown the logger should be considered closed — further
 * `logger.info(...)` calls may silently no-op or throw depending on the
 * underlying transport state.
 *
 * @example
 * ```ts
 * import { createLogger, shutdownLogger } from "@hiprax/logger";
 *
 * const logger = createLogger({ moduleName: "auth" });
 *
 * process.on("SIGTERM", async () => {
 *   try {
 *     await shutdownLogger(logger, { timeoutMs: 5000 });
 *   } catch (err) {
 *     // Timeout fired before every transport flushed.
 *   } finally {
 *     process.exit(0);
 *   }
 * });
 * ```
 */
export const shutdownLogger = (
  logger: winston.Logger,
  options: ShutdownOptions = {},
): Promise<void> => {
  const existing = shutdownPromises.get(logger);
  if (existing) {
    return existing;
  }

  const { timeoutMs = DEFAULT_SHUTDOWN_TIMEOUT_MS } = options;

  // Snapshot the transports before `end()` mutates them (some winston
  // transports detach themselves from the logger when they close). winston's
  // `Logger.transports` is always an array per the public API, so no nullish
  // fallback is required.
  const transports = [...logger.transports];

  // Issue the graceful flush. winston's `Logger.end()` is a no-op on an
  // already-ended logger (the underlying writable's second `end()` is a
  // documented no-op), so the idempotent re-shutdown path is safe — but the
  // early `shutdownPromises` cache hit above also short-circuits before we
  // ever reach this line on a repeat call.
  logger.end();

  // Each per-transport awaiter exposes its own `cleanup()` so we can detach
  // the `finish`/`close` listeners regardless of which side of the race wins.
  // Without this the timeout branch would leak one pair of `once` listeners
  // per transport per timed-out shutdown call — a real concern for long-lived
  // processes that supervise repeated restarts (test loops, k8s probes).
  const awaiters = transports.map((transport) => awaitTransportFlush(transport));
  const flushAll = Promise.all(awaiters.map((awaiter) => awaiter.promise)).then(() => undefined);

  let timeoutHandle: NodeJS.Timeout | undefined;
  const timeout = new Promise<void>((_resolve, reject) => {
    timeoutHandle = setTimeout(() => {
      reject(
        new Error(
          `shutdownLogger timed out after ${timeoutMs}ms waiting for ${transports.length} transport(s) to flush.`,
        ),
      );
    }, timeoutMs);
    // Do NOT keep the event loop alive solely for this timeout — if the rest
    // of the process is idle we want it to exit.
    timeoutHandle.unref?.();
  });

  const promise = Promise.race([flushAll, timeout])
    .catch((err) => {
      // On rejection (timeout), evict the WeakMap so a subsequent call can
      // retry the flush with a fresh timeout. Successful shutdowns are NOT
      // evicted — their cached resolved promise is the idempotent "already
      // done" signal. The identity check is defensive: in single-threaded JS
      // no code can run between the rejection microtask and this `.catch()`
      // handler, so the stored entry will always be `promise`. The guard exists
      // so that if this function is ever refactored to be partially async (e.g.
      // an `await` is introduced before the `set`), a retry that managed to
      // install a newer entry first would not be accidentally evicted here.
      if (shutdownPromises.get(logger) === promise) {
        shutdownPromises.delete(logger);
      }
      throw err;
    })
    .finally(() => {
      if (timeoutHandle !== undefined) {
        clearTimeout(timeoutHandle);
      }
      // Detach every per-transport listener pair regardless of which side of
      // the race won. On the success path `settle()` already removed them (and
      // a second `removeListener` for an absent handler is a documented no-op),
      // so this is safe to call unconditionally; on the timeout path this is
      // the ONLY place the listeners get removed, so it is load-bearing.
      awaiters.forEach((awaiter) => awaiter.cleanup());
    });

  shutdownPromises.set(logger, promise);
  return promise;
};

/**
 * Shuts down every cached logger in the registry in parallel. Useful inside a
 * SIGTERM/SIGINT handler when the consumer has created several module-scoped
 * loggers and wants to flush them all before exiting. Same options as
 * {@link shutdownLogger}; the timeout applies INDEPENDENTLY to each logger.
 *
 * @example
 * ```ts
 * import { shutdownAllLoggers } from "@hiprax/logger";
 *
 * process.on("SIGTERM", async () => {
 *   await shutdownAllLoggers({ timeoutMs: 5000 }).catch(() => undefined);
 *   process.exit(0);
 * });
 * ```
 */
export const shutdownAllLoggers = (options: ShutdownOptions = {}): Promise<void> => {
  const loggers: winston.Logger[] = [];
  loggerRegistry.forEach((entry) => {
    loggers.push(entry.logger);
  });
  return Promise.all(loggers.map((logger) => shutdownLogger(logger, options))).then(
    () => undefined,
  );
};

/** @internal */
export const __loggerInternals = {
  sanitizeSegment,
  buildLogFilePath,
  formatMessage,
  buildTimestampCapture,
  buildMetaRedactor,
  resolveLogDirectory,
  buildRegistryKey,
  buildOptionsSignature,
  diffSignatures,
  isWinstonCompatibleTransport,
  validateAdditionalTransports,
  resolveColorizeFlags,
  validateLogLevelOption,
  validateRotationStrategy,
  validateRotationField,
  validateFormatOption,
  validateMaskMetaKeysOption,
  isValidLogLevel,
  ensureDirectory,
  bigintSafeReplacer,
  VALID_LOG_LEVELS,
  VALID_FORMATS,
  MAX_SIZE_PATTERN,
  MAX_FILES_PATTERN,
  MAX_TRACKED_TRANSPORT_ERRORS,
  MAX_TRACKED_UNKNOWN_METHODS,
  TIMESTAMP_FORMAT,
  RESERVED_INFO_KEYS,
  awaitTransportFlush,
};
