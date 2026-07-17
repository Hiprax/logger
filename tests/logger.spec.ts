import { EventEmitter } from "node:events";
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
import { __crashCaptureInternals } from "../src/crash-capture";
import {
  __sharedFileInternals,
  acquireSharedGlobalFile,
  flushSharedFileTransportsForExit,
} from "../src/shared-file-transport";
import { MAX_REDACT_DEPTH, redactValue } from "../src/redact";
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

/**
 * Returns the live shared global-file transports. Since v1.0.0 the global
 * (`all-logs`) rotating-file transport is shared + reference-counted across
 * loggers, so it is NOT present in `logger.transports` — the logger holds a
 * cheap forwarding handle instead. Tests that need to assert on the real
 * rotating-file options reach for it here.
 */
const sharedGlobalTransports = (): DailyRotateFile[] =>
  Array.from(__sharedFileInternals.sharedFileRegistry.values()).map(
    (entry) => entry.transport as unknown as DailyRotateFile,
  );

/** The module-scoped rotating file transports piped directly into a logger. */
const moduleRotatingTransports = (logger: winston.Logger): DailyRotateFile[] =>
  logger.transports.filter(
    (transport): transport is DailyRotateFile => transport instanceof DailyRotateFile,
  );

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

    // The module-scoped file is owned by this logger; the global file is the
    // shared, reference-counted transport reached via the shared registry.
    const rotating = moduleRotatingTransports(logger);
    expect(rotating).toHaveLength(1);
    expect(rotating[0].options.maxFiles).toBe("2d");

    const shared = sharedGlobalTransports();
    expect(shared).toHaveLength(1);
    expect(shared[0].options.maxFiles).toBe("30d");
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

    const rotating = moduleRotatingTransports(logger);
    expect(rotating).toHaveLength(1);
    expect(rotating[0].options.maxFiles).toBe("14d");

    const shared = sharedGlobalTransports();
    expect(shared).toHaveLength(1);
    expect(shared[0].options.maxFiles).toBe("30d");
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

    const rotating = moduleRotatingTransports(logger);
    expect(rotating).toHaveLength(1);
    expect(rotating[0].options.maxFiles).toBe("5d");

    const shared = sharedGlobalTransports();
    expect(shared).toHaveLength(1);
    expect(shared[0].options.maxFiles).toBe("5d");
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

  it("renders a nested BigInt in the info fallback instead of collapsing to String(value)", () => {
    // Same defect shape the middleware's serializeBody carried: an unguarded
    // JSON.stringify threw on the BigInt and String(value) rendered the whole
    // payload as the useless "[object Object]".
    const logger = createNoopTransportLogger();
    (logger as any).info = undefined;
    const logSpy = jest.fn();
    (logger as any).log = logSpy;

    (logger as any).obscure({ orderId: 123n, user: "bob" });

    expect(logSpy).toHaveBeenCalledWith({
      level: "info",
      message: '{"orderId":"123","user":"bob"}',
    });
    teardownLogger(logger);
  });

  it("renders a bare BigInt payload as its bare digits in the info fallback", () => {
    // Matches formatMessage's bare-BigInt short-circuit: `123`, not `"123"`.
    const logger = createNoopTransportLogger();
    (logger as any).info = undefined;
    const logSpy = jest.fn();
    (logger as any).log = logSpy;

    (logger as any).obscure(123n);

    expect(logSpy).toHaveBeenCalledWith({ level: "info", message: "123" });
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

    it("folds two module names that sanitize to the same file into one cached logger (P13a)", () => {
      // "user api" and "user-api" both sanitize to `http/user-api-%DATE%.log`,
      // so they must resolve to the SAME cached instance — not two independent
      // rotators fighting over one physical file. Reachable via
      // createRequestLogger({ label: "user api" }) (moduleName "http/<label>").
      const root = createTempDir();
      const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => undefined);

      const spaced = createLogger({ ...baseOpts(root), moduleName: "http/user api" });
      const hyphen = createLogger({ ...baseOpts(root), moduleName: "http/user-api" });

      expect(hyphen).toBe(spaced);
      // Identical options otherwise → no false-positive conflict warning.
      expect(warnSpy).not.toHaveBeenCalled();

      warnSpy.mockRestore();
      teardownLogger(spaced);
    });

    it("warns when two colliding module names carry divergent options (P13a)", () => {
      const root = createTempDir();
      const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => undefined);

      const first = createLogger({
        ...baseOpts(root),
        moduleName: "http/user api",
        level: "info",
      });
      const second = createLogger({
        ...baseOpts(root),
        moduleName: "http/user-api",
        level: "debug",
      });

      // Same resolved file → same cache key → the options divergence now trips
      // the existing conflict warning instead of silently double-opening.
      expect(second).toBe(first);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(String(warnSpy.mock.calls[0][0])).toContain("level");

      warnSpy.mockRestore();
      teardownLogger(first);
    });

    it("does not warn when rotation.maxSize differs only by unit-suffix case (P13b)", () => {
      // "20m" and "20M" produce a byte-identical transport (upstream lowercases
      // internally), so the signature must treat them as equal — no
      // false-positive conflict warning.
      const root = createTempDir();
      const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => undefined);

      const first = createLogger({ ...baseOpts(root), rotation: { maxSize: "20m" } });
      const second = createLogger({ ...baseOpts(root), rotation: { maxSize: "20M" } });

      expect(second).toBe(first);
      expect(warnSpy).not.toHaveBeenCalled();

      warnSpy.mockRestore();
      teardownLogger(first);
    });

    it("warns when onTransportError presence differs on a cached key (P13c)", () => {
      const root = createTempDir();
      const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => undefined);

      const first = createLogger(baseOpts(root));
      const second = createLogger({ ...baseOpts(root), onTransportError: () => undefined });

      // Adding the callback to a cached key must no longer be silently dropped:
      // the presence marker surfaces it through the conflict warning.
      expect(second).toBe(first);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(String(warnSpy.mock.calls[0][0])).toContain("onTransportError");

      warnSpy.mockRestore();
      teardownLogger(first);
    });

    it("does not warn when onTransportError is present on both calls (presence-only, P13c)", () => {
      const root = createTempDir();
      const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => undefined);

      // Two DIFFERENT callbacks: compared by presence only, both are
      // "function", so no conflict is reported (documented caveat, mirroring
      // additionalTransports(count)).
      const first = createLogger({ ...baseOpts(root), onTransportError: () => undefined });
      const second = createLogger({ ...baseOpts(root), onTransportError: (err) => void err });

      expect(second).toBe(first);
      expect(warnSpy).not.toHaveBeenCalled();

      warnSpy.mockRestore();
      teardownLogger(first);
    });

    it("normalizeMaxSize lowercases a string unit suffix and passes non-strings through (P13b)", () => {
      expect(__loggerInternals.normalizeMaxSize("20M")).toBe("20m");
      expect(__loggerInternals.normalizeMaxSize("0.5M")).toBe("0.5m");
      expect(__loggerInternals.normalizeMaxSize("1G")).toBe("1g");
      expect(__loggerInternals.normalizeMaxSize("20m")).toBe("20m");
      expect(__loggerInternals.normalizeMaxSize(undefined)).toBeUndefined();
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
    it("re-exports a working bigintSafeReplacer after the move to src/serialize.ts", () => {
      // The replacer now lives in `src/serialize.ts` and is shared with the
      // request middleware; `__loggerInternals` must keep exposing it, and it
      // must still be the real implementation rather than a stale stub.
      const { bigintSafeReplacer } = __loggerInternals;
      expect(bigintSafeReplacer("k", 123n)).toBe("123");
      expect(bigintSafeReplacer("k", "plain")).toBe("plain");
      expect(bigintSafeReplacer("k", 42)).toBe(42);
      // Behaves correctly as an actual JSON.stringify replacer.
      expect(JSON.stringify({ id: 9007199254740993n }, bigintSafeReplacer)).toBe(
        '{"id":"9007199254740993"}',
      );
    });

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

    it("resolveLogDirectory canonicalizes via the nearest existing ancestor when the dir does not exist", () => {
      // The parent exists but the target does not yet. The resolved path must be
      // the CANONICAL parent (realpath) with the missing tail re-joined, so it
      // matches what a later call resolves once the directory is created. This
      // is what keeps the registry key stable across the create-the-directory
      // boundary when a symlink/junction sits above the target.
      const parent = createTempDir();
      const ghost = path.join(parent, "does-not-exist-yet");
      const resolved = __loggerInternals.resolveLogDirectory(ghost);
      const expected = path.join(fs.realpathSync.native(parent), "does-not-exist-yet");
      expect(resolved).toBe(expected);
    });

    it("resolveLogDirectory re-joins a multi-segment missing tail onto the nearest existing ancestor", () => {
      const parent = createTempDir();
      const ghost = path.join(parent, "a", "b", "c");
      const resolved = __loggerInternals.resolveLogDirectory(ghost);
      const expected = path.join(fs.realpathSync.native(parent), "a", "b", "c");
      expect(resolved).toBe(expected);
    });

    it("resolveLogDirectory falls back to the plain absolute path when no ancestor can be canonicalized", () => {
      // Force every realpath to fail so the ancestor walk climbs to the
      // filesystem root and hits the root guard, exercising the fallback.
      const spy = jest.spyOn(fs.realpathSync, "native").mockImplementation(() => {
        throw new Error("realpath unavailable");
      });
      try {
        const input = path.join(createTempDir(), "x", "y");
        const resolved = __loggerInternals.resolveLogDirectory(input);
        expect(resolved).toBe(path.resolve(input));
      } finally {
        spy.mockRestore();
      }
    });

    // Probe (once) whether this runner is allowed to create a symlink/junction.
    // Windows can create directory JUNCTIONS without elevation but plain
    // symlinks usually need it; POSIX allows symlinks. Where neither is
    // permitted the junction test is skipped EXPLICITLY (jest reports it as
    // skipped) rather than silently passing.
    const symlinkProbe = ((): { ok: boolean; type: "junction" | undefined } => {
      const probeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "adv-logger-symprobe-"));
      const type = process.platform === "win32" ? ("junction" as const) : undefined;
      try {
        const target = path.join(probeRoot, "target");
        fs.mkdirSync(target);
        fs.symlinkSync(target, path.join(probeRoot, "link"), type);
        return { ok: true, type };
      } catch {
        return { ok: false, type };
      } finally {
        fs.rmSync(probeRoot, { recursive: true, force: true });
      }
    })();

    const junctionIt = symlinkProbe.ok ? it : it.skip;

    junctionIt(
      "resolves one logger and one shared global file across the create-the-directory boundary through a junction/symlink",
      () => {
        const root = fs.realpathSync.native(createTempDir());
        const realDir = path.join(root, "real");
        fs.mkdirSync(realDir);
        const linkDir = path.join(root, "link");
        fs.symlinkSync(realDir, linkDir, symlinkProbe.type);

        // The target under the link does NOT exist yet, so the FIRST call runs
        // before its own ensureDirectory materializes it — the exact ordering
        // that used to split one physical file across two registry keys.
        const logDirectory = path.join(linkDir, "logs");
        expect(fs.existsSync(logDirectory)).toBe(false);

        const first = createLogger({
          logDirectory,
          moduleName: "svc",
          includeConsole: false,
        });
        // Now the directory exists (physically under realDir), so the second
        // call's realpath succeeds and — with the fix — resolves to the same
        // canonical path the first call registered under.
        expect(fs.existsSync(logDirectory)).toBe(true);

        const second = createLogger({
          logDirectory,
          moduleName: "svc",
          includeConsole: false,
        });

        // Same cached instance => a single registry key across the boundary.
        expect(second).toBe(first);
        // Exactly ONE shared global-file transport => the shared-file key did
        // not diverge either (its key is derived from the same resolved dir).
        expect(__sharedFileInternals.sharedFileRegistry.size).toBe(1);
        // And exactly one module-scoped rotating-file handle backs the file.
        expect(moduleRotatingTransports(first)).toHaveLength(1);

        teardownLogger(first);
      },
    );

    it("buildRegistryKey is case-insensitive on Windows and case-sensitive on POSIX", () => {
      // Phase 13: the key is now the resolved MODULE LOG-FILE PATH, not the raw
      // moduleName + directory. Case-folding is still Windows-only.
      const upper = "/Tmp/Logger/auth-%DATE%.log";
      const lower = "/tmp/logger/auth-%DATE%.log";
      const original = process.platform;

      try {
        Object.defineProperty(process, "platform", { value: "win32", configurable: true });
        const upperKeyWin = __loggerInternals.buildRegistryKey(upper);
        const lowerKeyWin = __loggerInternals.buildRegistryKey(lower);
        expect(upperKeyWin).toBe(lowerKeyWin);

        Object.defineProperty(process, "platform", { value: "linux", configurable: true });
        const upperKeyPosix = __loggerInternals.buildRegistryKey(upper);
        const lowerKeyPosix = __loggerInternals.buildRegistryKey(lower);
        expect(upperKeyPosix).not.toBe(lowerKeyPosix);
      } finally {
        Object.defineProperty(process, "platform", { value: original, configurable: true });
      }
    });

    it("buildRegistryKey folds two module names that sanitize to one file into one key", () => {
      // "user api" and "user-api" both sanitize to `user-api-%DATE%.log`, so
      // their registry keys must be identical (Phase 13 collision fix).
      const baseDir = path.resolve("/tmp/logger-key");
      const spaced = __loggerInternals.buildLogFilePath(baseDir, "http/user api");
      const hyphen = __loggerInternals.buildLogFilePath(baseDir, "http/user-api");
      expect(__loggerInternals.buildRegistryKey(spaced)).toBe(
        __loggerInternals.buildRegistryKey(hyphen),
      );
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
        exitOnUncaught: true,
        onTransportError: "undefined",
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
        exitOnUncaught: true,
        onTransportError: "undefined",
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
      teardownLogger(logger);
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
      teardownLogger(logger);
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
      teardownLogger(logger);
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
      teardownLogger(a);
      teardownLogger(b);
    });

    // -------------------------------------------------------------------------
    // Phase 7 — shutdownAllLoggers partial-timeout rejection + independence
    // (Task 7.1, closes F10)
    // -------------------------------------------------------------------------

    it("shutdownAllLoggers rejects when one logger stalls, while the healthy logger flushes independently (Phase 7)", async () => {
      // Same StalledTransport pattern as the single-logger timeout test above,
      // registered alongside a normal Stream-backed logger so BOTH land in the
      // module-level registry that shutdownAllLoggers() walks via Promise.all.
      class StalledAllTransport extends Transport {
        public name = "stalled-all";
        public log = jest.fn((_info: unknown, callback?: () => void) => callback?.());
        public _final = (_callback: (err?: Error | null) => void): void => {
          // Intentionally never invoke the callback — this transport never
          // reaches the `finish` state, so its shutdownLogger() call must time
          // out at the 50ms deadline below.
        };
      }
      const stalled = new StalledAllTransport();
      const stream = new PassThrough();

      const healthy = createLogger({
        moduleName: "shutdown-all-healthy",
        includeConsole: false,
        includeFile: false,
        includeGlobalFile: false,
        additionalTransports: [new winston.transports.Stream({ stream })],
      });
      const broken = createLogger({
        moduleName: "shutdown-all-broken",
        includeConsole: false,
        includeFile: false,
        includeGlobalFile: false,
        additionalTransports: [stalled as unknown as winston.transport],
      });
      // Sanity: both got cached as distinct registry entries.
      expect(healthy).not.toBe(broken);

      // shutdownAllLoggers() is `Promise.all(...)` under the hood — it MUST
      // reject as soon as the broken logger's own 50ms timeout fires. This
      // pins the documented "can reject / timeout is independent per logger"
      // contract so a future `Promise.allSettled` refactor can't silently
      // flip it while staying green.
      await expect(shutdownAllLoggers({ timeoutMs: 50 })).rejects.toThrow(
        /shutdownLogger timed out after 50ms/,
      );

      // Independence proof: shutdownAllLoggers() issued the healthy logger's
      // OWN shutdownLogger() call internally, and that call already resolved
      // (the Stream transport flushes well within 50ms) — its resolved
      // promise is cached in the per-logger WeakMap. A fresh call here MUST
      // resolve immediately from that cached entry rather than reissuing
      // logger.end() (which would hang: the Stream's `finish` event already
      // fired once and a Writable does not re-emit it on a second `end()`).
      // If shutdownAllLoggers had been refactored to discard per-logger state
      // on rejection, this call would hang until the default 5000ms timeout
      // instead of resolving immediately.
      await expect(shutdownLogger(healthy)).resolves.toBeUndefined();
      teardownLogger(healthy);
      teardownLogger(broken);
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
      teardownLogger(logger);
    });

    // -------------------------------------------------------------------------
    // Phase 1 — shutdownLogger must actually flush to disk
    //
    // Regression guard for the data-loss defect: `shutdownLogger` used to await
    // only `finish`, and a `DailyRotateFile` implements no `_final`, so `end()`
    // emitted `finish` while its `logStream` was still buffering. The helper
    // resolved with NOTHING on disk, which meant the documented SIGTERM idiom
    // (`await shutdownAllLoggers(); process.exit(0)`) lost every buffered line.
    //
    // These tests are deliberately end-to-end: they read the real rotating log
    // file back off disk AFTER the await resolves. Asserting on transport
    // internals or `finish` events would have stayed green throughout the bug.
    // -------------------------------------------------------------------------

    /**
     * Concatenates every rotated log file written for `prefix` in `dir`. Reading
     * the directory rather than reconstructing the `-%DATE%.log` filename keeps
     * the assertion independent of the rotator's local-vs-UTC date resolution.
     */
    const readLogFiles = (dir: string, prefix: string): string => {
      if (!fs.existsSync(dir)) {
        return "";
      }
      return fs
        .readdirSync(dir)
        .filter((name) => name.startsWith(`${prefix}-`) && name.endsWith(".log"))
        .map((name) => fs.readFileSync(path.join(dir, name), "utf8"))
        .join("");
    };

    it("flushes a single line to the module file before resolving (Phase 1)", async () => {
      const root = createTempDir();
      const logger = createLogger({
        moduleName: "flush-single",
        logDirectory: root,
        includeConsole: false,
        includeGlobalFile: false,
      });

      logger.info("SINGLE-LINE-ON-DISK");

      await shutdownLogger(logger);

      // The await has resolved — the bytes MUST already be readable. Before the
      // fix this file did not even exist at this point.
      expect(readLogFiles(root, "flush-single")).toContain("SINGLE-LINE-ON-DISK");
      teardownLogger(logger);
    });

    it("flushes a bulk write to the module file before resolving (Phase 1)", async () => {
      const root = createTempDir();
      const logger = createLogger({
        moduleName: "flush-bulk",
        logDirectory: root,
        includeConsole: false,
        includeGlobalFile: false,
      });

      const total = 500;
      for (let i = 0; i < total; i += 1) {
        logger.info(`bulk-line-${i}`);
      }

      await shutdownLogger(logger);

      // Every line, not just the first — the original defect lost the entire
      // buffer, and a partial drain would be just as much a data-loss bug.
      const contents = readLogFiles(root, "flush-bulk");
      for (let i = 0; i < total; i += 1) {
        expect(contents).toContain(`bulk-line-${i}`);
      }
      teardownLogger(logger);
    });

    it("flushes both the module and shared global file under the default config (Phase 1)", async () => {
      const root = createTempDir();
      // `includeFile` and `includeGlobalFile` both default to true — this is the
      // configuration the README's SIGTERM example produces.
      const logger = createLogger({
        moduleName: "flush-default",
        logDirectory: root,
        includeConsole: false,
      });

      logger.info("DEFAULT-CONFIG-LINE");

      await shutdownLogger(logger);

      expect(readLogFiles(root, "flush-default")).toContain("DEFAULT-CONFIG-LINE");
      // The shared global file drains through the refcounted handle's `_final`,
      // a different code path from the module file's `DailyRotateFile`.
      expect(readLogFiles(root, "all-logs")).toContain("DEFAULT-CONFIG-LINE");
      teardownLogger(logger);
    });

    it("flushes to disk via shutdownAllLoggers before resolving (Phase 1)", async () => {
      const root = createTempDir();
      const a = createLogger({
        moduleName: "flush-all-a",
        logDirectory: root,
        includeConsole: false,
        includeGlobalFile: false,
      });
      const b = createLogger({
        moduleName: "flush-all-b",
        logDirectory: root,
        includeConsole: false,
        includeGlobalFile: false,
      });
      a.info("ALL-LOGGERS-A");
      b.info("ALL-LOGGERS-B");

      // This is the exact idiom the `shutdownAllLoggers` JSDoc documents for a
      // SIGTERM handler that then calls `process.exit(0)`.
      await shutdownAllLoggers({ timeoutMs: 5000 });

      expect(readLogFiles(root, "flush-all-a")).toContain("ALL-LOGGERS-A");
      expect(readLogFiles(root, "flush-all-b")).toContain("ALL-LOGGERS-B");
      teardownLogger(a);
      teardownLogger(b);
    });

    it("partial shutdown flushes one logger while the shared global file stays usable (Phase 1)", async () => {
      const root = createTempDir();
      const a = createLogger({
        moduleName: "partial-a",
        logDirectory: root,
        includeConsole: false,
      });
      const b = createLogger({
        moduleName: "partial-b",
        logDirectory: root,
        includeConsole: false,
      });

      a.info("PARTIAL-FROM-A");
      b.info("PARTIAL-FROM-B");

      // Shut down ONLY `a`. The shared global transport is refcounted, so `b`
      // still holds a handle and the file must stay open and writable.
      await shutdownLogger(a);

      expect(readLogFiles(root, "partial-a")).toContain("PARTIAL-FROM-A");

      // `b` survives `a`'s shutdown and can still write to both its own module
      // file and the shared global file.
      b.info("PARTIAL-AFTER-A-SHUTDOWN");
      await shutdownLogger(b);

      const bContents = readLogFiles(root, "partial-b");
      expect(bContents).toContain("PARTIAL-FROM-B");
      expect(bContents).toContain("PARTIAL-AFTER-A-SHUTDOWN");

      // The shared global file must carry every line from BOTH loggers,
      // including the one written after `a` was already down.
      const globalContents = readLogFiles(root, "all-logs");
      expect(globalContents).toContain("PARTIAL-FROM-A");
      expect(globalContents).toContain("PARTIAL-FROM-B");
      expect(globalContents).toContain("PARTIAL-AFTER-A-SHUTDOWN");
      teardownLogger(a);
      teardownLogger(b);
    });

    it("flushes an additional transport that brings its own _final (Phase 1)", async () => {
      // `winston.transports.File` ships a correct `_final` of its own AND a
      // `close()` that emits `flush`/`closed` but NEVER `finish`/`close`. It is
      // the reason the drain lives in `buildRotateTransport` rather than in a
      // "prefer close() over end()" rule inside the flush: such a rule would
      // hang here until the shutdown timeout.
      const root = createTempDir();
      const filename = path.join(root, "final-transport.log");
      const fileTransport = new winston.transports.File({ filename });

      const logger = createLogger({
        moduleName: "flush-final-transport",
        logDirectory: root,
        includeConsole: false,
        includeFile: false,
        includeGlobalFile: false,
        additionalTransports: [fileTransport as unknown as winston.transport],
      });

      logger.info("FINAL-TRANSPORT-LINE");

      // Must resolve well inside the deadline, not reject.
      await expect(shutdownLogger(logger, { timeoutMs: 2000 })).resolves.toBeUndefined();

      expect(fs.readFileSync(filename, "utf8")).toContain("FINAL-TRANSPORT-LINE");
      teardownLogger(logger);
    });

    it("keeps driving winston's pipeline via logger.end() for a back-pressuring transport (Phase 1)", async () => {
      // Pins WHY the drain lives in the transport's `_final` rather than in a
      // "close() each transport instead of calling logger.end()" flush.
      //
      // A transport whose `log()` callback is ASYNC back-pressures the winston
      // pipe: its writable buffer fills, `pipe` pauses the Logger's readable,
      // and the remaining infos sit in the Logger's OWN buffers. `logger.end()`
      // is the only thing that hands those over (`Logger._final`). Draining the
      // transports directly without it strands everything behind the
      // back-pressure — measured at ONE line of 2000 delivered.
      class AsyncTransport extends Transport {
        public name = "async-backpressure";
        public received: string[] = [];
        public finalCalled = false;
        public log = (info: { message?: unknown }, callback?: () => void): void => {
          setImmediate(() => {
            this.received.push(String(info.message));
            callback?.();
          });
        };
        public _final = (callback: (err?: Error) => void): void => {
          this.finalCalled = true;
          callback();
        };
      }
      const asyncTransport = new AsyncTransport();

      const logger = createLogger({
        moduleName: "flush-async-backpressure",
        includeConsole: false,
        includeFile: false,
        includeGlobalFile: false,
        additionalTransports: [asyncTransport as unknown as winston.transport],
      });

      const total = 200;
      for (let i = 0; i < total; i += 1) {
        logger.info(`async-line-${i}`);
      }

      await shutdownLogger(logger, { timeoutMs: 5000 });

      // `_final` only runs because `shutdownLogger` called `logger.end()`, whose
      // `Logger._final` ends each transport. This is the load-bearing assertion.
      expect(asyncTransport.finalCalled).toBe(true);

      // ...and the pipeline really did hand over the back-pressured backlog,
      // far beyond the handful the transport's own writable could hold in
      // flight (objectMode highWaterMark is 16). Without `logger.end()` this is
      // 1. NOTE: this is deliberately a lower bound, not `total`. winston's own
      // `Logger._final` ends each transport while the Logger's readable may
      // still hold queued chunks, so the tail is lost to a write-after-end that
      // the base logger's no-op `error` listener swallows. That is an upstream
      // winston race, reproducible with bare winston and no part of this
      // package; asserting `total` here would pin a guarantee winston does not
      // make.
      expect(asyncTransport.received.length).toBeGreaterThan(100);
      teardownLogger(logger);
    });

    it("installRotateFileFinal drains logStream and never clobbers an existing _final (Phase 1)", async () => {
      // Unit-level coverage for the hook that makes `DailyRotateFile.end()`
      // truthful. The rotating file defines no `_final`, so Node emits `finish`
      // the moment its queued writes return — while `logStream` is still
      // buffering. This installs the missing drain.
      const ended: string[] = [];
      const stub = {
        logStream: {
          end: (callback?: () => void): void => {
            ended.push("drained");
            callback?.();
          },
        },
      } as unknown as DailyRotateFile;

      __loggerInternals.installRotateFileFinal(stub);
      const withFinal = stub as unknown as {
        _final: (callback: (err?: Error) => void) => void;
      };
      expect(typeof withFinal._final).toBe("function");

      // `_final` must not call back until `logStream.end()` has drained.
      await new Promise<void>((resolve) => withFinal._final(() => resolve()));
      expect(ended).toEqual(["drained"]);

      // A transport that already has a `_final` (a future upstream release, or
      // `winston.transports.File`) must be left exactly as it was.
      const existing = jest.fn((callback: (err?: Error) => void) => callback());
      const preEquipped = { _final: existing } as unknown as DailyRotateFile;
      __loggerInternals.installRotateFileFinal(preEquipped);
      expect((preEquipped as unknown as { _final: unknown })._final).toBe(existing);
    });

    it("installRotateFileFinal settles when logStream is absent or throws (Phase 1)", async () => {
      // No `logStream` yet: `_final` must still call back rather than wedge
      // `end()` forever.
      const noStream = {} as unknown as DailyRotateFile;
      __loggerInternals.installRotateFileFinal(noStream);
      await expect(
        new Promise<void>((resolve) =>
          (noStream as unknown as { _final: (cb: () => void) => void })._final(() => resolve()),
        ),
      ).resolves.toBeUndefined();

      // A stream already mid-teardown can throw on a second `end()`. That must
      // degrade to "settle", never to a hang.
      const throwing = {
        logStream: {
          end: (): void => {
            throw new Error("end boom");
          },
        },
      } as unknown as DailyRotateFile;
      __loggerInternals.installRotateFileFinal(throwing);
      await expect(
        new Promise<void>((resolve) =>
          (throwing as unknown as { _final: (cb: () => void) => void })._final(() => resolve()),
        ),
      ).resolves.toBeUndefined();
    });

    // -------------------------------------------------------------------------
    // Phase 2 — a shut-down logger must not stay in the registry.
    //
    // `shutdownLogger` deregistered crash capture and released the shared-file
    // handle but never evicted `loggerRegistry`, so a later `createLogger()` on
    // the same `moduleName` + `logDirectory` cache-hit and returned the ENDED
    // logger: `b === a`, `b.transports.length === 0`, and every subsequent write
    // was silently discarded — no throw, no warning, nothing on disk. Worker
    // recycles, dev hot-reload and shutdown-then-recreate loops all hit it.
    //
    // These tests assert the REPLACEMENT logger actually works end-to-end
    // (bytes on disk), not merely that the identity differs — a fresh-but-broken
    // instance would satisfy an identity check while still losing every line.
    // -------------------------------------------------------------------------

    it("evicts the registry entry so a later createLogger builds a fresh working logger (Phase 2)", async () => {
      const root = createTempDir();
      const options = {
        moduleName: "evict-single",
        logDirectory: root,
        includeConsole: false,
        includeGlobalFile: false,
      };

      const a = createLogger(options);
      a.info("BEFORE-SHUTDOWN");
      await shutdownLogger(a);

      const b = createLogger(options);

      // The cache must NOT hand back the ended instance.
      expect(b).not.toBe(a);
      expect(b.transports.length).toBeGreaterThan(0);

      b.info("AFTER-SHUTDOWN-WRITE");
      await shutdownLogger(b);

      // The load-bearing assertion: the post-shutdown line is really on disk.
      // Before the fix this write vanished silently.
      const contents = readLogFiles(root, "evict-single");
      expect(contents).toContain("BEFORE-SHUTDOWN");
      expect(contents).toContain("AFTER-SHUTDOWN-WRITE");
      teardownLogger(a);
      teardownLogger(b);
    });

    it("evicts every logger shut down via shutdownAllLoggers (Phase 2)", async () => {
      const root = createTempDir();
      const optionsA = {
        moduleName: "evict-all-a",
        logDirectory: root,
        includeConsole: false,
        includeGlobalFile: false,
      };
      const optionsB = {
        moduleName: "evict-all-b",
        logDirectory: root,
        includeConsole: false,
        includeGlobalFile: false,
      };

      const a1 = createLogger(optionsA);
      const b1 = createLogger(optionsB);
      a1.info("ALL-BEFORE-A");
      b1.info("ALL-BEFORE-B");

      await shutdownAllLoggers();

      const a2 = createLogger(optionsA);
      const b2 = createLogger(optionsB);
      expect(a2).not.toBe(a1);
      expect(b2).not.toBe(b1);

      a2.info("ALL-AFTER-A");
      b2.info("ALL-AFTER-B");
      await shutdownAllLoggers();

      expect(readLogFiles(root, "evict-all-a")).toContain("ALL-AFTER-A");
      expect(readLogFiles(root, "evict-all-b")).toContain("ALL-AFTER-B");
      teardownLogger(a1);
      teardownLogger(b1);
      teardownLogger(a2);
      teardownLogger(b2);
    });

    it("re-registers crash capture for a logger created after a shutdown (Phase 2)", async () => {
      const root = createTempDir();
      const options = {
        moduleName: "evict-crash",
        logDirectory: root,
        includeConsole: false,
        includeGlobalFile: false,
        captureUncaught: true,
      };

      const a = createLogger(options);
      expect(__crashCaptureInternals.isInstalled()).toBe(true);

      // Last logger down -> the coordinator's single listener pair is uninstalled.
      await shutdownLogger(a);
      expect(__crashCaptureInternals.isInstalled()).toBe(false);
      expect(__crashCaptureInternals.registered.size).toBe(0);

      // The replacement must be a real, registered participant again — an
      // eviction that returned a fresh logger which never re-registered would
      // leave the process with no crash capture at all.
      const b = createLogger(options);
      expect(b).not.toBe(a);
      expect(__crashCaptureInternals.isInstalled()).toBe(true);
      expect(__crashCaptureInternals.registered.size).toBe(1);

      await shutdownLogger(b);
      teardownLogger(a);
      teardownLogger(b);
    });

    it("evicts on a TIMED-OUT shutdown too, and stays retryable by reference (Phase 2)", async () => {
      // A timed-out shutdown evicts as well. `end()` is issued unconditionally
      // before the flush race even starts, so a timed-out logger is not
      // "maybe still usable" — it is ended AND still undrained, i.e. strictly
      // more broken than a successful one. Keeping it cached would preserve the
      // silent-loss defect on precisely the unhealthy path.
      const root = createTempDir();
      let releaseFinal: (() => void) | undefined;
      class StallingTransport extends Transport {
        public name = "stalling";
        public log = jest.fn((_info: unknown, callback?: () => void) => callback?.());
        public _final = (callback: (err?: Error) => void): void => {
          releaseFinal = () => callback();
        };
      }

      const options = {
        moduleName: "evict-timeout",
        logDirectory: root,
        includeConsole: false,
        includeFile: false,
        includeGlobalFile: false,
        additionalTransports: [new StallingTransport() as unknown as winston.transport],
      };
      const a = createLogger(options);

      await expect(shutdownLogger(a, { timeoutMs: 20 })).rejects.toThrow(/timed out/);

      // Evicted despite the rejection: the cache must not keep serving an ended
      // logger just because its drain overran the deadline.
      const b = createLogger(options);
      expect(b).not.toBe(a);
      expect(b.transports.length).toBeGreaterThan(0);

      // Retry by reference still works — `shutdownLogger` never reads the
      // registry, so eviction cannot break the documented escalate-with-a-
      // longer-timeout idiom.
      releaseFinal?.();
      await expect(shutdownLogger(a, { timeoutMs: 2000 })).resolves.toBeUndefined();

      await shutdownLogger(b);
      teardownLogger(a);
      teardownLogger(b);
    });

    it("evicts when a logger is torn down via close() or end() directly (Phase 2)", async () => {
      // `shutdownLogger` is not the only door to a dead logger. Winston's
      // `close()` runs `clear()` -> `unpipe()`, and `end()` drives
      // `Logger._final` which ends every transport (Node then auto-unpipes
      // each) — both leave `transports` empty and silently discard writes. A
      // cached entry would keep serving that corpse.
      const root = createTempDir();
      const closeOptions = {
        moduleName: "evict-close",
        logDirectory: root,
        includeConsole: false,
        includeGlobalFile: false,
      };
      const a = createLogger(closeOptions);
      a.close();
      const a2 = createLogger(closeOptions);
      expect(a2).not.toBe(a);
      expect(a2.transports.length).toBeGreaterThan(0);

      const endOptions = {
        moduleName: "evict-end",
        logDirectory: root,
        includeConsole: false,
        includeGlobalFile: false,
      };
      const b = createLogger(endOptions);
      b.end();
      const b2 = createLogger(endOptions);
      expect(b2).not.toBe(b);

      // The replacement is genuinely functional, not merely a new object.
      b2.info("REPLACED-AFTER-END");
      await shutdownLogger(b2);
      expect(readLogFiles(root, "evict-end")).toContain("REPLACED-AFTER-END");

      await shutdownLogger(a2);
      teardownLogger(a);
      teardownLogger(a2);
      teardownLogger(b);
      teardownLogger(b2);
    });

    it("only evicts when the registry slot still points at the shut-down logger (Phase 2)", async () => {
      // `proxyToRegistryKey` can outlive the slot it names. After a
      // `resetLoggerRegistry()` the same key is re-claimed by a DIFFERENT, live
      // logger; shutting the old detached instance down must not evict its
      // replacement out of the cache.
      const root = createTempDir();
      const options = {
        moduleName: "evict-identity",
        logDirectory: root,
        includeConsole: false,
        includeGlobalFile: false,
      };

      const a = createLogger(options);
      resetLoggerRegistry();
      const b = createLogger(options);
      expect(b).not.toBe(a);

      // Shutting down the detached `a` must leave `b`'s slot alone.
      await shutdownLogger(a);
      expect(createLogger(options)).toBe(b);

      b.info("IDENTITY-GUARD-LINE");
      await shutdownLogger(b);
      expect(readLogFiles(root, "evict-identity")).toContain("IDENTITY-GUARD-LINE");
      teardownLogger(a);
      teardownLogger(b);
    });

    it("shutting down a never-registered logger evicts nothing and does not throw (Phase 2)", async () => {
      // A `createNoopLogger()` result (and any winston logger the caller built
      // themselves) has no `proxyToRegistryKey` entry — the eviction must be a
      // clean no-op rather than an error or a stray registry delete.
      const root = createTempDir();
      const cached = createLogger({
        moduleName: "evict-noop-bystander",
        logDirectory: root,
        includeConsole: false,
        includeGlobalFile: false,
      });

      await expect(shutdownLogger(createNoopLogger())).resolves.toBeUndefined();

      // The unrelated cached logger is untouched.
      expect(
        createLogger({
          moduleName: "evict-noop-bystander",
          logDirectory: root,
          includeConsole: false,
          includeGlobalFile: false,
        }),
      ).toBe(cached);
      await shutdownLogger(cached);
      teardownLogger(cached);
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
      teardownLogger(logger);
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
      teardownLogger(logger);
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
      teardownLogger(logger);
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
    // Winston installs one `uncaughtException` + one `unhandledRejection`
    // process listener per logger whose transports carry
    // `handleExceptions`/`handleRejections`. As of v1.0.0 this package sets
    // NEITHER flag on any transport and instead registers with a process-wide
    // coordinator that owns a single listener pair. These tests pin that
    // contract: no transport carries the flags, winston installs no per-logger
    // catcher, and N loggers still cost exactly one listener pair.

    const noFlags = (transport: winston.transport): void => {
      const t = transport as unknown as { handleExceptions?: boolean; handleRejections?: boolean };
      expect(t.handleExceptions === true).toBe(false);
      expect(t.handleRejections === true).toBe(false);
    };

    it("sets no handleExceptions/handleRejections flag on any transport (file/console/global)", () => {
      const root = createTempDir();
      const logger = createLogger({
        moduleName: "uncaught-file-only",
        logDirectory: root,
        includeConsole: true,
        includeFile: true,
        includeGlobalFile: true,
        captureUncaught: true,
      });

      expect(logger.transports.length).toBeGreaterThan(0);
      logger.transports.forEach(noFlags);

      teardownLogger(logger);
    });

    it("sets no flag on additionalTransports either", () => {
      const stub = new StubTransport();
      const logger = createLogger({
        moduleName: "uncaught-additional-only",
        includeConsole: false,
        includeFile: false,
        includeGlobalFile: false,
        additionalTransports: [stub as unknown as winston.transport],
        captureUncaught: true,
      });

      noFlags(stub as unknown as winston.transport);

      teardownLogger(logger);
    });

    it("winston canary: a capture-enabled logger installs NO per-logger process catcher", () => {
      const root = createTempDir();
      const logger = createLogger({
        moduleName: "uncaught-canary",
        logDirectory: root,
        captureUncaught: true,
      });

      // `logger.exceptions` / `logger.rejections` pass through the Proxy to the
      // real winston handler objects. Because no transport carries the flags,
      // winston's `add()` never calls `exceptions.handle()`, so its `catcher`
      // slot stays `false` and its `handlers` map stays empty — proving the
      // per-logger process listener was NOT installed by winston.
      const exc = (
        logger as unknown as { exceptions: { catcher: unknown; handlers: Map<unknown, unknown> } }
      ).exceptions;
      const rej = (
        logger as unknown as { rejections: { catcher: unknown; handlers: Map<unknown, unknown> } }
      ).rejections;
      expect(exc.catcher).toBeFalsy();
      expect(rej.catcher).toBeFalsy();
      expect(exc.handlers.size).toBe(0);
      expect(rej.handlers.size).toBe(0);

      teardownLogger(logger);
    });

    it("N distinct-module loggers add exactly ONE process-listener pair (the core fix)", () => {
      const beforeUncaught = process.listenerCount("uncaughtException");
      const beforeUnhandled = process.listenerCount("unhandledRejection");

      const loggers = Array.from({ length: 11 }, (_unused, i) =>
        createLogger({
          moduleName: `leak-mod-${i}`,
          includeConsole: false,
          includeFile: false,
          includeGlobalFile: false,
          additionalTransports: [new StubTransport() as unknown as winston.transport],
          captureUncaught: true,
        }),
      );

      // The pre-v1.0.0 behavior added 11 + 11 here; the coordinator adds 1 + 1.
      expect(process.listenerCount("uncaughtException") - beforeUncaught).toBe(1);
      expect(process.listenerCount("unhandledRejection") - beforeUnhandled).toBe(1);

      loggers.forEach((logger) => teardownLogger(logger));
    });

    it("captureUncaught:false registers nothing and adds no process listener", () => {
      const beforeUncaught = process.listenerCount("uncaughtException");
      const beforeUnhandled = process.listenerCount("unhandledRejection");

      const logger = createLogger({
        moduleName: "uncaught-disabled",
        includeConsole: false,
        includeFile: false,
        includeGlobalFile: false,
        additionalTransports: [new StubTransport() as unknown as winston.transport],
        captureUncaught: false,
      });

      expect(process.listenerCount("uncaughtException") - beforeUncaught).toBe(0);
      expect(process.listenerCount("unhandledRejection") - beforeUnhandled).toBe(0);
      expect(__crashCaptureInternals.isInstalled()).toBe(false);
      logger.transports.forEach(noFlags);

      teardownLogger(logger);
    });

    it("strips crash flags from a caller-supplied transport that arrives pre-flagged", () => {
      // A pre-flagged additionalTransport would make winston's add() install a
      // process listener for THIS logger — silently re-creating the exact
      // per-logger leak this release removes — and double-log every crash.
      const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
      const beforeUncaught = process.listenerCount("uncaughtException");
      const beforeUnhandled = process.listenerCount("unhandledRejection");

      const flagged = new StubTransport();
      (flagged as unknown as { handleExceptions: boolean }).handleExceptions = true;
      (flagged as unknown as { handleRejections: boolean }).handleRejections = true;

      const a = createLogger({
        moduleName: "preflagged-a",
        includeConsole: false,
        includeFile: false,
        includeGlobalFile: false,
        additionalTransports: [flagged as unknown as winston.transport],
      });

      const flagged2 = new StubTransport();
      (flagged2 as unknown as { handleExceptions: boolean }).handleExceptions = true;
      const b = createLogger({
        moduleName: "preflagged-b",
        includeConsole: false,
        includeFile: false,
        includeGlobalFile: false,
        additionalTransports: [flagged2 as unknown as winston.transport],
      });

      noFlags(flagged as unknown as winston.transport);
      noFlags(flagged2 as unknown as winston.transport);
      // Still exactly ONE pair total — not one per logger.
      expect(process.listenerCount("uncaughtException") - beforeUncaught).toBe(1);
      expect(process.listenerCount("unhandledRejection") - beforeUnhandled).toBe(1);

      // Explained once per process, not once per logger.
      const stripWarnings = warn.mock.calls.filter((call) =>
        String(call[0]).includes("handleExceptions"),
      );
      expect(stripWarnings).toHaveLength(1);

      [a, b].forEach((logger) => teardownLogger(logger));
    });

    it("removes the process-listener pair once every logger is shut down", async () => {
      const beforeUncaught = process.listenerCount("uncaughtException");
      const beforeUnhandled = process.listenerCount("unhandledRejection");

      const a = createLogger({
        moduleName: "hygiene-a",
        includeConsole: false,
        includeFile: false,
        includeGlobalFile: false,
        additionalTransports: [new StubTransport() as unknown as winston.transport],
      });
      const b = createLogger({
        moduleName: "hygiene-b",
        includeConsole: false,
        includeFile: false,
        includeGlobalFile: false,
        additionalTransports: [new StubTransport() as unknown as winston.transport],
      });

      expect(process.listenerCount("uncaughtException") - beforeUncaught).toBe(1);

      await shutdownLogger(a);
      // One logger still registered → listener stays installed.
      expect(process.listenerCount("uncaughtException") - beforeUncaught).toBe(1);
      expect(__crashCaptureInternals.isInstalled()).toBe(true);

      await shutdownLogger(b);
      // Last logger gone → coordinator uninstalls its pair.
      expect(process.listenerCount("uncaughtException") - beforeUncaught).toBe(0);
      expect(process.listenerCount("unhandledRejection") - beforeUnhandled).toBe(0);
      expect(__crashCaptureInternals.isInstalled()).toBe(false);
    });
  });

  describe("shared global-file transport", () => {
    const sharedEntry = (): {
      transport: winston.transport;
      refCount: number;
      handles: Set<winston.transport>;
    } => {
      const entries = Array.from(__sharedFileInternals.sharedFileRegistry.values());
      expect(entries).toHaveLength(1);
      return entries[0];
    };

    it("gives every logger on the same global path ONE underlying transport", () => {
      const root = createTempDir();
      const a = createLogger({ moduleName: "share-a", logDirectory: root, includeConsole: false });
      const b = createLogger({ moduleName: "share-b", logDirectory: root, includeConsole: false });
      const c = createLogger({ moduleName: "share-c", logDirectory: root, includeConsole: false });

      // One real rotating-file transport (one file handle, one rotation state
      // machine) backing all three loggers — the pre-v1.0.0 behavior built one
      // DailyRotateFile per logger against the same path.
      expect(__sharedFileInternals.sharedFileRegistry.size).toBe(1);
      expect(sharedEntry().refCount).toBe(3);

      // Each logger still holds its own module file, plus a forwarding handle.
      expect(moduleRotatingTransports(a)).toHaveLength(1);
      expect(moduleRotatingTransports(b)).toHaveLength(1);

      [a, b, c].forEach((logger) => teardownLogger(logger));
    });

    it("a repeat createLogger() cache hit does not double-count the refcount", () => {
      const root = createTempDir();
      const first = createLogger({
        moduleName: "share-cache",
        logDirectory: root,
        includeConsole: false,
      });
      const second = createLogger({
        moduleName: "share-cache",
        logDirectory: root,
        includeConsole: false,
      });

      expect(second).toBe(first);
      expect(sharedEntry().refCount).toBe(1);

      teardownLogger(first);
    });

    it("writes from every sharing logger reach the shared file with their own labels", async () => {
      const root = createTempDir();
      const a = createLogger({ moduleName: "label-a", logDirectory: root, includeConsole: false });
      const b = createLogger({ moduleName: "label-b", logDirectory: root, includeConsole: false });

      const written: string[] = [];
      const shared = sharedEntry().transport as unknown as {
        log: (i: unknown, cb: () => void) => void;
      };
      const original = shared.log.bind(shared);
      shared.log = (info: unknown, cb: () => void): void => {
        written.push(String((info as Record<symbol, unknown>)[Symbol.for("message")]));
        original(info, cb);
      };

      a.info("from-a");
      b.info("from-b");
      await new Promise((resolve) => setTimeout(resolve, 60));

      expect(written.some((line) => line.includes("(label-a)") && line.includes("from-a"))).toBe(
        true,
      );
      expect(written.some((line) => line.includes("(label-b)") && line.includes("from-b"))).toBe(
        true,
      );

      [a, b].forEach((logger) => teardownLogger(logger));
    });

    it("keeps per-logger level gating despite sharing one transport", async () => {
      const root = createTempDir();
      const quiet = createLogger({
        moduleName: "gate-quiet",
        logDirectory: root,
        includeConsole: false,
        level: "info",
      });
      const chatty = createLogger({
        moduleName: "gate-chatty",
        logDirectory: root,
        includeConsole: false,
        level: "debug",
      });

      const written: string[] = [];
      const shared = sharedEntry().transport as unknown as {
        log: (i: unknown, cb: () => void) => void;
      };
      const original = shared.log.bind(shared);
      shared.log = (info: unknown, cb: () => void): void => {
        written.push(String((info as { message?: unknown }).message));
        original(info, cb);
      };

      quiet.debug("dropped-by-level");
      chatty.debug("kept-by-level");
      await new Promise((resolve) => setTimeout(resolve, 60));

      expect(written).toContain("kept-by-level");
      expect(written).not.toContain("dropped-by-level");

      [quiet, chatty].forEach((logger) => teardownLogger(logger));
    });

    it("shutting one logger down leaves the shared file open for the others", async () => {
      const root = createTempDir();
      const a = createLogger({ moduleName: "live-a", logDirectory: root, includeConsole: false });
      const b = createLogger({ moduleName: "live-b", logDirectory: root, includeConsole: false });

      const entry = sharedEntry();
      const shared = entry.transport as unknown as { log: (i: unknown, cb: () => void) => void };
      const written: string[] = [];
      const original = shared.log.bind(shared);
      shared.log = (info: unknown, cb: () => void): void => {
        written.push(String((info as { message?: unknown }).message));
        original(info, cb);
      };

      await shutdownLogger(a);

      // The naive "share the DailyRotateFile itself" approach fails here:
      // winston's _final would have ended the shared transport during a's
      // shutdown and b's write would be dropped.
      expect(entry.refCount).toBe(1);
      b.info("still-writing");
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(written).toContain("still-writing");

      await shutdownLogger(b);
    });

    it("releases and closes the underlying transport only on the last release", async () => {
      const root = createTempDir();
      const a = createLogger({ moduleName: "rel-a", logDirectory: root, includeConsole: false });
      const b = createLogger({ moduleName: "rel-b", logDirectory: root, includeConsole: false });

      const entry = sharedEntry();
      expect(entry.refCount).toBe(2);

      await shutdownLogger(a);
      expect(entry.refCount).toBe(1);
      expect(__sharedFileInternals.sharedFileRegistry.size).toBe(1);

      await shutdownLogger(b);
      expect(entry.refCount).toBe(0);
      // Last handle gone → the entry is dropped and the real transport closed.
      expect(__sharedFileInternals.sharedFileRegistry.size).toBe(0);
      expect(entry.handles.size).toBe(0);
    });

    it("warns once when a second logger requests a conflicting global rotation", () => {
      const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
      const root = createTempDir();

      const a = createLogger({
        moduleName: "rot-a",
        logDirectory: root,
        includeConsole: false,
        globalRotation: { maxFiles: "7d" },
      });
      const b = createLogger({
        moduleName: "rot-b",
        logDirectory: root,
        includeConsole: false,
        globalRotation: { maxFiles: "30d" },
      });
      const c = createLogger({
        moduleName: "rot-c",
        logDirectory: root,
        includeConsole: false,
        globalRotation: { maxFiles: "90d" },
      });

      const conflictWarnings = warn.mock.calls.filter((call) =>
        String(call[0]).includes("Conflicting global-file rotation config"),
      );
      // Latched: one warning for the path, no matter how many conflict.
      expect(conflictWarnings).toHaveLength(1);
      // The creator's config wins.
      expect(sharedGlobalTransports()[0].options.maxFiles).toBe("7d");

      [a, b, c].forEach((logger) => teardownLogger(logger));
    });

    it("does not warn when two sharing loggers differ only by global maxSize unit case (P13b)", () => {
      // Two DIFFERENT module names (distinct registry keys, both created) that
      // share the global file with global rotation maxSize "20m" vs "20M". Since
      // resolvedGlobalRotation feeds the shared-file rotationSignature and
      // maxSize is now normalized before it is built, the two signatures agree
      // and the shared-file rotation-conflict warning must NOT fire. Against the
      // pre-Phase-13 code (raw maxSize in the signature) this warned.
      const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
      const root = createTempDir();

      const a = createLogger({
        moduleName: "size-a",
        logDirectory: root,
        includeConsole: false,
        includeFile: false,
        globalRotation: { maxSize: "20m", maxFiles: "14d" },
      });
      const b = createLogger({
        moduleName: "size-b",
        logDirectory: root,
        includeConsole: false,
        includeFile: false,
        globalRotation: { maxSize: "20M", maxFiles: "14d" },
      });

      const conflictWarnings = warn.mock.calls.filter((call) =>
        String(call[0]).includes("Conflicting global-file rotation config"),
      );
      expect(conflictWarnings).toHaveLength(0);

      [a, b].forEach((logger) => teardownLogger(logger));
    });

    it("fans the shared transport's error events out to every sharing logger", () => {
      const root = createTempDir();
      const errorsA: Error[] = [];
      const errorsB: Error[] = [];
      const a = createLogger({
        moduleName: "err-a",
        logDirectory: root,
        includeConsole: false,
        onTransportError: (err) => errorsA.push(err),
      });
      const b = createLogger({
        moduleName: "err-b",
        logDirectory: root,
        includeConsole: false,
        onTransportError: (err) => errorsB.push(err),
      });

      const entry = sharedEntry();
      // Exactly ONE error listener on the shared transport regardless of how
      // many loggers share it — attaching one per logger would recreate a
      // MaxListenersExceededWarning on the transport itself.
      expect(entry.transport.listenerCount("error")).toBe(1);

      entry.transport.emit("error", new Error("disk-on-fire"));

      expect(errorsA.map((e) => e.message)).toContain("disk-on-fire");
      expect(errorsB.map((e) => e.message)).toContain("disk-on-fire");

      [a, b].forEach((logger) => teardownLogger(logger));
    });

    describe("release semantics for non-DailyRotateFile sinks", () => {
      // `acquireSharedGlobalFile` takes an injected transport factory, so these
      // drive the release path directly against stub sinks to pin its contract
      // for transports that do not behave like a DailyRotateFile.
      const acquireWithSink = (sink: unknown, key: string): winston.transport =>
        acquireSharedGlobalFile({
          key,
          level: "info",
          rotationSignature: "{}",
          createTransport: () => sink as winston.transport,
        });

      const endHandle = (handle: winston.transport): Promise<void> =>
        new Promise<void>((resolve) => {
          handle.once("finish", () => resolve());
          (handle as unknown as { end: () => void }).end();
        });

      it("releases when the sink exposes no end() method", async () => {
        const sink = new EventEmitter();
        const handle = acquireWithSink(sink, "sink-without-end");

        // Must not hang: with no end() to await, the release settles at once.
        await expect(endHandle(handle)).resolves.toBeUndefined();
        expect(__sharedFileInternals.sharedFileRegistry.has("sink-without-end")).toBe(false);
      });

      it("releases even when the sink's end() throws", async () => {
        const sink = Object.assign(new EventEmitter(), {
          end: (): never => {
            throw new Error("already torn down");
          },
        });
        const handle = acquireWithSink(sink, "sink-end-throws");

        await expect(endHandle(handle)).resolves.toBeUndefined();
        expect(__sharedFileInternals.sharedFileRegistry.has("sink-end-throws")).toBe(false);
      });

      it("reports (not throws) a sink error that arrives after the last release", async () => {
        // The shared transport is never piped into a logger, so the fan-out
        // listener is its ONLY `error` listener. DailyRotateFile keeps emitting
        // asynchronously after release (pruning, gzip). Detaching would leave an
        // EventEmitter with zero error listeners, turning the next such error
        // into an ERR_UNHANDLED_ERROR that kills the process.
        const err = jest.spyOn(console, "error").mockImplementation(() => undefined);
        const sink: EventEmitter & { close?: () => void } = new EventEmitter();
        sink.close = (): void => {
          sink.emit("finish");
        };
        const handle = acquireWithSink(sink, "sink-late-error");
        await endHandle(handle);

        expect(sink.listenerCount("error")).toBeGreaterThan(0);
        expect(() => sink.emit("error", new Error("gzip failed after release"))).not.toThrow();
        expect(
          err.mock.calls.some((call) => String(call[0]).includes("gzip failed after release")),
        ).toBe(true);

        // A non-Error payload must stringify rather than read `.message` off it.
        expect(() => sink.emit("error", "raw-string-failure")).not.toThrow();
        expect(err.mock.calls.some((call) => String(call[0]).includes("raw-string-failure"))).toBe(
          true,
        );
      });

      it("closes the underlying sink at most once across release and exit-flush", async () => {
        let closeCount = 0;
        const sink: EventEmitter & { close?: () => void } = new EventEmitter();
        sink.close = (): void => {
          closeCount += 1;
          sink.emit("finish");
        };
        const handle = acquireWithSink(sink, "sink-close-once");

        // The exit flush and the last release both ask for teardown; the
        // memoised closePromise means one real close(), one shared drain.
        await Promise.all([flushSharedFileTransportsForExit(), endHandle(handle)]);
        await flushSharedFileTransportsForExit();

        expect(closeCount).toBe(1);
      });

      it("settles exactly once when the sink emits both finish and close", async () => {
        const sink: EventEmitter & { end?: () => void } = new EventEmitter();
        sink.end = (): void => {
          // A sink that announces teardown twice must not double-invoke the
          // stream _final callback (Node throws on a repeat callback).
          sink.emit("finish");
          sink.emit("close");
        };
        const handle = acquireWithSink(sink, "sink-double-signal");

        let finishCount = 0;
        handle.on("finish", () => {
          finishCount += 1;
        });
        await endHandle(handle);
        await new Promise((resolve) => setTimeout(resolve, 20));

        expect(finishCount).toBe(1);
      });
    });

    it("does not create a shared transport when includeGlobalFile is false", () => {
      const root = createTempDir();
      const logger = createLogger({
        moduleName: "no-global",
        logDirectory: root,
        includeConsole: false,
        includeGlobalFile: false,
      });

      expect(__sharedFileInternals.sharedFileRegistry.size).toBe(0);
      teardownLogger(logger);
    });
  });

  describe("crash-capture coordinator", () => {
    let exitFn: jest.Mock;

    beforeEach(() => {
      exitFn = jest.fn();
      __crashCaptureInternals.setExitFn(exitFn);
    });

    afterEach(() => {
      __crashCaptureInternals.restoreExitFn();
    });

    const makeCaptureLogger = (
      moduleName: string,
      overrides: Record<string, unknown> = {},
    ): { logger: winston.Logger; stub: StubTransport } => {
      const stub = new StubTransport();
      const logger = createLogger({
        moduleName,
        includeConsole: false,
        includeFile: false,
        includeGlobalFile: false,
        additionalTransports: [stub as unknown as winston.transport],
        captureUncaught: true,
        ...overrides,
      });
      return { logger, stub };
    };

    const flushMicrotasks = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

    it("logs an uncaughtException exactly once through the primary logger", async () => {
      const { stub } = makeCaptureLogger("crash-primary", { exitOnUncaught: false });

      __crashCaptureInternals.invokeUncaught(new Error("boom-uncaught"));
      await flushMicrotasks();

      expect(stub.log).toHaveBeenCalledTimes(1);
      const info = stub.log.mock.calls[0][0] as {
        crash?: string;
        exception?: boolean;
        message?: string;
        stack?: string;
        process?: unknown;
        trace?: unknown;
      };
      // The crash is surfaced under the non-filtered `crash` key. Winston's
      // reserved `exception` marker is deliberately stripped: `winston-transport`
      // drops `{ exception: true }` from every transport that lacks
      // `handleExceptions`, and this package sets that flag on no transport.
      expect(info.crash).toBe("uncaughtException");
      expect(info.exception).toBeUndefined();
      expect(String(info.message)).toContain("uncaughtException: boom-uncaught");
      // The full winston diagnostic payload still rides along.
      expect(info.stack).toContain("boom-uncaught");
      expect(info.process).toBeDefined();
      expect(Array.isArray(info.trace)).toBe(true);
    });

    it("logs an unhandledRejection through the primary with the rejection marker", async () => {
      const { stub } = makeCaptureLogger("crash-rejection", { exitOnUncaught: false });

      __crashCaptureInternals.invokeUnhandled(new Error("boom-rejection"));
      await flushMicrotasks();

      expect(stub.log).toHaveBeenCalledTimes(1);
      const info = stub.log.mock.calls[0][0] as {
        crash?: string;
        rejection?: boolean;
        message?: string;
      };
      expect(info.crash).toBe("unhandledRejection");
      expect(info.rejection).toBeUndefined();
      expect(String(info.message)).toContain("unhandledRejection: boom-rejection");
    });

    it("de-duplicates: only the primary logs the crash when multiple loggers are registered", async () => {
      const { stub: stubA } = makeCaptureLogger("crash-dedup-a", { exitOnUncaught: false });
      const { stub: stubB } = makeCaptureLogger("crash-dedup-b", { exitOnUncaught: false });

      __crashCaptureInternals.invokeUncaught(new Error("boom-dedup"));
      await flushMicrotasks();

      expect(stubA.log).toHaveBeenCalledTimes(1);
      expect(stubB.log).not.toHaveBeenCalled();
    });

    it("exits the process with code 1 by default after logging", async () => {
      makeCaptureLogger("crash-exit-default");

      __crashCaptureInternals.invokeUncaught(new Error("fatal"));
      // Allow the flush-then-exit race to settle.
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(exitFn).toHaveBeenCalledTimes(1);
      expect(exitFn).toHaveBeenCalledWith(1);
    });

    it("does not exit when exitOnUncaught is false", async () => {
      const { stub } = makeCaptureLogger("crash-no-exit", { exitOnUncaught: false });

      __crashCaptureInternals.invokeUncaught(new Error("survivable"));
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(stub.log).toHaveBeenCalledTimes(1);
      expect(exitFn).not.toHaveBeenCalled();
    });

    it("makes the exit decision independent of creation order (opt-out honored either way)", async () => {
      // Two loggers: one opts out, one keeps the default (exit). Whichever is
      // created first wins the primary election — but the exit decision must be
      // the SAME in both orders. Before the fix `onFatal` consulted only the
      // elected primary's policy, so swapping the creation order of these two
      // unrelated loggers flipped whether the process exited.

      // Order 1: the opt-out logger is created first, so it is elected primary.
      makeCaptureLogger("crash-order-optout-first", { exitOnUncaught: false });
      makeCaptureLogger("crash-order-default-first"); // default exitOnUncaught: true
      const primaryOrder1 = __crashCaptureInternals.getPrimaryEntry();
      __crashCaptureInternals.invokeUncaught(new Error("fatal-order-1"));
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Fresh coordinator, swapped order: the default (exit) logger is created
      // first, so it is elected primary this time.
      resetLoggerRegistry();
      makeCaptureLogger("crash-order-default-second"); // default true, elected primary
      makeCaptureLogger("crash-order-optout-second", { exitOnUncaught: false });
      const primaryOrder2 = __crashCaptureInternals.getPrimaryEntry();
      __crashCaptureInternals.invokeUncaught(new Error("fatal-order-2"));
      await new Promise((resolve) => setTimeout(resolve, 100));

      // A DIFFERENT logger was elected primary in each order...
      expect(primaryOrder1?.[0]).toBeDefined();
      expect(primaryOrder2?.[0]).toBeDefined();
      expect(primaryOrder1?.[0]).not.toBe(primaryOrder2?.[0]);
      // ...yet the exit decision is identical: the explicit opt-out vetoes the
      // exit in BOTH orders, so the process never exits.
      expect(exitFn).not.toHaveBeenCalled();
    });

    it("a non-primary logger's opt-out vetoes the exit the elected primary would have taken", async () => {
      // The elected primary keeps the default (exit); an unrelated logger opts
      // out afterwards. The opt-out must still win — this is the exact case the
      // old primary-only decision got wrong (it exited, silently ignoring the
      // documented per-logger opt-out).
      const { stub: primaryStub } = makeCaptureLogger("crash-veto-primary"); // default true, elected
      makeCaptureLogger("crash-veto-optout", { exitOnUncaught: false });

      __crashCaptureInternals.invokeUncaught(new Error("vetoed"));
      await new Promise((resolve) => setTimeout(resolve, 100));

      // The crash is still recorded exactly once, through the elected primary:
      // consensus governs only whether to EXIT, never where the crash is logged.
      expect(primaryStub.log).toHaveBeenCalledTimes(1);
      // The process does NOT exit: a single opt-out vetoes the whole process.
      expect(exitFn).not.toHaveBeenCalled();
    });

    it("still exits when every registered logger keeps the default exit policy", async () => {
      // Consensus over multiple loggers that all allow exit must still exit; the
      // veto only fires on an explicit opt-out, so an all-default fleet is
      // unaffected.
      makeCaptureLogger("crash-consensus-exit-a"); // default exitOnUncaught: true
      makeCaptureLogger("crash-consensus-exit-b"); // default exitOnUncaught: true

      __crashCaptureInternals.invokeUncaught(new Error("all-agree-exit"));
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(exitFn).toHaveBeenCalledTimes(1);
      expect(exitFn).toHaveBeenCalledWith(1);
    });

    it("re-elects a new primary after the current primary is shut down", async () => {
      const { logger: loggerA, stub: stubA } = makeCaptureLogger("crash-reelect-a", {
        exitOnUncaught: false,
      });
      const { stub: stubB } = makeCaptureLogger("crash-reelect-b", { exitOnUncaught: false });

      // A is the primary; shutting it down deregisters it and promotes B.
      await shutdownLogger(loggerA);

      __crashCaptureInternals.invokeUncaught(new Error("after-reelect"));
      await flushMicrotasks();

      expect(stubB.log).toHaveBeenCalledTimes(1);
      // A was shut down before the crash, so it must not receive it.
      const aCrashCalls = stubA.log.mock.calls.filter((call) =>
        String((call[0] as { message?: unknown }).message).includes("after-reelect"),
      );
      expect(aCrashCalls).toHaveLength(0);
    });

    it("logger.close() leaves crash capture so a closed logger cannot swallow the crash", async () => {
      // Winston's own close() calls exceptions.unhandle(), so before v1.0.0
      // closing a logger inherently stopped its capture. Without deregistering
      // here, a closed-but-registered logger stays the elected primary and the
      // next crash is routed into its ended stream — winston drops the write and
      // the no-op error listener swallows the failure, losing the crash entirely.
      const { logger: closed, stub: closedStub } = makeCaptureLogger("crash-closed", {
        exitOnUncaught: false,
      });
      const { stub: liveStub } = makeCaptureLogger("crash-live", { exitOnUncaught: false });

      closed.close();

      __crashCaptureInternals.invokeUncaught(new Error("after-close"));
      await flushMicrotasks();

      // The live logger is promoted and records the crash; the closed one does not.
      expect(liveStub.log).toHaveBeenCalledTimes(1);
      expect((liveStub.log.mock.calls[0][0] as { crash?: string }).crash).toBe("uncaughtException");
      expect(closedStub.log).not.toHaveBeenCalled();
    });

    it("is a no-op when no logger is registered", async () => {
      // No capture logger created in this test → there is no primary entry.
      __crashCaptureInternals.invokeUncaught(new Error("orphan"));
      await flushMicrotasks();

      expect(exitFn).not.toHaveBeenCalled();
    });

    it("the listeners actually installed on process route into the coordinator", async () => {
      // Everything else in this suite drives `onFatal` directly. This test
      // instead grabs the real functions the coordinator handed to
      // `process.on(...)` and invokes those, proving the process wiring itself
      // is correct end-to-end (rather than only the handler behind it).
      const beforeUncaught = new Set(process.listeners("uncaughtException"));
      const beforeUnhandled = new Set(process.listeners("unhandledRejection"));

      const { stub } = makeCaptureLogger("crash-wiring", { exitOnUncaught: false });

      const uncaughtListener = process
        .listeners("uncaughtException")
        .find((listener) => !beforeUncaught.has(listener));
      const unhandledListener = process
        .listeners("unhandledRejection")
        .find((listener) => !beforeUnhandled.has(listener));

      expect(uncaughtListener).toBeDefined();
      expect(unhandledListener).toBeDefined();

      (uncaughtListener as (err: Error) => void)(new Error("via-real-listener"));
      (unhandledListener as (reason: unknown) => void)(new Error("via-real-rejection"));
      await flushMicrotasks();

      expect(stub.log).toHaveBeenCalledTimes(2);
      expect((stub.log.mock.calls[0][0] as { crash?: string }).crash).toBe("uncaughtException");
      expect((stub.log.mock.calls[1][0] as { crash?: string }).crash).toBe("unhandledRejection");
    });

    it("latches so a second fatal during the exit window cannot race a second exit", async () => {
      makeCaptureLogger("crash-latch");

      __crashCaptureInternals.invokeUncaught(new Error("first"));
      __crashCaptureInternals.invokeUncaught(new Error("second"));
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(exitFn).toHaveBeenCalledTimes(1);
    });

    it("shutdownLogger on a logger it never created is a safe no-op", async () => {
      // Exercises the Proxy→base fallback: a logger that was never minted by
      // createLogger has no entry in the Proxy→base map, so the raw logger is
      // passed straight to deregisterCrashCapture (which ignores unknowns).
      await expect(shutdownLogger(createNoopLogger())).resolves.toBeUndefined();
    });

    describe("defensive paths", () => {
      /**
       * Builds a minimal winston-Logger-shaped stub exposing exactly the
       * surface the coordinator touches (`exceptions`/`rejections.getAllInfo`,
       * `log`, `transports`, `end`) so each failure mode can be driven
       * deterministically without a real transport stack.
       */
      const fakeLogger = (opts: {
        getAllInfoThrows?: boolean;
        logThrows?: boolean;
        endThrows?: boolean;
        transports?: unknown[];
      }): winston.Logger => {
        const handler = {
          getAllInfo: opts.getAllInfoThrows
            ? (): never => {
                throw new Error("getAllInfo exploded");
              }
            : (): Record<string, unknown> => ({
                level: "error",
                message: "synthetic",
                exception: true,
              }),
        };
        return {
          exceptions: handler,
          rejections: handler,
          transports: opts.transports ?? [],
          log: opts.logThrows
            ? (): never => {
                throw new Error("transport exploded");
              }
            : jest.fn(),
          end: opts.endThrows
            ? (): never => {
                throw new Error("end exploded");
              }
            : jest.fn(),
        } as unknown as winston.Logger;
      };

      it("falls back to a synthetic payload when getAllInfo throws (Error input)", async () => {
        const fake = fakeLogger({ getAllInfoThrows: true });
        __crashCaptureInternals.registerCrashCapture(fake, {
          exitOnUncaught: false,
          hasFileTransport: false,
        });

        __crashCaptureInternals.invokeUncaught(new Error("boom-fallback"));
        await flushMicrotasks();

        const log = fake.log as unknown as jest.Mock;
        expect(log).toHaveBeenCalledTimes(1);
        expect(String((log.mock.calls[0][0] as { message: unknown }).message)).toBe(
          "uncaughtException: boom-fallback",
        );
      });

      it("falls back to a synthetic payload when getAllInfo throws (non-Error input)", async () => {
        const fake = fakeLogger({ getAllInfoThrows: true });
        __crashCaptureInternals.registerCrashCapture(fake, {
          exitOnUncaught: false,
          hasFileTransport: false,
        });

        __crashCaptureInternals.invokeUnhandled("just-a-string");
        await flushMicrotasks();

        const log = fake.log as unknown as jest.Mock;
        expect(String((log.mock.calls[0][0] as { message: unknown }).message)).toBe(
          "unhandledRejection: just-a-string",
        );
      });

      it("does not rethrow when the primary logger's log() throws", () => {
        const fake = fakeLogger({ logThrows: true });
        __crashCaptureInternals.registerCrashCapture(fake, {
          exitOnUncaught: false,
          hasFileTransport: false,
        });

        // A throwing transport must never escalate out of the process listener.
        expect(() => __crashCaptureInternals.invokeUncaught(new Error("boom"))).not.toThrow();
      });

      it("still exits when the primary logger's end() throws during the flush", async () => {
        const fake = fakeLogger({ endThrows: true });
        __crashCaptureInternals.registerCrashCapture(fake, {
          exitOnUncaught: true,
          hasFileTransport: false,
        });

        __crashCaptureInternals.invokeUncaught(new Error("boom"));
        await new Promise((resolve) => setTimeout(resolve, 100));

        expect(exitFn).toHaveBeenCalledWith(1);
      });

      it("drains via close(), NOT end(), for a close()-capable transport", async () => {
        // A DailyRotateFile defines no _final: end() emits `finish` on the next
        // tick while its logStream is still buffering (verified: 0 bytes on
        // disk). Only close() truly drains. Since the exit path calls
        // process.exit(1) the instant the flush resolves, using end() here would
        // race the write and lose the crash record.
        const events: string[] = [];
        const sink = new EventEmitter() as EventEmitter & {
          close?: () => void;
          end?: () => void;
        };
        sink.close = (): void => {
          events.push("close");
          sink.emit("finish");
        };
        sink.end = (): void => {
          events.push("end");
        };

        const fake = fakeLogger({ transports: [sink] });
        __crashCaptureInternals.registerCrashCapture(fake, {
          exitOnUncaught: true,
          hasFileTransport: false,
        });

        __crashCaptureInternals.invokeUncaught(new Error("fatal"));
        await new Promise((resolve) => setTimeout(resolve, 100));

        expect(events).toEqual(["close"]);
        expect(exitFn).toHaveBeenCalledWith(1);
      });

      it("falls back to end() for a transport that exposes no close()", async () => {
        const events: string[] = [];
        const sink = new EventEmitter() as EventEmitter & { end?: () => void };
        sink.end = (): void => {
          events.push("end");
          sink.emit("finish");
        };

        const fake = fakeLogger({ transports: [sink] });
        __crashCaptureInternals.registerCrashCapture(fake, {
          exitOnUncaught: true,
          hasFileTransport: false,
        });

        __crashCaptureInternals.invokeUncaught(new Error("fatal"));
        await new Promise((resolve) => setTimeout(resolve, 100));

        expect(events).toEqual(["end"]);
        expect(exitFn).toHaveBeenCalledWith(1);
      });

      it("settles a transport exposing neither close() nor end() instead of stalling the exit", async () => {
        const sink = new EventEmitter();
        const fake = fakeLogger({ transports: [sink] });
        __crashCaptureInternals.registerCrashCapture(fake, {
          exitOnUncaught: true,
          hasFileTransport: false,
        });

        __crashCaptureInternals.invokeUncaught(new Error("fatal"));
        await new Promise((resolve) => setTimeout(resolve, 100));

        // Must not wait out EXIT_FLUSH_TIMEOUT_MS.
        expect(exitFn).toHaveBeenCalledWith(1);
      });

      it("still exits when a transport's close() throws", async () => {
        const sink = new EventEmitter() as EventEmitter & { close?: () => void };
        sink.close = (): never => {
          throw new Error("close exploded");
        };
        const fake = fakeLogger({ transports: [sink] });
        __crashCaptureInternals.registerCrashCapture(fake, {
          exitOnUncaught: true,
          hasFileTransport: false,
        });

        __crashCaptureInternals.invokeUncaught(new Error("fatal"));
        await new Promise((resolve) => setTimeout(resolve, 100));

        expect(exitFn).toHaveBeenCalledWith(1);
      });

      it("prefers a file-backed logger as primary so the crash reaches disk", async () => {
        // Only the elected logger records the crash. If a console-only logger
        // won purely by registering first, the trace would never reach disk —
        // breaking the package's long-standing "persisted across restarts"
        // promise, which pre-v1.0.0 was kept by routing winston's exception
        // flags to file transports ahead of the console.
        const root = createTempDir();
        const consoleOnly = createLogger({
          moduleName: "elect-console-first",
          includeConsole: true,
          includeFile: false,
          includeGlobalFile: false,
          exitOnUncaught: false,
        });
        const fileBacked = createLogger({
          moduleName: "elect-file-second",
          logDirectory: root,
          includeConsole: false,
          includeFile: true,
          exitOnUncaught: false,
        });

        // Registered second, but elected: it is the one that can persist.
        const primary = __crashCaptureInternals.getPrimaryEntry();
        expect(primary).toBeDefined();
        const [primaryLogger, primaryPolicy] = primary as [
          winston.Logger,
          { hasFileTransport: boolean },
        ];
        expect(primaryPolicy.hasFileTransport).toBe(true);
        // Identity: the elected logger owns the module rotating file, which only
        // the file-backed logger has.
        expect(primaryLogger.transports.some((t) => t instanceof DailyRotateFile)).toBe(true);

        [consoleOnly, fileBacked].forEach((logger) => teardownLogger(logger));
      });

      it("skips a transport-less logger when electing the primary", async () => {
        // A logger with zero transports can record nothing — winston just warns
        // "Attempt to write logs with no transports". Electing it would lose the
        // crash outright, so registration order yields to "can actually write".
        const empty = fakeLogger({ transports: [] });
        __crashCaptureInternals.registerCrashCapture(empty, {
          exitOnUncaught: false,
          hasFileTransport: false,
        });

        const { stub } = makeCaptureLogger("crash-elect-writable", { exitOnUncaught: false });

        __crashCaptureInternals.invokeUncaught(new Error("boom-elect"));
        await flushMicrotasks();

        expect(stub.log).toHaveBeenCalledTimes(1);
        expect(empty.log as unknown as jest.Mock).not.toHaveBeenCalled();
      });

      it("falls back to the first logger when every registered logger is transport-less", async () => {
        const empty = fakeLogger({ transports: [] });
        __crashCaptureInternals.registerCrashCapture(empty, {
          exitOnUncaught: false,
          hasFileTransport: false,
        });

        __crashCaptureInternals.invokeUncaught(new Error("boom-all-empty"));
        await flushMicrotasks();

        // Nothing better exists, so the exit policy is still honored via it.
        expect(empty.log as unknown as jest.Mock).toHaveBeenCalledTimes(1);
      });

      it("counts a transport-less opt-out toward the exit veto", async () => {
        // The exit vote concerns process lifetime, not persistence, so it reads
        // the raw `registered` map rather than `getPrimaryEntry`'s writable-only
        // view: a logger with zero transports (skipped during primary election)
        // still votes. Here a writable default-exit logger is elected primary
        // while a transport-less logger opts out — the opt-out must still veto.
        const { stub: primaryStub } = makeCaptureLogger("crash-vote-writable"); // default true, elected
        const optOutNoTransports = fakeLogger({ transports: [] });
        __crashCaptureInternals.registerCrashCapture(optOutNoTransports, {
          exitOnUncaught: false,
          hasFileTransport: false,
        });

        __crashCaptureInternals.invokeUncaught(new Error("transport-less-veto"));
        await new Promise((resolve) => setTimeout(resolve, 100));

        // The writable logger is elected and records the crash...
        expect(primaryStub.log).toHaveBeenCalledTimes(1);
        // ...the transport-less logger records nothing (it was not elected)...
        expect(optOutNoTransports.log as unknown as jest.Mock).not.toHaveBeenCalled();
        // ...but its opt-out still counts toward the vote, vetoing the exit.
        expect(exitFn).not.toHaveBeenCalled();
      });

      it("routes through the real process.exit when no exit fn is injected", async () => {
        const exitSpy = jest
          .spyOn(process, "exit")
          .mockImplementation((() => undefined) as unknown as typeof process.exit);
        __crashCaptureInternals.restoreExitFn();

        const fake = fakeLogger({});
        __crashCaptureInternals.registerCrashCapture(fake, {
          exitOnUncaught: true,
          hasFileTransport: false,
        });

        __crashCaptureInternals.invokeUncaught(new Error("boom"));
        await new Promise((resolve) => setTimeout(resolve, 100));

        expect(exitSpy).toHaveBeenCalledWith(1);
      });
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

    // -----------------------------------------------------------------------
    // Phase 1 (redact.ts DAG/diamond fix) — pretty-mode end-to-end
    // -----------------------------------------------------------------------

    it("pretty mode: renders both occurrences of a shared metadata object instead of collapsing the second into [Circular] (diamond fix)", () => {
      // `shared` is referenced by TWO metadata keys (`a`, `b`) passed in the
      // SAME call. Before the active-path fix, `formatMessage`'s single
      // `new WeakSet()` covering the whole metadata object never released a
      // visited value, so the second occurrence of `shared` rendered as the
      // literal string "[Circular]" instead of being walked and redacted.
      const shared = { password: "topsecret", keep: "visible" };
      const stream = new PassThrough();
      const chunks: string[] = [];
      stream.on("data", (chunk: Buffer) => chunks.push(chunk.toString()));
      const logger = createLogger({
        moduleName: "mask-diamond-pretty",
        includeConsole: false,
        includeFile: false,
        includeGlobalFile: false,
        maskMetaKeys: ["password"],
        additionalTransports: [new winston.transports.Stream({ stream })],
      });
      logger.info("Login", { a: shared, b: shared });
      teardownLogger(logger);
      const rendered = chunks.join("");

      expect(rendered).not.toContain("[Circular]");
      expect(rendered).not.toContain("topsecret");

      // The metadata block is the trailing JSON.stringify(..., 2) segment of
      // the rendered line — extract and parse it to assert BOTH keys render
      // fully (not just that "[REDACTED]" appears somewhere).
      const metaJson = rendered.slice(rendered.indexOf("{")).trim();
      const parsedMeta = JSON.parse(metaJson) as {
        a: { password: string; keep: string };
        b: { password: string; keep: string };
      };
      expect(parsedMeta.a).toEqual({ password: "[REDACTED]", keep: "visible" });
      expect(parsedMeta.b).toEqual({ password: "[REDACTED]", keep: "visible" });
    });

    // -----------------------------------------------------------------------
    // Depth-bounded redaction — a deep payload must not crash the caller
    //
    // The redaction walk is plain recursion, and winston runs its formats
    // synchronously inside `logger.log()`. Unbounded, the walk overflows the
    // stack at roughly HALF the depth `JSON.stringify` tolerates (measured:
    // RangeError at 2000, while JSON.stringify is still fine at 4000) — so
    // merely ENABLING `maskMetaKeys` turned a working `logger.info()` into a
    // synchronous `RangeError` thrown back at the application, for a payload
    // (~18KB of JSON) reachable by logging a parsed request body.
    // -----------------------------------------------------------------------

    /** Builds a `{child:{child:…}}` chain `depth` levels deep with a secret leaf. */
    const buildDeepMeta = (depth: number): Record<string, unknown> => {
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

    /** Walks `depth` `child` hops into a rendered/parsed metadata chain. */
    const descend = (value: unknown, depth: number): any => {
      let cursor: any = value;
      for (let i = 0; i < depth; i += 1) cursor = cursor.child;
      return cursor;
    };

    it("pretty mode: logs a 3000-deep metadata payload instead of throwing RangeError at the caller", () => {
      const stream = new PassThrough();
      const chunks: string[] = [];
      stream.on("data", (chunk: Buffer) => chunks.push(chunk.toString()));
      const logger = createLogger({
        moduleName: "mask-deep-pretty",
        includeConsole: false,
        includeFile: false,
        includeGlobalFile: false,
        maskMetaKeys: ["password"],
        additionalTransports: [new winston.transports.Stream({ stream })],
      });

      // The assertion is the absence of a throw: pre-fix this call raised
      // `RangeError: Maximum call stack size exceeded` out of `logger.info`.
      expect(() => logger.info("Deep", { payload: buildDeepMeta(3000) })).not.toThrow();
      teardownLogger(logger);

      const rendered = chunks.join("");
      // The line is genuinely emitted, not merely "not thrown".
      expect(rendered).toContain("[INFO] (mask-deep-pretty)");
      expect(rendered).toContain("Deep");
      expect(rendered).toContain("[MaxDepth]");
      // The over-deep leaf is never reached, so its secret cannot leak either.
      expect(rendered).not.toContain("topsecret");
    });

    it("json mode: logs a 3000-deep metadata payload instead of throwing RangeError at the caller", () => {
      const stream = new PassThrough();
      const chunks: string[] = [];
      stream.on("data", (chunk: Buffer) => chunks.push(chunk.toString()));
      const logger = createLogger({
        moduleName: "mask-deep-json",
        includeConsole: false,
        includeFile: false,
        includeGlobalFile: false,
        format: "json",
        maskMetaKeys: ["password"],
        additionalTransports: [new winston.transports.Stream({ stream })],
      });

      expect(() => logger.info("Deep", { payload: buildDeepMeta(3000) })).not.toThrow();
      teardownLogger(logger);

      const rendered = chunks.join("");
      const parsed = JSON.parse(rendered) as { message: string; payload: unknown };
      expect(parsed.message).toBe("Deep");
      expect(descend(parsed.payload, MAX_REDACT_DEPTH).child).toBe("[MaxDepth]");
      expect(rendered).not.toContain("topsecret");
    });

    it("bounds a deep ARRAY chain (the array recursive site threads depth too)", () => {
      // Coverage guard: every other depth test drives a plain-object chain, so
      // a dropped `depth + 1` at the array site would leave the original
      // RangeError reachable via `[[[…]]]` while the suite stayed green.
      let arr: unknown[] = ["leaf"];
      for (let i = 0; i < 3000; i += 1) arr = [arr];

      expect(() => redactValue(arr, new Set(["password"]), new WeakSet())).not.toThrow();
      const out = redactValue(arr, new Set(["password"]), new WeakSet());
      // The array AT the ceiling is still walked; the one nested inside it is
      // the first replaced — same boundary the json-mode test pins.
      let cursor: any = out;
      for (let i = 0; i < MAX_REDACT_DEPTH; i += 1) cursor = cursor[0];
      expect(cursor[0]).toBe("[MaxDepth]");
    });

    it("bounds a deep CLASS-INSTANCE chain (the data-bearing recursive site threads depth too)", () => {
      // Same coverage guard for the third recursive site. A data-bearing
      // instance is walked by its own enumerable keys, a distinct branch from
      // both the array and plain-object paths.
      class Node {
        public child?: Node;
        public password = "topsecret";
      }
      const root = new Node();
      let cursor = root;
      for (let i = 0; i < 3000; i += 1) {
        cursor.child = new Node();
        cursor = cursor.child;
      }

      expect(() => redactValue(root, new Set(["password"]), new WeakSet())).not.toThrow();
      const out = redactValue(root, new Set(["password"]), new WeakSet());
      let node: any = out;
      for (let i = 0; i < MAX_REDACT_DEPTH; i += 1) node = node.child;
      expect(node.child).toBe("[MaxDepth]");
      // The instance at the ceiling is still walked, so its own keys redact.
      expect(node.password).toBe("[REDACTED]");
    });

    it("pretty mode: a payload at depth 255 is still redacted normally (the guard must not fire early)", () => {
      const stream = new PassThrough();
      const chunks: string[] = [];
      stream.on("data", (chunk: Buffer) => chunks.push(chunk.toString()));
      const logger = createLogger({
        moduleName: "mask-depth-255",
        includeConsole: false,
        includeFile: false,
        includeGlobalFile: false,
        maskMetaKeys: ["password"],
        additionalTransports: [new winston.transports.Stream({ stream })],
      });
      // 254 `child` hops below the `payload` key puts the secret-bearing leaf
      // at metadata depth 255 — inside the 256 ceiling.
      logger.info("Shallow", { payload: buildDeepMeta(254) });
      teardownLogger(logger);

      const rendered = chunks.join("");
      const metaJson = rendered.slice(rendered.indexOf("{")).trim();
      const parsed = JSON.parse(metaJson) as { payload: unknown };
      expect(descend(parsed.payload, 254).password).toBe("[REDACTED]");
      expect(rendered).not.toContain("[MaxDepth]");
      expect(rendered).not.toContain("topsecret");
    });

    // -----------------------------------------------------------------------
    // Fail-closed redaction — a throwing getter must not crash the log call,
    // and must never fall back to emitting the raw (unredacted) value.
    // -----------------------------------------------------------------------

    /** A data-bearing instance whose enumerable getter throws when read. */
    const buildHostileMeta = () => {
      class Hostile {
        public safe = "visible";
        get boom(): string {
          throw new Error("getter exploded");
        }
      }
      const instance = new Hostile();
      // Make the throwing getter an OWN enumerable key so `Object.keys` in the
      // redaction walk reads (and detonates) it.
      Object.defineProperty(instance, "boom", {
        enumerable: true,
        get() {
          throw new Error("getter exploded");
        },
      });
      return instance;
    };

    it("pretty mode: a metadata getter that throws degrades to a marker instead of crashing logger.info", () => {
      const stream = new PassThrough();
      const chunks: string[] = [];
      stream.on("data", (chunk: Buffer) => chunks.push(chunk.toString()));
      const logger = createLogger({
        moduleName: "mask-hostile-pretty",
        includeConsole: false,
        includeFile: false,
        includeGlobalFile: false,
        maskMetaKeys: ["password"],
        additionalTransports: [new winston.transports.Stream({ stream })],
      });

      expect(() =>
        logger.info("Hostile", { evil: buildHostileMeta(), password: "topsecret" }),
      ).not.toThrow();
      teardownLogger(logger);

      const rendered = chunks.join("");
      // The line still renders...
      expect(rendered).toContain("[INFO] (mask-hostile-pretty)");
      expect(rendered).toContain("Hostile");
      // ...and fails CLOSED: the bag collapses to the marker rather than
      // falling back to the raw metadata, which would have leaked `password`.
      expect(rendered).toContain("_redactionFailed");
      expect(rendered).not.toContain("topsecret");
    });

    it("json mode: a metadata getter that throws degrades that key only, leaving other keys redacted", () => {
      const stream = new PassThrough();
      const chunks: string[] = [];
      stream.on("data", (chunk: Buffer) => chunks.push(chunk.toString()));
      const logger = createLogger({
        moduleName: "mask-hostile-json",
        includeConsole: false,
        includeFile: false,
        includeGlobalFile: false,
        format: "json",
        maskMetaKeys: ["password"],
        additionalTransports: [new winston.transports.Stream({ stream })],
      });

      expect(() =>
        logger.info("Hostile", {
          evil: buildHostileMeta(),
          nested: { password: "topsecret" },
          password: "topsecret",
        }),
      ).not.toThrow();
      teardownLogger(logger);

      const rendered = chunks.join("");
      const parsed = JSON.parse(rendered) as Record<string, any>;
      expect(parsed.message).toBe("Hostile");
      // Only the offending key degrades...
      expect(parsed.evil).toBe("[RedactionFailed]");
      // ...every other key still redacts normally (the failure is per-key, so
      // one hostile value cannot suppress the rest of the masking).
      expect(parsed.password).toBe("[REDACTED]");
      expect(parsed.nested).toEqual({ password: "[REDACTED]" });
      expect(rendered).not.toContain("topsecret");
    });

    it("json mode: a key redacted AFTER a throwing one is not misreported as [Circular]", () => {
      // Regression guard for `seen` contamination, and it only has teeth with a
      // very specific shape — an earlier version of this test had none.
      //
      // The throw unwinds out of the walk without running the `seen.delete` each
      // branch performs on its way out, so the objects on the abandoned path stay
      // marked "on the active path". `buildMetaRedactor` swaps in a fresh WeakSet
      // on failure; if it reused the contaminated one, a later key legitimately
      // holding one of those objects would render "[Circular]" and its real data
      // would vanish.
      //
      // Two constraints make that state reachable, and both were learned the hard
      // way (removing the reset left the previous version of this test green):
      //  1. The contaminated object must be an ANCESTOR of the thrower, not a
      //     sibling under it. Both walk branches read their children eagerly
      //     (`Object.entries` / `value[key]`), so a throwing getter detonates
      //     BEFORE any of its siblings are added to `seen` — only the objects on
      //     the path ABOVE it are left behind.
      //  2. The later key's re-walk must SUCCEED, or both branches yield a
      //     sentinel and the assertion cannot tell them apart. Hence a getter
      //     that fails only on its first read — modelling a lazily-initialised
      //     field (a lazy decrypt, a cache miss on a briefly-unavailable
      //     resource) whose second read resolves.
      let reads = 0;
      const inner = {
        get lazy(): string {
          if (reads++ === 0) {
            throw new Error("first read fails");
          }
          return "REAL-DATA";
        },
      };
      const ancestor = { password: "topsecret", keep: "visible", inner };

      const stream = new PassThrough();
      const chunks: string[] = [];
      stream.on("data", (chunk: Buffer) => chunks.push(chunk.toString()));
      const logger = createLogger({
        moduleName: "mask-seen-reset",
        includeConsole: false,
        includeFile: false,
        includeGlobalFile: false,
        format: "json",
        maskMetaKeys: ["password"],
        additionalTransports: [new winston.transports.Stream({ stream })],
      });
      // Key order matters: `evil` is walked (and throws, contaminating `seen`
      // with `ancestor` and `inner`) before `later` re-references `ancestor`.
      logger.info("Trap", { evil: ancestor, later: ancestor });
      teardownLogger(logger);

      const parsed = JSON.parse(chunks.join("")) as Record<string, any>;
      expect(parsed.evil).toBe("[RedactionFailed]");
      // The load-bearing assertion: WITHOUT the fresh WeakSet this is the string
      // "[Circular]" and every field below is lost.
      expect(parsed.later).not.toBe("[Circular]");
      expect(parsed.later).toEqual({
        password: "[REDACTED]",
        keep: "visible",
        inner: { lazy: "REAL-DATA" },
      });
    });

    // -----------------------------------------------------------------------
    // Phase 4 — the redaction must not mutate the caller's own object.
    //
    // Winston hands the format chain the CALLER'S object, uncloned, on three
    // reachable log forms (verified against the installed winston):
    //   - `logger.info(obj)` with a truthy `obj.message`
    //     (create-logger.js:76 — `const info = msg && msg.message && msg || ...`)
    //   - `logger.log("info", obj)` (logger.js:252 — `msg[LEVEL] = msg.level = level`)
    //   - `logger.info("msg", meta)` — here winston builds a fresh info and
    //     merges `meta`'s keys onto it, so the top level is safe, but the
    //     NESTED objects are still shared by reference with the caller.
    // A format that assigns `info[key] = "[REDACTED]"` therefore overwrites
    // live application state rather than a log line. `buildMetaRedactor`
    // returns a fresh info object instead; `formatMessage` (pretty mode) has
    // always been non-mutating and is pinned here against regression.
    //
    // Note what is deliberately NOT asserted, and why the payload below owns no
    // `timestamp` key. TWO reserved slots are written onto the caller's object,
    // neither of them additive (each overwrites a caller-owned key of that
    // name), and only one of them engine-owned:
    //   - `level` / the `LEVEL` Symbol — written by WINSTON before any format
    //     runs (`create-logger.js:79`, `logger.js:237`).
    //   - `timestamp` — written by THIS package's own `buildTimestampCapture`,
    //     the first format in both chains, which overwrites a caller-supplied
    //     `timestamp` in place. That is exact parity with
    //     `winston.format.timestamp({ format })` (`logform/timestamp.js:15-19`)
    //     and is mandatory: `timestamp` is a RESERVED_INFO_KEY rendered as the
    //     log's own `UTC:` line, so honoring a caller's value would let caller
    //     data forge the log's timestamp column.
    // Both are pinned by the "reserved-slot boundary" suite below rather than
    // left to an assumption in a comment.
    //
    // The contract under test HERE is therefore the narrower, real one: no
    // caller-supplied METADATA value is destroyed.
    // -----------------------------------------------------------------------

    /** Builds the payload used by every mutation-safety case below. */
    const buildCreds = (): Record<string, any> => ({
      message: "connecting",
      host: "db",
      password: "hunter2",
      nested: { password: "nested-secret", keep: "visible" },
    });

    /**
     * Asserts the caller's object still holds every original value, and that
     * the nested object is still the SAME object it started as (a redactor
     * that swapped in a redacted copy would leave the original intact but
     * unreachable — the same data loss, one level down).
     */
    const expectCredsIntact = (creds: Record<string, any>, nested: object): void => {
      expect(creds.password).toBe("hunter2");
      expect(creds.host).toBe("db");
      expect(creds.message).toBe("connecting");
      expect(creds.nested).toBe(nested);
      expect(creds.nested.password).toBe("nested-secret");
      expect(creds.nested.keep).toBe("visible");
    };

    /**
     * Renders one log line through a Stream transport in the requested format
     * mode with `maskMetaKeys: ["password"]`, letting the caller drive the
     * exact winston log form under test.
     */
    const renderWithMask = (
      moduleName: string,
      format: "json" | "pretty",
      emit: (logger: winston.Logger) => void,
    ): string => {
      const stream = new PassThrough();
      const chunks: string[] = [];
      stream.on("data", (chunk) => chunks.push(chunk.toString()));
      const logger = createLogger({
        moduleName,
        includeConsole: false,
        includeFile: false,
        includeGlobalFile: false,
        format,
        maskMetaKeys: ["password"],
        additionalTransports: [new winston.transports.Stream({ stream })],
      });
      emit(logger);
      teardownLogger(logger);
      return chunks.join("");
    };

    describe.each([["json"], ["pretty"]] as const)("format: %s", (format) => {
      it("does not mutate the caller's object on the single-object form", () => {
        const creds = buildCreds();
        const nested = creds.nested;

        const rendered = renderWithMask(`mask-mutate-single-${format}`, format, (logger) => {
          logger.info(creds);
        });

        // The caller's live object is untouched...
        expectCredsIntact(creds, nested);
        // ...while the emitted line is fully redacted at both levels.
        expect(rendered).not.toContain("hunter2");
        expect(rendered).not.toContain("nested-secret");
        expect(rendered).toContain("[REDACTED]");
        expect(rendered).toContain("db");
        expect(rendered).toContain("visible");
      });

      it("does not mutate the caller's object on the 2-arg object form", () => {
        const creds = buildCreds();
        const nested = creds.nested;

        const rendered = renderWithMask(`mask-mutate-2arg-${format}`, format, (logger) => {
          logger.info("Connecting", creds);
        });

        expectCredsIntact(creds, nested);
        expect(rendered).not.toContain("hunter2");
        expect(rendered).not.toContain("nested-secret");
        expect(rendered).toContain("[REDACTED]");
      });

      it('does not mutate the caller\'s object on logger.log("info", obj)', () => {
        const creds = buildCreds();
        const nested = creds.nested;

        const rendered = renderWithMask(`mask-mutate-log-${format}`, format, (logger) => {
          logger.log("info", creds);
        });

        expectCredsIntact(creds, nested);
        expect(rendered).not.toContain("hunter2");
        expect(rendered).not.toContain("nested-secret");
        expect(rendered).toContain("[REDACTED]");
      });
    });

    it("buildMetaRedactor returns a fresh object and leaves the input untouched", () => {
      // Unit-level counterpart to the end-to-end cases above: the redactor's
      // OWN contract is "read `info`, return a new one".
      const formatter = __loggerInternals.buildMetaRedactor(new Set(["password"]));
      const input: Record<string, unknown> = {
        level: "info",
        message: "connecting",
        password: "hunter2",
        nested: { password: "nested-secret" },
      };

      const transformed = formatter.transform(input as any) as Record<string, unknown>;

      expect(transformed).not.toBe(input);
      expect(input.password).toBe("hunter2");
      expect(input.nested).toEqual({ password: "nested-secret" });
      expect(transformed.password).toBe("[REDACTED]");
      expect(transformed.nested).toEqual({ password: "[REDACTED]" });
      // Reserved fields ride across onto the copy.
      expect(transformed.level).toBe("info");
      expect(transformed.message).toBe("connecting");
    });

    it("buildMetaRedactor carries Symbol slots across to the returned object", () => {
      // `LEVEL` is written by `Logger._transform` BEFORE the format chain runs
      // and is what `winston-transport`'s `_write` gates the level filter on;
      // `SPLAT` carries interpolation args. Dropping either while returning a
      // copy would silently break downstream serialization / filtering, so the
      // copy must carry every Symbol-keyed slot.
      const LEVEL = Symbol.for("level");
      const SPLAT = Symbol.for("splat");
      const formatter = __loggerInternals.buildMetaRedactor(new Set(["password"]));
      const input: Record<string | symbol, unknown> = {
        level: "info",
        message: "connecting",
        password: "hunter2",
        [LEVEL]: "info",
        [SPLAT]: ["a", 1],
      };

      const transformed = formatter.transform(input as any) as unknown as Record<
        string | symbol,
        unknown
      >;

      expect(transformed).not.toBe(input);
      expect(transformed[LEVEL]).toBe("info");
      expect(transformed[SPLAT]).toEqual(["a", 1]);
    });

    it("buildMetaRedactor returns the input by identity on the empty-mask fast path", () => {
      // The zero-allocation fast path is load-bearing for the default config:
      // with no `maskMetaKeys` the redactor must not copy the info at all.
      const formatter = __loggerInternals.buildMetaRedactor(new Set<string>());
      const input: Record<string, unknown> = { level: "info", message: "hi", password: "hunter2" };

      expect(formatter.transform(input as any)).toBe(input);
      expect(input.password).toBe("hunter2");
    });

    it("a masked key whose getter throws is redacted without taking the line down", () => {
      // The masked value is discarded either way, so the redactor never reads
      // it — a throwing getter on a masked key cannot reach the caller.
      const creds: Record<string, unknown> = { message: "connecting", host: "db" };
      Object.defineProperty(creds, "password", {
        enumerable: true,
        get() {
          throw new Error("hostile getter");
        },
      });

      let rendered = "";
      expect(() => {
        rendered = renderWithMask("mask-hostile-getter", "json", (logger) => {
          logger.info(creds);
        });
      }).not.toThrow();

      const parsed = JSON.parse(rendered.trim()) as Record<string, unknown>;
      expect(parsed.password).toBe("[REDACTED]");
      expect(parsed.host).toBe("db");
    });

    it("an accessor-only own key whose nested value throws fails closed without a set-on-getter TypeError", () => {
      // Checklist 4.3, the second required accessor-only case: a NON-masked own
      // property defined with only a getter (no setter), whose value carries a
      // nested throwing getter so `redactValue` throws and the redactor takes
      // its fail-closed branch. In the pre-fix code that branch wrote
      // `info[key] = "[RedactionFailed]"` back onto the caller's own object —
      // which, for a getter-only property, raises
      // `TypeError: Cannot set property … which has only a getter` in strict
      // mode. That TypeError escaped the format and was thrown out of the
      // application's `logger.info(...)`. Returning a fresh object removes the
      // write entirely, so the line renders and the caller never sees the throw.
      const payload: Record<string, unknown> = { message: "connecting", host: "db" };
      Object.defineProperty(payload, "detail", {
        enumerable: true,
        // Getter-only: assigning `payload.detail = …` would throw. Each read
        // yields an object whose non-masked `token` getter throws, so the
        // deep walk raises before it can finish this key.
        get() {
          const inner: Record<string, unknown> = {};
          Object.defineProperty(inner, "token", {
            enumerable: true,
            get() {
              throw new Error("nested boom");
            },
          });
          return inner;
        },
      });

      let rendered = "";
      expect(() => {
        rendered = renderWithMask("mask-accessor-nested-throw", "json", (logger) => {
          logger.info(payload);
        });
      }).not.toThrow();

      const parsed = JSON.parse(rendered.trim()) as Record<string, unknown>;
      // The hostile key fails closed to the marker; every sibling still renders.
      expect(parsed.detail).toBe("[RedactionFailed]");
      expect(parsed.host).toBe("db");
      expect(parsed.message).toBe("connecting");
    });

    // -----------------------------------------------------------------------
    // Prototype-pollution hardening for the fresh-object rebuild.
    //
    // Returning a FRESH object (Phase 4) means a caller-supplied own key named
    // "__proto__" is no longer written onto an object that already owns it.
    // `next["__proto__"] = …` on a plain `{}` invokes `Object.prototype`'s
    // `__proto__` SETTER — silently dropping the key from the emitted line and
    // repointing `next`'s prototype for the rest of the pipeline. Such a key is
    // trivially reachable via `logger.info(JSON.parse(body))`, where JSON.parse
    // mints a genuine own enumerable "__proto__" data property. `buildMetaRedactor`
    // therefore skips FORBIDDEN_KEYS, exactly as `redactValue` does on every
    // nested rebuild.
    // -----------------------------------------------------------------------

    it("buildMetaRedactor drops a __proto__ metadata key without corrupting the returned object", () => {
      const formatter = __loggerInternals.buildMetaRedactor(new Set(["password"]));
      // JSON.parse creates a real own enumerable "__proto__" data property.
      const input = JSON.parse(
        '{"level":"info","message":"hi","__proto__":{"password":"leak"},"keep":"visible"}',
      ) as Record<string, unknown>;
      expect(Object.prototype.hasOwnProperty.call(input, "__proto__")).toBe(true);

      const out = formatter.transform(input as any) as unknown as Record<string, unknown>;

      // The prototype-pollution key is skipped entirely...
      expect(Object.prototype.hasOwnProperty.call(out, "__proto__")).toBe(false);
      // ...the fresh object's prototype is untouched (not repointed by a setter)...
      expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
      // ...and every legitimate key still rides across.
      expect(out.message).toBe("hi");
      expect(out.keep).toBe("visible");
    });

    it("logs a __proto__-bearing payload cleanly without breaking the json line", () => {
      // Integration smoke test: a payload carrying an own "__proto__" key must
      // not throw, must still render its legitimate siblings, and must not
      // surface the injected object as a data field. The DISCRIMINATING guard
      // for the prototype skip is the unit test above (it asserts the returned
      // object's prototype is untouched) — a value planted on an object's
      // prototype is never emitted by `JSON.stringify`, so the difference the
      // skip makes is not observable in the rendered line, only on the object.
      const payload = JSON.parse(
        '{"message":"connecting","__proto__":{"role":"admin"},"keep":"visible"}',
      ) as Record<string, unknown>;

      let rendered = "";
      expect(() => {
        rendered = renderWithMask("mask-proto-key", "json", (logger) => {
          logger.info(payload);
        });
      }).not.toThrow();

      const parsed = JSON.parse(rendered.trim()) as Record<string, unknown>;
      expect(parsed.keep).toBe("visible");
      expect(parsed.message).toBe("connecting");
      // The injected key is not surfaced as a data field, and its contents
      // never leak into the line.
      expect(Object.prototype.hasOwnProperty.call(parsed, "__proto__")).toBe(false);
      expect(rendered).not.toContain("admin");
    });
  });

  // ---------------------------------------------------------------------------
  // A top-level `toJSON` must be resolved, then redacted.
  //
  // `buildMetaRedactor` rebuilds into a plain `{}`, which discards the info's
  // prototype. On the single-object form the info IS the caller's DTO, so the
  // rebuild made `json()` stop finding `toJSON` and emit every own field —
  // including ones the DTO deliberately withheld. Enabling `maskMetaKeys` then
  // disclosed MORE than leaving it off, which is the exact inversion the option
  // exists to prevent.
  //
  // The fix resolves `toJSON` here (on the real instance, inside a try/catch)
  // and redacts its OUTPUT. Merely passing a `toJSON`-defining info through by
  // identity would fix the withholding but silently void `maskMetaKeys` — the
  // `toJSON`-surfaces-a-masked-key test below is what pins that apart.
  // ---------------------------------------------------------------------------
  describe("top-level toJSON is resolved then redacted", () => {
    const renderJson = (
      moduleName: string,
      emit: (logger: winston.Logger) => void,
      maskMetaKeys?: string[],
    ): string => {
      const stream = new PassThrough();
      const chunks: string[] = [];
      stream.on("data", (chunk) => chunks.push(chunk.toString()));
      const logger = createLogger({
        moduleName,
        includeConsole: false,
        includeFile: false,
        includeGlobalFile: false,
        format: "json",
        ...(maskMetaKeys ? { maskMetaKeys } : {}),
        additionalTransports: [new winston.transports.Stream({ stream })],
      });
      emit(logger);
      teardownLogger(logger);
      return chunks.join("");
    };

    class UserDto {
      public message = "user loaded";
      public email = "u@example.com";
      public ssn = "123-45-6789";
      toJSON(): Record<string, unknown> {
        // `ssn` is deliberately withheld.
        return { message: this.message, email: this.email };
      }
    }

    it("honors a withheld field when maskMetaKeys is set (regression: enabling the mask leaked it)", () => {
      const rendered = renderJson("tojson-withhold", (logger) => logger.info(new UserDto()), [
        "password",
      ]);
      expect(rendered).not.toContain("123-45-6789");
      expect(rendered).toContain("user loaded");
    });

    it("emits exactly the same line with the mask on as with it off (mask-on ⊆ mask-off canary)", () => {
      // The load-bearing invariant: turning a redaction feature ON must never
      // emit MORE than leaving it off.
      const withMask = renderJson("tojson-on", (logger) => logger.info(new UserDto()), [
        "password",
      ]);
      const withoutMask = renderJson("tojson-off", (logger) => logger.info(new UserDto()));
      expect(JSON.parse(withMask.trim())).toEqual(JSON.parse(withoutMask.trim()));
    });

    it("still redacts a masked key that the toJSON output SURFACES", () => {
      // This is the test that rejects the tempting "just pass a toJSON-defining
      // info through by identity" fix: that would honor the withholding but
      // emit this password in cleartext, voiding the operator's explicit
      // instruction with no `redactPaths` escape hatch on `createLogger`.
      class CredDto {
        public message = "connecting";
        public password = "hunter2";
        toJSON(): Record<string, unknown> {
          return { message: this.message, password: this.password };
        }
      }
      const dto = new CredDto();
      const rendered = renderJson("tojson-surface", (logger) => logger.info(dto), ["password"]);

      expect(rendered).toContain("[REDACTED]");
      expect(rendered).not.toContain("hunter2");
      // ...and the caller's own object still holds the real secret.
      expect(dto.password).toBe("hunter2");
    });

    it("resolves a toJSON that reads a private #field without crashing the caller", () => {
      // Pins why the prototype must NOT be copied onto the rebuild
      // (`Object.create(getPrototypeOf(info))` / `setPrototypeOf` / copying
      // `toJSON` across): the copy is not a real instance, so a brand check on
      // `this.#secret` throws a TypeError from inside the unwrapped `json()`,
      // crashing `logger.info(dto)`. Invoking toJSON on the REAL instance here
      // is what makes this work.
      class PrivDto {
        #secret = "PRIVATE-VAL";
        public message = "priv";
        toJSON(): Record<string, unknown> {
          return { message: this.message, shown: this.#secret };
        }
      }
      let rendered = "";
      expect(() => {
        rendered = renderJson("tojson-private", (logger) => logger.info(new PrivDto()), [
          "password",
        ]);
      }).not.toThrow();
      expect(rendered).toContain("PRIVATE-VAL");
    });

    it("keeps a top-level ARRAY info an array, with no toJSON involved", () => {
      // `logger.log("info", ["a","b"])` takes winston's object branch
      // (`logger.js:245` — an array IS an object), so `info` IS the array and
      // no `toJSON` is in play. The plain rebuild would render
      // `{"0":"a","1":"b","level":"info","timestamp":"…"}` while the no-mask
      // line renders `["a","b"]` (json()'s array branch ignores the level /
      // timestamp props winston assigned onto the array) — which is why the
      // delegation is gated on `Array.isArray(subject) || resolvedViaToJSON`
      // rather than on the toJSON resolve alone.
      const withMask = renderJson("arrinfo-on", (l) => l.log("info", ["a", "b"] as never), [
        "password",
      ]);
      const withoutMask = renderJson("arrinfo-off", (l) => l.log("info", ["a", "b"] as never));
      expect(JSON.parse(withMask.trim())).toEqual(["a", "b"]);
      expect(JSON.parse(withMask.trim())).toEqual(JSON.parse(withoutMask.trim()));
    });

    it("still redacts a masked key nested inside a top-level array info", () => {
      const rendered = renderJson(
        "arrinfo-secret",
        (l) => l.log("info", [{ password: "pw", keep: "k" }] as never),
        ["password"],
      );
      expect(rendered).toContain("[REDACTED]");
      expect(rendered).not.toContain("pw");
    });

    it("keeps a toJSON returning an ARRAY an array (not an index-keyed object)", () => {
      // The plain rebuild is `Object.keys` into a fresh `{}`, which would render
      // `{"0":"a","1":"b"}` here while the no-mask line renders `["a","b"]` —
      // the same mask-diverges-from-no-mask defect in a new shape. Non-plain
      // toJSON outputs are delegated to `redactValue` instead.
      class ArrDto {
        public message = "m";
        toJSON(): unknown[] {
          return ["a", "b"];
        }
      }
      const withMask = renderJson("tojson-arr-on", (l) => l.info(new ArrDto()), ["password"]);
      const withoutMask = renderJson("tojson-arr-off", (l) => l.info(new ArrDto()));
      expect(JSON.parse(withMask.trim())).toEqual(["a", "b"]);
      expect(JSON.parse(withMask.trim())).toEqual(JSON.parse(withoutMask.trim()));
    });

    it("still redacts a masked key nested inside a toJSON that returns an array", () => {
      // Proves the array delegation redacts rather than passing through: this is
      // the case a bare `return info` for non-plain outputs would have leaked.
      class ArrSecret {
        public message = "m";
        toJSON(): unknown[] {
          return [{ password: "pw", keep: "k" }];
        }
      }
      const rendered = renderJson("tojson-arr-secret", (l) => l.info(new ArrSecret()), [
        "password",
      ]);
      expect(rendered).toContain("[REDACTED]");
      expect(rendered).not.toContain("pw");
      expect(rendered).toContain("keep");
    });

    it("hands a toJSON returning a built-in back to the serializer (redactValue identity branch)", () => {
      // `redactValue` returns a `Date`/`Map` by identity — its own rule for a
      // value owning no key-addressable secret. We must not attach symbols to a
      // caller-owned value, so `info` is returned and the serializer resolves it
      // exactly as the no-mask line does.
      class DateDto {
        public message = "m";
        toJSON(): Date {
          return new Date("2024-01-01T00:00:00Z");
        }
      }
      const withMask = renderJson("tojson-date-on", (l) => l.info(new DateDto()), ["password"]);
      const withoutMask = renderJson("tojson-date-off", (l) => l.info(new DateDto()));
      expect(withMask.trim()).toBe(withoutMask.trim());
    });

    it("fails closed when redacting a non-plain toJSON output throws", () => {
      class ArrHostile {
        public message = "arr-hostile";
        toJSON(): unknown[] {
          return [
            {
              get boom(): string {
                throw new Error("element getter exploded");
              },
            },
          ];
        }
      }
      let rendered = "";
      expect(() => {
        rendered = renderJson("tojson-arr-throws", (l) => l.info(new ArrHostile()), ["password"]);
      }).not.toThrow();
      const parsed = JSON.parse(rendered.trim()) as Record<string, unknown>;
      expect(parsed._redactionFailed).toBe(true);
      expect(parsed.message).toBe("arr-hostile");
    });

    it("passes through a toJSON returning a non-object (no keys to inspect)", () => {
      class FlatDto {
        public message = "flat";
        toJSON(): string {
          return "flattened";
        }
      }
      const rendered = renderJson("tojson-flat", (logger) => logger.info(new FlatDto()), [
        "password",
      ]);
      // `json()` resolves it downstream, exactly as the no-mask config does.
      expect(rendered).toContain("flattened");
    });

    it("fails closed when toJSON throws, without escaping into logger.info", () => {
      class HostileDto {
        public message = "hostile";
        public password = "hunter2";
        toJSON(): Record<string, unknown> {
          throw new Error("toJSON exploded");
        }
      }
      let rendered = "";
      expect(() => {
        rendered = renderJson("tojson-throws", (logger) => logger.info(new HostileDto()), [
          "password",
        ]);
      }).not.toThrow();

      const parsed = JSON.parse(rendered.trim()) as Record<string, unknown>;
      expect(parsed._redactionFailed).toBe(true);
      expect(parsed.message).toBe("hostile");
      // FAIL CLOSED: rebuilding from the unresolved source would have emitted
      // the very fields toJSON withholds.
      expect(rendered).not.toContain("hunter2");
    });

    it("fails closed when the toJSON GETTER itself throws", () => {
      const dto: Record<string, unknown> = { message: "getter-hostile", password: "hunter2" };
      Object.defineProperty(dto, "toJSON", {
        enumerable: false,
        get() {
          throw new Error("toJSON getter exploded");
        },
      });

      let rendered = "";
      expect(() => {
        rendered = renderJson("tojson-getter", (logger) => logger.info(dto), ["password"]);
      }).not.toThrow();
      expect((JSON.parse(rendered.trim()) as Record<string, unknown>)._redactionFailed).toBe(true);
      expect(rendered).not.toContain("hunter2");
    });

    it("applies to the 2-arg object form too (logger.log('info', dto))", () => {
      // `logger.js:246` passes the caller's object by identity just as the
      // single-object form does, so it carries the same prototype.
      const rendered = renderJson(
        "tojson-2arg",
        (logger) => logger.log("info", new UserDto() as unknown as string),
        ["password"],
      );
      expect(rendered).not.toContain("123-45-6789");
      expect(rendered).toContain("user loaded");
    });

    /**
     * Captures what winston's Console transport actually writes.
     *
     * It writes to `console._stdout`, NOT to `process.stdout` directly
     * (`winston/lib/winston/transports/console.js:85-87` — "Node.js maps
     * `process.stdout` to `console._stdout`"). Those are the same object in a
     * bare Node process, but jest replaces the global `console` with its own
     * buffered Console whose `_stdout` is a different stream — so patching
     * `process.stdout` captures nothing under a full-suite run while appearing
     * to work when this file runs alone. Patch the channel winston really uses,
     * falling back to `process.stdout` if a future winston drops `_stdout`.
     */
    const captureConsole = (emit: () => void): string => {
      const written: string[] = [];
      const target =
        (console as unknown as { _stdout?: NodeJS.WritableStream })._stdout ?? process.stdout;
      const original = target.write.bind(target);
      (target as unknown as { write: unknown }).write = (chunk: unknown): boolean => {
        written.push(String(chunk));
        return true;
      };
      try {
        emit();
      } finally {
        (target as unknown as { write: unknown }).write = original;
      }
      return written.join("");
    };

    it("honors a top-level toJSON on the CONSOLE too when a mask is configured", () => {
      // The eager resolve happens in the logger-level chain, so the withheld
      // field never enters the rebuilt info at all — leaving nothing for the
      // Console's own second serialization pass to re-expose. (Before the fix
      // the console leaked `ssn` here as well.)
      const consoleOut = captureConsole(() => {
        const logger = createLogger({
          moduleName: "tojson-console-mask",
          includeFile: false,
          includeGlobalFile: false,
          format: "json",
          maskMetaKeys: ["password"],
        });
        logger.info(new UserDto());
        teardownLogger(logger);
      });

      expect(consoleOut).not.toContain("123-45-6789");
      expect(consoleOut).toContain("user loaded");
    });

    it("does NOT honor a top-level toJSON on the console with NO mask — pinned known boundary", () => {
      // The one case that remains, and it is PRE-EXISTING (it predates the
      // redactor rework and reproduces identically against the old code): with
      // no `maskMetaKeys`, `buildMetaRedactor` is a zero-allocation identity
      // pass, so the real DTO instance reaches the Console transport — which
      // `winston-transport`'s `_write` hands `Object.assign({}, info)`, a
      // shallow clone that cannot carry a prototype, so the console's own
      // serializer never finds `toJSON`. Consequence of giving Console its own
      // format chain, which Phase 16.1 already plans to drop; pinned here so the
      // boundary is a decision on record and 16.1 gets a signal when it changes.
      const consoleOut = captureConsole(() => {
        const logger = createLogger({
          moduleName: "tojson-console-nomask",
          includeFile: false,
          includeGlobalFile: false,
          format: "json",
        });
        logger.info(new UserDto());
        teardownLogger(logger);
      });

      expect(consoleOut).toContain("123-45-6789");
    });

    it("leaves an Error info unaffected (errors() already flattened it)", () => {
      // `logform/errors.js:16` copies own ENUMERABLE props onto a plain object,
      // so a prototype `toJSON` never survives to reach the resolve block.
      class ErrWithToJSON extends Error {
        toJSON(): Record<string, unknown> {
          return { message: "should-not-be-used" };
        }
      }
      const rendered = renderJson(
        "tojson-error",
        (logger) => logger.error(new ErrWithToJSON("boom-tojson")),
        ["password"],
      );
      expect(rendered).toContain("boom-tojson");
      expect(rendered).not.toContain("should-not-be-used");
    });
  });

  // ---------------------------------------------------------------------------
  // Reserved-slot boundary — the documented limit of the mutation-safety
  // guarantee above, pinned rather than left to an assumption in a comment.
  //
  // `level` and `timestamp` ARE overwritten in place on the caller's object.
  // The guarantee is about caller-supplied METADATA values, not about those two
  // reserved slots. These tests exist so the boundary is enforced and honest:
  // if upstream winston ever stops behaving this way, the parity canary fails
  // loudly and the deferral is reopened deliberately rather than by drift.
  // ---------------------------------------------------------------------------
  describe("reserved-slot boundary (level / timestamp are overwritten in place)", () => {
    const renderTo = (
      moduleName: string,
      format: "json" | "pretty",
      emit: (logger: winston.Logger) => void,
    ): string => {
      const stream = new PassThrough();
      const chunks: string[] = [];
      stream.on("data", (chunk) => chunks.push(chunk.toString()));
      const logger = createLogger({
        moduleName,
        includeConsole: false,
        includeFile: false,
        includeGlobalFile: false,
        format,
        additionalTransports: [new winston.transports.Stream({ stream })],
      });
      emit(logger);
      teardownLogger(logger);
      return chunks.join("");
    };

    describe.each([["json"], ["pretty"]] as const)("format: %s", (format) => {
      it("overwrites a caller-supplied timestamp in place while leaving other caller values intact", () => {
        const event = {
          message: "webhook received",
          timestamp: "2024-01-01T00:00:00Z",
          id: 7,
        };

        renderTo(`reserved-ts-${format}`, format, (logger) => {
          logger.info(event);
        });

        // The reserved slot IS overwritten — this is the boundary, not a bug.
        expect(event.timestamp).not.toBe("2024-01-01T00:00:00Z");
        expect(event.timestamp).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
        // ...and the actual Phase 4 contract still holds around it: the
        // caller's non-reserved metadata value is untouched.
        expect(event.id).toBe(7);
        expect(event.message).toBe("webhook received");
      });

      it("still renders an Error's message and stack (guards against a copy-on-write timestampCapture)", () => {
        // The highest-value test in this suite. `buildTimestampCapture` runs
        // BEFORE `errors({ stack: true })`, so on this call its `info` IS the
        // Error instance (`create-logger.js:78` — an Error has a truthy
        // `.message`). "Fixing" the timestamp overwrite by returning
        // `{ ...info }` would drop `message`/`stack` (own NON-enumerable on an
        // Error) and defeat `errors.js:15`'s `instanceof Error` gate, emitting
        // a line with neither — verified: the whole payload collapsed to
        // `{"level":"error","timestamp":"..."}`. This fails the moment anyone
        // tries it.
        const rendered = renderTo(`reserved-err-${format}`, format, (logger) => {
          logger.error(new Error("boom-reserved"));
        });

        expect(rendered).toContain("boom-reserved");
        expect(rendered).toContain("Error: boom-reserved");
        expect(rendered).toMatch(/\bat\b/);
      });
    });

    it("matches bare winston's own format.timestamp({ format }) parity (canary)", () => {
      // The deferral rests entirely on this being winston's own behavior rather
      // than something this package adds. If a winston release ever changes it,
      // this fails and the decision is reopened on purpose.
      const stream = new PassThrough();
      const bare = winston.createLogger({
        format: winston.format.combine(
          winston.format.timestamp({ format: __loggerInternals.TIMESTAMP_FORMAT }),
          winston.format.json(),
        ),
        transports: [new winston.transports.Stream({ stream })],
      });
      const event = { message: "m", timestamp: "2024-01-01T00:00:00Z", id: 7 };

      bare.info(event);

      // Bare winston destroys the caller's timestamp identically, in place.
      expect(event.timestamp).not.toBe("2024-01-01T00:00:00Z");
      expect(event.timestamp).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
      expect(event.id).toBe(7);
      bare.close();
    });
  });

  // ---------------------------------------------------------------------------
  // JSON mode: module label field (Phase 15)
  //
  // In `format: "json"` the emitted line previously carried no module/label
  // field at all, so the shared `all-logs` file mixed every module's lines with
  // no way to attribute them. `buildModuleFieldInjector` stamps the module label
  // as a top-level `module` field (the pretty chain already renders `(label)`).
  // The field is additive, caller-precedence-respecting, and non-mutating.
  // ---------------------------------------------------------------------------
  describe("json mode: module label field (Phase 15)", () => {
    const renderJsonLine = (
      moduleName: string | undefined,
      emit: (logger: winston.Logger) => void,
      maskMetaKeys?: string[],
    ): string => {
      const stream = new PassThrough();
      const chunks: string[] = [];
      stream.on("data", (chunk) => chunks.push(chunk.toString()));
      const logger = createLogger({
        ...(moduleName === undefined ? {} : { moduleName }),
        includeConsole: false,
        includeFile: false,
        includeGlobalFile: false,
        format: "json",
        ...(maskMetaKeys ? { maskMetaKeys } : {}),
        additionalTransports: [new winston.transports.Stream({ stream })],
      });
      emit(logger);
      teardownLogger(logger);
      return chunks.join("").trim();
    };

    const parseJson = (
      moduleName: string | undefined,
      emit: (logger: winston.Logger) => void,
      maskMetaKeys?: string[],
    ): Record<string, unknown> =>
      JSON.parse(renderJsonLine(moduleName, emit, maskMetaKeys)) as Record<string, unknown>;

    it("stamps a named module as the top-level `module` field, alongside caller metadata", () => {
      const parsed = parseJson("api", (logger) => logger.info("Login", { userId: 42 }));
      expect(parsed.module).toBe("api");
      expect(parsed.message).toBe("Login");
      expect(parsed.level).toBe("info");
      expect(parsed.userId).toBe(42);
      expect(typeof parsed.timestamp).toBe("string");
    });

    it("stamps the default module as `GLOBAL`, matching the pretty pipeline's label", () => {
      // The default `moduleName: "global"` renders as `(GLOBAL)` in pretty mode
      // (`label = moduleName === "global" ? "GLOBAL" : moduleName`), so the json
      // field must carry the same `GLOBAL` token, not the raw `global`.
      const explicit = parseJson("global", (logger) => logger.info("boot"));
      expect(explicit.module).toBe("GLOBAL");

      const omitted = parseJson(undefined, (logger) => logger.info("boot"));
      expect(omitted.module).toBe("GLOBAL");
    });

    it("does not silently clobber a caller-supplied `module` metadata key (2-arg form)", () => {
      const parsed = parseJson("api", (logger) => logger.info("m", { module: "caller-owned" }));
      // Caller precedence: the caller's own value wins; ours is not added.
      expect(parsed.module).toBe("caller-owned");
    });

    it("does not silently clobber a caller-supplied `module` key on the single-object form", () => {
      const parsed = parseJson("api", (logger) =>
        logger.info({ message: "m", module: "caller-owned" }),
      );
      expect(parsed.module).toBe("caller-owned");
    });

    it("does not mutate the caller's object when stamping the field (single-object form)", () => {
      // The injector returns a FRESH object, so the caller's own object never
      // gains a `module` property. (winston/`buildTimestampCapture` still write
      // `level`/`timestamp` — the documented reserved-slot boundary — but
      // `module` is package-added metadata and must not land on caller state.)
      const event: Record<string, unknown> = { message: "m", id: 7 };
      parseJson("api", (logger) => logger.info(event));
      expect(Object.prototype.hasOwnProperty.call(event, "module")).toBe(false);
      expect(event.id).toBe(7);
    });

    it("stamps the module on an Error line alongside its message and stack", () => {
      const parsed = parseJson("api", (logger) => logger.error(new Error("boom-module")));
      expect(parsed.module).toBe("api");
      expect(parsed.message).toBe("boom-module");
      expect(typeof parsed.stack).toBe("string");
      expect(parsed.stack as string).toContain("Error: boom-module");
    });

    it("stamps the module when maskMetaKeys is configured (survives redaction)", () => {
      const parsed = parseJson(
        "api",
        (logger) => logger.info("Login", { password: "hunter2", userId: 42 }),
        ["password"],
      );
      expect(parsed.module).toBe("api");
      expect(parsed.password).toBe("[REDACTED]");
      expect(parsed.userId).toBe(42);
    });

    it("boundary: a single-object toJSON DTO line carries NO module field (toJSON owns the line)", () => {
      class UserDto {
        public message = "user loaded";
        toJSON(): Record<string, unknown> {
          return { message: this.message };
        }
      }
      const parsed = parseJson("api", (logger) => logger.info(new UserDto()));
      expect(parsed).toEqual({ message: "user loaded" });
      expect(parsed).not.toHaveProperty("module");
    });

    it("boundary: an array info stays an array (no index-keyed rebuild, no module)", () => {
      const parsed = JSON.parse(
        renderJsonLine("api", (logger) => logger.log("info", ["a", "b"] as never)),
      ) as unknown;
      expect(parsed).toEqual(["a", "b"]);
    });

    it("emits the same `module` field on the console as in the file (json)", () => {
      const captureConsole = (emit: () => void): string => {
        const written: string[] = [];
        const target =
          (console as unknown as { _stdout?: NodeJS.WritableStream })._stdout ?? process.stdout;
        const original = target.write.bind(target);
        (target as unknown as { write: unknown }).write = (chunk: unknown): boolean => {
          written.push(String(chunk));
          return true;
        };
        try {
          emit();
        } finally {
          (target as unknown as { write: unknown }).write = original;
        }
        return written.join("");
      };
      const consoleOut = captureConsole(() => {
        const logger = createLogger({
          moduleName: "api",
          includeConsole: true,
          includeFile: false,
          includeGlobalFile: false,
          format: "json",
        });
        logger.info("Login", { userId: 42 });
        teardownLogger(logger);
      });
      const parsed = JSON.parse(consoleOut.trim()) as Record<string, unknown>;
      expect(parsed.module).toBe("api");
      expect(parsed.userId).toBe(42);
    });

    it("boundary: a single-object toJSON DTO gets NO module on the console either (no file/console divergence)", () => {
      // The injector lives only on the logger-level chain, so it skips the DTO
      // (which still carries its `toJSON`) once, upstream. The console never sees
      // a second injector, so it cannot re-stamp `module` onto the shallow clone
      // whose prototype (and `toJSON`) was stripped — console and file agree.
      const captureConsole = (emit: () => void): string => {
        const written: string[] = [];
        const target =
          (console as unknown as { _stdout?: NodeJS.WritableStream })._stdout ?? process.stdout;
        const original = target.write.bind(target);
        (target as unknown as { write: unknown }).write = (chunk: unknown): boolean => {
          written.push(String(chunk));
          return true;
        };
        try {
          emit();
        } finally {
          (target as unknown as { write: unknown }).write = original;
        }
        return written.join("");
      };
      class UserDto {
        public message = "user loaded";
        toJSON(): Record<string, unknown> {
          return { message: this.message };
        }
      }
      const consoleOut = captureConsole(() => {
        const logger = createLogger({
          moduleName: "api",
          includeConsole: true,
          includeFile: false,
          includeGlobalFile: false,
          format: "json",
        });
        logger.info(new UserDto());
        teardownLogger(logger);
      });
      const parsed = JSON.parse(consoleOut.trim()) as Record<string, unknown>;
      // (The console line may carry level/timestamp that the file's toJSON output
      // omits — that is the pre-existing console-vs-file toJSON boundary, pinned
      // elsewhere. The module-specific guarantee is the only thing under test
      // here: `module` is absent on the console just as it is on the file.)
      expect(parsed).not.toHaveProperty("module");
      expect(parsed.message).toBe("user loaded");
    });

    it("does not add a `module` metadata field in pretty mode (json-only change)", () => {
      const stream = new PassThrough();
      const chunks: string[] = [];
      stream.on("data", (chunk) => chunks.push(chunk.toString()));
      const logger = createLogger({
        moduleName: "api",
        includeConsole: false,
        includeFile: false,
        includeGlobalFile: false,
        format: "pretty",
        additionalTransports: [new winston.transports.Stream({ stream })],
      });
      logger.info("Login");
      teardownLogger(logger);
      const rendered = chunks.join("");
      expect(rendered).toContain("(api)");
      expect(rendered).not.toContain('"module"');
    });

    it("buildModuleFieldInjector: returns a fresh object with the field, preserving symbols", () => {
      const injector = __loggerInternals.buildModuleFieldInjector("api");
      const LEVEL = Symbol.for("level");
      const input: Record<string | symbol, unknown> = {
        level: "info",
        message: "m",
        [LEVEL]: "info",
      };
      const out = injector.transform(input as any) as Record<string | symbol, unknown>;
      expect(out).not.toBe(input);
      expect(out[__loggerInternals.MODULE_FIELD]).toBe("api");
      expect(out[LEVEL]).toBe("info");
      // The input is left untouched.
      expect(Object.prototype.hasOwnProperty.call(input, "module")).toBe(false);
    });

    it("buildModuleFieldInjector: skips FORBIDDEN_KEYS when rebuilding the fresh object", () => {
      const injector = __loggerInternals.buildModuleFieldInjector("api");
      // A `__proto__` own data property (as `JSON.parse('{"__proto__":{}}')`
      // mints) must not be copied onto the fresh object — the same
      // prototype-pollution guard the rest of the pipeline applies.
      const input = JSON.parse('{"message":"m","__proto__":{"polluted":true}}') as Record<
        string,
        unknown
      >;
      const out = injector.transform(input as any) as Record<string, unknown>;
      expect(out.module).toBe("api");
      expect(Object.prototype.hasOwnProperty.call(out, "__proto__")).toBe(false);
      expect((out as { polluted?: unknown }).polluted).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // Formatter totality — a log call must never throw at the caller.
  //
  // The pretty printf runs synchronously inside `logger.log()`, so every
  // JSON.stringify in it propagates out of the application's own
  // `logger.info(...)` call rather than degrading the line. Both inputs below
  // crash the DEFAULT, no-mask config — which made enabling `maskMetaKeys`
  // (whose walk bounds the graph first) paradoxically SAFER than leaving it off.
  // ---------------------------------------------------------------------------
  describe("formatter totality (pretty mode never throws at the caller)", () => {
    const captureStream = () => {
      const stream = new PassThrough();
      const chunks: string[] = [];
      stream.on("data", (chunk: Buffer) => chunks.push(chunk.toString()));
      return { stream, rendered: () => chunks.join("") };
    };

    const streamLogger = (moduleName: string, stream: PassThrough) =>
      createLogger({
        moduleName,
        includeConsole: false,
        includeFile: false,
        includeGlobalFile: false,
        additionalTransports: [new winston.transports.Stream({ stream })],
      });

    it("logs a deep metadata payload with NO maskMetaKeys instead of throwing RangeError", () => {
      // Depth 8000 exhausts JSON.stringify itself. Pre-fix, the unguarded
      // metadata stringify threw RangeError straight out of logger.info.
      const deep: Record<string, unknown> = {};
      let cursor = deep;
      for (let i = 0; i < 8000; i += 1) {
        const next: Record<string, unknown> = {};
        cursor.child = next;
        cursor = next;
      }
      const { stream, rendered } = captureStream();
      const logger = streamLogger("total-deep-nomask", stream);

      expect(() => logger.info("Deep", { payload: deep })).not.toThrow();
      teardownLogger(logger);

      // The line still renders; only the metadata block degrades.
      expect(rendered()).toContain("[INFO] (total-deep-nomask)");
      expect(rendered()).toContain("Deep");
      expect(rendered()).toContain("[UNSERIALIZABLE]");
    });

    it("logs a circular message object instead of throwing TypeError", () => {
      const circular: Record<string, unknown> = { name: "root" };
      circular.self = circular;
      const { stream, rendered } = captureStream();
      const logger = streamLogger("total-circular-msg", stream);

      // `logger.info(obj)` puts the object itself on `info.message`, which the
      // printf stringifies — pre-fix: "Converting circular structure to JSON".
      expect(() => logger.info(circular as unknown as string)).not.toThrow();
      teardownLogger(logger);

      expect(rendered()).toContain("[INFO] (total-circular-msg)");
      expect(rendered()).toContain("[UNSERIALIZABLE]");
    });

    it("logs a circular non-string stack instead of throwing TypeError", () => {
      const circularStack: Record<string, unknown> = { frames: 1 };
      circularStack.self = circularStack;
      const { stream, rendered } = captureStream();
      const logger = streamLogger("total-circular-stack", stream);

      expect(() => logger.info("Boom", { stack: circularStack })).not.toThrow();
      teardownLogger(logger);

      expect(rendered()).toContain("[INFO] (total-circular-stack)");
      expect(rendered()).toContain("Boom");
      expect(rendered()).toContain("[UNSERIALIZABLE]");
    });

    it("still renders a serializable non-string message and stack unchanged (no false sentinel)", () => {
      // Pins that the guard only fires on genuine failure — the happy path
      // must be byte-for-byte what it was before.
      const { stream, rendered } = captureStream();
      const logger = streamLogger("total-happy", stream);

      logger.info({ a: 1 } as unknown as string);
      logger.info("Boom", { stack: { frames: ["a", "b"] } });
      teardownLogger(logger);

      expect(rendered()).not.toContain("[UNSERIALIZABLE]");
      expect(rendered()).toContain('"a": 1');
      expect(rendered()).toContain('"frames"');
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

    /**
     * Renders `logger.error(new Error(payload))` through the real pipeline —
     * which is what makes this test meaningful. `errors({ stack: true })` runs
     * ahead of the printf and flattens the Error into a string `message` PLUS a
     * string `stack` whose first line repeats that message, so an Error is the
     * one input that reaches the printf's stack branch with attacker bytes in
     * it. Rendering the formatter in isolation would not exercise it.
     */
    const renderInjectedError = (escape: boolean): string => {
      const stream = new PassThrough();
      const chunks: string[] = [];
      stream.on("data", (chunk) => chunks.push(chunk.toString()));
      const logger = createLogger({
        // The printf's `(label)` is the moduleName (`src/logger.ts:1261`).
        moduleName: `escape-stack-${escape ? "on" : "off"}`,
        includeConsole: false,
        includeFile: false,
        includeGlobalFile: false,
        escapeMessageNewlines: escape,
        additionalTransports: [new winston.transports.Stream({ stream })],
      });
      logger.error(new Error(FORGERY_PAYLOAD));
      teardownLogger(logger);
      return chunks.join("");
    };

    /**
     * A username-shaped payload that closes the current line and opens a fake
     * one in the printf's own `${levelToken} (${label})` format.
     */
    const FORGERY_PAYLOAD =
      "login failed for alice\n[ERROR] (admin)\nfake critical event: account drained";
    const FORGED_LINE = "[ERROR] (admin)";

    it("escapes the stack of an Error so a payload cannot forge a log line", () => {
      const rendered = renderInjectedError(true);
      // The core guarantee: no rendered LINE is the forged entry. Asserting on
      // whole lines (not `toContain`) is what actually pins the defect — the
      // forged text still appears, escaped and inline, which is the point.
      const lines = rendered.split("\n");
      expect(lines).not.toContain(FORGED_LINE);
      // Nothing on the payload's behalf survived as a real newline byte...
      expect(rendered).not.toContain("alice\n[ERROR]");
      // ...but the payload's contents are still fully readable for debugging,
      // now as visible literal escape sequences, on BOTH the message line and
      // the stack line below it.
      expect(rendered).toContain("alice\\n[ERROR] (admin)\\nfake critical event");
      // The genuine entry this logger produced is of course still a real line.
      expect(lines).toContain("[ERROR] (escape-stack-on)");
    });

    it("leaves an Error stack rendering unchanged when omitted (back-compat)", () => {
      const rendered = renderInjectedError(false);
      // Default (`false`) behavior is untouched by the stack fix: the stack
      // renders verbatim, multi-line, raw newlines intact. This is the
      // back-compat pin — the forged line IS present here, which is precisely
      // the exposure the opt-in option exists to close.
      expect(rendered).toContain("alice\n[ERROR] (admin)\nfake critical event");
      expect(rendered).not.toContain("alice\\n[ERROR]");
      // A real multi-line stack still spans multiple lines when the option is
      // off — the trade-off documented on the option applies only when it is on.
      expect(rendered).toContain("\n    at ");
    });

    it("escapes a string stack directly through the printf, and passes through when off", () => {
      // Direct internals call pinning the stack branch itself, independent of
      // winston's `errors()` flattening — including that a NON-string stack
      // still goes through safeStringify (whose JSON encoding escapes newlines
      // on its own) rather than the escape helper.
      const render = (escape: boolean, stack: unknown): string => {
        const formatter = __loggerInternals.formatMessage(
          { label: "test", timezones: [] },
          { includeTimestamps: false, escapeMessageNewlines: escape },
        );
        const info = formatter.transform({ level: "error", message: "boom", stack } as any);
        return Reflect.get(info as Record<PropertyKey, unknown>, Symbol.for("message")) as string;
      };

      expect(render(true, "Error: boom\n    at forged")).toContain("Error: boom\\n    at forged");
      expect(render(false, "Error: boom\n    at forged")).toContain("Error: boom\n    at forged");
      // Non-string stack: serialized, not escaped — the sequence below is
      // JSON.stringify's own escaping, present regardless of the option.
      expect(render(true, { nested: "a\nb" })).toContain("a\\nb");
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

    // -------------------------------------------------------------------------
    // Phase 7 — JSON-mode circular references end-to-end (Task 7.2, closes F12)
    // -------------------------------------------------------------------------

    it("json mode WITH maskMetaKeys redacts a circular metadata object via buildMetaRedactor's WeakSet (Phase 7)", () => {
      // `circular` is passed AS the metadata object, so winston merges its own
      // enumerable keys directly onto `info` — `info.self === circular` and
      // `circular.self === circular` form a genuine cycle. With a non-empty
      // `maskMetaKeys`, `buildMetaRedactor` runs the shared `redactValue(...)`
      // over every metadata key BEFORE `winston.format.json()` ever sees the
      // object, so the cycle is resolved into the literal string "[Circular]"
      // by OUR WeakSet-based detection (src/redact.ts), not by
      // safe-stable-stringify's own handling (exercised by the sibling test
      // below, without maskMetaKeys).
      const circular: Record<string, unknown> = { keep: 1 };
      circular.self = circular;

      let output = "";
      expect(() => {
        output = renderJsonLine(
          "json-circular-masked",
          (logger) => {
            logger.info("circular", circular);
          },
          { maskMetaKeys: ["password"] },
        );
      }).not.toThrow();

      const line = output.trim();
      expect(() => JSON.parse(line)).not.toThrow();
      const parsed = JSON.parse(line) as Record<string, unknown>;

      expect(line).toContain('"[Circular]"');
      expect(parsed.keep).toBe(1);
      expect(parsed.self).toEqual({ keep: 1, self: "[Circular]" });
    });

    it("json mode WITHOUT maskMetaKeys handles a circular metadata object via winston.format.json()'s safe-stable-stringify (Phase 7)", () => {
      // Same circular payload, but `maskMetaKeys` is omitted entirely so
      // `buildMetaRedactor` takes its documented no-op pass-through branch
      // (early return on `!maskMetaKeys || maskMetaKeys.size === 0`). The raw,
      // still-circular `info` object reaches `winston.format.json()` untouched,
      // so this exercises `safe-stable-stringify`'s OWN circular-reference
      // handling — its default `circularValue` is also the literal
      // "[Circular]" (confirmed in node_modules/safe-stable-stringify/index.js),
      // so the two code paths are expected to produce equivalent output.
      const circular: Record<string, unknown> = { keep: 1 };
      circular.self = circular;

      let output = "";
      expect(() => {
        output = renderJsonLine("json-circular-unmasked", (logger) => {
          logger.info("circular", circular);
        });
      }).not.toThrow();

      const line = output.trim();
      expect(() => JSON.parse(line)).not.toThrow();
      const parsed = JSON.parse(line) as Record<string, unknown>;

      expect(line).toContain('"[Circular]"');
      expect(parsed.keep).toBe(1);
      expect(parsed.self).toEqual({ keep: 1, self: "[Circular]" });
    });

    // -------------------------------------------------------------------------
    // Phase 1 (redact.ts DAG/diamond fix) — json-mode, cross-top-level-key
    // -------------------------------------------------------------------------

    it("json mode WITH maskMetaKeys renders both occurrences of a shared metadata object across two top-level keys (DAG/diamond fix)", () => {
      // `shared` is referenced by TWO separate top-level metadata keys (`a`,
      // `b`), both merged directly onto `info` by winston. `buildMetaRedactor`
      // creates ONE `seen` WeakSet for the whole format call and reuses it
      // across its loop over `Object.keys(info)`, so this specifically
      // exercises whether the SECOND top-level `redactValue` call still sees
      // `shared` as available (active-path fix) instead of falsely flagging
      // it as a cycle just because the FIRST top-level call already visited
      // — and fully unwound from — the same reference.
      const shared = { password: "topsecret", keep: "visible" };

      const output = renderJsonLine(
        "json-diamond-cross-key",
        (logger) => {
          logger.info("Login", { a: shared, b: shared });
        },
        { maskMetaKeys: ["password"] },
      );

      const line = output.trim();
      expect(line).not.toContain('"[Circular]"');
      expect(line).not.toContain("topsecret");

      const parsed = JSON.parse(line) as {
        a: { password: string; keep: string };
        b: { password: string; keep: string };
      };
      expect(parsed.a).toEqual({ password: "[REDACTED]", keep: "visible" });
      expect(parsed.b).toEqual({ password: "[REDACTED]", keep: "visible" });
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

/**
 * Characterization suite for a deliberate boundary: neither format chain
 * composes `winston.format.splat()`, so a message containing a printf token
 * (`%s %d %j %i %f %o %O %%`) causes winston to route a trailing metadata
 * object into its `SPLAT` slot — which nothing in these chains reads — and the
 * metadata is not emitted.
 *
 * These tests pin that behavior deliberately rather than fixing it, for a
 * reason worth restating at the assertion site: adding `splat()` does NOT
 * recover the metadata for the canonical one-token/one-object call, and it
 * would forfeit something more valuable than it buys. `logform/splat.js`
 * computes `extraSplat = (tokens - escapes) - splat.length`; for
 * `info("route /a%d", meta)` that is `1 - 1 = 0`, so NO merge occurs and
 * `util.format` instead consumes the metadata object as the `%d` argument —
 * rewriting the caller's message to `"route /aNaN"` while STILL dropping the
 * metadata. The status quo is byte-identical to bare winston's own default
 * format (`winston/lib/winston/logger.js:105` falls back to `logform/json`
 * with no splat), and winston's own docs mark interpolation opt-in
 * ("Requires `winston.format.splat()`").
 *
 * The invariant these tests defend is therefore stronger than the metadata
 * they give up: **this logger renders the caller's message text verbatim and
 * never passes it through `util.format`.** The percent-encoding case below is
 * the load-bearing canary for that.
 */
describe("printf tokens in a message (winston splat parity)", () => {
  afterEach(() => {
    // Mirrors the `createLogger` suite's own hook. Every logger below is torn
    // down via `teardownLogger` (whose `close()` already evicts its registry
    // entry), so this is belt-and-braces — it keeps the suite honest if a case
    // is ever added that reuses a `moduleName`.
    resetLoggerRegistry();
    jest.restoreAllMocks();
  });

  /** Renders one log line through a Stream transport in the given format mode. */
  const render = (
    moduleName: string,
    format: "json" | "pretty",
    emit: (logger: winston.Logger) => void,
  ): string => {
    const stream = new PassThrough();
    const chunks: string[] = [];
    stream.on("data", (chunk) => chunks.push(chunk.toString()));
    const logger = createLogger({
      moduleName,
      includeConsole: false,
      includeFile: false,
      includeGlobalFile: false,
      format,
      additionalTransports: [new winston.transports.Stream({ stream })],
    });
    emit(logger);
    teardownLogger(logger);
    return chunks.join("");
  };

  describe.each([["json"], ["pretty"]] as const)("format: %s", (format) => {
    it("drops the trailing metadata object but renders the message verbatim", () => {
      const rendered = render(`splat-drop-${format}`, format, (logger) => {
        logger.info("route /a%d", { requestId: "r1" });
      });

      // The message survives byte-for-byte — this is the guarantee.
      expect(rendered).toContain("route /a%d");
      // The metadata is the documented casualty...
      expect(rendered).not.toContain("r1");
      // ...but the message was never run through `util.format`, so the `%d`
      // did not consume the object and coerce it to NaN.
      expect(rendered).not.toContain("NaN");
    });

    it("does not interpolate printf tokens", () => {
      const rendered = render(`splat-interp-${format}`, format, (logger) => {
        logger.info("User %s logged in", "u-42");
      });

      expect(rendered).toContain("User %s logged in");
      expect(rendered).not.toContain("u-42");
    });

    it("keeps metadata when the message contains no printf token", () => {
      // The contrast case: proves the drop above is token-triggered and that
      // the test is not passing for some unrelated reason.
      const rendered = render(`splat-control-${format}`, format, (logger) => {
        logger.info("route /users", { requestId: "r1" });
      });

      expect(rendered).toContain("route /users");
      expect(rendered).toContain("r1");
    });

    it("renders a percent-encoded URL byte-for-byte and never rewrites it", () => {
      // SECURITY-LOAD-BEARING CANARY. `formatRegExp` is `/%[scdjifoO%]/`, and
      // `c`, `d`, `f` are HEX DIGITS — so lowercase percent-encoded octets in
      // a URL (`%c3`, `%d0`, `%f0`) match as printf tokens. If anyone ever
      // adds `splat()` to a chain, `util.format` will consume the metadata as
      // the `%c` argument and emit nothing for it, silently rewriting this URL
      // to "route /caf3%a9" — an attacker-authored lie about which path was
      // requested. Today the metadata is merely absent and the URL is true;
      // log omission is recoverable, log forgery is not. This test fails the
      // day that trade is reversed.
      const rendered = render(`splat-pct-${format}`, format, (logger) => {
        logger.info("route /caf%c3%a9", { ip: "1.2.3.4" });
      });

      expect(rendered).toContain("route /caf%c3%a9");
      expect(rendered).not.toContain("caf3%a9");
      expect(rendered).not.toContain("1.2.3.4");
    });

    it("renders an escaped percent literally", () => {
      const rendered = render(`splat-escaped-${format}`, format, (logger) => {
        logger.info("50%% done", { requestId: "r1" });
      });

      // `%%` is in `formatRegExp` too, so it triggers the same drop.
      expect(rendered).toContain("50%% done");
      expect(rendered).not.toContain("r1");
    });
  });

  it("matches bare winston's default format byte-for-byte on a token message", () => {
    // Parity canary, mirroring the winston-canary pattern used by the
    // crash-capture suite: the drop is winston's own out-of-the-box behavior,
    // NOT something this package introduces. If a future winston release
    // starts composing splat() into its default format, this fails and the
    // documented boundary must be revisited.
    const stream = new PassThrough();
    const chunks: string[] = [];
    stream.on("data", (chunk) => chunks.push(chunk.toString()));
    const bare = winston.createLogger({
      level: "info",
      transports: [new winston.transports.Stream({ stream })],
    });
    bare.info("route /a%d", { requestId: "r1" });
    bare.close();
    const bareMessage = JSON.parse(chunks.join("").trim()).message;

    const ours = render("splat-parity", "json", (logger) => {
      logger.info("route /a%d", { requestId: "r1" });
    });
    const ourMessage = JSON.parse(ours.trim()).message;

    expect(bareMessage).toBe("route /a%d");
    expect(ourMessage).toBe(bareMessage);
    expect(JSON.parse(ours.trim()).requestId).toBeUndefined();
  });

  it("confirms util.format is what would rewrite the message, if it were ever applied", () => {
    // Documents the mechanism the canary above defends against, pinned against
    // the real `util.format` so the rationale cannot rot into folklore.
    expect(util.format("route /caf%c3%a9", { ip: "1.2.3.4" })).toBe("route /caf3%a9");
    expect(util.format("route /a%d", { requestId: "r1" })).toBe("route /aNaN");
  });
});
