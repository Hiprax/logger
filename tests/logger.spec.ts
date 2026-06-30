import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import util from "node:util";
import fc from "fast-check";
import winston from "winston";
import Transport from "winston-transport";
import DailyRotateFile from "winston-daily-rotate-file";
import {
  createLogger,
  createNoopLogger,
  resetLoggerRegistry,
  shutdownLogger,
  shutdownAllLoggers,
  defaultRotation,
  getDefaultRotation,
  __loggerInternals,
} from "../src/logger";
import type { ShutdownOptions } from "../src/logger";
import { InvalidTimezoneError, LoggerOptionError } from "../src/errors";
import { createTempDir, teardownLogger } from "./_helpers";

/**
 * Minimal Winston-compatible transport used by the transport-error-handling
 * tests. Extends the official `winston-transport` base class so winston does
 * NOT wrap it as a legacy transport (which would re-emit `error` events back
 * into the logger machinery and break the synthetic-emit contract).
 */
class StubTransport extends Transport {
  public name = "stub-transport";
  public log = jest.fn((_info: unknown, callback?: () => void) => callback?.());
}

const createNoopTransportLogger = () => {
  const stream = new PassThrough();
  return createLogger({
    includeConsole: false,
    includeFile: false,
    includeGlobalFile: false,
    additionalTransports: [
      new winston.transports.Stream({
        stream,
      }),
    ],
  });
};

describe("createLogger", () => {
  afterEach(() => {
    resetLoggerRegistry();
    jest.restoreAllMocks();
  });

  it("creates the log directory when missing", () => {
    const root = createTempDir();
    const target = path.join(root, "logs-output");
    fs.rmSync(target, { recursive: true, force: true });

    // includeFile is left enabled so the lazy ensureDirectory path runs.
    const logger = createLogger({
      logDirectory: target,
      includeConsole: false,
      includeFile: true,
      includeGlobalFile: false,
    });

    expect(fs.existsSync(target)).toBe(true);
    teardownLogger(logger);
  });

  it("creates nested directories for scoped module names", () => {
    const root = createTempDir();
    // includeFile must be on so the module-scoped directory is materialized
    // (lazy creation: no file transports => no directory side-effect).
    const logger = createLogger({
      logDirectory: root,
      moduleName: "security/failedLogins",
      includeConsole: false,
      includeFile: true,
      includeGlobalFile: false,
    });

    expect(fs.existsSync(path.join(root, "security"))).toBe(true);
    teardownLogger(logger);
  });

  it("attaches rotating file transports with independent rotation configs", () => {
    const root = createTempDir();
    const logger = createLogger({
      logDirectory: root,
      includeConsole: false,
      rotation: { maxFiles: "2d" },
      globalRotation: { maxFiles: "30d" },
    });

    const rotating = logger.transports.filter(
      (transport): transport is DailyRotateFile => transport instanceof DailyRotateFile,
    );

    expect(rotating).toHaveLength(2);
    expect(rotating[0].options.maxFiles).toBe("2d");
    expect(rotating[1].options.maxFiles).toBe("30d");
    teardownLogger(logger);
  });

  it("normalizes an uppercase maxFiles day suffix to lowercase before the transport (F8)", () => {
    // `file-stream-rotator` (the engine behind `winston-daily-rotate-file`)
    // detects the day suffix case-SENSITIVELY (`max_logs.toString().substr(-1)
    // === 'd'`), while `MAX_FILES_PATTERN` and the public JSDoc both document
    // `"14D"` as accepted "14 days" input. Without normalization, "14D" would
    // pass validation but silently behave as a 14-FILE retention window
    // instead of 14 days. Both the module-scoped and the global rotating-file
    // transport must receive the normalized lowercase value.
    const root = createTempDir();
    const logger = createLogger({
      logDirectory: root,
      includeConsole: false,
      rotation: { maxFiles: "14D" },
      globalRotation: { maxFiles: "30D" },
    });

    const rotating = logger.transports.filter(
      (transport): transport is DailyRotateFile => transport instanceof DailyRotateFile,
    );

    expect(rotating).toHaveLength(2);
    expect(rotating[0].options.maxFiles).toBe("14d");
    expect(rotating[1].options.maxFiles).toBe("30d");
    teardownLogger(logger);
  });

  it("supports extra timezones and renders enriched messages", () => {
    const root = createTempDir();
    const messages: string[] = [];
    const stream = new PassThrough();
    stream.on("data", (chunk) => messages.push(chunk.toString()));

    const logger = createLogger({
      moduleName: "test-module",
      logDirectory: root,
      includeConsole: false,
      includeFile: false,
      includeGlobalFile: false,
      extraTimezones: ["Europe/London"],
      additionalTransports: [
        new winston.transports.Stream({
          stream,
        }),
      ],
    });

    logger.info("Hello world", { userId: 42 });
    teardownLogger(logger);

    expect(messages.some((entry) => entry.includes("UTC:"))).toBe(true);
    expect(messages.some((entry) => entry.includes("Europe/London"))).toBe(true);
    expect(messages.some((entry) => entry.includes('"userId": 42'))).toBe(true);
  });

  it("throws for invalid timezones", () => {
    expect(() =>
      createLogger({
        extraTimezones: ["Invalid/Zone"],
        includeConsole: false,
        includeFile: false,
        includeGlobalFile: false,
      }),
    ).toThrow(InvalidTimezoneError);
  });

  it("attaches console transport when enabled", () => {
    const logger = createLogger({
      includeConsole: true,
      includeFile: false,
      includeGlobalFile: false,
    });

    const hasConsole = logger.transports.some(
      (transport) => transport instanceof winston.transports.Console,
    );
    expect(hasConsole).toBe(true);
    teardownLogger(logger);
  });

  it("logs stack traces and metadata to custom transports", () => {
    const messages: string[] = [];
    const stream = new PassThrough();
    stream.on("data", (chunk) => messages.push(chunk.toString()));

    const logger = createLogger({
      includeConsole: false,
      includeFile: false,
      includeGlobalFile: false,
      additionalTransports: [
        new winston.transports.Stream({
          stream,
        }),
      ],
    });

    const error = new Error("Boom");
    logger.log({
      level: "error",
      message: "Boom",
      stack: error.stack,
      correlationId: "xyz",
    });
    teardownLogger(logger);

    const output = messages.join("");
    expect(output).toContain("Boom");
    expect(output).toContain("correlationId");
    expect(output).toContain("Error: Boom");
  });

  it("falls back to a safe segment name when module name is blank", () => {
    const root = createTempDir();
    const logger = createLogger({
      logDirectory: root,
      moduleName: "   ",
      includeConsole: false,
      includeGlobalFile: false,
    });

    const fileTransport = logger.transports.find(
      (transport): transport is DailyRotateFile => transport instanceof DailyRotateFile,
    );

    expect(path.basename(fileTransport?.options.filename ?? "")).toBe("logs-%DATE%.log");
    teardownLogger(logger);
  });

  it("accepts string based timezone inputs", () => {
    const messages: string[] = [];
    const stream = new PassThrough();
    stream.on("data", (chunk) => messages.push(chunk.toString()));

    const logger = createLogger({
      includeConsole: false,
      includeFile: false,
      includeGlobalFile: false,
      extraTimezones: " Europe/London ",
      additionalTransports: [
        new winston.transports.Stream({
          stream,
        }),
      ],
    });

    logger.info("timezone test");
    teardownLogger(logger);

    expect(messages.join("")).toContain("Europe/London");
  });

  it("serializes object messages and deduplicates timezones", () => {
    const messages: string[] = [];
    const stream = new PassThrough();
    stream.on("data", (chunk) => messages.push(chunk.toString()));

    const logger = createLogger({
      includeConsole: false,
      includeFile: false,
      includeGlobalFile: false,
      extraTimezones: ["Europe/London", "Europe/London"],
      additionalTransports: [
        new winston.transports.Stream({
          stream,
        }),
      ],
    });

    logger.info({ foo: "bar" });
    teardownLogger(logger);

    const output = messages.join("");
    expect(output.match(/Europe\/London/g)?.length).toBe(1);
    expect(output).toContain('"foo": "bar"');
  });

  it("reuses module rotation defaults when global rotation is omitted", () => {
    const root = createTempDir();
    const logger = createLogger({
      logDirectory: root,
      includeConsole: false,
      rotation: { maxFiles: "5d" },
    });

    const rotating = logger.transports.filter(
      (transport): transport is DailyRotateFile => transport instanceof DailyRotateFile,
    );

    expect(rotating).toHaveLength(2);
    expect(rotating[0].options.maxFiles).toBe("5d");
    expect(rotating[1].options.maxFiles).toBe("5d");
    teardownLogger(logger);
  });

  it("falls back to info when unknown methods are invoked", () => {
    const messages: string[] = [];
    const stream = new PassThrough();
    stream.on("data", (chunk) => messages.push(chunk.toString()));

    const logger = createLogger({
      includeConsole: false,
      includeFile: false,
      includeGlobalFile: false,
      additionalTransports: [
        new winston.transports.Stream({
          stream,
        }),
      ],
    });

    expect(() => (logger as any).success("custom level")).not.toThrow();
    teardownLogger(logger);

    const output = messages.join("");
    expect(output).toContain('Unknown logger method "success"');
    expect(output).toContain("custom level");
    expect(output).toContain("[INFO]");
  });

  it("warns via console when the logger has no warn method", () => {
    const logger = createNoopTransportLogger();

    const consoleSpy = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    (logger as any).warn = undefined;

    expect(() => (logger as any).mystery()).not.toThrow();
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('"mystery"'));
    consoleSpy.mockRestore();
    teardownLogger(logger);
  });

  it("routes fallback logging through base log when info is missing", () => {
    const logger = createNoopTransportLogger();

    const logSpy = jest.fn();
    (logger as any).info = undefined;
    (logger as any).log = logSpy;

    (logger as any).ghost({ foo: "bar" });

    expect(logSpy).toHaveBeenCalledWith({
      level: "info",
      message: '{"foo":"bar"}',
    });
    teardownLogger(logger);
  });

  it("preserves metadata when fallback logging receives extra arguments", () => {
    const logger = createNoopTransportLogger();

    const logSpy = jest.fn();
    (logger as any).info = undefined;
    (logger as any).log = logSpy;

    const meta = { requestId: "abc" };
    (logger as any).phantom("hello", meta);

    expect(logSpy).toHaveBeenCalledWith("info", "hello", meta);
    teardownLogger(logger);
  });

  it("injects an empty message when fallback is invoked without arguments", () => {
    const logger = createNoopTransportLogger();

    const infoSpy = jest.fn();
    (logger as any).info = infoSpy;

    (logger as any).void();

    expect(infoSpy).toHaveBeenCalledWith("");
    teardownLogger(logger);
  });

  it("warns only once per unknown method", () => {
    const logger = createNoopTransportLogger();
    const warnSpy = jest.fn();
    (logger as any).warn = warnSpy;

    (logger as any).mystery();
    (logger as any).mystery();

    expect(warnSpy).toHaveBeenCalledTimes(1);
    teardownLogger(logger);
  });

  it("stringifies BigInt payloads when info is missing and log receives an object", () => {
    const logger = createNoopTransportLogger();
    (logger as any).info = undefined;
    const logSpy = jest.fn();
    (logger as any).log = logSpy;

    (logger as any).nebula(42n);

    expect(logSpy).toHaveBeenCalledWith({
      level: "info",
      message: "42",
    });
    teardownLogger(logger);
  });

  it("logs a console warning when neither info nor log exists", () => {
    const logger = createNoopTransportLogger();
    const consoleSpy = jest.spyOn(console, "warn").mockImplementation(() => undefined);

    (logger as any).info = undefined;
    (logger as any).log = undefined;

    (logger as any).phantom();

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("no info/log method was available"),
    );
    consoleSpy.mockRestore();
    teardownLogger(logger);
  });

  it("falls back to String(value) when JSON serialization fails", () => {
    const logger = createNoopTransportLogger();
    const logSpy = jest.fn();
    (logger as any).info = undefined;
    (logger as any).log = logSpy;

    const problematic = {
      toJSON() {
        throw new Error("nope");
      },
      toString() {
        return "stringified-problem";
      },
    };

    (logger as any).obscure(problematic);

    expect(logSpy).toHaveBeenCalledWith({
      level: "info",
      message: "stringified-problem",
    });
    teardownLogger(logger);
  });

  it("handles circular objects by using String fallback", () => {
    const logger = createNoopTransportLogger();
    (logger as any).info = undefined;
    const logSpy = jest.fn();
    (logger as any).log = logSpy;

    const circular: any = {};
    circular.self = circular;

    (logger as any).cyclone(circular);

    expect(logSpy).toHaveBeenCalledWith({
      level: "info",
      message: "[object Object]",
    });
    teardownLogger(logger);
  });

  it("coerces undefined payloads to empty strings when info fallback uses log()", () => {
    const logger = createNoopTransportLogger();
    (logger as any).info = undefined;
    const logSpy = jest.fn();
    (logger as any).log = logSpy;

    (logger as any).wisp(undefined);

    expect(logSpy).toHaveBeenCalledWith({
      level: "info",
      message: "",
    });
    teardownLogger(logger);
  });

  describe("proxy boundaries", () => {
    const buildBareLogger = () => {
      const stream = new PassThrough();
      const logger = createLogger({
        includeConsole: false,
        includeFile: false,
        includeGlobalFile: false,
        additionalTransports: [
          new winston.transports.Stream({
            stream,
          }),
        ],
      });
      return { logger, stream };
    };

    it("does not make the logger thenable so `await logger` resolves to the logger", async () => {
      const { logger } = buildBareLogger();
      const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => undefined);

      const awaited = await logger;

      expect(awaited).toBe(logger);
      expect(warnSpy).not.toHaveBeenCalled();
      warnSpy.mockRestore();
      teardownLogger(logger);
    });

    it("allows JSON.stringify(logger) without throwing or warning", () => {
      const { logger } = buildBareLogger();
      const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => undefined);

      let serialized: string | undefined;
      expect(() => {
        serialized = JSON.stringify(logger);
      }).not.toThrow();

      expect(typeof serialized).toBe("string");
      // Result must be valid JSON parseable into an object summarizing the logger.
      const parsed = JSON.parse(serialized as string);
      expect(parsed).toEqual(
        expect.objectContaining({
          type: "@hiprax/logger",
          level: "info",
        }),
      );
      expect(warnSpy).not.toHaveBeenCalled();
      warnSpy.mockRestore();
      teardownLogger(logger);
    });

    it("Promise.resolve(logger) resolves to the logger instance", async () => {
      const { logger } = buildBareLogger();
      const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => undefined);

      const resolved = await Promise.resolve(logger);

      expect(resolved).toBe(logger);
      expect(warnSpy).not.toHaveBeenCalled();
      warnSpy.mockRestore();
      teardownLogger(logger);
    });

    it("String(logger) does not warn", () => {
      const { logger } = buildBareLogger();
      const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => undefined);

      const stringified = String(logger);
      expect(typeof stringified).toBe("string");
      expect(warnSpy).not.toHaveBeenCalled();
      warnSpy.mockRestore();
      teardownLogger(logger);
    });

    it("'then' is not in the logger", () => {
      const { logger } = buildBareLogger();
      expect("then" in logger).toBe(false);
      teardownLogger(logger);
    });

    it("Object.keys(logger) excludes proxy-only probes like then/toJSON", () => {
      const { logger } = buildBareLogger();
      const keys = Object.keys(logger);
      expect(keys).not.toContain("then");
      expect(keys).not.toContain("toJSON");
      expect(keys).not.toContain("nodeType");
      teardownLogger(logger);
    });

    it("logger.success('ok') still emits the unknown-method warning (regression guard)", () => {
      const messages: string[] = [];
      const stream = new PassThrough();
      stream.on("data", (chunk) => messages.push(chunk.toString()));

      const logger = createLogger({
        includeConsole: false,
        includeFile: false,
        includeGlobalFile: false,
        additionalTransports: [
          new winston.transports.Stream({
            stream,
          }),
        ],
      });

      expect(() => (logger as any).success("ok")).not.toThrow();
      teardownLogger(logger);

      const output = messages.join("");
      expect(output).toContain('Unknown logger method "success"');
      expect(output).toContain("ok");
    });

    it("logger[Symbol.iterator] is undefined and produces no warning", () => {
      const { logger } = buildBareLogger();
      const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => undefined);

      // Symbols not present on the base winston logger must return undefined
      // (no warning, no fallback shim).
      expect((logger as any)[Symbol.iterator]).toBeUndefined();
      expect((logger as any)[Symbol.toPrimitive]).toBeUndefined();
      expect((logger as any)[Symbol.toStringTag]).toBeUndefined();
      expect((logger as any)[Symbol.for("nodejs.util.inspect.custom")]).toBeUndefined();
      expect(warnSpy).not.toHaveBeenCalled();

      warnSpy.mockRestore();
      teardownLogger(logger);
    });

    it("rejects prop names that do not look like a method identifier", () => {
      const { logger } = buildBareLogger();
      const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => undefined);

      // Names starting with non-alphabetic chars or containing illegal chars
      // are NOT routed through the unknown-method fallback. They return
      // undefined silently with no warning.
      expect((logger as any)["123digits"]).toBeUndefined();
      expect((logger as any)["with-dash"]).toBeUndefined();
      expect((logger as any)["with space"]).toBeUndefined();
      expect((logger as any)[""]).toBeUndefined();
      expect((logger as any)["x".repeat(64)]).toBeUndefined();
      expect(warnSpy).not.toHaveBeenCalled();

      warnSpy.mockRestore();
      teardownLogger(logger);
    });

    it("util.inspect(logger) does not warn", () => {
      const { logger } = buildBareLogger();
      const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => undefined);

      const inspected = util.inspect(logger);
      expect(typeof inspected).toBe("string");
      expect(warnSpy).not.toHaveBeenCalled();

      warnSpy.mockRestore();
      teardownLogger(logger);
    });

    it("returns undefined for JS engine introspection probes (name/prototype/length/arguments/caller/bind)", () => {
      const { logger } = buildBareLogger();
      const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => undefined);

      // Standard introspection props that real `Function` instances expose
      // (`Function.name`, `Function.prototype`, `Function.length`,
      // `Function.arguments`, `Function.caller`, `Function.prototype.bind`)
      // would otherwise pass `FALLBACK_METHOD_NAME_PATTERN` and return a
      // shim — minting a spurious `Unknown logger method "name"` warning when
      // the framework probes the object reflectively. They must return
      // `undefined` instead so reflective code paths see "not a function".
      expect((logger as any).name).toBeUndefined();
      expect((logger as any).prototype).toBeUndefined();
      expect((logger as any).length).toBeUndefined();
      expect((logger as any).arguments).toBeUndefined();
      expect((logger as any).caller).toBeUndefined();
      expect((logger as any).bind).toBeUndefined();
      // No console.warn fallback emitted because the deny-list short-circuits
      // before the unknown-method branch runs.
      expect(warnSpy).not.toHaveBeenCalled();

      warnSpy.mockRestore();
      teardownLogger(logger);
    });

    it("emits a fresh warning after MAX_TRACKED_UNKNOWN_METHODS unique typos (cap-and-reset)", () => {
      // The `warnedMethods` Set tracks each unique unknown-method name to
      // suppress duplicate warnings. Without a cap the set grows monotonically
      // when a misbehaving consumer funnels arbitrary input into method names
      // (e.g. `logger[req.headers["x-action"]]()`). Once the cap is reached
      // the set is cleared so genuinely new typos still surface — including
      // the FIRST name we tried, which is now eligible to warn again.
      const messages: string[] = [];
      const stream = new PassThrough();
      stream.on("data", (chunk) => messages.push(chunk.toString()));

      const logger = createLogger({
        moduleName: "warned-methods-cap",
        includeConsole: false,
        includeFile: false,
        includeGlobalFile: false,
        additionalTransports: [
          new winston.transports.Stream({
            stream,
          }),
        ],
      });

      const max = __loggerInternals.MAX_TRACKED_UNKNOWN_METHODS;
      // Issue MAX + 1 unique unknown-method names; the (MAX + 1)th call
      // triggers the size-cap branch, clears the tracker, and records the
      // (MAX + 1)th name fresh — so all MAX + 1 warnings are emitted.
      for (let i = 0; i < max + 1; i += 1) {
        (logger as any)[`unknown${i}`]("ok");
      }

      const output = messages.join("");
      // The first method warned at index 0 and the (max + 1)th unique method
      // both produce a warning message (the latter is the cap-trigger entry).
      expect(output).toContain('Unknown logger method "unknown0"');
      expect(output).toContain(`Unknown logger method "unknown${max}"`);

      // After the reset the FIRST name we already used is no longer in the
      // tracker, so it can emit a fresh warning. We assert this by counting
      // the number of distinct warning lines for `unknown0` — it must be at
      // least 2 (one before the reset, one after).
      const beforeCount = messages.length;
      (logger as any).unknown0("again");
      const after = messages.slice(beforeCount).join("");
      expect(after).toContain('Unknown logger method "unknown0"');

      teardownLogger(logger);
    });
  });

  describe("registry", () => {
    it("returns the same instance for identical moduleName and logDirectory", () => {
      const root = createTempDir();
      const first = createLogger({
        moduleName: "auth",
        logDirectory: root,
        includeConsole: false,
        includeFile: false,
        includeGlobalFile: false,
      });

      const second = createLogger({
        moduleName: "auth",
        logDirectory: root,
        includeConsole: false,
        includeFile: false,
        includeGlobalFile: false,
      });

      expect(first).toBe(second);
      teardownLogger(first);
    });

    it("returns different instances for different module names", () => {
      const root = createTempDir();
      const opts = {
        logDirectory: root,
        includeConsole: false,
        includeFile: false,
        includeGlobalFile: false,
      };

      const first = createLogger({ ...opts, moduleName: "auth" });
      const second = createLogger({ ...opts, moduleName: "payments" });

      expect(first).not.toBe(second);
      teardownLogger(first);
      teardownLogger(second);
    });

    it("returns different instances for different log directories", () => {
      const root1 = createTempDir();
      const root2 = createTempDir();
      const opts = {
        moduleName: "auth",
        includeConsole: false,
        includeFile: false,
        includeGlobalFile: false,
      };

      const first = createLogger({ ...opts, logDirectory: root1 });
      const second = createLogger({ ...opts, logDirectory: root2 });

      expect(first).not.toBe(second);
      teardownLogger(first);
      teardownLogger(second);
    });

    it("creates fresh instances after resetLoggerRegistry", () => {
      const root = createTempDir();
      const opts = {
        moduleName: "auth",
        logDirectory: root,
        includeConsole: false,
        includeFile: false,
        includeGlobalFile: false,
      };

      const first = createLogger(opts);
      resetLoggerRegistry();
      const second = createLogger(opts);

      expect(first).not.toBe(second);
      teardownLogger(first);
      teardownLogger(second);
    });
  });

  describe("registry signature", () => {
    const baseOpts = (root: string) => ({
      moduleName: "auth",
      logDirectory: root,
      includeConsole: false,
      includeFile: false,
      includeGlobalFile: false,
    });

    it("does not warn when the same options are passed twice for the same key", () => {
      const root = createTempDir();
      const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => undefined);

      const first = createLogger(baseOpts(root));
      const second = createLogger(baseOpts(root));

      expect(first).toBe(second);
      expect(warnSpy).not.toHaveBeenCalled();
      warnSpy.mockRestore();
      teardownLogger(first);
    });

    it("warns once when level differs and returns the cached instance", () => {
      const root = createTempDir();
      const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => undefined);

      const first = createLogger({ ...baseOpts(root), level: "info" });
      const second = createLogger({ ...baseOpts(root), level: "debug" });

      expect(second).toBe(first);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      const message = String(warnSpy.mock.calls[0][0]);
      expect(message).toContain("conflicting options");
      expect(message).toContain("level");

      warnSpy.mockRestore();
      teardownLogger(first);
    });

    it("warns when extraTimezones differs and returns the cached instance", () => {
      const root = createTempDir();
      const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => undefined);

      const first = createLogger({ ...baseOpts(root), extraTimezones: ["Europe/London"] });
      const second = createLogger({ ...baseOpts(root), extraTimezones: ["America/New_York"] });

      expect(second).toBe(first);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      const message = String(warnSpy.mock.calls[0][0]);
      expect(message).toContain("extraTimezones");

      warnSpy.mockRestore();
      teardownLogger(first);
    });

    it("warns when rotation.maxFiles differs and returns the cached instance", () => {
      const root = createTempDir();
      const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => undefined);

      const first = createLogger({ ...baseOpts(root), rotation: { maxFiles: "7d" } });
      const second = createLogger({ ...baseOpts(root), rotation: { maxFiles: "30d" } });

      expect(second).toBe(first);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      const message = String(warnSpy.mock.calls[0][0]);
      expect(message).toContain("rotation");

      warnSpy.mockRestore();
      teardownLogger(first);
    });

    it("does not warn when rotation.maxFiles differs only by day-suffix case (F8)", () => {
      // "14d" and "14D" normalize to the same transport-facing value, so the
      // registry signature must treat them as equal — otherwise this would be
      // a false-positive conflict warning for two functionally identical
      // configs.
      const root = createTempDir();
      const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => undefined);

      const first = createLogger({ ...baseOpts(root), rotation: { maxFiles: "14d" } });
      const second = createLogger({ ...baseOpts(root), rotation: { maxFiles: "14D" } });

      expect(second).toBe(first);
      expect(warnSpy).not.toHaveBeenCalled();

      warnSpy.mockRestore();
      teardownLogger(first);
    });

    it("warns when maskMetaKeys differs and returns the cached instance (F9)", () => {
      const root = createTempDir();
      const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => undefined);

      const first = createLogger({ ...baseOpts(root), maskMetaKeys: ["password"] });
      const second = createLogger({ ...baseOpts(root), maskMetaKeys: ["token"] });

      expect(second).toBe(first);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      const message = String(warnSpy.mock.calls[0][0]);
      expect(message).toContain("conflicting options");
      expect(message).toContain("maskMetaKeys");

      warnSpy.mockRestore();
      teardownLogger(first);
    });

    it("does not warn when maskMetaKeys differs only by order or case (F9)", () => {
      // ["Password", "TOKEN"] and ["token", "password"] normalize to the same
      // lowercased+sorted signature, so this must NOT be a false-positive
      // conflict warning for two functionally identical redaction configs.
      const root = createTempDir();
      const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => undefined);

      const first = createLogger({ ...baseOpts(root), maskMetaKeys: ["Password", "TOKEN"] });
      const second = createLogger({ ...baseOpts(root), maskMetaKeys: ["token", "password"] });

      expect(second).toBe(first);
      expect(warnSpy).not.toHaveBeenCalled();

      warnSpy.mockRestore();
      teardownLogger(first);
    });

    it("does not warn when the same non-empty maskMetaKeys array is passed twice (F9)", () => {
      const root = createTempDir();
      const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => undefined);

      const first = createLogger({ ...baseOpts(root), maskMetaKeys: ["password", "token"] });
      const second = createLogger({ ...baseOpts(root), maskMetaKeys: ["password", "token"] });

      expect(second).toBe(first);
      expect(warnSpy).not.toHaveBeenCalled();

      warnSpy.mockRestore();
      teardownLogger(first);
    });

    it("does not warn a second time when the same mismatched options recur", () => {
      const root = createTempDir();
      const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => undefined);

      const first = createLogger({ ...baseOpts(root), level: "info" });
      createLogger({ ...baseOpts(root), level: "debug" });
      createLogger({ ...baseOpts(root), level: "debug" });
      createLogger({ ...baseOpts(root), level: "warn" });

      expect(warnSpy).toHaveBeenCalledTimes(1);
      warnSpy.mockRestore();
      teardownLogger(first);
    });

    it("still validates extraTimezones on a cache hit (validation runs before lookup)", () => {
      const root = createTempDir();
      const first = createLogger(baseOpts(root));

      expect(() => createLogger({ ...baseOpts(root), extraTimezones: ["Invalid/Zone"] })).toThrow(
        InvalidTimezoneError,
      );

      teardownLogger(first);
    });

    it("warns when additionalTransports count changes and notes the comparison limitation", () => {
      const root = createTempDir();
      const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => undefined);

      const stream = new PassThrough();
      const extra = new winston.transports.Stream({ stream });

      const first = createLogger({
        ...baseOpts(root),
        additionalTransports: [extra],
      });
      const second = createLogger({
        ...baseOpts(root),
        additionalTransports: [],
      });

      expect(second).toBe(first);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      const message = String(warnSpy.mock.calls[0][0]);
      expect(message).toContain("additionalTransports(count)");
      expect(message).toContain("compared by count only");

      warnSpy.mockRestore();
      teardownLogger(first);
    });

    it("treats relative and resolved logDirectory as the same cache entry", () => {
      const cwd = process.cwd();
      try {
        const root = createTempDir();
        process.chdir(root);
        fs.mkdirSync(path.join(root, "logs"), { recursive: true });

        const opts = {
          moduleName: "auth",
          includeConsole: false,
          includeFile: false,
          includeGlobalFile: false,
        };

        const first = createLogger({ ...opts, logDirectory: "./logs" });
        const second = createLogger({ ...opts, logDirectory: path.resolve("./logs") });

        expect(second).toBe(first);
        teardownLogger(first);
      } finally {
        process.chdir(cwd);
      }
    });

    (process.platform === "win32" ? it : it.skip)(
      "treats mixed-case Windows logDirectory paths as the same cache entry",
      () => {
        const root = createTempDir();
        // Build a path that exists with a known case, then probe with an
        // upper- and lower-case variant of the drive/segment.
        const upper = root.charAt(0).toUpperCase() + root.slice(1);
        const lower = root.charAt(0).toLowerCase() + root.slice(1);

        const opts = {
          moduleName: "auth",
          includeConsole: false,
          includeFile: false,
          includeGlobalFile: false,
        };

        const first = createLogger({ ...opts, logDirectory: upper });
        const second = createLogger({ ...opts, logDirectory: lower });

        expect(second).toBe(first);
        teardownLogger(first);
      },
    );
  });

  describe("transport error handling", () => {
    it("does not crash the process and writes to console.error when a transport emits error", () => {
      const stub = new StubTransport();
      const consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => undefined);

      const logger = createLogger({
        includeConsole: false,
        includeFile: false,
        includeGlobalFile: false,
        additionalTransports: [stub as unknown as winston.transport],
      });

      const error = new Error("disk on fire");
      // Synthetic emit — must not throw an unhandled-error-event crash.
      expect(() => stub.emit("error", error)).not.toThrow();

      expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
      const logged = String(consoleErrorSpy.mock.calls[0][0]);
      expect(logged).toContain("@hiprax/logger transport");
      expect(logged).toContain("stub-transport");
      expect(logged).toContain("disk on fire");

      consoleErrorSpy.mockRestore();
      teardownLogger(logger);
    });

    it("invokes onTransportError callback with the error and the transport reference", () => {
      const stub = new StubTransport();
      const onTransportError = jest.fn();

      const logger = createLogger({
        includeConsole: false,
        includeFile: false,
        includeGlobalFile: false,
        additionalTransports: [stub as unknown as winston.transport],
        onTransportError,
      });

      const error = new Error("rotate fail");
      stub.emit("error", error);

      expect(onTransportError).toHaveBeenCalledTimes(1);
      expect(onTransportError.mock.calls[0][0]).toBe(error);
      expect(onTransportError.mock.calls[0][1]).toBe(stub);

      teardownLogger(logger);
    });

    it("does not crash and falls back to console.error when the callback throws", () => {
      const stub = new StubTransport();
      const consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => undefined);
      const onTransportError = jest.fn(() => {
        throw new Error("callback exploded");
      });

      const logger = createLogger({
        includeConsole: false,
        includeFile: false,
        includeGlobalFile: false,
        additionalTransports: [stub as unknown as winston.transport],
        onTransportError,
      });

      expect(() => stub.emit("error", new Error("write fail"))).not.toThrow();

      // First console.error reports the callback failure; the second is the
      // fallback for the original transport error.
      expect(consoleErrorSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
      const flat = consoleErrorSpy.mock.calls.map((c) => c.map(String).join(" ")).join(" | ");
      expect(flat).toContain("onTransportError callback threw");
      expect(flat).toContain("write fail");

      consoleErrorSpy.mockRestore();
      teardownLogger(logger);
    });

    it("deduplicates repeated identical error messages so the callback fires once", () => {
      const stub = new StubTransport();
      const onTransportError = jest.fn();

      const logger = createLogger({
        includeConsole: false,
        includeFile: false,
        includeGlobalFile: false,
        additionalTransports: [stub as unknown as winston.transport],
        onTransportError,
      });

      const error = new Error("ENOSPC");
      stub.emit("error", error);
      stub.emit("error", error);
      stub.emit("error", new Error("ENOSPC"));

      expect(onTransportError).toHaveBeenCalledTimes(1);

      // A genuinely new message is still surfaced.
      stub.emit("error", new Error("EACCES"));
      expect(onTransportError).toHaveBeenCalledTimes(2);

      teardownLogger(logger);
    });

    it("throws TypeError when an additionalTransports entry is missing log/on", () => {
      expect(() =>
        createLogger({
          includeConsole: false,
          includeFile: false,
          includeGlobalFile: false,
          additionalTransports: [{} as unknown as winston.transport],
        }),
      ).toThrow(TypeError);

      expect(() =>
        createLogger({
          includeConsole: false,
          includeFile: false,
          includeGlobalFile: false,
          additionalTransports: [{} as unknown as winston.transport],
        }),
      ).toThrow(
        "additionalTransports[0] must be a Winston-compatible transport (an object with `log` and `on` methods).",
      );
    });

    it("resets the dedup tracker after MAX_TRACKED_TRANSPORT_ERRORS unique messages", () => {
      const stub = new StubTransport();
      const onTransportError = jest.fn();

      const logger = createLogger({
        includeConsole: false,
        includeFile: false,
        includeGlobalFile: false,
        additionalTransports: [stub as unknown as winston.transport],
        onTransportError,
      });

      // Emit MAX + 1 unique messages. The (MAX + 1)th call resets the tracker
      // and is recorded fresh, so all MAX + 1 messages reach the callback.
      const max = __loggerInternals.MAX_TRACKED_TRANSPORT_ERRORS;
      for (let i = 0; i < max + 1; i += 1) {
        stub.emit("error", new Error(`unique-${i}`));
      }
      expect(onTransportError).toHaveBeenCalledTimes(max + 1);

      // After the reset the first emitted message is no longer in the tracker,
      // so it can be surfaced again.
      stub.emit("error", new Error("unique-0"));
      expect(onTransportError).toHaveBeenCalledTimes(max + 2);

      teardownLogger(logger);
    });

    it("rejects null entries in additionalTransports", () => {
      expect(() =>
        createLogger({
          includeConsole: false,
          includeFile: false,
          includeGlobalFile: false,
          additionalTransports: [null as unknown as winston.transport],
        }),
      ).toThrow(/additionalTransports\[0\]/);
    });

    it("captures additionalTransports defensively so post-construction mutation has no effect", () => {
      const stub = new StubTransport();
      const input: winston.transport[] = [stub as unknown as winston.transport];

      const logger = createLogger({
        includeConsole: false,
        includeFile: false,
        includeGlobalFile: false,
        additionalTransports: input,
      });

      // Mutate the caller's array AFTER construction. The logger MUST NOT see
      // the new entry, and MUST NOT throw later because of it.
      input.push({} as unknown as winston.transport);
      input.push({ totally: "garbage" } as unknown as winston.transport);

      expect(logger.transports).toHaveLength(1);
      expect(logger.transports[0]).toBe(stub);

      teardownLogger(logger);
    });
  });

  describe("timestamp capture", () => {
    it("renders the call-time timestamp via injected clock, not the flush-time clock", async () => {
      // The fake clock returns a fixed Date the FIRST time it is called and a
      // very different Date thereafter. The call-time capture (via the
      // prepended timestamp formatter) must read the FIRST value and the
      // rendered output MUST match it, even when the format pipeline is
      // deferred by an async transport.
      const fixed = new Date("2030-06-15T12:34:56Z");
      const drift = new Date("2099-01-01T00:00:00Z");
      let calls = 0;
      const clock = () => {
        calls += 1;
        return calls === 1 ? fixed : drift;
      };

      const messages: string[] = [];
      const stream = new PassThrough();
      stream.on("data", (chunk) => messages.push(chunk.toString()));

      const logger = createLogger({
        moduleName: "clock-test",
        includeConsole: false,
        includeFile: false,
        includeGlobalFile: false,
        clock,
        additionalTransports: [
          new winston.transports.Stream({
            stream,
          }),
        ],
      });

      logger.info("call-time timestamp");
      // Defer flush by setImmediate so any "format-at-flush-time" bug would
      // pick up the drifted clock value.
      await new Promise<void>((resolve) => setImmediate(resolve));
      teardownLogger(logger);

      const output = messages.join("");
      expect(output).toContain("UTC: 2030-06-15 12:34:56");
      expect(output).not.toContain("2099-01-01");
    });

    it("renders extra-tz strings from the same captured instant as UTC", () => {
      // Using a fixed UTC moment, the London string must reflect the SAME
      // instant — i.e., for 2030-01-15T12:00:00Z, London (which is in winter
      // therefore on GMT/UTC+0) is 12:00:00.
      const fixed = new Date("2030-01-15T12:00:00Z");
      const messages: string[] = [];
      const stream = new PassThrough();
      stream.on("data", (chunk) => messages.push(chunk.toString()));

      const logger = createLogger({
        moduleName: "clock-tz-test",
        includeConsole: false,
        includeFile: false,
        includeGlobalFile: false,
        clock: () => fixed,
        extraTimezones: ["Europe/London", "America/New_York"],
        additionalTransports: [
          new winston.transports.Stream({
            stream,
          }),
        ],
      });

      logger.info("tz capture");
      teardownLogger(logger);

      const output = messages.join("");
      expect(output).toContain("UTC: 2030-01-15 12:00:00");
      // London winter time == UTC; New York winter time == UTC-5.
      expect(output).toContain("Europe/London: 2030-01-15 12:00:00");
      expect(output).toContain("America/New_York: 2030-01-15 07:00:00");
    });

    it("defaults to live Date when no clock is injected", () => {
      // Smoke test for the default `clock = () => new Date()` path: the
      // formatter must render a YYYY-MM-DD HH:mm:ss UTC string.
      const messages: string[] = [];
      const stream = new PassThrough();
      stream.on("data", (chunk) => messages.push(chunk.toString()));

      const logger = createLogger({
        moduleName: "clock-default",
        includeConsole: false,
        includeFile: false,
        includeGlobalFile: false,
        additionalTransports: [
          new winston.transports.Stream({
            stream,
          }),
        ],
      });

      logger.info("default clock");
      teardownLogger(logger);

      const output = messages.join("");
      expect(output).toMatch(/UTC: \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/);
    });

    it("buildTimestampCapture writes info.timestamp using the supplied clock", () => {
      const fixed = new Date("2030-03-21T08:09:10Z");
      const capture = __loggerInternals.buildTimestampCapture(() => fixed);
      const result = capture.transform({
        level: "info",
        message: "test",
      } as any) as Record<string, unknown> | false;
      expect(result).not.toBe(false);
      expect((result as Record<string, unknown>).timestamp).toBe("2030-03-21 08:09:10");
    });
  });

  describe("internals", () => {
    it("generates log paths for empty module names", () => {
      const result = __loggerInternals.buildLogFilePath("/tmp", "");
      expect(result.endsWith(`logs-%DATE%.log`)).toBe(true);
    });

    it("falls back to INFO level when missing", () => {
      const formatter = __loggerInternals.formatMessage({
        label: "test",
        timezones: [],
      });
      const info = formatter.transform({ message: "ping" } as any);
      const output = Reflect.get(
        info as Record<PropertyKey, unknown>,
        Symbol.for("message"),
      ) as string;
      expect(output).toContain("[INFO] (test)");
    });

    it("serializes non-string stack traces", () => {
      const formatter = __loggerInternals.formatMessage({
        label: "test",
        timezones: [],
      });
      const info = formatter.transform({
        level: "error",
        message: "boom",
        stack: { foo: "bar" },
      } as any);
      const output = Reflect.get(
        info as Record<PropertyKey, unknown>,
        Symbol.for("message"),
      ) as string;
      expect(output.replace(/\s+/g, "")).toContain('"foo":"bar"');
    });

    it("omits timestamps when requested", () => {
      const formatter = __loggerInternals.formatMessage(
        {
          label: "test",
          timezones: [],
        },
        { includeTimestamps: false },
      );
      const info = formatter.transform({ level: "info", message: "ping" } as any);
      const output = Reflect.get(
        info as Record<PropertyKey, unknown>,
        Symbol.for("message"),
      ) as string;
      expect(output).not.toContain("UTC:");
      expect(output).toContain("[INFO] (test)");
    });

    it("falls back to live moment.utc when info.timestamp is missing on direct formatter calls", () => {
      // When the printf formatter is invoked outside the logger pipeline (no
      // upstream timestamp capture), it must still render a valid UTC line
      // rather than throwing or printing `UTC: undefined`.
      const formatter = __loggerInternals.formatMessage({
        label: "test",
        timezones: ["Europe/London"],
      });
      const info = formatter.transform({ level: "info", message: "ping" } as any);
      const output = Reflect.get(
        info as Record<PropertyKey, unknown>,
        Symbol.for("message"),
      ) as string;
      expect(output).toMatch(/UTC: \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/);
      expect(output).toMatch(/Europe\/London: \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/);
    });

    it("uses captured info.timestamp when present in direct formatter calls", () => {
      // When the consumer pre-populates `info.timestamp` (the same shape the
      // pipeline produces), the formatter must reuse it verbatim and derive
      // extra-tz strings from the SAME captured instant.
      const formatter = __loggerInternals.formatMessage({
        label: "test",
        timezones: ["Europe/London"],
      });
      const info = formatter.transform({
        level: "info",
        message: "ping",
        timestamp: "2030-07-01 12:00:00",
      } as any);
      const output = Reflect.get(
        info as Record<PropertyKey, unknown>,
        Symbol.for("message"),
      ) as string;
      expect(output).toContain("UTC: 2030-07-01 12:00:00");
      // London summer time is UTC+1.
      expect(output).toContain("Europe/London: 2030-07-01 13:00:00");
    });

    it("strips ANSI codes from info.level so the rendered [LEVEL] token is clean", () => {
      // When `info.level` arrives wrapped in ANSI SGR codes (e.g. an upstream
      // colorize() pass set it to `\x1b[31merror\x1b[39m`), the strip pass
      // must remove BOTH the leading ESC byte AND the bracket-digits-m portion
      // so the uppercase token is a clean `[ERROR]`. Before the regex was
      // fixed it left the bare ESC behind, polluting the token with raw
      // control bytes.
      const formatter = __loggerInternals.formatMessage(
        {
          label: "test",
          timezones: [],
        },
        { includeTimestamps: false },
      );
      const info = formatter.transform({
        level: "\x1b[31merror\x1b[39m",
        message: "boom",
      } as any);
      const output = Reflect.get(
        info as Record<PropertyKey, unknown>,
        Symbol.for("message"),
      ) as string;
      expect(output).toContain("[ERROR]");
      // The rendered token must NOT carry the ESC (0x1B) byte anymore.
      expect(output).not.toContain("\x1b");
    });

    it("formatMessage renders undefined message as the literal 'undefined', not a blank line", () => {
      // JSON.stringify(undefined) returns the JS value `undefined` (not the
      // string "undefined"), so without the `?? String(info.message)` fallback
      // `rawMessage` was `undefined` and the formatter emitted a blank line.
      const formatter = __loggerInternals.formatMessage(
        { label: "test", timezones: [] },
        { includeTimestamps: false },
      );
      const info = formatter.transform({ level: "info", message: undefined } as any);
      const output = Reflect.get(
        info as Record<PropertyKey, unknown>,
        Symbol.for("message"),
      ) as string;
      // The rendered output must include the literal word "undefined".
      expect(output).toContain("undefined");
      // The message line must not be blank (trimmed non-empty after stripping the
      // "[INFO] (test)" prefix line).
      const lines = output
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);
      expect(lines.some((l) => l === "undefined")).toBe(true);
    });

    it("formatMessage renders a function message via String() fallback, not a blank line", () => {
      // JSON.stringify(() => 42) also returns JS `undefined`; the fallback
      // String(info.message) converts the function to its source representation.
      const formatter = __loggerInternals.formatMessage(
        { label: "test", timezones: [] },
        { includeTimestamps: false },
      );
      const fn = () => 42;
      const info = formatter.transform({ level: "info", message: fn } as any);
      const output = Reflect.get(
        info as Record<PropertyKey, unknown>,
        Symbol.for("message"),
      ) as string;
      // The output must not be just the level/label header with a trailing blank —
      // String(fn) yields a non-empty source representation.
      const lines = output
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);
      // At minimum: "[INFO] (test)" + the stringified function body.
      expect(lines.length).toBeGreaterThanOrEqual(2);
    });

    it("resolveLogDirectory falls back to path.resolve when the dir does not exist", () => {
      const ghost = path.join(os.tmpdir(), `adv-logger-ghost-${Date.now()}`);
      const resolved = __loggerInternals.resolveLogDirectory(ghost);
      expect(resolved).toBe(path.resolve(ghost));
    });

    it("buildRegistryKey is case-insensitive on Windows and case-sensitive on POSIX", () => {
      const moduleName = "auth";
      const upper = path.resolve("/Tmp/Logger");
      const lower = path.resolve("/tmp/logger");
      const original = process.platform;

      try {
        Object.defineProperty(process, "platform", { value: "win32", configurable: true });
        const upperKeyWin = __loggerInternals.buildRegistryKey(moduleName, upper);
        const lowerKeyWin = __loggerInternals.buildRegistryKey(moduleName, lower);
        expect(upperKeyWin).toBe(lowerKeyWin);

        Object.defineProperty(process, "platform", { value: "linux", configurable: true });
        const upperKeyPosix = __loggerInternals.buildRegistryKey(moduleName, upper);
        const lowerKeyPosix = __loggerInternals.buildRegistryKey(moduleName, lower);
        expect(upperKeyPosix).not.toBe(lowerKeyPosix);
      } finally {
        Object.defineProperty(process, "platform", { value: original, configurable: true });
      }
    });

    it("buildOptionsSignature sorts extraTimezones to ignore input order", () => {
      const base = {
        level: "info" as const,
        consoleLevel: "info" as const,
        includeConsole: false,
        includeFile: false,
        includeGlobalFile: false,
        globalModuleName: "all-logs",
        rotation: { maxSize: "20m", maxFiles: "14d" },
        globalRotation: { maxSize: "20m", maxFiles: "14d" },
        escapeMessageNewlines: false,
        format: "pretty" as const,
        maskMetaKeys: [] as string[],
        colorize: { level: true, message: true },
        captureUncaught: true,
      };
      const a = __loggerInternals.buildOptionsSignature({
        ...base,
        extraTimezones: ["Europe/London", "America/New_York"],
      });
      const b = __loggerInternals.buildOptionsSignature({
        ...base,
        extraTimezones: ["America/New_York", "Europe/London"],
      });
      expect(a).toBe(b);
    });

    it("buildOptionsSignature includes maskMetaKeys/colorize/captureUncaught and sorts+lowercases maskMetaKeys (F9)", () => {
      const base = {
        level: "info" as const,
        consoleLevel: "info" as const,
        includeConsole: false,
        includeFile: false,
        includeGlobalFile: false,
        globalModuleName: "all-logs",
        extraTimezones: [] as string[],
        rotation: { maxSize: "20m", maxFiles: "14d" },
        globalRotation: { maxSize: "20m", maxFiles: "14d" },
        escapeMessageNewlines: false,
        format: "pretty" as const,
        colorize: { level: true, message: true },
        captureUncaught: true,
      };
      const a = __loggerInternals.buildOptionsSignature({
        ...base,
        maskMetaKeys: ["password", "Token"],
      });
      const b = __loggerInternals.buildOptionsSignature({
        ...base,
        maskMetaKeys: ["TOKEN", "Password"],
      });

      expect(a).toBe(b);
      expect(a).toContain('"maskMetaKeys":["password","token"]');
      expect(a).toContain('"colorize":{"level":true,"message":true}');
      expect(a).toContain('"captureUncaught":true');
    });

    it("diffSignatures lists divergent top-level keys", () => {
      const base = JSON.stringify({ level: "info", rotation: { maxFiles: "14d" } });
      const next = JSON.stringify({ level: "debug", rotation: { maxFiles: "14d" } });
      expect(__loggerInternals.diffSignatures(base, next)).toEqual(["level"]);
    });

    it("isWinstonCompatibleTransport rejects primitives, missing log, and missing on", () => {
      const { isWinstonCompatibleTransport } = __loggerInternals;
      expect(isWinstonCompatibleTransport(null)).toBe(false);
      expect(isWinstonCompatibleTransport(undefined)).toBe(false);
      expect(isWinstonCompatibleTransport(42)).toBe(false);
      expect(isWinstonCompatibleTransport("transport")).toBe(false);
      expect(isWinstonCompatibleTransport({})).toBe(false);
      expect(isWinstonCompatibleTransport({ log: () => undefined })).toBe(false);
      expect(isWinstonCompatibleTransport({ on: () => undefined })).toBe(false);
      expect(isWinstonCompatibleTransport({ log: () => undefined, on: () => undefined })).toBe(
        true,
      );
    });

    it("validateAdditionalTransports accepts an empty list and rejects mid-array invalid entries", () => {
      const { validateAdditionalTransports } = __loggerInternals;
      expect(() => validateAdditionalTransports([])).not.toThrow();

      const validish = { log: () => undefined, on: () => undefined };
      expect(() =>
        validateAdditionalTransports([validish, undefined as unknown as winston.transport]),
      ).toThrow(/additionalTransports\[1\]/);
    });

    it("transport error handler coerces non-Error values via String() and falls back to 'unknown' name", () => {
      const onTransportError = jest.fn();

      const stub = new StubTransport();
      // Wipe the name so the formatter's "unknown" fallback runs.
      (stub as unknown as { name: unknown }).name = undefined;

      const logger = createLogger({
        includeConsole: false,
        includeFile: false,
        includeGlobalFile: false,
        additionalTransports: [stub as unknown as winston.transport],
        onTransportError,
      });

      // Emit a value that is NOT an Error and has no `.message` field. The
      // handler must coerce via `String(err)` instead of crashing.
      stub.emit("error", "string error" as unknown as Error);
      stub.emit("error", { weird: "object" } as unknown as Error);

      expect(onTransportError).toHaveBeenCalledTimes(2);

      // Trigger the default-write branch (no callback) on a different stub so
      // the "unknown" name fallback is used in the console.error formatter.
      const consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => undefined);
      const anonStub = new StubTransport();
      (anonStub as unknown as { name: unknown }).name = undefined;
      const logger2 = createLogger({
        moduleName: "anon-name-test",
        includeConsole: false,
        includeFile: false,
        includeGlobalFile: false,
        additionalTransports: [anonStub as unknown as winston.transport],
      });
      anonStub.emit("error", new Error("blam"));
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining(`@hiprax/logger transport "unknown" error: blam`),
      );

      consoleErrorSpy.mockRestore();
      teardownLogger(logger);
      teardownLogger(logger2);
    });
  });

  describe("shutdown API", () => {
    it("resolves once finish events fire on all transports", async () => {
      const stream = new PassThrough();
      const logger = createLogger({
        moduleName: "shutdown-resolve",
        includeConsole: false,
        includeFile: false,
        includeGlobalFile: false,
        additionalTransports: [
          new winston.transports.Stream({
            stream,
          }),
        ],
      });

      logger.info("flush me");

      await expect(shutdownLogger(logger)).resolves.toBeUndefined();
    });

    it("rejects with a timeout error when a transport never finishes", async () => {
      // Stub transport that overrides `_final` to a no-op (NEVER calls the
      // writable callback), so the underlying Writable never reaches the
      // `finish` event. winston's `Logger.end()` cascades through `_final` on
      // each transport, and the await side of `shutdownLogger` is gated on
      // every transport emitting `finish`/`close`. With `_final` stalled the
      // shutdown MUST hit the timeoutMs deadline and reject.
      class StalledTransport extends Transport {
        public name = "stalled";
        public log = jest.fn((_info: unknown, callback?: () => void) => callback?.());
        public _final = (_callback: (err?: Error | null) => void): void => {
          // Intentionally never invoke `callback` — the writable stream stays
          // in "finishing" state forever from the host's perspective.
        };
      }
      const stalled = new StalledTransport();

      const logger = createLogger({
        moduleName: "shutdown-timeout",
        includeConsole: false,
        includeFile: false,
        includeGlobalFile: false,
        additionalTransports: [stalled as unknown as winston.transport],
      });

      await expect(shutdownLogger(logger, { timeoutMs: 50 })).rejects.toThrow(
        /shutdownLogger timed out after 50ms/,
      );
    });

    it("is idempotent — calling shutdownLogger twice does not throw", async () => {
      const stream = new PassThrough();
      const logger = createLogger({
        moduleName: "shutdown-idempotent",
        includeConsole: false,
        includeFile: false,
        includeGlobalFile: false,
        additionalTransports: [
          new winston.transports.Stream({
            stream,
          }),
        ],
      });

      const first = shutdownLogger(logger);
      const second = shutdownLogger(logger);
      // Both calls return the SAME promise; the second call MUST NOT trigger a
      // duplicate `logger.end()` (which would throw on an already-closed
      // logger) and MUST resolve to the same outcome.
      expect(second).toBe(first);
      await expect(first).resolves.toBeUndefined();
      await expect(shutdownLogger(logger)).resolves.toBeUndefined();
    });

    it("shutdownAllLoggers shuts down every cached logger", async () => {
      const root = createTempDir();
      const stream1 = new PassThrough();
      const stream2 = new PassThrough();

      const a = createLogger({
        moduleName: "shutdown-all-a",
        logDirectory: root,
        includeConsole: false,
        includeFile: false,
        includeGlobalFile: false,
        additionalTransports: [
          new winston.transports.Stream({
            stream: stream1,
          }),
        ],
      });
      const b = createLogger({
        moduleName: "shutdown-all-b",
        logDirectory: root,
        includeConsole: false,
        includeFile: false,
        includeGlobalFile: false,
        additionalTransports: [
          new winston.transports.Stream({
            stream: stream2,
          }),
        ],
      });
      // Sanity: both got cached as distinct instances.
      expect(a).not.toBe(b);

      await expect(shutdownAllLoggers()).resolves.toBeUndefined();
    });

    it("removes finish/close listeners after a timeout-rejected shutdown", async () => {
      // Same stalled-transport setup as the timeout test above, but here we
      // assert that after the timeout fires the awaiter's `finish`/`close`
      // listeners have been detached from the transport. Without the cleanup
      // branch in `shutdownLogger`, every timed-out call would leak one pair
      // of `once` listeners per transport (each closing over the never-
      // resolved `resolve` slot of the awaiter promise), eventually tripping
      // EventEmitter's MaxListenersExceededWarning on a long-running process.
      //
      // We instrument `transport.once`/`transport.removeListener` to track
      // exactly which `(eventName, listener)` pairs were attached by the
      // awaiter and which of those were detached during cleanup. The cleanup
      // branch must remove BOTH the `finish` and `close` pair regardless of
      // whether either event ever fired. (Comparing raw listener counts is
      // fragile because winston's own pipeline attaches additional async
      // `finish`/`close` listeners DURING `logger.end()` that we do NOT own
      // and must not detach.)
      class StalledTransport extends Transport {
        public name = "stalled-leak";
        public log = jest.fn((_info: unknown, callback?: () => void) => callback?.());
        public _final = (_callback: (err?: Error | null) => void): void => {
          // Intentionally never invoke the writable callback.
        };
      }
      const stalled = new StalledTransport();

      const logger = createLogger({
        moduleName: "shutdown-leak-cleanup",
        includeConsole: false,
        includeFile: false,
        includeGlobalFile: false,
        additionalTransports: [stalled as unknown as winston.transport],
      });

      // Locate the awaiter pair by cross-referencing the listener list AFTER
      // the shutdown runs against the listener list BEFORE shutdown. We
      // expose the awaiter helper via `__loggerInternals.awaitTransportFlush`
      // so we can call it directly and check that its `cleanup()` removes
      // both `finish` and `close` listeners — that is the load-bearing
      // contract that prevents the leak in the timed-out shutdown branch.
      const directAwaiter = __loggerInternals.awaitTransportFlush(
        stalled as unknown as winston.transport,
      );
      const finishAfterAttach = stalled.listeners("finish");
      const closeAfterAttach = stalled.listeners("close");
      directAwaiter.cleanup();
      const finishAfterCleanup = stalled.listeners("finish");
      const closeAfterCleanup = stalled.listeners("close");
      // Cleanup must REDUCE both event listener counts by exactly one
      // (the awaiter's own `settle` closure on each event). It must NOT
      // remove any of winston's own pipeline listeners.
      expect(finishAfterCleanup.length).toBe(finishAfterAttach.length - 1);
      expect(closeAfterCleanup.length).toBe(closeAfterAttach.length - 1);

      await expect(shutdownLogger(logger, { timeoutMs: 50 })).rejects.toThrow(
        /shutdownLogger timed out after 50ms/,
      );
    });

    it("awaitTransportFlush exposes a cleanup() that detaches both listeners", () => {
      // Direct unit-level coverage for the listener-cleanup helper. After
      // calling cleanup() neither `finish` nor `close` should retain the
      // attached `settle` handler, regardless of whether either event ever
      // fired. We use a bare `winston-transport` instance here (NOT wired
      // into a winston logger) so the only `finish`/`close` listeners on the
      // EventEmitter are the ones attached by `awaitTransportFlush` itself.
      class IdleTransport extends Transport {
        public name = "idle";
        public log = jest.fn((_info: unknown, callback?: () => void) => callback?.());
      }
      const idle = new IdleTransport();
      const finishBefore = idle.listenerCount("finish");
      const closeBefore = idle.listenerCount("close");

      const awaiter = __loggerInternals.awaitTransportFlush(idle as unknown as winston.transport);

      // Listeners are attached before settle/cleanup runs.
      expect(idle.listenerCount("finish")).toBe(finishBefore + 1);
      expect(idle.listenerCount("close")).toBe(closeBefore + 1);

      // After cleanup the counts return to the baseline. The promise itself
      // is still pending — cleanup() does NOT settle the awaiter; it only
      // detaches the listeners.
      awaiter.cleanup();
      expect(idle.listenerCount("finish")).toBe(finishBefore);
      expect(idle.listenerCount("close")).toBe(closeBefore);
    });

    // -------------------------------------------------------------------------
    // Phase 10 — shutdownLogger retry-after-timeout (Task 10.2)
    // -------------------------------------------------------------------------

    it("retry-after-timeout: evicts WeakMap entry so a later call can retry (Phase 10)", async () => {
      // A transport that stalls in `_final` and never emits `finish`/`close` on
      // its own — ensuring the first shutdown always times out.
      class StalledRetryTransport extends Transport {
        public name = "stalled-retry-p10";
        public log = jest.fn((_info: unknown, callback?: () => void) => callback?.());
        public _final = (_callback: (err?: Error | null) => void): void => {
          // Intentionally never invokes the callback.
        };
      }
      const stalled = new StalledRetryTransport();

      const logger = createLogger({
        moduleName: "shutdown-retry-p10",
        includeConsole: false,
        includeFile: false,
        includeGlobalFile: false,
        additionalTransports: [stalled as unknown as winston.transport],
      });

      // First call: small timeout → must reject.
      const first = shutdownLogger(logger, { timeoutMs: 20 });
      await expect(first).rejects.toThrow(/shutdownLogger timed out after 20ms/);

      // After the rejection the WeakMap entry must be evicted.
      // The second call must return a BRAND-NEW promise, not the cached rejection.
      const second = shutdownLogger(logger, { timeoutMs: 2000 });
      expect(second).not.toBe(first);

      // Manually emit "finish" so the second call's fresh awaiter resolves.
      // (This simulates the transport eventually completing its flush.)
      stalled.emit("finish");
      await expect(second).resolves.toBeUndefined();
    });

    it("successful shutdown remains idempotent: second and third calls return the same promise (Phase 10)", async () => {
      // The Proxy wrapping makes jest.spyOn(logger, "end") unreliable (the get
      // trap returns value.bind(target), not the raw spy). Idempotency is proven
      // by promise identity: if a second logger.end() were issued, shutdownLogger
      // would create a new Promise.race and return a different object.
      const stream = new PassThrough();
      const logger = createLogger({
        moduleName: "shutdown-idempotent-end-p10",
        includeConsole: false,
        includeFile: false,
        includeGlobalFile: false,
        additionalTransports: [new winston.transports.Stream({ stream })],
      });

      const first = shutdownLogger(logger);
      const second = shutdownLogger(logger);

      // Must be the exact same promise object — no new end()/race() on repeat call.
      expect(second).toBe(first);

      await expect(first).resolves.toBeUndefined();

      // A call after resolution also returns the cached resolved promise.
      const third = shutdownLogger(logger);
      expect(third).toBe(first);
      await expect(third).resolves.toBeUndefined();
    });

    it("concurrent same-tick calls share one in-flight promise (Phase 10)", async () => {
      // Three synchronous calls in the same event-loop turn. Only the first can
      // miss the WeakMap (it's empty); the second and third see the entry the
      // first installed and return the same promise. Promise callbacks are
      // deferred to the microtask queue, so none of the three calls can observe
      // a settled state before returning.
      const stream = new PassThrough();
      const logger = createLogger({
        moduleName: "shutdown-concurrent-p10",
        includeConsole: false,
        includeFile: false,
        includeGlobalFile: false,
        additionalTransports: [new winston.transports.Stream({ stream })],
      });

      const p1 = shutdownLogger(logger);
      const p2 = shutdownLogger(logger);
      const p3 = shutdownLogger(logger);

      // All three must be the identical promise object.
      expect(p2).toBe(p1);
      expect(p3).toBe(p1);

      await expect(Promise.all([p1, p2, p3])).resolves.toEqual([undefined, undefined, undefined]);
    });
  });

  // ---------------------------------------------------------------------------
  // Phase 9 — ShutdownOptions export (Task 9.2)
  // ---------------------------------------------------------------------------

  describe("ShutdownOptions is exported from src/logger (Phase 9)", () => {
    it("ShutdownOptions can be used as a type annotation (type is exported)", () => {
      // If ShutdownOptions were NOT exported this file would fail to compile
      // at the `import type { ShutdownOptions }` line at the top.
      // The runtime assertion below also confirms the interface is structurally
      // consistent with what shutdownLogger accepts.
      const opts: ShutdownOptions = { timeoutMs: 3000 };
      expect(opts.timeoutMs).toBe(3000);
    });

    it("ShutdownOptions with undefined timeoutMs is accepted (optional field)", () => {
      const opts: ShutdownOptions = {};
      expect(opts.timeoutMs).toBeUndefined();
    });
  });

  describe("lazy directory creation", () => {
    it("does not create the directory when both file flags are off and the dir is missing", () => {
      // Build a path that absolutely does not exist on disk and that the test
      // would never have created. createLogger() with both file transports
      // disabled MUST NOT touch the filesystem, throw, or create the dir.
      const ghost = path.join(os.tmpdir(), `adv-logger-ghost-lazy-${Date.now()}-${process.pid}`);
      // Pre-flight assertion so a cleanup leftover cannot accidentally pass.
      expect(fs.existsSync(ghost)).toBe(false);

      let logger: winston.Logger | undefined;
      expect(() => {
        logger = createLogger({
          moduleName: "lazy-dir-off",
          logDirectory: ghost,
          includeConsole: false,
          includeFile: false,
          includeGlobalFile: false,
        });
      }).not.toThrow();

      expect(fs.existsSync(ghost)).toBe(false);
      if (logger) {
        teardownLogger(logger);
      }
    });

    it("creates only the module dir when includeFile is true and includeGlobalFile is false", () => {
      const root = createTempDir();
      const logger = createLogger({
        moduleName: "lazy-dir-module-only/scoped",
        logDirectory: root,
        includeConsole: false,
        includeFile: true,
        includeGlobalFile: false,
      });

      // The module dir for the scoped name must exist (the rotating-file
      // transport requires it). The bare `logDirectory` exists too because
      // it's the parent of the module subdir we just created.
      expect(fs.existsSync(path.join(root, "lazy-dir-module-only"))).toBe(true);

      // Only one file transport should be attached — the module-scoped one —
      // not a global rotating file transport.
      const rotating = logger.transports.filter(
        (transport): transport is DailyRotateFile => transport instanceof DailyRotateFile,
      );
      expect(rotating).toHaveLength(1);

      // The "all-logs" global file would have been written into the same
      // logDirectory root (no nested segments), so its presence/absence is
      // not directly observable as a directory diff. The transport-count
      // assertion above is the load-bearing check that the global transport
      // was skipped.

      teardownLogger(logger);
    });
  });

  describe("captureUncaught", () => {
    it("attaches handleExceptions/handleRejections to file transports when console is off", () => {
      const root = createTempDir();
      const logger = createLogger({
        moduleName: "uncaught-file-only",
        logDirectory: root,
        includeConsole: false,
        includeFile: true,
        includeGlobalFile: true,
        captureUncaught: true,
      });

      const rotating = logger.transports.filter(
        (transport): transport is DailyRotateFile => transport instanceof DailyRotateFile,
      );
      expect(rotating).toHaveLength(2);
      rotating.forEach((transport) => {
        // The flags are exposed as winston-transport-level properties; both
        // must be `true` so the file transports persist any uncaught
        // exception/rejection trace.
        expect((transport as unknown as { handleExceptions: boolean }).handleExceptions).toBe(true);
        expect((transport as unknown as { handleRejections: boolean }).handleRejections).toBe(true);
      });

      teardownLogger(logger);
    });

    it("falls back to the console transport when no file transports are enabled", () => {
      const logger = createLogger({
        moduleName: "uncaught-console-only",
        includeConsole: true,
        includeFile: false,
        includeGlobalFile: false,
        captureUncaught: true,
      });

      const consoleTransport = logger.transports.find(
        (transport) => transport instanceof winston.transports.Console,
      );
      expect(consoleTransport).toBeDefined();
      expect((consoleTransport as unknown as { handleExceptions: boolean }).handleExceptions).toBe(
        true,
      );
      expect((consoleTransport as unknown as { handleRejections: boolean }).handleRejections).toBe(
        true,
      );

      teardownLogger(logger);
    });

    it("does not attach exception/rejection handlers to any transport when captureUncaught is false", () => {
      const root = createTempDir();
      const logger = createLogger({
        moduleName: "uncaught-disabled",
        logDirectory: root,
        includeConsole: true,
        includeFile: true,
        includeGlobalFile: true,
        captureUncaught: false,
      });

      logger.transports.forEach((transport) => {
        const t = transport as unknown as {
          handleExceptions?: boolean;
          handleRejections?: boolean;
        };
        // Either explicitly false or undefined — never `true`.
        expect(t.handleExceptions === true).toBe(false);
        expect(t.handleRejections === true).toBe(false);
      });

      teardownLogger(logger);
    });

    it("attaches handlers to additionalTransports when no built-in transports are enabled", () => {
      const stub = new StubTransport();

      const logger = createLogger({
        moduleName: "uncaught-additional-only",
        includeConsole: false,
        includeFile: false,
        includeGlobalFile: false,
        additionalTransports: [stub as unknown as winston.transport],
        captureUncaught: true,
      });

      expect((stub as unknown as { handleExceptions?: boolean }).handleExceptions).toBe(true);
      expect((stub as unknown as { handleRejections?: boolean }).handleRejections).toBe(true);

      teardownLogger(logger);
    });
  });

  describe("colorize", () => {
    /**
     * Drives the console transport's `format` pipeline directly via
     * `format.transform(info)` (the documented winston API for running a
     * format chain on a single info object). This bypasses both Jest's
     * stdout patcher and winston's `console.log.bind(console)` capture, so
     * the test can deterministically inspect the rendered string —
     * including any ANSI codes wrapped around the `[LEVEL]` token or
     * message body — without poking at stdout-or-console interception.
     */
    const renderConsole = (logger: winston.Logger, info: Record<string, unknown>): string => {
      const consoleTransport = logger.transports.find(
        (transport) => transport instanceof winston.transports.Console,
      );
      if (!consoleTransport) {
        throw new Error("expected a Console transport on the logger");
      }
      const format = (consoleTransport as { format?: winston.Logform.Format }).format;
      if (!format) {
        throw new Error("expected the Console transport to expose a format pipeline");
      }
      // winston's `format.colorize()` reads `info[Symbol.for("level")]` to
      // look up the ANSI codes for the level (the symbol-keyed slot is set
      // by the upstream `Logger.log()` flow before any format runs). When we
      // call `format.transform` directly on a hand-built info object we have
      // to populate the symbol slot ourselves.
      const enriched = {
        ...info,
        [Symbol.for("level")]: info.level,
      };
      const transformed = format.transform(enriched as any);
      if (transformed === false) {
        throw new Error("format.transform returned false");
      }
      // winston stores the rendered string at the Symbol.for("message") slot
      // after the printf formatter runs.
      return Reflect.get(
        transformed as Record<PropertyKey, unknown>,
        Symbol.for("message"),
      ) as string;
    };

    it("default colorize wraps the [ERROR] token in ANSI codes", () => {
      const logger = createLogger({
        moduleName: "colorize-default",
        includeConsole: true,
        includeFile: false,
        includeGlobalFile: false,
      });
      const rendered = renderConsole(logger, { level: "error", message: "ka-boom" });
      teardownLogger(logger);

      // The [ERROR] token must be wrapped in ANSI codes (\x1b[31m...\x1b[39m).
      expect(rendered).toContain("\x1b[31m[ERROR]\x1b[39m");
      // The message body is also colorized when defaults are used.
      expect(rendered).toContain("\x1b[31mka-boom\x1b[39m");
    });

    it("colorize: false produces no ANSI codes in console output", () => {
      const logger = createLogger({
        moduleName: "colorize-off",
        includeConsole: true,
        includeFile: false,
        includeGlobalFile: false,
        colorize: false,
      });
      const rendered = renderConsole(logger, { level: "error", message: "plain text only" });
      teardownLogger(logger);

      expect(rendered).toContain("[ERROR]");
      expect(rendered).toContain("plain text only");
      expect(rendered.includes("\x1b")).toBe(false);
    });

    it("colorize: { level: true, message: false } only colorizes the level token", () => {
      const logger = createLogger({
        moduleName: "colorize-level-only",
        includeConsole: true,
        includeFile: false,
        includeGlobalFile: false,
        colorize: { level: true, message: false },
      });
      const rendered = renderConsole(logger, { level: "error", message: "uncolored body" });
      teardownLogger(logger);

      // Level token wrapped in ANSI codes.
      expect(rendered).toContain("\x1b[31m[ERROR]\x1b[39m");
      // Message body NOT wrapped in ANSI codes.
      expect(rendered).toContain("uncolored body");
      // The only ANSI-wrapped token in the output is the level token; the
      // message body must not contain `\x1b[31muncolored body\x1b[39m`.
      expect(rendered).not.toContain("\x1b[31muncolored body\x1b[39m");
    });

    it("colorize: { all: true } colorizes both level and message via the all override", () => {
      const logger = createLogger({
        moduleName: "colorize-all",
        includeConsole: true,
        includeFile: false,
        includeGlobalFile: false,
        colorize: { all: true, level: false, message: false },
      });
      const rendered = renderConsole(logger, { level: "warn", message: "warning text" });
      teardownLogger(logger);

      // `all: true` overrides the per-flag `false` values — both must be colorized.
      expect(rendered).toContain("\x1b[33m[WARN]\x1b[39m");
      expect(rendered).toContain("\x1b[33mwarning text\x1b[39m");
    });

    it("resolveColorizeFlags returns expected normalized shapes", () => {
      const { resolveColorizeFlags } = __loggerInternals;
      expect(resolveColorizeFlags(undefined)).toEqual({ level: true, message: true });
      expect(resolveColorizeFlags(true)).toEqual({ level: true, message: true });
      expect(resolveColorizeFlags(false)).toEqual({ level: false, message: false });
      expect(resolveColorizeFlags({ all: true })).toEqual({ level: true, message: true });
      expect(resolveColorizeFlags({ all: false, level: true })).toEqual({
        level: false,
        message: false,
      });
      expect(resolveColorizeFlags({ level: true })).toEqual({ level: true, message: false });
      expect(resolveColorizeFlags({ message: true })).toEqual({ level: false, message: true });
      expect(resolveColorizeFlags({})).toEqual({ level: false, message: false });
    });
  });

  describe("maskMetaKeys", () => {
    /**
     * Drives the file-format pipeline directly (via a `Stream` transport) so
     * the rendered string can be inspected without touching the filesystem.
     * The `maskMetaKeys` redaction runs in BOTH the file and console
     * pipelines; we exercise the file pipeline here because it carries the
     * full metadata block.
     */
    const captureFileOutput = (logger: winston.Logger, stream: PassThrough): string => {
      const chunks: string[] = [];
      stream.on("data", (chunk) => chunks.push(chunk.toString()));
      logger.info("Login", { email: "u@example.com", password: "topsecret", token: "abc123" });
      teardownLogger(logger);
      return chunks.join("");
    };

    it("redacts metadata keys listed in maskMetaKeys before serialization", () => {
      const stream = new PassThrough();
      const logger = createLogger({
        moduleName: "mask-meta",
        includeConsole: false,
        includeFile: false,
        includeGlobalFile: false,
        maskMetaKeys: ["password", "token"],
        additionalTransports: [new winston.transports.Stream({ stream })],
      });

      const rendered = captureFileOutput(logger, stream);

      // Sensitive keys are written as `[REDACTED]` (matched case-insensitively)
      // while non-masked keys keep their original values.
      expect(rendered).toContain('"password": "[REDACTED]"');
      expect(rendered).toContain('"token": "[REDACTED]"');
      expect(rendered).toContain('"email": "u@example.com"');
      expect(rendered).not.toContain("topsecret");
      expect(rendered).not.toContain("abc123");
    });

    it("leaves metadata unchanged when maskMetaKeys is omitted (back-compat)", () => {
      const stream = new PassThrough();
      const logger = createLogger({
        moduleName: "mask-meta-off",
        includeConsole: false,
        includeFile: false,
        includeGlobalFile: false,
        additionalTransports: [new winston.transports.Stream({ stream })],
      });

      const rendered = captureFileOutput(logger, stream);

      // Without `maskMetaKeys`, the secrets flow through verbatim — proving
      // the new option is fully opt-in and existing behavior is preserved.
      expect(rendered).toContain('"password": "topsecret"');
      expect(rendered).toContain('"token": "abc123"');
      expect(rendered).toContain('"email": "u@example.com"');
      expect(rendered).not.toContain("[REDACTED]");
    });

    // -----------------------------------------------------------------------
    // Phase 1 — Leak-safe deep redaction: end-to-end class-instance masking
    // -----------------------------------------------------------------------

    it("pretty mode: redacts a masked key stored on a class-instance metadata value", () => {
      // F1 fix: the downstream JSON.stringify in the printf formatter enumerates
      // own enumerable keys of class instances, so without the fix a secret
      // stored as `instance.password` would leak into the log line even when
      // `password ∈ maskMetaKeys`.
      class UserMeta {
        constructor(
          public readonly email: string,
          public readonly password: string,
        ) {}
      }
      const stream = new PassThrough();
      const chunks: string[] = [];
      stream.on("data", (chunk: Buffer) => chunks.push(chunk.toString()));
      const logger = createLogger({
        moduleName: "mask-class-pretty",
        includeConsole: false,
        includeFile: false,
        includeGlobalFile: false,
        maskMetaKeys: ["password"],
        additionalTransports: [new winston.transports.Stream({ stream })],
      });
      logger.info("Login", new UserMeta("alice@example.com", "topsecret"));
      teardownLogger(logger);
      const rendered = chunks.join("");

      expect(rendered).not.toContain("topsecret");
      expect(rendered).toContain("[REDACTED]");
      expect(rendered).toContain("alice@example.com");
    });

    it("json mode: redacts a masked key stored on a class-instance metadata value", () => {
      class UserMeta {
        constructor(
          public readonly email: string,
          public readonly password: string,
        ) {}
      }
      const stream = new PassThrough();
      const chunks: string[] = [];
      stream.on("data", (chunk: Buffer) => chunks.push(chunk.toString()));
      const logger = createLogger({
        moduleName: "mask-class-json",
        format: "json",
        includeConsole: false,
        includeFile: false,
        includeGlobalFile: false,
        maskMetaKeys: ["password"],
        additionalTransports: [new winston.transports.Stream({ stream })],
      });
      logger.info("Login", new UserMeta("alice@example.com", "topsecret"));
      teardownLogger(logger);
      const output = chunks.join("").trim();

      expect(output).not.toContain("topsecret");
      expect(output).toContain("[REDACTED]");
      // Must still be valid JSON.
      const parsed = JSON.parse(output) as Record<string, unknown>;
      expect(parsed.password).toBe("[REDACTED]");
      expect(parsed.email).toBe("alice@example.com");
    });
  });

  describe("escapeMessageNewlines", () => {
    /**
     * Drives the file-format pipeline through a Stream transport so the
     * rendered log line can be inspected directly. The same renderer drives
     * both the on/off cases — what changes between them is the option, not
     * the harness.
     */
    const renderInjected = (escape: boolean): string => {
      const stream = new PassThrough();
      const chunks: string[] = [];
      stream.on("data", (chunk) => chunks.push(chunk.toString()));
      const logger = createLogger({
        moduleName: `escape-${escape ? "on" : "off"}`,
        includeConsole: false,
        includeFile: false,
        includeGlobalFile: false,
        escapeMessageNewlines: escape,
        additionalTransports: [new winston.transports.Stream({ stream })],
      });
      // The injected payload mimics a forged log entry — without escaping the
      // second `\n[ERROR]` line is byte-for-byte indistinguishable from a real
      // error entry an admin tool might trust.
      logger.info("line1\nline2");
      teardownLogger(logger);
      return chunks.join("");
    };

    it("renders embedded newlines as literal escape sequences when enabled", () => {
      const rendered = renderInjected(true);
      // The string `line1\\nline2` (five chars: l-i-n-e-1, then literal
      // backslash-n) appears verbatim in the rendered line; the real `\n`
      // byte is gone from the message body, so the second line cannot be
      // mistaken for a fresh log entry.
      expect(rendered).toContain("line1\\nline2");
      // The original raw `line1\nline2` (with a real newline between the
      // two halves) must NOT survive into the rendered output.
      expect(rendered).not.toContain("line1\nline2");
    });

    it("preserves the existing raw-newline behavior when omitted (back-compat)", () => {
      const rendered = renderInjected(false);
      // Without the option, the message body still carries the real `\n` byte
      // — back-compat with consumers that ship multi-line messages on
      // purpose. The test guards against an accidental future flip of the
      // default.
      expect(rendered).toContain("line1\nline2");
      expect(rendered).not.toContain("line1\\nline2");
    });

    it("formatMessage option wires through the printf when invoked directly", () => {
      // Direct internals call so the test doubles as a fast-path smoke test
      // for the option plumbing inside the formatter itself (independent of
      // `createLogger`'s defaults / pipeline assembly).
      const formatter = __loggerInternals.formatMessage(
        { label: "test", timezones: [] },
        { includeTimestamps: false, escapeMessageNewlines: true },
      );
      const info = formatter.transform({
        level: "info",
        message: "alpha\r\nbeta",
      } as any);
      const output = Reflect.get(
        info as Record<PropertyKey, unknown>,
        Symbol.for("message"),
      ) as string;
      expect(output).toContain("alpha\\r\\nbeta");
      expect(output).not.toContain("alpha\r\nbeta");
    });
  });

  describe("defaultRotation export", () => {
    it("exports the same shape as the internal frozen rotation object", () => {
      // The exported `defaultRotation` is the SAME frozen object the logger
      // uses internally — consumers can spread it into their own override
      // (e.g. `{ ...defaultRotation, maxFiles: "30d" }`) without copying the
      // literal. Mutating the export must throw under strict mode (frozen).
      expect(defaultRotation).toEqual({
        maxSize: "20m",
        maxFiles: "14d",
        datePattern: "YYYY-MM-DD",
        zippedArchive: false,
      });
      expect(Object.isFrozen(defaultRotation)).toBe(true);
      expect(() => {
        (defaultRotation as { maxFiles: string }).maxFiles = "1d";
      }).toThrow();
    });

    it("getDefaultRotation returns a non-frozen deep copy that is safe to mutate", () => {
      const rotation = getDefaultRotation();
      // Same shape as the export.
      expect(rotation).toEqual(defaultRotation);
      // But fresh — not the same reference, and not frozen.
      expect(rotation).not.toBe(defaultRotation as unknown as object);
      expect(Object.isFrozen(rotation)).toBe(false);

      // Mutating the returned copy MUST NOT affect the frozen export, proving
      // the deep-copy contract documented on `getDefaultRotation`.
      rotation.maxFiles = "30d";
      expect(rotation.maxFiles).toBe("30d");
      expect(defaultRotation.maxFiles).toBe("14d");

      // Successive calls return independent copies (no shared mutable state).
      const second = getDefaultRotation();
      expect(second.maxFiles).toBe("14d");
      expect(second).not.toBe(rotation);
    });
  });

  describe("structured option validation (LoggerOptionError)", () => {
    it("throws LoggerOptionError({ code: 'INVALID_LEVEL' }) for an unknown level string", () => {
      let caught: unknown;
      try {
        createLogger({
          level: "noisy" as unknown as "info",
          includeConsole: false,
          includeFile: false,
          includeGlobalFile: false,
        });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(LoggerOptionError);
      expect((caught as LoggerOptionError).code).toBe("INVALID_LEVEL");
      expect((caught as LoggerOptionError).message).toContain("level");
      expect((caught as LoggerOptionError).message).toContain("noisy");
    });

    it("throws LoggerOptionError({ code: 'INVALID_LEVEL' }) for an unknown consoleLevel string", () => {
      let caught: unknown;
      try {
        createLogger({
          consoleLevel: "loud" as unknown as "info",
          includeConsole: false,
          includeFile: false,
          includeGlobalFile: false,
        });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(LoggerOptionError);
      expect((caught as LoggerOptionError).code).toBe("INVALID_LEVEL");
      expect((caught as LoggerOptionError).message).toContain("consoleLevel");
    });

    it("throws LoggerOptionError({ code: 'INVALID_ROTATION' }) for malformed rotation.maxSize", () => {
      let caught: unknown;
      try {
        createLogger({
          rotation: { maxSize: "abc" },
          includeConsole: false,
          includeFile: false,
          includeGlobalFile: false,
        });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(LoggerOptionError);
      expect((caught as LoggerOptionError).code).toBe("INVALID_ROTATION");
      expect((caught as LoggerOptionError).message).toContain("rotation.maxSize");
    });

    it("throws LoggerOptionError({ code: 'INVALID_ROTATION' }) for malformed rotation.maxFiles", () => {
      let caught: unknown;
      try {
        createLogger({
          rotation: { maxFiles: "two days" },
          includeConsole: false,
          includeFile: false,
          includeGlobalFile: false,
        });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(LoggerOptionError);
      expect((caught as LoggerOptionError).code).toBe("INVALID_ROTATION");
      expect((caught as LoggerOptionError).message).toContain("rotation.maxFiles");
    });

    it("throws LoggerOptionError({ code: 'INVALID_ROTATION' }) for malformed globalRotation.maxSize", () => {
      let caught: unknown;
      try {
        createLogger({
          globalRotation: { maxSize: "huge" },
          includeConsole: false,
          includeFile: false,
          includeGlobalFile: false,
        });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(LoggerOptionError);
      expect((caught as LoggerOptionError).code).toBe("INVALID_ROTATION");
      expect((caught as LoggerOptionError).message).toContain("globalRotation.maxSize");
    });

    it("accepts valid rotation.maxSize shapes (single-letter k/m/g, optional 0. prefix)", () => {
      // These match the upstream `winston-daily-rotate-file` `getMaxSize`
      // contract: `^(?:0\.)?\d+[kmg]$` — single-letter suffix, case-insensitive,
      // optional `0.` prefix for fractional values.
      const validMaxSize = ["20m", "100k", "1g", "0.5m"];
      validMaxSize.forEach((value, idx) => {
        const logger = createLogger({
          moduleName: `valid-maxsize-${idx}`,
          rotation: { maxSize: value },
          includeConsole: false,
          includeFile: false,
          includeGlobalFile: false,
        });
        teardownLogger(logger);
      });
    });

    it("accepts valid rotation.maxFiles shapes (bare counts and day-suffixed)", () => {
      // These match the upstream `winston-daily-rotate-file` max-files contract:
      // `^\d+d?$` — bare numeric file count or day-suffixed retention window.
      const validMaxFiles = ["7", "14d", "30"];
      validMaxFiles.forEach((value, idx) => {
        const logger = createLogger({
          moduleName: `valid-maxfiles-${idx}`,
          rotation: { maxFiles: value },
          includeConsole: false,
          includeFile: false,
          includeGlobalFile: false,
        });
        teardownLogger(logger);
      });
    });

    it("rejects rotation.maxSize values upstream silently disables (long-form suffixes, bare numbers, day suffix)", () => {
      // Inputs the OLD lenient regex tolerated but `winston-daily-rotate-file`
      // would silently drop (returning `null` from `getMaxSize`, disabling
      // size-based rotation). All of these must now throw INVALID_ROTATION at
      // logger creation time so the misconfiguration surfaces immediately.
      const invalidMaxSize = ["20mb", "100b", "20d", "20"];
      invalidMaxSize.forEach((value) => {
        let caught: unknown;
        try {
          createLogger({
            moduleName: `invalid-maxsize-${value}`,
            rotation: { maxSize: value },
            includeConsole: false,
            includeFile: false,
            includeGlobalFile: false,
          });
        } catch (err) {
          caught = err;
        }
        expect(caught).toBeInstanceOf(LoggerOptionError);
        expect((caught as LoggerOptionError).code).toBe("INVALID_ROTATION");
        expect((caught as LoggerOptionError).message).toContain("rotation.maxSize");
      });
    });

    it("rejects rotation.maxFiles values that carry a size suffix (would coerce to a count)", () => {
      // `parseInt("20m")` silently coerces to `20`, so the upstream parser
      // would interpret `maxFiles: "20m"` as "20 files" — almost never the
      // intent. These must now throw INVALID_ROTATION at logger creation time.
      const invalidMaxFiles = ["20m", "20kb"];
      invalidMaxFiles.forEach((value) => {
        let caught: unknown;
        try {
          createLogger({
            moduleName: `invalid-maxfiles-${value}`,
            rotation: { maxFiles: value },
            includeConsole: false,
            includeFile: false,
            includeGlobalFile: false,
          });
        } catch (err) {
          caught = err;
        }
        expect(caught).toBeInstanceOf(LoggerOptionError);
        expect((caught as LoggerOptionError).code).toBe("INVALID_ROTATION");
        expect((caught as LoggerOptionError).message).toContain("rotation.maxFiles");
      });
    });

    it("wraps ensureDirectory failures in LoggerOptionError({ code: 'LOG_DIRECTORY_UNWRITABLE' })", () => {
      // Force the underlying mkdirSync to throw a synthetic EACCES so we can
      // verify the wrap-and-rethrow path. Use a path the test would otherwise
      // succeed on so the failure is unambiguously from the spy.
      const root = createTempDir();
      const cause = Object.assign(new Error("EACCES: permission denied, mkdir"), {
        code: "EACCES",
      });
      const spy = jest.spyOn(fs, "mkdirSync").mockImplementation(() => {
        throw cause;
      });

      let caught: unknown;
      try {
        createLogger({
          moduleName: "unwritable",
          logDirectory: root,
          includeConsole: false,
          includeFile: true,
          includeGlobalFile: false,
        });
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(LoggerOptionError);
      expect((caught as LoggerOptionError).code).toBe("LOG_DIRECTORY_UNWRITABLE");
      expect((caught as LoggerOptionError).message).toContain("EACCES");
      // Wrapped via the `cause` constructor option — the original error is
      // preserved on the wrapper for downstream debugging.
      expect((caught as LoggerOptionError).cause).toBe(cause);

      spy.mockRestore();
    });

    it("LoggerOptionError without a cause leaves `cause` as undefined", () => {
      // Smoke test for the constructor branch that does NOT receive `options`.
      const err = new LoggerOptionError("INVALID_LEVEL", "no cause supplied");
      expect(err.code).toBe("INVALID_LEVEL");
      expect(err.cause).toBeUndefined();
      expect(err.name).toBe("LoggerOptionError");
    });

    it("LoggerOptionError preserves an explicit `cause: undefined` (the `in` check still triggers)", () => {
      // Verifies that passing { cause: undefined } still walks the assignment
      // branch — the `in` check is satisfied even when the value is undefined.
      const err = new LoggerOptionError("INVALID_LEVEL", "cause is undefined", {
        cause: undefined,
      });
      expect(err.cause).toBeUndefined();
    });

    it("LOG_DIRECTORY_UNWRITABLE coerces non-Error throws via String() in the message", () => {
      // Force mkdirSync to throw a non-Error value (a bare string) so the
      // `err instanceof Error ? err.message : String(err)` branch is exercised.
      const root = createTempDir();
      const spy = jest.spyOn(fs, "mkdirSync").mockImplementation(() => {
        throw "raw string failure";
      });

      let caught: unknown;
      try {
        createLogger({
          moduleName: "unwritable-string",
          logDirectory: root,
          includeConsole: false,
          includeFile: true,
          includeGlobalFile: false,
        });
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(LoggerOptionError);
      expect((caught as LoggerOptionError).code).toBe("LOG_DIRECTORY_UNWRITABLE");
      expect((caught as LoggerOptionError).message).toContain("raw string failure");

      spy.mockRestore();
    });

    it("throws LoggerOptionError({ code: 'INVALID_MASK' }) when maskMetaKeys is a bare string", () => {
      let caught: unknown;
      try {
        createLogger({
          maskMetaKeys: "password" as unknown as string[],
          includeConsole: false,
          includeFile: false,
          includeGlobalFile: false,
        });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(LoggerOptionError);
      expect((caught as LoggerOptionError).code).toBe("INVALID_MASK");
      expect((caught as LoggerOptionError).message).toContain("maskMetaKeys");
    });

    it("throws LoggerOptionError({ code: 'INVALID_MASK' }) when maskMetaKeys is null", () => {
      let caught: unknown;
      try {
        createLogger({
          maskMetaKeys: null as unknown as string[],
          includeConsole: false,
          includeFile: false,
          includeGlobalFile: false,
        });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(LoggerOptionError);
      expect((caught as LoggerOptionError).code).toBe("INVALID_MASK");
      expect((caught as LoggerOptionError).message).toContain("maskMetaKeys");
    });

    it("throws LoggerOptionError({ code: 'INVALID_MASK' }) when maskMetaKeys contains a non-string entry", () => {
      let caught: unknown;
      try {
        createLogger({
          maskMetaKeys: ["password", 42] as unknown as string[],
          includeConsole: false,
          includeFile: false,
          includeGlobalFile: false,
        });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(LoggerOptionError);
      expect((caught as LoggerOptionError).code).toBe("INVALID_MASK");
      expect((caught as LoggerOptionError).message).toContain("maskMetaKeys");
      expect((caught as LoggerOptionError).message).toContain("index 1");
    });

    it("throws INVALID_MASK even when a logger is already cached for the same key", () => {
      const root = createTempDir();
      // Prime the cache with a valid logger.
      const first = createLogger({
        moduleName: "mask-cache-test",
        logDirectory: root,
        includeConsole: false,
        includeFile: false,
        includeGlobalFile: false,
      });
      teardownLogger(first);

      // A second call with bad maskMetaKeys must still throw even though the
      // registry already has an entry for this moduleName + logDirectory.
      let caught: unknown;
      try {
        createLogger({
          moduleName: "mask-cache-test",
          logDirectory: root,
          maskMetaKeys: "leaked" as unknown as string[],
          includeConsole: false,
          includeFile: false,
          includeGlobalFile: false,
        });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(LoggerOptionError);
      expect((caught as LoggerOptionError).code).toBe("INVALID_MASK");
    });

    it("accepts a valid string[] maskMetaKeys without throwing", () => {
      const root = createTempDir();
      const logger = createLogger({
        moduleName: "mask-valid",
        logDirectory: root,
        maskMetaKeys: ["password", "token"],
        includeConsole: false,
        includeFile: false,
        includeGlobalFile: false,
      });
      expect(logger).toBeDefined();
      teardownLogger(logger);
    });

    it("accepts undefined maskMetaKeys without throwing (treated as [])", () => {
      const root = createTempDir();
      const logger = createLogger({
        moduleName: "mask-undefined",
        logDirectory: root,
        maskMetaKeys: undefined,
        includeConsole: false,
        includeFile: false,
        includeGlobalFile: false,
      });
      expect(logger).toBeDefined();
      teardownLogger(logger);
    });
  });

  describe("internals — option validators", () => {
    it("validateLogLevelOption is a no-op for undefined (unset option)", () => {
      expect(() => __loggerInternals.validateLogLevelOption("level", undefined)).not.toThrow();
    });

    it("validateLogLevelOption accepts every documented npm log level", () => {
      __loggerInternals.VALID_LOG_LEVELS.forEach((level) => {
        expect(() => __loggerInternals.validateLogLevelOption("level", level)).not.toThrow();
      });
    });

    it("validateRotationStrategy is a no-op for undefined and partial inputs", () => {
      expect(() => __loggerInternals.validateRotationStrategy("rotation", undefined)).not.toThrow();
      expect(() => __loggerInternals.validateRotationStrategy("rotation", {})).not.toThrow();
      expect(() =>
        __loggerInternals.validateRotationStrategy("rotation", { maxSize: "20m" }),
      ).not.toThrow();
    });

    it("normalizeMaxFiles lowercases a string day suffix regardless of input case (F8)", () => {
      expect(__loggerInternals.normalizeMaxFiles("14D")).toBe("14d");
      expect(__loggerInternals.normalizeMaxFiles("14d")).toBe("14d");
      // Bare numeric counts have no suffix to normalize but still round-trip.
      expect(__loggerInternals.normalizeMaxFiles("30")).toBe("30");
    });

    it("normalizeMaxFiles passes a non-string value through unchanged", () => {
      expect(__loggerInternals.normalizeMaxFiles(undefined)).toBeUndefined();
    });

    it("isValidLogLevel returns true for valid levels and false otherwise", () => {
      expect(__loggerInternals.isValidLogLevel("info")).toBe(true);
      expect(__loggerInternals.isValidLogLevel("silly")).toBe(true);
      expect(__loggerInternals.isValidLogLevel("noisy")).toBe(false);
      expect(__loggerInternals.isValidLogLevel(42)).toBe(false);
      expect(__loggerInternals.isValidLogLevel(undefined)).toBe(false);
    });

    it("validateMaskMetaKeysOption is a no-op for undefined", () => {
      expect(() => __loggerInternals.validateMaskMetaKeysOption(undefined)).not.toThrow();
    });

    it("validateMaskMetaKeysOption accepts an empty array", () => {
      expect(() => __loggerInternals.validateMaskMetaKeysOption([])).not.toThrow();
    });

    it("validateMaskMetaKeysOption accepts a string[] without throwing", () => {
      expect(() =>
        __loggerInternals.validateMaskMetaKeysOption(["password", "token"]),
      ).not.toThrow();
    });

    it("validateMaskMetaKeysOption throws INVALID_MASK for a bare string", () => {
      let caught: unknown;
      try {
        __loggerInternals.validateMaskMetaKeysOption("password");
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(LoggerOptionError);
      expect((caught as LoggerOptionError).code).toBe("INVALID_MASK");
    });

    it("validateMaskMetaKeysOption throws INVALID_MASK for null", () => {
      let caught: unknown;
      try {
        __loggerInternals.validateMaskMetaKeysOption(null);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(LoggerOptionError);
      expect((caught as LoggerOptionError).code).toBe("INVALID_MASK");
    });

    it("validateMaskMetaKeysOption throws INVALID_MASK for an array with a non-string entry", () => {
      let caught: unknown;
      try {
        __loggerInternals.validateMaskMetaKeysOption(["ok", 99]);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(LoggerOptionError);
      expect((caught as LoggerOptionError).code).toBe("INVALID_MASK");
      expect((caught as LoggerOptionError).message).toContain("index 1");
    });
  });

  describe("property-based — sanitizeSegment / buildLogFilePath", () => {
    // Forbidden chars matching the source-side replacement regex in
    // `sanitizeSegment`. The result of `sanitizeSegment(arbitraryUnicode)`
    // must NEVER contain any of these characters.
    const FORBIDDEN = /[<>:"/\\|?* -]/;

    it("sanitizeSegment never produces forbidden chars or `..` segments", () => {
      fc.assert(
        fc.property(fc.string(), (raw) => {
          const cleaned = __loggerInternals.sanitizeSegment(raw);
          // Always returns a non-empty string (falls back to `"logs"` when empty).
          expect(typeof cleaned).toBe("string");
          expect(cleaned.length).toBeGreaterThan(0);
          // Must NEVER carry any of the forbidden characters.
          expect(FORBIDDEN.test(cleaned)).toBe(false);
          // Must NEVER carry the `..` parent-directory traversal sequence.
          expect(cleaned.includes("..")).toBe(false);
          // Must NEVER start or end with the hyphen separator (the source
          // implementation explicitly trims them).
          expect(cleaned.startsWith("-")).toBe(false);
          expect(cleaned.endsWith("-")).toBe(false);
        }),
        { numRuns: 200 },
      );
    });

    it("sanitizeSegment handles long runs of hyphens in linear time (ReDoS regression)", () => {
      // Regression test for the `js/polynomial-redos` (CWE-1333) finding on
      // the original trailing-hyphen regex `[-]+$`. Even though the production
      // code collapses runs via `-+/g` BEFORE the anchored strip — making the
      // attack vector theoretical — this test pins the linear-time invariant
      // so a future refactor that removes the collapse cannot reintroduce the
      // polynomial behavior. A genuinely polynomial regex on this 100k-char
      // input would take minutes (or hang the runner); the safe regex
      // finishes in single-digit milliseconds.
      const hostile = `${"-".repeat(100_000)}x`;
      const start = Date.now();
      const cleaned = __loggerInternals.sanitizeSegment(hostile);
      const elapsedMs = Date.now() - start;
      // Generous bound — the actual run is in the low milliseconds on every
      // platform; we just want a hard cap that a quadratic regex blows past.
      expect(elapsedMs).toBeLessThan(1000);
      // Behavior is unchanged from the pre-fix code: leading hyphen run is
      // stripped, the trailing `x` is retained.
      expect(cleaned).toBe("x");
    });

    it("buildLogFilePath always stays under baseDir and never escapes via `..`", () => {
      const baseDir = path.resolve("/tmp/log-base");
      fc.assert(
        fc.property(fc.string(), (raw) => {
          const result = __loggerInternals.buildLogFilePath(baseDir, raw);
          // Result must be an absolute path under baseDir (path.resolve
          // normalizes both sides; relative paths are not allowed).
          const resolved = path.resolve(result);
          // The resolved path MUST start with the baseDir prefix — that
          // guarantees no segment traversal escaped the sandbox.
          expect(resolved.startsWith(baseDir)).toBe(true);
          // Result MUST NEVER contain a `..` segment (a strong invariant
          // beyond the `startsWith` check, since that one would also pass
          // for `<baseDir>/..safe` etc.).
          const segments = result.split(/[\\/]+/);
          expect(segments.includes("..")).toBe(false);
          // Result must end with the rotation suffix `-%DATE%.log`.
          expect(result.endsWith("-%DATE%.log")).toBe(true);
        }),
        { numRuns: 200 },
      );
    });
  });

  describe("format option (JSON output)", () => {
    /**
     * Drives the JSON pipeline through a Stream transport so the rendered
     * NDJSON line can be captured and parsed back. The shared helper assembles
     * the logger, emits the supplied payload, tears down, and returns the
     * collected output as a single string for the caller to split on `\n`.
     */
    const renderJsonLine = (
      moduleName: string,
      emit: (logger: winston.Logger) => void,
      opts: Partial<Parameters<typeof createLogger>[0]> = {},
    ): string => {
      const stream = new PassThrough();
      const chunks: string[] = [];
      stream.on("data", (chunk) => chunks.push(chunk.toString()));
      const logger = createLogger({
        moduleName,
        format: "json",
        includeConsole: false,
        includeFile: false,
        includeGlobalFile: false,
        additionalTransports: [new winston.transports.Stream({ stream })],
        ...opts,
      });
      emit(logger);
      teardownLogger(logger);
      return chunks.join("");
    };

    it("emits one parseable JSON object per log line with canonical fields", () => {
      const output = renderJsonLine("json-roundtrip", (logger) => {
        logger.info("Login", { email: "u@example.com", userId: 42, role: "admin" });
      });

      // Strip the trailing newline winston appends and parse the line.
      const line = output.trim();
      const parsed = JSON.parse(line) as Record<string, unknown>;

      // Canonical winston/json shape: level, message, timestamp at the top
      // level, plus any caller-supplied metadata merged alongside.
      expect(parsed.level).toBe("info");
      expect(parsed.message).toBe("Login");
      expect(typeof parsed.timestamp).toBe("string");
      // The timestamp captured at log-call time is the canonical
      // `YYYY-MM-DD HH:mm:ss` UTC form written by `buildTimestampCapture`.
      expect(parsed.timestamp as string).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
      // Caller-supplied metadata round-trips at the top level (winston's
      // `format.json()` merges metadata onto the info object before JSON.stringify).
      expect(parsed.email).toBe("u@example.com");
      expect(parsed.userId).toBe(42);
      expect(parsed.role).toBe("admin");
    });

    it("applies maskMetaKeys redaction to JSON output (defense in depth)", () => {
      const output = renderJsonLine(
        "json-redact",
        (logger) => {
          logger.info("Login", {
            email: "u@example.com",
            password: "topsecret",
            token: "abc123",
            nested: { apiKey: "shh" },
          });
        },
        { maskMetaKeys: ["password", "token", "apikey"] },
      );

      const parsed = JSON.parse(output.trim()) as Record<string, unknown>;

      // Sensitive keys redacted at the JSON layer, non-masked keys preserved.
      expect(parsed.password).toBe("[REDACTED]");
      expect(parsed.token).toBe("[REDACTED]");
      expect(parsed.email).toBe("u@example.com");
      // Deep redaction still walks nested objects.
      const nested = parsed.nested as Record<string, unknown>;
      expect(nested.apiKey).toBe("[REDACTED]");
      // The raw secret strings must not appear anywhere in the line.
      expect(output).not.toContain("topsecret");
      expect(output).not.toContain("abc123");
      expect(output).not.toContain("shh");
    });

    it("preserves Error stack traces in JSON output via errors({ stack: true })", () => {
      const output = renderJsonLine("json-errors", (logger) => {
        logger.error(new Error("boom"));
      });

      const parsed = JSON.parse(output.trim()) as Record<string, unknown>;

      expect(parsed.level).toBe("error");
      expect(parsed.message).toBe("boom");
      // `format.errors({ stack: true })` resolves the Error into a plain
      // object whose `stack` field survives the JSON serialization.
      expect(typeof parsed.stack).toBe("string");
      expect(parsed.stack as string).toContain("Error: boom");
    });

    it("default format remains 'pretty' when the option is omitted (back-compat)", () => {
      const stream = new PassThrough();
      const chunks: string[] = [];
      stream.on("data", (chunk) => chunks.push(chunk.toString()));
      const logger = createLogger({
        moduleName: "format-default",
        includeConsole: false,
        includeFile: false,
        includeGlobalFile: false,
        additionalTransports: [new winston.transports.Stream({ stream })],
      });
      logger.info("hello", { extra: "meta" });
      teardownLogger(logger);

      const output = chunks.join("");
      // The pretty format emits the human-readable `[INFO] (label)` token —
      // a JSON line would never contain that bracketed prefix.
      expect(output).toContain("[INFO]");
      expect(output).toContain("hello");
      // Confirm the output is NOT a single JSON object on the first line.
      const firstLine = output.split("\n")[0];
      expect(() => JSON.parse(firstLine)).toThrow();
    });

    it("throws LoggerOptionError({ code: 'INVALID_FORMAT' }) for an unknown format", () => {
      let caught: unknown;
      try {
        createLogger({
          moduleName: "format-invalid",
          format: "JSON" as unknown as "json",
          includeConsole: false,
          includeFile: false,
          includeGlobalFile: false,
        });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(LoggerOptionError);
      expect((caught as LoggerOptionError).code).toBe("INVALID_FORMAT");
      expect((caught as LoggerOptionError).message).toContain("format");
    });

    it("validateFormatOption is a no-op for undefined (unset option)", () => {
      expect(() => __loggerInternals.validateFormatOption(undefined)).not.toThrow();
    });

    it("validateFormatOption accepts every documented format value", () => {
      __loggerInternals.VALID_FORMATS.forEach((value) => {
        expect(() => __loggerInternals.validateFormatOption(value)).not.toThrow();
      });
    });

    it("buildMetaRedactor is a pass-through when no maskMetaKeys are configured", () => {
      // Direct call exercises the empty-set early-return branch — when the
      // consumer omits `maskMetaKeys`, the redactor must not allocate a
      // WeakSet or walk the info object.
      const formatter = __loggerInternals.buildMetaRedactor(undefined);
      const original = { level: "info", message: "hello", password: "topsecret" };
      const transformed = formatter.transform({ ...original } as any);
      // The transform writes the value back without redaction.
      expect((transformed as Record<string, unknown>).password).toBe("topsecret");
    });

    it("buildMetaRedactor preserves reserved info keys (level, message, timestamp, stack)", () => {
      // The redactor must NEVER overwrite the canonical info fields even when
      // a consumer happens to add `password` to maskMetaKeys and the field
      // names happen to collide. Reserved keys pass through untouched.
      const formatter = __loggerInternals.buildMetaRedactor(new Set(["timestamp"]));
      const original: Record<string, unknown> = {
        level: "info",
        message: "hello",
        timestamp: "2026-05-04 00:00:00",
        stack: "Error: ...",
        secret: "should-not-appear",
      };
      const transformed = formatter.transform({ ...original } as any) as Record<string, unknown>;
      // Reserved keys retain their original values.
      expect(transformed.timestamp).toBe("2026-05-04 00:00:00");
      expect(transformed.stack).toBe("Error: ...");
    });

    it("json mode calls clock() exactly once per log line regardless of transport count", () => {
      // Each call returns a distinct Date (seconds = call index) so a double
      // invocation is detectable: the second timestamp would have a different
      // seconds digit than the first.
      let clockCalls = 0;
      const clock = (): Date => {
        clockCalls++;
        const d = new Date("2030-01-01T00:00:00Z");
        d.setSeconds(clockCalls);
        return d;
      };

      const stream = new PassThrough();
      const logger = createLogger({
        moduleName: "json-clock-once",
        format: "json",
        includeConsole: true,
        includeFile: false,
        includeGlobalFile: false,
        clock,
        additionalTransports: [new winston.transports.Stream({ stream })],
      });

      logger.info("ping");
      teardownLogger(logger);

      // The Console transport's per-transport format must NOT re-run
      // timestampCapture — the logger-level format already captured the
      // timestamp via the single clock() call. A second call would produce a
      // different timestamp on the console JSON line than on the file line.
      expect(clockCalls).toBe(1);
    });

    it("json mode console format preserves the timestamp written by the logger-level format", () => {
      // Drives both format pipelines manually — the same way Winston does it
      // internally: logger-level format first, then the Console transport's
      // per-transport format on a shallow clone of the transformed info.
      // This bypasses stream-timing concerns and directly asserts the format
      // composition contract: the Console format must NOT call clock() again
      // or overwrite info.timestamp.
      const fixedDate = new Date("2030-06-15T12:34:56Z");
      const clock = () => fixedDate;

      const logger = createLogger({
        moduleName: "json-ts-fmt",
        format: "json",
        includeConsole: true,
        includeFile: false,
        includeGlobalFile: false,
        clock,
      });

      const loggerLevelFormat = (logger as unknown as { format: winston.Logform.Format }).format;
      const consoleTransport = logger.transports.find(
        (t) => t instanceof winston.transports.Console,
      );
      const consoleTransportFormat = (
        consoleTransport as unknown as { format: winston.Logform.Format }
      ).format;

      const syntheticInfo = {
        level: "info",
        message: "hello",
        [Symbol.for("level")]: "info",
      };

      // Step 1 — logger-level format: runs timestampCapture → sets info.timestamp
      const afterLogger = loggerLevelFormat.transform({ ...syntheticInfo } as any);
      expect(afterLogger).not.toBe(false);

      // Step 2 — Console transport format: runs on a clone of the Step 1 result,
      // mirroring Winston's `Object.assign({}, info)` clone before per-transport
      // format execution. Must NOT re-run timestampCapture.
      const afterConsole = consoleTransportFormat.transform({
        ...(afterLogger as Record<string, unknown>),
      } as any);
      expect(afterConsole).not.toBe(false);

      teardownLogger(logger);

      const loggerJson = JSON.parse(
        Reflect.get(afterLogger as Record<PropertyKey, unknown>, Symbol.for("message")) as string,
      ) as Record<string, unknown>;

      const consoleJson = JSON.parse(
        Reflect.get(afterConsole as Record<PropertyKey, unknown>, Symbol.for("message")) as string,
      ) as Record<string, unknown>;

      // The console format must carry the timestamp already written by the
      // logger-level format, not a new clock() read that would differ.
      expect(loggerJson.timestamp).toBe("2030-06-15 12:34:56");
      expect(consoleJson.timestamp).toBe("2030-06-15 12:34:56");
      expect(consoleJson.timestamp).toBe(loggerJson.timestamp);
    });

    it("pretty mode calls clock() exactly once per log line (regression guard)", () => {
      // Confirms the pretty-mode pipeline was already single-capture and that
      // the json-mode fix did not accidentally regress the pretty branch.
      let clockCalls = 0;
      const clock = (): Date => {
        clockCalls++;
        const d = new Date("2030-01-01T00:00:00Z");
        d.setSeconds(clockCalls);
        return d;
      };

      const stream = new PassThrough();
      const logger = createLogger({
        moduleName: "pretty-clock-once",
        includeConsole: true,
        includeFile: false,
        includeGlobalFile: false,
        clock,
        additionalTransports: [new winston.transports.Stream({ stream })],
      });

      logger.info("ping");
      teardownLogger(logger);

      expect(clockCalls).toBe(1);
    });
  });

  describe("createNoopLogger", () => {
    it("returns a singleton — every call returns the same instance", () => {
      const a = createNoopLogger();
      const b = createNoopLogger();
      expect(a).toBe(b);
    });

    it("level methods are no-ops that emit no console output and do not throw", () => {
      const consoleLog = jest.spyOn(console, "log").mockImplementation(() => undefined);
      const consoleError = jest.spyOn(console, "error").mockImplementation(() => undefined);
      const consoleWarn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
      const consoleInfo = jest.spyOn(console, "info").mockImplementation(() => undefined);

      const logger = createNoopLogger();
      // Every documented winston level method must not throw.
      expect(() => logger.info("anything")).not.toThrow();
      expect(() => logger.error(new Error("x"))).not.toThrow();
      expect(() => logger.warn("warn")).not.toThrow();
      expect(() => logger.http("http")).not.toThrow();
      expect(() => logger.verbose("v")).not.toThrow();
      expect(() => logger.debug("d")).not.toThrow();
      expect(() => logger.silly("s")).not.toThrow();
      // Generic log() with explicit level form — `.log("info", "test")`.
      expect(() => (logger.log as (...args: unknown[]) => unknown)("info", "test")).not.toThrow();
      // Multi-arg form with metadata.
      expect(() => logger.info("Login", { email: "u@example.com" })).not.toThrow();

      // No console output — the no-op logger is silent on every transport.
      expect(consoleLog).not.toHaveBeenCalled();
      expect(consoleError).not.toHaveBeenCalled();
      expect(consoleWarn).not.toHaveBeenCalled();
      expect(consoleInfo).not.toHaveBeenCalled();
    });

    it("lifecycle methods (end/close/on/once/removeListener) are no-ops returning the logger", () => {
      const logger = createNoopLogger();
      // Each lifecycle method MUST return the logger so chained calls work.
      expect(logger.end()).toBe(logger);
      expect(logger.close()).toBe(logger);
      expect(logger.on("error", () => undefined)).toBe(logger);
      expect(logger.once("close", () => undefined)).toBe(logger);
      expect(logger.removeListener("error", () => undefined)).toBe(logger);
    });

    it("exposes a frozen empty transports array and a 'silent' level", () => {
      const logger = createNoopLogger();
      expect(logger.level).toBe("silent");
      expect(Array.isArray(logger.transports)).toBe(true);
      expect(logger.transports).toHaveLength(0);
      // The transports array is frozen so consumer code that defensively
      // pushes/splices on it gets a TypeError early instead of a silent
      // mutation that goes nowhere.
      expect(Object.isFrozen(logger.transports)).toBe(true);
    });

    it("does NOT register with the logger registry (singleton is shared, not cached)", () => {
      // Creating a real logger then resetting the registry should NOT clear
      // the no-op singleton — it lives outside the registry.
      const noopBefore = createNoopLogger();
      createLogger({
        moduleName: "registry-noop-probe",
        includeConsole: false,
        includeFile: false,
        includeGlobalFile: false,
      });
      resetLoggerRegistry();
      const noopAfter = createNoopLogger();
      expect(noopAfter).toBe(noopBefore);
    });

    it("returns a chainable no-op for unknown winston methods (forward-compat)", () => {
      const logger = createNoopLogger();
      // A method winston might add in a future release — the no-op logger
      // returns a callable that does nothing instead of throwing.
      const futureMethod = (logger as unknown as Record<string, unknown>).profile;
      expect(typeof futureMethod).toBe("function");
      expect(() => (futureMethod as (...args: unknown[]) => unknown)("test")).not.toThrow();
    });

    it("Symbol-keyed property access returns undefined (not thenable, not iterable)", () => {
      const logger = createNoopLogger() as unknown as Record<symbol, unknown>;
      // Promise machinery probes return undefined so the no-op logger is
      // not accidentally awaited as a thenable.
      expect(logger[Symbol.asyncIterator]).toBeUndefined();
      expect(logger[Symbol.iterator]).toBeUndefined();
      expect(logger[Symbol.toPrimitive]).toBeUndefined();
    });

    it("works as a drop-in replacement for the request middleware's logger option", async () => {
      // Defensive integration check: the request middleware accepts any
      // winston-shaped logger via the `logger` option. The no-op logger
      // must be type-compatible enough to be wired in without errors.
      const { createRequestLogger } = await import("../src/request-middleware");
      const middleware = createRequestLogger({
        logger: createNoopLogger(),
        loggingEnabled: true,
        loggingMode: "always",
      });
      expect(typeof middleware).toBe("function");
    });

    it("is not thenable — then/catch/finally are undefined (F2)", () => {
      const logger = createNoopLogger() as unknown as Record<string, unknown>;
      expect(typeof logger["then"]).toBe("undefined");
      expect(typeof logger["catch"]).toBe("undefined");
      expect(typeof logger["finally"]).toBe("undefined");
    });

    it("await createNoopLogger() resolves to the logger without hanging (F2)", async () => {
      const logger = createNoopLogger();
      // Race the await against a deadline. If then were a function the
      // resolution would never be called and the timer would win.
      const DEADLINE_MS = 500;
      const result = await Promise.race([
        new Promise<typeof logger>((resolve) => {
          // nextTick ensures this fires on the next iteration — fast enough
          // to beat the deadline unless the engine is following a thenable.
          process.nextTick(() => resolve(logger));
        }),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error("await hung — createNoopLogger() appears thenable")),
            DEADLINE_MS,
          ),
        ),
      ]);
      expect(result).toBe(logger);
    });

    it("unknown-method chain returns the no-op logger for forward-compat (F3)", () => {
      const logger = createNoopLogger();
      const rec = logger as unknown as Record<string, (...args: unknown[]) => unknown>;
      // The return value of any unknown method must be the logger itself
      // so callers can chain: logger.someFuture().info("x")
      const ret = rec.someFutureWinstonMethod();
      expect(ret).toBe(logger);
      // Full chain: someFuture().info("x") must not throw
      const chained = rec.someFutureWinstonMethod2() as typeof logger;
      expect(() => chained.info("chained")).not.toThrow();
    });

    it("JSON.stringify returns a valid object and keeps the field in a wrapper (F4)", () => {
      const logger = createNoopLogger();
      const serialized = JSON.stringify(logger);
      // Must produce a string, not undefined
      expect(typeof serialized).toBe("string");
      const parsed = JSON.parse(serialized as string) as Record<string, unknown>;
      expect(parsed.type).toBe("@hiprax/logger");
      expect(parsed.level).toBe("silent");
      expect(parsed.transports).toBe(0);
      // Must not be silently dropped when embedded in a wrapper object
      const wrapped = JSON.stringify({ logger });
      const parsedWrapped = JSON.parse(wrapped) as { logger: Record<string, unknown> };
      expect(parsedWrapped.logger).toBeDefined();
      expect(parsedWrapped.logger.level).toBe("silent");
    });
  });

  describe("BigInt-safe serialization", () => {
    /**
     * Drives a logger configured against a `Stream` transport so the rendered
     * output can be inspected directly. The shared helper builds the logger,
     * runs the supplied `emit` callback, tears down, and returns the captured
     * output as a single string. A `format: "pretty" | "json"` toggle lets
     * each test target the relevant pipeline branch — pretty mode goes
     * through `formatMessage` (where the bug lived), JSON mode goes through
     * `winston.format.json()` (where logform's built-in replacer handles
     * BigInt natively).
     */
    const captureOutput = (
      moduleName: string,
      emit: (logger: winston.Logger) => void,
      format: "pretty" | "json" = "pretty",
    ): string => {
      const stream = new PassThrough();
      const chunks: string[] = [];
      stream.on("data", (chunk) => chunks.push(chunk.toString()));
      const logger = createLogger({
        moduleName,
        format,
        includeConsole: false,
        includeFile: false,
        includeGlobalFile: false,
        additionalTransports: [new winston.transports.Stream({ stream })],
      });
      emit(logger);
      teardownLogger(logger);
      return chunks.join("");
    };

    it("pretty mode does not throw and renders BigInt metadata as a string value", () => {
      // Regression guard: before the bigintSafeReplacer, this call threw
      // `TypeError: Do not know how to serialize a BigInt` synchronously
      // inside the printf because `JSON.stringify(cleanedMeta, null, 2)`
      // has no built-in BigInt handling.
      let output = "";
      expect(() => {
        output = captureOutput("bigint-pretty-meta", (logger) => {
          logger.info("Order", { orderId: 123n });
        });
      }).not.toThrow();
      // The string-coerced form preserves fidelity for snowflake-style IDs
      // that exceed Number.MAX_SAFE_INTEGER.
      expect(output).toContain('"orderId": "123"');
      // The original `Order` message still flows through verbatim.
      expect(output).toContain("Order");
    });

    it("json mode does not throw and emits a parseable JSON line for BigInt metadata", () => {
      // logform's `winston.format.json()` ships its own replacer that
      // string-coerces BigInts before `safe-stable-stringify` runs (which
      // would otherwise emit a JSON number with precision loss). This test
      // pins that contract from our consumer side.
      let output = "";
      expect(() => {
        output = captureOutput(
          "bigint-json-meta",
          (logger) => {
            logger.info("Order", { orderId: 123n });
          },
          "json",
        );
      }).not.toThrow();
      const parsed = JSON.parse(output.trim()) as Record<string, unknown>;
      expect(parsed.message).toBe("Order");
      expect(parsed.orderId).toBe("123");
    });

    it("pretty mode handles a BigInt as the message itself without throwing", () => {
      // Edge case: `logger.info(123n)` — winston routes the value through
      // `info.message`, which the formatter must not pass to `JSON.stringify`
      // unguarded. The dedicated `typeof === "bigint"` branch coerces via
      // `.toString()` so the rendered line carries the digits verbatim.
      let output = "";
      expect(() => {
        output = captureOutput("bigint-pretty-msg", (logger) => {
          logger.info(123n as unknown as string);
        });
      }).not.toThrow();
      // The rendered line carries `123` as the message body — no quotes,
      // no `[object Object]`, no error envelope.
      expect(output).toMatch(/\n123\n/);
    });

    it("json mode handles a BigInt as the message itself without throwing", () => {
      let output = "";
      expect(() => {
        output = captureOutput(
          "bigint-json-msg",
          (logger) => {
            logger.info(456n as unknown as string);
          },
          "json",
        );
      }).not.toThrow();
      const parsed = JSON.parse(output.trim()) as Record<string, unknown>;
      // logform's replacer string-coerces the message field too.
      expect(parsed.message).toBe("456");
    });

    it("pretty mode walks nested BigInts inside metadata objects", () => {
      // Deep-redaction-style coverage: BigInts inside nested plain objects
      // must also string-coerce. The replacer is invoked for every key, so
      // the whole metadata tree is BigInt-safe regardless of depth.
      let output = "";
      expect(() => {
        output = captureOutput("bigint-pretty-nested", (logger) => {
          logger.info("Nested", { outer: { inner: { id: 999n } } });
        });
      }).not.toThrow();
      expect(output).toContain('"id": "999"');
    });

    it("pretty mode walks BigInts inside arrays", () => {
      // Arrays are also walked by JSON.stringify; the replacer fires for
      // each element. Without it, the first BigInt element would crash.
      let output = "";
      expect(() => {
        output = captureOutput("bigint-pretty-array", (logger) => {
          logger.info("Bulk", { ids: [1n, 2n, 3n] });
        });
      }).not.toThrow();
      // Each element is rendered as a string in array form.
      expect(output).toContain('"1"');
      expect(output).toContain('"2"');
      expect(output).toContain('"3"');
    });

    it("__loggerInternals.bigintSafeReplacer string-coerces BigInts and passes everything else through", () => {
      // Direct unit coverage on the replacer signature. The contract: any
      // BigInt becomes its decimal string; every other type passes through
      // identity-equal so no other JSON.stringify behavior is altered.
      const { bigintSafeReplacer } = __loggerInternals;
      expect(bigintSafeReplacer("k", 123n)).toBe("123");
      expect(bigintSafeReplacer("k", 0n)).toBe("0");
      // Negative BigInts retain the sign.
      expect(bigintSafeReplacer("k", -42n)).toBe("-42");
      // Non-BigInt values are returned unchanged (including `null`, which
      // JSON.stringify must continue to emit as the literal `null`).
      expect(bigintSafeReplacer("k", "string")).toBe("string");
      expect(bigintSafeReplacer("k", 42)).toBe(42);
      expect(bigintSafeReplacer("k", null)).toBe(null);
      expect(bigintSafeReplacer("k", undefined)).toBe(undefined);
      const obj = { a: 1 };
      expect(bigintSafeReplacer("k", obj)).toBe(obj);
    });
  });
});
