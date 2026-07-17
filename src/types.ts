import type winston from "winston";

export type LogLevel = "error" | "warn" | "info" | "http" | "verbose" | "debug" | "silly";

/**
 * Framework-agnostic shape representing the subset of an HTTP request object
 * that the request-logging middleware actually reads. Compatible with Express
 * `Request`, raw Node `IncomingMessage` (with the standard `headers`/`url`
 * fields), Fastify, Koa, and any other adapter that exposes the same surface.
 *
 * Consumers do NOT need `express` (or `@types/express`) installed to import
 * this type. Express's `Request` is a structural superset, so casting an
 * Express `Request` to `LoggableRequest` is a zero-cost type widening.
 */
export interface LoggableRequest {
  /** HTTP method, e.g. `"GET"`, `"POST"`. */
  method?: string;
  /** Request URL as received by the server (may include query string). */
  url?: string;
  /** Express-style normalized URL; preferred over `url` when present. */
  originalUrl?: string;
  /** Request headers, lowercased keys per Node convention. */
  headers: Record<string, string | string[] | undefined>;
  /** Parsed body (set by upstream body-parser middleware). */
  body?: unknown;
  /** Express-resolved client IP, when available. */
  ip?: string;
  /** Underlying socket, used as a fallback source for the client IP. */
  socket?: { remoteAddress?: string };
  /** Express-style header lookup helper; checked before falling back to `headers`. */
  get?(name: string): string | undefined;
  /**
   * Indicates whether the client aborted the request before it was fully
   * consumed. Exposed by Node's `IncomingMessage` and Express's `Request`,
   * but optional on adapters that do not surface it.
   */
  aborted?: boolean;
}

/**
 * Framework-agnostic shape representing the subset of an HTTP response object
 * that the request-logging middleware actually reads and listens on.
 * Compatible with Express `Response`, raw Node `ServerResponse`, and any other
 * adapter that exposes the same EventEmitter-like surface.
 *
 * Consumers do NOT need `express` (or `@types/express`) installed to import
 * this type. Express's `Response` is a structural superset.
 */
export interface LoggableResponse {
  /** HTTP status code set by the handler. */
  statusCode: number;
  /** Returns the value of a previously-set response header. */
  getHeader(name: string): unknown;
  /** Returns all response headers as a single record. */
  getHeaders?(): Record<string, unknown>;
  /** Subscribes a one-shot listener for an event (`"finish"` or `"close"`). */
  once(event: string, listener: (...args: any[]) => void): unknown;
  /** Removes a previously-attached listener. */
  removeListener(event: string, listener: (...args: any[]) => void): unknown;
  /** True once the response body has been fully written. */
  writableEnded?: boolean;
  /** True once the underlying socket has been destroyed. */
  destroyed?: boolean;
}

/**
 * Framework-agnostic shape for the `next()` callback passed into a middleware
 * function. Mirrors Express's `NextFunction` without the `express` import.
 */
export type LoggableNext = (err?: unknown) => void;

/**
 * Framework-agnostic middleware signature returned by `createRequestLogger()`.
 * Compatible with Express `RequestHandler` (Express's req/res are structural
 * supersets of `LoggableRequest`/`LoggableResponse`), so consumers using
 * Express can mount the returned function directly without casts.
 */
export type LoggableMiddleware = (
  req: LoggableRequest,
  res: LoggableResponse,
  next: LoggableNext,
) => void;

export interface RotationStrategy {
  /**
   * Maximum size of a single log file before rotation occurs. Validated
   * synchronously by `createLogger()` against the contract enforced by
   * `winston-daily-rotate-file`'s internal `getMaxSize` parser:
   *
   * **Format:** `^(?:0\.)?\d+[kmg]$` (case-insensitive). Numeric byte size
   * with a single-letter `k` / `m` / `g` suffix, optionally prefixed by a
   * leading `0.` for fractional values.
   *
   * **Accepted examples:** `"20m"`, `"500k"`, `"1g"`, `"0.5m"`, `"20M"` (case
   * is ignored).
   *
   * **Rejected examples:** `"20mb"`, `"100b"`, `"1gb"` (long-form suffixes
   * are NOT honored by the upstream parser — `getMaxSize("20mb")` returns
   * `null` and silently disables size-based rotation), bare numbers like
   * `"500"` (upstream requires a unit suffix for `maxSize`), and the day
   * suffix `"20d"` (use `maxFiles` for day-based retention).
   *
   * Invalid values throw `LoggerOptionError({ code: "INVALID_ROTATION" })`.
   */
  maxSize?: string;
  /**
   * Maximum number of files to keep. Validated synchronously by
   * `createLogger()` against the contract enforced by
   * `winston-daily-rotate-file`'s max-files parser:
   *
   * **Format:** `^\d+d?$` (case-insensitive). Either a bare numeric file
   * count or a day-suffixed retention window.
   *
   * **Accepted examples:** `"7"`, `"500"`, `"14d"`, `"30d"`, `"14D"` (case is
   * ignored — `@hiprax/logger` lowercases the day suffix before handing the
   * value to `winston-daily-rotate-file`, whose own upstream parser checks
   * for a lowercase `"d"` only, so an uppercase `"14D"` is honored as 14
   * *days* rather than silently falling back to file-count semantics).
   *
   * **Rejected examples:** `"20m"`, `"20kb"`, `"1g"` (size suffixes are NOT
   * honored — `parseInt("20m")` silently coerces to `20` and the upstream
   * parser interprets it as "20 files", which is rarely the intent).
   *
   * Invalid values throw `LoggerOptionError({ code: "INVALID_ROTATION" })`.
   */
  maxFiles?: string;
  /**
   * Pattern used to name rotated files. Defaults to YYYY-MM-DD.
   */
  datePattern?: string;
  /**
   * Whether rotated files should be zipped.
   */
  zippedArchive?: boolean;
}

export interface LoggerOptions {
  moduleName?: string;
  /**
   * Directory to store log files. Created automatically when missing.
   */
  logDirectory?: string;
  /**
   * Logging level for all transports. Defaults to `"info"`.
   *
   * Winston uses the npm log-level hierarchy where lower numbers are more
   * severe and a level only emits messages whose severity is `<=` the
   * configured level. The hierarchy is:
   *
   * ```text
   * error (0) < warn (1) < info (2) < http (3) < verbose (4) < debug (5) < silly (6)
   * ```
   *
   * **Default behavior:** the default `"info"` level swallows `http`,
   * `verbose`, `debug`, and `silly` calls — they are silently dropped and
   * never reach any transport. To see HTTP request/response logs from
   * `createRequestLogger`, set this option to `"http"` (or lower-severity)
   * on the underlying logger.
   *
   * Common choices:
   * - `"error"` — production-critical only.
   * - `"warn"` — production with degraded-state visibility.
   * - `"info"` — default; standard production verbosity.
   * - `"http"` — include HTTP request/response logs from the middleware.
   * - `"debug"` / `"silly"` — development / deep diagnostics only.
   */
  level?: LogLevel;
  /**
   * Logging level used specifically for the console transport. Defaults to
   * the value of `level`. Same npm-level semantics as `level` — see that
   * option's docs for the full hierarchy.
   */
  consoleLevel?: LogLevel;
  /**
   * Enables or disables the console transport.
   */
  includeConsole?: boolean;
  /**
   * Enables or disables the module specific rotating file transport.
   */
  includeFile?: boolean;
  /**
   * Enables or disables the shared/global rotating file transport.
   */
  includeGlobalFile?: boolean;
  /**
   * Name used for the aggregated log file.
   */
  globalModuleName?: string;
  /**
   * Additional IANA timezones to render alongside UTC in the log output.
   */
  extraTimezones?: string | string[];
  /**
   * Rotation tuning for the module specific transport.
   */
  rotation?: RotationStrategy;
  /**
   * Rotation tuning for the global transport. Falls back to `rotation` when omitted.
   */
  globalRotation?: RotationStrategy;
  /**
   * Provides custom Winston transports that will be appended to the logger.
   *
   * The array is read once at construction time and a defensive copy is made.
   * Mutating the input array after `createLogger()` returns has no effect on
   * the logger's transport list. Each entry is duck-type validated as a
   * Winston-compatible transport (must expose `log` and `on` methods); invalid
   * entries cause `createLogger()` to throw a `TypeError` synchronously.
   */
  additionalTransports?: winston.transport[];
  /**
   * Optional callback invoked when any built-in or additional transport emits
   * an `error` event (filesystem failures, rotation errors, EACCES, ENOSPC,
   * gzip errors when `zippedArchive: true`, etc.). Receives the error and the
   * transport that emitted it.
   *
   * The callback is invoked inside a try/catch — a throwing callback does NOT
   * crash the process; the original error falls back to `console.error` and a
   * one-time warning is emitted noting the callback failed.
   *
   * If omitted, transport errors are written to `console.error` (the bare
   * `console`, not through this logger, to avoid recursion). Repeated identical
   * error messages are deduplicated to prevent log floods (up to 10 unique
   * messages tracked per logger).
   */
  onTransportError?: (err: Error, transport: winston.transport) => void;
  /**
   * Optional clock injection point used by the timestamp formatter. When
   * provided, the formatter calls `clock()` every time a log entry is captured
   * and uses the returned `Date` as the event timestamp. Defaults to the live
   * `Date` constructor.
   *
   * The clock is consulted at log-call time (i.e., when `logger.info(...)`
   * runs and the formatter pipeline executes), not at flush time, so async
   * transports / queued writes / back-pressured streams do not skew the
   * rendered timestamp.
   *
   * Primarily intended for deterministic tests; production code should leave
   * this option unset.
   */
  clock?: () => Date;
  /**
   * Whether this logger participates in process-wide crash capture so an
   * `uncaughtException` or `unhandledRejection` is recorded into the log output
   * (with full stack trace, process/OS info, and parsed trace) before the
   * process decides what to do next. Defaults to `true`.
   *
   * ## How capture works (changed in v1.0.0)
   *
   * Every capture-enabled logger registers with a single process-wide
   * coordinator. The coordinator owns **exactly one** `uncaughtException` and
   * **one** `unhandledRejection` listener for the whole process, no matter how
   * many loggers are created. (Prior versions let winston install one listener
   * pair PER logger, so an app with one logger per module hit Node's
   * `MaxListenersExceededWarning` once it passed ~10 modules.)
   *
   * When a fatal event fires it is logged **once**, through a single elected
   * logger (the first capture-enabled logger still registered). The crash is
   * written to all of that logger's transports (console + files + any
   * additional transports). Other loggers do not each re-log the same crash.
   * `captureUncaught: false` opts a logger out of registration entirely.
   *
   * See {@link exitOnUncaught} for what happens to the process afterward.
   */
  captureUncaught?: boolean;
  /**
   * Whether capturing a fatal event (`uncaughtException` / `unhandledRejection`)
   * should terminate the process with exit code `1` after the crash has been
   * logged and flushed. Defaults to `true`.
   *
   * **Breaking change in v1.0.0.** Prior versions always set `exitOnError:
   * false` on the underlying winston logger and installed no exit behavior of
   * their own, so a captured fatal was logged and the process was left running
   * in a potentially inconsistent state (the "limp on" behavior). The default
   * is now to restore Node's standard crash-on-fatal semantics: the crash is
   * logged, the elected logger's transports are flushed (bounded by an internal
   * timeout so a stuck transport cannot wedge the exit), and then the process
   * exits with code `1`.
   *
   * Set `exitOnUncaught: false` to keep logging fatals without exiting (the
   * pre-v1.0.0 behavior). Only meaningful when {@link captureUncaught} is
   * `true`. When several capture-enabled loggers set different values, the
   * value of the elected primary logger governs the process-level decision.
   *
   * This option governs BOTH `uncaughtException` and `unhandledRejection`.
   */
  exitOnUncaught?: boolean;
  /**
   * Controls ANSI colorization of the console transport's output. Defaults to
   * `{ level: true, message: true }` — both the `[LEVEL]` token AND the
   * message body are colorized so the prefix matches `pino-pretty` / `bunyan`
   * conventions.
   *
   * Accepts:
   * - `true` — color both the level token and the message body (equivalent to
   *   `{ level: true, message: true }`).
   * - `false` — disable colorization entirely; raw text is written to the
   *   console transport.
   * - An object — fine-grained control. `level` colorizes the `[LEVEL]`
   *   prefix; `message` colorizes the message body; `all` overrides both
   *   flags and colorizes everything when `true`.
   *
   * File transports are NEVER colorized regardless of this option.
   */
  colorize?: boolean | { message?: boolean; level?: boolean; all?: boolean };
  /**
   * Metadata keys whose values should be replaced with `"[REDACTED]"` in the
   * serialized log output. Matched **case-insensitively** and applied
   * **deeply** (including arrays and nested objects) before the metadata is
   * `JSON.stringify`'d into the log line.
   *
   * Targets the metadata object passed as the second-or-later argument to
   * `logger.info(...)` / `logger.warn(...)` / etc. — for example:
   *
   * ```ts
   * const logger = createLogger({ maskMetaKeys: ["password", "token"] });
   * logger.info("Login", { email: "u@example.com", password: "topsecret" });
   * // Logged metadata: { email: "u@example.com", password: "[REDACTED]" }
   * ```
   *
   * Defaults to `[]` (no redaction) for backward compatibility. The redaction
   * runs in BOTH the file pipeline and the console pipeline, so a key cannot
   * leak via one transport but not the other. Circular references are handled
   * gracefully (replaced with `"[Circular]"`).
   *
   * **Redaction boundary.** Deep redaction covers plain objects, arrays, and
   * the enumerable own fields of class/Error instances. Values that define
   * their own `toJSON()` (such as `Date`, `URL`, and custom serializable
   * classes) or that carry no enumerable own keys (`Map`, `Set`, `RegExp`,
   * etc.) are serialized via their built-in method and are **not** key-
   * redacted — use `redactPaths` or normalize to a plain object for those.
   */
  maskMetaKeys?: string[];
  /**
   * Output format applied to BOTH the file pipeline and the console pipeline.
   * Defaults to `"pretty"` for backward compatibility.
   *
   * **Contract:**
   * - `"pretty"` (default) — emits the existing human-readable printf form
   *   (UTC + extra-timezone header lines, `[LEVEL] (label)`, the message body,
   *   the optional stack, and a JSON-pretty-printed metadata block). Console
   *   output remains colorized; file output remains plain text.
   * - `"json"` — emits one JSON object per log line (newline-delimited JSON,
   *   NDJSON / JSON-Lines) suitable for log shippers like Datadog, Loki, ELK,
   *   Splunk, and Vector. Each line carries the canonical `level`, `message`,
   *   `timestamp` (the captured-at-call-time UTC string in
   *   `"YYYY-MM-DD HH:mm:ss"` form), an `errors({ stack: true })`-resolved
   *   `stack` field when the logged value is an `Error`, and any caller-
   *   supplied metadata keys merged at the top level. The {@link maskMetaKeys}
   *   redaction continues to apply BEFORE serialization, so secrets never
   *   reach the JSON line. Console output is the SAME raw JSON in `"json"`
   *   mode (no colorize) so downstream consumers piping `stdout` to a shipper
   *   see consistent payloads on every transport.
   *
   * The option is honored uniformly across the file transports (module + global)
   * and the console transport. Custom `additionalTransports` receive the SAME
   * formatted payload — a `"json"` logger feeds JSON lines to every entry.
   */
  format?: "pretty" | "json";
  /**
   * When `true`, replaces every `\r` and `\n` character in a string-typed
   * `info.message` with the literal escape sequences `"\\r"` and `"\\n"` BEFORE
   * the printf concatenates the message into the rendered log line. Defaults
   * to `false` for backward compatibility.
   *
   * **Threat model.** Most loggers — including Winston by default — write the
   * caller-supplied `message` verbatim. When the message string is built from
   * untrusted user input that has not been encoded (for example
   * `logger.info(req.body.username)`), an attacker can embed newline characters
   * to forge fake log entries that are byte-for-byte indistinguishable from a
   * real `[ERROR]` entry written by the application. A username such as
   * `"alice\n[ERROR] (admin)\nfake critical event"` writes three lines into
   * the log file, the second and third of which a SOC analyst, log parser, or
   * incident responder may treat as authentic.
   *
   * Setting `escapeMessageNewlines: true` flips the default to safe: embedded
   * newlines render as the visible literal sequences `\\n` / `\\r`, preserving
   * the original message contents for debugging while making forged log lines
   * obvious. Non-string messages (objects, errors) are unaffected — they are
   * already serialized through `JSON.stringify`, which escapes newlines.
   *
   * Mature production loggers (pino, bunyan, application-log shippers) ship
   * the equivalent of this option enabled by default; this package keeps it
   * opt-in so existing log-parsing pipelines that expect raw multi-line
   * messages continue to work unchanged.
   */
  escapeMessageNewlines?: boolean;
}

export interface TimestampContext {
  label: string;
  timezones: string[];
}

export type RequestLogEvent = "completed" | "aborted";

export interface RequestLogEntry {
  event: RequestLogEvent;
  method: string;
  url: string;
  statusCode: number;
  responseTimeMs: number;
  contentLength?: number;
  ip?: string;
  userAgent?: string;
  requestId?: string;
  /**
   * Captured request body (after redaction) when `includeRequestBody` is true.
   *
   * Shape stability: this field NEVER returns a mid-truncation string for
   * non-string inputs. When the body is a string and exceeds `maxBodyLength`,
   * it is sliced to `maxBodyLength - 1` characters and an ellipsis (`…`) is
   * appended so the total length is exactly `maxBodyLength`. When the body is
   * an object/array and the JSON-serialized form would exceed `maxBodyLength`,
   * the field is set to a structured envelope of the form
   * `{ _truncated: true, _originalLength: <number>, _preview: <string-snippet> }`
   * — preserving valid JSON shape for downstream log shippers.
   *
   * Snapshot timing: the body is captured at middleware ENTRY time (before
   * `next()` runs), so handler-time mutations of `req.body` (e.g. `req.body =
   * { redacted: true }`) do not change what gets logged.
   */
  requestBody?: unknown;
  requestHeaders?: Record<string, unknown>;
  responseHeaders?: Record<string, unknown>;
  context?: Record<string, unknown>;
  /**
   * Captured value of `res.writableEnded` at finalize time. `true` indicates
   * the response body was fully written before the socket closed; `false`
   * indicates the connection ended before the body could be flushed
   * (premature client disconnect, HTTP/2 reset, server crash).
   *
   * Used together with the `event` field to disambiguate a true abort from a
   * benign keep-alive close: `event === "aborted"` is set ONLY when the
   * `close` event fired AND `responseWritableEnded === false`. A `close` event
   * after a normal `finish` is NOT classified as aborted.
   */
  responseWritableEnded?: boolean;
  /**
   * Captured value of `res.destroyed` at finalize time. `true` means the
   * underlying socket was destroyed (typically due to a client disconnect or
   * server-initiated reset).
   */
  responseDestroyed?: boolean;
  /**
   * Captured value of `req.aborted` at finalize time when the underlying
   * request adapter exposes it. `true` indicates the client aborted the
   * request before it was fully consumed by the server. Older Node `http`
   * versions and Express `Request` instances expose this property; raw
   * adapters that do not are reported as `undefined`.
   */
  requestAborted?: boolean;
}

export interface RequestLoggerOptions {
  /**
   * Custom logger instance. When omitted a scoped logger will be created automatically.
   */
  logger?: winston.Logger;
  /**
   * Overrides the log level or dynamically derives it from the response status code.
   */
  level?: LogLevel | ((statusCode: number) => LogLevel);
  /**
   * Adds a label to differentiate multiple middleware instances.
   */
  label?: string;
  /**
   * Customizes the log message string written to the underlying logger. The
   * default builder produces `"METHOD URL STATUS DURATIONms (EVENT)"`.
   *
   * @param entry The fully resolved {@link RequestLogEntry} for the request,
   *   AFTER body redaction, header masking, URL-query masking, custom enrich,
   *   and surgical `redactPaths` rewrites have been applied. Mutating the
   *   entry inside `messageBuilder` is undefined behavior — read-only is the
   *   intended contract.
   * @returns The message string passed to `logger.log({ message, ... })`.
   */
  messageBuilder?: (entry: RequestLogEntry) => string;
  /**
   * Provides an escape hatch to skip logging for specific requests.
   */
  skip?: (req: LoggableRequest, res: LoggableResponse) => boolean;
  /**
   * Injects additional context into the structured payload. The returned
   * object becomes `entry.context` on the resolved {@link RequestLogEntry};
   * returning `null` / `undefined` leaves `entry.context` unset.
   *
   * @param req The {@link LoggableRequest} (Express `Request`-compatible) the
   *   middleware received.
   * @param res The {@link LoggableResponse} (Express `Response`-compatible)
   *   the middleware is finalizing on. By the time `enrich` is called, the
   *   response has either fully finished (`finish` event) or aborted
   *   (`close` event), so headers and status code are stable.
   * @param durationMs Wall-clock duration in milliseconds since middleware
   *   entry (or since the externally-provided `req[REQUEST_START_SYMBOL]`
   *   when set).
   */
  enrich?: (
    req: LoggableRequest,
    res: LoggableResponse,
    durationMs: number,
  ) => Record<string, unknown> | null | undefined;
  /**
   * When true, includes request headers. Provide an allow list to control which keys to emit.
   */
  includeRequestHeaders?: boolean | string[];
  /**
   * When true, includes response headers. Provide an allow list to control which keys to emit.
   */
  includeResponseHeaders?: boolean | string[];
  /**
   * When true, logs the parsed request body. Provide an allow list of keys to redact everything else.
   */
  includeRequestBody?: boolean;
  /**
   * Caps serialized body size to guard against log-flood attacks from huge
   * payloads. Defaults to `3000` (characters).
   *
   * Must be a **positive number** or `Infinity` when supplied. `Infinity`
   * disables truncation entirely (body is always logged in full). `NaN`, `0`,
   * negative values, and non-number types throw
   * `RequestLoggerOptionError({ code: "INVALID_BODY_LIMIT" })` synchronously
   * at middleware-creation time.
   */
  maxBodyLength?: number;
  /**
   * Keys within the request body that should be replaced with `[REDACTED]`.
   * Matched **case-insensitively** and applied **deeply** (including arrays
   * and nested objects).
   *
   * **Redaction boundary.** Deep redaction covers plain objects, arrays, and
   * the enumerable own fields of class/Error instances. Values that define
   * their own `toJSON()` (such as `Date`, `URL`, and custom serializable
   * classes) or that carry no enumerable own keys (`Map`, `Set`, `RegExp`,
   * etc.) are serialized via their built-in method and are **not** key-
   * redacted — use `redactPaths` or normalize to a plain object for those.
   */
  maskBodyKeys?: string[];
  /**
   * Header names whose values should be replaced with `[REDACTED]` in BOTH
   * request and response headers. Matched case-insensitively, applied AFTER
   * the `includeRequestHeaders` / `includeResponseHeaders` allow-list filter.
   *
   * Defaults to `["authorization", "cookie", "set-cookie", "x-api-key",
   * "proxy-authorization"]` (a safe-defaults list that prevents the most
   * common secret-in-header leaks). Pass `false` to opt out entirely and
   * surface raw header values; pass an explicit array to override the list.
   */
  maskHeaderKeys?: string[] | false;
  /**
   * Query-string parameter names whose values should be replaced with
   * `[REDACTED]` in the logged `req.url` / `req.originalUrl`. Matched
   * case-insensitively. The raw query string is edited **in place**: only a
   * matched parameter's value is replaced with `[REDACTED]`; every other byte
   * — parameter order, sibling-param percent-encoding (`%20`, `%5B`/`%5D`,
   * `%2B`), the `//host` authority of protocol-relative URLs, and the fragment
   * — is preserved exactly. Values are never re-encoded or re-serialized.
   *
   * Defaults to `["token", "access_token", "api_key", "apikey", "key", "code",
   * "secret", "password"]` (a safe-defaults list covering OAuth callback
   * codes, API keys, and ad-hoc bearer tokens). Pass `false` to opt out
   * entirely and surface raw query strings; pass an explicit array to
   * override the list.
   */
  maskQueryKeys?: string[] | false;
  /**
   * Dot-notation paths into the resolved {@link RequestLogEntry} whose values
   * should be surgically replaced with `[REDACTED]`. Useful for masking a
   * specific nested body field that is not safe to mask by key alone (e.g.
   * `["body.user.password"]` — note that `body.*` resolves against the
   * captured `requestBody` object). Missing intermediate keys are handled
   * gracefully (no-op).
   *
   * Must be an array of strings (or `undefined`). A non-array value (e.g. the
   * typo `"body.password"` instead of `["body.password"]`) throws
   * `RequestLoggerOptionError({ code: "INVALID_MASK" })` at middleware-creation
   * time so the misconfiguration surfaces immediately rather than silently
   * failing to redact the intended secret.
   *
   * Defaults to `[]`.
   *
   * **Redaction boundary note.** Deep redaction (via `maskBodyKeys`) covers
   * plain objects, arrays, and the enumerable own fields of class/Error
   * instances but does **not** key-redact values that define their own
   * `toJSON()`. Use `redactPaths` for surgical path-based replacement of such
   * values (e.g. `["body.user.createdAt"]` to blank a `Date` field).
   */
  redactPaths?: string[];
  /**
   * Hard override that can enable/disable request logging (Option 2).
   */
  loggingEnabled?: boolean;
  /**
   * Environment-aware control that decides when logging should run (Option 1).
   * - `"always"` logs in every environment.
   * - `"never"` disables logging.
   * - `"dev-only"` automatically matches common dev env values (`dev`, `development`, `local`, case-insensitive).
   * - `"prod-only"` auto-matches typical production env values (`prod`, `production`, `live`).
   * - `"test-only"` auto-matches common test env values (`test`, `testing`, `qa`, `staging`).
   * - Provide a config object for custom environment variable/value matching.
   */
  loggingMode?: RequestLoggingMode;
  /**
   * When true, attaches the structured HTTP payload under the `info.http` key.
   */
  includeHttpContext?: boolean;
}

/**
 * Backward-compatible alias for {@link LoggableMiddleware}. Kept so existing
 * consumers importing `ExpressMiddleware` continue to compile after the
 * middleware was made framework-agnostic. New code should prefer
 * `LoggableMiddleware`.
 */
export type ExpressMiddleware = LoggableMiddleware;

export type RequestLoggingMode =
  | "always"
  | "never"
  | "dev-only"
  | "prod-only"
  | "test-only"
  | RequestLoggingEnvironmentConfig;

export interface RequestLoggingEnvironmentConfig {
  /**
   * Environment variables to inspect, in priority order.
   * Defaults to `["NODE_ENV", "APP_ENV", "ENV"]`.
   */
  sources?: string[];
  /**
   * Case-insensitive values that enable logging when matched.
   * Defaults to the same values as `"dev-only"`.
   */
  allow?: string[];
  /**
   * When `true`, logging remains enabled if no environment sources are found.
   * Defaults to `false`.
   */
  fallback?: boolean;
}
