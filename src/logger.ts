import fs from "node:fs";
import path from "node:path";
import winston from "winston";
import DailyRotateFile from "winston-daily-rotate-file";
import moment from "moment-timezone";
import { InvalidTimezoneError, LoggerOptionError } from "./errors";
import { redactValue, FORBIDDEN_KEYS } from "./redact";
import { registerCrashCapture, deregisterCrashCapture, resetCrashCapture } from "./crash-capture";
import { acquireSharedGlobalFile, resetSharedFileRegistry } from "./shared-file-transport";
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
 *   (`"14d"`, `"30d"`, `"14D"`). Size suffixes are NOT accepted — `parseInt("20m")`
 *   silently coerces to `20` and the rotation interprets it as "20 files". An
 *   uppercase-`D` day suffix is accepted here and then lowercased by
 *   {@link normalizeMaxFiles} before reaching `winston-daily-rotate-file`,
 *   whose upstream parser checks the suffix case-sensitively.
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

/**
 * Lowercases a string `maxFiles` value before it reaches
 * `winston-daily-rotate-file`. {@link MAX_FILES_PATTERN} (and the public
 * `RotationStrategy.maxFiles` JSDoc) document the day suffix as
 * case-insensitive — `"14D"` is accepted as "14 days" — but the upstream
 * `file-stream-rotator` parser checks for the suffix with a case-SENSITIVE
 * `max_logs.toString().substr(-1) === 'd'`. Left un-normalized, `"14D"`
 * passes validation yet silently falls through to upstream's file-COUNT
 * branch (kept as 14 files, not pruned by age) — the opposite of what the
 * docs promise. Normalizing here (rather than rejecting uppercase `D` at
 * validation time) keeps every previously-accepted value working, matching
 * how upstream already lowercases the sibling `maxSize` suffix internally.
 * Non-string values (`undefined`) pass through unchanged.
 */
const normalizeMaxFiles = (maxFiles: string | undefined): string | undefined =>
  typeof maxFiles === "string" ? maxFiles.toLowerCase() : maxFiles;

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
 * Maps each public logger Proxy back to the underlying **base** winston logger
 * it wraps. `shutdownLogger()` receives the Proxy but must deregister the base
 * logger from the crash-capture coordinator (which stores base loggers, never
 * the Proxy — the Proxy mints no-op shims for unknown property reads). A
 * `WeakMap` so a logger that is garbage-collected drops its entry automatically.
 */
const proxyToBaseLogger = new WeakMap<winston.Logger, winston.Logger>();

/**
 * Maps each public logger Proxy back to the `loggerRegistry` key it was cached
 * under, so {@link shutdownLogger} can evict the entry in O(1) instead of
 * scanning the whole registry for a matching value.
 *
 * Keyed by the **Proxy**, matching `loggerRegistry`'s stored `logger` and
 * `shutdownPromises` — `shutdownLogger()` receives the Proxy, so this is the
 * identity available at eviction time. (The crash-capture `registered` map is
 * the odd one out: it stores base loggers, which is what `proxyToBaseLogger`
 * exists to translate.)
 *
 * A `WeakMap` so a logger that is garbage-collected drops its entry
 * automatically. Entries here can outlive the registry slot they name (after a
 * `resetLoggerRegistry()`, or once a different logger has claimed the same
 * key) — which is exactly why eviction re-checks that the entry still points at
 * this logger before deleting it.
 */
const proxyToRegistryKey = new WeakMap<winston.Logger, string>();

/**
 * Drops a logger's `loggerRegistry` slot the moment it becomes unfit to be
 * handed out again, so the next `createLogger()` for the same `moduleName` +
 * `logDirectory` builds a fresh instance with live transports.
 *
 * Without this, a torn-down logger stayed cached forever and every later
 * `createLogger()` on that key cache-hit and returned the ENDED instance: a
 * logger whose `transports` is empty (winston derives it from the readable's
 * pipe targets, and Node auto-unpipes each transport as it finishes), which
 * throws nothing and warns nothing — winston's own "Attempt to write logs with
 * no transports" guard tests `!this._readableState.pipes`, and `pipes` is an
 * empty ARRAY, which is truthy — while the write-after-end error it raises is
 * swallowed by the base logger's no-op `error` listener. Every line written to
 * it vanished in total silence. Worker recycles, dev hot-reloads and
 * shutdown-then-recreate loops all hit that path. A cache hit also returns
 * before `registerCrashCapture`, so the stale entry left process-wide crash
 * capture permanently dead after the first shutdown.
 *
 * **Only evicts when the slot still points at this exact logger.** The key is
 * read from a `WeakMap` that can outlive the slot it names: after a
 * `resetLoggerRegistry()` followed by a `createLogger()` on the same key, the
 * slot holds a DIFFERENT, live logger, and tearing down the old detached
 * instance must not evict its replacement. The identity check makes the
 * eviction a no-op in that case, preserving the "detached loggers remain valid"
 * contract — the same precedent `shared-file-transport.ts`'s `release()` sets
 * for its own registry slot.
 *
 * A logger with no `WeakMap` entry (a `createNoopLogger()` result, or any
 * winston logger the caller built themselves and passed to `shutdownLogger`)
 * was never registered, so there is nothing to evict.
 *
 * Deliberately side-effect free beyond the `Map` delete: it runs inside the
 * `close`/`end` proxy traps and on `shutdownLogger`'s synchronous path, where a
 * throw would surface as an unrelated failure.
 */
const evictRegistryEntry = (logger: winston.Logger): void => {
  const registryKey = proxyToRegistryKey.get(logger);
  if (registryKey === undefined) {
    return;
  }
  if (loggerRegistry.get(registryKey)?.logger === logger) {
    loggerRegistry.delete(registryKey);
  }
};

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
 * `globalRotation`, `escapeMessageNewlines`, `format`, `maskMetaKeys`
 * (lowercased + sorted to be order-independent — security-relevant, so a
 * silently-dropped redaction config must surface as a conflict), `colorize`
 * (the *resolved* `{level, message}` flags, not the raw option shape),
 * `captureUncaught`, and `exitOnUncaught`. Does NOT include
 * `additionalTransports` — function/class instances are not stably comparable;
 * the registry tracks their count separately and the warning surfaces it as a
 * caveat.
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
  maskMetaKeys: string[];
  colorize: { level: boolean; message: boolean };
  captureUncaught: boolean;
  exitOnUncaught: boolean;
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
    maskMetaKeys: [...resolved.maskMetaKeys].map((key) => key.toLowerCase()).sort(),
    colorize: resolved.colorize,
    captureUncaught: resolved.captureUncaught,
    exitOnUncaught: resolved.exitOnUncaught,
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
 * **It builds and returns a FRESH info object; it must never assign back onto
 * `info`.** On winston's single-object log form (`logger.info({ message,
 * ...meta })`, `create-logger.js:76-82`) and its 2-arg object form
 * (`logger.log("info", meta)`, `logger.js:252-256`), the info object winston
 * hands the format chain **is the caller's own object, uncloned**. Assigning
 * `info[key] = "[REDACTED]"` there does not redact a log line — it overwrites
 * live application state, so `logger.info(creds)` would leave `creds.password`
 * holding the literal string `"[REDACTED]"` and the real secret gone. Code that
 * logs a DTO and then persists or returns it would write the placeholder to its
 * database or HTTP response. Returning a copy is safe because a winston format
 * may return a new object — `Logger._transform` pushes whatever `transform`
 * returns, and `format.combine` threads it to the next format. `formatMessage`
 * (the pretty-mode counterpart) has always been non-mutating; this keeps the
 * two modes honest about the same contract.
 *
 * The copy is deliberately a PLAIN object: `errors({ stack: true })` runs ahead
 * of this format in both chains and has already flattened any `Error` info to a
 * plain object, and the only consumer downstream is `winston.format.json()`, so
 * a plain rebuild is output-equivalent. This mirrors `redactValue`'s own
 * plain-rebuild rule for data-bearing instances.
 *
 * Note the boundary: winston itself still writes `level` / `[LEVEL]` onto the
 * caller's object before any format runs, and `timestamp` is added by
 * `buildTimestampCapture` upstream. Those are additive, engine-owned fields
 * this package does not control. What this format guarantees is that no
 * caller-supplied VALUE is destroyed.
 *
 * Because the rebuild targets a fresh object, own keys named `__proto__` /
 * `constructor` / `prototype` (`FORBIDDEN_KEYS`) are skipped rather than
 * assigned — the same prototype-pollution guard `redactValue` applies to every
 * nested rebuild. This matters specifically BECAUSE we rebuild instead of
 * mutating in place: `next["__proto__"] = …` on a plain `{}` would invoke
 * `Object.prototype`'s `__proto__` setter, silently dropping the key and
 * repointing `next`'s prototype; the old in-place code was immune only because
 * `info` already owned that key.
 *
 * When `maskMetaKeys` is empty (no redaction configured) the format is a
 * no-op pass-through — winston's pipeline still sees the original `info`
 * object by identity, with zero allocation in the hot path.
 */
const RESERVED_INFO_KEYS = new Set(["level", "message", "timestamp", "stack"]);

/**
 * Substituted for a metadata value whose redaction walk threw.
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
const REDACTION_FAILED = "[RedactionFailed]";

const buildMetaRedactor = (maskMetaKeys?: ReadonlySet<string>) =>
  winston.format((info) => {
    if (!maskMetaKeys || maskMetaKeys.size === 0) {
      return info;
    }
    let seen = new WeakSet<object>();
    const source = info as unknown as Record<string, unknown>;
    const next: Record<string | symbol, unknown> = {};
    for (const key of Object.keys(info)) {
      if (FORBIDDEN_KEYS.has(key)) {
        // Prototype-pollution vectors are NEVER copied onto the fresh object —
        // the same deny-list `redactValue` applies to every nested rebuild
        // (`src/redact.ts`). This is load-bearing precisely BECAUSE we now
        // rebuild instead of mutating in place: a caller-supplied own key named
        // `"__proto__"` (trivially reachable via `logger.info(JSON.parse(body))`,
        // where `JSON.parse` mints a genuine own enumerable `"__proto__"` data
        // property) would make `next["__proto__"] = …` invoke `Object.prototype`'s
        // `__proto__` setter on the fresh `{}` — silently dropping the key from
        // the emitted line AND repointing `next`'s prototype for the rest of the
        // pipeline. The old mutate-in-place code was immune only because `info`
        // already OWNED that key (an own data property shadows the accessor).
        continue;
      }
      if (RESERVED_INFO_KEYS.has(key)) {
        next[key] = source[key];
        continue;
      }
      if (maskMetaKeys.has(key.toLowerCase())) {
        // Written without reading `source[key]` first: the value is discarded
        // either way, and not reading it means a throwing getter on a MASKED
        // key cannot take the log line down.
        next[key] = "[REDACTED]";
        continue;
      }
      try {
        next[key] = redactValue(source[key], maskMetaKeys as Set<string>, seen);
      } catch {
        // Fail closed on this key only — the rest of the line still renders.
        next[key] = REDACTION_FAILED;
        // The throw unwound out of the walk without running the `seen.delete`
        // that each branch performs on its way out, so the abandoned subtree's
        // objects are still recorded as "on the active path". Reusing that
        // WeakSet would misreport any of them as "[Circular]" if a LATER key
        // legitimately references one. A fresh set restores the invariant.
        seen = new WeakSet<object>();
      }
    }
    // Carry every Symbol-keyed slot across by reference. Winston's engine
    // bookkeeping lives here — `LEVEL` is set by `Logger._transform` BEFORE the
    // format chain runs and is what `winston-transport`'s `_write` gates on,
    // `SPLAT` carries the interpolation arguments, and `MESSAGE` holds any
    // already-rendered output. Dropping them silently breaks downstream
    // serialization and transport level-filtering.
    for (const slot of Object.getOwnPropertySymbols(info)) {
      next[slot] = (source as unknown as Record<symbol, unknown>)[slot];
    }
    return next as unknown as winston.Logform.TransformableInfo;
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

/** Substituted for a value the pretty-mode formatter could not serialize. */
const UNSERIALIZABLE = "[UNSERIALIZABLE]";

/**
 * `JSON.stringify` that cannot throw at the caller.
 *
 * The pretty-mode printf runs synchronously inside `logger.log()`, so every
 * `JSON.stringify` in it is a live grenade: an exception does not degrade the
 * log line, it propagates out of the application's own `logger.info(...)` call.
 * Two reachable inputs prove it — a payload nested deeply enough to exhaust the
 * stack (`RangeError`) and a self-referencing value (`TypeError: Converting
 * circular structure to JSON`) — and both crash the DEFAULT, no-mask config,
 * which made enabling `maskMetaKeys` (whose walk bounds the graph first)
 * paradoxically safer than leaving it off.
 *
 * A log call must never be the thing that takes an application down: the
 * sentinel loses one field, the throw loses the process. Note the boundary —
 * this makes the FORMATTER total, not `JSON.stringify` itself: a value no JSON
 * serializer can express still renders as the sentinel rather than as data.
 */
const safeStringify = (value: unknown, space?: number): string => {
  try {
    return JSON.stringify(value, bigintSafeReplacer, space);
  } catch {
    return UNSERIALIZABLE;
  }
};

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
          : (safeStringify(info.message, 2) ?? String(info.message));
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
    // The walk itself can throw (a metadata getter is caller code), and winston
    // runs formats synchronously inside `logger.log()`, so an escaping
    // exception would crash the caller's own logging call. Fail closed: on
    // failure the whole metadata bag collapses to a marker rather than falling
    // back to the raw bag, which would leak the very values `maskMetaKeys` was
    // configured to hide. The level/message/stack lines still render.
    const redactedMetadata = ((): Record<string, unknown> => {
      if (!maskMetaKeys || maskMetaKeys.size === 0) {
        return metadata;
      }
      try {
        return redactValue(metadata, maskMetaKeys as Set<string>, new WeakSet()) as Record<
          string,
          unknown
        >;
      } catch {
        return { _redactionFailed: true };
      }
    })();
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
      lines.push(typeof stack === "string" ? stack : safeStringify(stack, 2));
    }

    if (cleanedMeta) {
      lines.push(safeStringify(cleanedMeta, 2));
    }

    return `${lines.join("\n")}\n`;
  });

/**
 * Shape of the parts of a `DailyRotateFile` this module reaches past the public
 * typings for: the `logStream` its `close()` drains, and the `_final` hook it
 * does not define.
 */
interface RotateFileInternals {
  _final?: (callback: (err?: Error) => void) => void;
  logStream?: { end: (callback?: () => void) => void };
}

/**
 * Gives a `DailyRotateFile` the `Writable._final` hook it omits, so that
 * `end()` genuinely drains it.
 *
 * **This is the fix for a silent, total data-loss bug, and it belongs here
 * rather than in any one caller.** Node defers a writable's `finish` until
 * `_final`'s callback runs; a writable with NO `_final` emits `finish` as soon
 * as its queued `_write` calls return. `DailyRotateFile` defines no `_final`,
 * yet its real sink is a separate `logStream` that is still buffering at that
 * moment — so its `finish` was a lie. Everything that trusted it inherited the
 * lie: `logger.end()` (winston's `Logger._final` awaits each transport's
 * `finish`) and therefore {@link shutdownLogger}, which resolved with NOTHING on
 * disk. The documented SIGTERM idiom `await shutdownAllLoggers();
 * process.exit(0)` lost every buffered line — verified: 2000 lines in, 0 on
 * disk; with this hook, 2000 of 2000.
 *
 * `DailyRotateFile.prototype.close` already proves `logStream.end(cb)` is the
 * real drain (`logStream.end(() => this.emit("finish"))`); this supplies the
 * same drain through the contract Node actually consults, so `end()` and
 * `close()` finally agree. Fixing it at construction — instead of teaching each
 * caller to prefer `close()` — keeps `awaitTransportFlush`, `settleTransport`
 * (`crash-capture.ts`) and `endSharedTransport` (`shared-file-transport.ts`) all
 * correct against one honest transport, and mirrors the precedent the shared
 * global-file handle already sets by assigning its own `_final`.
 *
 * Two details are load-bearing:
 * - The `typeof !== "function"` guard means a future upstream release that ships
 *   its own `_final` is never clobbered.
 * - `() => callback()` DISCARDS the callback's error argument. `logStream.end(cb)`
 *   on an already-ended stream invokes `cb(ERR_STREAM_ALREADY_FINISHED)`, and
 *   Node's `callFinal` turns a `_final` error into an `error` event on the
 *   transport — console noise via `attachTransportErrorHandler` for a
 *   non-problem. A second drain is reachable in normal use: `winston-transport`
 *   calls `close()` on `unpipe` (i.e. `logger.close()`).
 */
const installRotateFileFinal = (transport: DailyRotateFile): DailyRotateFile => {
  const internals = transport as unknown as RotateFileInternals;
  if (typeof internals._final !== "function") {
    internals._final = (callback: (err?: Error) => void): void => {
      try {
        if (internals.logStream) {
          internals.logStream.end(() => callback());
          return;
        }
        callback();
      } catch {
        // A stream already mid-teardown can throw on a second `end()`. The
        // bytes are someone else's drain to await; never wedge `end()`.
        callback();
      }
    };
  }
  return transport;
};

const buildRotateTransport = (options: {
  filename: string;
  level: LogLevel;
  rotation?: typeof defaultRotation | RotationStrategy;
}) => {
  const rotation = { ...defaultRotation, ...options.rotation };

  const transport = new DailyRotateFile({
    filename: options.filename,
    datePattern: rotation.datePattern,
    maxSize: rotation.maxSize,
    maxFiles: normalizeMaxFiles(rotation.maxFiles),
    zippedArchive: rotation.zippedArchive,
    level: options.level,
  });

  return installRotateFileFinal(transport);
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
 * Latches after the first `additionalTransports` entry is found carrying
 * winston's crash flags, so the explanatory warning is emitted once per process
 * rather than once per `createLogger()` call. Reset by
 * `resetLoggerRegistry()` for testability.
 */
let crashFlagStripWarned = false;

/**
 * Clears winston's `handleExceptions` / `handleRejections` flags from every
 * caller-supplied transport, warning once when any were set.
 *
 * This package owns crash capture process-wide (see `./crash-capture`), and it
 * does so precisely BY never letting a transport carry these flags: winston's
 * `Logger.add()` reacts to them by calling `exceptions.handle()` /
 * `rejections.handle()`, which installs an `uncaughtException` /
 * `unhandledRejection` listener **per logger**. A caller-supplied transport
 * that arrives pre-flagged would therefore silently re-create the exact defect
 * this design exists to remove — one process-listener pair per logger, tripping
 * Node's `MaxListenersExceededWarning` at ~10 module loggers — and would ALSO
 * double-log every crash (winston's own catcher writing the trace to that
 * transport, on top of the coordinator's single record).
 *
 * Clearing the flags IS a real change for the caller, so we warn rather than
 * stay silent: a crash is now recorded once, through the elected primary
 * logger, so this transport sees crashes only if it belongs to that logger. A
 * transport piped into any other logger — a dedicated Sentry/HTTP crash sink on
 * a non-primary module logger, say — stops receiving them. Silently dropping an
 * explicit caller choice is worse than saying so, and worse still would be
 * reassuring them that nothing changed.
 */
const stripWinstonCrashFlags = (transports: readonly winston.transport[]): void => {
  let stripped = false;
  transports.forEach((transport) => {
    const flagged = transport as winston.transport & {
      handleExceptions?: boolean;
      handleRejections?: boolean;
    };
    if (flagged.handleExceptions || flagged.handleRejections) {
      stripped = true;
      flagged.handleExceptions = false;
      flagged.handleRejections = false;
    }
  });

  if (stripped && !crashFlagStripWarned) {
    crashFlagStripWarned = true;
    console.warn(
      `[@hiprax/logger] An \`additionalTransports\` entry set \`handleExceptions\`/\`handleRejections\`; both were cleared. ` +
        `Leaving them set makes winston install one extra process listener per logger (Node warns past 10) and log every crash twice. ` +
        `Note this changes where crashes land: they are recorded once, through the elected primary logger (the first capture-enabled logger still registered), ` +
        `so this transport receives them only if it belongs to that logger. ` +
        `If it is a dedicated crash sink, attach it to the primary logger. Use \`captureUncaught: false\` to opt this logger out of crash capture entirely.`,
    );
  }
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
    exitOnUncaught = true,
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
  // Guarantee the invariant the whole crash-capture design rests on: NO
  // transport reaching winston.createLogger() may carry the crash flags, or
  // winston installs a process listener for this logger (see
  // `stripWinstonCrashFlags`). The built-in transports never set them; a
  // caller-supplied one might.
  stripWinstonCrashFlags(additionalTransportsCopy);

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

  // Normalize `maxFiles` the SAME way `buildRotateTransport` does before it
  // feeds the registry signature below — otherwise two calls that are
  // functionally identical post-normalization (`"14d"` vs `"14D"`) would hash
  // to different signatures and trip a false-positive conflict warning.
  const resolvedRotation: RotationStrategy = { ...defaultRotation, ...rotation };
  resolvedRotation.maxFiles = normalizeMaxFiles(resolvedRotation.maxFiles);
  const resolvedGlobalRotation: RotationStrategy = {
    ...defaultRotation,
    ...(globalRotation ?? rotation),
  };
  resolvedGlobalRotation.maxFiles = normalizeMaxFiles(resolvedGlobalRotation.maxFiles);

  // Resolve the colorize option to per-flag booleans BEFORE the cache lookup
  // (and the options signature it feeds) so a divergent `colorize` between two
  // createLogger() calls on the same key is caught by the conflict warning
  // below instead of being silently dropped. The flags are resolved
  // unconditionally — the same `colorizeFlags` value is reused further down
  // for both the `pretty` branch (used inline) and the `json` branch (which
  // ignores them — JSON output never gets colorized regardless).
  const colorizeFlags = resolveColorizeFlags(colorize);

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
    maskMetaKeys,
    colorize: colorizeFlags,
    captureUncaught,
    exitOnUncaught,
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
    // KNOWN BOUNDARY: `json()` is winston's own serializer and is not wrapped,
    // so a payload nested deeply enough to exhaust `JSON.stringify` itself
    // (~8000 levels) still throws `RangeError` out of `logger.log()` here. It
    // is unreachable whenever `maskMetaKeys` is configured — `buildMetaRedactor`
    // bounds the graph to `MAX_REDACT_DEPTH` first — and only fires where the
    // data is genuinely un-JSON-able, matching bare winston rather than adding
    // a crash of our own. The pretty branch has no equivalent hole: its
    // stringify sites all route through `safeStringify`.
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

  // Crash capture (`uncaughtException` / `unhandledRejection`) is NOT wired
  // through winston's per-transport `handleExceptions` / `handleRejections`
  // flags. Winston installs one process-level listener PAIR per logger whose
  // transports carry those flags (`Logger.add()` → `exceptions.handle()`), so
  // an app with one logger per module accumulates one pair per module and Node
  // emits a `MaxListenersExceededWarning`. Instead, capture-enabled loggers
  // register with the process-wide coordinator in `./crash-capture` below,
  // which owns a SINGLE listener pair and records a crash once through one
  // elected logger. No transport receives the flags here.

  if (includeConsole) {
    registerTransport(
      new winston.transports.Console({
        level: consoleLevel,
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
      }),
    );
  }

  if (includeGlobalFile) {
    ensureDirectory(path.dirname(globalFilename));
    // Every logger with `includeGlobalFile` targets the SAME resolved path, so
    // the underlying rotating-file transport is shared and reference-counted
    // across loggers (one file handle, one rotation state machine) rather than
    // duplicated per logger. What gets piped into THIS logger is a cheap
    // per-logger handle that forwards to it — winston's `_final` ends the
    // handle on shutdown, never the shared transport other loggers still use.
    registerTransport(
      acquireSharedGlobalFile({
        key: globalFilename,
        level,
        rotationSignature: JSON.stringify(resolvedGlobalRotation),
        createTransport: () =>
          buildRotateTransport({
            filename: globalFilename,
            // The shared transport must accept every level that any sharing
            // logger might emit; per-logger gating happens on the handle.
            level: "silly",
            rotation: globalRotation ?? rotation,
          }),
      }),
    );
  }

  if (additionalTransportsCopy.length) {
    additionalTransportsCopy.forEach((transport) => {
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

      // 2. `close()` must also leave crash capture. Winston's own
      //    `Logger.close()` calls `exceptions.unhandle()` / `rejections.unhandle()`,
      //    so before v1.0.0 closing a logger inherently stopped it from
      //    capturing crashes. Now that capture is coordinated here rather than
      //    by winston, a closed-but-still-registered logger could remain the
      //    elected primary — and the coordinator would route the next crash
      //    into its ended stream, where winston drops the write ("Attempt to
      //    write logs with no transports") and our no-op `error` listener
      //    swallows the failure. The crash would vanish silently. Deregistering
      //    here preserves the pre-v1.0.0 semantics and hands the primary role to
      //    a logger that can still write.
      //    It must ALSO leave the logger registry. Winston's `close()` runs
      //    `clear()` -> `unpipe()`, so the logger is left with zero transports
      //    and silently discards every subsequent write — and a cached entry
      //    would keep handing that corpse to the next `createLogger()` for this
      //    key. `close()` is a documented teardown path (`resetLoggerRegistry`'s
      //    own JSDoc treats it as co-equal to `shutdownLogger()` for releasing
      //    a shared-file handle), so it needs the same eviction.
      if (prop === "close") {
        return (...args: unknown[]): unknown => {
          deregisterCrashCapture(target);
          evictRegistryEntry(proxied);
          return (target.close as (...inner: unknown[]) => unknown).apply(target, args);
        };
      }

      // 2b. `end()` is the third door to the same dead-logger-in-the-cache
      //     state: it is terminal for the underlying stream, and winston's
      //     `Logger._final` ends every transport, each of which Node then
      //     auto-unpipes — leaving `transports` empty exactly as `close()`
      //     does. A caller draining a logger by hand (rather than through
      //     `shutdownLogger`) must not poison this cache key either. Eviction
      //     is idempotent, so `shutdownLogger`'s own `end()` passing through
      //     here costs nothing. Crash-capture deregistration is deliberately
      //     NOT duplicated here: `close()` inherits it from winston's own
      //     `unhandle()` semantics and `shutdownLogger` does it explicitly,
      //     whereas a bare `end()` never carried it before and changing that
      //     would alter crash-capture election beyond this cache fix.
      if (prop === "end") {
        return (...args: unknown[]): unknown => {
          evictRegistryEntry(proxied);
          return (target.end as (...inner: unknown[]) => unknown).apply(target, args);
        };
      }

      // 3. Pass-through to base logger for any prop that already exists on the
      //    underlying winston logger (own or inherited).
      if (Reflect.has(target, prop)) {
        const value = Reflect.get(target, prop, receiver);
        if (typeof value === "function") {
          return value.bind(target);
        }
        return value;
      }

      // 4. Symbol props that are not on the base logger return undefined so the
      //    logger is not thenable, not iterable, and not picked up by inspectors
      //    that probe for `Symbol.toPrimitive`, `util.inspect.custom`, etc.
      if (typeof prop === "symbol") {
        return undefined;
      }

      // 5. Hard deny-list of well-known engine/framework probes so the logger is
      //    NOT a thenable, NOT serializable as a function-bag, and NOT mistaken
      //    for a Vue/React component or a Jest mock.
      if (DENIED_PROXY_PROPS.has(prop)) {
        return undefined;
      }

      // 6. Validate the prop name shape before treating it as a logging
      //    fallback method. Reject anything that does not look like a public
      //    method identifier.
      if (!FALLBACK_METHOD_NAME_PATTERN.test(prop)) {
        return undefined;
      }

      // 7. Existing fallback warning behavior for legitimate typos like
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

  // Register with the process-wide crash-capture coordinator so an
  // `uncaughtException` / `unhandledRejection` is recorded once through a
  // single elected logger. The coordinator owns exactly one process-listener
  // pair regardless of how many loggers register. We register the BASE logger
  // (not the Proxy) and remember the Proxy→base mapping so `shutdownLogger()`
  // can deregister it later.
  proxyToBaseLogger.set(proxied, baseLogger);
  // Remember which registry slot this Proxy occupies so the teardown paths
  // (`shutdownLogger()`, `close()`, `end()`) can evict it in O(1), synchronously
  // as soon as the logger is ended — a torn-down logger must never be handed
  // back out by a later `createLogger()` cache hit.
  proxyToRegistryKey.set(proxied, registryKey);
  if (captureUncaught) {
    registerCrashCapture(baseLogger, {
      exitOnUncaught,
      // Lets the coordinator prefer a primary that can PERSIST the crash: only
      // the elected logger records it, so a console-only logger winning the
      // election would leave no trace on disk.
      hasFileTransport: includeFile || includeGlobalFile,
    });
  }

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
 * As of v1.0.0 this ALSO resets the process-wide crash-capture coordinator:
 * every registered logger is deregistered and the single package-owned
 * `uncaughtException` / `unhandledRejection` listener pair is uninstalled. This
 * closes a listener-orphan leak that a bare cache-clear would otherwise leave
 * behind (the detached loggers would keep the coordinator installed forever).
 * Detached loggers keep functioning as ordinary loggers; they simply no longer
 * participate in crash capture until re-created.
 *
 * The shared global-file registry is dropped too, so the next `createLogger()`
 * for a previously-shared path builds a fresh transport. Already-created
 * loggers keep writing through the handles they hold — their shared transport
 * is NOT closed here (that would break the "detached loggers remain valid"
 * contract above); it closes when its last handle is released via
 * `shutdownLogger()` / `logger.close()`.
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
  resetCrashCapture();
  resetSharedFileRegistry();
  crashFlagStripWarned = false;
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
    // Stable serialization — the unknown-method fallback would produce a circular result.
    toJSON: () => ({ type: "@hiprax/logger", level: "silent", transports: 0 }),
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
      // 6. Deny-list — same set the real logger proxy uses: Promise
      //    machinery (then/catch/finally), framework probes ($$typeof,
      //    nodeType), and engine introspection props. Blocking these keeps
      //    the no-op logger non-thenable and prevents it from being mistaken
      //    for a Vue/React component, a Jest mock, or a callable function.
      if (DENIED_PROXY_PROPS.has(propStr)) {
        return undefined;
      }
      // 7. Anything else — return a chainable no-op so even unknown winston
      //    methods do not throw. This makes the no-op logger forward-
      //    compatible with future winston versions.
      return (..._args: unknown[]) => noopLogger;
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
 * `finish` is trustworthy as a drain signal precisely because every transport
 * this package builds honors the `Writable._final` contract — Node defers
 * `finish` until `_final`'s callback runs. `winston.transports.File` ships one,
 * the shared global-file handle assigns one, and `buildRotateTransport` supplies
 * the one `DailyRotateFile` is missing (see the `_final` it installs there,
 * without which this awaiter would resolve on a `finish` fired while the
 * rotating file was still buffering).
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
 * API) and then draining every transport. Resolves once every transport's bytes
 * are actually out, or rejects with a clear timeout error after `timeoutMs` ms
 * (default 5000).
 *
 * **The resolve signal is the real drain, not just a `finish`.** Node defers a
 * writable's `finish` until its `_final` callback runs, so `finish` means "my
 * bytes are out" only for a transport that implements `_final`. A
 * `DailyRotateFile` ships none, and its `finish` fires while the underlying
 * `logStream` is still buffering — awaiting that and then calling
 * `process.exit(0)` (the documented SIGTERM idiom on
 * {@link shutdownAllLoggers}) lost every buffered line. The rotating transport
 * is therefore built with the `_final` it omits, so the `finish` this helper
 * awaits is honest; see `installRotateFileFinal`.
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
 * **Shutting down evicts the logger from the internal registry**, synchronously,
 * as soon as `end()` is issued — on the timeout path as well as the success
 * path. The cache entry for its `moduleName` + `logDirectory` is dropped, so the
 * next {@link createLogger} call for that combination builds a brand-new
 * instance with live transports rather than returning this ended one. (Before
 * this, a post-shutdown `createLogger()` cache-hit returned the ended logger —
 * zero transports, no error, no warning, every line silently discarded, and
 * crash capture permanently dead because the cache hit returns before it can
 * re-register.)
 *
 * Two consequences worth knowing:
 * - Only the CACHE is cleared. A reference you already hold stays ended; this
 *   does not heal a logger somebody already captured (an
 *   auto-created `createRequestLogger` middleware logger, for instance).
 * - A timed-out shutdown is still retryable through the reference you hold (see
 *   above), but {@link shutdownAllLoggers} — which iterates the registry — will
 *   not pick it up a second time, because it is no longer in the registry.
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

  // Subscribe BEFORE `end()`. Each per-transport awaiter exposes its own
  // `cleanup()` so we can detach the `finish`/`close` listeners regardless of
  // which side of the race wins. Without this the timeout branch would leak one
  // pair of listeners per transport per timed-out shutdown call — a real
  // concern for long-lived processes that supervise repeated restarts (test
  // loops, k8s probes).
  const awaiters = transports.map((transport) => awaitTransportFlush(transport));

  // Issue the graceful flush. This is what drives winston's own pipeline, and
  // draining the transports directly instead would NOT do: the Logger's own
  // buffers hold every info a back-pressuring transport has not accepted yet,
  // and `Logger._final` is what hands those over (by calling `transport.end()`
  // on each). Each transport then reaches a truthful `finish` through its
  // `_final` — the rotating file included, per `installRotateFileFinal`.
  // winston's `Logger.end()` is a no-op on an already-ended logger (the
  // underlying writable's second `end()` is a
  // documented no-op), so the idempotent re-shutdown path is safe — but the
  // early `shutdownPromises` cache hit above also short-circuits before we
  // ever reach this line on a repeat call.
  logger.end();

  // Deregister from the crash-capture coordinator as the logger tears down, so
  // once every logger has been shut down the process returns to zero
  // package-owned `uncaughtException` / `unhandledRejection` listeners. We map
  // the public Proxy back to the base logger the coordinator actually stored;
  // deregistering a logger that was never registered (e.g. a no-op logger, or
  // one created with `captureUncaught: false`) is a safe no-op.
  deregisterCrashCapture(proxyToBaseLogger.get(logger) ?? logger);

  // Evict the registry slot NOW — synchronously, in the same tick as `end()`,
  // and regardless of how the flush below turns out.
  //
  // WHY HERE, and not on the success branch of the race:
  // - `end()` above is unconditional and irreversible. The instant it runs the
  //   logger is unfit to hand out, so that is the instant the cache must stop
  //   offering it. Evicting only when the race settles would leave a window as
  //   wide as `timeoutMs` (5000ms by default) in which a concurrent
  //   `createLogger()` on this key still cache-hits and receives the ended
  //   logger — the exact defect this eviction exists to close, merely narrowed.
  // - A TIMED-OUT flush is not a reason to keep the entry. The timeout does not
  //   mean "not ended yet"; it means "ended, and still not drained" — strictly
  //   MORE broken, not less. Leaving it cached would trade a guaranteed,
  //   unbounded, silent loss for a bounded one. Retryability is unaffected:
  //   `shutdownLogger` reads only its argument, `shutdownPromises` and
  //   `proxyToBaseLogger` — never the registry — so the documented
  //   escalate-with-a-longer-timeout idiom works exactly as before.
  //   (`shutdownAllLoggers` is the one caller that iterates the registry, so a
  //   second bulk call will not re-attempt a timed-out logger; retry it through
  //   the reference you hold.)
  evictRegistryEntry(logger);

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
 * Every logger reached here is evicted from the registry (see
 * {@link shutdownLogger}), so a subsequent `createLogger()` builds a fresh
 * instance instead of receiving an ended one. The registry is snapshotted into
 * an array before any shutdown starts, so the evictions cannot disturb the
 * iteration. A logger that times out is evicted too and will therefore NOT be
 * retried by a second `shutdownAllLoggers()` call — retry those through the
 * references you hold.
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
  installRotateFileFinal,
  validateAdditionalTransports,
  resolveColorizeFlags,
  validateLogLevelOption,
  validateRotationStrategy,
  validateRotationField,
  normalizeMaxFiles,
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
