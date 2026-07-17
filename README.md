# @hiprax/logger

Fully typed, production-grade logging toolkit for Node.js applications. Built on top of Winston with first-class TypeScript support, rotating file transports, timezone mirroring, and an HTTP middleware that outperforms traditional solutions.

[![npm version](https://img.shields.io/npm/v/@hiprax/logger)](https://www.npmjs.com/package/@hiprax/logger)
[![npm provenance](https://img.shields.io/badge/npm-provenance%20attested-blue?logo=npm&logoColor=white)](https://www.npmjs.com/package/@hiprax/logger)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![CI](https://github.com/Hiprax/logger/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/Hiprax/logger/actions/workflows/ci.yml)
[![CodeQL](https://github.com/Hiprax/logger/actions/workflows/codeql.yml/badge.svg?branch=main)](https://github.com/Hiprax/logger/actions/workflows/codeql.yml)
[![codecov](https://codecov.io/gh/Hiprax/logger/branch/main/graph/badge.svg)](https://codecov.io/gh/Hiprax/logger)
[![Node.js](https://img.shields.io/badge/Node.js-18+-green.svg)](https://nodejs.org/)

---

## Table of Contents

- [Features](#features)
- [Installation](#installation)
- [TypeScript Module Resolution](#typescript-module-resolution)
- [Quick Start](#quick-start)
- [API](#api)
  - [createLogger](#createloggeroptions-loggeroptions)
  - [HTTP Request Logging Middleware (framework-agnostic)](#http-request-logging-middleware-framework-agnostic)
  - [Environment-Aware Request Logging](#environment-aware-request-logging)
  - [Timezone Handling](#timezone-handling)
  - [Custom Transports](#custom-transports)
  - [JSON Output for Log Shippers](#json-output-for-log-shippers)
  - [Silent / No-op Logger for Libraries & SSR](#silent--no-op-logger-for-libraries--ssr)
  - [Crash Capture](#crash-capture)
- [Log Output Format](#log-output-format)
- [Migration to v1.0.0](#migration-to-v100)
- [Scripts](#scripts)
- [Testing & Coverage](#testing--coverage)
- [Security Notes](#security-notes)
- [Contributing](#contributing)
- [License](#license)
- [Links](#links)

---

## Features

- Multi-target logging (console, per-module files, shared global file, custom transports). Console output is colorized and omits timestamps so only rotating files capture the full timeline.
- Daily rotation with independent retention rules for module and global files
- Guaranteed UTC timestamps plus optional verified IANA timezone mirrors
- Automatic log directory creation (including nested module scopes like `security/failedLogins`)
- Batteries-included Express middleware with structured HTTP payloads, body redaction, and header filtering
- Graceful fallback for unknown logger methods (warns once, re-routes to `info()`)
- Environment-aware request logging with built-in presets (`dev-only`, `prod-only`, `test-only`) and custom rules
- Optional `format: "json"` (NDJSON) for first-class log shipper support (Datadog, Loki, ELK, Splunk)
- Built-in `createNoopLogger()` singleton for libraries / SSR / tests that want a silent default
- Zero-config ESM & CommonJS dual builds with rich IntelliSense documentation
- Comprehensive Jest suite with genuine 100% coverage enforcement (no `c8 ignore` directives masking branches)

## Installation

```bash
npm install @hiprax/logger
```

> The package ships with precompiled dual builds (`.mjs` for ESM, `.cjs` for CommonJS). No transpilation is required in consuming projects.

## TypeScript Module Resolution

The `exports` map declares **per-condition** type declarations so both module systems resolve a `.d.ts` file that actually matches their runtime shape:

```json
"exports": {
  ".": {
    "import": { "types": "./dist/index.d.ts", "default": "./dist/index.mjs" },
    "require": { "types": "./dist/index.d.cts", "default": "./dist/index.cjs" }
  }
}
```

Under `"moduleResolution": "node16"` or `"nodenext"` (the TypeScript settings that mirror Node's real ESM/CJS dual-resolution behavior), `require("@hiprax/logger")` resolves the CommonJS-shaped `dist/index.d.cts` declaration and `import ... from "@hiprax/logger"` resolves the ESM `dist/index.d.ts` declaration — both are emitted by `npm run build`. Previously the package only published a single top-level `types` field pointing at the ESM declaration, which made CJS consumers under `node16`/`nodenext` fail to compile with `TS1479 ("the current file is a CommonJS module... cannot be imported")`. Projects using older `moduleResolution` settings (`"node"`, `"bundler"`) are unaffected — they continue to resolve via the legacy top-level `types` field.

## Quick Start

```ts
import { createLogger } from "@hiprax/logger";

const securityLogger = createLogger({
  moduleName: "security/failedLogins",
  extraTimezones: ["Europe/London"],
});

securityLogger.warn(`Failed login attempt\nEmail: ${email}\nIP: ${req.realIp}`);
```

CommonJS usage:

```js
const { createLogger } = require("@hiprax/logger");
```

## API

### `createLogger(options?: LoggerOptions)`

Creates a fully configured Winston logger with safe defaults, rotating files, UTC timestamps, and optional timezone mirrors. Instances are cached by `moduleName` + `logDirectory` — calling `createLogger()` with the same configuration from multiple files returns the same logger, preventing duplicate transports, file handles, and console output.

| Option                  | Type                                                               | Default                          | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ----------------------- | ------------------------------------------------------------------ | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `moduleName`            | `string`                                                           | `'global'`                       | Label used in log lines and for module-specific files. Supports nested scopes (`security/failedLogins`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `logDirectory`          | `string`                                                           | `<process.cwd()>/logs`           | Target directory (auto-created).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `level`                 | `LogLevel`                                                         | `'info'`                         | Default level for all transports. See [Log levels](#log-levels) below.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `consoleLevel`          | `LogLevel`                                                         | `level`                          | Console-specific level override. Same hierarchy as `level`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `includeConsole`        | `boolean`                                                          | `true`                           | Enables console logging. Console lines are colorized and omit timestamps.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `includeFile`           | `boolean`                                                          | `true`                           | Enables module-specific rotating file logging.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `includeGlobalFile`     | `boolean`                                                          | `true`                           | Enables shared rotating file logging.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `globalModuleName`      | `string`                                                           | `'all-logs'`                     | Label for the shared log file.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `extraTimezones`        | `string \| string[]`                                               | `[]`                             | Additional IANA zones rendered beside UTC. Validity is enforced; invalid zones throw `InvalidTimezoneError`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `rotation`              | `RotationStrategy`                                                 | 20 MB / 14 days / daily          | Rotation config for the module file.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `globalRotation`        | `RotationStrategy`                                                 | `rotation`                       | Override rotation for the shared file. Falls back to `rotation` when omitted.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `additionalTransports`  | `winston.transport[]`                                              | `[]`                             | Appends custom transports (e.g., HTTP, Kafka, Stream). Each entry is duck-type validated (must expose `log` and `on` methods) at construction time; invalid entries throw `TypeError`. The array is read once and defensively copied — mutating the input array after `createLogger()` returns has no effect. **Note:** if an entry sets winston's `handleExceptions` / `handleRejections`, both are cleared (with a one-time warning), which changes where crashes land — see [Crash Capture](#crash-capture).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `onTransportError`      | `(err, transport) => void`                                         | `undefined`                      | Optional callback invoked when any transport (built-in or `additionalTransports`) emits an `error` event (rotation/disk failures, EACCES, ENOSPC, gzip errors). Invoked inside a try/catch so a throwing callback cannot crash the process; errors then fall back to `console.error`. When omitted, errors go directly to `console.error` (the bare `console`, never through this logger). Repeated identical messages are deduplicated (up to 10 unique messages tracked per logger).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `clock`                 | `() => Date`                                                       | `() => new Date()`               | Optional clock injection point used by the timestamp formatter. The clock is consulted at log-call time (not flush time), so async transports / queued writes / back-pressured streams cannot skew the rendered timestamp. Primarily intended for deterministic tests; production code should leave this option unset.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `captureUncaught`       | `boolean`                                                          | `true`                           | When `true`, registers this logger with a process-wide crash coordinator that captures `uncaughtException` and `unhandledRejection` into the log output (full stack, plus `process` / `os` / parsed `trace` detail). The coordinator owns **exactly one** listener pair for the whole process regardless of how many loggers you create, and a crash is logged **once**, through a single elected logger — see [Crash Capture](#crash-capture). When `false`, this logger does not participate and adds no process listener.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `exitOnUncaught`        | `boolean`                                                          | `true`                           | Whether a captured fatal terminates the process with exit code `1` after the crash is logged and flushed (bounded internally so a stuck transport cannot wedge the exit). Governs **both** `uncaughtException` and `unhandledRejection`. Set to `false` to log fatals without exiting (the pre-1.0.0 behavior). Only meaningful when `captureUncaught` is `true`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `colorize`              | `boolean \| { message?: boolean; level?: boolean; all?: boolean }` | `{ level: true, message: true }` | Controls ANSI colorization of the console transport. `false` disables colorization entirely; `true` colors both the `[LEVEL]` token and the message body; an object honors `level` / `message` flags independently, with `all: true` overriding both. File transports are never colorized.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `maskMetaKeys`          | `string[]`                                                         | `[]`                             | Metadata keys whose values are replaced with `[REDACTED]` before serialization. Matched **case-insensitively** and applied **deeply** (arrays + nested objects, including the enumerable own fields of class/`Error` instances). Targets the metadata object passed as the second-or-later argument to `logger.info(...)` / `logger.warn(...)` / etc. — for example, `logger.info("Login", { password: "topsecret" })` with `maskMetaKeys: ["password"]` writes `"password": "[REDACTED]"`. Empty by default for backward compatibility. The redaction runs in BOTH file and console pipelines. **Your objects are never mutated:** the redacted line is built from a copy, so a logged object still holds its original values afterwards and stays safe to persist or return. **Redaction boundary:** values that define their own `toJSON()` (`Date`, `URL`, custom serializable classes) or carry no enumerable own keys (`Map`, `Set`, `RegExp`) are serialized via that method/built-in and are **not** key-redacted — normalize to a plain object first if those need masking. |
| `format`                | `"pretty" \| "json"`                                               | `"pretty"`                       | Output format for BOTH the file pipeline and the console pipeline. `"pretty"` (default) emits the existing human-readable printf form. `"json"` emits one JSON object per line (NDJSON / JSON-Lines) suitable for log shippers like Datadog, Loki, ELK, Splunk, and Vector — see [JSON Output for Log Shippers](#json-output-for-log-shippers) below.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `escapeMessageNewlines` | `boolean`                                                          | `false`                          | When `true`, replaces `\n` / `\r` in string messages **and in a string `stack`** with the visible escape sequences `\\n` / `\\r` BEFORE the printf renders the line. Mitigates log-injection forging via untrusted user input, including a payload wrapped in an `Error`. Collapses a multi-line stack to one line while on — see [Security Notes](#security-notes).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

### Log levels

Winston uses the npm log-level hierarchy. Lower numbers are more severe; a logger only emits messages whose severity is `<=` the configured level:

| Level     | Numeric |
| --------- | ------- |
| `error`   | 0       |
| `warn`    | 1       |
| `info`    | 2       |
| `http`    | 3       |
| `verbose` | 4       |
| `debug`   | 5       |
| `silly`   | 6       |

**Important:** the default `level: "info"` swallows `http`, `verbose`, `debug`, and `silly` calls — a message logged at one of those levels is silently dropped and never reaches any transport. This does **not** hide `createRequestLogger` output by default: the request middleware emits normal request/response logs at `info` / `warn` / `error` (status-code-driven), all of which the default `level: "info"` already passes. The `"http"` level only becomes relevant if you override the middleware's `level` option to winston's `"http"` — then the underlying logger's `level` must also be `>= "http"`:

```ts
const httpLogger = createLogger({ moduleName: "http", level: "http" });
app.use(createRequestLogger({ logger: httpLogger, level: () => "http" }));
```

### RotationStrategy

```ts
interface RotationStrategy {
  maxSize?: string; // e.g., '20m', '200k'
  maxFiles?: string; // e.g., '14d', '30'
  datePattern?: string; // default: 'YYYY-MM-DD'
  zippedArchive?: boolean;
}
```

**Defaults:** the package exports the frozen `defaultRotation` constant (`maxSize: "20m"`, `maxFiles: "14d"`, `datePattern: "YYYY-MM-DD"`, `zippedArchive: false`) plus a `getDefaultRotation()` helper that returns a fresh, mutable deep copy. Use either to override one or two fields without copying the literal:

```ts
import { createLogger, defaultRotation, getDefaultRotation } from "@hiprax/logger";

// Spread the frozen export to keep most defaults but bump retention.
const longRetention = createLogger({
  rotation: { ...defaultRotation, maxFiles: "30d" },
});

// Or grab a mutable copy and edit it imperatively.
const rotation = getDefaultRotation();
rotation.maxFiles = "30d";
rotation.zippedArchive = true;
const archived = createLogger({ rotation });
```

The exported `defaultRotation` is frozen — direct mutation throws under strict mode. Use `getDefaultRotation()` whenever you need to mutate the result.

**Unknown method fallback**: If you call a method that does not exist on the logger (e.g., `logger.success("done")`), it will log a warning once and route the message through `info()` instead of throwing.

**Instance caching**: Logger instances are cached by `moduleName` + the **resolved** `logDirectory`. The directory is normalized via `path.resolve` (and on Windows lowercased for the cache key only) so `"./logs"`, `path.resolve("./logs")`, and (on Windows) `C:\Logs` vs `c:\logs` collapse to a single cache entry. Symlinks are collapsed via `fs.realpathSync.native` whether or not the directory exists yet (when it is missing, the nearest existing ancestor is resolved and the not-yet-created tail is re-joined), so the cache key is stable across the first-call directory-creation boundary. The same call from different files returns the same instance. Use `resetLoggerRegistry()` to clear the cache (useful for testing or hot-reload scenarios):

```ts
import { resetLoggerRegistry } from "@hiprax/logger";

resetLoggerRegistry(); // clears all cached instances
```

**Conflicting options on a cached key**: If `createLogger()` is called a second time for the same `moduleName` + `logDirectory` with different `level`, `extraTimezones`, `rotation`, etc., the cached instance is returned and the new options are ignored. A one-time `console.warn` lists the divergent fields so the silent foot-gun is visible. `extraTimezones` is validated **before** the cache lookup, so passing an invalid IANA identifier always throws `InvalidTimezoneError` regardless of cache state. `additionalTransports` are compared by count only because function/class instances are not stably equal-checked.

**Lazy directory creation**: When both `includeFile` and `includeGlobalFile` are `false`, `createLogger()` does NOT touch the filesystem — no directory is created and no error is thrown when `logDirectory` does not exist or is read-only. This makes the logger safe to use in tests, AWS Lambda (where the project root is read-only outside `/tmp`), and stream-only setups. When at least one file transport is enabled, the resolved `logDirectory` (and the per-transport subdirectory for nested module names like `security/failedLogins`) is created idempotently via `fs.mkdirSync(..., { recursive: true })`.

---

### Graceful Shutdown

Production deployments (especially those running behind a load balancer or in a container orchestrator) usually receive `SIGTERM` shortly before the process is killed. To make sure buffered logs in the rotating-file transport are flushed before the process exits, use `shutdownLogger(logger, options?)` or `shutdownAllLoggers(options?)`:

```ts
import { createLogger, shutdownAllLoggers } from "@hiprax/logger";

const logger = createLogger({ moduleName: "auth" });

const handleSignal = async (signal: NodeJS.Signals) => {
  logger.info(`Received ${signal}; flushing logs and exiting…`);
  try {
    // Walks the registry and shuts down every cached logger in parallel.
    // The timeout applies INDEPENDENTLY to each logger.
    await shutdownAllLoggers({ timeoutMs: 5000 });
  } catch (err) {
    // The shutdown timed out — at least one transport did not flush in time.
    // Falling through to `process.exit` is intentional: the user requested
    // termination, and waiting forever for a stuck transport would defeat
    // the purpose of the SIGTERM contract.
    console.error("Logger shutdown timed out:", err);
  } finally {
    process.exit(0);
  }
};

process.once("SIGTERM", handleSignal);
process.once("SIGINT", handleSignal);
```

`shutdownLogger(logger, { timeoutMs = 5000 })` calls `logger.end()` (winston's flush API) and awaits the `finish` event on every transport. Once it resolves, the rotating file's bytes really are on disk — so it is safe to `process.exit(0)` immediately afterwards, as the example above does. It rejects with a `shutdownLogger timed out after <timeoutMs>ms…` error when any transport fails to flush in time. The function is **idempotent for successful shutdowns** — calling it twice returns the cached resolved promise without issuing a second `logger.end()`. A **timed-out shutdown is retryable**: the cached rejected promise is evicted so a subsequent call with a longer `timeoutMs` can start a fresh flush attempt.

`shutdownAllLoggers(options?)` is a convenience that walks the internal registry and calls `shutdownLogger()` on every cached logger in parallel. Both helpers `unref()` the timeout's `setTimeout` handle so a pending shutdown does not keep the event loop alive on its own.

**Shutting a logger down also evicts it from the internal registry**, so a later `createLogger()` for the same `moduleName` + `logDirectory` builds a brand-new instance with live transports instead of returning the ended one. This matters for worker recycles, dev hot-reloads, and any shutdown-then-recreate loop:

```ts
const a = createLogger({ moduleName: "auth" });
await shutdownLogger(a);

const b = createLogger({ moduleName: "auth" }); // fresh instance, NOT `a`
b.info("still logged"); // reaches disk
```

The eviction happens synchronously as soon as `end()` is issued, on the **timeout path as well as the success path** — a timed-out logger has already been ended, so it is no more usable than a successfully flushed one. Tearing a logger down with `logger.close()` or `logger.end()` directly evicts it too.

Two things to know: only the _cache_ is cleared, so a reference you already hold (or one captured by a `createRequestLogger` middleware) stays ended; and while a timed-out shutdown is still retryable through the reference you hold, `shutdownAllLoggers()` iterates the registry and so will not pick it up a second time.

---

### HTTP Request Logging Middleware (framework-agnostic)

The middleware is framework-agnostic — it consumes a request/response pair via the local `LoggableRequest` / `LoggableResponse` shapes and never imports `express`. Express is the canonical example below, but Fastify, Koa, raw Node `http`, or any adapter that produces objects matching those shapes (a `method`/`url`/`headers`-bearing request and an `EventEmitter`-style response) work the same way. The optional `peerDependencies.express` entry in `package.json` is documentation-only — it signals the most common host framework but imposes no real coupling.

```ts
import express from "express";
import { createRequestLogger } from "@hiprax/logger";

const app = express();
app.use(express.json());

app.use(
  createRequestLogger({
    includeRequestBody: true,
    includeRequestHeaders: ["authorization"],
    includeResponseHeaders: true,
    maskBodyKeys: ["password", "token"],
    enrich: (req) => ({ tenantId: req.headers["x-tenant-id"] }),
  }),
);
```

When `includeHttpContext` is enabled, the middleware attaches rich structured metadata via `info.http` while emitting a concise human-readable message. It relies on plain Node events (`finish`/`close`) with a guard against double-logging, and does **not** depend on `on-finished`.

**HTTP-level visibility:** the middleware emits `info`/`warn`/`error` for normal request/response logs (status-code-driven), so the default logger `level: "info"` is enough to see them. If you customize the `level` option to use winston's `"http"` level (e.g. `level: () => "http"`), the underlying logger's `level` MUST also be `>= "http"` (e.g. `"http"`, `"verbose"`, `"debug"`, `"silly"`) — otherwise the entries are silently dropped per the npm-level hierarchy above. Pass an explicit `logger` option pointed at a `createLogger({ level: "http" })` instance when using `"http"`.

**Mounting position (response-time accuracy):** the middleware captures its start timestamp the moment its `(req, res, next) =>` runs. To make `responseTimeMs` reflect the true end-to-end latency, **mount this middleware first** — before slow body parsers, authentication middleware, rate limiters, etc. If you cannot move it to the top of the stack, set the start timestamp from an earlier instrumentation hook using the exported `REQUEST_START_SYMBOL`:

```ts
import express from "express";
import { createRequestLogger, REQUEST_START_SYMBOL } from "@hiprax/logger";

const app = express();

// First piece of middleware — captures the earliest possible timestamp.
app.use((req, _res, next) => {
  (req as any)[REQUEST_START_SYMBOL] = process.hrtime.bigint();
  next();
});

// Slow body parser, authentication, etc.
app.use(express.json());

// Logger picks up the start time from the symbol.
app.use(createRequestLogger({ includeHttpContext: true }));
```

The override MUST be a `bigint` produced by `process.hrtime.bigint()`. Any other value (a `number`, a `Date`, etc.) is silently ignored and the middleware falls back to capturing its own start at entry time. (Requires Node 10.7+ for `process.hrtime.bigint()` — well below the package's `engines.node: >=18.0.0` floor.)

**Aborted vs completed classification:** the middleware listens on both `res.once("finish")` and `res.once("close")`. A `close` event is classified as `event === "aborted"` ONLY when `res.writableEnded` is falsy — i.e. the response body was NOT fully written before the socket closed. A `close` after a normal `finish` (HTTP/1 keep-alive socket teardown, HTTP/2 stream end) reports `event === "completed"`. The structured payload also surfaces `responseWritableEnded`, `responseDestroyed`, and `requestAborted` (when available) so downstream consumers can distinguish abort causes.

**Body snapshot timing:** `req.body` is captured at middleware ENTRY time (before `next()` runs). Handler-time mutation of `req.body` (e.g. `req.body = { redacted: true }`) does NOT affect what gets logged. The snapshot is a shallow reference, not a deep clone — handlers that mutate properties INSIDE the body object should redact those keys via `maskBodyKeys` / `redactPaths`. Deep cloning was rejected as a default because (a) it adds non-trivial per-request cost and (b) the common mutation pattern is whole-pointer reassignment, which the shallow reference already isolates against.

| Option                   | Type                                                                     | Default                               | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------ | ------------------------------------------------------------------------ | ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `logger`                 | `winston.Logger`                                                         | Scoped `http` logger                  | Provide your own logger or use the auto-created scoped one.                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `level`                  | `LogLevel \| (status: number) => LogLevel`                               | Auto (`info`/`warn`/`error`)          | Override severity. The default maps 5xx to `error`, 4xx to `warn`, rest to `info`.                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `label`                  | `string`                                                                 | —                                     | Included in the auto-generated logger name (`http/<label>`).                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `messageBuilder`         | `(entry) => string`                                                      | `"METHOD URL status latency (event)"` | Customize the final message string.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `skip`                   | `(req, res) => boolean`                                                  | —                                     | Return `true` to skip logging for specific requests.                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `enrich`                 | `(req, res, durationMs) => Record<string, unknown> \| null \| undefined` | —                                     | Inject extra context (e.g., tenant, user). Attached under `entry.context`. Returning `null` or `undefined` is treated as "no extra context" — `entry.context` is left unset.                                                                                                                                                                                                                                                                                                                                               |
| `includeRequestHeaders`  | `boolean \| string[]`                                                    | `false`                               | `true` for all headers, or an array of allowed header names.                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `includeResponseHeaders` | `boolean \| string[]`                                                    | `false`                               | Same as above for response headers.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `includeRequestBody`     | `boolean`                                                                | `false`                               | Logs parsed request body (with redaction support).                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `maskBodyKeys`           | `string[]`                                                               | `[]`                                  | Keys replaced with `[REDACTED]`. Applies deeply and case-insensitively, including arrays and the enumerable own fields of class/`Error` instances. Values with a custom `toJSON()` (`Date`, `URL`) or no enumerable keys (`Map`, `Set`) pass through un-redacted — use `redactPaths` for those.                                                                                                                                                                                                                            |
| `maskHeaderKeys`         | `string[] \| false`                                                      | safe defaults (see below)             | Header values to redact in BOTH request and response headers (case-insensitive). Pass `false` to opt out.                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `maskQueryKeys`          | `string[] \| false`                                                      | safe defaults (see below)             | Query-string param values to redact in `req.url` / `req.originalUrl` (case-insensitive). Pass `false` to opt out.                                                                                                                                                                                                                                                                                                                                                                                                          |
| `redactPaths`            | `string[]`                                                               | `[]`                                  | Dot-paths into the resolved entry for surgical redaction (e.g. `["body.user.password"]`). Must be an array of strings; a non-array (e.g. the bare string `"body.password"`) throws `RequestLoggerOptionError({ code: "INVALID_MASK" })`.                                                                                                                                                                                                                                                                                   |
| `maxBodyLength`          | `number`                                                                 | `3000`                                | Caps serialized body size to prevent log floods. String bodies are truncated to exactly `maxBodyLength` characters with a trailing `…`. Object/array bodies whose JSON form exceeds the limit return a structured envelope `{ _truncated: true, _originalLength, _preview }` so the field's shape never flips between an object and a string mid-truncation. Must be a positive number or `Infinity` (unlimited); `NaN`, `0`, negatives, and non-numbers throw `RequestLoggerOptionError({ code: "INVALID_BODY_LIMIT" })`. |
| `includeHttpContext`     | `boolean`                                                                | `false`                               | Attaches the structured `RequestLogEntry` payload under `info.http`.                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `loggingEnabled`         | `boolean`                                                                | `true`                                | Hard enable/disable switch.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `loggingMode`            | `RequestLoggingMode`                                                     | `'always'`                            | Environment-aware control. See below.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |

---

### Environment-Aware Request Logging

The `loggingMode` option controls when request logging is active, based on environment variables.

**Built-in presets:**

| Mode          | Matched env values (case-insensitive) | Env sources checked (in order) |
| ------------- | ------------------------------------- | ------------------------------ |
| `'always'`    | Always enabled                        | —                              |
| `'never'`     | Always disabled                       | —                              |
| `'dev-only'`  | `dev`, `development`, `local`         | `NODE_ENV`, `APP_ENV`, `ENV`   |
| `'prod-only'` | `prod`, `production`, `live`          | `NODE_ENV`, `APP_ENV`, `ENV`   |
| `'test-only'` | `test`, `testing`, `qa`, `staging`    | `NODE_ENV`, `APP_ENV`, `ENV`   |

**Custom configuration:**

```ts
createRequestLogger({
  loggingMode: {
    sources: ["DEPLOYMENT_STAGE"], // env vars to check (priority order)
    allow: ["staging", "qa"], // values that enable logging
    fallback: false, // behavior when no env source is found
  },
});
```

**Tips:**

- Pair `loggingEnabled` with boolean expressions for one-line toggles: `loggingEnabled: process.env.FEATURE_LOGS === "on"`
- The `loggingMode` decision is evaluated once at middleware creation time, not per-request
- Keep log output lightweight by enabling `includeHttpContext` only when you need the full structured payload

---

### Timezone Handling

- UTC is always logged in file output.
- Additional zones must be valid IANA identifiers (validated by `moment-timezone`). Invalid entries throw `InvalidTimezoneError`.
- Provide a single string or an array:

```ts
createLogger({
  extraTimezones: ["Europe/London", "America/New_York"],
});
```

- Duplicate timezone entries are automatically deduplicated.

---

### Custom Transports

You can disable all built-in transports and use only custom ones:

```ts
import { PassThrough } from "node:stream";
import winston from "winston";
import { createLogger } from "@hiprax/logger";

const capture = new PassThrough();
const logger = createLogger({
  moduleName: "audit",
  includeConsole: false,
  includeFile: false,
  includeGlobalFile: false,
  additionalTransports: [new winston.transports.Stream({ stream: capture })],
});
```

---

### JSON Output for Log Shippers

Set `format: "json"` to emit one JSON object per log line (newline-delimited JSON, also called NDJSON / JSON-Lines). This is the wire format expected by every mainstream log shipper — Datadog Agent, Grafana Loki / Promtail, Logstash / Filebeat (the ELK / Elastic Stack), Splunk Universal Forwarder, Vector, Fluent Bit, AWS CloudWatch Agent, and so on. The format option applies uniformly to BOTH the file transports (module + global) and the console transport, so a process that ships `stdout` to a sidecar (the standard pattern in Kubernetes / ECS / Cloud Run) gets byte-identical JSON on every transport.

```ts
import { createLogger } from "@hiprax/logger";

const logger = createLogger({
  moduleName: "api",
  format: "json",
  // The maskMetaKeys redaction continues to apply BEFORE serialization,
  // so secrets never reach the JSON line.
  maskMetaKeys: ["password", "authorization", "apiKey"],
});

logger.info("Login", {
  userId: 42,
  email: "u@example.com",
  password: "topsecret",
  durationMs: 12.4,
});
```

Each call writes a single line such as:

```json
{
  "level": "info",
  "message": "Login",
  "timestamp": "2026-05-04 14:30:22",
  "module": "api",
  "userId": 42,
  "email": "u@example.com",
  "password": "[REDACTED]",
  "durationMs": 12.4
}
```

Canonical fields:

- `level` — winston npm log level (`error`, `warn`, `info`, `http`, `verbose`, `debug`, `silly`).
- `message` — the rendered message string.
- `timestamp` — captured at log-call time as a UTC `"YYYY-MM-DD HH:mm:ss"` string (matches the pretty pipeline's `UTC:` line).
- `module` — the module identifier, so a line in the shared global (`all-logs`) file can be attributed to the module that produced it. It carries the same display label the pretty pipeline renders as `(…)`: your `moduleName`, or the literal `GLOBAL` for the default `moduleName: "global"`. If your metadata already includes a `module` key, your value is kept — the field is never silently overwritten. Two narrow log forms carry no `module` field: a single-object payload that defines its own `toJSON()` (its `toJSON` output owns the whole line) and a top-level array payload (it serializes as an array).
- `stack` — populated by `winston.format.errors({ stack: true })` whenever the logged value is an `Error`.
- _Caller metadata_ — every key/value pair passed in the metadata object (e.g. `logger.info("msg", { ... })`) is merged onto the top-level JSON object.

**Datadog ingestion example.** Wire your Datadog Agent to tail the rotating file (or set `includeConsole: true` and let Datadog scrape the container `stdout`):

```yaml
# /etc/datadog-agent/conf.d/api.d/conf.yaml
logs:
  - type: file
    path: /var/log/myapp/api-*.log
    service: api
    source: nodejs
    sourcecategory: hiprax-logger
    log_processing_rules:
      - type: multi_line
        name: ndjson_per_line
        pattern: \{
```

Datadog auto-parses each line as JSON and surfaces every metadata key as a searchable facet (`@userId:42`, `@email:u@example.com`, `@durationMs:>10`). The `level` field maps to the Datadog log status; `timestamp` sets the event time precisely.

**Grafana Loki / Promtail example.** Promtail forwards each line to Loki and parses the JSON into label/index pairs:

```yaml
# /etc/promtail/config.yml
scrape_configs:
  - job_name: api
    static_configs:
      - targets: [localhost]
        labels:
          job: api
          __path__: /var/log/myapp/api-*.log
    pipeline_stages:
      - json:
          expressions:
            level: level
            timestamp: timestamp
            userId: userId
      - timestamp:
          source: timestamp
          format: 2006-01-02 15:04:05
          location: UTC
      - labels:
          level:
```

LogQL queries can then filter by metadata fields (`{job="api", level="error"} | json | userId="42"`).

**ELK / Elastic Stack example.** Filebeat tails the file and ships to Logstash or directly to Elasticsearch; the `decode_json_fields` processor flattens the line into top-level fields:

```yaml
# /etc/filebeat/filebeat.yml
filebeat.inputs:
  - type: filestream
    paths:
      - /var/log/myapp/api-*.log
    parsers:
      - ndjson:
          target: ""
          add_error_key: true
processors:
  - timestamp:
      field: timestamp
      layouts:
        - "2006-01-02 15:04:05"
      timezone: UTC
output.elasticsearch:
  hosts: ["localhost:9200"]
```

**Notes on the JSON branch:**

- The `extraTimezones` mirror lines (e.g. `"Europe/London: …"`) are NOT emitted in JSON mode — only the canonical UTC `timestamp` field is present. Most log shippers convert UTC to the viewer's locale at presentation time, so the secondary timezones are redundant in structured pipelines.
- Console output in JSON mode is the SAME raw JSON (no colorize, no extra header lines). This is intentional: a sidecar shipper that scrapes `stdout` must see the same wire format the file does.
- `maskMetaKeys` redaction continues to apply, walking nested objects and arrays before `JSON.stringify`. Secret values are replaced with the literal string `"[REDACTED]"` before the line is serialized.

---

### Silent / No-op Logger for Libraries & SSR

Libraries that consume `@hiprax/logger` and want to be silent by default — or test harnesses / SSR pipelines that want a stub logger without emitting any output — can use `createNoopLogger()`. The returned logger drops every call on the floor, has no transports, registers no exception handlers, never touches the filesystem, and emits no Winston `Attempt to write logs with no transports` warning.

```ts
import { createLogger, createNoopLogger } from "@hiprax/logger";

// Library-side default — caller can override.
export interface InitOptions {
  logger?: import("winston").Logger;
}

export const init = ({ logger = createNoopLogger() }: InitOptions = {}) => {
  logger.info("Library initialized");
  // ... library setup that may emit log lines ...
};

// Application-side opt-in to real logging.
init({ logger: createLogger({ moduleName: "my-app" }) });
```

**Surface guarantees:**

- Every npm log-level method (`error`, `warn`, `info`, `http`, `verbose`, `debug`, `silly`) plus the generic `log()` method is a no-op. Calls accept any arguments (Error instances, metadata objects, format strings) and return the logger for chainability.
- `end()`, `close()`, `on()`, `once()`, `removeListener()` (and the rest of the `EventEmitter` lifecycle methods) are no-ops returning the logger so subscriber and shutdown code continues to work.
- `transports` is a frozen empty array; `level` is the literal string `"silent"`.
- Returns the SAME singleton instance on every call — the no-op logger is stateless and safe to share across consumers. It is NOT registered with the internal logger registry, so `resetLoggerRegistry()` does not affect it.
- Drop-in compatible with the request-logging middleware's `logger` option:

  ```ts
  import { createNoopLogger, createRequestLogger } from "@hiprax/logger";

  app.use(createRequestLogger({ logger: createNoopLogger() }));
  ```

---

### Crash Capture

With `captureUncaught: true` (the default), a logger registers with a **process-wide crash coordinator**. Two guarantees follow:

**One listener pair, however many loggers you create.** Creating a logger per module is the normal pattern, and it stays cheap:

```ts
// auth.ts, db.ts, cache.ts, … — one logger per module
const logger = createLogger({ moduleName: "auth" });
```

```ts
process.listenerCount("uncaughtException"); // 1  (was 1-per-logger before v1.0.0)
process.listenerCount("unhandledRejection"); // 1
```

Before v1.0.0 each logger installed its own pair, so around eleven modules tripped Node's default limit:

```text
(node:18524) MaxListenersExceededWarning: Possible EventEmitter memory leak detected.
  11 uncaughtException listeners added to [process]. MaxListeners is 10.
```

That warning is gone, and shutting every logger down (`shutdownLogger` / `shutdownAllLoggers` / `resetLoggerRegistry`) returns the process to **zero** package-owned listeners.

**One crash record.** A fatal is logged once, through a single elected logger — not once per logger into the shared `all-logs` file. The elected logger is the first still-registered one that writes to a **file** (so the trace is persisted across restarts), falling back to the first that has any transport at all. The entry carries winston's full diagnostic payload (`stack`, parsed `trace`, `process` / `os` blocks) and is marked with a `crash` field:

```json
{ "crash": "uncaughtException", "level": "error", "message": "uncaughtException: …" }
```

By default the process then flushes and exits with code `1`, matching Node's standard crash behavior. Opt out per logger:

```ts
createLogger({ moduleName: "auth", exitOnUncaught: false }); // log the fatal, keep running
createLogger({ moduleName: "auth", captureUncaught: false }); // don't participate at all
```

A process has a single lifetime, so the exit decision is a **consensus**: the process exits only when every registered logger allows it. A single `exitOnUncaught: false` on **any** logger therefore keeps the whole process running after a captured fatal, regardless of which logger records the crash or the order the loggers were created in. (The crash is still recorded once, through the elected file-backed logger — recording where a crash lands and deciding whether to exit are independent.) A component that wants no say in process lifetime, and no crash recording either, should use `captureUncaught: false` so it never participates.

**Custom transports.** The guarantee holds unconditionally, so an `additionalTransports` entry that sets winston's `handleExceptions` / `handleRejections` has both flags cleared (with a one-time warning). Those flags are what make winston install a listener **per logger**, and leaving them set would both re-create the warning above and log every crash twice.

This does change where crashes land, so it is worth stating plainly: because a crash is recorded **once, through the elected logger**, a transport receives crashes only if it belongs to that logger. If you have a dedicated crash sink (Sentry, an HTTP transport) that previously relied on `handleExceptions` to receive crashes from its own module's logger, attach it to the elected logger instead — otherwise it will stop seeing them. To opt a logger out of crash capture entirely, use `captureUncaught: false`.

> The coordinator is a singleton **per module instance**. Loading both the ESM and CJS builds into one process yields two coordinators (one pair each) — the same inherent limitation the logger registry has.

---

## Log Output Format

**File output** (with timestamps and extra timezones):

```text
UTC: 2025-06-15 14:30:22
Europe/London: 2025-06-15 15:30:22
[WARN] (security/failedLogins)
Failed login attempt
Email: user@example.com
IP: 192.168.1.1
```

**Console output** (colorized, no timestamps):

```text
[WARN] (security/failedLogins)
Failed login attempt
Email: user@example.com
IP: 192.168.1.1
```

**Request middleware default message:**

```text
POST /auth/login 201 12.45ms (completed)
```

When `includeHttpContext` is enabled, the structured `RequestLogEntry` is attached under `info.http`:

```json
{
  "event": "completed",
  "method": "POST",
  "url": "/auth/login",
  "statusCode": 201,
  "responseTimeMs": 12.45,
  "contentLength": 256,
  "ip": "127.0.0.1",
  "userAgent": "Mozilla/5.0...",
  "requestId": "req-abc-123"
}
```

`contentLength` is the **response's** declared byte count, taken from the response `Content-Length` header. It is a response-side figure only: a chunked or streamed response carries no `Content-Length`, and an aborted request sends nothing, so `contentLength` is `undefined` in both cases rather than reporting the uploaded request-body size. If you need the request body size, read it from `requestHeaders["content-length"]` (enable `includeRequestHeaders`).

### Printf tokens and metadata (no string interpolation)

This package composes **no** `winston.format.splat()`, matching winston's own default format. Two consequences follow, and the second is a deliberate trade:

**1. Printf-style interpolation is not performed.** A message keeps its tokens literally:

```ts
logger.info("User %s logged in", "u-42");
// message: "User %s logged in"   — the "u-42" argument is not substituted
```

**2. A message containing a printf token causes winston to drop a trailing metadata object.** When the message matches `%s %c %d %j %i %f %o %O %%`, winston routes the metadata into its internal `SPLAT` slot, which nothing in these chains reads:

```ts
logger.info("route /users", { requestId: "r1" }); // requestId logged
logger.info("route /a%d", { requestId: "r1" }); // requestId NOT logged
```

This is identical to bare `winston.createLogger()` with no `format` option — it is winston's documented default, where interpolation "requires `winston.format.splat()`" — not behavior this package adds.

**The message itself is always rendered verbatim and is never rewritten.** That is the reason `splat()` is deliberately not composed in. Adding it would not recover the metadata above (winston consumes the trailing object *as* the `%d` argument, so the metadata is dropped either way) and it would let a `%` token inside message text **alter the recorded text**. The trigger is not exotic: the characters `c`, `d` and `f` are hex digits, so lowercase percent-encoded URL octets (`%c3`, `%d0`, `%f0`) are printf tokens.

```ts
// With splat() composed in, this URL would be REWRITTEN in the log:
logger.info("route /caf%c3%a9", { ip }); // -> "route /caf3%a9"
```

An absent field is visibly absent; a silently rewritten URL is a plausible fabrication. Rendering the message verbatim is the stronger guarantee, so it is the one this package keeps.

**Recommendation — put dynamic values in metadata, not in the message.** This avoids the drop entirely:

```ts
// Avoid — a printf token in `url` (e.g. "%d", or the "%c3" of an encoded
// path) silently drops `ip`:
logger.info(`Unknown route ${url}`, { ip });

// Prefer — a static message with everything structured:
logger.info("Unknown route", { url, ip });
```

Beyond avoiding the drop, this keeps messages greppable and aggregatable, which is standard practice for structured logging. If you need interpolation, format the string yourself before logging it.

**`createRequestLogger` is unaffected**, so an attacker-chosen URL containing `%d` cannot strip the context from the HTTP entry recording that request. Note the reason, because it is not the recommendation above: the middleware does put the request URL into its message. It is immune because it logs through winston's single-object form (`logger.log(entry)`), which never populates the `SPLAT` slot and so never reaches the drop.

## Migration to v1.0.0

v1.0.0 removes the `MaxListenersExceededWarning` that appeared once an app created ~11 module loggers. Fixing it correctly meant this package takes ownership of crash capture instead of delegating to winston's per-logger handlers, which settles three behaviors that could not change without a major version.

**Most applications need no code change.** Review the five items below only if they describe you.

| #   | Change                                                                                                                                                                                                                                 | You are affected if…                                                                                            | Keep the old behavior                                                                   |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| 1   | A captured fatal now **exits the process with code `1`** after logging. Previously the error was logged and the process kept running in a possibly inconsistent state.                                                                 | You relied on the process surviving an `uncaughtException` / `unhandledRejection`.                              | `createLogger({ exitOnUncaught: false })`                                               |
| 2   | A crash is logged **once**, through one elected logger — not once per logger. It also reaches the console now, not only the file transports.                                                                                           | You expected a copy of the crash in every module's file, or parsed the N duplicate traces in `all-logs`.        | No opt-out; the duplicates were the bug.                                                |
| 3   | The crash payload's `exception: true` / `rejection: true` is replaced by `crash: "uncaughtException" \| "unhandledRejection"`.                                                                                                         | You grep or alert on `"exception":true`.                                                                        | Match on `"crash":` instead.                                                            |
| 4   | `logger.transports` holds a forwarding **handle** for the global log, not a `DailyRotateFile`. The module-scoped file is still a real `DailyRotateFile`.                                                                               | You introspect `logger.transports` with `instanceof DailyRotateFile`.                                           | Filter for the module file only; expect one match, not two.                             |
| 5   | An `additionalTransports` entry that sets `handleExceptions` / `handleRejections` has both flags **cleared** (with a warning). Since crashes go only to the elected logger, a crash sink on a non-elected logger stops receiving them. | You attached a crash sink (Sentry, HTTP) to a module logger and relied on those flags to deliver crashes to it. | Attach that transport to the elected logger — the first capture-enabled logger that **has a file transport**, falling back to the first with any transport. |

Why #3 is not optional: `exception` / `rejection` are winston-reserved routing flags. `winston-transport` **drops** an `{ exception: true }` record from any transport without `handleExceptions` — the very flag whose removal fixes the listener leak — so keeping the marker would have made every crash silently vanish from the logs. Everything else in the payload is unchanged.

If you previously worked around the warning with `process.setMaxListeners(n)`, you can remove it.

---

## Scripts

| Command                             | Description                                                                                     |
| ----------------------------------- | ----------------------------------------------------------------------------------------------- |
| `npm run build`                     | Generates dual ESM/CJS bundles plus type declarations.                                          |
| `npm test`                          | Runs Jest with 100% coverage enforcement.                                                       |
| `npm run lint`                      | Runs ESLint across source and test files.                                                       |
| `npm run type-check`                | Runs the TypeScript compiler in check-only mode.                                                |
| `npm run format:check`              | Verifies Prettier formatting is clean.                                                          |
| `npm run audit:runtime`             | Runs `npm audit` against runtime dependencies only (fails on `high` or above).                  |
| `npm run verify`                    | Runs all five pre-completion gates locally with a clean per-check summary.                      |
| `npm run branch -- <prefix> <slug>` | Creates a conventionally-named feature branch from a fresh `origin/main`.                       |
| `npm run sync`                      | Fast-forwards local `main` and prunes branches whose remote tracking branch was deleted.        |
| `npm run release:prepare -- <bump>` | Bumps version, promotes `CHANGELOG [Unreleased]`, commits, pushes a `release/vX.Y.Z` branch.    |
| `npm run release:tag`               | Creates and pushes the `vX.Y.Z` tag — triggers the release workflow (publish + GitHub Release). |

## Testing & Coverage

```bash
npm test
```

- `ts-jest` compiles TypeScript on the fly with ESM support.
- Coverage thresholds are locked at **100%** for branches, functions, lines, and statements — and there are no `c8 ignore` directives in the source tree, so the threshold is honest rather than masked.
- Tests run in band (`--runInBand`) for deterministic behavior.

## Security Notes

The request middleware ships with **safe defaults** for the most common
secret-leak vectors. Everything below is opt-out (set the corresponding option
to `false` if you need raw values for debugging) — it is opt-in only for the
narrowly scoped `redactPaths` API.

- All filesystem interactions are sandboxed to the configured log directory.
- Module names are sanitized to prevent path traversal (dangerous characters are replaced with hyphens).
- Timezones are validated against the Moment timezone database before use.
- **Body redaction (`maskBodyKeys`)**: opt-in array. Replaces matching keys with `[REDACTED]` recursively in nested objects and arrays, including the enumerable own fields of class/`Error` instances. Matched case-insensitively. Circular references are safely handled (replaced with `[Circular]`) — only a value that is its own ancestor (a true self-reference or an indirect/mutual cycle) triggers this; the same non-circular object reachable from two different keys, array entries, or nesting depths is fully redacted at every occurrence instead of collapsing after the first. **Redaction boundary:** values with a custom `toJSON()` (`Date`, `URL`) or zero enumerable keys (`Map`, `Set`, `RegExp`) are passed through by the serializer untouched — use `redactPaths` to target those surgically.
- **Header redaction (`maskHeaderKeys`)**: applied to BOTH request and response headers AFTER the `includeRequestHeaders` / `includeResponseHeaders` allow-list filter. Default mask list (opt-out by passing `false`):
  - `authorization`
  - `cookie`
  - `set-cookie`
  - `x-api-key`
  - `proxy-authorization`
- **URL query redaction (`maskQueryKeys`)**: edits the logged `req.originalUrl` / `req.url` query string **in place** — it locates each `key=value` pair in the raw query and replaces only a matched parameter's value with the literal `[REDACTED]`, leaving every other byte untouched. Sibling-parameter encoding (`%20`, `%5B`/`%5D`, `%2B`), the `//host` authority of protocol-relative URLs, the scheme/host of absolute URLs, and the URL fragment are all preserved exactly; parameters are never re-ordered or re-encoded, and the function never throws. Handles both absolute and relative URLs, including a URL whose only `?` appears inside the fragment (e.g. a hash-router path like `"/dash#/r?token=abc"`), which has no real query component and is returned unchanged. Default mask list (opt-out by passing `false`):
  - `token`, `access_token`
  - `api_key`, `apikey`, `key`
  - `code` (covers OAuth callback codes)
  - `secret`, `password`
- **Surgical path redaction (`redactPaths`)**: opt-in array of dot-notation paths into the resolved entry (e.g. `["body.user.password"]`). The leading `body` segment is rewritten to `requestBody` to match the public field name. Missing intermediate keys are a graceful no-op — we never create new sub-paths just to write `[REDACTED]`. Body-scoped paths (`body.*` / `requestBody.*`) are applied to the object graph BEFORE the `maxBodyLength` truncation decision, so a secret targeted only by `redactPaths` (with no corresponding `maskBodyKeys` entry) cannot survive inside the `_preview` field of an over-limit body's truncation envelope. The request body, the `enrich()` context, and any captured request/response headers are all redacted on internal owned copies — even when the body or context is a class instance that defines its own `toJSON()` (a Mongoose document, a DTO, `req.user`) — and each `redactPaths` write is additionally confined to a package-owned plain object or array, so your original `req.body` / `req.session` / `req.user` / `req.headers` objects (and the live response-header values behind `res.getHeaders()`) are never mutated by a `redactPaths` write. Path redaction is also best-effort and never throws: a path that targets an array's `length`, a frozen or getter-only property, or any other slot whose write would raise is skipped rather than allowed to drop the entire log entry.
- **Body size guard (`maxBodyLength`)**: prevents log-flood attacks. Object/array bodies whose JSON form exceeds the limit return the envelope `{ _truncated: true, _originalLength, _preview }` (preserving JSON shape for downstream log shippers). String bodies are truncated to `maxBodyLength` Unicode code points (handles emoji surrogate pairs correctly) with a trailing `…`.
- **Log injection (`escapeMessageNewlines`)**: untrusted user input concatenated into a log message — for example `logger.info(req.body.username)` where the request body carries `username = "alice\n[ERROR] (admin)\nfake critical event"` — writes three lines into the log file by default. The second and third lines are byte-for-byte indistinguishable from real `[ERROR]` entries the application itself produced and can mislead a SOC analyst, log parser, or incident responder into trusting forged data. Set `escapeMessageNewlines: true` on the `createLogger()` options to rewrite embedded `\n` / `\r` in string messages as the visible literal sequences `\n` / `\r` BEFORE the printf renders the line. Defaults to `false` for back-compat with consumers that intentionally emit multi-line messages; the recommendation for new applications is to opt in.

  ```ts
  const logger = createLogger({ escapeMessageNewlines: true });
  logger.info("alice\n[ERROR] (admin)\nfake event");
  // Rendered:
  //   [INFO] (GLOBAL)
  //   alice\n[ERROR] (admin)\nfake event
  // (one log entry, with the literal "\n" sequences visible in the body.)
  ```

  The escape covers the rendered **`stack`** line as well as the message, and needs to: `winston.format.errors({ stack: true })` flattens a logged `Error` into a string message **plus** a string stack whose first line repeats that message, so escaping only the message would let `logger.error(new Error(username))` re-inject the payload's raw newlines one line lower and forge the entry anyway. **Trade-off:** with the option on, a genuine multi-line stack trace renders as a single line whose frame separators show as the literal `\n` sequence. Every frame is still present and greppable, and nothing changes at the `false` default — a real stack frame and a forged log line are the same bytes to a log parser, so newlines from caller-supplied data cannot be trusted selectively. Leave the option off if your pipeline depends on multi-line stack rendering.

## Contributing

1. Clone the repo and install dependencies (`npm ci`).
2. Create a branch using the convention `<prefix>/<slug>` (e.g. `feat/add-thing`, `fix/headers-leak`, `ci/bump-actions`). The helper `npm run branch -- feat add-thing` does this from a fresh `origin/main`.
3. Make your changes and add or update tests. Coverage is enforced at 100% on every metric.
4. Run `npm run verify` before opening a PR — it runs the same five gates CI runs.
5. Update `CHANGELOG.md` under `## [Unreleased]` with a dated entry describing what changed.
6. Open a PR; the template enumerates the checklist that must pass.

### Release process

Releases are **tag-triggered**: pushing a `vX.Y.Z` tag fires `.github/workflows/release.yml`, which re-runs every gate, verifies the tag matches `package.json` `version`, publishes to npm with [provenance](https://docs.npmjs.com/generating-provenance-statements), and creates a GitHub Release whose body is the matching `CHANGELOG.md` section.

Publishing uses npm [trusted publishing](https://docs.npmjs.com/trusted-publishers) (OIDC): the workflow authenticates by exchanging a short-lived GitHub Actions identity token for a registry token at publish time, so there is **no npm token stored in the repository** to leak, expire, or rotate. The trust relationship is configured on the npm package itself (Settings → Trusted Publisher → GitHub Actions), pinned to this repository and the `release.yml` workflow filename. Because trusted publishing requires npm >= 11.5.1, the release job runs on Node 24.x and asserts the npm floor before any npm work.

The two-step flow:

```bash
npm run release:prepare -- patch   # or minor / major
# Open the printed PR URL, wait for CI green, squash-and-merge.
npm run sync                       # pull main, drop merged branches
npm run release:tag                # creates + pushes vX.Y.Z (triggers publish)
```

## License

MIT License - see [LICENSE](LICENSE) file for details.

## Links

- [NPM Package](https://www.npmjs.com/package/@hiprax/logger)
- [GitHub Repository](https://github.com/Hiprax/logger)
- [Issue Tracker](https://github.com/Hiprax/logger/issues)

---
