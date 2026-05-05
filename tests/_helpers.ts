import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type winston from "winston";
import type { LoggableNext, LoggableRequest, LoggableResponse } from "../src/types";

/**
 * Shape of a transport whose `close()` method may or may not exist. Used by
 * {@link teardownLogger} to synchronously close a logger and every transport
 * without falling back to `(transport as { close: () => void }).close()` casts.
 */
interface ClosableTransport {
  close?: () => void;
}

/**
 * Builds a `{ logger, log }` pair where `log` is a Jest mock fn standing in
 * for the underlying `winston.Logger.log` method. Used by the request
 * middleware tests to assert exactly what payload was forwarded to the logger.
 */
export const createMockLogger = (): { logger: winston.Logger; log: jest.Mock } => {
  const log = jest.fn();
  return {
    logger: { log } as unknown as winston.Logger,
    log,
  };
};

/**
 * Mock `Response` that satisfies the framework-agnostic `LoggableResponse`
 * shape. Backed by a real `EventEmitter` so tests can `res.emit("finish")` /
 * `res.emit("close")` to drive the middleware's lifecycle.
 */
export class MockResponse extends EventEmitter {
  statusCode = 200;
  private headers: Record<string, unknown> = {};

  setHeader(name: string, value: unknown) {
    this.headers[name.toLowerCase()] = value;
  }

  getHeader(name: string) {
    return this.headers[name.toLowerCase()];
  }

  getHeaders() {
    return { ...this.headers };
  }
}

/**
 * Mock `Request` with sensible defaults — `POST /auth/login`, JSON body,
 * `Authorization: Bearer secret`, `User-Agent: jest`. Tests override fields
 * via the `requestOverrides` argument to {@link runMiddleware}.
 */
export class MockRequest {
  method = "POST";
  url = "/auth/login";
  originalUrl = "/auth/login";
  headers: Record<string, string | string[] | undefined> = {
    "user-agent": "jest",
    "x-request-id": "req-1",
    "content-length": "128",
    authorization: "Bearer secret",
  };
  body: unknown = {
    email: "user@example.com",
    password: "topsecret",
  };
  ip = "127.0.0.1";
  socket = { remoteAddress: "127.0.0.1" };

  get(header: string): string | undefined {
    const value = this.headers[header.toLowerCase()];
    if (Array.isArray(value)) {
      return value.join(", ");
    }
    return typeof value === "string" ? value : undefined;
  }
}

/**
 * Drives a middleware once — assembles a `MockRequest` / `MockResponse`,
 * invokes the middleware, and returns the trio so tests can fire response
 * events and assert on the logged payload.
 */
export const runMiddleware = (
  middleware: (req: LoggableRequest, res: LoggableResponse, next: LoggableNext) => void,
  requestOverrides: Partial<MockRequest> = {},
  responseOverrides: Partial<MockResponse> = {},
): { req: MockRequest; res: MockResponse; next: jest.Mock } => {
  const req = Object.assign(new MockRequest(), requestOverrides);
  const res = Object.assign(new MockResponse(), responseOverrides);
  const next = jest.fn() as jest.Mock;

  middleware(
    req as unknown as LoggableRequest,
    res as unknown as LoggableResponse,
    next as unknown as LoggableNext,
  );

  return { req, res, next };
};

/**
 * Synchronously closes a logger and every one of its transports. Replaces
 * inline `(transport as { close: () => void }).close()` casts in test files —
 * the typed `ClosableTransport` shape narrows the duck-type without forcing
 * each call site to repeat the cast.
 *
 * Distinct from the public `shutdownLogger()` API (which is async, awaits
 * `finish` events, and is the one consumers should use); this helper is the
 * test-only fast-path for tearing down between cases.
 */
export const teardownLogger = (logger: winston.Logger): void => {
  logger.close();
  logger.transports.forEach((transport: winston.transport) => {
    const closable = transport as ClosableTransport;
    if (typeof closable.close === "function") {
      closable.close();
    }
  });
};

/** Creates a fresh OS-temp directory under a stable prefix. */
export const createTempDir = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "adv-logger-"));

/**
 * Runs `fn` with `process.env[key]` temporarily set to `value`, then restores
 * the original value (deleting the key entirely if it was unset before the
 * call). Standardizes the env save/restore dance used by the request-middleware
 * tests so a test that runs with the target env var unset (e.g. `npx jest`
 * from a shell that has not exported `NODE_ENV`) cannot leak the literal
 * string `"undefined"` into `process.env.NODE_ENV` for downstream tests via
 * `process.env[key] = originalValue` (which coerces `undefined` to `"undefined"`).
 *
 * Pass `value === undefined` to delete the env var for the duration of `fn`.
 */
export const withEnv = <T>(key: string, value: string | undefined, fn: () => T): T => {
  const orig = process.env[key];
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
  try {
    return fn();
  } finally {
    if (orig === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = orig;
    }
  }
};
