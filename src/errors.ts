/**
 * Error thrown when an invalid IANA timezone identifier is provided to
 * `LoggerOptions.extraTimezones`. Validation runs **before** the registry cache
 * lookup, so a bogus timezone always throws even when a logger is already
 * cached for the same `moduleName` + `logDirectory` combination.
 *
 * @example
 * ```ts
 * import { createLogger, InvalidTimezoneError } from "@hiprax/logger";
 *
 * try {
 *   createLogger({ extraTimezones: ["Not/A_Real_Zone"] });
 * } catch (err) {
 *   if (err instanceof InvalidTimezoneError) {
 *     console.error("Bad timezone configuration:", err.message);
 *   } else {
 *     throw err;
 *   }
 * }
 * ```
 */
export class InvalidTimezoneError extends Error {
  constructor(zone: string) {
    super(`Invalid timezone identifier: ${zone}`);
    this.name = "InvalidTimezoneError";
  }
}

/**
 * Documented option-validation error codes emitted by {@link LoggerOptionError}
 * thrown from `createLogger()`.
 *
 * - `INVALID_LEVEL` — `level` or `consoleLevel` is not in the npm-levels union
 *   (`error | warn | info | http | verbose | debug | silly`).
 * - `INVALID_ROTATION` — `rotation.maxSize` or `rotation.maxFiles` does not
 *   match the expected lenient shape (e.g. `"20m"`, `"14d"`, `"500"`). Garbage
 *   strings like `"abc"` are rejected.
 * - `LOG_DIRECTORY_UNWRITABLE` — `ensureDirectory()` failed when creating the
 *   configured `logDirectory` (or one of the per-transport sub-directories).
 *   The original filesystem error is wrapped via the `cause` option (Node 16+).
 * - `INVALID_FORMAT` — `format` is not in the documented `"pretty" | "json"`
 *   union (e.g. typo'd as `"JSON"` or `"plain"`).
 */
export type LoggerOptionErrorCode =
  | "INVALID_LEVEL"
  | "INVALID_ROTATION"
  | "LOG_DIRECTORY_UNWRITABLE"
  | "INVALID_FORMAT";

/**
 * Structured option-validation error thrown by `createLogger()` when the
 * caller-supplied options are malformed in a way that is not the fault of the
 * underlying logger framework. Carries a stable `code` field consumers can
 * branch on, plus the standard `message` for human-readable diagnostics.
 *
 * Backward compatibility: the existing `TypeError` thrown by
 * `validateAdditionalTransports` is intentionally NOT swapped for this class
 * (some consumers may already be `instanceof TypeError`-checking that path).
 * Only NEW validation paths added in this batch throw `LoggerOptionError`.
 *
 * Documented codes: see {@link LoggerOptionErrorCode}.
 *
 * @example
 * ```ts
 * import { createLogger, LoggerOptionError } from "@hiprax/logger";
 *
 * try {
 *   createLogger({ level: "noisy" as any });
 * } catch (err) {
 *   if (err instanceof LoggerOptionError && err.code === "INVALID_LEVEL") {
 *     console.error("Logger level is invalid:", err.message);
 *   } else {
 *     throw err;
 *   }
 * }
 * ```
 */
export class LoggerOptionError extends Error {
  /** Stable, machine-readable error code; see {@link LoggerOptionErrorCode}. */
  public readonly code: LoggerOptionErrorCode;
  /**
   * Underlying cause (when wrapping a lower-level error like an `EACCES`
   * filesystem failure). Populated from the `options.cause` constructor
   * argument and exposed as a public field for back-compat with TS targets
   * that predate the standard `Error.cause` property (ES2022+).
   */
  public readonly cause?: unknown;

  constructor(code: LoggerOptionErrorCode, message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = "LoggerOptionError";
    this.code = code;
    if (options && "cause" in options) {
      this.cause = options.cause;
    }
  }
}

/**
 * Documented option-validation error codes emitted by
 * {@link RequestLoggerOptionError} thrown from `createRequestLogger()`.
 *
 * - `INVALID_LEVEL` — `level` is not in the npm-levels union (when supplied as
 *   a string; function-form `level` is not validated up front).
 * - `INVALID_MASK` — `maskBodyKeys`, `maskHeaderKeys`, `maskQueryKeys`, or
 *   `redactPaths` is not an array of strings (the `false` opt-out for the
 *   header/query masks is still accepted; only malformed array forms throw).
 * - `INVALID_BODY_LIMIT` — `maxBodyLength` is not a positive number or
 *   `Infinity`. `NaN`, `0`, negative values, and non-number types all throw
 *   this code. `undefined` is accepted and falls back to the default of `3000`.
 */
export type RequestLoggerOptionErrorCode = "INVALID_LEVEL" | "INVALID_MASK" | "INVALID_BODY_LIMIT";

/**
 * Structured option-validation error thrown by `createRequestLogger()` when
 * caller-supplied middleware options are malformed. Mirrors the shape of
 * {@link LoggerOptionError} but with a different name and a different set of
 * documented codes — see {@link RequestLoggerOptionErrorCode}.
 *
 * @example
 * ```ts
 * import { createRequestLogger, RequestLoggerOptionError } from "@hiprax/logger";
 *
 * try {
 *   createRequestLogger({ maskBodyKeys: [42 as unknown as string] });
 * } catch (err) {
 *   if (err instanceof RequestLoggerOptionError && err.code === "INVALID_MASK") {
 *     console.error("Mask configuration is invalid:", err.message);
 *   } else {
 *     throw err;
 *   }
 * }
 * ```
 */
export class RequestLoggerOptionError extends Error {
  /** Stable, machine-readable error code; see {@link RequestLoggerOptionErrorCode}. */
  public readonly code: RequestLoggerOptionErrorCode;
  /** Underlying cause when wrapping a lower-level error (see {@link LoggerOptionError.cause}). */
  public readonly cause?: unknown;

  constructor(code: RequestLoggerOptionErrorCode, message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = "RequestLoggerOptionError";
    this.code = code;
    if (options && "cause" in options) {
      this.cause = options.cause;
    }
  }
}
