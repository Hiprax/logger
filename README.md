# @hiprax/logger

Fully typed, production-grade logging toolkit for Node.js applications. Built on top of Winston with first-class TypeScript support, rotating file transports, timezone mirroring, and an HTTP middleware that outperforms traditional solutions.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![npm version](https://img.shields.io/npm/v/@hiprax/logger)](https://www.npmjs.com/package/@hiprax/logger)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9.3-blue.svg)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-18+-green.svg)](https://nodejs.org/)

---

## Table of Contents

- [Features](#features)
- [Installation](#installation)
- [Quick Start](#quick-start)
- [API](#api)
  - [createLogger](#createloggeroptions-loggeroptions)
  - [Request Logging Middleware](#request-logging-middleware)
  - [Environment-Aware Request Logging](#environment-aware-request-logging)
  - [Timezone Handling](#timezone-handling)
  - [Custom Transports](#custom-transports)
- [Log Output Format](#log-output-format)
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
- Zero-config ESM & CommonJS dual builds with rich IntelliSense documentation
- Comprehensive Jest suite with 100% coverage enforcement

## Installation

```bash
npm install @hiprax/logger
```

> The package ships with precompiled dual builds (`.mjs` for ESM, `.cjs` for CommonJS). No transpilation is required in consuming projects.

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

| Option                 | Type                  | Default                 | Description                                                                                                  |
| ---------------------- | --------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------ |
| `moduleName`           | `string`              | `'global'`              | Label used in log lines and for module-specific files. Supports nested scopes (`security/failedLogins`).     |
| `logDirectory`         | `string`              | `<process.cwd()>/logs`  | Target directory (auto-created).                                                                             |
| `level`                | `LogLevel`            | `'info'`                | Default level for all transports.                                                                            |
| `consoleLevel`         | `LogLevel`            | `level`                 | Console-specific level override.                                                                             |
| `includeConsole`       | `boolean`             | `true`                  | Enables console logging. Console lines are colorized and omit timestamps.                                    |
| `includeFile`          | `boolean`             | `true`                  | Enables module-specific rotating file logging.                                                               |
| `includeGlobalFile`    | `boolean`             | `true`                  | Enables shared rotating file logging.                                                                        |
| `globalModuleName`     | `string`              | `'all-logs'`            | Label for the shared log file.                                                                               |
| `extraTimezones`       | `string \| string[]`  | `[]`                    | Additional IANA zones rendered beside UTC. Validity is enforced; invalid zones throw `InvalidTimezoneError`. |
| `rotation`             | `RotationStrategy`    | 20 MB / 14 days / daily | Rotation config for the module file.                                                                         |
| `globalRotation`       | `RotationStrategy`    | `rotation`              | Override rotation for the shared file. Falls back to `rotation` when omitted.                                |
| `additionalTransports` | `winston.transport[]` | `[]`                    | Appends custom transports (e.g., HTTP, Kafka, Stream).                                                       |

### RotationStrategy

```ts
interface RotationStrategy {
  maxSize?: string; // e.g., '20m', '200k'
  maxFiles?: string; // e.g., '14d', '30'
  datePattern?: string; // default: 'YYYY-MM-DD'
  zippedArchive?: boolean;
}
```

**Unknown method fallback**: If you call a method that does not exist on the logger (e.g., `logger.success("done")`), it will log a warning once and route the message through `info()` instead of throwing.

**Instance caching**: Logger instances are cached by `moduleName` + `logDirectory`. The same call from different files returns the same instance. Use `resetLoggerRegistry()` to clear the cache (useful for testing or hot-reload scenarios):

```ts
import { resetLoggerRegistry } from "@hiprax/logger";

resetLoggerRegistry(); // clears all cached instances
```

---

### Request Logging Middleware

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

| Option                   | Type                                                | Default                               | Description                                                                               |
| ------------------------ | --------------------------------------------------- | ------------------------------------- | ----------------------------------------------------------------------------------------- |
| `logger`                 | `winston.Logger`                                    | Scoped `http` logger                  | Provide your own logger or use the auto-created scoped one.                               |
| `level`                  | `LogLevel \| (status: number) => LogLevel`          | Auto (`info`/`warn`/`error`)          | Override severity. The default maps 5xx to `error`, 4xx to `warn`, rest to `info`.        |
| `label`                  | `string`                                            | —                                     | Included in the auto-generated logger name (`http/<label>`).                              |
| `messageBuilder`         | `(entry) => string`                                 | `"METHOD URL status latency (event)"` | Customize the final message string.                                                       |
| `skip`                   | `(req, res) => boolean`                             | —                                     | Return `true` to skip logging for specific requests.                                      |
| `enrich`                 | `(req, res, durationMs) => Record<string, unknown>` | —                                     | Inject extra context (e.g., tenant, user). Attached under `entry.context`.                |
| `includeRequestHeaders`  | `boolean \| string[]`                               | `false`                               | `true` for all headers, or an array of allowed header names.                              |
| `includeResponseHeaders` | `boolean \| string[]`                               | `false`                               | Same as above for response headers.                                                       |
| `includeRequestBody`     | `boolean`                                           | `false`                               | Logs parsed request body (with redaction support).                                        |
| `maskBodyKeys`           | `string[]`                                          | `[]`                                  | Keys replaced with `[REDACTED]`. Applies deeply and case-insensitively, including arrays. |
| `maxBodyLength`          | `number`                                            | `3000`                                | Caps serialized body size to prevent log floods. Truncated bodies end with `...`.         |
| `includeHttpContext`     | `boolean`                                           | `false`                               | Attaches the structured `RequestLogEntry` payload under `info.http`.                      |
| `loggingEnabled`         | `boolean`                                           | `true`                                | Hard enable/disable switch.                                                               |
| `loggingMode`            | `RequestLoggingMode`                                | `'always'`                            | Environment-aware control. See below.                                                     |

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

## Scripts

| Command              | Description                                            |
| -------------------- | ------------------------------------------------------ |
| `npm run build`      | Generates dual ESM/CJS bundles plus type declarations. |
| `npm test`           | Runs Jest with 100% coverage enforcement.              |
| `npm run lint`       | Runs ESLint across source and test files.              |
| `npm run type-check` | Runs the TypeScript compiler in check-only mode.       |

## Testing & Coverage

```bash
npm test
```

- `ts-jest` compiles TypeScript on the fly with ESM support.
- Coverage thresholds are locked at **100%** for branches, functions, lines, and statements.
- Tests run in band (`--runInBand`) for deterministic behavior.

## Security Notes

- All filesystem interactions are sandboxed to the configured log directory.
- Module names are sanitized to prevent path traversal (dangerous characters are replaced with hyphens).
- Timezones are validated against the Moment timezone database before use.
- Sensitive request payload fields can be masked recursively via `maskBodyKeys` (case-insensitive, handles nested objects and arrays).
- Circular references in request bodies are safely handled (replaced with `[Circular]`).

## Contributing

1. Clone the repo and install dependencies.
2. Run `npm test` to ensure the suite passes before submitting changes.
3. Follow the existing TypeScript, linting, and documentation patterns.

## License

MIT License - see [LICENSE](LICENSE) file for details.

## Links

- [NPM Package](https://www.npmjs.com/package/@hiprax/logger)
- [GitHub Repository](https://github.com/Hiprax/logger)
- [Issue Tracker](https://github.com/Hiprax/logger/issues)

---
