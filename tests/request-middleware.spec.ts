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

  it("falls back to string serialization when JSON conversion fails", () => {
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
    expect(payload.http.requestBody).toBe("42");
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

  it("redactUrlQuery returns the input unchanged when URL parsing fails", () => {
    const mask = new Set(["token"]);
    // `http://[invalid?...` triggers a real `URL` parse failure (`ERR_INVALID_URL`)
    // because the unclosed IPv6 bracket runs into the query separator. The
    // helper must catch the throw and return the input unchanged so logging is
    // never the cause of a request failure.
    const malformed = "http://[invalid?token=abc";
    expect(redactUrlQuery(malformed, mask)).toBe(malformed);
  });

  it("redactUrlQuery emits the literal [REDACTED] sentinel (not %5BREDACTED%5D) for relative URLs", () => {
    // URLSearchParams.toString() percent-encodes `[` → `%5B` and `]` → `%5D`.
    // Without the post-processing `.replace(/%5B/gi,"[").replace(/%5D/gi,"]")`
    // the logged URL would show `token=%5BREDACTED%5D` instead of the literal
    // sentinel used everywhere else in the package, breaking log monitoring.
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
});
