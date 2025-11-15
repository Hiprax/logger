# @hiprax/logger

Fully typed, production-grade logging toolkit for Node.js applications. Built on top of Winston with first-class TypeScript support, rotating file transports, timezone mirroring, and an HTTP middleware that outperforms traditional solutions.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9.3-blue.svg)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-18+-green.svg)](https://nodejs.org/)

## Features

- ✅ Multi-target logging (console, per-module files, shared files, custom transports). Console output stays enabled but omits timestamps so only files capture the full timeline.
- ✅ Daily rotation with independent retention rules
- ✅ Guaranteed UTC timestamps plus optional verified IANA timezones
- ✅ Automatic log directory creation (including nested module scopes)
- ✅ Batteries-included Express middleware with structured payloads
- ✅ Zero-config ESM & CommonJS builds, rich IntelliSense docs
- ✅ Comprehensive Jest suite with 100% coverage

## Installation

```bash
npm install @hiprax/logger
```

> The package ships with precompiled dual builds. No transpilation is required in consuming projects.

## Quick Start

```ts
import { createLogger } from "@hiprax/logger";

const securityLogger = createLogger({
  moduleName: "security/failedLogins",
  extraTimezones: ["Europe/London"],
});

securityLogger.warn(`Failed login attempt\nEmail: ${email}\nIP: ${req.realIp}`);
```

CommonJS usage is equally simple:

```js
const { createLogger } = require("@hiprax/logger");
```

## API

### `createLogger(options?: LoggerOptions)`

| Option                 | Type                  | Default                 | Description                                                                                              |
| ---------------------- | --------------------- | ----------------------- | -------------------------------------------------------------------------------------------------------- |
| `moduleName`           | `string`              | `'global'`              | Label used in log lines and for module-specific files. Supports nested scopes (`security/failedLogins`). |
| `logDirectory`         | `string`              | `<process.cwd()>/logs`  | Target directory (auto-created).                                                                         |
| `level`                | `LogLevel`            | `'info'`                | Default level for all transports.                                                                        |
| `consoleLevel`         | `LogLevel`            | `level`                 | Console-specific level.                                                                                  |
| `includeConsole`       | `boolean`             | `true`                  | Enables console logging. Console lines omit timestamps; files keep the full multi-timezone output.       |
| `includeFile`          | `boolean`             | `true`                  | Enables module-specific rotating file logging.                                                           |
| `includeGlobalFile`    | `boolean`             | `true`                  | Enables shared rotating file logging.                                                                    |
| `globalModuleName`     | `string`              | `'all-logs'`            | Label for the shared log file.                                                                           |
| `extraTimezones`       | `string \| string[]`  | `[]`                    | Additional IANA zones to render beside UTC. Validity is enforced.                                        |
| `rotation`             | `RotationStrategy`    | 20 MB / 14 days / daily | Rotation config for the module file.                                                                     |
| `globalRotation`       | `RotationStrategy`    | `rotation`              | Override rotation for the shared file.                                                                   |
| `additionalTransports` | `winston.transport[]` | `[]`                    | Appends custom transports (e.g., HTTP, Kafka).                                                           |

**RotationStrategy**

```ts
interface RotationStrategy {
  maxSize?: string; // e.g., '20m', '200k'
  maxFiles?: string; // e.g., '14d', '30'
  datePattern?: string; // default: 'YYYY-MM-DD'
  zippedArchive?: boolean;
}
```

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

When `includeHttpContext` is enabled, the middleware attaches rich structured metadata via `info.http` while emitting a concise human-readable message. It relies on plain Node events (`finish`/`close`) and does **not** depend on `on-finished`, keeping the surface secure and modern.

| Option                   | Type                                                | Default                               | Description                                                                              |
| ------------------------ | --------------------------------------------------- | ------------------------------------- | ---------------------------------------------------------------------------------------- |
| `logger`                 | `winston.Logger`                                    | Scoped `http` logger                  | Provide your own logger or reuse the scoped one.                                         |
| `level`                  | `LogLevel \| (status: number) => LogLevel`          | Auto (`info`/`warn`/`error`)          | Override severity per response.                                                          |
| `label`                  | `string`                                            | `'http'`                              | Included in the auto-generated logger name (`http/<label>`).                             |
| `messageBuilder`         | `(entry) => string`                                 | `"METHOD URL status latency (event)"` | Customize the final message string.                                                      |
| `skip`                   | `(req, res) => boolean`                             | `false`                               | Allowlist/denylist support.                                                              |
| `enrich`                 | `(req, res, durationMs) => Record<string, unknown>` | `undefined`                           | Inject extra context (e.g., tenant, user).                                               |
| `includeRequestHeaders`  | `boolean \| string[]`                               | `false`                               | Toggle or limit header emission.                                                         |
| `includeResponseHeaders` | `boolean \| string[]`                               | `false`                               | Same as above for responses.                                                             |
| `includeRequestBody`     | `boolean`                                           | `false`                               | Logs parsed body (with redaction).                                                       |
| `maskBodyKeys`           | `string[]`                                          | `[]`                                  | Keys replaced with `[REDACTED]`. Applies deeply, including arrays.                       |
| `maxBodyLength`          | `number`                                            | `3000`                                | Caps serialized body size to prevent log floods.                                         |
| `includeHttpContext`     | `boolean`                                           | `false`                               | Adds the structured payload under `info.http`.                                           |
| `loggingEnabled`         | `boolean`                                           | `true`                                | Hard enable/disable switch.                                                              |
| `loggingMode`            | `RequestLoggingMode`                                | `'always'`                            | Env-aware control. Supports `'dev-only'`, `'prod-only'`, `'test-only'`, or custom rules. |

### Environment-aware request logging

- Use `loggingMode: 'dev-only'` to automatically log when `NODE_ENV`, `APP_ENV`, or `ENV` equals `dev`, `development`, or `local` (case-insensitive).
- Use `loggingMode: 'prod-only'` to emit logs exclusively when the env matches `prod`, `production`, or `live`.
- Use `loggingMode: 'test-only'` to limit logging to `test`, `testing`, `qa`, or `staging`.
- Provide a custom configuration, e.g.:
  ```ts
  loggingMode: { sources: ["DEPLOYMENT_STAGE"], allow: ["staging", "qa"], fallback: false }
  ```
- Pair `loggingEnabled` with boolean expressions (`loggingEnabled: process.env.FEATURE_LOGS === "on"`) for one-line toggles.
- Keep log output lightweight unless needed by turning `includeHttpContext` on only when you want the structured payload.

### Timezone Handling

- UTC is always logged.
- Additional zones must be valid IANA identifiers (`moment-timezone` validation). Invalid entries throw `InvalidTimezoneError`.
- Provide a single string or an array: `extraTimezones: ['Europe/London', 'America/New_York']`.

### Custom Transports

```ts
import { PassThrough } from "node:stream";
import winston from "winston";

const capture = new PassThrough();
const logger = createLogger({
  moduleName: "audit",
  includeConsole: false,
  includeFile: false,
  includeGlobalFile: false,
  additionalTransports: [new winston.transports.Stream({ stream: capture })],
});
```

## Scripts

| Command         | Description                                            |
| --------------- | ------------------------------------------------------ |
| `npm run build` | Generates dual ESM/CJS bundles plus type declarations. |
| `npm test`      | Runs Jest with 100% coverage enforcement.              |

## Testing & Coverage

```bash
npm test
```

- `ts-jest` compiles TypeScript on the fly.
- Coverage thresholds are locked at 100% global branches/functions/lines/statements.

## Security Notes

- All filesystem interactions are sandboxed to the configured log directory.
- Timezones are validated against the Moment timezone database before use.
- Sensitive request payload fields can be masked recursively via `maskBodyKeys`.

## Contributing

1. Clone the repo and install dependencies.
2. Run `npm test` to ensure the suite passes before submitting changes.
3. Follow the existing TypeScript, linting, and documentation patterns.

## 📄 License

MIT License - see [LICENSE](LICENSE) file for details.

## 🔗 Links

- [NPM Package](https://www.npmjs.com/package/@hiprax/logger)
- [GitHub Repository](https://github.com/Hiprax/logger)
- [Issue Tracker](https://github.com/Hiprax/logger/issues)

---

### **Made with ❤️ for secure applications**
