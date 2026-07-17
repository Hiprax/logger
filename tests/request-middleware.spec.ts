import { EventEmitter } from "node:events";
import {
  createRequestLogger,
  REQUEST_START_SYMBOL,
  __requestInternals,
} from "../src/request-middleware";
import * as loggerModule from "../src/logger";
import { resetLoggerRegistry } from "../src/logger";
import { RequestLoggerOptionError } from "../src/errors";
import type { LoggableRequest, LoggableResponse, LoggableNext, LogLevel } from "../src/types";
import { createMockLogger, MockRequest, runMiddleware, withEnv } from "./_helpers";

describe("createRequestLogger", () => {
  afterEach(() => {
    resetLoggerRegistry();
    jest.restoreAllMocks();
  });

  it("logs structured payloads on response finish", () => {
    const { logger, log } = createMockLogger();
    const middleware = createRequestLogger({
      logger,
      includeHttpContext: true,
      includeRequestBody: true,
      includeRequestHeaders: true,
      includeResponseHeaders: ["content-type"],
      maskBodyKeys: ["password"],
      // Opt OUT of safe-defaults header masking for this test so the existing
      // assertion on `Bearer secret` continues to hold. Other tests below
      // verify the safe-defaults behavior explicitly.
      maskHeaderKeys: false,
      messageBuilder: (entry) => `handled ${entry.statusCode}`,
      enrich: () => ({ correlationId: "abc" }),
    });

    const { res, next } = runMiddleware(middleware);
    res.statusCode = 201;
    res.setHeader("content-type", "application/json");
    res.setHeader("content-length", "256");
    res.emit("finish");

    expect(next).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledTimes(1);

    const payload = log.mock.calls[0][0];
    expect(payload.message).toBe("handled 201");
    expect(payload.level).toBe("info");
    expect(payload.http.event).toBe("completed");
    expect(payload.http.requestBody).toEqual({
      email: "user@example.com",
      password: "[REDACTED]",
    });
    expect(payload.http.requestHeaders?.authorization).toBe("Bearer secret");
    expect(payload.http.responseHeaders?.["content-type"]).toBe("application/json");
    expect(payload.http.context).toEqual({ correlationId: "abc" });
    expect(payload.http.requestId).toBe("req-1");
    expect(payload.http.contentLength).toBe(256);
  });

  it("honors skip callbacks", () => {
    const { logger, log } = createMockLogger();
    const middleware = createRequestLogger({
      logger,
      skip: () => true,
    });

    const { res, next } = runMiddleware(middleware);
    res.emit("finish");

    expect(next).toHaveBeenCalledTimes(1);
    expect(log).not.toHaveBeenCalled();
  });

  it("logs aborted requests with elevated level derived from status code", () => {
    const { logger, log } = createMockLogger();
    const middleware = createRequestLogger({
      logger,
      includeHttpContext: true,
    });

    const { res } = runMiddleware(middleware);
    res.statusCode = 503;
    res.emit("close");

    const payload = log.mock.calls[0][0];
    expect(payload.http.event).toBe("aborted");
    expect(payload.level).toBe("error");
  });

  it("uses warn level for client errors by default", () => {
    const { logger, log } = createMockLogger();
    const middleware = createRequestLogger({ logger, includeHttpContext: true });

    const { res } = runMiddleware(middleware);
    res.statusCode = 404;
    res.emit("finish");

    expect(log.mock.calls[0][0].level).toBe("warn");
  });

  it("supports dynamic level selection functions", () => {
    const { logger, log } = createMockLogger();
    const middleware = createRequestLogger({
      logger,
      level: (status) => (status >= 300 ? "debug" : "info"),
    });

    const { res } = runMiddleware(middleware);
    res.statusCode = 302;
    res.emit("finish");

    const payload = log.mock.calls[0][0];
    expect(payload.level).toBe("debug");
  });

  it("respects body size limits and supports full header capture", () => {
    const { logger, log } = createMockLogger();
    const middleware = createRequestLogger({
      logger,
      includeHttpContext: true,
      includeRequestBody: true,
      includeResponseHeaders: true,
      maxBodyLength: 10,
    });

    const { res } = runMiddleware(middleware, {
      body: { long: "abcdefghijklmnopqrstuvwxyz" },
      headers: { "content-length": "77" },
    });

    res.emit("finish");

    const payload = log.mock.calls[0][0];
    // Object bodies that exceed `maxBodyLength` after JSON serialization now
    // return a structured envelope instead of a mid-truncation string. See the
    // dedicated `_truncated` envelope tests below for full coverage.
    expect(payload.http.requestBody).toEqual({
      _truncated: true,
      _originalLength: expect.any(Number),
      _preview: expect.stringMatching(/…$/),
    });
    expect(payload.http.requestBody._originalLength).toBeGreaterThan(10);
    expect(payload.http.requestBody._preview.length).toBe(10);
    expect(payload.http.responseHeaders).toEqual({});
    expect(payload.http.contentLength).toBe(77);
  });

  it("supports request header allowlists", () => {
    const { logger, log } = createMockLogger();
    const middleware = createRequestLogger({
      logger,
      includeHttpContext: true,
      includeRequestHeaders: ["authorization"],
      // Opt out of safe-defaults header masking so the existing assertion on
      // the raw `Bearer secret` value continues to hold.
      maskHeaderKeys: false,
    });

    const { res } = runMiddleware(middleware);
    res.emit("finish");

    const headers = log.mock.calls[0][0].http.requestHeaders;
    expect(headers).toEqual({ authorization: "Bearer secret" });
  });

  it("returns empty response headers when include is true but nothing exists", () => {
    const { logger, log } = createMockLogger();
    const middleware = createRequestLogger({
      logger,
      includeHttpContext: true,
      includeResponseHeaders: true,
    });

    const { res } = runMiddleware(middleware);
    (res as unknown as { getHeaders: () => undefined }).getHeaders = () => undefined;
    res.emit("finish");

    expect(log.mock.calls[0][0].http.responseHeaders).toEqual({});
  });

  it("skips request body logging when no body is present", () => {
    const { logger, log } = createMockLogger();
    const middleware = createRequestLogger({
      logger,
      includeHttpContext: true,
      includeRequestBody: true,
    });

    const { res } = runMiddleware(middleware, { body: undefined });
    res.emit("finish");

    expect(log.mock.calls[0][0].http.requestBody).toBeUndefined();
  });

  it("does not log twice when both finish and close fire", () => {
    const { logger, log } = createMockLogger();
    const middleware = createRequestLogger({
      logger,
    });

    const { res } = runMiddleware(middleware);
    res.emit("finish");
    res.emit("close");

    expect(log).toHaveBeenCalledTimes(1);
  });

  it("handles circular request bodies safely", () => {
    const { logger, log } = createMockLogger();
    const circular: any = {};
    circular.self = circular;

    const middleware = createRequestLogger({
      logger,
      includeHttpContext: true,
      includeRequestBody: true,
      maxBodyLength: 100,
    });

    const { res } = runMiddleware(middleware, { body: circular });
    res.emit("finish");

    const payload = log.mock.calls[0][0];
    expect(payload.http.requestBody).toEqual({ self: "[Circular]" });
  });

  it("renders both occurrences of a shared (non-circular) request-body object instead of collapsing the second into [Circular] (DAG/diamond fix)", () => {
    // `u` is referenced by TWO sibling keys (`owner`, `editor`) on the same
    // body object — a diamond, not a cycle. Before the active-path fix, the
    // `seen` WeakSet inside `redactValue` (threaded through `serializeBody`)
    // never removed a value once visited, so the second occurrence of `u`
    // was misclassified as circular and rendered as the literal string
    // "[Circular]" instead of being redacted — silently dropping real data.
    const { logger, log } = createMockLogger();
    const u = { name: "Alice", password: "topsecret" };
    const body = { owner: u, editor: u };

    const middleware = createRequestLogger({
      logger,
      includeHttpContext: true,
      includeRequestBody: true,
      maskBodyKeys: ["password"],
    });

    const { res } = runMiddleware(middleware, { body });
    res.emit("finish");

    const payload = log.mock.calls[0][0];
    expect(payload.http.requestBody).toEqual({
      owner: { name: "Alice", password: "[REDACTED]" },
      editor: { name: "Alice", password: "[REDACTED]" },
    });
    // Neither occurrence is the literal "[Circular]" string, and the raw
    // secret must not survive anywhere in the logged payload.
    expect(payload.http.requestBody.owner).not.toBe("[Circular]");
    expect(payload.http.requestBody.editor).not.toBe("[Circular]");
    expect(JSON.stringify(payload.http.requestBody)).not.toContain("topsecret");
  });

  it("falls back to string serialization when JSON conversion fails", () => {
    const { logger, log } = createMockLogger();

    const middleware = createRequestLogger({
      logger,
      includeHttpContext: true,
      includeRequestBody: true,
    });

    // A throwing `toJSON` is a genuine serialization failure. (A BigInt is NOT
    // one — `bigintSafeReplacer` renders it — see the test below.) No
    // `redactPaths` are configured, so nothing was mandated and the loose
    // String() rendering carries no unredacted secret.
    const { res } = runMiddleware(middleware, {
      body: [
        {
          toJSON() {
            throw new Error("boom");
          },
        },
      ] as unknown,
    });

    res.emit("finish");

    const payload = log.mock.calls[0][0];
    expect(payload.http.requestBody).toBe("[object Object]");
  });

  it("renders a BigInt body rather than collapsing it into the String() fallback", () => {
    // Regression guard: a BigInt used to make both stringify calls throw, so
    // this body was emitted as the string "42" instead of the real array.
    const { logger, log } = createMockLogger();

    const middleware = createRequestLogger({
      logger,
      includeHttpContext: true,
      includeRequestBody: true,
    });

    const { res } = runMiddleware(middleware, {
      body: [42n] as unknown,
    });

    res.emit("finish");

    const payload = log.mock.calls[0][0];
    expect(payload.http.requestBody).toEqual([42n]);
    expect(payload.http.requestBody).not.toBe("42");
  });

  // ---------------------------------------------------------------------------
  // Depth-bounded body redaction — a deep body must not make the request
  // structurally invisible in the HTTP log.
  //
  // `serializeBody` runs the recursive redaction walk over `req.body`. Unbounded,
  // that walk overflows the stack on a ~3000-deep body (~18KB — well under
  // `express.json()`'s 100kb default), `finalize()`'s catch swallowed the
  // RangeError, and ZERO log entries were emitted for the request — not even the
  // method/url/status, which never touched the body. That is a cheap way for an
  // attacker to erase their own requests from the log.
  // ---------------------------------------------------------------------------

  /** Builds a `{child:{child:…}}` chain `depth` levels deep with a secret leaf. */
  const buildDeepBody = (depth: number): Record<string, unknown> => {
    const root: Record<string, unknown> = {};
    let cursor = root;
    for (let i = 0; i < depth; i += 1) {
      const next: Record<string, unknown> = {};
      cursor.child = next;
      cursor = next;
    }
    cursor.password = "topsecret";
    return root;
  };

  it("still logs the entry for a 3000-deep request body instead of dropping it", () => {
    const { logger, log } = createMockLogger();
    const errSpy = jest.spyOn(console, "error").mockImplementation(() => undefined);

    const middleware = createRequestLogger({
      logger,
      includeHttpContext: true,
      includeRequestBody: true,
      maskBodyKeys: ["password"],
      maxBodyLength: 100_000,
    });

    const { res } = runMiddleware(middleware, {
      method: "POST",
      originalUrl: "/deep",
      body: buildDeepBody(3000),
    });
    res.emit("finish");

    // Pre-fix: zero calls — the RangeError from the walk hit finalize()'s catch.
    expect(log).toHaveBeenCalledTimes(1);
    const payload = log.mock.calls[0][0];
    expect(payload.http.method).toBe("POST");
    expect(payload.http.url).toBe("/deep");
    expect(payload.http.statusCode).toBe(200);
    // The body renders, bounded by the depth sentinel; the over-deep secret is
    // never reached and so cannot leak.
    expect(JSON.stringify(payload.http.requestBody)).toContain("[MaxDepth]");
    expect(JSON.stringify(payload.http.requestBody)).not.toContain("topsecret");
    // The entry was logged normally, not via the never-crash error path.
    expect(errSpy).not.toHaveBeenCalled();
  });

  it("redacts a body nested 255 levels deep normally (the depth guard must not fire early)", () => {
    const { logger, log } = createMockLogger();
    const middleware = createRequestLogger({
      logger,
      includeHttpContext: true,
      includeRequestBody: true,
      maskBodyKeys: ["password"],
      maxBodyLength: 100_000,
    });

    const { res } = runMiddleware(middleware, { body: buildDeepBody(255) });
    res.emit("finish");

    let cursor: any = log.mock.calls[0][0].http.requestBody;
    for (let i = 0; i < 255; i += 1) cursor = cursor.child;
    expect(cursor.password).toBe("[REDACTED]");
    expect(JSON.stringify(log.mock.calls[0][0].http.requestBody)).not.toContain("[MaxDepth]");
  });

  it("degrades only the body to a sentinel when serialization fails, still logging the entry", () => {
    // A body whose own enumerable getter throws: the redaction walk reads own
    // keys, so reading it detonates inside `serializeBody`. Pre-fix that
    // exception reached finalize()'s catch and took the WHOLE entry with it.
    const { logger, log } = createMockLogger();
    const errSpy = jest.spyOn(console, "error").mockImplementation(() => undefined);
    const body = { safe: "visible" };
    Object.defineProperty(body, "boom", {
      enumerable: true,
      get() {
        throw new Error("getter exploded");
      },
    });

    const middleware = createRequestLogger({
      logger,
      includeHttpContext: true,
      includeRequestBody: true,
      maskBodyKeys: ["password"],
    });

    const { res } = runMiddleware(middleware, { method: "POST", originalUrl: "/boom", body });
    res.emit("finish");

    expect(log).toHaveBeenCalledTimes(1);
    const payload = log.mock.calls[0][0];
    // Everything that never touched the body still survives...
    expect(payload.http.method).toBe("POST");
    expect(payload.http.url).toBe("/boom");
    expect(payload.http.statusCode).toBe(200);
    // ...and only the body degrades.
    expect(payload.http.requestBody).toBe("[UNSERIALIZABLE]");
    expect(errSpy).not.toHaveBeenCalled();
  });

  it("omits http metadata unless includeHttpContext is true", () => {
    const { logger, log } = createMockLogger();
    const middleware = createRequestLogger({ logger });

    const { res } = runMiddleware(middleware);
    res.emit("finish");

    expect(log.mock.calls[0][0].http).toBeUndefined();
  });

  it("derives identifiers from headers when req.get is unavailable", () => {
    const { logger, log } = createMockLogger();
    const middleware = createRequestLogger({
      logger,
      includeHttpContext: true,
      includeRequestHeaders: ["user-agent"],
    });

    const { req, res } = runMiddleware(middleware, {
      get: undefined as unknown as MockRequest["get"],
    });

    res.emit("finish");

    const payload = log.mock.calls[0][0];
    expect(payload.http.userAgent).toBe("jest");
    expect(payload.http.requestId).toBe("req-1");
    expect(payload.http.requestHeaders).toEqual({ "user-agent": "jest" });
    expect(req.get).toBeUndefined();
  });

  it("creates a scoped logger when no logger is provided", () => {
    const mock = createMockLogger();
    const spy = jest.spyOn(loggerModule, "createLogger").mockReturnValue(mock.logger);

    createRequestLogger({ label: "api" });

    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ moduleName: "http/api" }));
    spy.mockRestore();
  });

  it("creates a scoped logger with default 'http' module name when no label or logger is provided", () => {
    const mock = createMockLogger();
    const spy = jest.spyOn(loggerModule, "createLogger").mockReturnValue(mock.logger);

    createRequestLogger({});

    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ moduleName: "http" }));
    spy.mockRestore();
  });

  it("falls back to header-array join when req.get is unavailable and the header is an array", () => {
    // Exercises the `headerOrUndefined` array-join branch: `req.get` is
    // undefined, so the middleware falls back to direct `req.headers` lookup.
    // When the header value is an `string[]` it must be joined with `", "`.
    const { logger, log } = createMockLogger();
    const middleware = createRequestLogger({ logger, includeHttpContext: true });

    const { res } = runMiddleware(middleware, {
      get: undefined as unknown as MockRequest["get"],
      headers: {
        "user-agent": ["mozilla", "chrome"] as unknown as string,
        "x-request-id": ["multi", "value"] as unknown as string,
      },
    });

    res.emit("finish");

    const payload = log.mock.calls[0][0];
    expect(payload.http.userAgent).toBe("mozilla, chrome");
    expect(payload.http.requestId).toBe("multi, value");
  });

  it("returns undefined when req.get is unavailable and the header is missing or non-string", () => {
    // Exercises the `typeof raw === "string" ? raw : undefined` fallback
    // inside `headerOrUndefined` when the raw header value is neither an
    // array nor a string (here: undefined / numeric value).
    const { logger, log } = createMockLogger();
    const middleware = createRequestLogger({ logger, includeHttpContext: true });

    const { res } = runMiddleware(middleware, {
      get: undefined as unknown as MockRequest["get"],
      headers: {
        // user-agent omitted entirely → req.headers["user-agent"] is undefined
        "x-request-id": 12345 as unknown as string,
      },
    });

    res.emit("finish");

    const payload = log.mock.calls[0][0];
    expect(payload.http.userAgent).toBeUndefined();
    expect(payload.http.requestId).toBeUndefined();
  });

  it("treats response.getHeaders being undefined as a no-op", () => {
    // Exercises the `res.getHeaders ? res.getHeaders() : undefined` fallback
    // when the response object exposes no `getHeaders` method at all (raw
    // adapters may omit it).
    const { logger, log } = createMockLogger();
    const middleware = createRequestLogger({
      logger,
      includeHttpContext: true,
      includeResponseHeaders: true,
    });

    const responseEmitter = new EventEmitter();
    const rawResponse: LoggableResponse = {
      statusCode: 200,
      getHeader: () => undefined,
      // getHeaders intentionally omitted to exercise the falsy branch.
      once: (event, listener) => responseEmitter.once(event, listener),
      removeListener: (event, listener) => responseEmitter.removeListener(event, listener),
    };

    const next: LoggableNext = jest.fn();
    middleware(new MockRequest() as unknown as LoggableRequest, rawResponse, next);
    responseEmitter.emit("finish");

    expect(log).toHaveBeenCalledTimes(1);
    const payload = log.mock.calls[0][0];
    expect(payload.http.responseHeaders).toEqual({});
  });

  it("collapses req.get returning undefined to entry.userAgent === undefined", () => {
    // Exercises the `req.get(name) ?? undefined` branch when `req.get` IS a
    // function but returns `undefined` for the requested header.
    const { logger, log } = createMockLogger();
    const middleware = createRequestLogger({ logger, includeHttpContext: true });

    const { res } = runMiddleware(middleware, {
      get: ((name: string) => {
        // Some Express subclasses return null for a missing header — both
        // null and undefined collapse to entry.userAgent/requestId === undefined.
        if (name.toLowerCase() === "user-agent") return undefined;
        if (name.toLowerCase() === "x-request-id") return null as unknown as string;
        return undefined;
      }) as MockRequest["get"],
    });

    res.emit("finish");

    const payload = log.mock.calls[0][0];
    expect(payload.http.userAgent).toBeUndefined();
    expect(payload.http.requestId).toBeUndefined();
  });

  it("logs the entry without context when enrich returns undefined", () => {
    // Exercises the `enrich(...) ?? undefined` branch — when the user-supplied
    // `enrich` returns `undefined`, the entry is still logged but
    // `entry.context` is left as `undefined`. The return type now explicitly
    // includes `| undefined` so no cast is required.
    const { logger, log } = createMockLogger();
    const middleware = createRequestLogger({
      logger,
      includeHttpContext: true,
      enrich: () => undefined,
    });

    const { res } = runMiddleware(middleware);
    res.emit("finish");

    expect(log).toHaveBeenCalledTimes(1);
    const payload = log.mock.calls[0][0];
    expect(payload.http.context).toBeUndefined();
  });

  it("logs the entry without context when enrich returns null", () => {
    // Same `?? undefined` collapse path, exercising the explicit `null`
    // return that some user enrichers may produce. The return type now
    // explicitly includes `| null` so no cast is required.
    const { logger, log } = createMockLogger();
    const middleware = createRequestLogger({
      logger,
      includeHttpContext: true,
      enrich: () => null,
    });

    const { res } = runMiddleware(middleware);
    res.emit("finish");

    expect(log).toHaveBeenCalledTimes(1);
    const payload = log.mock.calls[0][0];
    expect(payload.http.context).toBeUndefined();
  });

  it("falls back to defaults when request fields are missing", () => {
    const { logger, log } = createMockLogger();
    const middleware = createRequestLogger({ logger, includeHttpContext: true });

    const { res } = runMiddleware(
      middleware,
      {
        method: undefined as unknown as string,
        url: undefined as unknown as string,
        originalUrl: undefined as unknown as string,
      },
      {
        statusCode: undefined as unknown as number,
      },
    );

    res.emit("finish");

    const payload = log.mock.calls[0][0];
    expect(payload.http.method).toBe("GET");
    expect(payload.http.url).toBe("");
    expect(payload.http.statusCode).toBe(0);
  });

  it("skips logging entirely when loggingEnabled is false", () => {
    const { logger, log } = createMockLogger();
    const middleware = createRequestLogger({ logger, loggingEnabled: false });

    const { res } = runMiddleware(middleware);
    res.emit("finish");

    expect(log).not.toHaveBeenCalled();
  });

  it("respects dev-only logging mode", () => {
    const { logger, log } = createMockLogger();

    withEnv("NODE_ENV", "production", () => {
      let middleware = createRequestLogger({
        logger,
        loggingMode: "dev-only",
        includeHttpContext: true,
      });
      const first = runMiddleware(middleware);
      first.res.emit("finish");
      expect(log).not.toHaveBeenCalled();

      log.mockClear();
      withEnv("NODE_ENV", "development", () => {
        middleware = createRequestLogger({
          logger,
          loggingMode: "dev-only",
          includeHttpContext: true,
        });
        const second = runMiddleware(middleware);
        second.res.emit("finish");
        expect(log).toHaveBeenCalledTimes(1);
      });
    });
  });

  it("respects prod-only logging mode", () => {
    const { logger, log } = createMockLogger();

    withEnv("NODE_ENV", "development", () => {
      let middleware = createRequestLogger({
        logger,
        loggingMode: "prod-only",
        includeHttpContext: true,
      });
      const first = runMiddleware(middleware);
      first.res.emit("finish");
      expect(log).not.toHaveBeenCalled();

      log.mockClear();
      withEnv("NODE_ENV", "PRODUCTION", () => {
        middleware = createRequestLogger({
          logger,
          loggingMode: "prod-only",
          includeHttpContext: true,
        });
        const second = runMiddleware(middleware);
        second.res.emit("finish");
        expect(log).toHaveBeenCalledTimes(1);
      });
    });
  });

  it("respects test-only logging mode", () => {
    const { logger, log } = createMockLogger();

    withEnv("NODE_ENV", "production", () => {
      let middleware = createRequestLogger({
        logger,
        loggingMode: "test-only",
        includeHttpContext: true,
      });
      runMiddleware(middleware).res.emit("finish");
      expect(log).not.toHaveBeenCalled();

      log.mockClear();
      withEnv("NODE_ENV", "Testing", () => {
        middleware = createRequestLogger({
          logger,
          loggingMode: "test-only",
          includeHttpContext: true,
        });
        runMiddleware(middleware).res.emit("finish");
        expect(log).toHaveBeenCalledTimes(1);
      });
    });
  });

  it("supports custom environment logging configuration", () => {
    const { logger, log } = createMockLogger();

    withEnv("CUSTOM_ENV", "", () => {
      let middleware = createRequestLogger({
        logger,
        loggingMode: { sources: ["CUSTOM_ENV"], allow: ["enabled"], fallback: false },
        includeHttpContext: true,
      });
      const first = runMiddleware(middleware);
      first.res.emit("finish");
      expect(log).not.toHaveBeenCalled();

      log.mockClear();
      withEnv("CUSTOM_ENV", "enabled", () => {
        middleware = createRequestLogger({
          logger,
          loggingMode: { sources: ["CUSTOM_ENV"], allow: ["enabled"] },
          includeHttpContext: true,
        });
        const second = runMiddleware(middleware);
        second.res.emit("finish");
        expect(log).toHaveBeenCalledTimes(1);
      });
    });
  });

  it("derives client ip from socket when req.ip is undefined", () => {
    const { logger, log } = createMockLogger();
    const middleware = createRequestLogger({ logger, includeHttpContext: true });

    const { res } = runMiddleware(middleware, {
      ip: undefined as unknown as string,
      socket: { remoteAddress: "10.0.0.1" },
    });

    res.emit("finish");

    expect(log.mock.calls[0][0].http.ip).toBe("10.0.0.1");
  });

  it("omits ip when neither req.ip nor socket remote address exist", () => {
    const { logger, log } = createMockLogger();
    const middleware = createRequestLogger({ logger, includeHttpContext: true });

    const { res } = runMiddleware(middleware, {
      ip: undefined as unknown as string,
      socket: { remoteAddress: undefined as unknown as string },
    });

    res.emit("finish");

    expect(log.mock.calls[0][0].http.ip).toBeUndefined();
  });

  // ---------------------------------------------------------------------------
  // Task #11 — Header / URL / path redaction
  // ---------------------------------------------------------------------------

  it("redacts default safe-default header keys (authorization/cookie/set-cookie) by default", () => {
    const { logger, log } = createMockLogger();
    const middleware = createRequestLogger({
      logger,
      includeHttpContext: true,
      includeRequestHeaders: true,
      includeResponseHeaders: true,
    });

    const { res } = runMiddleware(middleware, {
      headers: {
        authorization: "Bearer top-secret",
        cookie: "session=abc; user=42",
        "x-api-key": "k_live_abc",
        "x-trace-id": "trace-1",
      },
    });
    res.setHeader("set-cookie", ["session=abc; HttpOnly", "csrf=xyz"]);
    res.setHeader("content-type", "application/json");
    res.emit("finish");

    const payload = log.mock.calls[0][0];
    expect(payload.http.requestHeaders.authorization).toBe("[REDACTED]");
    expect(payload.http.requestHeaders.cookie).toBe("[REDACTED]");
    expect(payload.http.requestHeaders["x-api-key"]).toBe("[REDACTED]");
    // Non-mask-listed headers are surfaced unchanged.
    expect(payload.http.requestHeaders["x-trace-id"]).toBe("trace-1");
    expect(payload.http.responseHeaders["set-cookie"]).toBe("[REDACTED]");
    expect(payload.http.responseHeaders["content-type"]).toBe("application/json");
  });

  it("supports custom maskHeaderKeys arrays (case-insensitive)", () => {
    const { logger, log } = createMockLogger();
    const middleware = createRequestLogger({
      logger,
      includeHttpContext: true,
      includeRequestHeaders: true,
      // Custom list: only mask `x-trace-id`. Default mask list is replaced
      // entirely, so `authorization` is now surfaced raw.
      maskHeaderKeys: ["X-Trace-Id"],
    });

    const { res } = runMiddleware(middleware, {
      headers: {
        authorization: "Bearer secret",
        "x-trace-id": "trace-1",
      },
    });
    res.emit("finish");

    const payload = log.mock.calls[0][0];
    expect(payload.http.requestHeaders.authorization).toBe("Bearer secret");
    expect(payload.http.requestHeaders["x-trace-id"]).toBe("[REDACTED]");
  });

  it("disables header masking entirely when maskHeaderKeys is false", () => {
    const { logger, log } = createMockLogger();
    const middleware = createRequestLogger({
      logger,
      includeHttpContext: true,
      includeRequestHeaders: true,
      maskHeaderKeys: false,
    });

    const { res } = runMiddleware(middleware, {
      headers: {
        authorization: "Bearer top-secret",
        cookie: "session=abc",
      },
    });
    res.emit("finish");

    const payload = log.mock.calls[0][0];
    expect(payload.http.requestHeaders.authorization).toBe("Bearer top-secret");
    expect(payload.http.requestHeaders.cookie).toBe("session=abc");
  });

  it("applies header masking AFTER the includeRequestHeaders allow-list filter", () => {
    const { logger, log } = createMockLogger();
    const middleware = createRequestLogger({
      logger,
      includeHttpContext: true,
      // Allow-list: only `authorization` and `x-trace-id` survive the filter.
      includeRequestHeaders: ["authorization", "x-trace-id"],
    });

    const { res } = runMiddleware(middleware, {
      headers: {
        authorization: "Bearer secret",
        cookie: "session=abc",
        "x-trace-id": "trace-1",
      },
    });
    res.emit("finish");

    const payload = log.mock.calls[0][0];
    // `authorization` survived the allow-list AND was redacted by the safe defaults.
    expect(payload.http.requestHeaders.authorization).toBe("[REDACTED]");
    // `cookie` was filtered out by the allow-list before masking even ran.
    expect(payload.http.requestHeaders.cookie).toBeUndefined();
    expect(payload.http.requestHeaders["x-trace-id"]).toBe("trace-1");
  });

  it("redacts query-string secrets in the logged URL by default", () => {
    const { logger, log } = createMockLogger();
    const middleware = createRequestLogger({ logger, includeHttpContext: true });

    const { res } = runMiddleware(middleware, {
      url: "/auth/login?token=abc&keep=me",
      originalUrl: "/auth/login?token=abc&keep=me",
    });
    res.emit("finish");

    const payload = log.mock.calls[0][0];
    expect(payload.http.url).toBe("/auth/login?token=[REDACTED]&keep=me");
  });

  it("redacts originalUrl alongside url when originalUrl differs from url", () => {
    const { logger, log } = createMockLogger();
    const middleware = createRequestLogger({ logger, includeHttpContext: true });

    // `originalUrl` is preferred when present; verify it is the field used and
    // that its query string is redacted.
    const { res } = runMiddleware(middleware, {
      url: "/internal/login?token=abc",
      originalUrl: "/auth/login?token=abc&keep=me",
    });
    res.emit("finish");

    const payload = log.mock.calls[0][0];
    expect(payload.http.url).toBe("/auth/login?token=[REDACTED]&keep=me");
  });

  it("supports custom maskQueryKeys arrays (case-insensitive)", () => {
    const { logger, log } = createMockLogger();
    const middleware = createRequestLogger({
      logger,
      includeHttpContext: true,
      maskQueryKeys: ["sessionId"],
    });

    const { res } = runMiddleware(middleware, {
      originalUrl: "/path?SessionId=xyz&token=keep",
    });
    res.emit("finish");

    const payload = log.mock.calls[0][0];
    expect(payload.http.url).toBe("/path?SessionId=[REDACTED]&token=keep");
  });

  it("disables query masking entirely when maskQueryKeys is false", () => {
    const { logger, log } = createMockLogger();
    const middleware = createRequestLogger({
      logger,
      includeHttpContext: true,
      maskQueryKeys: false,
    });

    const { res } = runMiddleware(middleware, {
      originalUrl: "/auth/login?token=abc&keep=me",
    });
    res.emit("finish");

    const payload = log.mock.calls[0][0];
    expect(payload.http.url).toBe("/auth/login?token=abc&keep=me");
  });

  it("leaves URLs without a query string unchanged", () => {
    const { logger, log } = createMockLogger();
    const middleware = createRequestLogger({ logger, includeHttpContext: true });

    const { res } = runMiddleware(middleware, {
      originalUrl: "/healthz",
    });
    res.emit("finish");

    expect(log.mock.calls[0][0].http.url).toBe("/healthz");
  });

  it("redacts a nested body field via redactPaths dot-notation", () => {
    const { logger, log } = createMockLogger();
    const middleware = createRequestLogger({
      logger,
      includeHttpContext: true,
      includeRequestBody: true,
      redactPaths: ["body.user.password"],
    });

    const { res } = runMiddleware(middleware, {
      body: {
        user: {
          email: "u@example.com",
          password: "topsecret",
        },
      },
    });
    res.emit("finish");

    const payload = log.mock.calls[0][0];
    expect(payload.http.requestBody).toEqual({
      user: {
        email: "u@example.com",
        password: "[REDACTED]",
      },
    });
  });

  it("does not leak a redactPaths target end-to-end when the body carries a BigInt", () => {
    // The proven end-to-end leak: a single BigInt made the redactPaths
    // round-trip throw, so every mandated path was skipped and String(body)
    // joined the array into "1,SUPER-SECRET,5" straight into the log.
    const { logger, log } = createMockLogger();
    const middleware = createRequestLogger({
      logger,
      includeHttpContext: true,
      includeRequestBody: true,
      redactPaths: ["body.1"],
    });

    const { res } = runMiddleware(middleware, {
      method: "POST",
      originalUrl: "/orders",
      body: ["1", "SUPER-SECRET", 5n],
    });
    res.emit("finish");

    const payload = log.mock.calls[0][0];
    expect(payload.http.requestBody).toEqual(["1", "[REDACTED]", "5"]);
    const rendered = JSON.stringify(payload, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
    expect(rendered).not.toContain("SUPER-SECRET");
  });

  it("logs a diagnosable redacted body end-to-end when the body carries a BigInt", () => {
    // Previously the whole body collapsed to the useless "[object Object]",
    // silently discarding every diagnostic field.
    const { logger, log } = createMockLogger();
    const middleware = createRequestLogger({
      logger,
      includeHttpContext: true,
      includeRequestBody: true,
      maskBodyKeys: ["password"],
    });

    const { res } = runMiddleware(middleware, {
      method: "POST",
      originalUrl: "/pay",
      body: { amount: 100n, password: "hunter2", user: "bob" },
    });
    res.emit("finish");

    const payload = log.mock.calls[0][0];
    expect(payload.http.requestBody).not.toBe("[object Object]");
    expect(payload.http.requestBody).toMatchObject({
      password: "[REDACTED]",
      user: "bob",
      amount: 100n,
    });
  });

  it("handles missing intermediate keys in redactPaths gracefully", () => {
    const { logger, log } = createMockLogger();
    const middleware = createRequestLogger({
      logger,
      includeHttpContext: true,
      includeRequestBody: true,
      // The `user` intermediate segment does NOT exist on this body — must be a no-op.
      redactPaths: ["body.user.password", "context.secret"],
    });

    const { res } = runMiddleware(middleware, {
      body: { other: "value" },
    });
    res.emit("finish");

    const payload = log.mock.calls[0][0];
    expect(payload.http.requestBody).toEqual({ other: "value" });
    expect(payload.http.context).toBeUndefined();
  });

  it("accepts the explicit requestBody alias in redactPaths", () => {
    const { logger, log } = createMockLogger();
    const middleware = createRequestLogger({
      logger,
      includeHttpContext: true,
      includeRequestBody: true,
      redactPaths: ["requestBody.token"],
    });

    const { res } = runMiddleware(middleware, {
      body: { token: "abc" },
    });
    res.emit("finish");

    const payload = log.mock.calls[0][0];
    expect(payload.http.requestBody).toEqual({ token: "[REDACTED]" });
  });

  it("applies redactPaths to a nested body field BEFORE truncation so the secret cannot survive inside _preview", () => {
    // Regression for the redactPaths truncation-leak: previously `redactPaths`
    // only ran on `entry.requestBody` AFTER an over-limit body had already
    // collapsed into the `{ _truncated, _originalLength, _preview }` envelope,
    // so a secret targeted ONLY by `redactPaths` (no matching `maskBodyKeys`)
    // leaked verbatim inside `_preview`.
    const { logger, log } = createMockLogger();
    const middleware = createRequestLogger({
      logger,
      includeHttpContext: true,
      includeRequestBody: true,
      redactPaths: ["body.password"],
    });

    const body = { password: "SECRET", filler: "x".repeat(4000) };
    const { res } = runMiddleware(middleware, { body });
    res.emit("finish");

    const payload = log.mock.calls[0][0];
    const requestBody = payload.http.requestBody as {
      _truncated: boolean;
      _originalLength: number;
      _preview: string;
    };
    expect(requestBody._truncated).toBe(true);
    expect(requestBody._preview).not.toContain("SECRET");
    expect(requestBody._preview).toContain("[REDACTED]");
  });

  it("still redacts a body field via redactPaths when the body is small enough to skip truncation (regression)", () => {
    const { logger, log } = createMockLogger();
    const middleware = createRequestLogger({
      logger,
      includeHttpContext: true,
      includeRequestBody: true,
      redactPaths: ["body.password"],
    });

    const body = { password: "SECRET", filler: "small" };
    const { res } = runMiddleware(middleware, { body });
    res.emit("finish");

    const payload = log.mock.calls[0][0];
    expect(payload.http.requestBody).toEqual({ password: "[REDACTED]", filler: "small" });
    expect((payload.http.requestBody as { _truncated?: boolean })._truncated).toBeUndefined();
  });

  it("does not mutate the caller's original class-instance request body when redactPaths targets a field with no matching maskBodyKeys", () => {
    // Guards against a mutation hazard found during review: `redactValue`
    // returns a data-bearing class instance BY IDENTITY when no
    // `maskBodyKeys` entry matches it (see `src/redact.ts`). Applying
    // `redactPaths` to that identity-shared value without `serializeBody`'s
    // `forceCopy` guard would mutate the caller's own live object in place.
    class LoginDto {
      constructor(
        public readonly username: string,
        public readonly password: string,
      ) {}
    }
    const originalBody = new LoginDto("alice", "REALSECRET");

    const { logger, log } = createMockLogger();
    const middleware = createRequestLogger({
      logger,
      includeHttpContext: true,
      includeRequestBody: true,
      redactPaths: ["body.password"],
    });

    const { res } = runMiddleware(middleware, { body: originalBody });
    res.emit("finish");

    const payload = log.mock.calls[0][0];
    expect(payload.http.requestBody).toEqual({ username: "alice", password: "[REDACTED]" });
    // The caller's ORIGINAL instance must be untouched.
    expect(originalBody.password).toBe("REALSECRET");
    expect(originalBody.username).toBe("alice");
  });

  it("does not mutate a caller-owned toJSON-defining class-instance body when redactPaths targets its own field", () => {
    // End-to-end variant of the redactValue forceCopy/toJSON mutation fix: a
    // class body that ALSO defines toJSON used to bypass the forceCopy guard
    // (the pass-through early-return fired first) and get mutated in place by
    // the redactPaths step. The middleware must redact the logged value while
    // leaving the caller's live `req.body` object untouched.
    class SessionDto {
      public password = "REALSECRET";
      public username = "alice";
      toJSON() {
        return { username: this.username, password: this.password };
      }
    }
    const originalBody = new SessionDto();

    const { logger, log } = createMockLogger();
    const middleware = createRequestLogger({
      logger,
      includeHttpContext: true,
      includeRequestBody: true,
      redactPaths: ["body.password"],
    });

    const { res } = runMiddleware(middleware, { body: originalBody });
    res.emit("finish");

    const payload = log.mock.calls[0][0];
    expect(payload.http.requestBody).toEqual({ username: "alice", password: "[REDACTED]" });
    expect(JSON.stringify(payload.http.requestBody)).not.toContain("REALSECRET");
    // The caller's ORIGINAL instance must be untouched.
    expect(originalBody.password).toBe("REALSECRET");
    expect(originalBody.username).toBe("alice");
  });

  // ---------------------------------------------------------------------------
  // Phase 5 — redactPaths must not destroy the caller's live context, and must
  // not drop the whole log line when a single path assignment fails.
  // ---------------------------------------------------------------------------

  it("redactPaths:['context.*'] redacts the log line but leaves the caller's live context object intact", () => {
    // The post-assembly redactPaths pass used to write [REDACTED] straight into
    // the object enrich() returned by identity (e.g. req.session), destroying
    // the real value in the running app. entry.context is now an owned copy.
    const session = { token: "REALSECRET", userId: 7 };

    const { logger, log } = createMockLogger();
    const middleware = createRequestLogger({
      logger,
      includeHttpContext: true,
      enrich: () => session,
      redactPaths: ["context.token"],
    });

    const { res } = runMiddleware(middleware);
    res.emit("finish");

    const payload = log.mock.calls[0][0];
    expect(payload.http.context).toEqual({ token: "[REDACTED]", userId: 7 });
    // The caller's live object must still hold the real value.
    expect(session.token).toBe("REALSECRET");
    expect(session.userId).toBe(7);
  });

  it("redactPaths:['context.*'] on a FROZEN context still logs the entry and does not throw", () => {
    // A frozen context is an ordinary defensive pattern. Because entry.context
    // is copied before the redactPaths loop, the copy is writable, so the
    // redaction lands on the copy and the frozen caller object is untouched.
    const frozen = Object.freeze({ userId: 7, token: "SECRET" });

    const { logger, log } = createMockLogger();
    const middleware = createRequestLogger({
      logger,
      includeHttpContext: true,
      enrich: () => frozen,
      redactPaths: ["context.token"],
    });

    const { res } = runMiddleware(middleware);
    expect(() => res.emit("finish")).not.toThrow();

    expect(log).toHaveBeenCalledTimes(1);
    const payload = log.mock.calls[0][0];
    expect(payload.http.context).toEqual({ userId: 7, token: "[REDACTED]" });
    // The caller's frozen object is untouched.
    expect(frozen.token).toBe("SECRET");
  });

  it("redactPaths:['context.*'] targeting a getter-only context prop still logs the entry", () => {
    // JSON.stringify resolves the getter into a plain data field on the copy,
    // so the redaction applies to the copy; the caller's accessor is untouched.
    const context = { userId: 7 };
    Object.defineProperty(context, "token", {
      get: () => "SECRET",
      enumerable: true,
      configurable: false,
    });

    const { logger, log } = createMockLogger();
    const middleware = createRequestLogger({
      logger,
      includeHttpContext: true,
      enrich: () => context as Record<string, unknown>,
      redactPaths: ["context.token"],
    });

    const { res } = runMiddleware(middleware);
    expect(() => res.emit("finish")).not.toThrow();

    expect(log).toHaveBeenCalledTimes(1);
    const payload = log.mock.calls[0][0];
    expect(payload.http.context).toEqual({ userId: 7, token: "[REDACTED]" });
    // The caller's getter is still intact.
    expect((context as Record<string, unknown>).token).toBe("SECRET");
  });

  it("redactPaths:['context.*'] redacts a toJSON-defining context (DTO / Mongoose-style) without mutating the caller", () => {
    // enrich commonly returns req.user — a class instance with a toJSON. The
    // JSON round-trip copy resolves toJSON so the field stays redactable AND
    // the caller's live instance is never touched (it would otherwise be
    // passed through by identity and mutated in place).
    class UserDoc {
      public token = "REALSECRET";
      public id = 42;
      toJSON() {
        return { id: this.id, token: this.token };
      }
    }
    const user = new UserDoc();

    const { logger, log } = createMockLogger();
    const middleware = createRequestLogger({
      logger,
      includeHttpContext: true,
      enrich: () => user as unknown as Record<string, unknown>,
      redactPaths: ["context.token"],
    });

    const { res } = runMiddleware(middleware);
    res.emit("finish");

    const payload = log.mock.calls[0][0];
    expect(payload.http.context).toEqual({ id: 42, token: "[REDACTED]" });
    expect(JSON.stringify(payload.http.context)).not.toContain("REALSECRET");
    // The caller's live document is untouched.
    expect(user.token).toBe("REALSECRET");
  });

  it("redactPaths:['body.tags.length'] does not throw and still logs the entry with the array intact", () => {
    // Assigning [REDACTED] to an array's length throws RangeError; the length
    // guard turns it into a no-op so the whole entry is not dropped.
    const { logger, log } = createMockLogger();
    const middleware = createRequestLogger({
      logger,
      includeHttpContext: true,
      includeRequestBody: true,
      redactPaths: ["body.tags.length"],
    });

    const { res } = runMiddleware(middleware, { body: { tags: ["a", "b"] } });
    expect(() => res.emit("finish")).not.toThrow();

    expect(log).toHaveBeenCalledTimes(1);
    const payload = log.mock.calls[0][0];
    expect(payload.http.requestBody).toEqual({ tags: ["a", "b"] });
  });

  it("redacts a BigInt-carrying context (owned copy, caller untouched) instead of dropping it", () => {
    // A BigInt makes the primary JSON.stringify throw; the BigInt-coercing
    // retry still yields a fully-owned, redactable copy.
    const context: Record<string, unknown> = { id: 100n, token: "REALSECRET" };

    const { logger, log } = createMockLogger();
    const middleware = createRequestLogger({
      logger,
      includeHttpContext: true,
      enrich: () => context,
      redactPaths: ["context.token"],
    });

    const { res } = runMiddleware(middleware);
    expect(() => res.emit("finish")).not.toThrow();

    expect(log).toHaveBeenCalledTimes(1);
    const payload = log.mock.calls[0][0];
    expect(payload.http.context).toEqual({ id: "100", token: "[REDACTED]" });
    // The caller's live object is untouched — its BigInt and secret survive.
    expect(context.id).toBe(100n);
    expect(context.token).toBe("REALSECRET");
  });

  it("redacts a toJSON-defining context that carries a BigInt without mutating the caller (judge regression)", () => {
    // Composite case: a class instance that defines toJSON AND whose serialized
    // form is not JSON-expressible (a BigInt field). redactValue's forceCopy
    // would pass such an instance through BY IDENTITY (toJSON boundary), so the
    // redactPaths write would mutate the caller. The BigInt-coercing round-trip
    // resolves toJSON into a fresh owned object, closing that hole.
    class Ctx {
      token = "REALSECRET";
      toJSON() {
        return { token: this.token, amount: 100n };
      }
    }
    const ctx = new Ctx();

    const { logger, log } = createMockLogger();
    const middleware = createRequestLogger({
      logger,
      includeHttpContext: true,
      enrich: () => ctx as unknown as Record<string, unknown>,
      redactPaths: ["context.token"],
    });

    const { res } = runMiddleware(middleware);
    expect(() => res.emit("finish")).not.toThrow();

    expect(log).toHaveBeenCalledTimes(1);
    const payload = log.mock.calls[0][0];
    expect(payload.http.context).toEqual({ token: "[REDACTED]", amount: "100" });
    expect(JSON.stringify(payload.http.context)).not.toContain("REALSECRET");
    // The caller's live instance MUST be untouched.
    expect(ctx.token).toBe("REALSECRET");
  });

  it("degrades a circular context to an owned sentinel and still logs (no throw, caller untouched)", () => {
    // A circular context cannot be expressed by either round-trip; it degrades
    // to a fresh owned { _unserializable: true } sentinel rather than sharing
    // the caller's live graph or dropping the line.
    const circular: Record<string, unknown> = { token: "REALSECRET" };
    circular.self = circular;

    const { logger, log } = createMockLogger();
    const middleware = createRequestLogger({
      logger,
      includeHttpContext: true,
      enrich: () => circular,
      redactPaths: ["context.token"],
    });

    const { res } = runMiddleware(middleware);
    expect(() => res.emit("finish")).not.toThrow();

    expect(log).toHaveBeenCalledTimes(1);
    const payload = log.mock.calls[0][0];
    expect(payload.http.context).toEqual({ _unserializable: true });
    // The caller's live circular object is untouched.
    expect(circular.token).toBe("REALSECRET");
    expect(circular.self).toBe(circular);
  });

  it("degrades a context whose getter throws to an owned sentinel and still logs the entry", () => {
    // A throwing getter makes both round-trips throw; the line must still be
    // logged (never dropped) and the caller is never mutated.
    const context = { userId: 7 };
    Object.defineProperty(context, "token", {
      get: () => {
        throw new Error("getter boom");
      },
      enumerable: true,
      configurable: false,
    });

    const { logger, log } = createMockLogger();
    const middleware = createRequestLogger({
      logger,
      includeHttpContext: true,
      enrich: () => context as Record<string, unknown>,
      redactPaths: ["context.token"],
    });

    const { res } = runMiddleware(middleware);
    expect(() => res.emit("finish")).not.toThrow();

    expect(log).toHaveBeenCalledTimes(1);
    const payload = log.mock.calls[0][0];
    expect(payload.http.context).toEqual({ _unserializable: true });
  });

  // ---------------------------------------------------------------------------
  // Task #12 — Truncation type stability
  // ---------------------------------------------------------------------------

  it("returns a structured envelope for object bodies that exceed maxBodyLength", () => {
    const { logger, log } = createMockLogger();
    const middleware = createRequestLogger({
      logger,
      includeHttpContext: true,
      includeRequestBody: true,
      maxBodyLength: 20,
    });

    const body = { name: "alice", payload: "x".repeat(100) };
    const { res } = runMiddleware(middleware, { body });
    res.emit("finish");

    const payload = log.mock.calls[0][0];
    const requestBody = payload.http.requestBody;
    expect(requestBody._truncated).toBe(true);
    expect(typeof requestBody._originalLength).toBe("number");
    expect(requestBody._originalLength).toBe(JSON.stringify(body).length);
    expect(typeof requestBody._preview).toBe("string");
    // Total preview length is exactly `maxBodyLength` and ends in the ellipsis.
    expect(requestBody._preview.length).toBe(20);
    expect(requestBody._preview.endsWith("…")).toBe(true);
  });

  it("returns the original object when JSON-serialized form fits within maxBodyLength", () => {
    const { logger, log } = createMockLogger();
    const middleware = createRequestLogger({
      logger,
      includeHttpContext: true,
      includeRequestBody: true,
      maxBodyLength: 5000,
    });

    const body = { ok: true };
    const { res } = runMiddleware(middleware, { body });
    res.emit("finish");

    const payload = log.mock.calls[0][0];
    expect(payload.http.requestBody).toEqual({ ok: true });
    expect((payload.http.requestBody as { _truncated?: boolean })._truncated).toBeUndefined();
  });

  it("truncates string bodies to exactly maxBodyLength characters with trailing ellipsis", () => {
    const { logger, log } = createMockLogger();
    const middleware = createRequestLogger({
      logger,
      includeHttpContext: true,
      includeRequestBody: true,
      maxBodyLength: 8,
    });

    const { res } = runMiddleware(middleware, {
      body: "the-quick-brown-fox-jumps",
    });
    res.emit("finish");

    const payload = log.mock.calls[0][0];
    expect(typeof payload.http.requestBody).toBe("string");
    // Total length is EXACTLY `maxBodyLength`, ending in the single-char ellipsis.
    expect(payload.http.requestBody.length).toBe(8);
    expect(payload.http.requestBody.endsWith("…")).toBe(true);
    expect(payload.http.requestBody).toBe("the-qui…");
  });

  it("works with a raw Node-like request/response (no Express types)", () => {
    // This test exercises the framework-agnostic LoggableRequest /
    // LoggableResponse contract: it constructs minimal duck-typed objects that
    // expose ONLY the surface declared in src/types.ts (no Express methods,
    // no Express getters), and verifies the middleware logs correctly.
    const { logger, log } = createMockLogger();
    const middleware = createRequestLogger({
      logger,
      includeHttpContext: true,
      includeRequestHeaders: true,
      includeResponseHeaders: true,
      includeRequestBody: true,
    });

    const responseEmitter = new EventEmitter();
    const responseHeaders: Record<string, unknown> = {
      "content-type": "application/json",
      "content-length": "42",
    };

    // Build a `LoggableRequest`-shaped object with NO `get` method (raw Node
    // IncomingMessage-like) so the header-fallback path is exercised, and a
    // multi-value header to confirm array-join handling.
    const rawRequest: LoggableRequest = {
      method: "GET",
      url: "/raw/node",
      headers: {
        "user-agent": "node-raw",
        "x-request-id": "raw-id",
        "x-forwarded-for": ["10.0.0.1", "10.0.0.2"],
      },
      body: { hello: "world" },
      socket: { remoteAddress: "10.0.0.1" },
    };

    // Build a `LoggableResponse`-shaped object that delegates listener
    // management to a real EventEmitter so we can fire the `finish` event.
    const rawResponse: LoggableResponse = {
      statusCode: 200,
      getHeader: (name: string) => responseHeaders[name.toLowerCase()],
      getHeaders: () => ({ ...responseHeaders }),
      once: (event, listener) => responseEmitter.once(event, listener),
      removeListener: (event, listener) => responseEmitter.removeListener(event, listener),
      writableEnded: true,
    };

    const next: LoggableNext = jest.fn();
    middleware(rawRequest, rawResponse, next);
    responseEmitter.emit("finish");

    expect(next).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledTimes(1);

    const payload = log.mock.calls[0][0];
    expect(payload.http.event).toBe("completed");
    expect(payload.http.method).toBe("GET");
    expect(payload.http.url).toBe("/raw/node");
    expect(payload.http.statusCode).toBe(200);
    expect(payload.http.userAgent).toBe("node-raw");
    expect(payload.http.requestId).toBe("raw-id");
    expect(payload.http.contentLength).toBe(42);
    expect(payload.http.ip).toBe("10.0.0.1");
    expect(payload.http.requestBody).toEqual({ hello: "world" });
    expect(payload.http.requestHeaders?.["user-agent"]).toBe("node-raw");
    expect(payload.http.requestHeaders?.["x-forwarded-for"]).toEqual(["10.0.0.1", "10.0.0.2"]);
    expect(payload.http.responseHeaders?.["content-type"]).toBe("application/json");
  });

  // ---------------------------------------------------------------------------
  // Task #13 — Honor externally-set start time
  // ---------------------------------------------------------------------------

  it("honors an externally-set start timestamp on req[REQUEST_START_SYMBOL]", () => {
    // An earlier instrumentation hook captured `process.hrtime.bigint()` one
    // second before the middleware ran. The middleware must use that value as
    // the start (NOT capture its own at entry time), so the rendered
    // `responseTimeMs` reflects the true end-to-end latency.
    const { logger, log } = createMockLogger();
    const middleware = createRequestLogger({ logger, includeHttpContext: true });

    const externalStart = process.hrtime.bigint() - 1_000_000_000n; // -1s in ns
    const overrides = { [REQUEST_START_SYMBOL]: externalStart } as Partial<MockRequest>;

    const { res } = runMiddleware(middleware, overrides);
    res.emit("finish");

    const payload = log.mock.calls[0][0];
    expect(payload.http.responseTimeMs).toBeGreaterThanOrEqual(1000);
  });

  it("falls back to in-middleware capture when REQUEST_START_SYMBOL is not a bigint", () => {
    // A consumer who accidentally assigns a `number` (e.g. `Date.now()`) must
    // not crash the request — the middleware silently ignores the bad value
    // and captures its own start at entry time, producing a sensible
    // (small) `responseTimeMs`.
    const { logger, log } = createMockLogger();
    const middleware = createRequestLogger({ logger, includeHttpContext: true });

    const badStart = Date.now() - 5000; // a `number`, not a `bigint`
    const overrides = { [REQUEST_START_SYMBOL]: badStart } as unknown as Partial<MockRequest>;

    const { res } = runMiddleware(middleware, overrides);
    res.emit("finish");

    const payload = log.mock.calls[0][0];
    // Captured at entry time, not at `Date.now() - 5000` → should be tiny.
    expect(typeof payload.http.responseTimeMs).toBe("number");
    expect(payload.http.responseTimeMs).toBeLessThan(1000);
  });

  // ---------------------------------------------------------------------------
  // Task #20 — Refined aborted classification
  // ---------------------------------------------------------------------------

  it("classifies a close event with writableEnded:false as aborted", () => {
    // True abort scenario: the client disconnected before the response body
    // was fully written. The middleware must report `event === "aborted"` and
    // surface `responseWritableEnded === false`.
    const { logger, log } = createMockLogger();
    const middleware = createRequestLogger({ logger, includeHttpContext: true });

    const { res } = runMiddleware(middleware);
    (res as unknown as { writableEnded: boolean }).writableEnded = false;
    (res as unknown as { destroyed: boolean }).destroyed = true;
    res.emit("close");

    const payload = log.mock.calls[0][0];
    expect(payload.http.event).toBe("aborted");
    expect(payload.http.responseWritableEnded).toBe(false);
    expect(payload.http.responseDestroyed).toBe(true);
  });

  it("classifies a close event with writableEnded:true as completed", () => {
    // Benign post-finish close (HTTP/1 keep-alive socket teardown). The
    // response body WAS fully written, so the middleware must NOT classify
    // the close as aborted.
    const { logger, log } = createMockLogger();
    const middleware = createRequestLogger({ logger, includeHttpContext: true });

    const { res } = runMiddleware(middleware);
    // Simulate the response body being fully written before the close fires.
    (res as unknown as { writableEnded: boolean }).writableEnded = true;
    res.emit("close");

    const payload = log.mock.calls[0][0];
    expect(payload.http.event).toBe("completed");
    expect(payload.http.responseWritableEnded).toBe(true);
  });

  it("logs a single completed entry when finish then close fire in sequence", () => {
    // The `finish` handler removes the `close` listener so the close never
    // fires the second log call. End-to-end this means a normal request
    // produces exactly one entry with `event === "completed"`.
    const { logger, log } = createMockLogger();
    const middleware = createRequestLogger({ logger, includeHttpContext: true });

    const { res } = runMiddleware(middleware);
    (res as unknown as { writableEnded: boolean }).writableEnded = true;
    res.emit("finish");
    res.emit("close");

    expect(log).toHaveBeenCalledTimes(1);
    const payload = log.mock.calls[0][0];
    expect(payload.http.event).toBe("completed");
    expect(payload.http.responseWritableEnded).toBe(true);
  });

  it("captures req.aborted when the request adapter exposes it", () => {
    const { logger, log } = createMockLogger();
    const middleware = createRequestLogger({ logger, includeHttpContext: true });

    const { res } = runMiddleware(middleware, {
      aborted: true,
    } as Partial<MockRequest>);
    (res as unknown as { writableEnded: boolean }).writableEnded = false;
    res.emit("close");

    const payload = log.mock.calls[0][0];
    expect(payload.http.requestAborted).toBe(true);
    expect(payload.http.event).toBe("aborted");
  });

  // ---------------------------------------------------------------------------
  // Task #21 — Body snapshot timing
  // ---------------------------------------------------------------------------

  // ---------------------------------------------------------------------------
  // Task #33 — Structured option validation (RequestLoggerOptionError)
  // ---------------------------------------------------------------------------

  describe("structured option validation (RequestLoggerOptionError)", () => {
    it("throws RequestLoggerOptionError({ code: 'INVALID_LEVEL' }) for an unknown level string", () => {
      let caught: unknown;
      try {
        createRequestLogger({ level: "noisy" as unknown as "info" });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(RequestLoggerOptionError);
      expect((caught as RequestLoggerOptionError).code).toBe("INVALID_LEVEL");
      expect((caught as RequestLoggerOptionError).message).toContain("level");
    });

    it("accepts a function-form level without throwing", () => {
      const { logger } = createMockLogger();
      expect(() =>
        createRequestLogger({ logger, level: (status) => (status >= 500 ? "error" : "info") }),
      ).not.toThrow();
    });

    it("throws RequestLoggerOptionError({ code: 'INVALID_MASK' }) when maskBodyKeys is not an array", () => {
      let caught: unknown;
      try {
        createRequestLogger({
          maskBodyKeys: "password" as unknown as string[],
        });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(RequestLoggerOptionError);
      expect((caught as RequestLoggerOptionError).code).toBe("INVALID_MASK");
      expect((caught as RequestLoggerOptionError).message).toContain("maskBodyKeys");
    });

    it("throws RequestLoggerOptionError({ code: 'INVALID_MASK' }) when a maskBodyKeys entry is not a string", () => {
      let caught: unknown;
      try {
        createRequestLogger({
          maskBodyKeys: ["password", 42 as unknown as string],
        });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(RequestLoggerOptionError);
      expect((caught as RequestLoggerOptionError).code).toBe("INVALID_MASK");
      expect((caught as RequestLoggerOptionError).message).toContain("index 1");
    });

    it("throws RequestLoggerOptionError({ code: 'INVALID_MASK' }) when maskHeaderKeys is the wrong type", () => {
      let caught: unknown;
      try {
        createRequestLogger({
          maskHeaderKeys: 123 as unknown as string[],
        });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(RequestLoggerOptionError);
      expect((caught as RequestLoggerOptionError).code).toBe("INVALID_MASK");
      expect((caught as RequestLoggerOptionError).message).toContain("maskHeaderKeys");
      // For header masks, the message also mentions the `false` opt-out form.
      expect((caught as RequestLoggerOptionError).message).toContain("false");
    });

    it("accepts maskHeaderKeys: false (opt-out for safe-defaults masking)", () => {
      expect(() => createRequestLogger({ maskHeaderKeys: false })).not.toThrow();
    });

    it("accepts maskQueryKeys: false (opt-out for safe-defaults query masking)", () => {
      expect(() => createRequestLogger({ maskQueryKeys: false })).not.toThrow();
    });

    it("throws RequestLoggerOptionError({ code: 'INVALID_MASK' }) when maskQueryKeys is the wrong type", () => {
      let caught: unknown;
      try {
        createRequestLogger({
          maskQueryKeys: { invalid: true } as unknown as string[],
        });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(RequestLoggerOptionError);
      expect((caught as RequestLoggerOptionError).code).toBe("INVALID_MASK");
      expect((caught as RequestLoggerOptionError).message).toContain("maskQueryKeys");
    });

    it("validates options even when loggingEnabled is false (errors surface up front)", () => {
      // The pass-through middleware short-circuits AFTER validation, so
      // misconfigured options still throw when the consumer disables logging.
      expect(() =>
        createRequestLogger({
          loggingEnabled: false,
          maskBodyKeys: "nope" as unknown as string[],
        }),
      ).toThrow(RequestLoggerOptionError);
    });

    it("throws RequestLoggerOptionError({ code: 'INVALID_BODY_LIMIT' }) for NaN", () => {
      let caught: unknown;
      try {
        createRequestLogger({ maxBodyLength: NaN });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(RequestLoggerOptionError);
      expect((caught as RequestLoggerOptionError).code).toBe("INVALID_BODY_LIMIT");
      expect((caught as RequestLoggerOptionError).message).toContain("maxBodyLength");
    });

    it("throws RequestLoggerOptionError({ code: 'INVALID_BODY_LIMIT' }) for 0", () => {
      let caught: unknown;
      try {
        createRequestLogger({ maxBodyLength: 0 });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(RequestLoggerOptionError);
      expect((caught as RequestLoggerOptionError).code).toBe("INVALID_BODY_LIMIT");
      expect((caught as RequestLoggerOptionError).message).toContain("maxBodyLength");
    });

    it("throws RequestLoggerOptionError({ code: 'INVALID_BODY_LIMIT' }) for a negative value", () => {
      let caught: unknown;
      try {
        createRequestLogger({ maxBodyLength: -5 });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(RequestLoggerOptionError);
      expect((caught as RequestLoggerOptionError).code).toBe("INVALID_BODY_LIMIT");
      expect((caught as RequestLoggerOptionError).message).toContain("maxBodyLength");
    });

    it("throws RequestLoggerOptionError({ code: 'INVALID_BODY_LIMIT' }) for a non-number type", () => {
      let caught: unknown;
      try {
        createRequestLogger({ maxBodyLength: "100" as unknown as number });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(RequestLoggerOptionError);
      expect((caught as RequestLoggerOptionError).code).toBe("INVALID_BODY_LIMIT");
      expect((caught as RequestLoggerOptionError).message).toContain("maxBodyLength");
    });

    it("accepts a valid positive maxBodyLength without throwing", () => {
      const { logger } = createMockLogger();
      expect(() => createRequestLogger({ logger, maxBodyLength: 5000 })).not.toThrow();
    });

    it("accepts Infinity as maxBodyLength and never truncates the body", () => {
      const { logger, log } = createMockLogger();
      const body = "x".repeat(4000);
      const middleware = createRequestLogger({
        logger,
        includeRequestBody: true,
        includeHttpContext: true,
        maxBodyLength: Infinity,
      });

      const { res } = runMiddleware(middleware, { body });
      res.emit("finish");

      const payload = log.mock.calls[0][0];
      expect(typeof payload.http.requestBody).toBe("string");
      expect(payload.http.requestBody).toBe(body);
      expect((payload.http.requestBody as string).length).toBe(4000);
    });

    it("throws RequestLoggerOptionError({ code: 'INVALID_MASK' }) when redactPaths is a string instead of array", () => {
      let caught: unknown;
      try {
        createRequestLogger({ redactPaths: "body.password" as unknown as string[] });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(RequestLoggerOptionError);
      expect((caught as RequestLoggerOptionError).code).toBe("INVALID_MASK");
      expect((caught as RequestLoggerOptionError).message).toContain("redactPaths");
    });

    it("throws RequestLoggerOptionError({ code: 'INVALID_MASK' }) when a redactPaths entry is not a string", () => {
      let caught: unknown;
      try {
        createRequestLogger({ redactPaths: ["body.user.password", 42 as unknown as string] });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(RequestLoggerOptionError);
      expect((caught as RequestLoggerOptionError).code).toBe("INVALID_MASK");
      expect((caught as RequestLoggerOptionError).message).toContain("redactPaths");
      expect((caught as RequestLoggerOptionError).message).toContain("index 1");
    });

    it("accepts redactPaths: undefined without throwing", () => {
      const { logger } = createMockLogger();
      expect(() => createRequestLogger({ logger, redactPaths: undefined })).not.toThrow();
    });

    it("accepts a valid string[] for redactPaths without throwing", () => {
      const { logger } = createMockLogger();
      expect(() =>
        createRequestLogger({ logger, redactPaths: ["body.user.password", "context.token"] }),
      ).not.toThrow();
    });

    it("RequestLoggerOptionError without a cause leaves `cause` as undefined", () => {
      const err = new RequestLoggerOptionError("INVALID_LEVEL", "no cause");
      expect(err.code).toBe("INVALID_LEVEL");
      expect(err.cause).toBeUndefined();
      expect(err.name).toBe("RequestLoggerOptionError");
    });

    it("RequestLoggerOptionError preserves an explicit `cause` value", () => {
      const cause = new Error("underlying");
      const err = new RequestLoggerOptionError("INVALID_MASK", "wrapped", { cause });
      expect(err.cause).toBe(cause);
    });
  });

  it("snapshots req.body at entry time so handler-time mutation does not affect the log", () => {
    // Capture the snapshot BEFORE next() returns. The "handler" then replaces
    // `req.body` with a sentinel — the logged body must still be the original.
    const { logger, log } = createMockLogger();
    const middleware = createRequestLogger({
      logger,
      includeHttpContext: true,
      includeRequestBody: true,
    });

    const original = { email: "user@example.com", important: "keep-me" };
    const { req, res } = runMiddleware(middleware, { body: original });

    // Simulate the downstream handler mutating req.body after next() ran.
    (req as { body: unknown }).body = { redacted: true };

    res.emit("finish");

    const payload = log.mock.calls[0][0];
    expect(payload.http.requestBody).toEqual({
      email: "user@example.com",
      important: "keep-me",
    });
    // And as a sanity check: the request DID get mutated.
    expect((req as { body: unknown }).body).toEqual({ redacted: true });
  });

  // ---------------------------------------------------------------------------
  // Phase 1 — finalize() never-crash hardening (Task 1.2)
  // ---------------------------------------------------------------------------

  it("does not propagate when enrich throws, and writes one console.error", () => {
    const { logger, log } = createMockLogger();
    const errSpy = jest.spyOn(console, "error").mockImplementation(() => undefined);
    const middleware = createRequestLogger({
      logger,
      enrich: () => {
        throw new Error("enrich boom");
      },
    });

    const { res } = runMiddleware(middleware);
    expect(() => res.emit("finish")).not.toThrow();

    expect(log).not.toHaveBeenCalled();
    expect(errSpy).toHaveBeenCalledTimes(1);
    expect(errSpy.mock.calls[0][0]).toContain("@hiprax/logger request logger failed");
  });

  it("does not propagate when messageBuilder throws, and writes one console.error", () => {
    const { logger, log } = createMockLogger();
    const errSpy = jest.spyOn(console, "error").mockImplementation(() => undefined);
    const middleware = createRequestLogger({
      logger,
      messageBuilder: () => {
        throw new Error("messageBuilder boom");
      },
    });

    const { res } = runMiddleware(middleware);
    expect(() => res.emit("finish")).not.toThrow();

    expect(log).not.toHaveBeenCalled();
    expect(errSpy).toHaveBeenCalledTimes(1);
    expect(errSpy.mock.calls[0][0]).toContain("@hiprax/logger request logger failed");
  });

  it("does not propagate when logger.log throws, and writes one console.error", () => {
    const { logger, log } = createMockLogger();
    log.mockImplementation(() => {
      throw "log string throw";
    });
    const errSpy = jest.spyOn(console, "error").mockImplementation(() => undefined);
    const middleware = createRequestLogger({ logger });

    const { res } = runMiddleware(middleware);
    expect(() => res.emit("finish")).not.toThrow();

    expect(log).toHaveBeenCalledTimes(1);
    expect(errSpy).toHaveBeenCalledTimes(1);
    expect(errSpy.mock.calls[0][0]).toContain("log string throw");
  });

  it("does not propagate when a function-form level throws, and writes one console.error", () => {
    const { logger, log } = createMockLogger();
    const errSpy = jest.spyOn(console, "error").mockImplementation(() => undefined);
    const middleware = createRequestLogger({
      logger,
      level: (_statusCode: number) => {
        throw new Error("level boom");
      },
    });

    const { res } = runMiddleware(middleware);
    expect(() => res.emit("finish")).not.toThrow();

    expect(log).not.toHaveBeenCalled();
    expect(errSpy).toHaveBeenCalledTimes(1);
    expect(errSpy.mock.calls[0][0]).toContain("@hiprax/logger request logger failed");
  });

  it("catch block falls back to GET and empty string when method and URL fields are absent", () => {
    const { logger } = createMockLogger();
    const errSpy = jest.spyOn(console, "error").mockImplementation(() => undefined);
    const middleware = createRequestLogger({
      logger,
      enrich: () => {
        throw new Error("enrich boom fallback");
      },
    });

    const { res } = runMiddleware(middleware, {
      method: undefined as unknown as string,
      originalUrl: undefined as unknown as string,
      url: undefined as unknown as string,
    });
    expect(() => res.emit("finish")).not.toThrow();

    expect(errSpy).toHaveBeenCalledTimes(1);
    expect(errSpy.mock.calls[0][0]).toMatch(/GET .* enrich boom fallback/);
  });

  // ---------------------------------------------------------------------------
  // Phase 6 — the error path must not leak the raw URL
  //
  // The happy path masks query secrets via `redactUrlQuery`, but finalize()'s
  // catch used to rebuild its console.error message from the RAW
  // `req.originalUrl ?? req.url`. Any throwing user callback therefore printed
  // the cleartext query string to stderr — leaking exactly the secrets
  // `maskQueryKeys` promises to mask. `code` is in DEFAULT_MASKED_QUERY_KEYS,
  // so these tests need no explicit `maskQueryKeys` option.
  //
  // The pre-existing never-crash tests above all drive the query-less default
  // url (`/auth/login`) and only assert the message prefix, which is why this
  // went unnoticed.
  // ---------------------------------------------------------------------------

  const SECRET_URL = "/oauth/cb?code=SUPER_SECRET_AUTH_CODE&state=x";

  it("redacts query secrets in the error-path message when enrich throws", () => {
    const { logger } = createMockLogger();
    const errSpy = jest.spyOn(console, "error").mockImplementation(() => undefined);
    const middleware = createRequestLogger({
      logger,
      enrich: () => {
        throw new Error("enrich boom");
      },
    });

    const { res } = runMiddleware(middleware, { originalUrl: SECRET_URL });
    expect(() => res.emit("finish")).not.toThrow();

    expect(errSpy).toHaveBeenCalledTimes(1);
    const message = errSpy.mock.calls[0][0] as string;
    expect(message).not.toContain("SUPER_SECRET_AUTH_CODE");
    expect(message).toContain("code=[REDACTED]");
    // Non-masked siblings must survive byte-for-byte.
    expect(message).toContain("state=x");
    expect(message).toContain("enrich boom");
  });

  it("redacts query secrets in the error-path message when messageBuilder throws", () => {
    const { logger } = createMockLogger();
    const errSpy = jest.spyOn(console, "error").mockImplementation(() => undefined);
    const middleware = createRequestLogger({
      logger,
      messageBuilder: () => {
        throw new Error("messageBuilder boom");
      },
    });

    const { res } = runMiddleware(middleware, { originalUrl: SECRET_URL });
    expect(() => res.emit("finish")).not.toThrow();

    expect(errSpy).toHaveBeenCalledTimes(1);
    const message = errSpy.mock.calls[0][0] as string;
    expect(message).not.toContain("SUPER_SECRET_AUTH_CODE");
    expect(message).toContain("code=[REDACTED]");
    expect(message).toContain("messageBuilder boom");
  });

  it("redacts query secrets in the error-path message when logger.log throws", () => {
    const { logger, log } = createMockLogger();
    log.mockImplementation(() => {
      throw new Error("log boom");
    });
    const errSpy = jest.spyOn(console, "error").mockImplementation(() => undefined);
    const middleware = createRequestLogger({ logger });

    const { res } = runMiddleware(middleware, { originalUrl: SECRET_URL });
    expect(() => res.emit("finish")).not.toThrow();

    expect(errSpy).toHaveBeenCalledTimes(1);
    const message = errSpy.mock.calls[0][0] as string;
    expect(message).not.toContain("SUPER_SECRET_AUTH_CODE");
    expect(message).toContain("code=[REDACTED]");
    expect(message).toContain("log boom");
  });

  it("redacts query secrets on the error path when the throw precedes URL resolution", () => {
    // A function-form `level` throws BEFORE the happy path resolves/redacts the
    // URL. This is why the catch recomputes the redacted URL itself rather than
    // reading a value hoisted out of the try: at this throw position no such
    // value would exist yet, and the message would lose the URL entirely.
    const { logger } = createMockLogger();
    const errSpy = jest.spyOn(console, "error").mockImplementation(() => undefined);
    const middleware = createRequestLogger({
      logger,
      level: () => {
        throw new Error("level boom");
      },
    });

    const { res } = runMiddleware(middleware, { originalUrl: SECRET_URL });
    expect(() => res.emit("finish")).not.toThrow();

    expect(errSpy).toHaveBeenCalledTimes(1);
    const message = errSpy.mock.calls[0][0] as string;
    expect(message).not.toContain("SUPER_SECRET_AUTH_CODE");
    expect(message).toContain("code=[REDACTED]");
  });

  it("honors a custom maskQueryKeys list on the error path", () => {
    const { logger } = createMockLogger();
    const errSpy = jest.spyOn(console, "error").mockImplementation(() => undefined);
    const middleware = createRequestLogger({
      logger,
      maskQueryKeys: ["sessionid"],
      enrich: () => {
        throw new Error("enrich boom");
      },
    });

    const { res } = runMiddleware(middleware, {
      originalUrl: "/x?sessionid=SUPER_SECRET_SESSION&page=2",
    });
    expect(() => res.emit("finish")).not.toThrow();

    const message = errSpy.mock.calls[0][0] as string;
    expect(message).not.toContain("SUPER_SECRET_SESSION");
    expect(message).toContain("sessionid=[REDACTED]");
    expect(message).toContain("page=2");
  });

  it("falls back to the raw url when originalUrl is absent on the error path", () => {
    // `req.url` is the raw-Node fallback and must be redacted just the same.
    const { logger } = createMockLogger();
    const errSpy = jest.spyOn(console, "error").mockImplementation(() => undefined);
    const middleware = createRequestLogger({
      logger,
      enrich: () => {
        throw new Error("enrich boom");
      },
    });

    const { res } = runMiddleware(middleware, {
      originalUrl: undefined as unknown as string,
      url: SECRET_URL,
    });
    expect(() => res.emit("finish")).not.toThrow();

    const message = errSpy.mock.calls[0][0] as string;
    expect(message).not.toContain("SUPER_SECRET_AUTH_CODE");
    expect(message).toContain("code=[REDACTED]");
  });

  it("does not throw from the error path when reading the URL itself throws", () => {
    // The error handler runs inside the `res` "finish" emitter, where an
    // exception is an UNCAUGHT exception, not a dropped log line. An exotic
    // request object can expose a throwing `originalUrl` getter, so the
    // catch's own URL resolution is self-guarded and degrades to "".
    const { logger } = createMockLogger();
    const errSpy = jest.spyOn(console, "error").mockImplementation(() => undefined);
    const middleware = createRequestLogger({ logger });

    const { req, res } = runMiddleware(middleware);
    // Defined AFTER middleware entry: the middleware body never reads the URL,
    // only finalize() does, and `Object.assign` in runMiddleware would have
    // invoked the getter too early.
    Object.defineProperty(req, "originalUrl", {
      get: () => {
        throw new Error("hostile getter");
      },
    });

    expect(() => res.emit("finish")).not.toThrow();

    expect(errSpy).toHaveBeenCalledTimes(1);
    expect(errSpy.mock.calls[0][0]).toContain("hostile getter");
  });

  it("leaves the query untouched on the error path when maskQueryKeys is false", () => {
    // The `false` opt-out disables query masking, and the error path must honor
    // it exactly as the happy path does — not fall back to the default list.
    const { logger } = createMockLogger();
    const errSpy = jest.spyOn(console, "error").mockImplementation(() => undefined);
    const middleware = createRequestLogger({
      logger,
      maskQueryKeys: false,
      enrich: () => {
        throw new Error("enrich boom");
      },
    });

    const { res } = runMiddleware(middleware, { originalUrl: SECRET_URL });
    expect(() => res.emit("finish")).not.toThrow();

    expect(errSpy.mock.calls[0][0]).toContain("code=SUPER_SECRET_AUTH_CODE");
  });

  it("does not throw from the error path when every reported field throws", () => {
    // Last-resort guard: the handler runs inside the `res` "finish" emitter, so
    // a throw here is an UNCAUGHT exception, not a dropped line. A request whose
    // `method` getter throws (alongside an error whose `message` getter throws)
    // must still degrade to a single console.error rather than crash.
    const { logger } = createMockLogger();
    const errSpy = jest.spyOn(console, "error").mockImplementation(() => undefined);

    const hostileError = new Error("ignored");
    Object.defineProperty(hostileError, "message", {
      get: () => {
        throw new Error("hostile message getter");
      },
    });

    const middleware = createRequestLogger({
      logger,
      enrich: () => {
        throw hostileError;
      },
    });

    const { req, res } = runMiddleware(middleware);
    Object.defineProperty(req, "method", {
      get: () => {
        throw new Error("hostile method getter");
      },
    });

    expect(() => res.emit("finish")).not.toThrow();

    expect(errSpy).toHaveBeenCalledTimes(1);
    expect(errSpy.mock.calls[0][0]).toBe(
      "@hiprax/logger request logger failed, and so did reporting the failure.",
    );
  });

  // ---------------------------------------------------------------------------
  // Phase 2 — function-form level validated at request time (Task 2.3)
  // ---------------------------------------------------------------------------

  it("function-form level returning an invalid string logs at the status-derived level (2xx → info)", () => {
    const { logger, log } = createMockLogger();
    const middleware = createRequestLogger({
      logger,
      level: () => "not-a-level" as unknown as LogLevel,
    });

    const { res } = runMiddleware(middleware);
    res.statusCode = 200;
    res.emit("finish");

    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0].level).toBe("info");
  });

  it("function-form level returning undefined logs at the status-derived level (5xx → error)", () => {
    const { logger, log } = createMockLogger();
    const middleware = createRequestLogger({
      logger,
      level: () => undefined as unknown as LogLevel,
    });

    const { res } = runMiddleware(middleware);
    res.statusCode = 500;
    res.emit("finish");

    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0].level).toBe("error");
  });

  it("function-form level returning undefined logs at the status-derived level (4xx → warn)", () => {
    const { logger, log } = createMockLogger();
    const middleware = createRequestLogger({
      logger,
      level: () => undefined as unknown as LogLevel,
    });

    const { res } = runMiddleware(middleware);
    res.statusCode = 404;
    res.emit("finish");

    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0].level).toBe("warn");
  });

  // ---------------------------------------------------------------------------
  // Phase 9 — API / type / hot-path polish (Tasks 9.1, 9.3)
  // ---------------------------------------------------------------------------

  it("enrich type accepts null return without a cast (Phase 9 — widened return type)", () => {
    // This test compiles without the `as unknown as Record<string, unknown>`
    // cast that was needed before the type widening. The runtime behavior
    // (no context on the entry) is the same as the existing null-return test.
    const { logger, log } = createMockLogger();
    const middleware = createRequestLogger({
      logger,
      includeHttpContext: true,
      // TypeScript must accept `() => null` without an explicit cast.
      enrich: (): null => null,
    });

    const { res } = runMiddleware(middleware);
    res.emit("finish");

    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0].http.context).toBeUndefined();
  });

  it("enrich type accepts undefined return without a cast (Phase 9 — widened return type)", () => {
    // Mirrors the null variant above for the undefined branch.
    const { logger, log } = createMockLogger();
    const middleware = createRequestLogger({
      logger,
      includeHttpContext: true,
      enrich: (): undefined => undefined,
    });

    const { res } = runMiddleware(middleware);
    res.emit("finish");

    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0].http.context).toBeUndefined();
  });

  it("maskBodyKeys is pre-resolved at construction and redacts body keys case-insensitively (Phase 9)", () => {
    // Verify that the pre-resolved bodyMaskSet is used correctly end-to-end:
    // construction happens once, per-request path passes the Set to
    // serializeBody without rebuilding it.
    const { logger, log } = createMockLogger();
    const middleware = createRequestLogger({
      logger,
      includeHttpContext: true,
      includeRequestBody: true,
      maskBodyKeys: ["password", "Token"],
    });

    const { res } = runMiddleware(middleware, {
      body: { username: "alice", Password: "secret", token: "abc123" },
    });
    res.emit("finish");

    expect(log).toHaveBeenCalledTimes(1);
    const body = log.mock.calls[0][0].http.requestBody as Record<string, unknown>;
    expect(body.username).toBe("alice");
    // Case-insensitive: "password" in maskBodyKeys → "Password" key is redacted.
    expect(body.Password).toBe("[REDACTED]");
    // Case-insensitive: "Token" in maskBodyKeys → "token" key is redacted.
    expect(body.token).toBe("[REDACTED]");
  });
});

describe("request middleware internals", () => {
  const {
    serializeBody,
    normalizeHeaders,
    toNumber,
    shouldLogForEnvironment,
    truncateString,
    buildTruncatedEnvelope,
    redactUrlQuery,
    redactEntryPath,
    resolveMaskHeaderKeys,
    resolveMaskQueryKeys,
    DEFAULT_MASKED_HEADER_KEYS,
    DEFAULT_MASKED_QUERY_KEYS,
  } = __requestInternals;

  it("serializes primitive bodies and truncates strings", () => {
    expect(serializeBody("hello", undefined, 100)).toBe("hello");
    // Total length is now exactly `maxBodyLength` (4): `tru` (3 chars) + `…`.
    expect(serializeBody("truncate-me", undefined, 4)).toBe("tru…");
  });

  it("serializeBody accepts a pre-resolved ReadonlySet<string> and redacts correctly (Phase 9 — Task 9.3)", () => {
    // When the caller passes a Set (as the construction-time bodyMaskSet does),
    // serializeBody must use it directly without building a new Set. The
    // redaction must still be case-insensitive because redactValue checks
    // maskKeys.has(key.toLowerCase()).
    const maskSet = new Set(["password", "token"]);
    const body = { email: "user@example.com", Password: "secret", token: "abc", visible: "yes" };
    const result = serializeBody(body, maskSet) as Record<string, unknown>;
    expect(result.email).toBe("user@example.com");
    // redactValue lowercases the object key before checking the Set.
    expect(result.Password).toBe("[REDACTED]");
    expect(result.token).toBe("[REDACTED]");
    expect(result.visible).toBe("yes");
  });

  it("serializeBody still accepts a string[] array for maskKeys (backward compat for test callers)", () => {
    // Existing callers via __requestInternals continue to pass arrays.
    const body = { x: "keep", secret: "leak" };
    const result = serializeBody(body, ["secret"]) as Record<string, unknown>;
    expect(result.x).toBe("keep");
    expect(result.secret).toBe("[REDACTED]");
  });

  it("serializeBody applies the 4th bodyRedactPaths arg to an over-limit body so the secret cannot survive inside _preview", () => {
    const body = { password: "SECRET", filler: "x".repeat(4000) };
    const result = serializeBody(body, undefined, 3000, ["body.password"]) as {
      _truncated: boolean;
      _originalLength: number;
      _preview: string;
    };
    expect(result._truncated).toBe(true);
    expect(result._preview).not.toContain("SECRET");
    expect(result._preview).toContain("[REDACTED]");
  });

  it("serializeBody's bodyRedactPaths param is opt-in — omitting it leaves the pre-existing truncation behavior unchanged (backward compat)", () => {
    // Identical over-limit body and target field as the test above, but the
    // 4th argument is never passed — exactly what every pre-existing call
    // site does. `serializeBody` has no other way to learn about
    // `redactPaths`, so the secret is (as before this parameter existed)
    // still present in `_preview`. Pins that the new parameter only changes
    // behavior when a caller explicitly opts in.
    const body = { password: "SECRET", filler: "x".repeat(4000) };
    const result = serializeBody(body, undefined, 3000) as {
      _truncated: boolean;
      _preview: string;
    };
    expect(result._truncated).toBe(true);
    expect(result._preview).toContain("SECRET");
  });

  it("serializeBody does not mutate a caller-owned class-instance body when applying bodyRedactPaths to an unmasked field", () => {
    class LoginDto {
      constructor(
        public readonly username: string,
        public readonly password: string,
      ) {}
    }
    const originalBody = new LoginDto("alice", "REALSECRET");

    const result = serializeBody(originalBody, undefined, 3000, ["body.password"]) as Record<
      string,
      unknown
    >;

    expect(result).toEqual({ username: "alice", password: "[REDACTED]" });
    expect(originalBody.password).toBe("REALSECRET");
    expect(originalBody.username).toBe("alice");
  });

  it("truncates fallback strings when JSON serialization fails", () => {
    const problematic = {
      toJSON() {
        throw new Error("boom");
      },
      toString() {
        return "fallback-string";
      },
    };

    // Total length now exactly `maxBodyLength` (5): `fall` + `…`.
    expect(serializeBody(problematic, undefined, 5)).toBe("fall…");
  });

  it("normalizes headers across edge cases", () => {
    const headers = { Authorization: "Bearer secret", Foo: "bar" };
    expect(normalizeHeaders(headers, false)).toBeUndefined();
    expect(normalizeHeaders(undefined, true)).toEqual({});
    expect(normalizeHeaders(undefined, ["authorization"])).toBeUndefined();
    expect(normalizeHeaders({}, true)).toEqual({});
    expect(normalizeHeaders(headers, ["authorization"])).toEqual({
      authorization: "Bearer secret",
    });
    expect(normalizeHeaders({ Foo: "bar" }, ["missing"])).toBeUndefined();
  });

  it("converts numeric strings and rejects invalid values", () => {
    expect(toNumber("123")).toBe(123);
    expect(toNumber("abc")).toBeUndefined();
  });

  it("detects development environments for dev-only logging", () => {
    withEnv("NODE_ENV", "development", () => {
      expect(shouldLogForEnvironment("dev-only")).toBe(true);
    });
    withEnv("NODE_ENV", "production", () => {
      expect(shouldLogForEnvironment("dev-only")).toBe(false);
    });
  });

  it("disables logging when mode is never", () => {
    expect(shouldLogForEnvironment("never")).toBe(false);
  });

  it("respects custom allow lists and fallback behavior", () => {
    withEnv("APP_ENV", undefined, () => {
      expect(shouldLogForEnvironment({ sources: ["APP_ENV"], allow: ["qa"], fallback: true })).toBe(
        true,
      );
    });
    withEnv("APP_ENV", "qa", () => {
      expect(
        shouldLogForEnvironment({ sources: ["APP_ENV"], allow: ["qa"], fallback: false }),
      ).toBe(true);
    });
    withEnv("APP_ENV", "prod", () => {
      expect(
        shouldLogForEnvironment({ sources: ["APP_ENV"], allow: ["qa"], fallback: false }),
      ).toBe(false);
    });
  });

  it("reuses default sources and allow lists when custom inputs are empty", () => {
    withEnv("NODE_ENV", "DEV", () => {
      expect(shouldLogForEnvironment({ sources: [], allow: [], fallback: false })).toBe(true);
    });
    withEnv("NODE_ENV", "production", () => {
      expect(shouldLogForEnvironment({ sources: [], allow: [], fallback: false })).toBe(false);
    });
  });

  it("enables logging for prod-only mode when NODE_ENV matches", () => {
    withEnv("NODE_ENV", "production", () => {
      expect(shouldLogForEnvironment("prod-only")).toBe(true);
    });
    withEnv("NODE_ENV", "dev", () => {
      expect(shouldLogForEnvironment("prod-only")).toBe(false);
    });
  });

  it("enables logging for test-only mode when NODE_ENV matches", () => {
    withEnv("NODE_ENV", "testing", () => {
      expect(shouldLogForEnvironment("test-only")).toBe(true);
    });
    withEnv("NODE_ENV", "production", () => {
      expect(shouldLogForEnvironment("test-only")).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // Task #11 / #12 internals
  // ---------------------------------------------------------------------------

  it("truncateString returns the input unchanged when within the limit", () => {
    expect(truncateString("hi", 10)).toBe("hi");
    expect(truncateString("ten-char!!", 10)).toBe("ten-char!!");
  });

  it("truncateString handles degenerate maxLength values (0 and 1)", () => {
    expect(truncateString("anything", 0)).toBe("");
    expect(truncateString("anything", 1)).toBe("…");
  });

  it("truncateString counts code points so emoji surrogate pairs survive intact", () => {
    // `"😀"` (U+1F600) is encoded as a UTF-16 surrogate pair (2 code units, 1
    // code point). The string `"ab😀😀"` has 4 code points but 6 code units.
    // A naive `value.slice(0, maxLength - 1)` operating on UTF-16 code units
    // can land a truncation point inside a surrogate pair, leaving a lone
    // high surrogate behind that renders as the Unicode replacement
    // character. The code-point-aware implementation walks the string
    // iterator instead, so an emoji is kept whole or skipped entirely —
    // never torn in half.
    //
    // For `truncateString("ab😀😀", 4)`: maxLength=4, so the bounded for...of
    // collects 3 code points = `['a', 'b', '😀']` then appends `…` —
    // yielding `"ab😀…"` (4 code points; the first emoji is preserved
    // intact). Critically, the result must NOT contain a lone surrogate.
    const truncated = truncateString("ab😀😀", 4);
    expect(truncated).toBe("ab😀…");
    // Defensive guard: no lone surrogate in the output. `\uD83D` is the high
    // surrogate of `😀` (`😀`); a torn-in-half emoji would surface
    // a `\uD83D` not followed by a low surrogate.
    expect(truncated).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);

    // With `maxLength=5` (still less than the 6-code-unit `value.length`,
    // so the early-exit does not fire), the for...of collects 4 code points:
    // `['a', 'b', '😀', '😀']` then appends `…` = `"ab😀😀…"`. Both emojis
    // are kept whole — the truncation strictly trims from the end.
    expect(truncateString("ab😀😀", 5)).toBe("ab😀😀…");

    // No truncation needed when the input fits the limit (measured in CODE
    // UNITS by the early-exit `value.length <= maxLength` branch — preserved
    // unchanged from the previous implementation for back-compat). `"ab😀😀"`
    // is 6 UTF-16 code units, so `maxLength=6` returns the input verbatim.
    expect(truncateString("ab😀😀", 6)).toBe("ab😀😀");
  });

  it("truncateString preserves the documented combining-mark caveat", () => {
    // A base character (`a`, U+0061) followed by a combining acute accent
    // (U+0301) is a SINGLE grapheme but TWO code points. The truncate helper
    // counts code points (not graphemes), so a boundary that lands between
    // them produces a separated form — this is the documented contract;
    // consumers who need grapheme-correct slicing should reach for
    // `Intl.Segmenter`.
    const composed = `ábc`; // 4 code points, displays as "ábc"
    // maxLength=2 → for...of collects 1 code point then appends `…` → `"a…"`.
    expect(truncateString(composed, 2)).toBe("a…");
  });

  // ---------------------------------------------------------------------------
  // Phase 6 — truncateString O(maxLength) bounded for...of (Task 6.2)
  // ---------------------------------------------------------------------------

  describe("truncateString (Phase 6 — bounded for...of parity)", () => {
    // Reference implementation preserved from before Phase 6: the old
    // Array.from-based semantics. Used to verify the new for...of loop
    // produces byte-identical output for every input class.
    const arrayFromTruncate = (value: string, maxLength: number): string => {
      if (value.length <= maxLength) {
        return value;
      }
      if (maxLength <= 0) {
        return "";
      }
      if (maxLength === 1) {
        return "…";
      }
      return `${Array.from(value)
        .slice(0, maxLength - 1)
        .join("")}…`;
    };

    it("produces identical output to Array.from semantics for ASCII strings at several maxLengths", () => {
      const s = "abcdefghijklmnopqrstuvwxyz"; // 26 chars, all single code points
      for (const ml of [0, 1, 2, 5, 13, 26, 27]) {
        expect(truncateString(s, ml)).toBe(arrayFromTruncate(s, ml));
      }
    });

    it("produces identical output to Array.from semantics for emoji strings at several maxLengths", () => {
      // "😀" encodes as a UTF-16 surrogate pair (2 code units, 1 code point).
      // The string has 1000 code points but 2000 code units, so no early-exit
      // fires for the maxLengths tested here.
      const s = "😀".repeat(1000); // 1000 × "😀"
      for (const ml of [0, 1, 2, 3, 5, 10, 50]) {
        expect(truncateString(s, ml)).toBe(arrayFromTruncate(s, ml));
      }
    });

    it("produces identical output to Array.from semantics for mixed ASCII+emoji strings", () => {
      // Alternating ASCII + emoji: 8 code points, 12 code units.
      const s = "a😀b😀c😀d😀";
      for (const ml of [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 15]) {
        expect(truncateString(s, ml)).toBe(arrayFromTruncate(s, ml));
      }
    });

    it("completes in bounded time on a >=100 kB string (O(maxLength) regression guard)", () => {
      // An O(input-length) regression (e.g. reverting to Array.from) would
      // make this call proportionally slower as input grows. With 200 kB input
      // and maxLength=50, an O(n) pass walks 200 000 chars; O(maxLength) walks
      // only 50. The 200 ms ceiling is deliberately generous: even on slow CI
      // the bounded loop should complete in microseconds.
      const hugeInput = "x".repeat(200_000); // ~200 kB ASCII
      const maxLen = 50;
      const start = performance.now();
      const result = truncateString(hugeInput, maxLen);
      const elapsed = performance.now() - start;
      expect(elapsed).toBeLessThan(200);
      // Sanity-check the output is still correct.
      expect(result.length).toBe(maxLen);
      expect(result.endsWith("…")).toBe(true);
    });
  });

  it("buildTruncatedEnvelope reports original length and a fixed-size preview", () => {
    const serialized = JSON.stringify({ payload: "x".repeat(50) });
    const envelope = buildTruncatedEnvelope(serialized, 12);
    expect(envelope._truncated).toBe(true);
    expect(envelope._originalLength).toBe(serialized.length);
    expect(envelope._preview.length).toBe(12);
    expect(envelope._preview.endsWith("…")).toBe(true);
  });

  it("redactUrlQuery is a no-op when there is no query string or no mask set", () => {
    const mask = new Set(["token"]);
    expect(redactUrlQuery("/path", mask)).toBe("/path");
    expect(redactUrlQuery("", mask)).toBe("");
    expect(redactUrlQuery("/path?token=abc", undefined)).toBe("/path?token=abc");
    expect(redactUrlQuery("/path?token=abc", new Set())).toBe("/path?token=abc");
  });

  it("redactUrlQuery returns the input unchanged when no params are masked", () => {
    const mask = new Set(["token"]);
    // Query param `keep=me` does not match any masked key → no mutation, return as-is.
    expect(redactUrlQuery("/path?keep=me", mask)).toBe("/path?keep=me");
  });

  it("redactUrlQuery rewrites both absolute and relative URL query strings", () => {
    const mask = new Set(["token", "secret"]);
    expect(redactUrlQuery("/path?token=abc&keep=me", mask)).toBe("/path?token=[REDACTED]&keep=me");
    expect(redactUrlQuery("https://api.example.com/path?secret=sk-1&safe=ok", mask)).toBe(
      "https://api.example.com/path?secret=[REDACTED]&safe=ok",
    );
  });

  it("redactUrlQuery redacts query params in URLs with malformed hosts (no URL-parse dependency)", () => {
    const mask = new Set(["token"]);
    // The in-place implementation never invokes `new URL()`, so a malformed
    // host (unclosed IPv6 bracket) does not prevent query-param redaction.
    // Sensitive params are still redacted; the rest of the URL is left verbatim.
    expect(redactUrlQuery("http://[invalid?token=abc", mask)).toBe(
      "http://[invalid?token=[REDACTED]",
    );
  });

  it("redactUrlQuery emits the literal [REDACTED] sentinel (not %5BREDACTED%5D) for relative URLs", () => {
    // The in-place implementation writes the REDACTED constant directly into
    // the raw query string, so the brackets in `[REDACTED]` are never
    // percent-encoded — we never call URLSearchParams.toString() which would
    // produce `token=%5BREDACTED%5D`.
    const mask = new Set(["token", "api_key"]);
    const result = redactUrlQuery("/auth/login?token=secret&keep=me&api_key=sk-1", mask);
    expect(result).toContain("[REDACTED]");
    expect(result).not.toContain("%5B");
    expect(result).not.toContain("%5D");
    expect(result).toBe("/auth/login?token=[REDACTED]&keep=me&api_key=[REDACTED]");
  });

  it("redactUrlQuery emits the literal [REDACTED] sentinel (not %5BREDACTED%5D) for absolute URLs", () => {
    const mask = new Set(["secret", "token"]);
    const result = redactUrlQuery(
      "https://api.example.com/v1/resource?secret=top&token=abc&safe=ok",
      mask,
    );
    expect(result).toContain("[REDACTED]");
    expect(result).not.toContain("%5B");
    expect(result).not.toContain("%5D");
    expect(result).toBe(
      "https://api.example.com/v1/resource?secret=[REDACTED]&token=[REDACTED]&safe=ok",
    );
  });

  it("redactUrlQuery preserves sibling-param encoding (%20, %5B/%5D, %2B) on non-masked params", () => {
    const mask = new Set(["token"]);
    // None of these encoding sequences are present in the masked value — they
    // are in a *sibling* param. The in-place edit must leave them byte-for-byte
    // unchanged (the old URLSearchParams round-trip decoded %20→+ etc.).
    expect(redactUrlQuery("/p?q=hello%20world&token=abc", mask)).toBe(
      "/p?q=hello%20world&token=[REDACTED]",
    );
    expect(redactUrlQuery("/p?name=arr%5Bidx%5D&token=x", mask)).toBe(
      "/p?name=arr%5Bidx%5D&token=[REDACTED]",
    );
    expect(redactUrlQuery("/p?q=foo%2Bbar&token=abc", mask)).toBe(
      "/p?q=foo%2Bbar&token=[REDACTED]",
    );
  });

  it("redactUrlQuery preserves the //host authority of protocol-relative URLs", () => {
    const mask = new Set(["token"]);
    // The old `parsed.pathname + parsed.search + parsed.hash` reconstruction
    // silently dropped the `//host` authority for `//host/path?…` inputs.
    // The in-place edit preserves every byte before the first `?`.
    expect(redactUrlQuery("//host/path?token=abc&q=1", mask)).toBe(
      "//host/path?token=[REDACTED]&q=1",
    );
  });

  it("redactUrlQuery preserves sibling-param encoding in absolute URLs", () => {
    const mask = new Set(["token"]);
    expect(redactUrlQuery("https://h/p?token=abc&q=hello%20world", mask)).toBe(
      "https://h/p?token=[REDACTED]&q=hello%20world",
    );
  });

  it("redactUrlQuery redacts all occurrences of a repeated masked key", () => {
    const mask = new Set(["token"]);
    expect(redactUrlQuery("/p?token=a&token=b&keep=1", mask)).toBe(
      "/p?token=[REDACTED]&token=[REDACTED]&keep=1",
    );
  });

  it("redactUrlQuery preserves all occurrences of a repeated non-masked key", () => {
    const mask = new Set(["token"]);
    expect(redactUrlQuery("/p?ids=1&ids=2&token=x", mask)).toBe("/p?ids=1&ids=2&token=[REDACTED]");
  });

  it("redactUrlQuery handles bracket-array params verbatim (arr[] kept, masked params redacted)", () => {
    const mask = new Set(["token"]);
    // `arr[]` is a common PHP/Rails convention for array query params.
    // The in-place edit decodes the key to compare, so `arr[]` ≠ `token` and
    // stays untouched, while `token` is still redacted.
    expect(redactUrlQuery("/p?arr[]=1&arr[]=2&token=x", mask)).toBe(
      "/p?arr[]=1&arr[]=2&token=[REDACTED]",
    );
  });

  it("redactUrlQuery preserves the URL fragment verbatim after editing the query", () => {
    const mask = new Set(["token"]);
    // Fragment (`#section`) must be peeled off before splitting on `?` and
    // re-appended verbatim — it is never part of the query string.
    expect(redactUrlQuery("/p?token=abc#section", mask)).toBe("/p?token=[REDACTED]#section");
    // Fragment with no masked params → identity (original string returned).
    expect(redactUrlQuery("/p?keep=me#anchor", mask)).toBe("/p?keep=me#anchor");
  });

  it("redactUrlQuery passes bare flag params (no `=` sign) through unchanged", () => {
    const mask = new Set(["token"]);
    // A flag like `?debug` has no `=` so there is nothing to mask.
    expect(redactUrlQuery("/p?flag&token=abc", mask)).toBe("/p?flag&token=[REDACTED]");
    // All bare flags → nothing to mask at all.
    const maskNone = new Set(["token"]);
    expect(redactUrlQuery("/p?flagonly", maskNone)).toBe("/p?flagonly");
  });

  it("redactUrlQuery skips pairs with malformed percent-encoding in the key", () => {
    const mask = new Set(["token"]);
    // `%GG` is not valid percent-encoding — decodeURIComponent throws URIError.
    // The inner catch must leave the malformed pair untouched while still
    // redacting the subsequent well-formed masked key.
    expect(redactUrlQuery("/p?%GG=x&token=abc", mask)).toBe("/p?%GG=x&token=[REDACTED]");
  });

  it("redactUrlQuery returns the URL verbatim when the only `?` lives inside the fragment", () => {
    const mask = new Set(["token"]);
    // Before the `qIdx === -1` guard, the fragment-free prefix ("token=secret")
    // was mis-parsed as a query string: `beforeFragment.slice(0, -1)` dropped
    // the trailing "t" and `beforeFragment.slice(0)` re-read the whole prefix
    // as `rawQuery`, producing the corrupted "token=secre?token=[REDACTED]#?x".
    // The whole-URL `?` check matches (there IS a `?`, inside the fragment),
    // but the pre-fragment split finds none — there is no real query
    // component, so the URL must come back unchanged. This is the case that
    // actually reproduces the bug on pre-fix code.
    expect(redactUrlQuery("token=secret#?x", mask)).toBe("token=secret#?x");
  });

  it("redactUrlQuery returns a fragment-only-`?` hash-router URL unchanged", () => {
    const mask = new Set(["token"]);
    // Realistic hash-router shape: the `?` belongs to the fragment's own
    // client-side route, not to a real query component. Note this particular
    // input happens to survive even on pre-fix code (the mis-sliced prefix
    // "/dash" contains no "=", so the pre-existing `!mutated` fallback
    // returns it unchanged by coincidence, not because the old logic was
    // correct) — it is kept here as a post-fix guard for a realistic shape,
    // not as the bug's reproduction case (see the preceding test for that).
    expect(redactUrlQuery("/dash#/r?token=abc", mask)).toBe("/dash#/r?token=abc");
  });

  it("redactUrlQuery still redacts a real query-before-fragment URL after the qIdx guard", () => {
    const mask = new Set(["token"]);
    // Regression guard for the `qIdx === -1` fix above: deliberately
    // duplicates the "preserves the URL fragment" test's first assertion,
    // kept local to the new fragment-only-`?` tests so it is obvious the
    // guard does not affect the ordinary query-before-fragment case (`qIdx`
    // is a real, non-negative index here, so the new branch never fires).
    expect(redactUrlQuery("/p?token=abc#section", mask)).toBe("/p?token=[REDACTED]#section");
  });

  it("redactEntryPath redacts a top-level path", () => {
    const entry = { context: { token: "abc" } } as unknown as Record<string, unknown>;
    redactEntryPath(entry, "context.token");
    expect((entry.context as Record<string, unknown>).token).toBe("[REDACTED]");
  });

  it("redactEntryPath aliases `body` to `requestBody`", () => {
    const entry = { requestBody: { user: { password: "p" } } } as unknown as Record<
      string,
      unknown
    >;
    redactEntryPath(entry, "body.user.password");
    expect(((entry.requestBody as any).user as Record<string, unknown>).password).toBe(
      "[REDACTED]",
    );
  });

  it("redactEntryPath is a no-op for empty paths and missing intermediates", () => {
    const entry = { requestBody: { other: 1 } } as unknown as Record<string, unknown>;
    redactEntryPath(entry, "");
    redactEntryPath(entry, ".");
    redactEntryPath(entry, "body.user.password");
    redactEntryPath(entry, "context.user.password");
    expect(entry).toEqual({ requestBody: { other: 1 } });
  });

  it("redactEntryPath does not create the final key when it is missing", () => {
    const entry = { requestBody: { user: { email: "u@x" } } } as unknown as Record<string, unknown>;
    redactEntryPath(entry, "body.user.password");
    expect((entry.requestBody as any).user).toEqual({ email: "u@x" });
  });

  it("redactEntryPath bails out when the cursor becomes a non-object mid-walk", () => {
    // The intermediate `body.user` resolves to a primitive (`"alice"`) — the
    // walker must short-circuit instead of attempting to property-access a string.
    const entry = { requestBody: { user: "alice" } } as unknown as Record<string, unknown>;
    redactEntryPath(entry, "body.user.password");
    expect(entry.requestBody).toEqual({ user: "alice" });
  });

  it("redactEntryPath is a no-op on an array `length` target (does not throw)", () => {
    const entry = { requestBody: { tags: ["a", "b"] } } as unknown as Record<string, unknown>;
    expect(() => redactEntryPath(entry, "body.tags.length")).not.toThrow();
    expect(entry.requestBody).toEqual({ tags: ["a", "b"] });
    expect((entry.requestBody as { tags: string[] }).tags.length).toBe(2);
  });

  it("redactEntryPath is a no-op on a non-writable (frozen) property (does not throw)", () => {
    const entry = { context: Object.freeze({ token: "SECRET" }) } as unknown as Record<
      string,
      unknown
    >;
    expect(() => redactEntryPath(entry, "context.token")).not.toThrow();
    expect((entry.context as { token: string }).token).toBe("SECRET");
  });

  it("redactEntryPath is a no-op on a getter-only / accessor property (does not throw)", () => {
    const context = {};
    Object.defineProperty(context, "token", {
      get: () => "SECRET",
      enumerable: true,
      configurable: true,
    });
    const entry = { context } as unknown as Record<string, unknown>;
    expect(() => redactEntryPath(entry, "context.token")).not.toThrow();
    expect((entry.context as { token: string }).token).toBe("SECRET");
  });

  it("redactEntryPath swallows an assignment that throws (Proxy with a throwing set trap)", () => {
    // Defense-in-depth: even a slot reported as a writable data property can
    // throw on assignment. The final try/catch turns that into a no-op instead
    // of dropping the whole log entry.
    const throwing = new Proxy(
      { token: "SECRET" },
      {
        set() {
          throw new Error("set trap boom");
        },
        getOwnPropertyDescriptor(target, key) {
          return {
            value: (target as Record<string, unknown>)[key as string],
            writable: true,
            enumerable: true,
            configurable: true,
          };
        },
      },
    );
    const entry = { context: throwing } as unknown as Record<string, unknown>;
    expect(() => redactEntryPath(entry, "context.token")).not.toThrow();
    expect((throwing as { token: string }).token).toBe("SECRET");
  });

  it("resolveMaskHeaderKeys returns undefined when option is false and the default set otherwise", () => {
    expect(resolveMaskHeaderKeys(false)).toBeUndefined();
    const defaults = resolveMaskHeaderKeys(undefined);
    expect(defaults).toBeDefined();
    DEFAULT_MASKED_HEADER_KEYS.forEach((key) => {
      expect(defaults?.has(key)).toBe(true);
    });
    const custom = resolveMaskHeaderKeys(["X-Custom"]);
    expect(custom?.has("x-custom")).toBe(true);
  });

  it("resolveMaskQueryKeys returns undefined when option is false and the default set otherwise", () => {
    expect(resolveMaskQueryKeys(false)).toBeUndefined();
    const defaults = resolveMaskQueryKeys(undefined);
    expect(defaults).toBeDefined();
    DEFAULT_MASKED_QUERY_KEYS.forEach((key) => {
      expect(defaults?.has(key)).toBe(true);
    });
    const custom = resolveMaskQueryKeys(["SessionId"]);
    expect(custom?.has("sessionid")).toBe(true);
  });

  it("normalizeHeaders applies mask set after the include allow-list", () => {
    const mask = new Set(["authorization"]);
    expect(
      normalizeHeaders(
        { Authorization: "Bearer secret", Foo: "bar" },
        ["authorization", "foo"],
        mask,
      ),
    ).toEqual({ authorization: "[REDACTED]", foo: "bar" });
  });

  it("normalizeHeaders applies mask set when include is true", () => {
    const mask = new Set(["cookie"]);
    expect(normalizeHeaders({ Cookie: "session=abc", Foo: "bar" }, true, mask)).toEqual({
      cookie: "[REDACTED]",
      foo: "bar",
    });
  });

  // ---------------------------------------------------------------------------
  // Iteration 2 — prototype-pollution hardening (FIX.md tasks #1 + #4)
  //
  // Defensive `afterEach` resets `Object.prototype.polluted` after every case
  // so a regression in the production code that DOES leak into the global
  // prototype cannot cascade into unrelated tests further down the run. With
  // the fix in place this is a no-op (the property never gets assigned).
  // ---------------------------------------------------------------------------
  describe("prototype-pollution hardening", () => {
    afterEach(() => {
      delete (Object.prototype as Record<string, unknown>).polluted;
      delete (Object.prototype as Record<string, unknown>).toStringHijack;
    });

    it("redactEntryPath is a no-op for paths containing __proto__ / constructor / prototype", () => {
      const originalToString = Object.prototype.toString;

      const entry = { requestBody: { user: { name: "alice" } } } as unknown as Record<
        string,
        unknown
      >;
      // Each of these would, without the deny-list guard, walk into a
      // prototype-bearing object and overwrite a structural method. After the
      // fix every variant is a graceful no-op.
      redactEntryPath(entry, "body.__proto__.toString");
      redactEntryPath(entry, "requestBody.__proto__.toString");
      redactEntryPath(entry, "body.constructor.name");
      redactEntryPath(entry, "body.user.prototype");

      // `Object.prototype.toString` must still be the function it was at
      // import time — no `[REDACTED]` substitution.
      expect(Object.prototype.toString).toBe(originalToString);
      expect(typeof Object.prototype.toString).toBe("function");
      // The legitimate entry data is untouched.
      expect(entry.requestBody).toEqual({ user: { name: "alice" } });
    });

    it("redactEntryPath final-segment guard catches __proto__ as an OWN property on the cursor", () => {
      // The intermediate-segment guard (part 1) catches forbidden keys at
      // segments[0..length-2]. This test exercises the FINAL-segment guard
      // (part 2, the inline check right before the assignment) by feeding a
      // path whose intermediate segments are all clean and whose final segment
      // is `__proto__` — AND mounting the assignment target as a
      // `JSON.parse('{"__proto__": ...}')` object that owns the key directly,
      // so the `hasOwnProperty` filter would NOT short-circuit on its own.
      // Without the inline guard the bracket-assignment would invoke the
      // prototype setter and corrupt the chain.
      const evil = JSON.parse('{"__proto__": "real"}') as Record<string, unknown>;
      const entry = { requestBody: { user: evil } } as unknown as Record<string, unknown>;
      const originalProto = Object.getPrototypeOf(evil);

      redactEntryPath(entry, "requestBody.user.__proto__");

      // The own `__proto__` key on the cursor is left untouched ...
      expect(Object.getOwnPropertyDescriptor(evil, "__proto__")?.value).toBe("real");
      // ... and the cursor's actual prototype chain is the original
      // (`Object.prototype`, not `"[REDACTED]"`).
      expect(Object.getPrototypeOf(evil)).toBe(originalProto);
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    });

    it("serializeBody on a JSON-parsed __proto__ payload does not pollute Object.prototype", () => {
      // `JSON.parse` is the canonical way to construct an object that owns a
      // `__proto__` key (object literals route the assignment through the
      // setter and never end up with the own property). The redactor must
      // skip it during the rebuild so the result has a clean
      // `Object.prototype` chain (NOT the malicious `{polluted:"yes"}`
      // payload) AND `Object.prototype.polluted` is undefined globally.
      const malicious = JSON.parse('{"foo":"bar","__proto__":{"polluted":"yes"}}');

      const result = serializeBody(malicious);

      // The redacted output preserves legitimate keys ...
      expect(result).toEqual({ foo: "bar" });
      // ... has a normal `Object.prototype` chain (or `null` — either is
      // safe; what matters is that it is NOT the malicious payload) ...
      const proto = Object.getPrototypeOf(result);
      expect(proto === Object.prototype || proto === null).toBe(true);
      // ... and the global object's prototype is unpolluted.
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
      expect((Object.prototype as Record<string, unknown>).polluted).toBeUndefined();
    });

    it("normalizeHeaders skips __proto__ on input header bags", () => {
      // Hand-built fixture with `__proto__` as an OWN property — this is the
      // shape Object.create + defineProperty produces (and is also achievable
      // from `JSON.parse('{"__proto__":...}')`). Real Node HTTP parsers
      // strip such keys, but a non-standard adapter or a test fixture can
      // surface them, so the helper must not blindly trust the input.
      const headers = JSON.parse('{"__proto__":{"polluted":"yes"},"foo":"bar"}') as Record<
        string,
        unknown
      >;

      const result = normalizeHeaders(headers, true);

      // The legitimate header survives; the dangerous key is dropped.
      expect(result).toBeDefined();
      expect((result as Record<string, unknown>).foo).toBe("bar");
      expect((result as Record<string, unknown>).polluted).toBeUndefined();
      // No global pollution.
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    });

    it("normalizeHeaders allow-list path also rejects __proto__ in the allow-list", () => {
      // A consumer who passes `__proto__` in the include allow-list (likely
      // by accident, but possible from config-driven setups) must NOT cause
      // the accumulator to invoke the prototype setter on the way out.
      const headers = { foo: "bar" } as Record<string, unknown>;
      const result = normalizeHeaders(headers, ["__proto__", "foo"]);

      expect(result).toEqual({ foo: "bar" });
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    });

    it("applyHeaderMask (via normalizeHeaders+include:true) skips __proto__ in the mask path", () => {
      // Drive through the mask branch by passing a non-empty mask set; the
      // header bag still carries an own `__proto__` key that must be dropped
      // by the deny-list guard inside applyHeaderMask.
      const headers = JSON.parse(
        '{"__proto__":{"polluted":"yes"},"authorization":"Bearer secret","x-trace":"1"}',
      ) as Record<string, unknown>;
      const mask = new Set(["authorization"]);

      const result = normalizeHeaders(headers, true, mask);

      expect(result).toEqual({ authorization: "[REDACTED]", "x-trace": "1" });
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    });

    it("applyHeaderMask directly skips __proto__ entries (defense-in-depth)", () => {
      // `normalizeHeaders` already filters `__proto__` upstream, but
      // `applyHeaderMask` carries its own deny-list as defense-in-depth in
      // case a future caller invokes it on an already-normalized bag that
      // still owns a `__proto__` key. This direct test exercises that
      // second wall.
      const { applyHeaderMask } = __requestInternals;
      const bag = JSON.parse(
        '{"__proto__":{"polluted":"yes"},"authorization":"Bearer secret","x-trace":"1"}',
      ) as Record<string, unknown>;
      const mask = new Set(["authorization"]);

      const result = applyHeaderMask(bag, mask);

      expect(result).toEqual({ authorization: "[REDACTED]", "x-trace": "1" });
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    });

    it("logger maskMetaKeys probe — metadata containing __proto__ does not pollute Object.prototype", () => {
      // End-to-end probe per FIX.md: emit a log call carrying a JSON-parsed
      // payload that owns `__proto__: {polluted: true}` through the redact
      // pipeline (here invoked directly via serializeBody, which IS the same
      // primitive `maskMetaKeys` uses under the hood — both delegate to
      // `redactValue`). After the call, `({}).polluted` must be undefined.
      const malicious = JSON.parse(
        '{"username":"alice","password":"topsecret","__proto__":{"polluted":true}}',
      );

      const result = serializeBody(malicious, ["password"]);

      expect(result).toMatchObject({ username: "alice", password: "[REDACTED]" });
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
      expect((Object.prototype as Record<string, unknown>).polluted).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // Iteration 3 — built-in object preservation (FIX.md task #1)
  //
  // The previous `redactValue` implementation walked every non-array object via
  // `Object.entries(...).reduce(..., {})`. Built-in classes (Date, Map, Set,
  // RegExp, URL, Error, Buffer, ...) expose their data through non-enumerable
  // accessors, so `Object.entries` returned `[]` and the rebuild silently
  // produced the empty object `{}` — losing the original instance entirely.
  //
  // The fix adds an "is plain object" guard
  // (`Object.getPrototypeOf(value) === Object.prototype || === null`) so
  // built-ins pass through untouched. These tests pin that behavior across
  // every common built-in plus a custom-class instance, and verify the
  // surrounding redaction (`maskBodyKeys`, deep recursion) still works when
  // built-ins are nested inside a plain-object payload.
  // ---------------------------------------------------------------------------
  describe("redactValue preserves built-in object types (Date, Map, Set, RegExp, URL, Error, Buffer)", () => {
    const { redactValue } = __requestInternals;
    const empty = new Set<string>();

    it("returns Date instances unchanged (same identity, time value preserved)", () => {
      const input = new Date("2024-01-01T00:00:00.000Z");
      const out = redactValue(input, empty, new WeakSet());
      expect(out).toBe(input);
      expect(out instanceof Date).toBe(true);
      expect((out as Date).getTime()).toBe(input.getTime());
    });

    it("returns Map instances unchanged (same identity, entries preserved)", () => {
      const input = new Map<string, number>([
        ["a", 1],
        ["b", 2],
      ]);
      const out = redactValue(input, empty, new WeakSet());
      expect(out).toBe(input);
      expect(out instanceof Map).toBe(true);
      expect((out as Map<string, number>).get("a")).toBe(1);
      expect((out as Map<string, number>).get("b")).toBe(2);
    });

    it("returns Set instances unchanged (same identity, members preserved)", () => {
      const input = new Set<string>(["x", "y", "z"]);
      const out = redactValue(input, empty, new WeakSet());
      expect(out).toBe(input);
      expect(out instanceof Set).toBe(true);
      expect((out as Set<string>).has("x")).toBe(true);
      expect((out as Set<string>).has("z")).toBe(true);
    });

    it("returns RegExp instances unchanged (same identity, source + flags preserved)", () => {
      const input = /^foo-(\d+)$/i;
      const out = redactValue(input, empty, new WeakSet());
      expect(out).toBe(input);
      expect(out instanceof RegExp).toBe(true);
      expect((out as RegExp).source).toBe("^foo-(\\d+)$");
      expect((out as RegExp).flags).toBe("i");
    });

    it("returns URL instances unchanged (same identity, href preserved)", () => {
      const input = new URL("https://example.com/path?q=1");
      const out = redactValue(input, empty, new WeakSet());
      expect(out).toBe(input);
      expect(out instanceof URL).toBe(true);
      expect((out as URL).href).toBe("https://example.com/path?q=1");
    });

    it("returns Error instances unchanged (same identity, name + message preserved)", () => {
      const input = new Error("kaboom");
      const out = redactValue(input, empty, new WeakSet());
      expect(out).toBe(input);
      expect(out instanceof Error).toBe(true);
      expect((out as Error).message).toBe("kaboom");
      expect((out as Error).name).toBe("Error");
    });

    it("returns Buffer instances unchanged (same identity, contents preserved)", () => {
      const input = Buffer.from("hi");
      const out = redactValue(input, empty, new WeakSet());
      expect(out).toBe(input);
      expect(Buffer.isBuffer(out)).toBe(true);
      expect((out as Buffer).toString("utf8")).toBe("hi");
    });

    it("returns custom-class instances unchanged (same identity)", () => {
      class Widget {
        constructor(public readonly id: string) {}
      }
      const input = new Widget("w-1");
      const out = redactValue(input, empty, new WeakSet());
      expect(out).toBe(input);
      expect(out instanceof Widget).toBe(true);
      expect((out as Widget).id).toBe("w-1");
    });

    it("preserves nested built-ins inside a plain object while recursing the outer shape", () => {
      const date = new Date("2024-06-15T12:00:00.000Z");
      const map = new Map<string, string>([["k", "v"]]);
      const url = new URL("https://example.com");
      const input = {
        created: date,
        idMap: map,
        endpoint: url,
        nested: { inner: { tag: "ok" } },
      };
      const mask = new Set<string>();
      const out = redactValue(input, mask, new WeakSet()) as Record<string, unknown>;

      // Outer shape was rebuilt (fresh plain object) but built-in fields
      // retain their original instance identity.
      expect(out).not.toBe(input);
      expect(out.created).toBe(date);
      expect(out.idMap).toBe(map);
      expect(out.endpoint).toBe(url);
      // Plain nested object continues to recurse.
      expect(out.nested).toEqual({ inner: { tag: "ok" } });
      expect(out.nested).not.toBe(input.nested);
    });

    it("preserves Object.create(null) plain objects (still recurses)", () => {
      // `Object.create(null)` produces a plain-data object with NO prototype.
      // The "is plain object" guard treats `proto === null` as plain too, so
      // the recursion proceeds and key-based masking still applies.
      const input = Object.create(null) as Record<string, unknown>;
      input.token = "secret";
      input.keep = "ok";
      const mask = new Set(["token"]);
      const out = redactValue(input, mask, new WeakSet()) as Record<string, unknown>;
      expect(out).not.toBe(input);
      expect(out.token).toBe("[REDACTED]");
      expect(out.keep).toBe("ok");
    });

    it("serializeBody preserves Date inside a plain payload while redacting flagged keys", () => {
      // End-to-end via the middleware's `serializeBody`. The Date survives
      // intact (NOT collapsed to `{}`); the secret next to it is redacted by
      // the existing maskBodyKeys path.
      const created = new Date("2024-01-01T00:00:00.000Z");
      const body = { created, data: { secret: "x", visible: "y" } };
      const out = serializeBody(body, ["secret"]) as {
        created: Date;
        data: { secret: string; visible: string };
      };
      expect(out.created).toBe(created);
      expect(out.created instanceof Date).toBe(true);
      expect(out.data.secret).toBe("[REDACTED]");
      expect(out.data.visible).toBe("y");
    });

    it("serializeBody preserves Map / Set / RegExp / URL / Error / Buffer values inside a plain payload", () => {
      const map = new Map<string, number>([["x", 1]]);
      const set = new Set<string>(["a"]);
      const re = /^abc$/;
      const url = new URL("https://example.com/x");
      const err = new Error("boom");
      const buf = Buffer.from("hi");
      const body = { map, set, re, url, err, buf };
      const out = serializeBody(body) as Record<string, unknown>;
      expect(out.map).toBe(map);
      expect(out.set).toBe(set);
      expect(out.re).toBe(re);
      expect(out.url).toBe(url);
      expect(out.err).toBe(err);
      expect(out.buf).toBe(buf);
    });

    // -------------------------------------------------------------------------
    // Phase 1 — Leak-safe deep redaction: class/Error instance masking
    // -------------------------------------------------------------------------

    it("redacts a masked own key on a class instance (data-bearing branch)", () => {
      class Credentials {
        constructor(
          public readonly username: string,
          public readonly password: string,
        ) {}
      }
      const input = new Credentials("alice", "s3cr3t");
      const mask = new Set(["password"]);
      const out = redactValue(input, mask, new WeakSet()) as Record<string, unknown>;
      // password is masked → fresh plain object returned
      expect(out).not.toBe(input);
      expect(out.password).toBe("[REDACTED]");
      expect(out.username).toBe("alice");
    });

    it("redacts a masked own key nested inside a plain object that holds a class instance", () => {
      class Token {
        constructor(
          public readonly value: string,
          public readonly label: string,
        ) {}
      }
      const tok = new Token("secret-token", "api");
      const body = { meta: { auth: tok, tag: "ok" } };
      const mask = new Set(["value"]);
      const out = redactValue(body, mask, new WeakSet()) as {
        meta: { auth: Record<string, unknown>; tag: string };
      };
      // The outer plain object is rebuilt; the inner class instance is also
      // walked because it contains a masked key.
      expect(out.meta.auth).not.toBe(tok);
      expect(out.meta.auth.value).toBe("[REDACTED]");
      expect(out.meta.auth.label).toBe("api");
      expect(out.meta.tag).toBe("ok");
    });

    it("redacts a masked enumerable prop on an Error subclass", () => {
      class AppError extends Error {
        public token: string;
        constructor(message: string, token: string) {
          super(message);
          this.name = "AppError";
          this.token = token; // own enumerable key
        }
      }
      const err = new AppError("auth failed", "bearer-xyz");
      const mask = new Set(["token"]);
      const out = redactValue(err, mask, new WeakSet()) as Record<string, unknown>;
      // token is enumerable and masked → fresh plain object
      expect(out).not.toBe(err);
      expect(out.token).toBe("[REDACTED]");
      // name was not masked and is enumerable on this subclass
      expect(out.name).toBe("AppError");
    });

    it("returns a class instance by identity when the mask is non-empty but no key matches", () => {
      class Payload {
        constructor(public readonly data: string) {}
      }
      const input = new Payload("hello");
      const mask = new Set(["password", "token"]); // non-empty but no match
      const out = redactValue(input, mask, new WeakSet());
      // Nothing changed → original returned by identity
      expect(out).toBe(input);
      expect((out as Payload).data).toBe("hello");
    });

    it("forceCopy=true (4th arg) always returns a fresh copy of a data-bearing instance, even when nothing changed", () => {
      // Contrasts with the identity-passthrough test above: same inputs, but
      // with forceCopy requested — used by `serializeBody` to guarantee its
      // subsequent in-place `redactPaths` mutation never lands on a
      // caller-owned object (see the comment on the `forceCopy` parameter in
      // `src/redact.ts`).
      class Payload {
        constructor(public readonly data: string) {}
      }
      const input = new Payload("hello");
      const mask = new Set(["password", "token"]); // non-empty but no match
      const out = redactValue(input, mask, new WeakSet(), true);
      expect(out).not.toBe(input);
      expect(out).toEqual({ data: "hello" });
    });

    it("forceCopy defaults to false when the 4th arg is omitted, preserving identity-passthrough (backward compat)", () => {
      class Payload {
        constructor(public readonly data: string) {}
      }
      const input = new Payload("hello");
      const out = redactValue(input, new Set<string>(), new WeakSet());
      expect(out).toBe(input);
    });

    it("passes through a class instance that defines toJSON even when a key matches (documented limitation)", () => {
      class Timestamped {
        public readonly password = "secret";
        toJSON() {
          return { customized: true };
        }
      }
      const input = new Timestamped();
      const mask = new Set(["password"]);
      const out = redactValue(input, mask, new WeakSet());
      // hasToJSON === true → pass-through, no key walk; this is the documented
      // limitation: use `redactPaths` or normalize to a plain object instead.
      expect(out).toBe(input);
    });

    it("serializeBody does not mutate a caller-owned toJSON-defining class-instance body when redactPaths targets its own field", () => {
      // Direct reproduction of the confirmed mutation hazard: a class body that
      // defines toJSON AND exposes `password` as an own field, targeted only by
      // redactPaths (no matching maskBodyKeys). Pre-fix, `serializeBody`
      // mutated the caller's live object in place; the toJSON-resolved owned
      // deep copy now isolates the redaction from the caller.
      class ToJSONBody {
        public password = "REALSECRET";
        public username = "alice";
        toJSON() {
          return { username: this.username, password: this.password };
        }
      }
      const originalBody = new ToJSONBody();
      const out = serializeBody(originalBody, undefined, 3000, ["body.password"]) as Record<
        string,
        unknown
      >;
      // The logged representation (from toJSON) redacts the secret...
      expect(out).toEqual({ password: "[REDACTED]", username: "alice" });
      // ...and the caller's ORIGINAL instance is left completely untouched.
      expect(originalBody.password).toBe("REALSECRET");
      expect(originalBody.username).toBe("alice");
    });

    it("serializeBody does not mutate a NESTED toJSON-defining instance targeted by redactPaths", () => {
      class Credentials {
        public password = "NESTEDSECRET";
        toJSON() {
          return { password: this.password };
        }
      }
      const creds = new Credentials();
      const body = { user: "bob", credentials: creds };
      const out = serializeBody(body, undefined, 3000, ["body.credentials.password"]) as {
        user: string;
        credentials: Record<string, unknown>;
      };
      expect(out.user).toBe("bob");
      expect(out.credentials).toEqual({ password: "[REDACTED]" });
      // The caller's nested instance is untouched.
      expect(creds.password).toBe("NESTEDSECRET");
    });

    it("serializeBody + redactPaths redacts (not leaks) a private-field secret exposed only through toJSON", () => {
      // A secret held in a true private field (`#password`) is surfaced only by
      // the class's own toJSON(). The toJSON-resolved owned copy exposes it as a
      // plain key, so redactPaths can redact it in place of the caller — the
      // secret is neither leaked nor left on the caller's object.
      class PrivateSecretBody {
        #password: string;
        public username = "alice";
        constructor(pw: string) {
          this.#password = pw;
        }
        toJSON() {
          return { username: this.username, password: this.#password };
        }
        reveal() {
          return this.#password;
        }
      }
      const originalBody = new PrivateSecretBody("SECRET");
      const out = serializeBody(originalBody, undefined, 3000, ["body.password"]);
      // The raw secret never reaches the serialized form; it is redacted.
      expect(JSON.stringify(out)).not.toContain("SECRET");
      expect(out).toEqual({ username: "alice", password: "[REDACTED]" });
      // The caller's private field is untouched.
      expect(originalBody.reveal()).toBe("SECRET");
    });

    it("serializeBody resolves an incidental toJSON value via toJSON() (not its internal fields) when redactPaths targets an unrelated field", () => {
      // Regression guard for the moment-balloon: a value like a moment instance
      // owns many internal fields (`_d`, `_locale`, …) alongside its toJSON().
      // Any non-empty redactPaths must NOT cause it to be rebuilt from those
      // internals — the JSON round-trip resolves toJSON() to its clean output
      // exactly as the final log serializer would, so the logged value stays
      // compact, not a multi-field internal-state dump.
      class MomentLike {
        public _d = new Date("2024-01-01T00:00:00.000Z");
        public _locale = { _months: ["January", "February", "…"] };
        public _isAMomentObject = true;
        constructor(private readonly iso: string) {}
        toJSON() {
          return this.iso;
        }
      }
      const created = new MomentLike("2024-01-01T00:00:00.000Z");
      const body = { created, note: "hi" };
      const out = serializeBody(body, undefined, 3000, ["body.note"]) as {
        created: string;
        note: string;
      };
      // The toJSON output (a clean ISO string), not the internal own fields.
      expect(out.created).toBe("2024-01-01T00:00:00.000Z");
      expect(out.note).toBe("[REDACTED]");
      const serialized = JSON.stringify(out);
      expect(serialized).not.toContain("_locale");
      expect(serialized).not.toContain("_isAMomentObject");
    });

    it("serializeBody resolves a Date body-field to its ISO string under redactPaths (not ballooned, caller untouched)", () => {
      const created = new Date("2024-01-01T00:00:00.000Z");
      const body = { created, note: "hi" };
      const out = serializeBody(body, undefined, 3000, ["body.other"]) as {
        created: string;
        note: string;
      };
      // The Date resolves to its toJSON() ISO string, exactly as the final log
      // serializer would render it.
      expect(out.created).toBe("2024-01-01T00:00:00.000Z");
      expect(out.note).toBe("hi");
      // The caller's Date instance is untouched.
      expect(created.toISOString()).toBe("2024-01-01T00:00:00.000Z");
    });

    it("serializeBody applies redactPaths to a BigInt-carrying body instead of collapsing it to String()", () => {
      // Previously a BigInt made the redactPaths round-trip throw, the catch
      // silently skipped every mandated path, and String(masked) rendered the
      // whole body as the useless "[object Object]". `bigintSafeReplacer` makes
      // the round-trip succeed, so the path is honored and the BigInt renders
      // as its decimal string (matching logform/json.js's convention).
      const out = serializeBody({ big: 10n }, undefined, 3000, ["body.big"]) as Record<
        string,
        unknown
      >;
      expect(out).toEqual({ big: "[REDACTED]" });
      expect(out).not.toBe("[object Object]");
    });

    it("serializeBody keeps a BigInt body diagnosable (keyword mask applied, no [object Object])", () => {
      // The BigInt no longer takes the rest of the body down with it: every
      // diagnostic field survives and maskBodyKeys still redacts.
      const out = serializeBody({ amount: 100n, password: "hunter2", user: "bob" }, [
        "password",
      ]) as Record<string, unknown>;
      expect(out.password).toBe("[REDACTED]");
      expect(out.user).toBe("bob");
      // The BigInt is preserved as a live value; the downstream serializer
      // (pretty-mode safeStringify / logform's json replacer) string-coerces it.
      expect(out.amount).toBe(100n);
      expect(out).not.toBe("[object Object]");
    });

    it("serializeBody does not leak a redactPaths target through the String() fallback on a BigInt array body", () => {
      // The proven leak: String() on an array invokes Array.prototype.join, so
      // the operator-mandated redaction was emitted in cleartext as
      // "1,SUPER-SECRET,5".
      const out = serializeBody(["1", "SUPER-SECRET", 5n], undefined, 3000, ["body.1"]);
      expect(
        JSON.stringify(out, (_k, v) => (typeof v === "bigint" ? v.toString() : v)),
      ).not.toContain("SUPER-SECRET");
      expect(out).toEqual(["1", "[REDACTED]", "5"]);
    });

    it("serializeBody fails closed with a sentinel when a redactPaths round-trip cannot be applied", () => {
      // A genuinely unserializable body: `bad` defines toJSON, so redactValue
      // passes it through by identity and JSON.stringify invokes the throwing
      // serializer. With mandated paths unapplied, the body must never be
      // emitted raw.
      const body = {
        token: "SUPER-SECRET",
        bad: {
          toJSON() {
            throw new Error("boom");
          },
        },
      };
      const out = serializeBody(body, undefined, 3000, ["body.token"]);
      expect(out).toBe("[UNSERIALIZABLE]");
      expect(String(out)).not.toContain("SUPER-SECRET");
    });

    it("serializeBody still applies redactPaths to an ordinary circular body (a plain cycle is not a fail-closed trigger)", () => {
      // Counter-intuitive but load-bearing: redactValue walks first and renders
      // the cycle as "[Circular]", so the round-trip succeeds and the path is
      // honored — a plain cycle never degrades the body to the sentinel.
      const body: Record<string, unknown> = { token: "SUPER-SECRET" };
      body.self = body;
      const out = serializeBody(body, undefined, 3000, ["body.token"]) as Record<string, unknown>;
      expect(out.token).toBe("[REDACTED]");
      expect(out.self).toBe("[Circular]");
      expect(JSON.stringify(out)).not.toContain("SUPER-SECRET");
    });

    it("serializeBody fails closed when a cycle is routed through a toJSON-defining instance", () => {
      // The exception to the rule above, and the reason it is scoped to
      // ORDINARY cycles: redactValue passes a toJSON-defining instance through
      // by identity (its documented boundary) without cycle-tracking it, so the
      // cycle survives into JSON.stringify and throws. Note the throw is
      // `RangeError: Maximum call stack size exceeded`, NOT "Converting
      // circular structure to JSON": JSON.stringify's cycle detection tracks
      // the value returned by toJSON, and this toJSON mints a FRESH object
      // every call, so no reference ever repeats and it recurses until the
      // stack is exhausted. Either way it lands on the fail-closed path — the
      // safe outcome, and why the fallback must not render `masked` raw.
      class Node {
        public parent: unknown = null;
        toJSON() {
          return { parent: this.parent };
        }
      }
      const node = new Node();
      node.parent = node;
      const out = serializeBody({ token: "SUPER-SECRET", node }, undefined, 3000, ["body.token"]);
      expect(out).toBe("[UNSERIALIZABLE]");
      expect(String(out)).not.toContain("SUPER-SECRET");
    });

    it("does NOT yield [Circular] when the same built-in is referenced by two keys", () => {
      // Before the fix, seen.add(date) ran before the non-plain check, so the
      // second reference to the same Date returned "[Circular]".
      const d = new Date("2024-01-01T00:00:00.000Z");
      const body = { start: d, end: d };
      const out = redactValue(body, empty, new WeakSet()) as Record<string, unknown>;
      // Both keys must carry the original Date instance, not "[Circular]".
      expect(out.start).toBe(d);
      expect(out.end).toBe(d);
      expect(out.start).not.toBe("[Circular]");
      expect(out.end).not.toBe("[Circular]");
    });

    it("serializeBody redacts a masked key on a class-instance request body", () => {
      // End-to-end fix for F1: the downstream JSON.stringify enumerates own
      // keys of class instances, so secrets stored as instance fields leaked
      // even when the key was in maskBodyKeys. This test pins the fix.
      class LoginBody {
        constructor(
          public readonly username: string,
          public readonly password: string,
        ) {}
      }
      const body = new LoginBody("alice", "s3cr3t");
      const out = serializeBody(body, ["password"]) as Record<string, unknown>;
      expect(out.password).toBe("[REDACTED]");
      expect(out.username).toBe("alice");
      // The raw secret string must NOT appear in any serialized form.
      expect(JSON.stringify(out)).not.toContain("s3cr3t");
    });

    it("data-bearing instance: FORBIDDEN_KEYS are skipped during the walk (defense-in-depth)", () => {
      // Exercises lines 119-121: the case where a class instance has an own
      // enumerable key whose name is in FORBIDDEN_KEYS (__proto__, constructor,
      // prototype). Object.assign copies own-enumerable properties — including
      // 'constructor' from an object literal — onto the target instance.
      class SafeDto {
        public safe: string;
        constructor(safe: string) {
          this.safe = safe;
        }
      }
      // Create an instance whose own enumerable keys include 'constructor'
      // (a FORBIDDEN_KEY). This is an adversarial/prototype-pollution scenario.
      const instance = Object.assign(Object.create(SafeDto.prototype) as SafeDto, {
        safe: "data",
        constructor: "evil" as unknown, // own enumerable FORBIDDEN_KEY
      });

      const mask = new Set(["safe"]);
      const out = redactValue(instance, mask, new WeakSet()) as Record<string, unknown>;

      // 'constructor' was skipped (dropped) → not an OWN property on the output.
      expect(Object.prototype.hasOwnProperty.call(out, "constructor")).toBe(false);
      // 'safe' was masked.
      expect(out.safe).toBe("[REDACTED]");
      // changed === true (masked key + forbidden key skipped) → fresh plain object.
      expect(out).not.toBe(instance);
    });

    it("data-bearing instance with a circular self-reference emits [Circular]", () => {
      // Exercises the seen.has() branch inside the data-bearing instance path
      // (distinct from the plain-object circular path exercised by other tests).
      class Node {
        public self?: Node;
        public label: string;
        constructor(label: string) {
          this.label = label;
        }
      }
      const n = new Node("root");
      n.self = n; // circular: n.self === n

      const mask = new Set<string>();
      const out = redactValue(n, mask, new WeakSet()) as Record<string, unknown>;

      // The self-reference must be replaced with "[Circular]" without throwing.
      expect(out.self).toBe("[Circular]");
      expect(out.label).toBe("root");
    });

    it("circular array containing itself emits [Circular] without throwing", () => {
      // Exercises the seen.has() branch inside the Array.isArray path (line 83).
      // An array that holds a reference to itself must be handled gracefully.
      const arr: unknown[] = [];
      arr.push(arr); // arr[0] === arr — circular

      const mask = new Set<string>();
      const out = redactValue(arr, mask, new WeakSet()) as unknown[];

      // The nested self-reference is replaced with "[Circular]".
      expect(out[0]).toBe("[Circular]");
    });
  });

  // ---------------------------------------------------------------------------
  // Phase 1 (redact.ts DAG/diamond fix) — active-path cycle detection
  //
  // Before this fix, the `seen` WeakSet tracked "every object visited
  // anywhere in the traversal" rather than "objects on the current active DFS
  // path", so a shared (non-circular) reference reached via two independent
  // paths was misclassified as a cycle and rendered as the literal string
  // "[Circular]" on its second occurrence, silently dropping real
  // (already-redacted) data. These tests pin the corrected active-path
  // (add-on-entry, delete-on-unwind) behavior: shared/DAG references render
  // FULLY on every occurrence, and ONLY a genuine cycle (an object that is
  // its own ancestor on the active path) still yields "[Circular]".
  // ---------------------------------------------------------------------------
  describe("redactValue active-path cycle detection (DAG/diamond fix)", () => {
    const { redactValue } = __requestInternals;

    it("renders a plain-object diamond referenced by two sibling keys in full (no mask)", () => {
      const shared = { value: "x" };
      const body = { a: shared, b: shared };
      const mask = new Set<string>();
      const out = redactValue(body, mask, new WeakSet()) as Record<string, unknown>;

      expect(out.a).toEqual({ value: "x" });
      expect(out.b).toEqual({ value: "x" });
      expect(out.a).not.toBe("[Circular]");
      expect(out.b).not.toBe("[Circular]");
    });

    it("redacts a plain-object diamond referenced by two sibling keys under a mask", () => {
      const shared = { password: "topsecret", keep: "visible" };
      const body = { a: shared, b: shared };
      const mask = new Set(["password"]);
      const out = redactValue(body, mask, new WeakSet()) as Record<string, unknown>;

      expect(out.a).toEqual({ password: "[REDACTED]", keep: "visible" });
      expect(out.b).toEqual({ password: "[REDACTED]", keep: "visible" });
    });

    it("renders both occurrences of a shared object inside an array ([shared, shared])", () => {
      const shared = { password: "topsecret", keep: "visible" };
      const mask = new Set(["password"]);
      const out = redactValue([shared, shared], mask, new WeakSet()) as unknown[];

      expect(out[0]).toEqual({ password: "[REDACTED]", keep: "visible" });
      expect(out[1]).toEqual({ password: "[REDACTED]", keep: "visible" });
    });

    it("renders a deep diamond where a nested leaf is shared two levels down", () => {
      const leaf = { secret: "s3cr3t", keep: "ok" };
      const body = { x: { l: leaf }, y: { l: leaf } };
      const mask = new Set(["secret"]);
      const out = redactValue(body, mask, new WeakSet()) as {
        x: { l: Record<string, unknown> };
        y: { l: Record<string, unknown> };
      };

      expect(out.x.l).toEqual({ secret: "[REDACTED]", keep: "ok" });
      expect(out.y.l).toEqual({ secret: "[REDACTED]", keep: "ok" });
    });

    it("redacts both occurrences of a shared class-DTO instance referenced by two sibling keys", () => {
      class Credentials {
        constructor(
          public readonly username: string,
          public readonly password: string,
        ) {}
      }
      const dto = new Credentials("alice", "s3cr3t");
      const body = { u: dto, v: dto };
      const mask = new Set(["password"]);
      const out = redactValue(body, mask, new WeakSet()) as Record<string, unknown>;

      expect(out.u).toEqual({ username: "alice", password: "[REDACTED]" });
      expect(out.v).toEqual({ username: "alice", password: "[REDACTED]" });
      expect(out.u).not.toBe("[Circular]");
      expect(out.v).not.toBe("[Circular]");
    });

    it("a true self-referencing plain object still resolves to [Circular] after the active-path fix", () => {
      const obj: Record<string, unknown> = { label: "root" };
      obj.self = obj;
      const mask = new Set<string>();
      const out = redactValue(obj, mask, new WeakSet()) as Record<string, unknown>;

      expect(out.label).toBe("root");
      expect(out.self).toBe("[Circular]");
    });

    it("a mutual cycle between two plain objects still resolves to [Circular] after the active-path fix", () => {
      const a: Record<string, unknown> = { name: "a" };
      const b: Record<string, unknown> = { name: "b" };
      a.peer = b;
      b.peer = a;
      const mask = new Set<string>();
      const out = redactValue(a, mask, new WeakSet()) as Record<string, unknown>;
      const peer = out.peer as Record<string, unknown>;

      expect(out.name).toBe("a");
      expect(peer.name).toBe("b");
      // The edge that closes the cycle (b.peer -> a) resolves to "[Circular]";
      // the forward edge (a.peer -> b) is not itself circular and renders as
      // a proper nested object.
      expect(peer.peer).toBe("[Circular]");
    });
  });
});
