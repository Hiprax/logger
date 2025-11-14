import { EventEmitter } from "node:events";
import type { Request, Response, NextFunction } from "express";
import type winston from "winston";
import {
  createRequestLogger,
  __requestInternals,
} from "../src/request-middleware";
import * as loggerModule from "../src/logger";

const createMockLogger = () => {
  const log = jest.fn();
  return {
    logger: { log } as unknown as winston.Logger,
    log,
  };
};

class MockResponse extends EventEmitter {
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

class MockRequest {
  method = "POST";
  url = "/auth/login";
  originalUrl = "/auth/login";
  headers: Record<string, unknown> = {
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

  get(header: string) {
    return this.headers[header.toLowerCase()];
  }
}

const runMiddleware = (
  middleware: ReturnType<typeof createRequestLogger>,
  requestOverrides: Partial<MockRequest> = {},
  responseOverrides: Partial<MockResponse> = {}
) => {
  const req = Object.assign(new MockRequest(), requestOverrides);
  const res = Object.assign(new MockResponse(), responseOverrides);
  const next = jest.fn() as NextFunction;

  middleware(req as unknown as Request, res as unknown as Response, next);

  return { req, res, next };
};

describe("createRequestLogger", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("logs structured payloads on response finish", () => {
    const { logger, log } = createMockLogger();
    const middleware = createRequestLogger({
      logger,
      includeRequestBody: true,
      includeRequestHeaders: true,
      includeResponseHeaders: ["content-type"],
      maskBodyKeys: ["password"],
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
    expect(payload.http.responseHeaders?.["content-type"]).toBe(
      "application/json"
    );
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
    const middleware = createRequestLogger({ logger });

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
      includeRequestBody: true,
      includeResponseHeaders: true,
      maxBodyLength: 10,
    });

    const { req, res } = runMiddleware(middleware, {
      body: { long: "abcdefghijklmnopqrstuvwxyz" },
      headers: { "content-length": "77" },
    });

    res.emit("finish");

    const payload = log.mock.calls[0][0];
    expect(typeof payload.http.requestBody).toBe("string");
    expect(payload.http.requestBody.endsWith("…")).toBe(true);
    expect(payload.http.responseHeaders).toEqual({});
    expect(payload.http.contentLength).toBe(77);
  });

  it("supports request header allowlists", () => {
    const { logger, log } = createMockLogger();
    const middleware = createRequestLogger({
      logger,
      includeRequestHeaders: ["authorization"],
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
      includeResponseHeaders: true,
    });

    const { res } = runMiddleware(middleware);
    (res as unknown as { getHeaders: () => undefined }).getHeaders = () =>
      undefined;
    res.emit("finish");

    expect(log.mock.calls[0][0].http.responseHeaders).toEqual({});
  });

  it("skips request body logging when no body is present", () => {
    const { logger, log } = createMockLogger();
    const middleware = createRequestLogger({
      logger,
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
      includeRequestBody: true,
    });

    const { res } = runMiddleware(middleware, {
      body: [42n] as unknown,
    });

    res.emit("finish");

    const payload = log.mock.calls[0][0];
    expect(payload.http.requestBody).toBe("42");
  });

  it("derives identifiers from headers when req.get is unavailable", () => {
    const { logger, log } = createMockLogger();
    const middleware = createRequestLogger({
      logger,
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
    const spy = jest
      .spyOn(loggerModule, "createLogger")
      .mockReturnValue(mock.logger);

    createRequestLogger({ label: "api" });

    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ moduleName: "http/api" })
    );
    spy.mockRestore();
  });

  it("falls back to defaults when request fields are missing", () => {
    const { logger, log } = createMockLogger();
    const middleware = createRequestLogger({ logger });

    const { res } = runMiddleware(
      middleware,
      {
        method: undefined as unknown as string,
        url: undefined as unknown as string,
        originalUrl: undefined as unknown as string,
      },
      {
        statusCode: undefined as unknown as number,
      }
    );

    res.emit("finish");

    const payload = log.mock.calls[0][0];
    expect(payload.http.method).toBe("GET");
    expect(payload.http.url).toBe("");
    expect(payload.http.statusCode).toBe(0);
  });

  it("derives client ip from socket when req.ip is undefined", () => {
    const { logger, log } = createMockLogger();
    const middleware = createRequestLogger({ logger });

    const { res } = runMiddleware(middleware, {
      ip: undefined as unknown as string,
      socket: { remoteAddress: "10.0.0.1" },
    });

    res.emit("finish");

    expect(log.mock.calls[0][0].http.ip).toBe("10.0.0.1");
  });

  it("omits ip when neither req.ip nor socket remote address exist", () => {
    const { logger, log } = createMockLogger();
    const middleware = createRequestLogger({ logger });

    const { res } = runMiddleware(middleware, {
      ip: undefined as unknown as string,
      socket: { remoteAddress: undefined as unknown as string },
    });

    res.emit("finish");

    expect(log.mock.calls[0][0].http.ip).toBeUndefined();
  });
});

describe("request middleware internals", () => {
  const { serializeBody, normalizeHeaders, toNumber } = __requestInternals;

  it("serializes primitive bodies and truncates strings", () => {
    expect(serializeBody("hello", undefined, 100)).toBe("hello");
    expect(serializeBody("truncate-me", undefined, 4)).toBe("trun…");
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

    expect(serializeBody(problematic, undefined, 5)).toBe("fallb…");
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
});
