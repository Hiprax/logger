import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import util from "node:util";
import vm from "node:vm";
import fc from "fast-check";
import winston from "winston";
import Transport from "winston-transport";
import DailyRotateFile from "winston-daily-rotate-file";
import moment from "moment-timezone";
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
import { FORBIDDEN_KEYS, MAX_REDACT_DEPTH, redactValue } from "../src/redact";
import {
  FORBIDDEN_KEYS as SERIALIZE_FORBIDDEN_KEYS,
  bigintSafeReplacer,
  createErrorAwareReplacer,
  errorAwareStringify,
  errorToPlain,
  isErrorLike,
} from "../src/serialize";
import { InvalidTimezoneError, LoggerOptionError } from "../src/errors";
import type { LoggerOptions } from "../src/types";
import { captureConsole, createTempDir, teardownLogger } from "./_helpers";

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

  it("renders a nested Error's fields in the info fallback", () => {
    const logger = createNoopTransportLogger();
    (logger as any).info = undefined;
    const logSpy = jest.fn();
    (logger as any).log = logSpy;
    const err = new Error("fallback failure");
    err.stack = "Error: fallback failure\n    at fixed (fixed.js:1:1)";

    (logger as any).obscure({ err });

    expect(logSpy).toHaveBeenCalledWith({
      level: "info",
      message: JSON.stringify({
        err: { name: "Error", message: "fallback failure", stack: err.stack },
      }),
    });
    expect(Object.keys(err)).toEqual([]);
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

    it("folds a case-varying globalModuleName into one shared global-file transport (P13/shared-file)", () => {
      // The shared-file registry key is normalized the same way the module
      // registry key is (`buildRegistryKey` — Windows-only lowercase, POSIX
      // identity). Two DISTINCT module loggers whose `globalModuleName` differs
      // only in case target the same physical global file on a case-insensitive
      // filesystem, so they must share ONE `DailyRotateFile`, not open two
      // rotators fighting over it. On a case-sensitive filesystem the two names
      // are genuinely different files, so two transports is correct there.
      const root = createTempDir();
      const a = createLogger({
        moduleName: "svc-a",
        logDirectory: root,
        includeConsole: false,
        includeFile: false,
        includeGlobalFile: true,
        globalModuleName: "SharedLog",
      });
      const b = createLogger({
        moduleName: "svc-b",
        logDirectory: root,
        includeConsole: false,
        includeFile: false,
        includeGlobalFile: true,
        globalModuleName: "sharedlog",
      });

      // Two different module loggers (distinct module keys), so neither is a
      // cache hit of the other; the assertion is purely about the shared-file key.
      expect(b).not.toBe(a);
      const expectedShared = process.platform === "win32" ? 1 : 2;
      expect(__sharedFileInternals.sharedFileRegistry.size).toBe(expectedShared);

      teardownLogger(a);
      teardownLogger(b);
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
        consoleLevelPinned: false,
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
        consoleLevelPinned: false,
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
          datePattern: "YYYY-MM-DD",
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
      // The upstream `Logger.log()` flow sets the symbol-keyed level slot
      // before any format runs; the console printf colors by `info.level`,
      // but the hand-built info mirrors the real shape so the format chain
      // sees exactly what winston would hand it.
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
      // `this.#secret` throws a TypeError from inside `json()`, and the line
      // would be replaced by the `_unserializable` sentinel. Invoking toJSON on
      // the REAL instance here is what makes this work.
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
      // timestamp props winston assigned onto the array) — which is why an
      // array subject is always delegated to `redactValue`, whether or not a
      // toJSON produced it.
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
      // the same mask-diverges-from-no-mask defect in a new shape. An array
      // output is delegated to `redactValue` instead.
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

    it("renders a toJSON returning a built-in exactly as the no-mask line does", () => {
      // The serializer calls `toJSON` once and serializes the returned `Date`
      // by its own enumerable keys (none), so the no-mask line is `{}`. The
      // masked path rebuilds the result key by key into a fresh object and
      // must produce the same line, without touching the caller's value.
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

    it("honors a top-level toJSON on the CONSOLE too when a mask is configured", () => {
      // The eager resolve happens in the logger-level chain, so the withheld
      // field never enters the rebuilt info at all. Since Phase 16.1 the Console
      // transport carries no format in json mode and simply emits the
      // logger-level `sharedFormat`'s already-serialized `info[MESSAGE]`, so the
      // console line is byte-identical to the file line. (Before the fix the
      // console ran its own duplicate chain and leaked `ssn` here.)
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

    it("honors a top-level toJSON on the console with NO mask too (Phase 16.1 closed the console/file divergence)", () => {
      // PRE-16.1 this was a pinned boundary: with no `maskMetaKeys`,
      // `buildMetaRedactor` is a zero-allocation identity pass, so the real DTO
      // instance reached the Console transport, which ran its OWN duplicate json
      // chain over the shallow clone winston hands it (`Object.assign({}, info)`)
      // — a clone that cannot carry a prototype, so the console's serializer
      // never found `toJSON` and re-exposed the `ssn` the DTO withholds, diverging
      // from the file line. Phase 16.1 dropped that duplicate chain: in json mode
      // the Console transport carries no format and emits the logger-level
      // `sharedFormat`'s already-serialized `info[MESSAGE]`, so console and file
      // are byte-identical and the withheld field stays withheld on both.
      let fileOut = "";
      const consoleOut = captureConsole(() => {
        const stream = new PassThrough();
        stream.on("data", (chunk) => {
          fileOut += chunk.toString();
        });
        const logger = createLogger({
          moduleName: "tojson-console-nomask",
          includeConsole: true,
          includeFile: false,
          includeGlobalFile: false,
          format: "json",
          additionalTransports: [new winston.transports.Stream({ stream })],
        });
        logger.info(new UserDto());
        teardownLogger(logger);
      });

      expect(consoleOut).not.toContain("123-45-6789");
      expect(consoleOut).toContain("user loaded");
      // The divergence is gone: the console line equals the file line exactly.
      expect(consoleOut.trim()).toBe(fileOut.trim());
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
  // Reserved-slot boundary (Phase 16.5) — the documented limit of the
  // mutation-safety guarantee above, pinned rather than left to a comment.
  //
  // Only `level` / `[LEVEL]` is now overwritten in place on the caller's object,
  // and that write is WINSTON's own (`create-logger.js:79`), before any format
  // runs — unavoidable. `timestamp` is NO LONGER an in-place overwrite: Phase
  // 16.5 made `buildTimestampCapture` copy-on-write for a plain-object info and
  // sequenced it after `errors({ stack: true })`, so a caller-supplied
  // `timestamp` on live state is left intact while the log still renders the
  // captured instant. The bare-winston canary below records the exact hazard
  // that fix avoids — bare winston still destroys the caller's `timestamp` in
  // place — so if a winston release ever changes that, the divergence is
  // revisited on purpose rather than by drift.
  // ---------------------------------------------------------------------------
  describe("reserved-slot boundary (level in place; timestamp copy-on-write)", () => {
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
      it("leaves a caller-supplied timestamp intact (copy-on-write) while rendering the captured instant", () => {
        // Branch: plain object WITH an own `timestamp`. The proven Phase 16.5
        // defect — `logger.info({ message, timestamp, id })` used to overwrite
        // `event.timestamp` on live state. Copy-on-write leaves it untouched.
        const event = {
          message: "webhook received",
          timestamp: "2024-01-01T00:00:00Z",
          id: 7,
        };

        const rendered = renderTo(`reserved-ts-${format}`, format, (logger) => {
          logger.info(event);
        });

        // The caller's object is NOT mutated.
        expect(event.timestamp).toBe("2024-01-01T00:00:00Z");
        expect(event.id).toBe(7);
        expect(event.message).toBe("webhook received");
        // ...but the log line still renders the CAPTURED instant, never the
        // caller-forged value (which does not appear anywhere in the line).
        expect(rendered).not.toContain("2024-01-01T00:00:00Z");
        expect(rendered).toMatch(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/);
      });

      it("does not add a timestamp to a plain-object caller that had none", () => {
        // Branch: plain object WITHOUT an own `timestamp`. Copy-on-write means
        // the caller's object never gains a `timestamp` property (only winston's
        // own `level` lands on it, before any format runs).
        const event: Record<string, unknown> = { message: "hi", id: 9 };

        renderTo(`reserved-nots-${format}`, format, (logger) => {
          logger.info(event);
        });

        expect(Object.prototype.hasOwnProperty.call(event, "timestamp")).toBe(false);
        expect(event.id).toBe(9);
      });

      it("still renders an Error's message and stack (errors() flattens before the capture copies)", () => {
        // The highest-value test in this suite. Phase 16.5 sequences
        // `errors({ stack: true })` AHEAD of `buildTimestampCapture`, so a logged
        // Error is flattened to a plain object with own-ENUMERABLE message/stack
        // before the copy-on-write runs — the copy preserves them. A naive
        // copy-on-write placed BEFORE `errors()` would instead rebuild the raw
        // Error into a plain object, dropping its own NON-enumerable message and
        // stack and defeating `errors.js:15`'s `instanceof Error` gate (verified:
        // the payload collapses to `{"level":"error","timestamp":"..."}`). This
        // fails the moment the ordering is reverted.
        const rendered = renderTo(`reserved-err-${format}`, format, (logger) => {
          logger.error(new Error("boom-reserved"));
        });

        expect(rendered).toContain("boom-reserved");
        expect(rendered).toContain("Error: boom-reserved");
        expect(rendered).toMatch(/\bat\b/);
      });

      it("leaves an Error's own enumerable timestamp intact and still renders it (branch: Error WITH own timestamp)", () => {
        // Branch: Error WITH an own enumerable `timestamp`. `errors()` copies the
        // Error's own enumerable props onto its fresh plain object, so the copy
        // carries `timestamp` — and the copy-on-write capture overwrites it only
        // on that engine-owned copy, never on the caller's Error. Message/stack
        // still render.
        const err = new Error("boom-err-ts") as Error & { timestamp?: string };
        err.timestamp = "2024-01-01T00:00:00Z";

        const rendered = renderTo(`reserved-err-ts-${format}`, format, (logger) => {
          logger.error(err);
        });

        expect(err.timestamp).toBe("2024-01-01T00:00:00Z");
        expect(rendered).toContain("boom-err-ts");
        expect(rendered).toContain("Error: boom-err-ts");
        expect(rendered).not.toContain("2024-01-01T00:00:00Z");
      });

      it("documented exception: an array or class-instance entry gets `timestamp` written in place", () => {
        // Branch: non-plain info. A plain copy would strip an array's arrayness
        // or a class instance's prototype (and its toJSON), so the capture
        // writes `timestamp` onto the logged object itself. The README states
        // this exception; the copy-on-write branches above cover plain objects.
        class LoginEvent {
          public message = "login";
          public id = 3;
        }
        const entries = ["a", "b"];
        const event = new LoginEvent();

        renderTo(`reserved-nonplain-${format}`, format, (logger) => {
          logger.log("info", entries as never);
          logger.info(event);
        });

        const stamp = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
        // The array stays an array with its elements untouched; winston's own
        // `level` and the captured `timestamp` are the only keys added.
        expect(Array.isArray(entries)).toBe(true);
        expect([entries[0], entries[1]]).toEqual(["a", "b"]);
        expect(Object.keys(entries)).toEqual(["0", "1", "level", "timestamp"]);
        expect((entries as unknown as Record<string, unknown>).timestamp).toMatch(stamp);
        // The instance keeps its prototype and its own values.
        expect(event).toBeInstanceOf(LoginEvent);
        expect(event.message).toBe("login");
        expect(event.id).toBe(3);
        expect(Object.keys(event)).toEqual(["message", "id", "level", "timestamp"]);
        expect((event as unknown as Record<string, unknown>).timestamp).toMatch(stamp);
      });
    });

    it("bare winston's own format.timestamp({ format }) still mutates in place (canary the fix diverges from)", () => {
      // This is the hazard Phase 16.5's copy-on-write avoids. Bare winston's
      // `format.timestamp({ format })` overwrites the caller's `timestamp` in
      // place (`logform/timestamp.js:15-19`), destroying live state. This package
      // deliberately diverges. If a winston release ever stops doing this, the
      // divergence is revisited on purpose rather than by drift.
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

      // Bare winston destroys the caller's timestamp in place — what we avoid.
      expect(event.timestamp).not.toBe("2024-01-01T00:00:00Z");
      expect(event.timestamp).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
      expect(event.id).toBe(7);
      bare.close();
    });
  });

  // ---------------------------------------------------------------------------
  // Phase 16 — hot-path performance (byte-identical output)
  //
  // 16.1 drops the duplicate json-mode Console format chain (the console now
  // reuses the logger-level `sharedFormat`'s `info[MESSAGE]`); 16.2 guards the
  // per-log `moment` timezone parse on `ctx.timezones.length > 0` and removes an
  // identity `.map`; 16.4 wraps `winston.format.json()` so a serializer throw
  // degrades to a sentinel line instead of crashing the caller. These tests pin
  // that none of it changed the emitted bytes on the happy path.
  // ---------------------------------------------------------------------------
  describe("Phase 16 — hot-path performance (byte-identical output)", () => {
    const FIXED_ISO = "2031-03-04T05:06:07Z";
    const FIXED_TS = "2031-03-04 05:06:07";
    const fixedClock = (): Date => new Date(FIXED_ISO);

    const renderStream = (
      options: Parameters<typeof createLogger>[0],
      emit: (logger: winston.Logger) => void,
    ): string => {
      const stream = new PassThrough();
      let out = "";
      stream.on("data", (chunk) => {
        out += chunk.toString();
      });
      const logger = createLogger({
        includeConsole: false,
        includeFile: false,
        includeGlobalFile: false,
        clock: fixedClock,
        ...options,
        additionalTransports: [
          // `eol: "\n"` keeps the byte-for-byte assertions platform-independent
          // (winston's Stream transport otherwise appends `os.EOL`, i.e. CRLF on
          // Windows). The formatter's own trailing `\n` is unaffected.
          new winston.transports.Stream({ stream, eol: "\n" }),
          ...(options?.additionalTransports ?? []),
        ],
      });
      emit(logger);
      teardownLogger(logger);
      return out;
    };

    it("16.1 json mode: the Console line is byte-identical to the file line", () => {
      let fileOut = "";
      const consoleOut = captureConsole(() => {
        const stream = new PassThrough();
        stream.on("data", (chunk) => {
          fileOut += chunk.toString();
        });
        const logger = createLogger({
          moduleName: "perf-json",
          format: "json",
          includeConsole: true,
          includeFile: false,
          includeGlobalFile: false,
          clock: fixedClock,
          additionalTransports: [new winston.transports.Stream({ stream })],
        });
        logger.info("hello", { userId: 42, nested: { a: [1, 2, 3] } });
        teardownLogger(logger);
      });

      expect(consoleOut.trim()).toBe(fileOut.trim());
      const parsed = JSON.parse(consoleOut.trim()) as Record<string, unknown>;
      expect(parsed.message).toBe("hello");
      expect(parsed.module).toBe("perf-json");
      expect(parsed.userId).toBe(42);
      expect(parsed.timestamp).toBe(FIXED_TS);
    });

    it("16.1 json mode with maskMetaKeys: console and file lines stay byte-identical", () => {
      let fileOut = "";
      const consoleOut = captureConsole(() => {
        const stream = new PassThrough();
        stream.on("data", (chunk) => {
          fileOut += chunk.toString();
        });
        const logger = createLogger({
          moduleName: "perf-json-mask",
          format: "json",
          includeConsole: true,
          includeFile: false,
          includeGlobalFile: false,
          maskMetaKeys: ["password"],
          clock: fixedClock,
          additionalTransports: [new winston.transports.Stream({ stream })],
        });
        logger.info("login", { password: "hunter2", userId: 7 });
        teardownLogger(logger);
      });

      expect(consoleOut.trim()).toBe(fileOut.trim());
      expect(consoleOut).toContain('"password":"[REDACTED]"');
      expect(consoleOut).not.toContain("hunter2");
    });

    it("16.2 pretty mode with NO extraTimezones: renders exactly the UTC line and nothing more", () => {
      const out = renderStream({ moduleName: "perf-pretty" }, (logger) => logger.info("hi"));
      expect(out).toBe(`UTC: ${FIXED_TS}\n[INFO] (perf-pretty)\nhi\n\n`);
    });

    it("16.2 pretty mode WITH extraTimezones: UTC line then one line per zone, in order (byte-identical)", () => {
      const zones = ["Europe/London", "America/New_York"];
      const out = renderStream({ moduleName: "perf-pretty-tz", extraTimezones: zones }, (logger) =>
        logger.info("hi"),
      );

      // Build the expected zone lines the same way the formatter does, so the
      // assertion is DST-robust and still byte-exact.
      const captured = moment.utc(FIXED_TS, "YYYY-MM-DD HH:mm:ss");
      const zoneLines = zones
        .map((zone) => `${zone}: ${captured.clone().tz(zone).format("YYYY-MM-DD HH:mm:ss")}`)
        .join("\n");
      expect(out).toBe(`UTC: ${FIXED_TS}\n${zoneLines}\n[INFO] (perf-pretty-tz)\nhi\n\n`);
    });

    it("16.2 pretty console (no timestamps) is unchanged by the timezone guard", () => {
      // The console pretty format omits timestamps entirely, so the guard never
      // runs there; pin that the console line is still the plain colorize-free
      // `[LEVEL] (label)\nmessage` form.
      const consoleOut = captureConsole(() => {
        const logger = createLogger({
          moduleName: "perf-pretty-console",
          includeConsole: true,
          includeFile: false,
          includeGlobalFile: false,
          colorize: false,
          extraTimezones: ["Europe/London"],
          clock: fixedClock,
        });
        logger.info("hi");
        teardownLogger(logger);
      });
      expect(consoleOut.trim()).toBe("[INFO] (perf-pretty-console)\nhi");
      // The console line never carries a UTC/timezone line.
      expect(consoleOut).not.toContain("UTC:");
      expect(consoleOut).not.toContain("Europe/London");
    });

    it("16.2 with NO extraTimezones skips the mirror-parse (moment.utc 2-arg form is never called)", () => {
      // Teeth for the 16.2 optimization: the `moment.utc(utcString, TIMESTAMP_FORMAT)`
      // mirror-parse (two string args) is the ~9µs the guard removes and must NOT
      // run when there are no extra timezones. Output is byte-identical either
      // way (the loop never iterates), so only a call-count spy catches a silent
      // revert of the `ctx.timezones.length > 0` guard. Other moment.utc calls —
      // the capture's `moment.utc(clock())`, a single Date arg — are unrelated.
      const spy = jest.spyOn(moment, "utc");
      try {
        renderStream({ moduleName: "perf-tz-guard-off" }, (logger) => logger.info("hi"));
        const mirrorParseCalls = spy.mock.calls.filter(
          (args) => args.length === 2 && typeof args[0] === "string" && typeof args[1] === "string",
        );
        expect(mirrorParseCalls).toHaveLength(0);
      } finally {
        spy.mockRestore();
      }
    });

    it("16.2 WITH extraTimezones runs the mirror-parse (guard's other branch)", () => {
      const spy = jest.spyOn(moment, "utc");
      try {
        renderStream(
          { moduleName: "perf-tz-guard-on", extraTimezones: ["Europe/London"] },
          (logger) => logger.info("hi"),
        );
        const mirrorParseCalls = spy.mock.calls.filter(
          (args) => args.length === 2 && typeof args[0] === "string" && typeof args[1] === "string",
        );
        expect(mirrorParseCalls.length).toBeGreaterThanOrEqual(1);
      } finally {
        spy.mockRestore();
      }
    });

    it("16.4 json mode: a serializer-exhausting payload degrades to a sentinel line, no throw at the caller", () => {
      // A payload deep enough to exhaust JSON.stringify itself throws RangeError
      // from inside winston's own `json()`. With NO maskMetaKeys the redactor's
      // depth guard never runs, so pre-16.4 this crashed the caller's own
      // logger.info(...). 16.4 wraps `json()` so it degrades to a sentinel.
      const deep: Record<string, unknown> = {};
      let cursor = deep;
      for (let i = 0; i < 12000; i++) {
        const child: Record<string, unknown> = {};
        cursor.next = child;
        cursor = child;
      }

      let fileOut = "";
      let consoleOut = "";
      expect(() => {
        consoleOut = captureConsole(() => {
          const stream = new PassThrough();
          stream.on("data", (chunk) => {
            fileOut += chunk.toString();
          });
          const logger = createLogger({
            moduleName: "perf-json-deep",
            format: "json",
            includeConsole: true,
            includeFile: false,
            includeGlobalFile: false,
            clock: fixedClock,
            additionalTransports: [new winston.transports.Stream({ stream })],
          });
          logger.info("too deep", { deep });
          teardownLogger(logger);
        });
      }).not.toThrow();

      // Both the file and console lines carry the same sentinel — 16.1 keeps
      // them identical on the failure path too.
      expect(consoleOut.trim()).toBe(fileOut.trim());
      const parsed = JSON.parse(consoleOut.trim()) as Record<string, unknown>;
      expect(parsed._unserializable).toBe(true);
      expect(parsed.level).toBe("info");
      expect(parsed.module).toBe("perf-json-deep");
      expect(parsed.timestamp).toBe(FIXED_TS);
    });

    it("16.4 json mode with maskMetaKeys never reaches the sentinel (depth guard bounds first)", () => {
      // When a mask is configured, buildMetaRedactor bounds the graph to
      // MAX_REDACT_DEPTH before json() runs, so the serializer never throws and
      // the line renders normally — the sentinel path is unreachable here.
      const deep: Record<string, unknown> = {};
      let cursor = deep;
      for (let i = 0; i < 12000; i++) {
        const child: Record<string, unknown> = {};
        cursor.next = child;
        cursor = child;
      }
      const out = renderStream(
        { moduleName: "perf-json-deep-mask", format: "json", maskMetaKeys: ["password"] },
        (logger) => logger.info("deep but masked", { password: "hunter2", deep }),
      );
      const parsed = JSON.parse(out.trim()) as Record<string, unknown>;
      expect(parsed._unserializable).toBeUndefined();
      expect(parsed.message).toBe("deep but masked");
      // The top-level masked key is redacted; the deep payload is bounded by the
      // redactor's MAX_REDACT_DEPTH guard, so json() never throws.
      expect(parsed.password).toBe("[REDACTED]");
    });

    it("json mode: a throwing metadata getter degrades to a sentinel, no throw at the caller", () => {
      // A caller metadata value can be a getter — caller code that may throw.
      // In json mode with NO maskMetaKeys the getter survives untouched to
      // `json()`, whose serializer invokes it and throws; buildSafeJsonFormat
      // must catch and degrade to a sentinel rather than let it escape out of the
      // caller's own logger.info(). The injected `module` field is a data string
      // here, so it is still reported.
      const payload: Record<string, unknown> = { message: "hostile token" };
      Object.defineProperty(payload, "token", {
        enumerable: true,
        get() {
          throw new Error("token boom");
        },
      });
      let out = "";
      expect(() => {
        out = renderStream({ moduleName: "json-getter", format: "json" }, (logger) =>
          logger.info(payload),
        );
      }).not.toThrow();
      const parsed = JSON.parse(out.trim()) as Record<string, unknown>;
      expect(parsed._unserializable).toBe(true);
      expect(parsed.module).toBe("json-getter");
      expect(parsed.level).toBe("info");
    });

    it("json mode: a throwing caller `module` getter cannot re-escape the sentinel fallback", () => {
      // Regression for the sentinel's own re-throw hole. `buildModuleFieldInjector`
      // leaves a caller-supplied own `module` key untouched in the no-mask
      // default, so a hostile `{ get module() { throw } }` both makes `json()`
      // throw AND is the field buildSafeJsonFormat's catch reads while building
      // the sentinel — pre-fix it re-threw out of logger.info(). The catch must
      // read `module` defensively; the sentinel then carries no `module` (the
      // hostile getter could not be read) rather than crashing.
      const payload: Record<string, unknown> = { message: "hostile module" };
      Object.defineProperty(payload, "module", {
        enumerable: true,
        get() {
          throw new Error("module boom");
        },
      });
      let out = "";
      expect(() => {
        out = renderStream({ moduleName: "json-mod-getter", format: "json" }, (logger) =>
          logger.info(payload),
        );
      }).not.toThrow();
      const parsed = JSON.parse(out.trim()) as Record<string, unknown>;
      expect(parsed._unserializable).toBe(true);
      expect(parsed.level).toBe("info");
      // The hostile getter could not be read, so `module` is absent (undefined →
      // omitted by JSON.stringify), not a crash and not the label.
      expect(parsed).not.toHaveProperty("module");
    });

    it("pretty mode: a throwing metadata getter fails closed instead of crashing the caller", () => {
      // formatMessage builds its metadata bag by DESCRIPTOR transplant, never
      // invoking a caller getter during extraction — so a `{ get token() { throw } }`
      // payload logs a line whose metadata block fails closed (UNSERIALIZABLE)
      // rather than throwing out of the caller's logger.info() (verified pre-fix:
      // pretty mode crashed). The level/message lines still render.
      const payload: Record<string, unknown> = { message: "pretty hostile" };
      Object.defineProperty(payload, "token", {
        enumerable: true,
        get() {
          throw new Error("pretty boom");
        },
      });
      let out = "";
      expect(() => {
        out = renderStream({ moduleName: "pretty-getter" }, (logger) => logger.info(payload));
      }).not.toThrow();
      expect(out).toContain("[INFO] (pretty-getter)");
      expect(out).toContain("pretty hostile");
      expect(out).toContain("[UNSERIALIZABLE]");
    });

    it("pretty mode with maskMetaKeys: a throwing non-masked getter fails closed, line still logged", () => {
      // The mask path reads a non-masked value inside redactValue, which is
      // wrapped; a throwing getter there degrades the whole metadata block to
      // `_redactionFailed` rather than crashing. Extraction still never invokes
      // the getter (descriptor transplant), so the throw is contained.
      const payload: Record<string, unknown> = { message: "masked hostile", password: "hunter2" };
      Object.defineProperty(payload, "token", {
        enumerable: true,
        get() {
          throw new Error("masked boom");
        },
      });
      let out = "";
      expect(() => {
        out = renderStream(
          { moduleName: "pretty-mask-getter", maskMetaKeys: ["password"] },
          (logger) => logger.info(payload),
        );
      }).not.toThrow();
      expect(out).toContain("[INFO] (pretty-mask-getter)");
      expect(out).toContain("masked hostile");
      expect(out).toContain("_redactionFailed");
      expect(out).not.toContain("hunter2");
    });

    it("pretty mode: a throwing `stack` accessor (non-Error payload) fails closed, does not crash", () => {
      // `stack` is a RESERVED key, but a non-Error caller payload can still carry
      // a throwing `stack` accessor that `errors()` never neutralizes (it reads
      // `stack` only for an actual Error). formatMessage reads `stack` inside a
      // try/catch and fails closed — the stack line is omitted, the caller's
      // logger.info() does not throw (verified pre-fix: it crashed).
      const payload: Record<string, unknown> = { message: "pretty stack" };
      Object.defineProperty(payload, "stack", {
        enumerable: true,
        get() {
          throw new Error("stack boom");
        },
      });
      let out = "";
      expect(() => {
        out = renderStream({ moduleName: "pretty-stack-getter" }, (logger) => logger.info(payload));
      }).not.toThrow();
      expect(out).toContain("[INFO] (pretty-stack-getter)");
      expect(out).toContain("pretty stack");
      expect(out).not.toContain("stack boom");
    });

    it("json mode + maskMetaKeys: a throwing `stack` accessor fails closed on that key, no throw", () => {
      // In json mode WITH a mask, buildMetaRedactor copies reserved keys, which
      // READS `subject.stack`; a throwing accessor there escaped out of
      // logger.log() pre-fix. The reserved-key copy is now guarded and fails
      // closed to the RedactionFailed sentinel; the rest of the line still
      // renders. (No mask → buildSafeJsonFormat catches json()'s throw instead.)
      const payload: Record<string, unknown> = { message: "json stack", password: "hunter2" };
      Object.defineProperty(payload, "stack", {
        enumerable: true,
        get() {
          throw new Error("stack boom");
        },
      });
      let out = "";
      expect(() => {
        out = renderStream(
          { moduleName: "json-stack-getter", format: "json", maskMetaKeys: ["password"] },
          (logger) => logger.info(payload),
        );
      }).not.toThrow();
      const parsed = JSON.parse(out.trim()) as Record<string, unknown>;
      expect(parsed.message).toBe("json stack");
      expect(parsed.stack).toBe("[RedactionFailed]");
      expect(parsed.password).toBe("[REDACTED]");
      expect(out).not.toContain("stack boom");
    });

    it("json mode (no mask): a throwing `stack` accessor degrades to the sentinel, no throw", () => {
      const payload: Record<string, unknown> = { message: "json stack nomask" };
      Object.defineProperty(payload, "stack", {
        enumerable: true,
        get() {
          throw new Error("stack boom");
        },
      });
      let out = "";
      expect(() => {
        out = renderStream({ moduleName: "json-stack-nomask", format: "json" }, (logger) =>
          logger.info(payload),
        );
      }).not.toThrow();
      const parsed = JSON.parse(out.trim()) as Record<string, unknown>;
      expect(parsed._unserializable).toBe(true);
      expect(out).not.toContain("stack boom");
    });

    it("pretty mode: a throwing `level` accessor (getter+setter) does not crash the caller", () => {
      // A `level` defined as a throwing getter WITH a setter passes winston's own
      // `info.level = level` (the setter runs, leaving the accessor live), so
      // formatMessage's level read would crash the caller pre-fix. readReserved
      // guards it, falling back to the "info" display level. (A getter-ONLY level
      // instead crashes at winston's own assignment — the winston-core boundary.)
      const payload: Record<string, unknown> = { message: "level hostile" };
      Object.defineProperty(payload, "level", {
        configurable: true,
        enumerable: true,
        get() {
          throw new Error("level boom");
        },
        set() {
          /* no-op: absorb winston's `info.level = level` so the accessor survives */
        },
      });
      let out = "";
      expect(() => {
        out = renderStream({ moduleName: "pretty-level-getter" }, (logger) => logger.info(payload));
      }).not.toThrow();
      expect(out).toContain("[INFO] (pretty-level-getter)");
      expect(out).toContain("level hostile");
      expect(out).not.toContain("level boom");
    });

    it("pretty CONSOLE: neutralizeCallerAccessors keeps the console re-clone from crashing on a throwing getter", () => {
      // winston-transport re-runs the console format over Object.assign({}, info),
      // which invokes every enumerable own getter and RE-THROWS on error — so a
      // caller-supplied throwing accessor would crash logger.info() there even
      // though the logger-level formats are getter-safe. neutralizeCallerAccessors
      // (added to the pretty chain when a console exists) resolves accessors to
      // data first. This payload exercises every branch of that format: a throwing
      // accessor (fails closed), a non-throwing accessor (resolved), a plain data
      // key (copied), and a FORBIDDEN key (skipped). Verified pre-fix: the default
      // console logger crashed here.
      const payload: Record<string, unknown> = { message: "console safe", plain: 7 };
      Object.defineProperty(payload, "willThrow", {
        enumerable: true,
        configurable: true,
        get() {
          throw new Error("console boom");
        },
      });
      Object.defineProperty(payload, "computed", {
        enumerable: true,
        configurable: true,
        get() {
          return "ok-value";
        },
      });
      Object.defineProperty(payload, "constructor", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: "poison",
      });

      let consoleOut = "";
      expect(() => {
        consoleOut = captureConsole(() => {
          const logger = createLogger({
            moduleName: "console-neutralize",
            format: "pretty",
            colorize: false,
            includeConsole: true,
            includeFile: false,
            includeGlobalFile: false,
            clock: fixedClock,
          });
          logger.info(payload);
          teardownLogger(logger);
        });
      }).not.toThrow();

      expect(consoleOut).toContain("(console-neutralize)");
      expect(consoleOut).toContain("console safe");
      // The non-throwing accessor is resolved to its value...
      expect(consoleOut).toContain("ok-value");
      // ...the throwing accessor fails closed (never re-thrown into the clone)...
      expect(consoleOut).not.toContain("console boom");
      // ...and the FORBIDDEN prototype-pollution key is skipped, not emitted.
      expect(consoleOut).not.toContain("poison");
    });

    it("pretty (console off) + a format-carrying additionalTransport: neutralize still runs, no crash", () => {
      // neutralize is added whenever a format-carrying transport exists — not
      // only when the built-in console does. A caller-supplied additionalTransport
      // that sets its OWN `format` triggers winston-transport's re-clone-and-
      // rethrow, so a throwing accessor would crash there without neutralize.
      const stream = new PassThrough();
      let out = "";
      stream.on("data", (chunk) => {
        out += chunk.toString();
      });
      const payload: Record<string, unknown> = { message: "at-pretty" };
      Object.defineProperty(payload, "lazy", {
        enumerable: true,
        configurable: true,
        get() {
          throw new Error("at-boom");
        },
      });
      expect(() => {
        const logger = createLogger({
          moduleName: "at-pretty-test",
          format: "pretty",
          includeConsole: false,
          includeFile: false,
          includeGlobalFile: false,
          additionalTransports: [
            new winston.transports.Stream({ stream, format: winston.format.json(), eol: "\n" }),
          ],
        });
        logger.info(payload);
        teardownLogger(logger);
      }).not.toThrow();
      expect(out).toContain("at-pretty");
      expect(out).not.toContain("at-boom");
    });

    it("json + a format-carrying additionalTransport: neutralize is added to the json chain, no crash", () => {
      // The built-in json console is formatless (safe), but a caller-supplied
      // format-carrying additionalTransport re-clones the info; neutralize is
      // added to the json chain when such a transport exists.
      const stream = new PassThrough();
      let out = "";
      stream.on("data", (chunk) => {
        out += chunk.toString();
      });
      const payload: Record<string, unknown> = { message: "at-json" };
      Object.defineProperty(payload, "lazy", {
        enumerable: true,
        configurable: true,
        get() {
          throw new Error("at-boom-json");
        },
      });
      expect(() => {
        const logger = createLogger({
          moduleName: "at-json-test",
          format: "json",
          includeConsole: false,
          includeFile: false,
          includeGlobalFile: false,
          additionalTransports: [
            new winston.transports.Stream({ stream, format: winston.format.json(), eol: "\n" }),
          ],
        });
        logger.info(payload);
        teardownLogger(logger);
      }).not.toThrow();
      expect(out).toContain("at-json");
      expect(out).not.toContain("at-boom-json");
    });

    it("non-plain payload with a getter-only `timestamp` accessor does not crash and renders the captured instant", () => {
      // buildTimestampCapture keeps a non-plain info in place (to preserve a
      // DTO's toJSON / an array's arrayness), but must not crash writing
      // `timestamp` when the instance exposes it as a getter-only/computed field
      // (`class AuditEvent { get timestamp() {…} }`). It installs an OWN data
      // property (shadowing the inherited getter) instead of assigning through
      // it. Verified pre-fix: this threw `Cannot set property timestamp ... which
      // has only a getter` out of logger.info().
      class AuditEvent {
        public message = "user login";
        // A getter-only accessor is the whole point of this test (a readonly
        // data field would not reproduce the "set on getter-only throws" crash),
        // so the class-literal-property-style suggestion does not apply here.
        // eslint-disable-next-line @typescript-eslint/class-literal-property-style
        get timestamp(): string {
          return "2024-immutable";
        }
      }
      for (const format of ["pretty", "json"] as const) {
        let out = "";
        expect(() => {
          out = renderStream({ moduleName: `ts-getter-${format}`, format }, (logger) =>
            logger.info(new AuditEvent()),
          );
        }).not.toThrow();
        // The CAPTURED instant renders, never the caller's computed getter value.
        expect(out).toContain("user login");
        expect(out).toContain(FIXED_TS);
        expect(out).not.toContain("2024-immutable");
      }
    });

    it("non-plain payload with a THROWING `timestamp` accessor does not crash (getter shadowed)", () => {
      class ThrowingTs {
        public message = "m";
        get timestamp(): string {
          throw new Error("ts boom");
        }
      }
      let out = "";
      expect(() => {
        out = renderStream(
          { moduleName: "ts-throw-json", format: "json", maskMetaKeys: ["password"] },
          (logger) => logger.info(new ThrowingTs()),
        );
      }).not.toThrow();
      expect(out).not.toContain("ts boom");
      const parsed = JSON.parse(out.trim()) as Record<string, unknown>;
      expect(parsed.message).toBe("m");
      expect(parsed.timestamp).toBe(FIXED_TS);
    });

    it("non-plain payload with a non-configurable throwing `timestamp` accessor fails closed (write + read guards), no crash", () => {
      // The exotic edge: an EXTENSIBLE non-plain instance (so winston's own
      // `info[LEVEL]` write succeeds) with a NON-CONFIGURABLE own `timestamp`
      // accessor that throws. `Object.defineProperty` cannot redefine it, so
      // buildTimestampCapture's write catch leaves it in place, and
      // formatMessage's `timestamp` read guard then falls back to a fresh
      // timestamp instead of invoking the throwing getter. Exercises BOTH the
      // defineProperty catch and the formatMessage timestamp read guard.
      class LockedThrowingTs {
        public message = "locked-msg";
        constructor() {
          Object.defineProperty(this, "timestamp", {
            get() {
              throw new Error("locked-ts-boom");
            },
            enumerable: true,
            configurable: false,
          });
        }
      }
      let out = "";
      expect(() => {
        out = renderStream({ moduleName: "ts-locked-pretty" }, (logger) =>
          logger.info(new LockedThrowingTs()),
        );
      }).not.toThrow();
      expect(out).toContain("[INFO] (ts-locked-pretty)");
      expect(out).toContain("locked-msg");
      expect(out).toContain("UTC:");
      expect(out).not.toContain("locked-ts-boom");
    });

    it("hostile Error with an own enumerable throwing accessor does not crash pretty mode (errors() wrap)", () => {
      // `logform/errors.js` flattens an Error via `Object.assign` over its OWN
      // ENUMERABLE properties (`errors.js:16`), invoking a hostile own-enumerable
      // getter and throwing at the FIRST format — before neutralizeCallerAccessors
      // (which runs last) and every downstream guard, escaping out of
      // `logger.error(...)`. `buildSafeErrorsFormat` wraps `errors()` the way
      // `buildSafeJsonFormat` wraps `json()`: it degrades to a minimal flattening
      // that preserves the readable message/stack and marks the degradation,
      // instead of crashing. (An idiomatic PROTOTYPE getter is immune —
      // `Object.assign` copies own props only — so this needs an OWN-instance
      // accessor, e.g. one defined in the constructor.)
      class HostileError extends Error {
        constructor(m: string) {
          super(m);
          this.name = "HostileError";
          Object.defineProperty(this, "detail", {
            enumerable: true,
            configurable: true,
            get() {
              throw new Error("detail boom");
            },
          });
        }
      }
      let out = "";
      expect(() => {
        out = renderStream({ moduleName: "err-hostile-pretty" }, (logger) =>
          logger.error(new HostileError("pretty error msg")),
        );
      }).not.toThrow();
      expect(out).toContain("[ERROR] (err-hostile-pretty)");
      expect(out).toContain("pretty error msg");
      expect(out).toContain("_errorFlattenFailed");
      expect(out).not.toContain("detail boom");
    });

    it("hostile Error does not crash json mode; message/stack preserved on the degrade path", () => {
      class HostileError extends Error {
        constructor(m: string) {
          super(m);
          this.name = "HostileError";
          Object.defineProperty(this, "detail", {
            enumerable: true,
            configurable: true,
            get() {
              throw new Error("detail boom");
            },
          });
        }
      }
      let out = "";
      expect(() => {
        out = renderStream({ moduleName: "err-hostile-json", format: "json" }, (logger) =>
          logger.error(new HostileError("json error msg")),
        );
      }).not.toThrow();
      const parsed = JSON.parse(out.trim()) as Record<string, unknown>;
      expect(parsed.level).toBe("error");
      expect(parsed.message).toBe("json error msg");
      expect(typeof parsed.stack).toBe("string");
      expect(parsed.stack as string).toContain("HostileError");
      expect(parsed._errorFlattenFailed).toBe(true);
      expect(parsed.module).toBe("err-hostile-json");
      expect(out).not.toContain("detail boom");
    });

    it("hostile Error passed as `message` on the 2-arg log form is flattened getter-safely", () => {
      // errors.js:33 (`einfo.message instanceof Error`) does `Object.assign(einfo, err)`,
      // the sibling crash site, reached via `logger.log("error", { message: err })`.
      class HostileError extends Error {
        constructor(m: string) {
          super(m);
          this.name = "HostileError";
          Object.defineProperty(this, "detail", {
            enumerable: true,
            configurable: true,
            get() {
              throw new Error("detail boom");
            },
          });
        }
      }
      let out = "";
      expect(() => {
        out = renderStream({ moduleName: "err-hostile-2arg", format: "json" }, (logger) =>
          logger.log("error", { message: new HostileError("2arg error msg") }),
        );
      }).not.toThrow();
      const parsed = JSON.parse(out.trim()) as Record<string, unknown>;
      expect(parsed.level).toBe("error");
      expect(parsed.message).toBe("2arg error msg");
      expect(parsed._errorFlattenFailed).toBe(true);
      expect(out).not.toContain("detail boom");
    });

    it("hostile Error with a throwing `stack` accessor degrades: message kept, stack dropped, no crash", () => {
      // A DIFFERENT crash site inside `errors()`: a non-enumerable throwing `stack`
      // accessor is skipped by `Object.assign` (line 16) but read directly by
      // `errors.js:23` (`info.stack = einfo.stack`), so `errors()` throws there.
      // The catch then re-reads `stack` defensively — exercising `safeReadFrom`'s
      // own try/catch — and fails closed on that one field (stack dropped) while
      // the readable message survives.
      class StackThrower extends Error {
        constructor(m: string) {
          super(m);
          this.name = "StackThrower";
          Object.defineProperty(this, "stack", {
            configurable: true,
            enumerable: false,
            get() {
              throw new Error("stack boom");
            },
          });
        }
      }
      let out = "";
      expect(() => {
        out = renderStream({ moduleName: "err-stack-throw", format: "json" }, (logger) =>
          logger.error(new StackThrower("stack-thrower msg")),
        );
      }).not.toThrow();
      const parsed = JSON.parse(out.trim()) as Record<string, unknown>;
      expect(parsed.level).toBe("error");
      expect(parsed.message).toBe("stack-thrower msg");
      expect(parsed.stack).toBeUndefined();
      expect(parsed._errorFlattenFailed).toBe(true);
      expect(out).not.toContain("stack boom");
    });

    it("a throwing `message` getter on the log()/2-arg form is caught by the errors() wrap (not a boundary)", () => {
      // On the single-object LEVEL-METHOD form (`logger.error(obj)`) winston reads
      // `.message` in create-logger.js BEFORE any format runs — an unavoidable
      // boundary. But on the `logger.log(level, obj)` / 2-arg form the FIRST
      // `.message` read happens INSIDE `logform/errors.js` (errors.js:28), which is
      // now wrapped by buildSafeErrorsFormat — so a throwing `message` getter there
      // degrades instead of crashing the caller. Pins the closed boundary the docs
      // describe (the single-object form remains a documented winston-core boundary).
      for (const format of ["pretty", "json"] as const) {
        const payload: Record<string, unknown> = { data: 1 };
        Object.defineProperty(payload, "message", {
          enumerable: true,
          configurable: true,
          get() {
            throw new Error("msg boom");
          },
        });
        let out = "";
        expect(() => {
          out = renderStream({ moduleName: `err-msg-2arg-${format}`, format }, (logger) =>
            logger.log("error", payload),
          );
        }).not.toThrow();
        expect(out).not.toContain("msg boom");
        expect(out).toContain("_errorFlattenFailed");
      }
    });

    it("bare-winston parity: the same hostile Error crashes bare winston + errors()+json, but not this logger", () => {
      // Proves the crash is a real logform boundary (not an invented one) AND that
      // buildSafeErrorsFormat closes it. Bare winston composing the SAME
      // `errors({ stack: true }) + json()` throws synchronously out of `.error()`;
      // this package's logger degrades instead.
      class HostileError extends Error {
        constructor(m: string) {
          super(m);
          this.name = "HostileError";
          Object.defineProperty(this, "detail", {
            enumerable: true,
            configurable: true,
            get() {
              throw new Error("detail boom");
            },
          });
        }
      }
      const bareStream = new PassThrough();
      const bare = winston.createLogger({
        transports: [new winston.transports.Stream({ stream: bareStream, eol: "\n" })],
        format: winston.format.combine(
          winston.format.errors({ stack: true }),
          winston.format.json(),
        ),
      });
      // Absorb any re-emitted error so a stray async event cannot crash the runner.
      bare.on("error", () => undefined);
      expect(() => bare.error(new HostileError("bare boom"))).toThrow();

      expect(() => {
        renderStream({ moduleName: "err-parity", format: "json" }, (logger) =>
          logger.error(new HostileError("guarded")),
        );
      }).not.toThrow();
    });

    it("a NORMAL Error still flattens on the happy path (no degradation marker)", () => {
      // Regression guard: the wrapper delegates to the real `errors()` for every
      // non-hostile Error, so normal Error logging is unchanged and carries NO
      // `_errorFlattenFailed` marker — the happy path is byte-identical to the
      // un-wrapped format.
      for (const format of ["pretty", "json"] as const) {
        let out = "";
        expect(() => {
          out = renderStream({ moduleName: `err-normal-${format}`, format }, (logger) =>
            logger.error(new Error("ordinary failure")),
          );
        }).not.toThrow();
        expect(out).toContain("ordinary failure");
        expect(out).not.toContain("_errorFlattenFailed");
      }
    });

    it("16.5 buildTimestampCapture copy-on-writes a null-prototype info without mutating it", () => {
      // Exercises the `proto === null` arm of the plain-object branch directly:
      // an `Object.create(null)` info (no `Object.prototype`) is still a plain
      // bag, so it must be copy-on-written, not mutated in place.
      const capture = __loggerInternals.buildTimestampCapture(() => new Date(FIXED_ISO));
      const info = Object.create(null) as Record<string, unknown>;
      info.level = "info";
      info.message = "null-proto";
      info.id = 5;

      const result = capture.transform(info as never) as Record<string, unknown>;

      // A fresh object carrying the captured timestamp and the original fields.
      expect(result).not.toBe(info);
      expect(result.timestamp).toBe(FIXED_TS);
      expect(result.message).toBe("null-proto");
      expect(result.id).toBe(5);
      // The caller's null-prototype object is untouched (no timestamp added).
      expect(Object.prototype.hasOwnProperty.call(info, "timestamp")).toBe(false);
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

    it('maskMetaKeys: ["module"] redacts the injected module field', () => {
      // The injector runs BEFORE buildMetaRedactor, so the stamped `module` field
      // is an ordinary metadata key the redactor threads through — masking
      // "module" must replace the label with [REDACTED], an opt-in the operator
      // controls. Guards against a future regression that adds "module" to
      // RESERVED_INFO_KEYS (which would let it bypass the mask check).
      const parsed = parseJson("api", (logger) => logger.info("hi"), ["module"]);
      expect(parsed.module).toBe("[REDACTED]");
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

      // Since Phase 16.1 the json-mode Console transport carries NO format, so
      // there is no second format to re-run timestampCapture: clock() fires once
      // in the logger-level format and both the console and file lines carry that
      // single captured timestamp.
      expect(clockCalls).toBe(1);
    });

    it("json mode Console transport has no format and reuses the logger-level MESSAGE (Phase 16.1)", () => {
      // Phase 16.1: the json-mode Console transport carries NO per-transport
      // format. winston-transport's `_write` then emits the logger-level format's
      // already-serialized `info[MESSAGE]` verbatim (`modern.js`: `if (info &&
      // !this.format) return this.log(info)`), so the console line is
      // byte-identical to the file line — same captured timestamp — with the
      // redaction + json() serialization run exactly once and no second clock()
      // read that could desync it.
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
        consoleTransport as unknown as { format?: winston.Logform.Format }
      ).format;

      // The Console transport has NO format in json mode — it reuses MESSAGE.
      expect(consoleTransportFormat).toBeUndefined();

      const syntheticInfo = {
        level: "info",
        message: "hello",
        [Symbol.for("level")]: "info",
      };

      // The logger-level format serializes the whole line (with the captured
      // timestamp) into info[MESSAGE]; the formatless Console transport emits
      // that same slot, so the console line is exactly this.
      const afterLogger = loggerLevelFormat.transform({ ...syntheticInfo } as any);
      expect(afterLogger).not.toBe(false);

      teardownLogger(logger);

      const loggerJson = JSON.parse(
        Reflect.get(afterLogger as Record<PropertyKey, unknown>, Symbol.for("message")) as string,
      ) as Record<string, unknown>;

      expect(loggerJson.timestamp).toBe("2030-06-15 12:34:56");
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

describe("runtime level changes", () => {
  afterEach(() => {
    resetLoggerRegistry();
    jest.restoreAllMocks();
  });

  /**
   * Concatenates every rotated log file written for `prefix` in `dir`, read
   * off disk. Reading the directory keeps the assertion independent of the
   * rotator's local-vs-UTC `%DATE%` resolution.
   */
  const readLogFiles = (dir: string, prefix: string): string =>
    fs
      .readdirSync(dir)
      .filter((name) => name.startsWith(`${prefix}-`) && name.endsWith(".log"))
      .map((name) => fs.readFileSync(path.join(dir, name), "utf8"))
      .join("");

  /** The rotation audit files (`.<hash>-audit.json`) present in `dir`. */
  const auditFiles = (dir: string): string[] =>
    fs.readdirSync(dir).filter((name) => /^\..+-audit\.json$/.test(name));

  describe.each([["pretty"], ["json"]] as const)("format: %s", (format) => {
    it('delivers a debug line to the console, module file, and global file after `logger.level = "debug"`', async () => {
      const root = createTempDir();
      const logger = createLogger({
        moduleName: `rl-raise-${format}`,
        logDirectory: root,
        captureUncaught: false,
        format,
      });

      const consoleOut = captureConsole(() => {
        logger.debug("RL-BEFORE-RAISE");
        logger.level = "debug";
        logger.debug("RL-AFTER-RAISE");
      });
      await shutdownLogger(logger);

      const moduleFile = readLogFiles(root, `rl-raise-${format}`);
      const globalFile = readLogFiles(root, "all-logs");
      expect(consoleOut).toContain("RL-AFTER-RAISE");
      expect(moduleFile).toContain("RL-AFTER-RAISE");
      expect(globalFile).toContain("RL-AFTER-RAISE");
      // The line logged BEFORE the change was still gated at "info" everywhere.
      expect(consoleOut).not.toContain("RL-BEFORE-RAISE");
      expect(moduleFile).not.toContain("RL-BEFORE-RAISE");
      expect(globalFile).not.toContain("RL-BEFORE-RAISE");
      // Exactly one line each: no duplicate delivery through any transport.
      expect(moduleFile.split("RL-AFTER-RAISE").length - 1).toBe(1);
      expect(globalFile.split("RL-AFTER-RAISE").length - 1).toBe(1);
      expect(consoleOut.split("RL-AFTER-RAISE").length - 1).toBe(1);
    });
  });

  it('stops an info line from reaching any built-in transport after `logger.level = "warn"`', async () => {
    const root = createTempDir();
    const logger = createLogger({
      moduleName: "rl-lower",
      logDirectory: root,
      captureUncaught: false,
    });

    const consoleOut = captureConsole(() => {
      logger.level = "warn";
      logger.info("RL-INFO-SUPPRESSED");
      logger.warn("RL-WARN-KEPT");
    });
    await shutdownLogger(logger);

    const moduleFile = readLogFiles(root, "rl-lower");
    const globalFile = readLogFiles(root, "all-logs");
    expect(consoleOut).not.toContain("RL-INFO-SUPPRESSED");
    expect(moduleFile).not.toContain("RL-INFO-SUPPRESSED");
    expect(globalFile).not.toContain("RL-INFO-SUPPRESSED");
    // The level still admits what it should: the suppression is not a blanket drop.
    expect(consoleOut).toContain("RL-WARN-KEPT");
    expect(moduleFile).toContain("RL-WARN-KEPT");
    expect(globalFile).toContain("RL-WARN-KEPT");
  });

  it("keeps runtime levels independent between two loggers sharing the global file", async () => {
    const root = createTempDir();
    const chatty = createLogger({
      moduleName: "rl-shared-chatty",
      logDirectory: root,
      includeConsole: false,
      captureUncaught: false,
    });
    const quiet = createLogger({
      moduleName: "rl-shared-quiet",
      logDirectory: root,
      includeConsole: false,
      captureUncaught: false,
    });

    chatty.level = "debug";
    chatty.debug("RL-CHATTY-DEBUG");
    quiet.debug("RL-QUIET-DEBUG");
    await shutdownLogger(chatty);
    await shutdownLogger(quiet);

    const globalFile = readLogFiles(root, "all-logs");
    expect(globalFile).toContain("RL-CHATTY-DEBUG");
    expect(readLogFiles(root, "rl-shared-chatty")).toContain("RL-CHATTY-DEBUG");
    // The other logger sharing the same file never changed level, so its debug
    // line reaches neither its own file nor the shared one.
    expect(globalFile).not.toContain("RL-QUIET-DEBUG");
    expect(readLogFiles(root, "rl-shared-quiet")).not.toContain("RL-QUIET-DEBUG");
    expect(quiet.level).toBe("info");
  });

  it("keeps an explicit `consoleLevel` pinned while the files follow `logger.level`", async () => {
    const root = createTempDir();
    const logger = createLogger({
      moduleName: "rl-pinned",
      logDirectory: root,
      consoleLevel: "info",
      captureUncaught: false,
    });

    const consoleOut = captureConsole(() => {
      logger.level = "debug";
      logger.debug("RL-PINNED-DEBUG");
      logger.info("RL-PINNED-INFO");
    });
    await shutdownLogger(logger);

    expect(readLogFiles(root, "rl-pinned")).toContain("RL-PINNED-DEBUG");
    expect(readLogFiles(root, "all-logs")).toContain("RL-PINNED-DEBUG");
    // The pinned console ignores the runtime change...
    expect(consoleOut).not.toContain("RL-PINNED-DEBUG");
    // ...but still logs at its own pinned level.
    expect(consoleOut).toContain("RL-PINNED-INFO");
  });

  it("reports `isLevelEnabled` consistently with emission when only built-in transports exist", async () => {
    const root = createTempDir();
    const logger = createLogger({
      moduleName: "rl-enabled",
      logDirectory: root,
      captureUncaught: false,
    });

    expect(logger.isLevelEnabled("debug")).toBe(false);
    const consoleOut = captureConsole(() => {
      logger.level = "debug";
      logger.debug("RL-ENABLED-DEBUG");
    });

    expect(logger.isLevelEnabled("debug")).toBe(true);
    expect(logger.isDebugEnabled()).toBe(true);
    // One level past the new threshold stays disabled.
    expect(logger.isLevelEnabled("silly")).toBe(false);
    await shutdownLogger(logger);
    expect(consoleOut).toContain("RL-ENABLED-DEBUG");
    expect(readLogFiles(root, "rl-enabled")).toContain("RL-ENABLED-DEBUG");
    expect(readLogFiles(root, "all-logs")).toContain("RL-ENABLED-DEBUG");
  });

  it("leaves construction-time gating unchanged when the level is never changed", async () => {
    const root = createTempDir();
    const logger = createLogger({
      moduleName: "rl-static",
      logDirectory: root,
      captureUncaught: false,
    });

    const consoleOut = captureConsole(() => {
      logger.debug("RL-STATIC-DEBUG");
      logger.info("RL-STATIC-INFO");
    });
    await shutdownLogger(logger);

    const moduleFile = readLogFiles(root, "rl-static");
    const globalFile = readLogFiles(root, "all-logs");
    expect(consoleOut).not.toContain("RL-STATIC-DEBUG");
    expect(moduleFile).not.toContain("RL-STATIC-DEBUG");
    expect(globalFile).not.toContain("RL-STATIC-DEBUG");
    expect(consoleOut).toContain("RL-STATIC-INFO");
    expect(moduleFile).toContain("RL-STATIC-INFO");
    expect(globalFile).toContain("RL-STATIC-INFO");
    expect(logger.isLevelEnabled("debug")).toBe(false);
  });

  it("keeps the module file's rotation audit file name unchanged (same constructor options as before)", async () => {
    // The audit file is named from a hash of EVERY DailyRotateFile constructor
    // option, `level` included, and file-stream-rotator only prunes files listed
    // in it. A reference transport built with the exact options the module file
    // has always received must therefore land on the SAME audit file; if the
    // module file were built with different options (say, without `level`) there
    // would be two audit files and existing installs would stop pruning.
    const root = createTempDir();
    const logger = createLogger({
      moduleName: "rl-audit",
      logDirectory: root,
      includeConsole: false,
      includeGlobalFile: false,
      captureUncaught: false,
      rotation: { maxSize: "5M", maxFiles: "3D" },
    });
    expect(auditFiles(root)).toHaveLength(1);

    const reference = new DailyRotateFile({
      // `.native`, like the logger's own `resolveLogDirectory`: on Windows the
      // JS `realpathSync` keeps 8.3 short names (`RUNNER~1`), which would change
      // the absolute filename and therefore the hash.
      filename: path.join(fs.realpathSync.native(root), "rl-audit-%DATE%.log"),
      datePattern: "YYYY-MM-DD",
      maxSize: "5m",
      maxFiles: "3d",
      zippedArchive: false,
      level: "info",
    });
    await new Promise<void>((resolve) => {
      reference.once("finish", () => resolve());
      reference.close?.();
    });
    await shutdownLogger(logger);

    const audits = auditFiles(root);
    expect(audits).toHaveLength(1);
    const audit = JSON.parse(fs.readFileSync(path.join(root, audits[0]), "utf8")) as {
      files: { name: string }[];
    };
    // Every entry names this transport's own dated file (a run spanning local
    // midnight may legitimately list two dates, so the count is not pinned).
    const names = audit.files.map((file) => path.basename(file.name));
    expect(names.length).toBeGreaterThan(0);
    names.forEach((name) => expect(name).toMatch(/^rl-audit-\d{4}-\d{2}-\d{2}\.log$/));
  });

  it('keeps the shared global file\'s rotation audit file name unchanged (built at "silly")', async () => {
    // Same retention hazard as the module file: the shared sink has always been
    // constructed with `level: "silly"`, and that value feeds its audit-file
    // hash. Its gating lives on each logger's handle, so the constructor option
    // looks redundant, yet dropping it would orphan every existing install's
    // `all-logs` audit file.
    const root = createTempDir();
    const logger = createLogger({
      moduleName: "rl-global-audit",
      logDirectory: root,
      includeConsole: false,
      includeFile: false,
      captureUncaught: false,
      rotation: { maxSize: "7M", maxFiles: "4D" },
    });
    expect(auditFiles(root)).toHaveLength(1);

    const reference = new DailyRotateFile({
      filename: path.join(fs.realpathSync.native(root), "all-logs-%DATE%.log"),
      datePattern: "YYYY-MM-DD",
      maxSize: "7m",
      maxFiles: "4d",
      zippedArchive: false,
      level: "silly",
    });
    await new Promise<void>((resolve) => {
      reference.once("finish", () => resolve());
      reference.close?.();
    });
    await shutdownLogger(logger);

    const audits = auditFiles(root);
    expect(audits).toHaveLength(1);
    const audit = JSON.parse(fs.readFileSync(path.join(root, audits[0]), "utf8")) as {
      files: { name: string }[];
    };
    // Every entry names this transport's own dated file (a run spanning local
    // midnight may legitimately list two dates, so the count is not pinned).
    const names = audit.files.map((file) => path.basename(file.name));
    expect(names.length).toBeGreaterThan(0);
    names.forEach((name) => expect(name).toMatch(/^all-logs-\d{4}-\d{2}-\d{2}\.log$/));
  });

  it("keeps a pinned console at its level when `logger.level` is LOWERED below it", async () => {
    const root = createTempDir();
    const logger = createLogger({
      moduleName: "rl-pinned-down",
      logDirectory: root,
      consoleLevel: "info",
      captureUncaught: false,
    });

    const consoleOut = captureConsole(() => {
      logger.level = "warn";
      logger.info("RL-PINNED-DOWN-INFO");
    });
    await shutdownLogger(logger);

    // The pinned console still admits info...
    expect(consoleOut).toContain("RL-PINNED-DOWN-INFO");
    // ...while the files follow the stricter logger level.
    expect(readLogFiles(root, "rl-pinned-down")).not.toContain("RL-PINNED-DOWN-INFO");
    expect(readLogFiles(root, "all-logs")).not.toContain("RL-PINNED-DOWN-INFO");
  });

  it('still records a crash in the module file after `logger.level` is lowered to "warn"', async () => {
    // Crash records are logged at `error` through the elected primary's
    // `log()`, so they pass every level the logger can be lowered to within the
    // hierarchy.
    const exitFn = jest.fn();
    __crashCaptureInternals.setExitFn(exitFn);
    try {
      const root = createTempDir();
      const logger = createLogger({
        moduleName: "rl-crash",
        logDirectory: root,
        includeConsole: false,
        includeGlobalFile: false,
        exitOnUncaught: false,
      });

      logger.level = "warn";
      logger.info("RL-CRASH-INFO-SUPPRESSED");
      __crashCaptureInternals.invokeUncaught(new Error("RL-CRASH-MARKER"));
      await shutdownLogger(logger);

      const moduleFile = readLogFiles(root, "rl-crash");
      expect(moduleFile).toContain("uncaughtException: RL-CRASH-MARKER");
      expect(moduleFile).not.toContain("RL-CRASH-INFO-SUPPRESSED");
      expect(exitFn).not.toHaveBeenCalled();
    } finally {
      __crashCaptureInternals.restoreExitFn();
    }
  });

  describe("consoleLevelPinned in the options signature", () => {
    const quietOptions = (root: string): Parameters<typeof createLogger>[0] => ({
      moduleName: "rl-signature",
      logDirectory: root,
      includeConsole: false,
      includeFile: false,
      includeGlobalFile: false,
      captureUncaught: false,
    });

    it("warns when a cached key's second call adds a `consoleLevel` equal to `level`", () => {
      const root = createTempDir();
      const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => undefined);

      const first = createLogger(quietOptions(root));
      const second = createLogger({ ...quietOptions(root), consoleLevel: "info" });

      expect(second).toBe(first);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      const message = String(warnSpy.mock.calls[0][0]);
      // The resolved `consoleLevel` is "info" on both calls, so the pin is the
      // ONLY divergence; it must be named on its own.
      expect(message).toContain("Differing fields: consoleLevelPinned.");
      teardownLogger(first);
    });

    it("warns when a cached key's second call removes the `consoleLevel` pin", () => {
      const root = createTempDir();
      const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => undefined);

      const first = createLogger({ ...quietOptions(root), consoleLevel: "info" });
      const second = createLogger(quietOptions(root));

      expect(second).toBe(first);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(String(warnSpy.mock.calls[0][0])).toContain("Differing fields: consoleLevelPinned.");
      teardownLogger(first);
    });

    it("does not warn when both calls pin the same `consoleLevel`", () => {
      const root = createTempDir();
      const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => undefined);

      const first = createLogger({ ...quietOptions(root), consoleLevel: "warn" });
      const second = createLogger({ ...quietOptions(root), consoleLevel: "warn" });

      expect(second).toBe(first);
      expect(warnSpy).not.toHaveBeenCalled();
      teardownLogger(first);
    });
  });

  it('drops even an error line from every built-in transport after `logger.level = "silent"` (a non-empty string outside the hierarchy matches no level)', async () => {
    // "silent" is not an npm level: winston resolves it to no level value, so
    // every transport that inherits the logger level rejects every entry.
    // `logger.silent = true` is the supported way to silence a logger.
    const root = createTempDir();
    const logger = createLogger({
      moduleName: "rl-silent",
      logDirectory: root,
      captureUncaught: false,
    });

    const consoleOut = captureConsole(() => {
      logger.error("RL-ERROR-BEFORE-SILENT");
      logger.level = "silent";
      logger.error("RL-ERROR-WHILE-SILENT");
    });
    expect(logger.isLevelEnabled("error")).toBe(false);
    await shutdownLogger(logger);

    const moduleFile = readLogFiles(root, "rl-silent");
    const globalFile = readLogFiles(root, "all-logs");
    expect(consoleOut).toContain("RL-ERROR-BEFORE-SILENT");
    expect(moduleFile).toContain("RL-ERROR-BEFORE-SILENT");
    expect(globalFile).toContain("RL-ERROR-BEFORE-SILENT");
    expect(consoleOut).not.toContain("RL-ERROR-WHILE-SILENT");
    expect(moduleFile).not.toContain("RL-ERROR-WHILE-SILENT");
    expect(globalFile).not.toContain("RL-ERROR-WHILE-SILENT");
  });

  it('drops the crash record too when the elected logger\'s level is "silent"', async () => {
    // Crash records go through the elected primary's `log()` at `error`, so a
    // level that matches nothing loses them exactly like any other entry.
    const exitFn = jest.fn();
    __crashCaptureInternals.setExitFn(exitFn);
    try {
      const root = createTempDir();
      const logger = createLogger({
        moduleName: "rl-crash-silent",
        logDirectory: root,
        includeConsole: false,
        includeGlobalFile: false,
        exitOnUncaught: false,
      });

      logger.error("RL-CRASH-SILENT-BEFORE");
      logger.level = "silent";
      __crashCaptureInternals.invokeUncaught(new Error("RL-CRASH-SILENT-MARKER"));
      await shutdownLogger(logger);

      const moduleFile = readLogFiles(root, "rl-crash-silent");
      expect(moduleFile).toContain("RL-CRASH-SILENT-BEFORE");
      expect(moduleFile).not.toContain("RL-CRASH-SILENT-MARKER");
      expect(exitFn).not.toHaveBeenCalled();
    } finally {
      __crashCaptureInternals.restoreExitFn();
    }
  });

  it.each([
    ["an empty string", ""],
    ["undefined", undefined],
    ["null", null],
  ])(
    "writes EVERY level to every built-in transport when `logger.level` is %s (no level at all)",
    async (_label, value) => {
      // The opposite of "silent": `winston-transport` treats a falsy level as
      // "no level" and accepts everything, while winston's `isLevelEnabled`
      // finds no numeric value and reports false. Reachable from an unset
      // environment variable (`logger.level = process.env.LOG_LEVEL`).
      const root = createTempDir();
      const logger = createLogger({
        moduleName: "rl-empty",
        logDirectory: root,
        captureUncaught: false,
      });

      const consoleOut = captureConsole(() => {
        logger.silly("RL-EMPTY-BEFORE");
        logger.level = value as unknown as string;
        logger.silly("RL-EMPTY-SILLY");
      });
      expect(logger.isLevelEnabled("error")).toBe(false);
      expect(logger.isLevelEnabled("silly")).toBe(false);
      await shutdownLogger(logger);

      const moduleFile = readLogFiles(root, "rl-empty");
      const globalFile = readLogFiles(root, "all-logs");
      expect(consoleOut).toContain("RL-EMPTY-SILLY");
      expect(moduleFile).toContain("RL-EMPTY-SILLY");
      expect(globalFile).toContain("RL-EMPTY-SILLY");
      expect(consoleOut).not.toContain("RL-EMPTY-BEFORE");
      expect(moduleFile).not.toContain("RL-EMPTY-BEFORE");
      expect(globalFile).not.toContain("RL-EMPTY-BEFORE");
    },
  );
});

describe("pretty console message rendering", () => {
  afterEach(() => {
    resetLoggerRegistry();
    jest.restoreAllMocks();
  });

  const ANSI_PATTERN = /\x1b\[[0-9;]*m/g;
  const stripAnsi = (value: string): string => value.replace(ANSI_PATTERN, "");
  const FIXED_NOW = new Date(Date.UTC(2026, 0, 2, 3, 4, 5));
  const GREEN = "\x1b[32m";
  const YELLOW = "\x1b[33m";
  const RED = "\x1b[31m";
  const BLUE = "\x1b[34m";
  const CLOSE = "\x1b[39m";

  /**
   * Logs through a real pretty logger whose only outputs are the built-in
   * Console and a formatless `Stream` sink. The sink writes the logger-level
   * `info[MESSAGE]`, which is exactly the pretty file line, so the two strings
   * can be compared: the console line must be the file line without its
   * timestamp header (plus ANSI codes). Both transports append `os.EOL`; the
   * sink is given `eol: "\n"` and the console's platform EOL is normalized to
   * `"\n"`, so the byte pins hold on Windows as well.
   */
  const render = async (
    moduleName: string,
    emit: (logger: winston.Logger) => void,
    options: Partial<LoggerOptions> = {},
  ): Promise<{ consoleOut: string; fileOut: string }> => {
    const sink = new PassThrough();
    const chunks: string[] = [];
    sink.on("data", (chunk: Buffer | string) => chunks.push(String(chunk)));
    const logger = createLogger({
      moduleName,
      includeFile: false,
      includeGlobalFile: false,
      captureUncaught: false,
      clock: () => FIXED_NOW,
      ...options,
      // Last, so a test option can never replace the capture sink.
      additionalTransports: [new winston.transports.Stream({ stream: sink, eol: "\n" })],
    });
    const rawConsole = captureConsole(() => emit(logger));
    await shutdownLogger(logger);
    // Normalized only when present: a missing line ending is left for each
    // test's exact comparison to report, next to the real failure reason.
    const consoleOut = rawConsole.endsWith(os.EOL)
      ? `${rawConsole.slice(0, rawConsole.length - os.EOL.length)}\n`
      : rawConsole;
    return { consoleOut, fileOut: chunks.join("") };
  };

  /** The file line with its `UTC:` header removed, i.e. the console's visible text. */
  const withoutTimestamp = (fileOut: string): string => {
    expect(fileOut.startsWith("UTC: 2026-01-02 03:04:05\n")).toBe(true);
    return fileOut.slice("UTC: 2026-01-02 03:04:05\n".length);
  };

  const nestedObject = { a: 1, b: { c: { d: { e: 1 } } } };
  const nestedArray = [1, { x: [2, [3, [4]]] }];

  const payloads: [string, unknown, string][] = [
    ["an undefined message", undefined, "undefined"],
    ["a BigInt message", 123n, "123"],
    ["a deeply nested object message", nestedObject, JSON.stringify(nestedObject, null, 2)],
    ["a deeply nested array message", nestedArray, JSON.stringify(nestedArray, null, 2)],
  ];

  const colorizeModes: [string, LoggerOptions["colorize"], boolean, boolean][] = [
    ["default colorize", undefined, true, true],
    ["colorize { level: false, message: true }", { level: false, message: true }, false, true],
    ["colorize { level: true, message: false }", { level: true, message: false }, true, false],
    ["colorize false", false, false, false],
  ];

  describe.each(colorizeModes)("%s", (_title, colorize, levelColored, messageColored) => {
    it.each(payloads)(
      "renders %s with the same visible text as the file line",
      async (_name, payload, expectedMessage) => {
        const { consoleOut, fileOut } = await render(
          "pcm-parity",
          (logger) => {
            logger.info(payload);
          },
          { colorize },
        );

        const expectedVisible = `[INFO] (pcm-parity)\n${expectedMessage}\n\n`;
        expect(withoutTimestamp(fileOut)).toBe(expectedVisible);
        expect(stripAnsi(consoleOut)).toBe(expectedVisible);
        // Never the level name, a BigInt literal, or util.inspect's depth markers.
        expect(stripAnsi(consoleOut)).not.toMatch(/\ninfo\n/);
        expect(consoleOut).not.toContain("123n");
        expect(consoleOut).not.toContain("[Object]");
        expect(consoleOut).not.toContain("[Array]");

        const [levelLine, ...messageLines] = consoleOut.split("\n").slice(0, -2);
        expect(levelLine).toBe(
          levelColored ? `${GREEN}[INFO]${CLOSE} (pcm-parity)` : "[INFO] (pcm-parity)",
        );
        // Every physical line of the message block carries exactly one
        // open/close pair when the message is colored, and none otherwise.
        for (const line of messageLines) {
          if (messageColored) {
            expect(line.startsWith(GREEN)).toBe(true);
            expect(line.endsWith(CLOSE)).toBe(true);
            expect(line.split(GREEN).length - 1).toBe(1);
            expect(line.split(CLOSE).length - 1).toBe(1);
          } else {
            expect(line.includes("\x1b")).toBe(false);
          }
        }
      },
    );
  });

  describe("byte-identical console output for messages the change does not target", () => {
    const fixedError = (): Error => {
      const err = new Error("boom");
      err.stack = "Error: boom\n    at fixed (fixed.js:1:1)";
      return err;
    };

    it.each([
      [
        "a single-line string",
        (logger: winston.Logger) => logger.info("hello world"),
        `${GREEN}[INFO]${CLOSE} (pcm-bytes)\n${GREEN}hello world${CLOSE}\n\n`,
      ],
      [
        "a string with metadata (the metadata block stays uncolored)",
        (logger: winston.Logger) => logger.info("hello", { k: 1 }),
        `${GREEN}[INFO]${CLOSE} (pcm-bytes)\n${GREEN}hello${CLOSE}\n{\n  "k": 1\n}\n\n`,
      ],
      [
        "an Error (message colored, stack uncolored)",
        (logger: winston.Logger) => logger.error(fixedError()),
        `${RED}[ERROR]${CLOSE} (pcm-bytes)\n${RED}boom${CLOSE}\nError: boom\n    at fixed (fixed.js:1:1)\n\n`,
      ],
      [
        "an empty string (never wrapped)",
        (logger: winston.Logger) => logger.info(""),
        `${GREEN}[INFO]${CLOSE} (pcm-bytes)\n\n\n`,
      ],
      [
        "a null message",
        (logger: winston.Logger) => logger.info(null as unknown as string),
        `${GREEN}[INFO]${CLOSE} (pcm-bytes)\n${GREEN}null${CLOSE}\n\n`,
      ],
      [
        "a debug-level string (a non-default color)",
        (logger: winston.Logger) => {
          logger.level = "debug";
          logger.debug("dbg");
        },
        `${BLUE}[DEBUG]${CLOSE} (pcm-bytes)\n${BLUE}dbg${CLOSE}\n\n`,
      ],
      [
        "a string carrying a raw carriage return",
        (logger: winston.Logger) => logger.info("a\rb"),
        `${GREEN}[INFO]${CLOSE} (pcm-bytes)\n${GREEN}a\rb${CLOSE}\n\n`,
      ],
      [
        "a multi-line string (codes closed and reopened around each newline)",
        (logger: winston.Logger) => logger.warn("line1\nline2"),
        `${YELLOW}[WARN]${CLOSE} (pcm-bytes)\n${YELLOW}line1${CLOSE}\n${YELLOW}line2${CLOSE}\n\n`,
      ],
    ])("renders %s exactly as before", async (_name, emit, expected) => {
      const { consoleOut, fileOut } = await render("pcm-bytes", emit);

      expect(consoleOut).toBe(expected);
      // The console shows exactly what the file shows, minus the timestamp.
      expect(stripAnsi(consoleOut)).toBe(withoutTimestamp(fileOut));
    });

    it.each([
      [
        "colorize { level: true, message: false }",
        { level: true, message: false },
        `${GREEN}[INFO]${CLOSE} (pcm-flags)\nhi\n\n`,
      ],
      [
        "colorize { level: false, message: true }",
        { level: false, message: true },
        `[INFO] (pcm-flags)\n${GREEN}hi${CLOSE}\n\n`,
      ],
      ["colorize false", false, "[INFO] (pcm-flags)\nhi\n\n"],
    ] as [string, LoggerOptions["colorize"], string][])(
      "honors %s for a single-line string",
      async (_name, colorize, expected) => {
        const { consoleOut } = await render("pcm-flags", (logger) => logger.info("hi"), {
          colorize,
        });

        expect(consoleOut).toBe(expected);
      },
    );
  });

  it("keeps a message that carries its own color-close code colored to the end", async () => {
    const { consoleOut, fileOut } = await render("pcm-close-code", (logger) =>
      logger.info(`x${CLOSE}y`),
    );

    // @colors/colors reopens the level color at an embedded close code, so the
    // tail of the message is never left uncolored (unchanged behavior).
    expect(consoleOut).toBe(
      `${GREEN}[INFO]${CLOSE} (pcm-close-code)\n${GREEN}x${GREEN}y${CLOSE}\n\n`,
    );
    // The file keeps the caller's bytes verbatim; only the console recolors.
    expect(withoutTimestamp(fileOut)).toBe(`[INFO] (pcm-close-code)\nx${CLOSE}y\n\n`);
  });

  describe("a message neither JSON nor String() can express", () => {
    const nullPrototypeUndefinedJson = (): unknown =>
      Object.assign(Object.create(null) as object, { toJSON: () => undefined });
    const functionWithThrowingToString = (): unknown => {
      const fn = (): number => 1;
      Object.defineProperty(fn, "toString", {
        value: () => {
          throw new Error("toString refused");
        },
      });
      return fn;
    };

    it.each([
      ["a null-prototype object whose toJSON returns undefined", nullPrototypeUndefinedJson],
      ["a function whose toString throws", functionWithThrowingToString],
    ])("renders %s as the sentinel instead of throwing", async (_name, build) => {
      let thrown: unknown;
      const { consoleOut, fileOut } = await render("pcm-inexpressible", (logger) => {
        try {
          logger.info(build());
        } catch (err) {
          thrown = err;
        }
      });

      expect(thrown).toBeUndefined();
      expect(withoutTimestamp(fileOut)).toBe("[INFO] (pcm-inexpressible)\n[UNSERIALIZABLE]\n\n");
      expect(consoleOut).toBe(
        `${GREEN}[INFO]${CLOSE} (pcm-inexpressible)\n${GREEN}[UNSERIALIZABLE]${CLOSE}\n\n`,
      );
    });
  });

  it("wraps an escaped multi-line message in exactly one color pair, like any single line", async () => {
    const { consoleOut, fileOut } = await render(
      "pcm-escaped",
      (logger) => logger.warn("line1\nline2"),
      { escapeMessageNewlines: true },
    );

    // The escaped message is one physical line, so it is colored as one unit.
    expect(consoleOut).toBe(
      `${YELLOW}[WARN]${CLOSE} (pcm-escaped)\n${YELLOW}line1\\nline2${CLOSE}\n\n`,
    );
    expect(stripAnsi(consoleOut)).toBe(withoutTimestamp(fileOut));
    // No raw newline survives inside the message: the escape still holds.
    expect(consoleOut.split("\n")).toHaveLength(4);
  });

  it.each(colorizeModes)(
    "renders an entry whose level has no configured color as plain text under %s instead of throwing",
    async (_title, colorize) => {
      const errorSpy = jest.spyOn(console, "error").mockImplementation(() => undefined);
      let thrown: unknown;
      const { consoleOut, fileOut } = await render(
        "pcm-unknown-level",
        (logger) => {
          // An empty logger level lets every inheriting transport accept any
          // entry, so an entry with an unknown level reaches the console format.
          logger.level = "";
          try {
            logger.log({ level: "bogus", message: "no color for this level" });
          } catch (err) {
            thrown = err;
          }
        },
        { colorize },
      );

      expect(thrown).toBeUndefined();
      expect(consoleOut).toBe("[BOGUS] (pcm-unknown-level)\nno color for this level\n\n");
      expect(withoutTimestamp(fileOut)).toBe(
        "[BOGUS] (pcm-unknown-level)\nno color for this level\n\n",
      );
      // winston itself reports the unknown level; nothing else is written to stderr.
      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(errorSpy).toHaveBeenCalledWith("[winston] Unknown logger level: %s", "bogus");
    },
  );
});

/**
 * Shared harness for the maskMetaKeys message/stack suites below: a real logger
 * with the built-in Console and a formatless Stream sink, a fixed clock, and
 * helpers for the exact line each chain writes.
 */
const FIXED_NOW = new Date(Date.UTC(2026, 0, 2, 3, 4, 5));
const STAMP = "2026-01-02 03:04:05";
const stripAnsi = (value: string): string => value.replace(/\x1b\[[0-9;]*m/g, "");

type Format = "pretty" | "json";

interface Rendered {
  fileOut: string;
  consoleOut: string;
  thrown: unknown;
}

/**
 * Logs once through a real logger whose outputs are the built-in Console
 * (default colorize) and a formatless `Stream` sink. The sink writes the
 * logger-level `info[MESSAGE]`, i.e. exactly the file line, so both the
 * file rendering and the console rendering of every chain are observed. A
 * throw out of the log call is captured rather than propagated, so a test
 * can assert that none happened.
 */
const render = async (
  moduleName: string,
  format: Format,
  emit: (logger: winston.Logger) => void,
  maskMetaKeys?: string[],
): Promise<Rendered> => {
  const sink = new PassThrough();
  const chunks: string[] = [];
  sink.on("data", (chunk: Buffer | string) => chunks.push(String(chunk)));
  const logger = createLogger({
    moduleName,
    format,
    includeFile: false,
    includeGlobalFile: false,
    captureUncaught: false,
    clock: () => FIXED_NOW,
    ...(maskMetaKeys ? { maskMetaKeys } : {}),
    additionalTransports: [new winston.transports.Stream({ stream: sink, eol: "\n" })],
  });
  let thrown: unknown;
  const rawConsole = captureConsole(() => {
    try {
      emit(logger);
    } catch (err) {
      thrown = err;
    }
  });
  await shutdownLogger(logger);
  const consoleOut = rawConsole.endsWith(os.EOL)
    ? `${rawConsole.slice(0, rawConsole.length - os.EOL.length)}\n`
    : rawConsole;
  return { fileOut: chunks.join(""), consoleOut, thrown };
};

/** The exact line each chain writes for a message whose serialized form is given. */
const prettyLine = (label: string, body: string): string =>
  `UTC: ${STAMP}\n[INFO] (${label})\n${body}\n\n`;
const jsonLine = (label: string, body: string): string =>
  `{"level":"info","message":${body},"module":"${label}","timestamp":"${STAMP}"}\n`;

/** The console shows the pretty file line without its `UTC:` header; json is identical. */
const expectConsoleMatchesFile = (format: Format, out: Rendered): void => {
  if (format === "json") {
    expect(out.consoleOut).toBe(out.fileOut);
  } else {
    expect(out.fileOut.startsWith(`UTC: ${STAMP}\n`)).toBe(true);
    expect(stripAnsi(out.consoleOut)).toBe(out.fileOut.slice(`UTC: ${STAMP}\n`.length));
  }
};

describe("maskMetaKeys covers object-valued messages", () => {
  afterEach(() => {
    resetLoggerRegistry();
    jest.restoreAllMocks();
  });

  /** Own string-keyed properties only (drops winston's `Symbol(level)` slot). */
  const stringKeyed = (value: object): Record<string, unknown> =>
    Object.fromEntries(Object.keys(value).map((key) => [key, (value as never)[key]]));

  class Account {
    public user = "bob";
    readonly #password: string;
    constructor(password: string) {
      this.#password = password;
    }
    toJSON(): Record<string, unknown> {
      return { user: this.user, password: this.#password };
    }
  }

  interface MaskCase {
    title: string;
    make: () => object;
    secret: string;
    keeps: string[];
    /** True when winston hands the caller's own object to the chain (truthy `message`). */
    callerIsInfo: boolean;
    pretty: string;
    json: string;
  }

  const cases: MaskCase[] = [
    {
      title: "logger.info({ user, password }) (a single object without a message key)",
      make: () => ({ user: "bob", password: "secret-S1" }),
      secret: "secret-S1",
      keeps: ['"user": "bob"', '"user":"bob"'],
      callerIsInfo: false,
      pretty: '{\n  "user": "bob",\n  "password": "secret-S1"\n}',
      json: '{"password":"secret-S1","user":"bob"}',
    },
    {
      title: "logger.info({ message: { password } }) (an object-valued message)",
      make: () => ({ message: { password: "secret-S2" } }),
      secret: "secret-S2",
      keeps: [],
      callerIsInfo: true,
      pretty: '{\n  "password": "secret-S2"\n}',
      json: '{"password":"secret-S2"}',
    },
    {
      title: "logger.info([{ password }]) (an array message)",
      make: () => [{ password: "secret-S3" }],
      secret: "secret-S3",
      keeps: [],
      callerIsInfo: false,
      pretty: '[\n  {\n    "password": "secret-S3"\n  }\n]',
      json: '[{"password":"secret-S3"}]',
    },
    {
      title: 'logger.info({ message: "", password }) (a falsy message wraps the whole object)',
      make: () => ({ message: "", password: "secret-S4" }),
      secret: "secret-S4",
      keeps: ['"message": ""', '"message":""'],
      callerIsInfo: false,
      pretty: '{\n  "message": "",\n  "password": "secret-S4"\n}',
      json: '{"message":"","password":"secret-S4"}',
    },
    {
      title: "a class instance without a message whose toJSON exposes password",
      make: () => new Account("secret-S5"),
      secret: "secret-S5",
      keeps: ['"user": "bob"', '"user":"bob"'],
      callerIsInfo: false,
      pretty: '{\n  "user": "bob",\n  "password": "secret-S5"\n}',
      json: '{"password":"secret-S5","user":"bob"}',
    },
    {
      title: "a nested secret ({ profile: { name, password } })",
      make: () => ({ profile: { name: "bob", password: "secret-S6" } }),
      secret: "secret-S6",
      keeps: ['"name": "bob"', '"name":"bob"'],
      callerIsInfo: false,
      pretty: '{\n  "profile": {\n    "name": "bob",\n    "password": "secret-S6"\n  }\n}',
      json: '{"profile":{"name":"bob","password":"secret-S6"}}',
    },
    {
      title: "a mixed-case key (Password)",
      make: () => ({ user: "bob", Password: "secret-S7" }),
      secret: "secret-S7",
      keeps: ['"user": "bob"', '"user":"bob"'],
      callerIsInfo: false,
      pretty: '{\n  "user": "bob",\n  "Password": "secret-S7"\n}',
      json: '{"Password":"secret-S7","user":"bob"}',
    },
  ];

  const formats: Format[] = ["pretty", "json"];

  describe.each(formats)("format %s", (format) => {
    const expectedLine = (label: string, body: string): string =>
      format === "json" ? jsonLine(label, body) : prettyLine(label, body);
    const bodyOf = (testCase: MaskCase): string =>
      format === "json" ? testCase.json : testCase.pretty;

    it.each(cases)(
      "without maskMetaKeys, $title renders exactly as before (pinned bytes)",
      async (testCase) => {
        const label = `mom-off-${format}`;
        const out = await render(label, format, (logger) => {
          logger.info(testCase.make());
        });

        expect(out.thrown).toBeUndefined();
        expect(out.fileOut).toBe(expectedLine(label, bodyOf(testCase)));
        expectConsoleMatchesFile(format, out);
        expect(out.fileOut).toContain(testCase.secret);
        expect(out.fileOut).not.toContain("[REDACTED]");
      },
    );

    it.each(cases)(
      "with maskMetaKeys, $title redacts the secret in the file and on the console and changes nothing else",
      async (testCase) => {
        const label = `mom-on-${format}`;
        const payload = testCase.make();
        const snapshot = structuredClone(payload);
        const out = await render(
          label,
          format,
          (logger) => {
            logger.info(payload);
          },
          ["password"],
        );

        expect(out.thrown).toBeUndefined();
        // The masked line is the unmasked line with ONLY the secret's JSON
        // string swapped for the placeholder: same keys, same order, same
        // non-secret values.
        const unmaskedBody = bodyOf(testCase);
        const maskedBody = unmaskedBody.replace(`"${testCase.secret}"`, '"[REDACTED]"');
        expect(maskedBody).not.toBe(unmaskedBody);
        expect(out.fileOut).toBe(expectedLine(label, maskedBody));
        expectConsoleMatchesFile(format, out);
        for (const output of [out.fileOut, out.consoleOut]) {
          expect(output).not.toContain(testCase.secret);
          expect(output).toContain("[REDACTED]");
          expect(testCase.keeps.some((fragment) => output.includes(fragment))).toBe(
            testCase.keeps.length > 0,
          );
        }

        // The caller's object is never rewritten. The only write on it is
        // winston-core's own `level` slot, and only when winston hands the
        // caller's object itself to the chain (a truthy `message`).
        if (testCase.callerIsInfo) {
          expect(stringKeyed(payload)).toEqual({ ...snapshot, level: "info" });
          expect(Object.getOwnPropertySymbols(payload)).toEqual([Symbol.for("level")]);
        } else {
          expect(payload).toEqual(snapshot);
          expect(Object.keys(payload)).toEqual(Object.keys(snapshot));
        }
        if (payload instanceof Account) {
          expect(payload.toJSON()).toEqual({ user: "bob", password: "secret-S5" });
        }
      },
    );

    it("a message object whose getter throws renders the redaction sentinel instead of throwing or leaking", async () => {
      const label = `mom-throw-${format}`;
      const payload = {
        password: "secret-S8",
        get profile(): string {
          throw new Error("profile getter failed");
        },
      };
      const out = await render(
        label,
        format,
        (logger) => {
          logger.info(payload);
        },
        ["password"],
      );

      expect(out.thrown).toBeUndefined();
      expect(out.fileOut).toBe(expectedLine(label, '"[RedactionFailed]"'));
      expectConsoleMatchesFile(format, out);
      for (const output of [out.fileOut, out.consoleOut]) {
        expect(output).not.toContain("secret-S8");
        expect(output).not.toContain("profile getter failed");
        expect(output).not.toContain("[UNSERIALIZABLE]");
        expect(output).not.toContain("_unserializable");
      }
    });

    it("with maskMetaKeys, an object message with nothing to mask renders byte-identically to no mask", async () => {
      const payload = { user: "bob", tags: ["a", "b"], nested: { n: 1, ok: true } };
      const masked = await render(
        `mom-same-${format}`,
        format,
        (logger) => {
          logger.info(payload);
        },
        ["password"],
      );
      const plain = await render(`mom-same-${format}`, format, (logger) => {
        logger.info(payload);
      });

      expect(masked.thrown).toBeUndefined();
      expect(masked.fileOut).toBe(plain.fileOut);
      expect(masked.consoleOut).toBe(plain.consoleOut);
      expect(masked.fileOut).not.toContain("[REDACTED]");
      expect(payload).toEqual({ user: "bob", tags: ["a", "b"], nested: { n: 1, ok: true } });
    });

    it("with maskMetaKeys, a string message that mentions a masked key is left untouched", async () => {
      const label = `mom-string-${format}`;
      const out = await render(
        label,
        format,
        (logger) => {
          logger.info("reset password for bob");
        },
        ["password"],
      );

      expect(out.fileOut).toBe(
        format === "json"
          ? jsonLine(label, '"reset password for bob"')
          : prettyLine(label, "reset password for bob"),
      );
      expectConsoleMatchesFile(format, out);
      expect(out.fileOut).not.toContain("[REDACTED]");
    });
  });

  it("json mode: a top-level toJSON whose output carries an object message is redacted", async () => {
    // `buildMetaRedactor` resolves a top-level `toJSON` and rebuilds from its
    // output, copying the reserved `message` key across; the object behind it
    // must be walked like any other message object.
    const payload = {
      message: "wrapped",
      toJSON: () => ({ message: { user: "bob", password: "secret-S10" } }),
    };
    const plain = await render("mom-tojson", "json", (logger) => {
      logger.info(payload);
    });
    const masked = await render(
      "mom-tojson",
      "json",
      (logger) => {
        logger.info(payload);
      },
      ["password"],
    );

    expect(plain.fileOut).toBe('{"message":{"password":"secret-S10","user":"bob"}}\n');
    expect(masked.thrown).toBeUndefined();
    expect(masked.fileOut).toBe('{"message":{"password":"[REDACTED]","user":"bob"}}\n');
    expect(masked.consoleOut).toBe(masked.fileOut);
    // The payload IS the info here (truthy `message`): only winston's `level`
    // lands on it, and its own `message` is still the original string.
    expect(Object.keys(payload)).toEqual(["message", "toJSON", "level"]);
    expect(payload.message).toBe("wrapped");
  });
});

describe("redactMessagePayload (shared reserved-slot redaction helper)", () => {
  const { redactMessagePayload, REDACTION_FAILED } = __loggerInternals;
  const mask: ReadonlySet<string> = new Set(["password"]);

  it("returns primitives, null, and functions unchanged, since a mask has no key to address", () => {
    const fn = (): string => "password";
    for (const value of ["password=hunter2", 42, 7n, true, undefined, null, fn]) {
      expect(redactMessagePayload(value, mask, "message")).toBe(value);
    }
  });

  it("returns a fresh redacted copy of a plain object and leaves the input untouched", () => {
    const input = { user: "bob", PassWord: "pw-1", nested: { password: "pw-2", keep: [1, 2] } };
    const out = redactMessagePayload(input, mask, "message");

    expect(out).toEqual({
      user: "bob",
      PassWord: "[REDACTED]",
      nested: { password: "[REDACTED]", keep: [1, 2] },
    });
    expect(out).not.toBe(input);
    expect(input).toEqual({
      user: "bob",
      PassWord: "pw-1",
      nested: { password: "pw-2", keep: [1, 2] },
    });
  });

  it("walks an array message element by element", () => {
    const input = [{ password: "pw" }, "plain", 3];
    const out = redactMessagePayload(input, mask, "");

    expect(out).toEqual([{ password: "[REDACTED]" }, "plain", 3]);
    expect(input[0]).toEqual({ password: "pw" });
  });

  it("returns a class instance with nothing to mask by identity, so the serializer renders it as before", () => {
    class Point {
      constructor(
        public x: number,
        public y: number,
      ) {}
    }
    const point = new Point(1, 2);
    expect(redactMessagePayload(point, mask, "message")).toBe(point);
  });

  it("resolves toJSON on the real instance with the serializer's key, then redacts its output", () => {
    const seenKeys: string[] = [];
    class Vault {
      readonly #password = "pw-private";
      toJSON(key: string): Record<string, unknown> {
        seenKeys.push(key);
        return { owner: "bob", password: this.#password };
      }
    }
    const vault = new Vault();

    expect(redactMessagePayload(vault, mask, "message")).toEqual({
      owner: "bob",
      password: "[REDACTED]",
    });
    expect(redactMessagePayload(vault, mask, "")).toEqual({
      owner: "bob",
      password: "[REDACTED]",
    });
    // Called once per resolution, with exactly the key the serializer would pass.
    expect(seenKeys).toEqual(["message", ""]);
  });

  it("returns the original value when toJSON yields a primitive, so the serializer resolves it as before", () => {
    const primitive = { toJSON: (): string => "as-text" };
    expect(redactMessagePayload(primitive, mask, "")).toBe(primitive);
  });

  it("rebuilds a toJSON result by its own keys, the way the serializer reads it", () => {
    // Serializers call toJSON once and serialize the result by its own
    // enumerable keys: a Date result renders "{}", a result's own toJSON is
    // never called, and a result that is the instance itself is read field by
    // field.
    const date = { toJSON: (): Date => new Date(0) };
    const nested = { toJSON: () => ({ user: "bob", toJSON: () => ({ password: "pw-n" }) }) };
    class Self {
      public user = "bob";
      public password = "pw-s";
      toJSON(): this {
        return this;
      }
    }

    const dateOut = redactMessagePayload(date, mask, "");
    expect(dateOut).toEqual({});
    expect(JSON.stringify(dateOut)).toBe(JSON.stringify(date));

    const nestedOut = redactMessagePayload(nested, mask, "");
    expect(nestedOut).toEqual({ user: "bob" });
    expect(JSON.stringify(nestedOut)).toBe(JSON.stringify(nested));

    const self = new Self();
    expect(redactMessagePayload(self, mask, "")).toEqual({ user: "bob", password: "[REDACTED]" });
    expect(self.password).toBe("pw-s");
  });

  it("keeps an array toJSON result an array and drops forbidden keys from an object result", () => {
    const arr = { toJSON: () => [{ password: "pw-a" }, 1] };
    const proto = {
      toJSON: () => JSON.parse('{"user":"bob","__proto__":{"password":"pw-p"}}') as object,
    };

    expect(redactMessagePayload(arr, mask, "")).toEqual([{ password: "[REDACTED]" }, 1]);
    // The key-by-key rebuild (a result that defines its own toJSON) drops the
    // same forbidden keys and the result's toJSON.
    const withOwnToJSON = JSON.parse('{"user":"bob","__proto__":{"password":"pw-q"}}') as Record<
      string,
      unknown
    >;
    withOwnToJSON.toJSON = (): string => "never called";
    const rebuiltOut = redactMessagePayload({ toJSON: () => withOwnToJSON }, mask, "") as Record<
      string,
      unknown
    >;
    expect(rebuiltOut).toEqual({ user: "bob" });
    expect(Object.keys(rebuiltOut)).toEqual(["user"]);
    expect(Object.getPrototypeOf(rebuiltOut)).toBe(Object.prototype);
    const protoOut = redactMessagePayload(proto, mask, "") as Record<string, unknown>;
    expect(protoOut).toEqual({ user: "bob" });
    expect(Object.keys(protoOut)).toEqual(["user"]);
    expect(Object.getPrototypeOf(protoOut)).toBe(Object.prototype);
  });

  it.each([
    [
      "a throwing toJSON",
      {
        password: "pw-a",
        toJSON: (): never => {
          throw new Error("toJSON failed");
        },
      },
    ],
    [
      "a throwing toJSON getter",
      Object.defineProperty({ password: "pw-b" }, "toJSON", {
        get(): never {
          throw new Error("toJSON getter failed");
        },
      }),
    ],
    [
      "a throwing nested getter",
      {
        password: "pw-c",
        get detail(): string {
          throw new Error("detail getter failed");
        },
      },
    ],
  ])("fails closed to the redaction sentinel on %s, never the raw value", (_name, value) => {
    let out: unknown;
    expect(() => {
      out = redactMessagePayload(value, mask, "message");
    }).not.toThrow();
    expect(out).toBe(REDACTION_FAILED);
    expect(REDACTION_FAILED).toBe("[RedactionFailed]");
    expect(JSON.stringify(out)).not.toMatch(/pw-/);
  });
});

describe("maskMetaKeys covers the fail-closed message copy and non-string stacks", () => {
  afterEach(() => {
    resetLoggerRegistry();
    jest.restoreAllMocks();
  });

  describe("a top-level toJSON that throws (the fail-closed rebuild)", () => {
    const makePayload = (): Record<string, unknown> => ({
      message: { user: "bob", password: "secret-S11" },
      toJSON: (): never => {
        throw new Error("toJSON failed");
      },
    });

    it("json: the fail-closed line still redacts an object message instead of copying it raw", async () => {
      const payload = makePayload();
      const out = await render(
        "mom-fail-json",
        "json",
        (logger) => {
          logger.info(payload);
        },
        ["password"],
      );

      expect(out.thrown).toBeUndefined();
      expect(out.fileOut).toBe(
        '{"_redactionFailed":true,"level":"info","message":{"password":"[REDACTED]","user":"bob"}}\n',
      );
      expect(out.consoleOut).toBe(out.fileOut);
      expect(out.fileOut).not.toContain("secret-S11");
      expect(out.fileOut).not.toContain("toJSON failed");
      // The caller's message object still holds the real secret.
      expect(payload.message).toEqual({ user: "bob", password: "secret-S11" });
    });

    it("json: a message whose own redaction also fails renders the sentinel, never the raw object", async () => {
      const payload = {
        message: {
          password: "secret-S14",
          get detail(): string {
            throw new Error("detail getter failed");
          },
        },
        toJSON: (): never => {
          throw new Error("toJSON failed");
        },
      };
      const out = await render(
        "mom-fail-json2",
        "json",
        (logger) => {
          logger.info(payload);
        },
        ["password"],
      );

      expect(out.thrown).toBeUndefined();
      expect(out.fileOut).toBe(
        '{"_redactionFailed":true,"level":"info","message":"[RedactionFailed]"}\n',
      );
      expect(out.fileOut).not.toContain("secret-S14");
    });

    it("json: a string message on the fail-closed line is copied unchanged", async () => {
      const out = await render(
        "mom-fail-json3",
        "json",
        (logger) => {
          logger.info({
            message: "plain text",
            password: "secret-S15",
            toJSON: (): never => {
              throw new Error("toJSON failed");
            },
          });
        },
        ["password"],
      );

      expect(out.fileOut).toBe('{"_redactionFailed":true,"level":"info","message":"plain text"}\n');
      expect(out.fileOut).not.toContain("secret-S15");
    });

    it("pretty: the same payload renders the redacted message (the metadata block, holding only toJSON, is unserializable)", async () => {
      const out = await render(
        "mom-fail-pretty",
        "pretty",
        (logger) => {
          logger.info(makePayload());
        },
        ["password"],
      );

      expect(out.thrown).toBeUndefined();
      expect(out.fileOut).toBe(
        `UTC: ${STAMP}\n[INFO] (mom-fail-pretty)\n{\n  "user": "bob",\n  "password": "[REDACTED]"\n}\n[UNSERIALIZABLE]\n\n`,
      );
      expectConsoleMatchesFile("pretty", out);
      expect(out.fileOut).not.toContain("secret-S11");
    });
  });

  const formats: Format[] = ["pretty", "json"];

  describe.each(formats)("non-string stack, format %s", (format) => {
    const line = (label: string, stackBody: string, level = "info", message = "m"): string =>
      format === "json"
        ? `{"level":"${level}","message":"${message}","module":"${label}","stack":${stackBody},"timestamp":"${STAMP}"}\n`
        : `UTC: ${STAMP}\n[${level.toUpperCase()}] (${label})\n${message}\n${stackBody}\n\n`;
    const body = (pretty: string, json: string): string => (format === "json" ? json : pretty);

    const stackForms: [string, (logger: winston.Logger, stack: unknown) => void][] = [
      ["logger.info({ message, stack })", (logger, stack) => logger.info({ message: "m", stack })],
      [
        'logger.log("info", { message, stack })',
        (logger, stack) => logger.log("info", { message: "m", stack }),
      ],
      ['logger.info("m", { stack })', (logger, stack) => logger.info("m", { stack })],
    ];

    it.each(stackForms)(
      "without maskMetaKeys, an object stack via %s renders exactly as before (pinned bytes)",
      async (_form, emit) => {
        const label = `mom-stack-off-${format}`;
        const out = await render(label, format, (logger) =>
          emit(logger, { password: "secret-S12", frame: "f1" }),
        );

        expect(out.fileOut).toBe(
          line(
            label,
            body(
              '{\n  "password": "secret-S12",\n  "frame": "f1"\n}',
              '{"frame":"f1","password":"secret-S12"}',
            ),
          ),
        );
        expectConsoleMatchesFile(format, out);
      },
    );

    it.each(stackForms)(
      "with maskMetaKeys, an object stack via %s is redacted and the caller's stack is untouched",
      async (_form, emit) => {
        const label = `mom-stack-on-${format}`;
        const stack = { password: "secret-S12", frame: "f1" };
        const out = await render(label, format, (logger) => emit(logger, stack), ["password"]);

        expect(out.thrown).toBeUndefined();
        expect(out.fileOut).toBe(
          line(
            label,
            body(
              '{\n  "password": "[REDACTED]",\n  "frame": "f1"\n}',
              '{"frame":"f1","password":"[REDACTED]"}',
            ),
          ),
        );
        expectConsoleMatchesFile(format, out);
        expect(out.consoleOut).not.toContain("secret-S12");
        expect(stack).toEqual({ password: "secret-S12", frame: "f1" });
      },
    );

    it("with maskMetaKeys, an array stack is walked too", async () => {
      const label = `mom-stack-arr-${format}`;
      const out = await render(
        label,
        format,
        (logger) => logger.info({ message: "m", stack: [{ password: "secret-S13" }, "frame"] }),
        ["password"],
      );

      expect(out.fileOut).toBe(
        line(
          label,
          body(
            '[\n  {\n    "password": "[REDACTED]"\n  },\n  "frame"\n]',
            '[{"password":"[REDACTED]"},"frame"]',
          ),
        ),
      );
      expect(out.consoleOut).not.toContain("secret-S13");
    });

    it("with maskMetaKeys, a stack object whose getter throws renders the redaction sentinel", async () => {
      const label = `mom-stack-throw-${format}`;
      const out = await render(
        label,
        format,
        (logger) =>
          logger.info({
            message: "m",
            stack: {
              password: "secret-S16",
              get frame(): string {
                throw new Error("frame getter failed");
              },
            },
          }),
        ["password"],
      );

      expect(out.thrown).toBeUndefined();
      expect(out.fileOut).toBe(line(label, '"[RedactionFailed]"'));
      expectConsoleMatchesFile(format, out);
      expect(out.fileOut).not.toContain("secret-S16");
    });

    it("with maskMetaKeys, a real Error's string stack renders byte-identically to no mask", async () => {
      const makeError = (): Error => {
        const err = new Error("boom");
        err.stack = "Error: boom\n    at fixedFrame (fixed.ts:1:1)";
        return err;
      };
      const label = `mom-stack-str-${format}`;
      const masked = await render(label, format, (logger) => logger.error(makeError()), [
        "password",
      ]);
      const plain = await render(label, format, (logger) => logger.error(makeError()));

      expect(masked.fileOut).toBe(
        line(
          label,
          body(
            "Error: boom\n    at fixedFrame (fixed.ts:1:1)",
            '"Error: boom\\n    at fixedFrame (fixed.ts:1:1)"',
          ),
          "error",
          "boom",
        ),
      );
      expect(masked.fileOut).toBe(plain.fileOut);
      expect(masked.consoleOut).toBe(plain.consoleOut);
    });
  });
});

describe("maskMetaKeys object-message boundaries", () => {
  afterEach(() => {
    resetLoggerRegistry();
    jest.restoreAllMocks();
  });

  const formats: Format[] = ["pretty", "json"];

  describe.each(formats)("format %s", (format) => {
    const pick = (pretty: string, json: string): string => (format === "json" ? json : pretty);

    it("a class-instance payload with an object message is redacted, and the instance's message is left alone", async () => {
      class AuditEvent {
        public message = { user: "bob", password: "secret-S20" };
        public kind = "login";
      }
      const event = new AuditEvent();
      const originalMessage = event.message;
      const label = `mom-class-${format}`;
      const out = await render(label, format, (logger) => logger.info(event), ["password"]);

      expect(out.thrown).toBeUndefined();
      expect(out.fileOut).toBe(
        pick(
          `UTC: ${STAMP}\n[INFO] (${label})\n{\n  "user": "bob",\n  "password": "[REDACTED]"\n}\n{\n  "kind": "login"\n}\n\n`,
          `{"kind":"login","level":"info","message":{"password":"[REDACTED]","user":"bob"},"module":"${label}","timestamp":"${STAMP}"}\n`,
        ),
      );
      expectConsoleMatchesFile(format, out);
      expect(out.consoleOut).not.toContain("secret-S20");
      // Winston hands the instance itself to the chain. Its message object is
      // the same object, still holding the secret; the only writes on the
      // instance are winston's `level` and the documented in-place `timestamp`
      // for non-plain payloads.
      expect(event.message).toBe(originalMessage);
      expect(event.message).toEqual({ user: "bob", password: "secret-S20" });
      expect(Object.keys(event).sort()).toEqual(["kind", "level", "message", "timestamp"]);
    });

    it("the multi-argument form logger.info(object, meta) redacts the object message", async () => {
      const label = `mom-multi-${format}`;
      const out = await render(
        label,
        format,
        // Winston's typings only declare a string first argument here; the
        // runtime accepts an object and treats it as the message.
        (logger) =>
          (logger.info as unknown as (...args: unknown[]) => void)(
            { password: "secret-S21" },
            { requestId: "r1" },
          ),
        ["password"],
      );

      expect(out.fileOut).toBe(
        pick(
          `UTC: ${STAMP}\n[INFO] (${label})\n{\n  "password": "[REDACTED]"\n}\n{\n  "requestId": "r1"\n}\n\n`,
          `{"level":"info","message":{"password":"[REDACTED]"},"module":"${label}","requestId":"r1","timestamp":"${STAMP}"}\n`,
        ),
      );
      expect(out.consoleOut).not.toContain("secret-S21");
    });

    it("the unknown-method fallback redacts an object message too", async () => {
      const label = `mom-fallback-${format}`;
      const out = await render(
        label,
        format,
        (logger) =>
          (logger as unknown as Record<string, (arg: unknown) => void>).audit({
            password: "secret-S22",
          }),
        ["password"],
      );

      expect(out.thrown).toBeUndefined();
      // First line: the one-time fallback warning; second: the redacted entry.
      expect(out.fileOut).toContain(
        pick('Unknown logger method "audit" called', 'Unknown logger method \\"audit\\" called'),
      );
      expect(out.fileOut).toContain(
        pick('{\n  "password": "[REDACTED]"\n}', '"message":{"password":"[REDACTED]"}'),
      );
      expect(out.fileOut).not.toContain("secret-S22");
      expect(out.consoleOut).not.toContain("secret-S22");
    });

    it("a self-referencing object message renders [Circular] with a mask, and as before without one", async () => {
      const makeCyclic = (): Record<string, unknown> => {
        const message: Record<string, unknown> = { user: "bob" };
        message.self = message;
        return message;
      };
      const label = `mom-cycle-${format}`;
      const masked = await render(label, format, (logger) => logger.info(makeCyclic()), [
        "password",
      ]);
      const plain = await render(label, format, (logger) => logger.info(makeCyclic()));

      // Without a mask the serializers behave as before: pretty cannot express
      // the cycle; json's serializer marks it.
      expect(plain.fileOut).toBe(
        pick(
          `UTC: ${STAMP}\n[INFO] (${label})\n[UNSERIALIZABLE]\n\n`,
          `{"level":"info","message":{"self":"[Circular]","user":"bob"},"module":"${label}","timestamp":"${STAMP}"}\n`,
        ),
      );
      // With a mask the message is walked first, like the metadata bag, so the
      // back-reference is marked and the rest of the object still renders.
      expect(masked.thrown).toBeUndefined();
      expect(masked.fileOut).toBe(
        pick(
          `UTC: ${STAMP}\n[INFO] (${label})\n{\n  "user": "bob",\n  "self": "[Circular]"\n}\n\n`,
          plain.fileOut,
        ),
      );
    });

    it("an own __proto__ key in an object message is dropped with a mask (same guard as metadata)", async () => {
      const label = `mom-proto-${format}`;
      const out = await render(
        label,
        format,
        (logger) =>
          logger.info(JSON.parse('{"user":"bob","__proto__":{"password":"secret-S23"}}') as object),
        ["password"],
      );

      expect(out.fileOut).toBe(
        pick(
          `UTC: ${STAMP}\n[INFO] (${label})\n{\n  "user": "bob"\n}\n\n`,
          `{"level":"info","message":{"user":"bob"},"module":"${label}","timestamp":"${STAMP}"}\n`,
        ),
      );
      expect(out.consoleOut).not.toContain("secret-S23");
    });
  });
});

describe("maskMetaKeys and toJSON outputs (serializers resolve toJSON once)", () => {
  afterEach(() => {
    resetLoggerRegistry();
    jest.restoreAllMocks();
  });

  // Both `JSON.stringify` and winston's json serializer call `toJSON` once and
  // then serialize its result by its own enumerable keys; a `toJSON` on the
  // RESULT is never called. Masking must read the result the same way.
  class SelfDoc {
    public user = "bob";
    public password = "secret-S30";
    toJSON(): this {
      return this;
    }
  }

  const formats: Format[] = ["pretty", "json"];

  describe.each(formats)("format %s", (format) => {
    const pick = (pretty: string, json: string): string => (format === "json" ? json : pretty);

    it("masks a message whose toJSON returns the instance itself", async () => {
      const label = `mom-self-${format}`;
      const plain = await render(label, format, (logger) => logger.info(new SelfDoc()));
      const masked = await render(label, format, (logger) => logger.info(new SelfDoc()), [
        "password",
      ]);

      expect(plain.fileOut).toBe(
        pick(
          prettyLine(label, '{\n  "user": "bob",\n  "password": "secret-S30"\n}'),
          jsonLine(label, '{"password":"secret-S30","user":"bob"}'),
        ),
      );
      expect(masked.fileOut).toBe(plain.fileOut.replace('"secret-S30"', '"[REDACTED]"'));
      expectConsoleMatchesFile(format, masked);
      expect(masked.consoleOut).not.toContain("secret-S30");
    });

    it("never calls a toJSON found on a toJSON result (the serializer omits it)", async () => {
      const label = `mom-nested-tojson-${format}`;
      const payload = {
        toJSON: () => ({ user: "bob", toJSON: () => ({ password: "secret-S32" }) }),
      };
      const plain = await render(label, format, (logger) => logger.info(payload));
      const masked = await render(label, format, (logger) => logger.info(payload), ["password"]);

      expect(plain.fileOut).toBe(
        pick(prettyLine(label, '{\n  "user": "bob"\n}'), jsonLine(label, '{"user":"bob"}')),
      );
      expect(masked.fileOut).toBe(plain.fileOut);
      expect(masked.consoleOut).not.toContain("secret-S32");
    });

    it("passes toJSON the key the serializer passes (root in pretty, message in json)", async () => {
      const label = `mom-key-${format}`;
      const payload = {
        toJSON: (key: string) => ({ seenKey: key, password: "secret-S33" }),
      };
      const plain = await render(label, format, (logger) => logger.info(payload));
      const masked = await render(label, format, (logger) => logger.info(payload), ["password"]);

      expect(plain.fileOut).toBe(
        pick(
          prettyLine(label, '{\n  "seenKey": "",\n  "password": "secret-S33"\n}'),
          jsonLine(label, '{"password":"secret-S33","seenKey":"message"}'),
        ),
      );
      expect(masked.fileOut).toBe(plain.fileOut.replace('"secret-S33"', '"[REDACTED]"'));
    });

    it("leaves a BigInt message alone with a mask", async () => {
      const label = `mom-bigint-${format}`;
      const plain = await render(label, format, (logger) => logger.info(123n));
      const masked = await render(label, format, (logger) => logger.info(123n), ["password"]);

      expect(plain.fileOut).toBe(pick(prettyLine(label, "123"), jsonLine(label, '"123"')));
      expect(masked.fileOut).toBe(plain.fileOut);
    });
  });

  it("json: masks a top-level payload whose toJSON returns the instance itself", async () => {
    class SelfEvent {
      public message = "evt";
      public password = "secret-S31";
      toJSON(): this {
        return this;
      }
    }
    const plain = await render("mom-self-top", "json", (logger) => logger.info(new SelfEvent()));
    const masked = await render("mom-self-top", "json", (logger) => logger.info(new SelfEvent()), [
      "password",
    ]);

    expect(plain.fileOut).toBe(
      `{"level":"info","message":"evt","password":"secret-S31","timestamp":"${STAMP}"}\n`,
    );
    expect(masked.fileOut).toBe(plain.fileOut.replace('"secret-S31"', '"[REDACTED]"'));
    expect(masked.consoleOut).toBe(masked.fileOut);
  });

  it("json: a top-level toJSON result's own toJSON is not called with a mask either", async () => {
    const payload = {
      message: "m",
      toJSON: () => ({ message: "m", toJSON: () => ({ password: "secret-S34" }) }),
    };
    const plain = await render("mom-top-nested", "json", (logger) => logger.info(payload));
    const masked = await render("mom-top-nested", "json", (logger) => logger.info(payload), [
      "password",
    ]);

    expect(plain.fileOut).toBe('{"message":"m"}\n');
    expect(masked.fileOut).toBe(plain.fileOut);
  });
});

describe("maskMetaKeys keeps toJSON results without their own toJSON on the serializer's path", () => {
  afterEach(() => {
    resetLoggerRegistry();
    jest.restoreAllMocks();
  });

  const formats: Format[] = ["pretty", "json"];

  describe.each(formats)("format %s", (format) => {
    const pick = (pretty: string, json: string): string => (format === "json" ? json : pretty);

    it("a boxed-primitive toJSON result renders like the no-mask line", async () => {
      // JSON.stringify unwraps a boxed primitive; safe-stable-stringify (json
      // mode) reads it by its index keys. Either way the mask must not differ.
      const label = `mom-boxed-${format}`;
      const payload = { toJSON: (): unknown => new String("boxed") };
      const plain = await render(label, format, (logger) => logger.info(payload));
      const masked = await render(label, format, (logger) => logger.info(payload), ["password"]);

      expect(plain.fileOut).toBe(
        pick(
          prettyLine(label, '"boxed"'),
          jsonLine(label, '{"0":"b","1":"o","2":"x","3":"e","4":"d"}'),
        ),
      );
      expect(masked.fileOut).toBe(plain.fileOut);
    });

    it("a typed-array toJSON result renders like the no-mask line (index order kept)", async () => {
      const label = `mom-typed-${format}`;
      const payload = { toJSON: (): Uint8Array => Uint8Array.from({ length: 12 }, (_v, i) => i) };
      const plain = await render(label, format, (logger) => logger.info(payload));
      const masked = await render(label, format, (logger) => logger.info(payload), ["password"]);

      expect(masked.fileOut).toBe(plain.fileOut);
      if (format === "json") {
        expect(plain.fileOut).toContain('"message":{"0":0,"1":1,"2":2,');
      }
    });

    it("a Buffer toJSON result renders like the no-mask line (binary views are never rebuilt)", async () => {
      const label = `mom-buffer-${format}`;
      const payload = {
        toJSON: (): Buffer => Buffer.from(Array.from({ length: 12 }, (_v, i) => i)),
      };
      const plain = await render(label, format, (logger) => logger.info(payload));
      const masked = await render(label, format, (logger) => logger.info(payload), ["password"]);

      expect(masked.fileOut).toBe(plain.fileOut);
      expect(plain.fileOut).not.toContain('"type"');
    });

    it("a class-instance toJSON result without its own toJSON is masked, or kept as is when nothing matches", async () => {
      class Creds {
        public user = "bob";
        public password = "secret-S40";
      }
      class Plain {
        public user = "bob";
      }
      const label = `mom-inst-${format}`;
      const secret = { toJSON: (): Creds => new Creds() };
      const clean = { toJSON: (): Plain => new Plain() };
      const maskedSecret = await render(label, format, (logger) => logger.info(secret), [
        "password",
      ]);
      const plainClean = await render(label, format, (logger) => logger.info(clean));
      const maskedClean = await render(label, format, (logger) => logger.info(clean), ["password"]);

      expect(maskedSecret.fileOut).toBe(
        pick(
          prettyLine(label, '{\n  "user": "bob",\n  "password": "[REDACTED]"\n}'),
          jsonLine(label, '{"password":"[REDACTED]","user":"bob"}'),
        ),
      );
      expect(maskedClean.fileOut).toBe(plainClean.fileOut);
    });
  });

  describe("json: a top-level payload's toJSON result", () => {
    it("a boxed primitive renders like the no-mask line", async () => {
      class Boxed {
        public message = "m";
        toJSON(): unknown {
          return new String("boxed");
        }
      }
      const plain = await render("mom-top-boxed", "json", (logger) => logger.info(new Boxed()));
      const masked = await render("mom-top-boxed", "json", (logger) => logger.info(new Boxed()), [
        "password",
      ]);

      expect(plain.fileOut).toBe('{"0":"b","1":"o","2":"x","3":"e","4":"d"}\n');
      expect(masked.fileOut).toBe(plain.fileOut);
    });

    it("a typed array renders like the no-mask line (index order kept)", async () => {
      class Bytes {
        public message = "m";
        toJSON(): Uint8Array {
          return Uint8Array.from({ length: 12 }, (_v, i) => i);
        }
      }
      const plain = await render("mom-top-typed", "json", (logger) => logger.info(new Bytes()));
      const masked = await render("mom-top-typed", "json", (logger) => logger.info(new Bytes()), [
        "password",
      ]);

      expect(plain.fileOut.startsWith('{"0":0,"1":1,"2":2,')).toBe(true);
      expect(masked.fileOut).toBe(plain.fileOut);
    });

    it("a Buffer renders like the no-mask line", async () => {
      class Bytes {
        public message = "m";
        toJSON(): Buffer {
          return Buffer.from(Array.from({ length: 12 }, (_v, i) => i));
        }
      }
      const plain = await render("mom-top-buffer", "json", (logger) => logger.info(new Bytes()));
      const masked = await render("mom-top-buffer", "json", (logger) => logger.info(new Bytes()), [
        "password",
      ]);

      expect(plain.fileOut.startsWith('{"0":0,"1":1,"2":2,')).toBe(true);
      expect(masked.fileOut).toBe(plain.fileOut);
    });

    it("a class instance is masked, and kept as is when nothing matches", async () => {
      class Creds {
        public message = "m";
        public password = "secret-S41";
      }
      class Clean {
        public message = "m";
      }
      class WrapsCreds {
        public message = "w";
        toJSON(): Creds {
          return new Creds();
        }
      }
      class WrapsClean {
        public message = "w";
        toJSON(): Clean {
          return new Clean();
        }
      }
      const masked = await render("mom-top-inst", "json", (l) => l.info(new WrapsCreds()), [
        "password",
      ]);
      const plainClean = await render("mom-top-inst", "json", (l) => l.info(new WrapsClean()));
      const maskedClean = await render("mom-top-inst", "json", (l) => l.info(new WrapsClean()), [
        "password",
      ]);

      expect(masked.fileOut).toBe('{"message":"m","password":"[REDACTED]"}\n');
      expect(maskedClean.fileOut).toBe(plainClean.fileOut);
      expect(plainClean.fileOut).toBe('{"message":"m"}\n');
    });

    it("a Proxy whose key listing throws fails closed instead of throwing out of logger.info", async () => {
      class Hostile {
        public message = "hostile";
        toJSON(): object {
          return new Proxy(
            {},
            {
              ownKeys: (): never => {
                throw new Error("ownKeys trap failed");
              },
            },
          );
        }
      }
      const out = await render("mom-top-proxy", "json", (l) => l.info(new Hostile()), ["password"]);

      expect(out.thrown).toBeUndefined();
      expect(out.fileOut).toBe('{"_redactionFailed":true,"level":"info","message":"hostile"}\n');
      expect(out.fileOut).not.toContain("ownKeys trap failed");
    });
  });
});

describe("caller-safe Error-in-message payloads", () => {
  afterEach(() => {
    resetLoggerRegistry();
    jest.restoreAllMocks();
  });

  const LEVEL_SLOT = Symbol.for("level");
  // A fixed stack keeps every byte pin independent of where this test sits in the file.
  const FIXED_STACK = "Error: boom\n    at fixed (fixed.js:1:1)";
  const FORMATS: Format[] = ["pretty", "json"];
  const hasOwn = (value: object, key: string): boolean =>
    Object.prototype.hasOwnProperty.call(value, key);

  /** An Error the way an application throws it: a fixed stack and one own enumerable field. */
  const makeError = (): Error & { code: string } => {
    const err = Object.assign(new Error("boom"), { code: "E42" });
    err.stack = FIXED_STACK;
    return err;
  };

  /** The exact error line both chains wrote before the fix for `{ message: err, requestId }`. */
  const errorLine = (format: Format, label: string): string =>
    format === "pretty"
      ? `UTC: ${STAMP}\n[ERROR] (${label})\nboom\n${FIXED_STACK}\n{\n  "requestId": "r1",\n  "code": "E42"\n}\n\n`
      : `{"code":"E42","level":"error","message":"boom","module":"${label}","requestId":"r1",` +
        `"stack":${JSON.stringify(FIXED_STACK)},"timestamp":"${STAMP}"}\n`;

  /** The logged Error itself is never touched either. */
  const expectErrorUntouched = (err: Error & { code: string }): void => {
    expect(err.message).toBe("boom");
    expect(err.stack).toBe(FIXED_STACK);
    expect(err.code).toBe("E42");
    expect(Object.keys(err)).toEqual(["code"]);
  };

  interface PlainForm {
    title: string;
    make: (err: Error) => Record<string | symbol, unknown>;
    emit: (logger: winston.Logger, payload: Record<string | symbol, unknown>) => void;
    /** Own keys afterwards: the original ones plus winston-core's `level` write. */
    keysAfter: string[];
  }

  const plainForms: PlainForm[] = [
    {
      title: "logger.error({ message: err, requestId })",
      make: (err) => ({ message: err, requestId: "r1" }),
      emit: (logger, payload) => logger.error(payload),
      keysAfter: ["message", "requestId", "level"],
    },
    {
      title: 'logger.log("error", { message: err, requestId })',
      make: (err) => ({ message: err, requestId: "r1" }),
      emit: (logger, payload) => logger.log("error", payload),
      keysAfter: ["message", "requestId", "level"],
    },
    {
      title: 'logger.log({ level: "error", message: err, requestId })',
      make: (err) => ({ level: "error", message: err, requestId: "r1" }),
      emit: (logger, payload) => logger.log(payload as never),
      keysAfter: ["level", "message", "requestId"],
    },
    {
      title: "logger.error() with a null-prototype { message: err, requestId }",
      make: (err) =>
        Object.assign(Object.create(null) as Record<string, unknown>, {
          message: err,
          requestId: "r1",
        }),
      emit: (logger, payload) => logger.error(payload),
      keysAfter: ["message", "requestId", "level"],
    },
  ];

  describe.each(FORMATS)("%s", (format) => {
    const label = `err-payload-${format}`;

    it.each(plainForms)(
      "$title renders the same line and leaves the caller's object and its Error untouched",
      async ({ make, emit, keysAfter }) => {
        const err = makeError();
        const payload = make(err);

        const out = await render(label, format, (logger) => emit(logger, payload));

        expect(out.thrown).toBeUndefined();
        expect(out.fileOut).toBe(errorLine(format, label));
        expectConsoleMatchesFile(format, out);
        // `message` is still the SAME Error instance, not its message string.
        expect(payload.message).toBe(err);
        // Only winston-core's own `level` / `[LEVEL]` write lands on the object:
        // no `stack`, no copied Error field, no `[MESSAGE]` slot.
        expect(Object.keys(payload)).toEqual(keysAfter);
        expect(hasOwn(payload, "stack")).toBe(false);
        expect(hasOwn(payload, "code")).toBe(false);
        expect(payload.level).toBe("error");
        expect(Object.getOwnPropertySymbols(payload)).toEqual([LEVEL_SLOT]);
        expect(payload[LEVEL_SLOT]).toBe("error");
        expectErrorUntouched(err);
      },
    );

    it("keeps the caller's own `code` and `stack` fields while the line still shows the Error's", async () => {
      // errors() copies the Error's fields over the payload's, so the line shows
      // the Error's `code` / `stack` (unchanged); the caller's values must survive.
      const err = makeError();
      const payload: Record<string, unknown> = {
        message: err,
        requestId: "r1",
        code: "CALLER",
        stack: "caller stack",
      };

      const out = await render(label, format, (logger) => logger.error(payload));

      expect(out.thrown).toBeUndefined();
      expect(out.fileOut).toBe(errorLine(format, label));
      expectConsoleMatchesFile(format, out);
      expect(payload).toEqual({
        message: err,
        requestId: "r1",
        code: "CALLER",
        stack: "caller stack",
        level: "error",
        [LEVEL_SLOT]: "error",
      });
      expect(payload.message).toBe(err);
      expectErrorUntouched(err);
    });

    it("copies a plain payload's accessors by descriptor, never invoking them", async () => {
      // A value copy would read `audit` once more than today; a descriptor copy
      // leaves the read count exactly where it was (pretty: the printf and the
      // console's accessor pass; json: the serializer).
      const err = makeError();
      let calls = 0;
      const payload: Record<string, unknown> = { message: err, requestId: "r1" };
      Object.defineProperty(payload, "audit", {
        enumerable: true,
        configurable: true,
        get() {
          calls += 1;
          return "a1";
        },
      });

      const out = await render(label, format, (logger) => logger.error(payload));

      expect(out.thrown).toBeUndefined();
      expect(calls).toBe(format === "pretty" ? 2 : 1);
      expect(out.fileOut).toContain(format === "pretty" ? '"audit": "a1"' : '"audit":"a1"');
      expect(payload.message).toBe(err);
      expect(hasOwn(payload, "code")).toBe(false);
      expect(typeof Object.getOwnPropertyDescriptor(payload, "audit")?.get).toBe("function");
    });

    it("a getter-only `message` returning an Error degrades exactly as before, and writes nothing onto the payload", async () => {
      // errors() cannot assign the flattened string over a getter-only `message`,
      // so it throws and the line degrades via `_errorFlattenFailed` (unchanged).
      // Before the fix its `Object.assign` had already copied `code` onto the
      // caller's object by then.
      const err = makeError();
      let calls = 0;
      const payload: Record<string, unknown> = { requestId: "r2" };
      Object.defineProperty(payload, "message", {
        enumerable: true,
        configurable: true,
        get() {
          calls += 1;
          return err;
        },
      });

      const out = await render(label, format, (logger) => logger.log("error", payload));

      expect(out.thrown).toBeUndefined();
      expect(out.fileOut).toBe(
        format === "pretty"
          ? `UTC: ${STAMP}\n[ERROR] (${label})\nboom\n${FIXED_STACK}\n{\n  "_errorFlattenFailed": true\n}\n\n`
          : `{"_errorFlattenFailed":true,"level":"error","message":"boom","module":"${label}",` +
              `"stack":${JSON.stringify(FIXED_STACK)},"timestamp":"${STAMP}"}\n`,
      );
      expectConsoleMatchesFile(format, out);
      expect(Object.keys(payload)).toEqual(["requestId", "message", "level"]);
      expect(hasOwn(payload, "code")).toBe(false);
      expect(hasOwn(payload, "stack")).toBe(false);
      // Twice by errors() and once by its fail-closed fallback, as before: the
      // copy is chosen from the property descriptor, so the getter is not read.
      expect(calls).toBe(3);
      expectErrorUntouched(err);
    });

    it("a `message` accessor holding a string is read exactly as often as before", async () => {
      let calls = 0;
      const payload: Record<string, unknown> = { requestId: "r3" };
      Object.defineProperty(payload, "message", {
        enumerable: true,
        configurable: true,
        get() {
          calls += 1;
          return "text";
        },
      });

      const out = await render(label, format, (logger) => logger.log("error", payload));

      expect(out.thrown).toBeUndefined();
      expect(out.fileOut).toBe(
        format === "pretty"
          ? `UTC: ${STAMP}\n[ERROR] (${label})\ntext\n{\n  "requestId": "r3"\n}\n\n`
          : `{"level":"error","message":"text","module":"${label}","requestId":"r3","timestamp":"${STAMP}"}\n`,
      );
      expectConsoleMatchesFile(format, out);
      // The read counts measured before the fix: the getter stays an accessor on
      // every copy, so each later format and the console re-read it. Choosing the
      // copy from the descriptor adds no read of its own.
      expect(calls).toBe(format === "pretty" ? 6 : 2);
      expect(Object.keys(payload)).toEqual(["requestId", "message", "level"]);
      expect(typeof Object.getOwnPropertyDescriptor(payload, "message")?.get).toBe("function");
    });

    it("a Proxy whose `message` exists only through its get trap renders exactly as before", async () => {
      // A descriptor copy cannot reproduce a property the target does not own,
      // so such a payload is not copied: errors() flattens it through the
      // Proxy's traps as before (a documented exception, like a class
      // instance), and the line keeps the Error's message.
      const err = makeError();
      const target: Record<string, unknown> = { requestId: "r1" };
      const payload = new Proxy(target, {
        get: (obj, key, receiver) => (key === "message" ? err : Reflect.get(obj, key, receiver)),
      });

      const out = await render(label, format, (logger) => logger.log("error", payload));

      expect(out.thrown).toBeUndefined();
      expect(out.fileOut).toBe(errorLine(format, label));
      expectConsoleMatchesFile(format, out);
      expect(out.fileOut).not.toContain("undefined");
      // Still flattened in place through the traps, exactly as before.
      expect(target).toEqual({
        requestId: "r1",
        level: "error",
        code: "E42",
        message: "boom",
        stack: FIXED_STACK,
        [LEVEL_SLOT]: "error",
        [Symbol.for("message")]: "boom",
      });
      expectErrorUntouched(err);
    });

    it("a Proxy payload whose getOwnPropertyDescriptor trap throws degrades instead of throwing", async () => {
      // The copy decision reads the `message` descriptor inside the errors() guard,
      // so a hostile trap lands on the `_errorFlattenFailed` line. (Before, the
      // same trap threw out of the log call from the timestamp step's copy.)
      const target: Record<string, unknown> = { message: "px", requestId: "r1" };
      const payload = new Proxy(target, {
        set: (obj, key, value) => Reflect.set(obj, key, value),
        getOwnPropertyDescriptor: () => {
          throw new Error("gopd boom");
        },
      });

      const out = await render(label, format, (logger) => logger.log("error", payload));

      expect(out.thrown).toBeUndefined();
      expect(out.fileOut).toBe(
        format === "pretty"
          ? `UTC: ${STAMP}\n[ERROR] (${label})\nundefined\n{\n  "_errorFlattenFailed": true\n}\n\n`
          : `{"_errorFlattenFailed":true,"level":"error","module":"${label}","timestamp":"${STAMP}"}\n`,
      );
      expectConsoleMatchesFile(format, out);
      expect(out.fileOut).not.toContain("gopd boom");
      expect(target).toEqual({
        message: "px",
        requestId: "r1",
        level: "error",
        [LEVEL_SLOT]: "error",
      });
    });

    it("with maskMetaKeys, a plain { message: err } payload renders the same masked line and stays untouched", async () => {
      const err = makeError();
      const payload: Record<string, unknown> = {
        message: err,
        requestId: "r1",
        password: "secret-P7",
      };

      const out = await render(label, format, (logger) => logger.error(payload), ["password"]);

      expect(out.thrown).toBeUndefined();
      expect(out.fileOut).toBe(
        format === "pretty"
          ? `UTC: ${STAMP}\n[ERROR] (${label})\nboom\n${FIXED_STACK}\n` +
              `{\n  "requestId": "r1",\n  "password": "[REDACTED]",\n  "code": "E42"\n}\n\n`
          : `{"code":"E42","level":"error","message":"boom","module":"${label}",` +
              `"password":"[REDACTED]","requestId":"r1","stack":${JSON.stringify(FIXED_STACK)},` +
              `"timestamp":"${STAMP}"}\n`,
      );
      expectConsoleMatchesFile(format, out);
      expect(out.fileOut).not.toContain("secret-P7");
      expect(out.consoleOut).not.toContain("secret-P7");
      expect(payload).toEqual({
        message: err,
        requestId: "r1",
        password: "secret-P7",
        level: "error",
        [LEVEL_SLOT]: "error",
      });
      expectErrorUntouched(err);
    });

    it("a throwing `message` getter still degrades via `_errorFlattenFailed`, read no more often than before", async () => {
      let calls = 0;
      const payload: Record<string, unknown> = { data: 1 };
      Object.defineProperty(payload, "message", {
        enumerable: true,
        configurable: true,
        get() {
          calls += 1;
          throw new Error("msg boom");
        },
      });

      const out = await render(label, format, (logger) => logger.log("error", payload));

      expect(out.thrown).toBeUndefined();
      expect(out.fileOut).toBe(
        format === "pretty"
          ? `UTC: ${STAMP}\n[ERROR] (${label})\nundefined\n{\n  "_errorFlattenFailed": true\n}\n\n`
          : `{"_errorFlattenFailed":true,"level":"error","module":"${label}","timestamp":"${STAMP}"}\n`,
      );
      expectConsoleMatchesFile(format, out);
      expect(out.fileOut).not.toContain("msg boom");
      // Once by the errors() step and once by its fail-closed fallback, as before.
      expect(calls).toBe(2);
      expect(Object.keys(payload)).toEqual(["data", "message", "level"]);
    });

    it("negative control: a top-level logger.error(err) renders exactly as before", async () => {
      const err = makeError();

      const out = await render(label, format, (logger) => logger.error(err));

      expect(out.thrown).toBeUndefined();
      expect(out.fileOut).toBe(
        format === "pretty"
          ? `UTC: ${STAMP}\n[ERROR] (${label})\nboom\n${FIXED_STACK}\n{\n  "code": "E42"\n}\n\n`
          : `{"code":"E42","level":"error","message":"boom","module":"${label}",` +
              `"stack":${JSON.stringify(FIXED_STACK)},"timestamp":"${STAMP}"}\n`,
      );
      expectConsoleMatchesFile(format, out);
      // winston-core writes `level` onto the logged Error itself (unchanged);
      // nothing else is added and its message and stack are intact.
      expect(Object.keys(err)).toEqual(["code", "level"]);
      expect(err.message).toBe("boom");
      expect(err.stack).toBe(FIXED_STACK);
    });

    it("negative control: a plain string-message payload renders exactly as before", async () => {
      const payload: Record<string, unknown> = { message: "plain", x: 1 };

      const out = await render(label, format, (logger) => logger.info(payload));

      expect(out.thrown).toBeUndefined();
      expect(out.fileOut).toBe(
        format === "pretty"
          ? prettyLine(label, 'plain\n{\n  "x": 1\n}')
          : `{"level":"info","message":"plain","module":"${label}","timestamp":"${STAMP}","x":1}\n`,
      );
      expectConsoleMatchesFile(format, out);
      expect(payload).toEqual({ message: "plain", x: 1, level: "info", [LEVEL_SLOT]: "info" });
    });

    it("documented exception: a class-instance payload keeps winston's in-place flattening and its toJSON line", async () => {
      // A plain copy would drop the prototype, so json() would stop calling the
      // instance's toJSON and print the fields it withholds. Class instances
      // therefore stay on errors()' in-place path: the line is unchanged and the
      // instance's `message` is still replaced by the Error's message string.
      class ErrorEnvelope {
        public message: unknown;
        public requestId: string;
        constructor(message: unknown) {
          this.message = message;
          this.requestId = "r1";
        }
        toJSON(): Record<string, unknown> {
          return { kind: "envelope", requestId: this.requestId };
        }
      }
      const err = makeError();
      const payload = new ErrorEnvelope(err);

      const out = await render(label, format, (logger) => logger.error(payload));

      expect(out.thrown).toBeUndefined();
      expect(out.fileOut).toBe(
        format === "pretty" ? errorLine(format, label) : '{"kind":"envelope","requestId":"r1"}\n',
      );
      expectConsoleMatchesFile(format, out);
      expect(payload.message).toBe("boom");
      expect(Object.keys(payload)).toEqual([
        "message",
        "requestId",
        "level",
        "code",
        "stack",
        "timestamp",
      ]);
      expectErrorUntouched(err);
    });
  });
});

describe("maskMetaKeys masks the output of a metadata object's own toJSON in pretty mode", () => {
  afterEach(() => {
    resetLoggerRegistry();
    jest.restoreAllMocks();
  });

  interface ToJSONForm {
    title: string;
    make: (secret: string) => Record<string, unknown>;
    emit: (logger: winston.Logger, payload: Record<string, unknown>) => void;
    /** Own keys of the payload afterwards (winston-core adds `level` only when it is the info). */
    keysAfter: string[];
  }

  // winston keeps the caller's object as the info when it has a truthy
  // `message`, and merges a metadata object into a fresh info on the
  // multi-argument form, so an own `toJSON` reaches the metadata bag both ways.
  const forms: ToJSONForm[] = [
    {
      title: 'logger.info({ message: "m", user, toJSON })',
      make: (secret) => ({
        message: "m",
        user: "bob",
        toJSON: () => ({ user: "bob", password: secret }),
      }),
      emit: (logger, payload) => logger.info(payload as never),
      keysAfter: ["message", "user", "toJSON", "level"],
    },
    {
      title: 'logger.info("m", { user, toJSON })',
      make: (secret) => ({ user: "bob", toJSON: () => ({ user: "bob", password: secret }) }),
      emit: (logger, payload) => logger.info("m", payload),
      keysAfter: ["user", "toJSON"],
    },
  ];

  it.each(forms)(
    "pretty: $title masks the toJSON output exactly like the unmasked line, file and console",
    async ({ make, emit, keysAfter }) => {
      const plain = await render("mtj-off", "pretty", (logger) => {
        emit(logger, make("secret-T1"));
      });
      const payload = make("secret-T1");
      const masked = await render(
        "mtj-on",
        "pretty",
        (logger) => {
          emit(logger, payload);
        },
        ["password"],
      );

      // Unchanged without a mask: JSON.stringify calls the bag's toJSON.
      expect(plain.fileOut).toBe(
        prettyLine("mtj-off", 'm\n{\n  "user": "bob",\n  "password": "secret-T1"\n}'),
      );
      expect(masked.thrown).toBeUndefined();
      expect(masked.fileOut).toBe(
        prettyLine("mtj-on", 'm\n{\n  "user": "bob",\n  "password": "[REDACTED]"\n}'),
      );
      expectConsoleMatchesFile("pretty", masked);
      for (const output of [masked.fileOut, masked.consoleOut]) {
        expect(output).not.toContain("secret-T1");
      }
      // The caller's object is never rewritten.
      expect(Object.keys(payload)).toEqual(keysAfter);
      expect(payload.user).toBe("bob");
      expect((payload.toJSON as () => unknown)()).toEqual({ user: "bob", password: "secret-T1" });
    },
  );

  it.each(forms)(
    "json: $title masks the same toJSON output (parity pin)",
    async ({ make, emit }) => {
      const out = await render(
        "mtj-json",
        "json",
        (logger) => {
          emit(logger, make("secret-T2"));
        },
        ["password"],
      );

      expect(out.thrown).toBeUndefined();
      // json() lets a top-level toJSON own the whole line; the mask applies to it.
      expect(out.fileOut).toBe('{"password":"[REDACTED]","user":"bob"}\n');
      expect(out.consoleOut).toBe(out.fileOut);
      expect(out.fileOut).not.toContain("secret-T2");
    },
  );

  it("pretty: a toJSON reading a masked field through `this` still sees the placeholder", async () => {
    // The toJSON runs on the masked copy, exactly where JSON.stringify ran it
    // before, so a renamed field built from `this.password` stays masked.
    const out = await render(
      "mtj-this",
      "pretty",
      (logger) => {
        logger.info("login", {
          password: "secret-T7",
          toJSON() {
            return { pw: this.password };
          },
        });
      },
      ["password"],
    );

    expect(out.thrown).toBeUndefined();
    expect(out.fileOut).toBe(prettyLine("mtj-this", 'login\n{\n  "pw": "[REDACTED]"\n}'));
    expectConsoleMatchesFile("pretty", out);
    expect(out.fileOut).not.toContain("secret-T7");
  });

  it("json: documented boundary, the entry's toJSON runs on the original, so a renamed `this` field is not masked", async () => {
    // JSON mode calls a top-level toJSON on the real object (a copy would break
    // a toJSON reading #private fields) and masks its OUTPUT by its own keys.
    // A masked field copied under another name therefore prints; the README
    // documents this difference from pretty mode, and this test pins it.
    const out = await render(
      "mtj-this-json",
      "json",
      (logger) => {
        logger.info("login", {
          password: "secret-T8",
          toJSON() {
            return { pw: this.password, password: this.password };
          },
        });
      },
      ["password"],
    );

    expect(out.thrown).toBeUndefined();
    // The output's own `password` key is masked; the renamed `pw` is not.
    expect(out.fileOut).toBe('{"password":"[REDACTED]","pw":"secret-T8"}\n');
    expect(out.consoleOut).toBe(out.fileOut);
    expect(out.fileOut).not.toContain('"password":"secret-T8"');
  });

  it.each(["pretty", "json"] as const)(
    "%s: a class-inherited toJSON that throws fails closed in json and is never called in pretty",
    async (format) => {
      class HostileDto {
        public message = "hostile";
        public password = "secret-T9";
        public toJSON(): never {
          throw new Error("toJSON refused");
        }
      }

      const out = await render(
        `mtj-class-throw-${format}`,
        format,
        (logger) => logger.info(new HostileDto()),
        ["password"],
      );

      expect(out.thrown).toBeUndefined();
      expect(out.fileOut).toBe(
        format === "pretty"
          ? // The metadata block holds the instance's own fields, masked by key;
            // pretty mode only resolves a toJSON the block owns.
            `UTC: ${STAMP}\n[INFO] (mtj-class-throw-pretty)\nhostile\n{\n  "password": "[REDACTED]"\n}\n\n`
          : '{"_redactionFailed":true,"level":"info","message":"hostile"}\n',
      );
      expect(out.fileOut).not.toContain("secret-T9");
      expect(out.fileOut).not.toContain("[UNSERIALIZABLE]");
      expectConsoleMatchesFile(format, out);
    },
  );

  it("pretty: a throwing metadata getter fails the file block closed while the console drops only that field", async () => {
    const out = await render(
      "mtj-getter-console",
      "pretty",
      (logger) => {
        logger.info({
          message: "m",
          password: "secret-T10",
          keep: 1,
          get bad(): string {
            throw new Error("getter refused");
          },
        });
      },
      ["password"],
    );

    expect(out.thrown).toBeUndefined();
    expect(out.fileOut).toBe(
      prettyLine("mtj-getter-console", 'm\n{\n  "_redactionFailed": true\n}'),
    );
    // The console copy resolves the throwing accessor to undefined before it
    // renders, so the rest of the block prints, still masked.
    expect(stripAnsi(out.consoleOut)).toBe(
      '[INFO] (mtj-getter-console)\nm\n{\n  "password": "[REDACTED]",\n  "keep": 1\n}\n\n',
    );
    expect(out.fileOut + out.consoleOut).not.toContain("secret-T10");
  });

  it("pretty: a throwing getter nested inside a metadata value fails the file and console blocks closed alike", async () => {
    // Only top-level accessors are resolved before the console copy, so a
    // nested one still throws inside the console's own masking walk.
    const out = await render(
      "mtj-nested-getter",
      "pretty",
      (logger) => {
        logger.info("m", {
          password: "secret-T11",
          user: {
            get bad(): string {
              throw new Error("getter refused");
            },
          },
        });
      },
      ["password"],
    );

    expect(out.thrown).toBeUndefined();
    expect(out.fileOut).toBe(
      prettyLine("mtj-nested-getter", 'm\n{\n  "_redactionFailed": true\n}'),
    );
    expectConsoleMatchesFile("pretty", out);
    expect(out.fileOut + out.consoleOut).not.toContain("secret-T11");
  });

  it("pretty: a toJSON that returns the bag itself is read by its own keys, not called again", async () => {
    let calls = 0;
    const emit = (logger: winston.Logger): void => {
      logger.info("m", {
        password: "secret-T3",
        note: "n",
        toJSON() {
          calls += 1;
          return this;
        },
      });
    };
    const plain = await render("mtj-self", "pretty", emit);
    const plainCalls = calls;
    calls = 0;
    const masked = await render("mtj-self", "pretty", emit, ["password"]);

    // The serializer calls toJSON once and omits the function-valued key of
    // the result; the masked line keeps exactly those keys.
    expect(plain.fileOut).toBe(
      prettyLine("mtj-self", 'm\n{\n  "password": "secret-T3",\n  "note": "n"\n}'),
    );
    expect(masked.thrown).toBeUndefined();
    expect(masked.fileOut).toBe(
      prettyLine("mtj-self", 'm\n{\n  "password": "[REDACTED]",\n  "note": "n"\n}'),
    );
    expectConsoleMatchesFile("pretty", masked);
    expect(masked.fileOut).not.toContain("secret-T3");
    // One call per rendering (file and console) either way: the result's own
    // toJSON key is dropped rather than called a second time.
    expect(plainCalls).toBe(2);
    expect(calls).toBe(plainCalls);
  });

  it.each([
    ["a primitive", (): unknown => "summary", '"summary"'],
    ["an empty object", (): unknown => ({}), "{}"],
    ["an empty array", (): unknown => [], "[]"],
  ])(
    "pretty: a toJSON returning %s renders the same block with and without a mask",
    async (_name, result, block) => {
      const emit = (logger: winston.Logger): void => {
        logger.info("m", { toJSON: result });
      };
      const plain = await render("mtj-shape", "pretty", emit);
      const masked = await render("mtj-shape", "pretty", emit, ["password"]);

      expect(plain.fileOut).toBe(prettyLine("mtj-shape", `m\n${block}`));
      expect(masked.thrown).toBeUndefined();
      expect(masked.fileOut).toBe(plain.fileOut);
      expectConsoleMatchesFile("pretty", masked);
    },
  );

  it("pretty: a toJSON returning an array masks the secret inside it", async () => {
    const emit = (logger: winston.Logger): void => {
      logger.info("m", { toJSON: () => [{ password: "secret-T4", id: 1 }] });
    };
    const plain = await render("mtj-array", "pretty", emit);
    const masked = await render("mtj-array", "pretty", emit, ["password"]);

    expect(plain.fileOut).toBe(
      prettyLine("mtj-array", 'm\n[\n  {\n    "password": "secret-T4",\n    "id": 1\n  }\n]'),
    );
    expect(masked.fileOut).toBe(
      prettyLine("mtj-array", 'm\n[\n  {\n    "password": "[REDACTED]",\n    "id": 1\n  }\n]'),
    );
    expectConsoleMatchesFile("pretty", masked);
    expect(masked.consoleOut).not.toContain("secret-T4");
  });

  it("pretty: a mask that names toJSON itself replaces the method, so the object's own keys print (documented exception)", async () => {
    // The walk masks the `toJSON` key like any other, turning the method into
    // the placeholder string, so there is no method left to call and
    // JSON.stringify prints the bag's own keys. This is the one exception the
    // maskMetaKeys JSDoc names; json mode resolves the method before masking.
    const emit = (logger: winston.Logger): void => {
      logger.info("m", { hidden: "kept-H1", toJSON: () => ({ shown: 1 }) });
    };
    const pretty = await render("mtj-named", "pretty", emit, ["toJSON"]);
    const json = await render("mtj-named", "json", emit, ["toJSON"]);

    expect(pretty.thrown).toBeUndefined();
    expect(pretty.fileOut).toBe(
      prettyLine("mtj-named", 'm\n{\n  "hidden": "kept-H1",\n  "toJSON": "[REDACTED]"\n}'),
    );
    expectConsoleMatchesFile("pretty", pretty);
    expect(json.fileOut).toBe('{"shown":1}\n');
    expect(json.fileOut).not.toContain("kept-H1");
  });

  it("pretty: metadata without a toJSON renders exactly as before under a mask", async () => {
    const out = await render(
      "mtj-none",
      "pretty",
      (logger) => {
        logger.info("m", { user: "bob", password: "secret-T5", nested: { password: "secret-T6" } });
      },
      ["password"],
    );

    expect(out.fileOut).toBe(
      prettyLine(
        "mtj-none",
        'm\n{\n  "user": "bob",\n  "password": "[REDACTED]",\n  "nested": {\n    "password": "[REDACTED]"\n  }\n}',
      ),
    );
    expectConsoleMatchesFile("pretty", out);
    expect(out.fileOut).not.toContain("secret-T");
  });
});

describe("a payload whose keys or prototype cannot be read", () => {
  afterEach(() => {
    resetLoggerRegistry();
    jest.restoreAllMocks();
  });

  const LEVEL_SLOT = Symbol.for("level");
  const refuse = (trap: string) => (): never => {
    throw new Error(`${trap} refused`);
  };
  class Dto {
    public message = "hi";
    public password = "secret-X1";
  }

  interface HostileCase {
    title: string;
    make: () => { payload: object; target: Record<string | symbol, unknown> };
    emit: (logger: winston.Logger, payload: object) => void;
    /** The level the entry was logged at, which the degraded line keeps. */
    level: string;
    /** The message the degraded line keeps: the payload's own string, else the sentinel. */
    message: string;
    /** The target's own keys afterwards. */
    keysAfter: string[];
  }

  const plainTarget = (): Record<string | symbol, unknown> => ({
    message: "hi",
    password: "secret-X1",
  });

  const cases: HostileCase[] = [
    {
      title: "a plain Proxy whose ownKeys trap throws, logged with logger.info",
      make: () => {
        const target = plainTarget();
        return { payload: new Proxy(target, { ownKeys: refuse("ownKeys") }), target };
      },
      emit: (logger, payload) => logger.info(payload as never),
      level: "info",
      message: "hi",
      keysAfter: ["message", "password", "level"],
    },
    {
      title: "the same Proxy logged with logger.error, which keeps its level",
      make: () => {
        const target = plainTarget();
        return { payload: new Proxy(target, { ownKeys: refuse("ownKeys") }), target };
      },
      emit: (logger, payload) => logger.error(payload as never),
      level: "error",
      message: "hi",
      keysAfter: ["message", "password", "level"],
    },
    {
      title: 'the same Proxy logged with logger.log("info", payload)',
      make: () => {
        const target = plainTarget();
        return { payload: new Proxy(target, { ownKeys: refuse("ownKeys") }), target };
      },
      emit: (logger, payload) => logger.log("info", payload as never),
      level: "info",
      message: "hi",
      keysAfter: ["message", "password", "level"],
    },
    {
      title: "a class-instance Proxy whose ownKeys trap throws",
      make: () => {
        const target = new Dto() as unknown as Record<string | symbol, unknown>;
        return { payload: new Proxy(target, { ownKeys: refuse("ownKeys") }), target };
      },
      emit: (logger, payload) => logger.info(payload as never),
      level: "info",
      message: "hi",
      // A class instance keeps the documented in-place `timestamp` write.
      keysAfter: ["message", "password", "level", "timestamp"],
    },
    {
      title: "a plain Proxy whose getPrototypeOf trap throws",
      make: () => {
        const target = plainTarget();
        return { payload: new Proxy(target, { getPrototypeOf: refuse("getPrototypeOf") }), target };
      },
      emit: (logger, payload) => logger.info(payload as never),
      level: "info",
      message: "hi",
      keysAfter: ["message", "password", "level"],
    },
    {
      title: "a Proxy without a message whose ownKeys trap throws, logged at warn",
      make: () => {
        const target: Record<string | symbol, unknown> = { password: "secret-X1" };
        return { payload: new Proxy(target, { ownKeys: refuse("ownKeys") }), target };
      },
      emit: (logger, payload) => logger.log("warn", payload as never),
      level: "warn",
      message: "[UNSERIALIZABLE]",
      keysAfter: ["password", "level"],
    },
    {
      title: "a Proxy whose message read and ownKeys trap both throw",
      make: () => {
        const target: Record<string | symbol, unknown> = { password: "secret-X1" };
        const payload = new Proxy(target, {
          ownKeys: refuse("ownKeys"),
          get: (obj, key, receiver) => {
            if (key === "message") {
              throw new Error("message refused");
            }
            return Reflect.get(obj, key, receiver);
          },
        });
        return { payload, target };
      },
      emit: (logger, payload) => logger.log("info", payload as never),
      level: "info",
      message: "[UNSERIALIZABLE]",
      keysAfter: ["password", "level"],
    },
  ];

  const FORMATS: Format[] = ["pretty", "json"];

  describe.each(FORMATS)("%s", (format) => {
    const degradedLine = (label: string, message: string, level: string): string =>
      format === "pretty"
        ? `UTC: ${STAMP}\n[${level.toUpperCase()}] (${label})\n${message}\n{\n  "_unserializable": true\n}\n\n`
        : `{"_unserializable":true,"level":"${level}","message":${JSON.stringify(message)},` +
          `"module":"${label}","timestamp":"${STAMP}"}\n`;

    // The throw happens before any mask-dependent format, so the degraded line
    // is the same with and without `maskMetaKeys`.
    describe.each([
      ["without maskMetaKeys", undefined],
      ["with maskMetaKeys", ["password"]],
    ] as [string, string[] | undefined][])("%s", (_maskTitle, maskMetaKeys) => {
      it.each(cases)(
        "$title renders a degraded line instead of throwing",
        async ({ make, emit, level, message, keysAfter }) => {
          const label = `hostile-${format}`;
          const { payload, target } = make();

          const out = await render(label, format, (logger) => emit(logger, payload), maskMetaKeys);

          expect(out.thrown).toBeUndefined();
          expect(out.fileOut).toBe(degradedLine(label, message, level));
          expectConsoleMatchesFile(format, out);
          for (const output of [out.fileOut, out.consoleOut]) {
            expect(output).not.toContain("refused");
            // Nothing the payload holds beyond a string message is written.
            expect(output).not.toContain("secret-X1");
          }
          // Only winston-core's own `level` / `[LEVEL]` write lands on a plain
          // target; the secret is still there, unmasked and untouched.
          expect(Object.keys(target)).toEqual(keysAfter);
          expect(Object.getOwnPropertySymbols(target)).toEqual([LEVEL_SLOT]);
          expect(target[LEVEL_SLOT]).toBe(level);
          expect(target.password).toBe("secret-X1");
        },
      );
    });

    interface LevelCase {
      title: string;
      /** Values the Proxy's `get` trap reports instead of the target's. */
      overrides: Map<string | symbol, unknown>;
      expectedLevel: string;
      /** Whether winston itself reports an unknown level before the chain runs. */
      winstonReportsUnknownLevel: boolean;
    }

    it.each<LevelCase>([
      {
        title: "an unreadable `[LEVEL]` slot falls back to `level`",
        overrides: new Map<string | symbol, unknown>([[LEVEL_SLOT, undefined]]),
        expectedLevel: "warn",
        winstonReportsUnknownLevel: true,
      },
      {
        title: "an unreadable `[LEVEL]` slot and `level` fall back to info",
        overrides: new Map<string | symbol, unknown>([
          [LEVEL_SLOT, undefined],
          ["level", undefined],
        ]),
        expectedLevel: "info",
        winstonReportsUnknownLevel: true,
      },
      {
        title: "the `[LEVEL]` slot wins over `level` when both are readable",
        overrides: new Map<string | symbol, unknown>([[LEVEL_SLOT, "error"]]),
        expectedLevel: "error",
        winstonReportsUnknownLevel: false,
      },
    ])(
      "$title, so the degraded line is still written at a real level",
      async ({ overrides, expectedLevel, winstonReportsUnknownLevel }) => {
        const errorSpy = jest.spyOn(console, "error").mockImplementation(() => undefined);
        const label = `hostile-level-${format}`;
        const payload = new Proxy(plainTarget(), {
          ownKeys: refuse("ownKeys"),
          get: (obj, key, receiver) =>
            overrides.has(key) ? overrides.get(key) : Reflect.get(obj, key, receiver),
        });

        const out = await render(label, format, (logger) => logger.log("warn", payload as never));

        expect(out.thrown).toBeUndefined();
        expect(out.fileOut).toBe(degradedLine(label, "hi", expectedLevel));
        expectConsoleMatchesFile(format, out);
        // winston itself reports a level it could not read; this package never
        // writes to stderr on this path.
        expect(errorSpy.mock.calls).toEqual(
          winstonReportsUnknownLevel ? [["[winston] Unknown logger level: %s", undefined]] : [],
        );
      },
    );

    it("a throwing clock still throws its ORIGINAL error out of the log call, as before", () => {
      // The degraded pass runs the same chain, so a configuration error that
      // throws on every pass is not swallowed; the caller sees the first throw.
      let calls = 0;
      const sink = new PassThrough();
      const chunks: string[] = [];
      sink.on("data", (chunk: Buffer | string) => chunks.push(String(chunk)));
      const logger = createLogger({
        moduleName: `hostile-clock-${format}`,
        format,
        includeConsole: false,
        includeFile: false,
        includeGlobalFile: false,
        captureUncaught: false,
        clock: (): Date => {
          calls += 1;
          throw new Error(`clock failure ${calls}`);
        },
        additionalTransports: [new winston.transports.Stream({ stream: sink, eol: "\n" })],
      });

      expect(() => logger.info("x")).toThrow(new Error("clock failure 1"));
      // The degraded pass was attempted once and failed the same way.
      expect(calls).toBe(2);
      expect(chunks).toEqual([]);
      teardownLogger(logger);
    });
  });

  it("pretty: the console transport degrades like the file when a message Proxy defeats its Error flattening", async () => {
    // The Console re-runs its own format over a copy of the rendered entry. A
    // message whose prototype cannot be read and whose `message` is itself
    // makes the Error-flattening step throw there too, and winston-transport
    // re-throws a transport-format error out of the log call.
    const message = new Proxy(
      { a: 1 },
      {
        getPrototypeOf: refuse("getPrototypeOf"),
        get: (obj, key, receiver) =>
          key === "message" ? receiver : Reflect.get(obj, key, receiver),
      },
    );

    const out = await render("hostile-console", "pretty", (logger) =>
      logger.log("info", { message }),
    );

    expect(out.thrown).toBeUndefined();
    expect(out.fileOut).toBe(
      prettyLine("hostile-console", '{\n  "a": 1\n}\n{\n  "_errorFlattenFailed": true\n}'),
    );
    expectConsoleMatchesFile("pretty", out);
    expect(out.consoleOut).not.toContain("refused");
  });

  it("negative control: an ordinary payload never takes the degraded path", async () => {
    const out = await render("hostile-control", "json", (logger) =>
      logger.info({ message: "hi", user: "bob" }),
    );

    expect(out.fileOut).toBe(
      `{"level":"info","message":"hi","module":"hostile-control","timestamp":"${STAMP}","user":"bob"}\n`,
    );
    expect(out.fileOut).not.toContain("_unserializable");
  });
});

describe("serialize: FORBIDDEN_KEYS, isErrorLike, errorToPlain", () => {
  /** An Error with a deterministic stack (the pins below never depend on this file's line numbers). */
  const fixedError = (
    message: string,
    stack = `Error: ${message}\n    at fixed (fixed.js:1:1)`,
  ) => {
    const err = new Error(message);
    err.stack = stack;
    return err;
  };

  describe("FORBIDDEN_KEYS", () => {
    it("lives in serialize.ts and redact.ts re-exports the SAME deny-list", () => {
      expect(FORBIDDEN_KEYS).toBe(SERIALIZE_FORBIDDEN_KEYS);
      expect([...SERIALIZE_FORBIDDEN_KEYS]).toEqual(["__proto__", "constructor", "prototype"]);
      expect(SERIALIZE_FORBIDDEN_KEYS.has("message")).toBe(false);
    });
  });

  describe("isErrorLike", () => {
    it("is true for a native Error, a built-in subclass, and a user subclass", () => {
      class PaymentError extends Error {}
      expect(isErrorLike(new Error("x"))).toBe(true);
      expect(isErrorLike(new TypeError("x"))).toBe(true);
      expect(isErrorLike(new AggregateError([], "x"))).toBe(true);
      expect(isErrorLike(new PaymentError("x"))).toBe(true);
    });

    it("is true for an Error created in another realm, where instanceof Error is false", () => {
      const foreign = vm.runInNewContext("new Error('x')") as unknown;
      const foreignAggregate = vm.runInNewContext("new AggregateError([], 'agg')") as unknown;

      expect(foreign instanceof Error).toBe(false);
      expect(isErrorLike(foreign)).toBe(true);
      expect(isErrorLike(foreignAggregate)).toBe(true);
    });

    it("is false for a plain object that merely has name / message / stack keys", () => {
      expect(isErrorLike({ name: "Error", message: "x" })).toBe(false);
      expect(isErrorLike({ name: "Error", message: "x", stack: "Error: x" })).toBe(false);
      expect(isErrorLike(Object.assign(Object.create(null), { name: "Error", message: "x" }))).toBe(
        false,
      );
    });

    it("is false for primitives, null, arrays, and non-Error objects", () => {
      for (const value of [undefined, null, "Error", 0, 1n, true, Symbol("e"), [], new Date(0)]) {
        expect(isErrorLike(value)).toBe(false);
      }
      expect(isErrorLike(() => undefined)).toBe(false);
    });

    it("never throws: a value whose prototype or tag cannot be read is not error-like", () => {
      const refusing = new Proxy(
        {},
        {
          getPrototypeOf: () => {
            throw new Error("getPrototypeOf refused");
          },
        },
      );
      class HostileTag {
        get [Symbol.toStringTag](): string {
          throw new Error("tag refused");
        }
      }

      expect(() => isErrorLike(refusing)).not.toThrow();
      expect(isErrorLike(refusing)).toBe(false);
      expect(isErrorLike(new HostileTag())).toBe(false);
    });
  });

  describe("errorToPlain", () => {
    it("a plain Error: name, message, stack, in that order, as a fresh plain object", () => {
      const err = fixedError("boom");
      const plain = errorToPlain(err);

      expect(Object.keys(plain)).toEqual(["name", "message", "stack"]);
      expect(plain).toEqual({
        name: "Error",
        message: "boom",
        stack: "Error: boom\n    at fixed (fixed.js:1:1)",
      });
      expect(Object.getPrototypeOf(plain)).toBe(Object.prototype);
      expect(plain).not.toBe(err);
      expect(plain instanceof Error).toBe(false);
      expect(JSON.stringify(plain)).toBe(
        '{"name":"Error","message":"boom","stack":"Error: boom\\n    at fixed (fixed.js:1:1)"}',
      );
    });

    it("a subclass with an own enumerable code: the standard fields first, then code, name emitted once", () => {
      class CodedError extends Error {
        public code: string;
        constructor(message: string, code: string) {
          super(message);
          this.name = "CodedError"; // own enumerable, must keep the FIRST slot
          this.code = code;
        }
      }
      const err = new CodedError("declined", "E42");
      err.stack = "CodedError: declined\n    at fixed";

      const plain = errorToPlain(err);

      expect(Object.keys(plain)).toEqual(["name", "message", "stack", "code"]);
      expect(plain).toEqual({
        name: "CodedError",
        message: "declined",
        stack: "CodedError: declined\n    at fixed",
        code: "E42",
      });
    });

    it("new Error(msg, { cause }): the non-enumerable own cause comes last, by reference", () => {
      const inner = fixedError("inner");
      const outer = new Error("outer", { cause: inner });
      outer.stack = "Error: outer\n    at fixed";

      const plain = errorToPlain(outer);

      expect(Object.keys(plain)).toEqual(["name", "message", "stack", "cause"]);
      expect(plain.cause).toBe(inner); // not converted: the caller converts nested values
      expect(Object.keys(outer)).toEqual([]); // the input's own enumerable set is untouched
    });

    it("an own cause holding undefined is still an own property and is kept", () => {
      const err = new Error("x", { cause: undefined });

      const plain = errorToPlain(err);

      expect(Object.keys(plain)).toEqual(["name", "message", "stack", "cause"]);
      expect(plain.cause).toBeUndefined();
    });

    it("an AggregateError: errors after the standard fields; with a cause, cause then errors", () => {
      const e1 = fixedError("one");
      const e2 = fixedError("two");
      const agg = new AggregateError([e1, e2], "agg");
      const withCause = new AggregateError([e1], "agg", { cause: "root" });

      const plain = errorToPlain(agg);
      const plainWithCause = errorToPlain(withCause);

      expect(Object.keys(plain)).toEqual(["name", "message", "stack", "errors"]);
      expect(plain.name).toBe("AggregateError");
      expect(plain.message).toBe("agg");
      expect(plain.errors).toEqual([e1, e2]);
      expect((plain.errors as unknown[])[0]).toBe(e1);
      expect(Object.keys(plainWithCause)).toEqual(["name", "message", "stack", "cause", "errors"]);
      expect(plainWithCause.cause).toBe("root");
    });

    it("an enumerable assigned cause / errors keeps its own-key position and is not duplicated", () => {
      const err = fixedError("x") as Error & { cause?: unknown; errors?: unknown; after?: number };
      err.cause = "assigned";
      err.errors = ["field"];
      err.after = 1;

      expect(Object.keys(errorToPlain(err))).toEqual([
        "name",
        "message",
        "stack",
        "cause",
        "errors",
        "after",
      ]);
    });

    it("a cross-realm Error converts like a native one", () => {
      const foreign = vm.runInNewContext(
        "const e = new Error('far', { cause: 'why' }); e.stack = 'Error: far'; e",
      ) as object;

      expect(errorToPlain(foreign)).toEqual({
        name: "Error",
        message: "far",
        stack: "Error: far",
        cause: "why",
      });
    });

    it("a throwing own enumerable getter drops ONLY that field, and is invoked once", () => {
      const err = fixedError("x");
      const getter = jest.fn(() => {
        throw new Error("getter refused");
      });
      Object.defineProperty(err, "detail", { enumerable: true, get: getter });
      Object.defineProperty(err, "code", { enumerable: true, value: "E1" });

      let plain: Record<string, unknown> = {};
      expect(() => {
        plain = errorToPlain(err);
      }).not.toThrow();

      expect(Object.keys(plain)).toEqual(["name", "message", "stack", "code"]);
      expect(plain.code).toBe("E1");
      expect("detail" in plain).toBe(false);
      expect(getter).toHaveBeenCalledTimes(1);
    });

    it("a throwing enumerable cause getter is dropped and never read a second time", () => {
      const err = fixedError("x");
      const getter = jest.fn(() => {
        throw new Error("cause refused");
      });
      Object.defineProperty(err, "cause", { enumerable: true, configurable: true, get: getter });

      const plain = errorToPlain(err);

      expect(Object.keys(plain)).toEqual(["name", "message", "stack"]);
      expect(getter).toHaveBeenCalledTimes(1);
    });

    it("a throwing message accessor drops only message; name and stack survive", () => {
      const err = fixedError("x");
      Object.defineProperty(err, "message", {
        get: () => {
          throw new Error("message refused");
        },
      });

      expect(errorToPlain(err)).toEqual({
        name: "Error",
        stack: "Error: x\n    at fixed (fixed.js:1:1)",
      });
    });

    it("skips own keys named __proto__ / constructor / prototype, so the result's prototype cannot be repointed", () => {
      const err = fixedError("x");
      for (const key of ["__proto__", "constructor", "prototype"]) {
        Object.defineProperty(err, key, {
          value: { polluted: true },
          enumerable: true,
          configurable: true,
          writable: true,
        });
      }
      Object.defineProperty(err, "kept", { value: 1, enumerable: true });

      const plain = errorToPlain(err);

      expect(Object.keys(plain)).toEqual(["name", "message", "stack", "kept"]);
      expect(Object.getPrototypeOf(plain)).toBe(Object.prototype);
      expect((plain as { polluted?: unknown }).polluted).toBeUndefined();
      expect(({} as { polluted?: unknown }).polluted).toBeUndefined();
      expect(Object.prototype.hasOwnProperty.call(plain, "constructor")).toBe(false);
    });

    it("omits an undefined standard field but keeps an own enumerable undefined value; symbols are ignored", () => {
      const bare = Object.create(Error.prototype) as Error; // no own message / stack
      const err = fixedError("x") as Error & { extra?: unknown };
      err.extra = undefined;
      (err as unknown as Record<symbol, unknown>)[Symbol("hidden")] = "s";

      expect(errorToPlain(bare)).toEqual({ name: "Error", message: "" });
      expect(Object.keys(errorToPlain(bare))).toEqual(["name", "message"]);
      expect(Object.keys(errorToPlain(err))).toEqual(["name", "message", "stack", "extra"]);
      expect(Object.getOwnPropertySymbols(errorToPlain(err))).toEqual([]);
    });

    it("never throws for a Proxy whose key listing and descriptor lookups throw", () => {
      const target = fixedError("proxied");
      const refuse = (): never => {
        throw new Error("trap refused");
      };
      const hostile = new Proxy(target, { ownKeys: refuse, getOwnPropertyDescriptor: refuse });

      let plain: Record<string, unknown> = {};
      expect(() => {
        plain = errorToPlain(hostile);
      }).not.toThrow();

      // V8's own `stack` accessor returns undefined for a Proxy receiver, and an
      // undefined standard field is omitted; the rest survives.
      expect(plain).toEqual({ name: "Error", message: "proxied" });
    });

    it("never mutates its input and returns a new object on every call", () => {
      const err = new Error("x", { cause: { code: 1 } }) as Error & { code?: string };
      err.code = "E1";
      const before = Reflect.ownKeys(err).map((key) => [
        key,
        Object.getOwnPropertyDescriptor(err, key),
      ]);

      const first = errorToPlain(err);
      const second = errorToPlain(err);

      expect(first).not.toBe(second);
      expect(first).toEqual(second);
      expect(
        Reflect.ownKeys(err).map((key) => [key, Object.getOwnPropertyDescriptor(err, key)]),
      ).toEqual(before);
    });
  });
});

describe("maskMetaKeys walks nested Errors (own fields, cause chain, AggregateError members)", () => {
  afterEach(() => {
    resetLoggerRegistry();
    jest.restoreAllMocks();
  });

  const STACK = "Error: fixed\n    at fixed (fixed.js:1:1)";
  const STACK_JSON = JSON.stringify(STACK);

  /** An Error with a deterministic stack (design rule 8), optionally carrying own properties. */
  const fixedError = (
    message: string,
    own: Record<string, unknown> = {},
    options?: ErrorOptions,
  ) => {
    const err = Object.assign(new Error(message, options), own);
    err.stack = STACK;
    return err;
  };

  const formats: Format[] = ["pretty", "json"];

  describe.each(formats)("format: %s", (format) => {
    it("an Error with an own masked key keeps its name / message / stack and shows [REDACTED]", async () => {
      const err = fixedError("card declined", { password: "S1-SECRET" });

      const out = await render(
        "nested-err-own",
        format,
        (logger) => logger.info("Payment failed", { err, orderId: 7 }),
        ["password"],
      );

      expect(out.thrown).toBeUndefined();
      expect(out.fileOut).toBe(
        format === "pretty"
          ? prettyLine(
              "nested-err-own",
              [
                "Payment failed",
                "{",
                '  "err": {',
                '    "name": "Error",',
                '    "message": "card declined",',
                `    "stack": ${STACK_JSON},`,
                '    "password": "[REDACTED]"',
                "  },",
                '  "orderId": 7',
                "}",
              ].join("\n"),
            )
          : `{"err":{"message":"card declined","name":"Error","password":"[REDACTED]","stack":${STACK_JSON}},` +
              `"level":"info","message":"Payment failed","module":"nested-err-own","orderId":7,"timestamp":"${STAMP}"}\n`,
      );
      expectConsoleMatchesFile(format, out);
      expect(out.fileOut).not.toContain("S1-SECRET");
      expect(out.consoleOut).not.toContain("S1-SECRET");
      // The caller's Error is never rewritten.
      expect(err.password).toBe("S1-SECRET");
      expect(err.message).toBe("card declined");
      expect(Object.keys(err)).toEqual(["password"]);
    });

    it("a masked key inside a non-enumerable cause is redacted, never written in cleartext", async () => {
      const cause = { user: "bob", password: "S2-SECRET" };
      const err = fixedError("outer", {}, { cause });

      const out = await render(
        "nested-err-cause",
        format,
        (logger) => logger.info("Charge failed", { err }),
        ["password"],
      );

      expect(out.thrown).toBeUndefined();
      expect(out.fileOut).toBe(
        format === "pretty"
          ? prettyLine(
              "nested-err-cause",
              [
                "Charge failed",
                "{",
                '  "err": {',
                '    "name": "Error",',
                '    "message": "outer",',
                `    "stack": ${STACK_JSON},`,
                '    "cause": {',
                '      "user": "bob",',
                '      "password": "[REDACTED]"',
                "    }",
                "  }",
                "}",
              ].join("\n"),
            )
          : `{"err":{"cause":{"password":"[REDACTED]","user":"bob"},"message":"outer","name":"Error","stack":${STACK_JSON}},` +
              `"level":"info","message":"Charge failed","module":"nested-err-cause","timestamp":"${STAMP}"}\n`,
      );
      expectConsoleMatchesFile(format, out);
      expect(out.fileOut).not.toContain("S2-SECRET");
      expect(cause.password).toBe("S2-SECRET");
      expect(err.cause).toBe(cause);
    });

    it("an Error with only primitive fields and nothing to mask renders exactly as it does without a mask", async () => {
      const make = () => fixedError("plain failure", { code: "E1" }, { cause: "upstream" });

      const masked = await render(
        "nested-err-parity",
        format,
        (logger) => logger.info("m", { err: make(), orderId: 7 }),
        ["password"],
      );
      const unmasked = await render("nested-err-parity", format, (logger) =>
        logger.info("m", { err: make(), orderId: 7 }),
      );

      expect(masked.thrown).toBeUndefined();
      expect(masked.fileOut).toBe(unmasked.fileOut);
      expect(masked.consoleOut).toBe(unmasked.consoleOut);
      expect(masked.fileOut).not.toContain("[REDACTED]");
      expect(masked.fileOut).toContain(format === "json" ? '"orderId":7' : '"orderId": 7');
    });

    it("a throwing getter inside a walked cause fails closed for that field; the rest of the line still renders", async () => {
      const cause = {
        get token(): string {
          throw new Error("getter refused");
        },
      };
      const err = fixedError("x", {}, { cause });

      const out = await render(
        "nested-err-throw",
        format,
        (logger) => logger.info("m", { err, orderId: 7 }),
        ["password"],
      );

      expect(out.thrown).toBeUndefined();
      expect(out.fileOut).toBe(
        format === "pretty"
          ? prettyLine(
              "nested-err-throw",
              [
                "m",
                "{",
                '  "err": {',
                '    "name": "Error",',
                '    "message": "x",',
                `    "stack": ${STACK_JSON},`,
                '    "cause": "[RedactionFailed]"',
                "  },",
                '  "orderId": 7',
                "}",
              ].join("\n"),
            )
          : `{"err":{"cause":"[RedactionFailed]","message":"x","name":"Error","stack":${STACK_JSON}},` +
              `"level":"info","message":"m","module":"nested-err-throw","orderId":7,"timestamp":"${STAMP}"}\n`,
      );
      expectConsoleMatchesFile(format, out);
      expect(out.fileOut).not.toContain("_redactionFailed");
    });

    it("AggregateError members are masked and keep their own message", async () => {
      const member = fixedError("member failed", { password: "S3-SECRET" });
      const agg = new AggregateError([member], "all failed");
      agg.stack = STACK;

      const out = await render(
        "nested-err-agg",
        format,
        (logger) => logger.info("Batch failed", { err: agg }),
        ["password"],
      );

      expect(out.thrown).toBeUndefined();
      expect(out.fileOut).toBe(
        format === "pretty"
          ? prettyLine(
              "nested-err-agg",
              [
                "Batch failed",
                "{",
                '  "err": {',
                '    "name": "AggregateError",',
                '    "message": "all failed",',
                `    "stack": ${STACK_JSON},`,
                '    "errors": [',
                "      {",
                '        "name": "Error",',
                '        "message": "member failed",',
                `        "stack": ${STACK_JSON},`,
                '        "password": "[REDACTED]"',
                "      }",
                "    ]",
                "  }",
                "}",
              ].join("\n"),
            )
          : `{"err":{"errors":[{"message":"member failed","name":"Error","password":"[REDACTED]","stack":${STACK_JSON}}],` +
              `"message":"all failed","name":"AggregateError","stack":${STACK_JSON}},` +
              `"level":"info","message":"Batch failed","module":"nested-err-agg","timestamp":"${STAMP}"}\n`,
      );
      expectConsoleMatchesFile(format, out);
      expect(out.fileOut).not.toContain("S3-SECRET");
      expect(out.consoleOut).not.toContain("S3-SECRET");
      expect(member.password).toBe("S3-SECRET");
    });
  });
});

describe("nested Error serialization", () => {
  afterEach(() => {
    resetLoggerRegistry();
    jest.restoreAllMocks();
  });

  const STACK = "Error: fixed\n    at fixed (fixed.js:1:1)";
  const STACK_JSON = JSON.stringify(STACK);

  /** An Error with a deterministic stack (design rule 8), optionally carrying own properties. */
  const fixedError = (
    message: string,
    own: Record<string, unknown> = {},
    options?: ErrorOptions,
  ) => {
    const err = Object.assign(new Error(message, options), own);
    err.stack = STACK;
    return err;
  };

  /** A self-referencing cause in the ES2022 options shape: own, NON-enumerable. */
  const selfCausedError = (message: string): Error => {
    const err = fixedError(message);
    Object.defineProperty(err, "cause", { value: err, writable: true, configurable: true });
    return err;
  };

  /** Parses the metadata block of a pretty line whose message is one line. */
  const prettyMeta = (fileOut: string): unknown =>
    JSON.parse(fileOut.split("\n").slice(3).join("\n"));

  /** The metadata of a json line (every field but the logger's own). */
  const jsonMeta = (fileOut: string): Record<string, unknown> => {
    const {
      level: _level,
      message: _message,
      module: _module,
      timestamp: _timestamp,
      ...meta
    } = JSON.parse(fileOut) as Record<string, unknown>;
    return meta;
  };

  const metaOf = (format: Format, fileOut: string): unknown =>
    format === "pretty" ? prettyMeta(fileOut) : jsonMeta(fileOut);

  const formats: Format[] = ["pretty", "json"];

  describe.each(formats)("format: %s", (format) => {
    it("a nested Error renders its name, message, and stack instead of {}", async () => {
      const err = fixedError("card declined");

      const out = await render("nested-ser-basic", format, (logger) =>
        logger.info("Payment failed", { err, orderId: 7 }),
      );

      expect(out.thrown).toBeUndefined();
      expect(out.fileOut).toBe(
        format === "pretty"
          ? prettyLine(
              "nested-ser-basic",
              [
                "Payment failed",
                "{",
                '  "err": {',
                '    "name": "Error",',
                '    "message": "card declined",',
                `    "stack": ${STACK_JSON}`,
                "  },",
                '  "orderId": 7',
                "}",
              ].join("\n"),
            )
          : `{"err":{"message":"card declined","name":"Error","stack":${STACK_JSON}},` +
              `"level":"info","message":"Payment failed","module":"nested-ser-basic","orderId":7,"timestamp":"${STAMP}"}\n`,
      );
      expect(out.fileOut).not.toContain(format === "pretty" ? '"err": {}' : '"err":{}');
      expectConsoleMatchesFile(format, out);
      // The caller's Error is never rewritten.
      expect(Object.keys(err)).toEqual([]);
      expect(err.message).toBe("card declined");
      expect(err.stack).toBe(STACK);
    });

    it("renders the cause chain of new Error(msg, { cause })", async () => {
      const inner = fixedError("inner");
      const outer = fixedError("outer", {}, { cause: inner });

      const out = await render("nested-ser-cause", format, (logger) =>
        logger.info("m", { err: outer }),
      );

      expect(out.thrown).toBeUndefined();
      expect(out.fileOut).toBe(
        format === "pretty"
          ? prettyLine(
              "nested-ser-cause",
              [
                "m",
                "{",
                '  "err": {',
                '    "name": "Error",',
                '    "message": "outer",',
                `    "stack": ${STACK_JSON},`,
                '    "cause": {',
                '      "name": "Error",',
                '      "message": "inner",',
                `      "stack": ${STACK_JSON}`,
                "    }",
                "  }",
                "}",
              ].join("\n"),
            )
          : `{"err":{"cause":{"message":"inner","name":"Error","stack":${STACK_JSON}},"message":"outer",` +
              `"name":"Error","stack":${STACK_JSON}},"level":"info","message":"m","module":"nested-ser-cause",` +
              `"timestamp":"${STAMP}"}\n`,
      );
      expectConsoleMatchesFile(format, out);
      expect(outer.cause).toBe(inner);
    });

    it("a subclass with an own enumerable code renders code plus the standard fields", async () => {
      class PaymentError extends Error {
        constructor(message: string) {
          super(message);
          this.name = "PaymentError";
          Object.assign(this, { code: "E_CARD" });
        }
      }
      const err = new PaymentError("declined");
      err.stack = STACK;

      const out = await render("nested-ser-subclass", format, (logger) =>
        logger.info("m", { err }),
      );

      expect(out.thrown).toBeUndefined();
      expect(out.fileOut).toBe(
        format === "pretty"
          ? prettyLine(
              "nested-ser-subclass",
              [
                "m",
                "{",
                '  "err": {',
                '    "name": "PaymentError",',
                '    "message": "declined",',
                `    "stack": ${STACK_JSON},`,
                '    "code": "E_CARD"',
                "  }",
                "}",
              ].join("\n"),
            )
          : `{"err":{"code":"E_CARD","message":"declined","name":"PaymentError","stack":${STACK_JSON}},` +
              `"level":"info","message":"m","module":"nested-ser-subclass","timestamp":"${STAMP}"}\n`,
      );
      expectConsoleMatchesFile(format, out);
    });

    it("an AggregateError renders its errors", async () => {
      const agg = new AggregateError([fixedError("first"), fixedError("second")], "agg");
      agg.stack = STACK;

      const out = await render("nested-ser-agg", format, (logger) =>
        logger.info("m", { err: agg }),
      );

      expect(out.thrown).toBeUndefined();
      const member = (message: string) => ({ name: "Error", message, stack: STACK });
      expect(metaOf(format, out.fileOut)).toEqual({
        err: {
          name: "AggregateError",
          message: "agg",
          stack: STACK,
          errors: [member("first"), member("second")],
        },
      });
      if (format === "json") {
        expect(out.fileOut).toBe(
          `{"err":{"errors":[{"message":"first","name":"Error","stack":${STACK_JSON}},` +
            `{"message":"second","name":"Error","stack":${STACK_JSON}}],"message":"agg",` +
            `"name":"AggregateError","stack":${STACK_JSON}},"level":"info","message":"m",` +
            `"module":"nested-ser-agg","timestamp":"${STAMP}"}\n`,
        );
      }
      expectConsoleMatchesFile(format, out);
    });

    it("a cross-realm Error (vm context) renders its fields", async () => {
      const foreign = vm.runInNewContext('new Error("foreign failure")') as Error;
      foreign.stack = STACK;
      expect(foreign instanceof Error).toBe(false);

      const out = await render("nested-ser-realm", format, (logger) =>
        logger.info("m", { err: foreign }),
      );

      expect(out.thrown).toBeUndefined();
      expect(metaOf(format, out.fileOut)).toEqual({
        err: { name: "Error", message: "foreign failure", stack: STACK },
      });
      expectConsoleMatchesFile(format, out);
    });

    it("with maskMetaKeys, a password in a cause Error or an AggregateError member's cause never appears", async () => {
      const inner = fixedError("inner", { password: "S1-SECRET" });
      const outer = fixedError("outer", {}, { cause: inner });
      const member = fixedError("member", {}, { cause: { user: "bob", password: "S2-SECRET" } });
      const agg = new AggregateError([member], "agg");
      agg.stack = STACK;

      const out = await render(
        "nested-ser-mask",
        format,
        (logger) => logger.info("m", { err: outer, batch: agg }),
        ["password"],
      );

      expect(out.thrown).toBeUndefined();
      for (const text of [out.fileOut, out.consoleOut]) {
        expect(text).not.toContain("S1-SECRET");
        expect(text).not.toContain("S2-SECRET");
      }
      expect(metaOf(format, out.fileOut)).toEqual({
        err: {
          name: "Error",
          message: "outer",
          stack: STACK,
          cause: { name: "Error", message: "inner", stack: STACK, password: "[REDACTED]" },
        },
        batch: {
          name: "AggregateError",
          message: "agg",
          stack: STACK,
          errors: [
            {
              name: "Error",
              message: "member",
              stack: STACK,
              cause: { user: "bob", password: "[REDACTED]" },
            },
          ],
        },
      });
      expectConsoleMatchesFile(format, out);
      // The caller's graph keeps its secrets.
      expect(inner.password).toBe("S1-SECRET");
      expect((member.cause as { password: string }).password).toBe("S2-SECRET");
    });

    it("an Error graph with nothing to mask renders identically with and without maskMetaKeys", async () => {
      const make = () => ({
        chained: fixedError("outer", {}, { cause: fixedError("inner") }),
        objectCause: fixedError("x", {}, { cause: { code: 1 } }),
        batch: Object.assign(new AggregateError([fixedError("m1")], "agg"), { stack: STACK }),
        orderId: 7,
      });

      const masked = await render(
        "nested-ser-parity",
        format,
        (logger) => logger.info("m", make()),
        ["password"],
      );
      const unmasked = await render("nested-ser-parity", format, (logger) =>
        logger.info("m", make()),
      );

      expect(masked.thrown).toBeUndefined();
      expect(unmasked.thrown).toBeUndefined();
      expect(unmasked.fileOut).toBe(masked.fileOut);
      expect(unmasked.consoleOut).toBe(masked.consoleOut);
      expect(unmasked.fileOut).not.toContain("[REDACTED]");
      expect(metaOf(format, unmasked.fileOut)).toEqual({
        chained: {
          name: "Error",
          message: "outer",
          stack: STACK,
          cause: { name: "Error", message: "inner", stack: STACK },
        },
        objectCause: { name: "Error", message: "x", stack: STACK, cause: { code: 1 } },
        batch: {
          name: "AggregateError",
          message: "agg",
          stack: STACK,
          errors: [{ name: "Error", message: "m1", stack: STACK }],
        },
        orderId: 7,
      });
    });

    it("a NON-enumerable self-referencing cause terminates and is no worse than today", async () => {
      const err = selfCausedError("loop");

      const out = await render("nested-ser-selfcause", format, (logger) =>
        logger.info("m", { err, orderId: 7 }),
      );

      expect(out.thrown).toBeUndefined();
      expect(out.fileOut).toBe(
        format === "pretty"
          ? // The error-aware pass meets the cycle; the retry reproduces the
            // pre-fix rendering, siblings included, instead of a sentinel.
            prettyLine(
              "nested-ser-selfcause",
              ["m", "{", '  "err": {},', '  "orderId": 7', "}"].join("\n"),
            )
          : `{"err":{"cause":"[Circular]","message":"loop","name":"Error","stack":${STACK_JSON}},` +
              `"level":"info","message":"m","module":"nested-ser-selfcause","orderId":7,"timestamp":"${STAMP}"}\n`,
      );
      expect(out.fileOut).not.toContain("[UNSERIALIZABLE]");
      expect(out.fileOut).not.toContain("_unserializable");
      expectConsoleMatchesFile(format, out);
      expect(err.cause).toBe(err);
    });

    it("a NON-enumerable self-referencing cause makes pretty mode fall back for the whole block, a sibling Error included", async () => {
      // The pretty retry re-renders the whole metadata block the pre-fix way,
      // so every Error in it renders `{}`, not only the self-referencing one.
      // JSON mode keeps rendering the sibling's fields.
      const err = selfCausedError("loop");
      const other = fixedError("card declined");

      const out = await render("nested-ser-selfcause-sibling", format, (logger) =>
        logger.info("m", { err, other, orderId: 7 }),
      );

      expect(out.thrown).toBeUndefined();
      expect(out.fileOut).toBe(
        format === "pretty"
          ? prettyLine(
              "nested-ser-selfcause-sibling",
              ["m", "{", '  "err": {},', '  "other": {},', '  "orderId": 7', "}"].join("\n"),
            )
          : `{"err":{"cause":"[Circular]","message":"loop","name":"Error","stack":${STACK_JSON}},` +
              `"level":"info","message":"m","module":"nested-ser-selfcause-sibling","orderId":7,` +
              `"other":{"message":"card declined","name":"Error","stack":${STACK_JSON}},"timestamp":"${STAMP}"}\n`,
      );
      expect(out.fileOut).not.toContain("[UNSERIALIZABLE]");
      expect(out.fileOut).not.toContain("_unserializable");
      expectConsoleMatchesFile(format, out);
      expect(err.cause).toBe(err);
      expect(Object.keys(other)).toEqual([]);
    });

    it("a top-level logged Error omits a cause set through the options bag (winston's errors() copies own enumerable fields)", async () => {
      // The README states this boundary: only an Error nested in metadata is
      // rendered through the shared view. A top-level Error is flattened by
      // winston's errors(), which never reads the non-enumerable `cause`.
      const err = fixedError("outer", {}, { cause: fixedError("inner") });

      const out = await render("nested-ser-top-cause", format, (logger) => logger.info(err));

      expect(out.thrown).toBeUndefined();
      expect(out.fileOut).toBe(
        format === "pretty"
          ? prettyLine("nested-ser-top-cause", `outer\n${STACK}`)
          : `{"level":"info","message":"outer","module":"nested-ser-top-cause","stack":${STACK_JSON},"timestamp":"${STAMP}"}\n`,
      );
      expect(out.fileOut).not.toContain("inner");
      expectConsoleMatchesFile(format, out);
    });

    it("a top-level logged Error renders a cause assigned afterwards (an own enumerable field) as metadata", async () => {
      const err = fixedError("outer");
      (err as Error & { cause?: unknown }).cause = fixedError("inner");

      const out = await render("nested-ser-top-enum-cause", format, (logger) => logger.info(err));

      const cause = { name: "Error", message: "inner", stack: STACK };
      expect(out.thrown).toBeUndefined();
      expect(out.fileOut).toBe(
        format === "pretty"
          ? prettyLine(
              "nested-ser-top-enum-cause",
              `outer\n${STACK}\n${JSON.stringify({ cause }, null, 2)}`,
            )
          : `{"cause":{"message":"inner","name":"Error","stack":${STACK_JSON}},"level":"info","message":"outer",` +
              `"module":"nested-ser-top-enum-cause","stack":${STACK_JSON},"timestamp":"${STAMP}"}\n`,
      );
      expectConsoleMatchesFile(format, out);
      // Only winston-core's own `level` write lands on the logged Error.
      expect(Object.keys(err)).toEqual(["cause", "level"]);
    });

    it("with maskMetaKeys, a NON-enumerable self-referencing cause renders the error's fields and [Circular]", async () => {
      // The mask walk reads the cause through the shared view and meets the
      // error on its own active path, so both formats print the fields with a
      // "[Circular]" back-reference (the README states this) instead of the
      // no-mask pretty fallback `"err": {}`.
      const err = selfCausedError("loop");

      const out = await render(
        "nested-ser-selfcause-mask",
        format,
        (logger) => logger.info("m", { err, orderId: 7 }),
        ["password"],
      );

      const meta = {
        err: { name: "Error", message: "loop", stack: STACK, cause: "[Circular]" },
        orderId: 7,
      };
      expect(out.thrown).toBeUndefined();
      expect(out.fileOut).toBe(
        format === "pretty"
          ? prettyLine("nested-ser-selfcause-mask", `m\n${JSON.stringify(meta, null, 2)}`)
          : `{"err":{"cause":"[Circular]","message":"loop","name":"Error","stack":${STACK_JSON}},` +
              `"level":"info","message":"m","module":"nested-ser-selfcause-mask","orderId":7,"timestamp":"${STAMP}"}\n`,
      );
      expect(out.fileOut).not.toContain('"err": {}');
      expect(out.fileOut).not.toContain("[UNSERIALIZABLE]");
      expectConsoleMatchesFile(format, out);
      expect(err.cause).toBe(err);
      expect(Object.keys(err)).toEqual([]);
    });

    it("an own enumerable cycle (err.self = err) keeps the pretty sentinel and renders [Circular] in json", async () => {
      const err = fixedError("self");
      (err as unknown as { self: unknown }).self = err;

      const out = await render("nested-ser-selfenum", format, (logger) =>
        logger.info("m", { err, orderId: 7 }),
      );

      expect(out.thrown).toBeUndefined();
      expect(out.fileOut).toBe(
        format === "pretty"
          ? prettyLine("nested-ser-selfenum", "m\n[UNSERIALIZABLE]")
          : `{"err":{"message":"self","name":"Error","self":"[Circular]","stack":${STACK_JSON}},` +
              `"level":"info","message":"m","module":"nested-ser-selfenum","orderId":7,"timestamp":"${STAMP}"}\n`,
      );
      expectConsoleMatchesFile(format, out);
    });

    it("an ENUMERABLE self-cause (err.cause = err, no cause option) behaves like err.self = err", async () => {
      // Assigned after construction on an error created without the option,
      // `cause` is an own enumerable key, so the retry is still cyclic (the
      // README states this next to the non-enumerable options-bag shape).
      const err = fixedError("loop");
      (err as Error & { cause?: unknown }).cause = err;
      expect(Object.getOwnPropertyDescriptor(err, "cause")?.enumerable).toBe(true);

      const out = await render("nested-ser-selfenum-cause", format, (logger) =>
        logger.info("m", { err, orderId: 7 }),
      );

      expect(out.thrown).toBeUndefined();
      expect(out.fileOut).toBe(
        format === "pretty"
          ? prettyLine("nested-ser-selfenum-cause", "m\n[UNSERIALIZABLE]")
          : `{"err":{"cause":"[Circular]","message":"loop","name":"Error","stack":${STACK_JSON}},` +
              `"level":"info","message":"m","module":"nested-ser-selfenum-cause","orderId":7,"timestamp":"${STAMP}"}\n`,
      );
      expect(out.fileOut).not.toContain('"err": {}');
      expectConsoleMatchesFile(format, out);
    });

    it("a throwing getter inside a nested cause still renders the rest of the line (retry), not the stub", async () => {
      let reads = 0;
      const cause = {
        get token(): string {
          reads += 1;
          throw new Error("getter refused");
        },
      };
      const err = fixedError("outer", {}, { cause });

      const out = await render("nested-ser-throw", format, (logger) =>
        logger.info("m", { err, orderId: 7 }),
      );

      expect(out.thrown).toBeUndefined();
      expect(out.fileOut).toBe(
        format === "pretty"
          ? prettyLine(
              "nested-ser-throw",
              ["m", "{", '  "err": {},', '  "orderId": 7', "}"].join("\n"),
            )
          : `{"err":{},"level":"info","message":"m","module":"nested-ser-throw","orderId":7,"timestamp":"${STAMP}"}\n`,
      );
      expect(out.fileOut).not.toContain("_unserializable");
      expect(out.fileOut).not.toContain("[UNSERIALIZABLE]");
      expectConsoleMatchesFile(format, out);
      // The getter runs once per chain in the error-aware pass (json: the file
      // chain only, its Console is formatless; pretty: the file chain and the
      // Console's own chain), never in the retry, which cannot see the cause.
      expect(reads).toBe(format === "json" ? 1 : 2);
    });

    it("an Error subclass defining toJSON renders its toJSON output, also as a cause", async () => {
      class Described extends Error {
        toJSON() {
          return { kind: "described", text: this.message };
        }
      }
      const described = new Described("dd");
      described.stack = STACK;
      const outer = fixedError("outer", {}, { cause: described });

      const out = await render("nested-ser-tojson", format, (logger) =>
        logger.info("m", { err: described, wrapped: outer }),
      );

      expect(out.thrown).toBeUndefined();
      expect(metaOf(format, out.fileOut)).toEqual({
        err: { kind: "described", text: "dd" },
        wrapped: {
          name: "Error",
          message: "outer",
          stack: STACK,
          cause: { kind: "described", text: "dd" },
        },
      });
      expectConsoleMatchesFile(format, out);
    });

    it("with maskMetaKeys, a toJSON value inside a cause, and an Error inside a toJSON output, are masked", async () => {
      // Both printed their masked keys once nested Errors rendered their
      // `cause` (the walk skipped a value that defines toJSON, the serializer
      // expanded it), where the line before showed `{}`. The walk now resolves
      // a nested toJSON the way the serializer does and masks its output.
      class ClientError extends Error {
        toJSON() {
          return { kind: "client", password: "S-TOJSON" };
        }
      }
      const client = new ClientError("upstream");
      const wrapped = fixedError("wrap", {}, { cause: client });
      const inner = fixedError("inner", {}, { cause: { password: "S-INNER" } });
      const dto = { toJSON: () => ({ err: inner }) };

      const out = await render(
        "nested-ser-boundary",
        format,
        (logger) => logger.info("m", { wrapped, dto, password: "S-TOP" }),
        ["password"],
      );

      expect(out.thrown).toBeUndefined();
      expect(metaOf(format, out.fileOut)).toEqual({
        wrapped: {
          name: "Error",
          message: "wrap",
          stack: STACK,
          cause: { kind: "client", password: "[REDACTED]" },
        },
        dto: {
          err: { name: "Error", message: "inner", stack: STACK, cause: { password: "[REDACTED]" } },
        },
        password: "[REDACTED]",
      });
      for (const text of [out.fileOut, out.consoleOut]) {
        expect(text).not.toMatch(/S-TOP|S-TOJSON|S-INNER/);
      }
      expectConsoleMatchesFile(format, out);
    });

    it("metadata without Errors (BigInt, Buffer, Date, nested objects) renders byte-identically", async () => {
      const out = await render("nested-ser-free", format, (logger) =>
        logger.info("m", {
          n: 5n,
          buf: Buffer.from("hi"),
          d: new Date(0),
          nested: { a: [1, { b: 2 }] },
        }),
      );

      expect(out.thrown).toBeUndefined();
      expect(out.fileOut).toBe(
        format === "pretty"
          ? prettyLine(
              "nested-ser-free",
              [
                "m",
                "{",
                '  "n": "5",',
                '  "buf": {',
                '    "type": "Buffer",',
                '    "data": [',
                "      104,",
                "      105",
                "    ]",
                "  },",
                '  "d": "1970-01-01T00:00:00.000Z",',
                '  "nested": {',
                '    "a": [',
                "      1,",
                "      {",
                '        "b": 2',
                "      }",
                "    ]",
                "  }",
                "}",
              ].join("\n"),
            )
          : `{"buf":{"data":[104,105],"type":"Buffer"},"d":"1970-01-01T00:00:00.000Z","level":"info",` +
              `"message":"m","module":"nested-ser-free","n":"5","nested":{"a":[1,{"b":2}]},"timestamp":"${STAMP}"}\n`,
      );
      expectConsoleMatchesFile(format, out);
    });
  });

  describe.each(formats)("crash record, format: %s", (format) => {
    beforeEach(() => {
      __crashCaptureInternals.setExitFn(jest.fn());
    });

    afterEach(() => {
      __crashCaptureInternals.restoreExitFn();
    });

    it("the crash record's error field renders name, message, and stack instead of {}", async () => {
      const sink = new PassThrough();
      const chunks: string[] = [];
      sink.on("data", (chunk: Buffer | string) => chunks.push(String(chunk)));
      const logger = createLogger({
        moduleName: "nested-ser-crash",
        format,
        includeConsole: false,
        includeFile: false,
        includeGlobalFile: false,
        captureUncaught: true,
        exitOnUncaught: false,
        clock: () => FIXED_NOW,
        additionalTransports: [new winston.transports.Stream({ stream: sink, eol: "\n" })],
      });
      const err = fixedError("boom-crash");

      __crashCaptureInternals.invokeUncaught(err);
      await new Promise((resolve) => setImmediate(resolve));
      await shutdownLogger(logger);
      const fileOut = chunks.join("");

      if (format === "json") {
        const parsed = JSON.parse(fileOut) as Record<string, unknown>;
        expect(parsed.crash).toBe("uncaughtException");
        expect(parsed.error).toEqual({ name: "Error", message: "boom-crash", stack: STACK });
        expect(fileOut).toContain(
          `"error":{"message":"boom-crash","name":"Error","stack":${STACK_JSON}}`,
        );
        expect(fileOut).not.toContain('"error":{}');
      } else {
        expect(fileOut).toContain(
          [
            '  "error": {',
            '    "name": "Error",',
            '    "message": "boom-crash",',
            `    "stack": ${STACK_JSON}`,
            "  },",
          ].join("\n"),
        );
        expect(fileOut).toContain('"crash": "uncaughtException"');
        expect(fileOut).not.toContain('"error": {}');
      }
      expect(Object.keys(err)).toEqual([]);
    });
  });
});

describe("serialize: createErrorAwareReplacer, errorAwareStringify", () => {
  const STACK = "Error: fixed\n    at fixed (fixed.js:1:1)";

  const fixedError = (message: string, options?: ErrorOptions): Error => {
    const err = new Error(message, options);
    err.stack = STACK;
    return err;
  };

  const selfCausedError = (message: string): Error => {
    const err = fixedError(message);
    Object.defineProperty(err, "cause", { value: err, writable: true, configurable: true });
    return err;
  };

  describe("createErrorAwareReplacer", () => {
    it("maps an Error to its errorToPlain view, the SAME view on every visit of one replacer", () => {
      const err = fixedError("boom");
      const replacer = createErrorAwareReplacer();

      const first = replacer("err", err);
      const second = replacer("again", err);

      expect(first).toEqual({ name: "Error", message: "boom", stack: STACK });
      expect(first).toEqual(errorToPlain(err));
      expect(second).toBe(first);
      expect(first).not.toBe(err);
      // A fresh replacer has its own memo: an equal view, never the same object.
      const fresh = createErrorAwareReplacer()("err", err);
      expect(fresh).toEqual(first);
      expect(fresh).not.toBe(first);
      // The caller's Error is untouched.
      expect(Object.keys(err)).toEqual([]);
    });

    it("hands every non-Error value to bigintSafeReplacer unchanged", () => {
      const replacer = createErrorAwareReplacer();
      const plain = { a: 1 };
      const list = [1, 2];
      const date = new Date(0);
      const lookAlike = { name: "Error", message: "not an error" };

      expect(replacer("n", 123n)).toBe("123");
      expect(replacer("n", 123n)).toBe(bigintSafeReplacer("n", 123n));
      expect(replacer("o", plain)).toBe(plain);
      expect(replacer("l", list)).toBe(list);
      expect(replacer("d", date)).toBe(date);
      expect(replacer("e", lookAlike)).toBe(lookAlike);
      for (const primitive of ["s", 0, -1.5, true, null, undefined]) {
        expect(replacer("p", primitive)).toBe(primitive);
      }
    });

    it("converts a cross-realm Error and leaves a hostile Proxy as is without throwing", () => {
      const replacer = createErrorAwareReplacer();
      const foreign = vm.runInNewContext('new RangeError("far")') as Error;
      foreign.stack = STACK;
      const hostile = new Proxy(
        {},
        {
          getPrototypeOf() {
            throw new Error("trap refused");
          },
        },
      );

      expect(replacer("f", foreign)).toEqual({ name: "RangeError", message: "far", stack: STACK });
      expect(replacer("h", hostile)).toBe(hostile);
    });

    it("keeps the serializer's own cycle detection: a self-referencing cause throws the circular TypeError", () => {
      const err = selfCausedError("loop");
      let thrown: unknown;

      try {
        JSON.stringify({ err }, createErrorAwareReplacer());
      } catch (caught) {
        thrown = caught;
      }

      // Without the memo every visit would build a new view, so the walk would
      // only stop at the stack limit (whose RangeError the total guards absorb),
      // emitting thousands of nested copies instead of meeting the same view.
      expect(thrown).toBeInstanceOf(TypeError);
      expect((thrown as Error).message).toMatch(/circular/i);
    });

    it("renders one Error shared by two siblings in full at both places (not a cycle)", () => {
      const err = fixedError("shared");

      const out = JSON.parse(JSON.stringify({ a: err, b: [err] }, createErrorAwareReplacer()));

      const view = { name: "Error", message: "shared", stack: STACK };
      expect(out).toEqual({ a: view, b: [view] });
    });
  });

  describe("errorAwareStringify", () => {
    it("renders nested Errors, cause chains included, with the requested indentation", () => {
      const value = { err: fixedError("outer", { cause: fixedError("inner") }), n: 1n };

      expect(errorAwareStringify(value, 2)).toBe(
        JSON.stringify(
          {
            err: {
              name: "Error",
              message: "outer",
              stack: STACK,
              cause: { name: "Error", message: "inner", stack: STACK },
            },
            n: "1",
          },
          null,
          2,
        ),
      );
    });

    it("is byte-identical to the BigInt-only replacer for Error-free values (property)", () => {
      fc.assert(
        fc.property(
          fc.anything({
            withBigInt: true,
            withDate: true,
            withTypedArray: true,
            withBoxedValues: true,
            withMap: true,
            withSet: true,
            withNullPrototype: true,
            withSparseArray: true,
          }),
          fc.constantFrom(undefined, 0, 2),
          (value, space) => {
            expect(errorAwareStringify(value, space)).toBe(
              JSON.stringify(value, bigintSafeReplacer, space),
            );
          },
        ),
        { numRuns: 300, seed: 20260925 },
      );
    });

    it("retries with the BigInt-only replacer when the Error-aware pass throws", () => {
      const value = { err: selfCausedError("loop"), n: 2n };

      const out = errorAwareStringify(value);

      expect(out).toBe('{"err":{},"n":"2"}');
      expect(out).toBe(JSON.stringify(value, bigintSafeReplacer));
    });

    it("lets the retry's own throw propagate, so each caller keeps its last resort", () => {
      const selfRef = fixedError("self");
      (selfRef as unknown as { self: unknown }).self = selfRef;
      const refusing = {
        toJSON() {
          throw new Error("toJSON refused");
        },
      };

      expect(() => errorAwareStringify({ err: selfRef })).toThrow(TypeError);
      expect(() => errorAwareStringify(refusing)).toThrow("toJSON refused");
    });

    it("returns undefined for a value JSON cannot express, without a retry", () => {
      let calls = 0;
      const absent = {
        toJSON() {
          calls += 1;
          return undefined;
        },
      };

      expect(errorAwareStringify(absent)).toBeUndefined();
      expect(calls).toBe(1);
      expect(errorAwareStringify(() => 1)).toBeUndefined();
    });
  });
});

describe("module and global files on the same path", () => {
  afterEach(() => {
    resetLoggerRegistry();
    __crashCaptureInternals.restoreExitFn();
    jest.restoreAllMocks();
  });

  /** Every `.log` file in `dir` whose name starts with `${prefix}-`, concatenated. */
  const readLogFiles = (dir: string, prefix: string): string =>
    fs
      .readdirSync(dir)
      .filter((name) => name.startsWith(`${prefix}-`) && name.endsWith(".log"))
      .map((name) => fs.readFileSync(path.join(dir, name), "utf8"))
      .join("");

  const logFileNames = (dir: string): string[] =>
    fs.readdirSync(dir).filter((name) => name.endsWith(".log"));

  /**
   * The distinct file families (`<name>` of `<name>-<date>[.N].log`) in `dir`.
   * Counting families rather than files keeps a run that crosses local midnight,
   * where a rotator opens the next day's file, from changing the result.
   */
  const logFileFamilies = (dir: string): string[] =>
    [
      ...new Set(
        logFileNames(dir).map((name) => name.replace(/-\d{4}-\d{2}-\d{2}(\.\d+)?\.log$/, "")),
      ),
    ].sort();

  const auditFiles = (dir: string): string[] =>
    fs.readdirSync(dir).filter((name) => /^\..+-audit\.json$/.test(name));

  const occurrences = (text: string, marker: string): number => text.split(marker).length - 1;

  /** The exact file-name pattern `createLogger` hands to the rotator for `name`. */
  const rotatedPath = (dir: string, name: string): string =>
    path.join(fs.realpathSync.native(dir), `${name}-%DATE%.log`);

  describe("one logger whose module file is its global file (deduplicated)", () => {
    describe.each([
      ['globalModuleName: "global"', { globalModuleName: "global" }, "global"],
      ['moduleName: "all-logs"', { moduleName: "all-logs" }, "all-logs"],
      [
        'moduleName: "all logs" (sanitizes to the global file)',
        { moduleName: "all logs" },
        "all-logs",
      ],
    ] as const)("%s", (_title, names, prefix) => {
      it.each([["pretty"], ["json"]] as const)(
        "writes each line once through one rotator (%s)",
        async (format) => {
          const root = createTempDir();
          const logger = createLogger({
            ...names,
            logDirectory: root,
            includeConsole: false,
            captureUncaught: false,
            format,
          });

          const privateRotators = moduleRotatingTransports(logger).length;
          const piped = logger.transports.length;

          logger.info(`SAME-PATH-${format}`);
          await shutdownLogger(logger);

          expect(logFileFamilies(root)).toEqual([prefix]);
          expect(occurrences(readLogFiles(root, prefix), `SAME-PATH-${format}`)).toBe(1);
          // One rotator means one rotation audit file; two rotators wrote two.
          expect(auditFiles(root)).toHaveLength(1);
          // Only the shared global handle is piped in: no private rotator on the same file.
          expect(privateRotators).toBe(0);
          expect(piped).toBe(1);
        },
      );
    });

    it("keeps following runtime level changes through the shared handle", async () => {
      const root = createTempDir();
      const logger = createLogger({
        moduleName: "all-logs",
        logDirectory: root,
        includeConsole: false,
        captureUncaught: false,
      });

      logger.debug("SAME-PATH-DEBUG-BEFORE");
      logger.level = "debug";
      logger.debug("SAME-PATH-DEBUG-AFTER");
      await shutdownLogger(logger);

      const file = readLogFiles(root, "all-logs");
      expect(occurrences(file, "SAME-PATH-DEBUG-AFTER")).toBe(1);
      expect(file).not.toContain("SAME-PATH-DEBUG-BEFORE");
    });

    it("records a crash once in the file it would otherwise have written twice", async () => {
      __crashCaptureInternals.setExitFn(jest.fn());
      const root = createTempDir();
      const logger = createLogger({
        moduleName: "all-logs",
        logDirectory: root,
        includeConsole: false,
        exitOnUncaught: false,
      });

      __crashCaptureInternals.invokeUncaught(new Error("same-path-crash"));
      await new Promise((resolve) => setImmediate(resolve));
      await shutdownLogger(logger);

      const file = readLogFiles(root, "all-logs");
      expect(occurrences(file, "uncaughtException: same-path-crash")).toBe(1);
      expect(logFileFamilies(root)).toEqual(["all-logs"]);
    });

    it("has the crash record on disk once before the process exits", async () => {
      const root = createTempDir();
      let fileAtExit: string | undefined;
      const exited = new Promise<void>((resolve) => {
        __crashCaptureInternals.setExitFn(() => {
          fileAtExit = readLogFiles(root, "all-logs");
          resolve();
        });
      });
      const logger = createLogger({
        moduleName: "all-logs",
        logDirectory: root,
        includeConsole: false,
      });

      __crashCaptureInternals.invokeUncaught(new Error("same-path-exit"));
      await exited;

      expect(occurrences(fileAtExit ?? "", "uncaughtException: same-path-exit")).toBe(1);
      expect(logFileFamilies(root)).toEqual(["all-logs"]);
      await shutdownLogger(logger);
    });

    it("rotates the single file with the global rotation settings", () => {
      const root = createTempDir();
      const logger = createLogger({
        moduleName: "all-logs",
        logDirectory: root,
        includeConsole: false,
        captureUncaught: false,
        rotation: { maxFiles: "3d" },
        globalRotation: { maxFiles: "30d" },
      });

      expect(moduleRotatingTransports(logger).length).toBe(0);
      const shared = sharedGlobalTransports();
      expect(shared).toHaveLength(1);
      expect((shared[0] as unknown as { options: { maxFiles: string } }).options.maxFiles).toBe(
        "30d",
      );

      teardownLogger(logger);
    });
  });

  describe("unchanged when the names differ", () => {
    it("still writes the module file and the global file, one line each", async () => {
      const root = createTempDir();
      const logger = createLogger({
        moduleName: "api",
        logDirectory: root,
        includeConsole: false,
        captureUncaught: false,
      });

      expect(moduleRotatingTransports(logger).length).toBe(1);
      expect(logger.transports.length).toBe(2);

      logger.info("DISTINCT-PATH");
      await shutdownLogger(logger);

      expect(logFileFamilies(root)).toEqual(["all-logs", "api"]);
      expect(occurrences(readLogFiles(root, "api"), "DISTINCT-PATH")).toBe(1);
      expect(occurrences(readLogFiles(root, "all-logs"), "DISTINCT-PATH")).toBe(1);
      expect(auditFiles(root)).toHaveLength(2);
    });

    it('keeps a private module file when the global file is off (`moduleName: "all-logs"`)', async () => {
      const root = createTempDir();
      const logger = createLogger({
        moduleName: "all-logs",
        logDirectory: root,
        includeConsole: false,
        includeGlobalFile: false,
        captureUncaught: false,
      });

      expect(moduleRotatingTransports(logger).length).toBe(1);
      expect(__sharedFileInternals.sharedFileRegistry.size).toBe(0);

      logger.info("MODULE-ONLY");
      await shutdownLogger(logger);

      expect(occurrences(readLogFiles(root, "all-logs"), "MODULE-ONLY")).toBe(1);
      expect(auditFiles(root)).toHaveLength(1);
    });
  });

  it("lets another logger share the deduplicated file, and its shutdown leaves the file open", async () => {
    const root = createTempDir();
    const owner = createLogger({
      moduleName: "all-logs",
      logDirectory: root,
      includeConsole: false,
      captureUncaught: false,
    });
    const sharer = createLogger({
      moduleName: "api",
      logDirectory: root,
      includeConsole: false,
      captureUncaught: false,
    });

    const entries = Array.from(__sharedFileInternals.sharedFileRegistry.values());
    expect(entries).toHaveLength(1);
    expect(entries[0].refCount).toBe(2);

    owner.info("OWNER-FIRST");
    sharer.info("SHARER-LINE");
    await shutdownLogger(sharer);

    // The sharer released only its own handle; the owner still holds the file.
    expect(entries[0].refCount).toBe(1);
    expect(__sharedFileInternals.sharedFileRegistry.size).toBe(1);
    owner.info("OWNER-AFTER-SHARER-SHUTDOWN");
    await shutdownLogger(owner);

    const global = readLogFiles(root, "all-logs");
    expect(occurrences(global, "OWNER-FIRST")).toBe(1);
    expect(occurrences(global, "SHARER-LINE")).toBe(1);
    expect(occurrences(global, "OWNER-AFTER-SHARER-SHUTDOWN")).toBe(1);
    expect(occurrences(readLogFiles(root, "api"), "SHARER-LINE")).toBe(1);
    expect(readLogFiles(root, "api")).not.toContain("OWNER-");
    expect(__sharedFileInternals.sharedFileRegistry.size).toBe(0);
  });

  describe("collision warning across loggers", () => {
    const quietOptions = { includeConsole: false, captureUncaught: false } as const;

    const collisionWarnings = (warn: jest.SpyInstance): string[] =>
      warn.mock.calls.map((call) => String(call[0]));

    it("warns once, naming the path, when a private module file meets a later shared global file", () => {
      const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
      const root = createTempDir();
      const owner = createLogger({
        ...quietOptions,
        moduleName: "all-logs",
        includeGlobalFile: false,
        logDirectory: root,
      });
      expect(warn).not.toHaveBeenCalled();

      const sharer = createLogger({ ...quietOptions, logDirectory: root });

      const messages = collisionWarnings(warn);
      expect(messages).toHaveLength(1);
      expect(messages[0]).toContain(JSON.stringify(rotatedPath(root, "all-logs")));
      expect(messages[0]).toContain("moduleName");
      expect(messages[0]).toContain("globalModuleName");

      [owner, sharer].forEach((logger) => teardownLogger(logger));
    });

    it("warns once when the shared global file exists before the private module file", () => {
      const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
      const root = createTempDir();
      const sharer = createLogger({ ...quietOptions, logDirectory: root });
      expect(warn).not.toHaveBeenCalled();

      const owner = createLogger({
        ...quietOptions,
        moduleName: "all-logs",
        includeGlobalFile: false,
        logDirectory: root,
      });

      const messages = collisionWarnings(warn);
      expect(messages).toHaveLength(1);
      expect(messages[0]).toContain(JSON.stringify(rotatedPath(root, "all-logs")));

      [owner, sharer].forEach((logger) => teardownLogger(logger));
    });

    it("does not warn again for a third logger on the same colliding path", () => {
      const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
      const root = createTempDir();
      const loggers = [
        createLogger({
          ...quietOptions,
          moduleName: "all-logs",
          includeGlobalFile: false,
          logDirectory: root,
        }),
        createLogger({ ...quietOptions, logDirectory: root }),
        createLogger({ ...quietOptions, moduleName: "third", logDirectory: root }),
      ];

      expect(collisionWarnings(warn)).toHaveLength(1);

      loggers.forEach((logger) => teardownLogger(logger));
    });

    it("warns once per colliding path", () => {
      const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
      const roots = [createTempDir(), createTempDir()];
      const loggers = roots.flatMap((root) => [
        createLogger({
          ...quietOptions,
          moduleName: "all-logs",
          includeGlobalFile: false,
          logDirectory: root,
        }),
        createLogger({ ...quietOptions, logDirectory: root }),
      ]);

      const messages = collisionWarnings(warn);
      expect(messages).toHaveLength(2);
      expect(messages[0]).toContain(JSON.stringify(rotatedPath(roots[0], "all-logs")));
      expect(messages[1]).toContain(JSON.stringify(rotatedPath(roots[1], "all-logs")));

      loggers.forEach((logger) => teardownLogger(logger));
    });

    it("warns again after resetLoggerRegistry() clears the latch", () => {
      const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
      const root = createTempDir();
      const build = (): winston.Logger[] => [
        createLogger({
          ...quietOptions,
          moduleName: "all-logs",
          includeGlobalFile: false,
          logDirectory: root,
        }),
        createLogger({ ...quietOptions, logDirectory: root }),
      ];

      const first = build();
      expect(collisionWarnings(warn)).toHaveLength(1);
      first.forEach((logger) => teardownLogger(logger));
      resetLoggerRegistry();

      const second = build();
      expect(collisionWarnings(warn)).toHaveLength(2);
      second.forEach((logger) => teardownLogger(logger));
    });

    describe("no warning", () => {
      const expectNoWarning = (build: (root: string) => winston.Logger[]): void => {
        const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
        const loggers = build(createTempDir());
        expect(warn).not.toHaveBeenCalled();
        loggers.forEach((logger) => teardownLogger(logger));
      };

      it("for loggers whose module and global paths never meet", () => {
        expectNoWarning((root) => [
          createLogger({ ...quietOptions, moduleName: "api", logDirectory: root }),
          createLogger({ ...quietOptions, moduleName: "jobs", logDirectory: root }),
          createLogger({ ...quietOptions, logDirectory: root }),
        ]);
      });

      it("for the deduplicated logger plus a logger sharing its global file, in either order", () => {
        expectNoWarning((root) => [
          createLogger({ ...quietOptions, moduleName: "all-logs", logDirectory: root }),
          createLogger({ ...quietOptions, moduleName: "api", logDirectory: root }),
        ]);
        resetLoggerRegistry();
        expectNoWarning((root) => [
          createLogger({ ...quietOptions, moduleName: "api", logDirectory: root }),
          createLogger({ ...quietOptions, moduleName: "all-logs", logDirectory: root }),
        ]);
      });

      it('for `moduleName: "all-logs", includeFile: false` next to a default logger, in either order', () => {
        expectNoWarning((root) => [
          createLogger({
            ...quietOptions,
            moduleName: "all-logs",
            includeFile: false,
            logDirectory: root,
          }),
          createLogger({ ...quietOptions, logDirectory: root }),
        ]);
        resetLoggerRegistry();
        expectNoWarning((root) => [
          createLogger({ ...quietOptions, logDirectory: root }),
          createLogger({
            ...quietOptions,
            moduleName: "all-logs",
            includeFile: false,
            logDirectory: root,
          }),
        ]);
      });

      it("for a later logger that opens no global file next to a private module file", () => {
        expectNoWarning((root) => [
          createLogger({
            ...quietOptions,
            moduleName: "all-logs",
            includeGlobalFile: false,
            logDirectory: root,
          }),
          createLogger({
            ...quietOptions,
            moduleName: "api",
            includeGlobalFile: false,
            logDirectory: root,
          }),
        ]);
      });

      it("once the other logger has been shut down, in either order", async () => {
        const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
        const root = createTempDir();
        const owner = createLogger({
          ...quietOptions,
          moduleName: "all-logs",
          includeGlobalFile: false,
          logDirectory: root,
        });
        await shutdownLogger(owner);
        const sharer = createLogger({ ...quietOptions, logDirectory: root });
        await shutdownLogger(sharer);
        const lateOwner = createLogger({
          ...quietOptions,
          moduleName: "all-logs",
          includeGlobalFile: false,
          logDirectory: root,
        });
        await shutdownLogger(lateOwner);

        expect(warn).not.toHaveBeenCalled();
      });
    });
  });

  describe("datePattern decides whether same-name rotators share files", () => {
    const MONTHLY = /^all-logs-\d{4}-\d{2}\.log$/;
    const DAILY = /^all-logs-\d{4}-\d{2}-\d{2}\.log$/;
    const quietOptions = { includeConsole: false, captureUncaught: false } as const;

    /** Every `.log` file in `dir` whose name matches `pattern`, concatenated. */
    const readMatching = (dir: string, pattern: RegExp): string =>
      fs
        .readdirSync(dir)
        .filter((name) => pattern.test(name))
        .map((name) => fs.readFileSync(path.join(dir, name), "utf8"))
        .join("");

    const hasMatching = (dir: string, pattern: RegExp): boolean =>
      fs.readdirSync(dir).some((name) => pattern.test(name));

    const warningsContaining = (warn: jest.SpyInstance, text: string): string[] =>
      warn.mock.calls.map((call) => String(call[0])).filter((message) => message.includes(text));

    const COLLISION = "Two loggers write to the same log file";
    const ROTATION_CONFLICT = "Conflicting global-file rotation config";

    it("dedupes a module datePattern the global file inherits (no globalRotation)", async () => {
      const root = createTempDir();
      const logger = createLogger({
        ...quietOptions,
        moduleName: "all-logs",
        logDirectory: root,
        rotation: { datePattern: "YYYY-MM" },
      });
      const privateRotators = moduleRotatingTransports(logger).length;

      logger.info("DP-INHERITED");
      await shutdownLogger(logger);

      expect(occurrences(readMatching(root, MONTHLY), "DP-INHERITED")).toBe(1);
      expect(hasMatching(root, DAILY)).toBe(false);
      expect(auditFiles(root)).toHaveLength(1);
      expect(privateRotators).toBe(0);
    });

    it.each([
      ["maxSize", { maxSize: "10m" }, { maxSize: "20m" }],
      ["zippedArchive", { zippedArchive: true }, { zippedArchive: false }],
      ["an undefined datePattern", { datePattern: undefined }, {}],
      ['an empty datePattern ("")', { datePattern: "" }, {}],
    ] as const)(
      "dedupes when only %s differs from the global rotation (same real file names)",
      async (_title, rotation, globalRotation) => {
        const root = createTempDir();
        const logger = createLogger({
          ...quietOptions,
          moduleName: "all-logs",
          logDirectory: root,
          rotation,
          globalRotation,
        });
        const privateRotators = moduleRotatingTransports(logger).length;

        logger.info("DP-SAME-NAMES");
        await shutdownLogger(logger);

        expect(occurrences(readMatching(root, DAILY), "DP-SAME-NAMES")).toBe(1);
        expect(auditFiles(root)).toHaveLength(1);
        expect(privateRotators).toBe(0);
      },
    );

    it("keeps both rotators, as before, when rotation and globalRotation name different files", async () => {
      const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
      const root = createTempDir();
      const logger = createLogger({
        ...quietOptions,
        moduleName: "all-logs",
        logDirectory: root,
        rotation: { datePattern: "YYYY-MM" },
        globalRotation: { datePattern: "YYYY-MM-DD" },
      });
      const privateRotators = moduleRotatingTransports(logger).length;
      const piped = logger.transports.length;

      logger.info("DP-TWO-SETS");
      await shutdownLogger(logger);

      expect(occurrences(readMatching(root, MONTHLY), "DP-TWO-SETS")).toBe(1);
      expect(occurrences(readMatching(root, DAILY), "DP-TWO-SETS")).toBe(1);
      expect(auditFiles(root)).toHaveLength(2);
      expect(privateRotators).toBe(1);
      expect(piped).toBe(2);
      expect(warn).not.toHaveBeenCalled();
    });

    it("compares with the shared file's CREATOR pattern: an existing different one keeps the module files", async () => {
      const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
      const root = createTempDir();
      const creator = createLogger({ ...quietOptions, logDirectory: root });
      const logger = createLogger({
        ...quietOptions,
        moduleName: "all-logs",
        logDirectory: root,
        rotation: { datePattern: "YYYY-MM" },
      });
      const privateRotators = moduleRotatingTransports(logger).length;

      logger.info("DP-CREATOR-DAILY");
      await shutdownLogger(logger);
      await shutdownLogger(creator);

      // Its module files are monthly; its global line goes to the creator's daily file.
      expect(occurrences(readMatching(root, MONTHLY), "DP-CREATOR-DAILY")).toBe(1);
      expect(occurrences(readMatching(root, DAILY), "DP-CREATOR-DAILY")).toBe(1);
      expect(privateRotators).toBe(1);
      expect(warningsContaining(warn, COLLISION)).toHaveLength(0);
      expect(warningsContaining(warn, ROTATION_CONFLICT)).toHaveLength(1);
    });

    it("compares with the shared file's CREATOR pattern: an existing equal one dedupes despite globalRotation", async () => {
      const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
      const root = createTempDir();
      const creator = createLogger({
        ...quietOptions,
        moduleName: "api",
        logDirectory: root,
        rotation: { datePattern: "YYYY-MM" },
      });
      const logger = createLogger({
        ...quietOptions,
        moduleName: "all-logs",
        logDirectory: root,
        rotation: { datePattern: "YYYY-MM" },
        globalRotation: { datePattern: "YYYY-MM-DD" },
      });
      const privateRotators = moduleRotatingTransports(logger).length;

      logger.info("DP-CREATOR-MONTHLY");
      await shutdownLogger(logger);
      await shutdownLogger(creator);

      expect(occurrences(readMatching(root, MONTHLY), "DP-CREATOR-MONTHLY")).toBe(1);
      expect(hasMatching(root, DAILY)).toBe(false);
      expect(privateRotators).toBe(0);
      expect(warningsContaining(warn, COLLISION)).toHaveLength(0);
      expect(warningsContaining(warn, ROTATION_CONFLICT)).toHaveLength(1);
    });

    it("compares with the pattern the creator recorded for its GLOBAL files, not its module files", async () => {
      const root = createTempDir();
      const creator = createLogger({
        ...quietOptions,
        moduleName: "api",
        logDirectory: root,
        rotation: { datePattern: "YYYY-MM" },
        globalRotation: { datePattern: "YYYY-MM-DD" },
      });
      const logger = createLogger({ ...quietOptions, moduleName: "all-logs", logDirectory: root });
      const privateRotators = moduleRotatingTransports(logger).length;

      logger.info("DP-CREATOR-GLOBAL");
      await shutdownLogger(logger);
      await shutdownLogger(creator);

      // The creator's global files are daily, like this logger's module files: one writer.
      expect(occurrences(readMatching(root, DAILY), "DP-CREATOR-GLOBAL")).toBe(1);
      expect(hasMatching(root, MONTHLY)).toBe(false);
      expect(privateRotators).toBe(0);
    });

    describe("collision warning", () => {
      const monthlyOwner = (root: string, extra: Record<string, unknown> = {}): winston.Logger =>
        createLogger({
          ...quietOptions,
          moduleName: "all-logs",
          includeGlobalFile: false,
          logDirectory: root,
          rotation: { datePattern: "YYYY-MM", ...extra },
        });

      it("stays silent for a private module file whose datePattern names other files, in either order", () => {
        const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
        const first = createTempDir();
        const ownerFirst = [
          monthlyOwner(first),
          createLogger({ ...quietOptions, logDirectory: first }),
        ];
        const second = createTempDir();
        const sharerFirst = [
          createLogger({ ...quietOptions, logDirectory: second }),
          monthlyOwner(second),
        ];

        expect(warn).not.toHaveBeenCalled();
        [...ownerFirst, ...sharerFirst].forEach((logger) => teardownLogger(logger));
      });

      it("compares an attaching logger with the pattern the shared file really uses", () => {
        const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
        const root = createTempDir();
        const loggers = [
          createLogger({ ...quietOptions, logDirectory: root }),
          monthlyOwner(root),
          createLogger({
            ...quietOptions,
            moduleName: "late",
            logDirectory: root,
            globalRotation: { datePattern: "YYYY-MM" },
          }),
        ];

        // The late logger asks for monthly global files but attaches to the daily ones.
        expect(warningsContaining(warn, COLLISION)).toHaveLength(0);
        expect(warningsContaining(warn, ROTATION_CONFLICT)).toHaveLength(1);
        loggers.forEach((logger) => teardownLogger(logger));
      });

      it.each([
        ["owner first", true, {}],
        ["shared file first", false, {}],
        ["owner first, different maxSize", true, { maxSize: "10m" }],
        ["shared file first, different maxSize", false, { maxSize: "10m" }],
      ] as const)(
        "warns once when both name the same monthly files (%s)",
        (_title, ownerFirst, extra) => {
          const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
          const root = createTempDir();
          const sharer = (): winston.Logger =>
            createLogger({
              ...quietOptions,
              logDirectory: root,
              rotation: { datePattern: "YYYY-MM" },
            });
          const loggers = ownerFirst
            ? [monthlyOwner(root, extra), sharer()]
            : [sharer(), monthlyOwner(root, extra)];

          const collisions = warningsContaining(warn, COLLISION);
          expect(collisions).toHaveLength(1);
          expect(collisions[0]).toContain(JSON.stringify(rotatedPath(root, "all-logs")));
          loggers.forEach((logger) => teardownLogger(logger));
        },
      );
    });
  });
});

describe("child loggers", () => {
  afterEach(() => {
    resetLoggerRegistry();
    jest.restoreAllMocks();
  });

  const FIXED_ISO = "2031-03-04T05:06:07Z";
  const FIXED_TS = "2031-03-04 05:06:07";
  const fixedClock = (): Date => new Date(FIXED_ISO);

  /** A logger whose only transport is a formatless Stream sink, plus the sink's text. */
  const sinkLogger = (
    format: "pretty" | "json",
    extra: Partial<LoggerOptions> = {},
  ): { logger: winston.Logger; output: () => string } => {
    const chunks: string[] = [];
    const stream = new PassThrough();
    stream.on("data", (chunk) => chunks.push(String(chunk)));
    const logger = createLogger({
      moduleName: `child-${format}`,
      includeConsole: false,
      includeFile: false,
      includeGlobalFile: false,
      captureUncaught: false,
      clock: fixedClock,
      format,
      additionalTransports: [new winston.transports.Stream({ stream })],
      ...extra,
    });
    return { logger, output: () => chunks.join("") };
  };

  const jsonLines = (text: string): Record<string, unknown>[] =>
    text
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>);

  const occurrences = (text: string, marker: string): number => text.split(marker).length - 1;

  /** Options for a file-backed root logger in `root`. */
  const fileOptions = (root: string, moduleName: string): LoggerOptions => ({
    moduleName,
    logDirectory: root,
    includeConsole: false,
    captureUncaught: true,
    exitOnUncaught: false,
  });

  describe("logging through a child", () => {
    it("writes the child's metadata on every line (json, exact line)", () => {
      const { logger, output } = sinkLogger("json");
      const child = logger.child({ requestId: "r1" });

      child.info("CHILD-JSON");
      logger.info("ROOT-JSON");

      expect(output().split("\n")[0]).toBe(
        `{"level":"info","message":"CHILD-JSON","module":"child-json","requestId":"r1","timestamp":"${FIXED_TS}"}`,
      );
      // The root logger is not affected by its child's metadata.
      expect(jsonLines(output())[1]).not.toHaveProperty("requestId");
      teardownLogger(logger);
    });

    it("writes the child's metadata on every line (pretty, exact block)", () => {
      const { logger, output } = sinkLogger("pretty");
      const child = logger.child({ requestId: "r1" });

      child.info("CHILD-PRETTY");

      expect(output()).toBe(
        `UTC: ${FIXED_TS}\n[INFO] (child-pretty)\nCHILD-PRETTY\n{\n  "requestId": "r1"\n}\n\n`,
      );
      teardownLogger(logger);
    });

    it.each([["pretty"], ["json"]] as const)(
      "applies maskMetaKeys to the child's metadata (%s)",
      (format) => {
        const { logger, output } = sinkLogger(format, { maskMetaKeys: ["token"] });
        const meta = { token: "CHILD-SECRET", requestId: "r1" };
        const child = logger.child(meta);

        child.info("masked");

        expect(output()).not.toContain("CHILD-SECRET");
        expect(output()).toContain("[REDACTED]");
        expect(output()).toContain("r1");
        // The caller's metadata object is left alone.
        expect(meta).toEqual({ token: "CHILD-SECRET", requestId: "r1" });
        teardownLogger(logger);
      },
    );

    it("routes an unknown method to the child's info, keeping its metadata, and warns once", () => {
      const { logger, output } = sinkLogger("json");
      const child = logger.child({ requestId: "r1" });

      expect(() => (child as any).success("FALLBACK-1")).not.toThrow();
      (child as any).success("FALLBACK-2");

      const lines = jsonLines(output());
      const logged = lines.filter((line) => String(line.message).startsWith("FALLBACK-"));
      expect(logged).toEqual([
        expect.objectContaining({ level: "info", message: "FALLBACK-1", requestId: "r1" }),
        expect.objectContaining({ level: "info", message: "FALLBACK-2", requestId: "r1" }),
      ]);
      const warnings = lines.filter((line) =>
        String(line.message).includes('Unknown logger method "success"'),
      );
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatchObject({ level: "warn" });
      teardownLogger(logger);
    });

    it("shares the root logger's one warning per unknown method name", () => {
      const { logger, output } = sinkLogger("json");
      const child = logger.child({ requestId: "r1" });

      (logger as any).notice("FROM-ROOT");
      (child as any).notice("FROM-CHILD");

      expect(occurrences(output(), 'Unknown logger method \\"notice\\"')).toBe(1);
      expect(jsonLines(output()).filter((line) => line.level === "info")).toHaveLength(2);
      teardownLogger(logger);
    });

    it("gives a grandchild both metadata sets, the nearer one winning, and the fallback", () => {
      const { logger, output } = sinkLogger("json");
      const grandchild = logger
        .child({ outer: 1, shared: "outer" })
        .child({ inner: 2, shared: "inner" });

      grandchild.info("NESTED");
      (grandchild as any).audit("NESTED-FALLBACK");

      const lines = jsonLines(output()).filter((line) => String(line.message).startsWith("NESTED"));
      expect(lines).toEqual([
        expect.objectContaining({ message: "NESTED", outer: 1, inner: 2, shared: "inner" }),
        expect.objectContaining({
          message: "NESTED-FALLBACK",
          outer: 1,
          inner: 2,
          shared: "inner",
        }),
      ]);
      teardownLogger(logger);
    });

    it("keeps winston's own child write reachable through the child (it adds the metadata)", () => {
      const { logger, output } = sinkLogger("json");
      const child = logger.child({ requestId: "r1" });

      expect(typeof child.write).toBe("function");
      child.write({ level: "info", message: "RAW-WRITE" } as any);

      expect(jsonLines(output())).toEqual([
        expect.objectContaining({ message: "RAW-WRITE", requestId: "r1" }),
      ]);
      teardownLogger(logger);
    });

    it("keeps output gated by the root's level: a child level write changes nothing", () => {
      const { logger, output } = sinkLogger("json");
      const child = logger.child({ requestId: "r1" });

      child.level = "debug";
      child.debug("CHILD-DEBUG");
      child.info("CHILD-INFO");

      expect(logger.level).toBe("info");
      expect(output()).not.toContain("CHILD-DEBUG");
      expect(output()).toContain("CHILD-INFO");
      teardownLogger(logger);
    });
  });

  describe("the child's safety surface", () => {
    it("serializes to the root's safe summary", () => {
      const { logger } = sinkLogger("json");
      const child = logger.child({ requestId: "r1" });

      expect(JSON.parse(JSON.stringify(child))).toEqual({
        type: "@hiprax/logger",
        moduleName: "child-json",
        label: "child-json",
        level: "info",
        transports: 1,
      });
      expect(JSON.stringify(child)).toBe(JSON.stringify(logger));
      teardownLogger(logger);
    });

    it("is not thenable: awaiting a child resolves to the child itself", async () => {
      const { logger } = sinkLogger("json");
      const child = logger.child({ requestId: "r1" });

      await expect(Promise.resolve(child)).resolves.toBe(child);
      expect((child as any).then).toBeUndefined();
      expect((child as any).catch).toBeUndefined();
      expect("then" in child).toBe(false);
      expect((child as any)[Symbol.toPrimitive]).toBeUndefined();
      expect((child as any)["not a method"]).toBeUndefined();
      teardownLogger(logger);
    });
  });

  describe("teardown through a child acts on the root logger", () => {
    it("shutdownLogger(child) shuts the root down, evicts it, and shares its promise", async () => {
      const root = createTempDir();
      const parent = createLogger(fileOptions(root, "parent"));
      const child = parent.child({ requestId: "r1" });
      expect(__crashCaptureInternals.registered.size).toBe(1);

      const childShutdown = shutdownLogger(child);
      expect(shutdownLogger(parent)).toBe(childShutdown);
      await childShutdown;

      expect(__crashCaptureInternals.registered.size).toBe(0);
      const next = createLogger(fileOptions(root, "parent"));
      expect(next).not.toBe(parent);
      expect(next.transports.length).toBeGreaterThan(0);

      next.info("AFTER-CHILD-SHUTDOWN");
      await shutdownLogger(next);
      const written = fs
        .readdirSync(root)
        .filter((name) => name.startsWith("parent-") && name.endsWith(".log"))
        .map((name) => fs.readFileSync(path.join(root, name), "utf8"))
        .join("");
      expect(written).toContain("AFTER-CHILD-SHUTDOWN");
    });

    it("shutdownLogger(parent) then shutdownLogger(child) returns the settled promise", async () => {
      const root = createTempDir();
      const parent = createLogger(fileOptions(root, "parent-first"));
      const child = parent.child({ requestId: "r1" });

      const parentShutdown = shutdownLogger(parent);
      await parentShutdown;

      expect(shutdownLogger(child)).toBe(parentShutdown);
    });

    it("child.close() deregisters the root, evicts it, and releases the shared global file", () => {
      const root = createTempDir();
      const parent = createLogger(fileOptions(root, "closing"));
      const child = parent.child({ requestId: "r1" });
      expect(__crashCaptureInternals.registered.size).toBe(1);
      expect(__sharedFileInternals.sharedFileRegistry.size).toBe(1);

      child.close();

      expect(__crashCaptureInternals.registered.size).toBe(0);
      expect(__sharedFileInternals.sharedFileRegistry.size).toBe(0);
      expect(parent.transports).toHaveLength(0);
      const next = createLogger(fileOptions(root, "closing"));
      expect(next).not.toBe(parent);
      teardownLogger(next);
    });

    it("child.close() keeps the shared global file open for another logger", () => {
      const root = createTempDir();
      const parent = createLogger(fileOptions(root, "closing-a"));
      const other = createLogger(fileOptions(root, "closing-b"));
      const child = parent.child({ requestId: "r1" });

      child.close();

      const entries = Array.from(__sharedFileInternals.sharedFileRegistry.values());
      expect(entries).toHaveLength(1);
      expect(entries[0].refCount).toBe(1);
      expect(__crashCaptureInternals.registered.size).toBe(1);
      expect(createLogger(fileOptions(root, "closing-b"))).toBe(other);
      teardownLogger(other);
    });

    it("child.end() ends the root logger and evicts it", async () => {
      const root = createTempDir();
      const parent = createLogger(fileOptions(root, "ending"));
      const child = parent.child({ requestId: "r1" });
      const finished = new Promise((resolve) => parent.once("finish", resolve));

      child.end();
      await finished;

      const next = createLogger(fileOptions(root, "ending"));
      expect(next).not.toBe(parent);
      teardownLogger(next);
      expect(parent.transports).toHaveLength(0);
    });

    it("child.end(entry) writes the entry with the child's metadata, then ends the root", async () => {
      const { logger, output } = sinkLogger("json");
      const child = logger.child({ requestId: "r1" });
      const ended = jest.fn();
      const finished = new Promise((resolve) => logger.once("finish", resolve));

      child.end({ level: "info", message: "LAST-ENTRY" } as any, ended);
      await finished;

      expect(jsonLines(output())).toEqual([
        expect.objectContaining({ level: "info", message: "LAST-ENTRY", requestId: "r1" }),
      ]);
      expect(ended).toHaveBeenCalledTimes(1);
      expect(logger.transports).toHaveLength(0);
    });

    it("child.end(entry, encoding, callback) writes the entry and still calls back", async () => {
      const { logger, output } = sinkLogger("json");
      const child = logger.child({ requestId: "r1" });

      await new Promise<void>((resolve) => {
        child.end({ level: "info", message: "WITH-ENCODING" } as any, "utf8", () => resolve());
      });

      expect(jsonLines(output())).toEqual([
        expect.objectContaining({ message: "WITH-ENCODING", requestId: "r1" }),
      ]);
    });

    it("child.end(entry) whose entry throws while being copied leaves the root cached and open", () => {
      const root = createTempDir();
      const parent = createLogger(fileOptions(root, "end-throws"));
      const child = parent.child({ requestId: "r1" });
      const hostile = {
        level: "info",
        message: "hostile",
        get broken(): string {
          throw new Error("getter failed");
        },
      };

      expect(() => child.end(hostile as any)).toThrow("getter failed");

      expect(createLogger(fileOptions(root, "end-throws"))).toBe(parent);
      expect(parent.transports.length).toBeGreaterThan(0);
      expect(__crashCaptureInternals.registered.size).toBe(1);
      teardownLogger(parent);
    });

    it("child.end(callback) ends the root and calls back without writing an entry", async () => {
      const { logger, output } = sinkLogger("json");
      const child = logger.child({ requestId: "r1" });

      await new Promise<void>((resolve) => {
        child.end(() => resolve());
      });

      expect(output()).toBe("");
      expect(logger.transports).toHaveLength(0);
    });

    it("a timed-out shutdown through a child can be retried through the root", async () => {
      class StalledTransport extends Transport {
        public name = "stalled-child";
        public log = jest.fn((_info: unknown, callback?: () => void) => callback?.());
        public _final = (_callback: (err?: Error | null) => void): void => {
          // Never calls back, so the first shutdown times out.
        };
      }
      const stalled = new StalledTransport();
      const parent = createLogger({
        moduleName: "child-timeout",
        includeConsole: false,
        includeFile: false,
        includeGlobalFile: false,
        captureUncaught: false,
        additionalTransports: [stalled as unknown as winston.transport],
      });
      const child = parent.child({ requestId: "r1" });

      const first = shutdownLogger(child, { timeoutMs: 20 });
      await expect(first).rejects.toThrow(/shutdownLogger timed out after 20ms/);

      const retry = shutdownLogger(parent, { timeoutMs: 2000 });
      expect(retry).not.toBe(first);
      stalled.emit("finish");
      await expect(retry).resolves.toBeUndefined();
    });

    it("close() and end() return the logger they were called on", () => {
      const { logger } = sinkLogger("json");
      const child = logger.child({ requestId: "r1" });
      const other = sinkLogger("json", { moduleName: "child-json-other" }).logger;
      const otherChild = other.child({ requestId: "r2" });

      expect(child.close()).toBe(child);
      expect(otherChild.end()).toBe(otherChild);
      const root = sinkLogger("json", { moduleName: "child-json-root" }).logger;
      const extra = new winston.transports.Stream({ stream: new PassThrough() });
      expect(root.add(extra)).toBe(root);
      expect(root.remove(extra)).toBe(root);
      expect(root.close()).toBe(root);
      const ended = sinkLogger("json", { moduleName: "child-json-ended" }).logger;
      expect(ended.end()).toBe(ended);
    });

    it("child.end() evicts the root but leaves it registered for crash capture", () => {
      const root = createTempDir();
      const parent = createLogger(fileOptions(root, "ending-crash"));
      const child = parent.child({ requestId: "r1" });

      child.end();

      expect(__crashCaptureInternals.registered.size).toBe(1);
      const next = createLogger(fileOptions(root, "ending-crash"));
      expect(next).not.toBe(parent);
      teardownLogger(next);
      teardownLogger(parent);
    });

    it("a grandchild's close() acts on the root logger", () => {
      const root = createTempDir();
      const parent = createLogger(fileOptions(root, "grand-closing"));
      const grandchild = parent.child({ a: 1 }).child({ b: 2 });

      expect(grandchild.close()).toBe(grandchild);

      expect(__crashCaptureInternals.registered.size).toBe(0);
      expect(__sharedFileInternals.sharedFileRegistry.size).toBe(0);
      const next = createLogger(fileOptions(root, "grand-closing"));
      expect(next).not.toBe(parent);
      teardownLogger(next);
    });

    it("a grandchild's shutdown is its root's shutdown", async () => {
      const root = createTempDir();
      const parent = createLogger(fileOptions(root, "grand-shutdown"));
      const grandchild = parent.child({ a: 1 }).child({ b: 2 });

      const grandchildShutdown = shutdownLogger(grandchild);

      expect(shutdownLogger(parent)).toBe(grandchildShutdown);
      await grandchildShutdown;
      expect(__crashCaptureInternals.registered.size).toBe(0);
      const next = createLogger(fileOptions(root, "grand-shutdown"));
      expect(next).not.toBe(parent);
      teardownLogger(next);
    });

    it("a child of a logger that was already shut down returns the settled shutdown", async () => {
      const root = createTempDir();
      const parent = createLogger(fileOptions(root, "late-child"));
      const parentShutdown = shutdownLogger(parent);
      await parentShutdown;

      const late = parent.child({ requestId: "r1" });

      expect(shutdownLogger(late)).toBe(parentShutdown);
    });

    it("a detached child's shutdown leaves the replacement logger cached", async () => {
      const root = createTempDir();
      const detached = createLogger(fileOptions(root, "replaced"));
      const child = detached.child({ requestId: "r1" });
      resetLoggerRegistry();
      const replacement = createLogger(fileOptions(root, "replaced"));

      await shutdownLogger(child);

      expect(createLogger(fileOptions(root, "replaced"))).toBe(replacement);
      await shutdownLogger(replacement);
    });
  });

  describe("transport changes through a child act on the root logger", () => {
    /** A transport that records its lines and counts `close()` calls. */
    const recordingTransport = () => {
      const lines: Record<string, unknown>[] = [];
      let closed = 0;
      const transport = new Transport({
        log(info: Record<string, unknown>, callback: () => void) {
          lines.push(info);
          callback();
        },
        close() {
          closed += 1;
        },
      }) as unknown as winston.transport;
      return { transport, lines, closed: () => closed };
    };

    const globalOnly = (root: string, moduleName: string): LoggerOptions => ({
      moduleName,
      logDirectory: root,
      includeConsole: false,
      includeFile: false,
      captureUncaught: false,
    });

    it.each([
      [
        "remove(handle)",
        (child: winston.Logger, handle: winston.transport) => child.remove(handle),
      ],
      ["clear()", (child: winston.Logger) => child.clear()],
      [
        "unpipe(handle)",
        (child: winston.Logger, handle: winston.transport) => child.unpipe(handle),
      ],
    ] as const)(
      "child.%s releases the shared global file without evicting the root",
      (_title, detach) => {
        const root = createTempDir();
        const parent = createLogger(globalOnly(root, "detaching"));
        const child = parent.child({ requestId: "r1" });
        const [handle] = parent.transports;
        expect(__sharedFileInternals.sharedFileRegistry.size).toBe(1);

        // The call returns the logger it was made on, not the raw root.
        expect(detach(child, handle)).toBe(child);

        expect(parent.transports).toHaveLength(0);
        expect(__sharedFileInternals.sharedFileRegistry.size).toBe(0);
        // Detaching a transport is not a teardown: the root stays cached.
        expect(createLogger(globalOnly(root, "detaching"))).toBe(parent);
        teardownLogger(parent);
      },
    );

    it("child.add() gives the root the transport: the root's close() closes it", () => {
      const { logger } = sinkLogger("json");
      const child = logger.child({ requestId: "r1" });
      const added = recordingTransport();

      expect(child.add(added.transport)).toBe(child);
      // The transport's source is the root base (the child's prototype), not the child.
      expect((added.transport as unknown as { parent: unknown }).parent).toBe(
        Object.getPrototypeOf(child),
      );
      logger.close();

      expect(added.closed()).toBe(1);
    });

    it("child.add() keeps the chain on the child and the transport gated by the root's level", () => {
      const { logger } = sinkLogger("json");
      const child = logger.child({ requestId: "r1" });
      const added = recordingTransport();

      child.level = "silly";
      child.add(added.transport).info("ADDED-INFO");
      child.debug("ADDED-DEBUG");

      expect(added.lines).toEqual([
        expect.objectContaining({ message: "ADDED-INFO", requestId: "r1" }),
      ]);
      teardownLogger(logger);
    });

    it("child.pipe() pipes into the root: the root's close() closes the transport", () => {
      const { logger } = sinkLogger("json");
      const child = logger.child({ requestId: "r1" });
      const piped = recordingTransport();

      expect(child.pipe(piped.transport as unknown as NodeJS.WritableStream)).toBe(piped.transport);
      child.info("PIPED");
      logger.close();

      expect(piped.lines).toEqual([expect.objectContaining({ message: "PIPED", requestId: "r1" })]);
      expect(piped.closed()).toBe(1);
    });

    it("child.configure() reconfigures the root and releases its old transports", () => {
      const root = createTempDir();
      const parent = createLogger(globalOnly(root, "configuring"));
      const child = parent.child({ requestId: "r1" });
      const replacement = recordingTransport();

      child.configure({ level: "debug", transports: [replacement.transport] });
      child.debug("CONFIGURED");

      expect(parent.level).toBe("debug");
      expect(Object.prototype.hasOwnProperty.call(child, "level")).toBe(false);
      expect(__sharedFileInternals.sharedFileRegistry.size).toBe(0);
      expect(replacement.lines).toEqual([
        expect.objectContaining({ message: "CONFIGURED", requestId: "r1" }),
      ]);
      parent.close();
      expect(replacement.closed()).toBe(1);
    });
  });

  describe("winston's child write runs before this package's formats (documented boundary)", () => {
    it("reports the child's own level from isLevelEnabled while output follows the root", () => {
      const { logger } = sinkLogger("json");
      const child = logger.child({ requestId: "r1" });

      child.level = "debug";

      expect(child.isLevelEnabled("debug")).toBe(true);
      expect(logger.isLevelEnabled("debug")).toBe(false);
      teardownLogger(logger);
    });

    it("a throwing getter on the payload throws out of the child's log call", () => {
      const { logger, output } = sinkLogger("json");
      const payload = {
        message: "getter",
        get broken(): string {
          throw new Error("getter failed");
        },
      };

      expect(() => logger.info(payload)).not.toThrow();
      expect(() => logger.child({ requestId: "r1" }).info(payload)).toThrow("getter failed");
      expect(jsonLines(output())).toHaveLength(1);
      teardownLogger(logger);
    });

    it("a Proxy payload whose ownKeys trap throws degrades on the root but throws through a child", () => {
      const { logger, output } = sinkLogger("json");
      const payload = new Proxy(
        { message: "hi" },
        {
          ownKeys: () => {
            throw new Error("ownKeys refused");
          },
        },
      );

      expect(() => logger.info(payload)).not.toThrow();
      expect(() => logger.child({ requestId: "r1" }).info(payload)).toThrow("ownKeys refused");
      // Only the root's degraded line was written; the child wrote nothing.
      const lines = jsonLines(output());
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatchObject({ level: "info", message: "hi", _unserializable: true });
      expect(lines[0]).not.toHaveProperty("requestId");
      teardownLogger(logger);
    });

    it("a class-instance payload is cloned into a plain object, so its toJSON is not used", () => {
      const { logger, output } = sinkLogger("json");
      class Dto {
        public message = "dto";
        public ssn = "WITHHELD";
        public toJSON(): Record<string, unknown> {
          return { message: this.message };
        }
      }

      logger.info(new Dto());
      logger.child({ requestId: "r1" }).info(new Dto());

      const [rootLine, childLine] = output().split("\n");
      expect(rootLine).toBe('{"message":"dto"}');
      expect(childLine).toContain('"ssn":"WITHHELD"');
      teardownLogger(logger);
    });

    it("an array payload is written as an object keyed by index", () => {
      const { logger, output } = sinkLogger("json");

      logger.log("info", ["a", "b"] as any);
      logger.child({}).log("info", ["a", "b"] as any);

      expect(output().split("\n").slice(0, 2)).toEqual([
        '["a","b"]',
        `{"0":"a","1":"b","level":"info","module":"child-json","timestamp":"${FIXED_TS}"}`,
      ]);
      teardownLogger(logger);
    });

    it("an Error payload gains a cause key (pretty: an empty metadata block)", () => {
      const { logger, output } = sinkLogger("pretty");
      const err = new Error("boom");
      err.stack = "Error: boom\n    at fixed";

      logger.child({}).error(err);

      expect(output()).toBe(
        `UTC: ${FIXED_TS}\n[ERROR] (child-pretty)\nboom\nError: boom\n    at fixed\n{}\n\n`,
      );
      teardownLogger(logger);
    });
  });
});

describe("methods that return the logger keep the package's wrapper", () => {
  afterEach(() => {
    resetLoggerRegistry();
    __crashCaptureInternals.restoreExitFn();
    jest.restoreAllMocks();
  });

  /** A json logger whose only transport is a formatless Stream sink, plus its parsed lines. */
  const sinkLogger = (
    moduleName: string,
  ): { logger: winston.Logger; lines: () => Record<string, unknown>[] } => {
    const chunks: string[] = [];
    const stream = new PassThrough();
    stream.on("data", (chunk) => chunks.push(String(chunk)));
    const logger = createLogger({
      moduleName,
      format: "json",
      level: "silly",
      includeConsole: false,
      includeFile: false,
      includeGlobalFile: false,
      captureUncaught: false,
      additionalTransports: [new winston.transports.Stream({ stream })],
    });
    const lines = (): Record<string, unknown>[] =>
      chunks
        .join("")
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as Record<string, unknown>);
    return { logger, lines };
  };

  /** Options for a file-backed logger in `root` that takes part in crash capture. */
  const fileOptions = (root: string, moduleName: string): LoggerOptions => ({
    moduleName,
    logDirectory: root,
    includeConsole: false,
    captureUncaught: true,
    exitOnUncaught: false,
  });

  /** Every `.log` file in `dir` whose name starts with `${prefix}-`, concatenated. */
  const readLogFiles = (dir: string, prefix: string): string =>
    fs
      .readdirSync(dir)
      .filter((name) => name.startsWith(`${prefix}-`) && name.endsWith(".log"))
      .map((name) => fs.readFileSync(path.join(dir, name), "utf8"))
      .join("");

  // Identity is compared as a boolean throughout: a failure diff of the raw
  // winston logger would make the test runner walk its stream internals.

  it("every level method and every log() form return the root logger", () => {
    const { logger, lines } = sinkLogger("chain-levels");
    const levels = ["error", "warn", "info", "http", "verbose", "debug", "silly"] as const;

    for (const level of levels) {
      expect(logger[level](`level-${level}`) === logger).toBe(true);
    }
    expect(logger.log("info", "log-two-args") === logger).toBe(true);
    expect(logger.log("info", "log-three-args", { extra: 1 }) === logger).toBe(true);
    expect(logger.log({ level: "info", message: "log-object" }) === logger).toBe(true);

    expect(lines().map((line) => line.message)).toEqual([
      ...levels.map((level) => `level-${level}`),
      "log-two-args",
      "log-three-args",
      "log-object",
    ]);
    teardownLogger(logger);
  });

  it("the event-emitter methods and the first profile() call return the root logger", () => {
    const { logger } = sinkLogger("chain-emitter");
    const listener = (): void => undefined;

    expect(logger.on("chain-test", listener) === logger).toBe(true);
    expect(logger.once("chain-test", listener) === logger).toBe(true);
    expect(logger.removeListener("chain-test", listener) === logger).toBe(true);
    expect(logger.setMaxListeners(20) === logger).toBe(true);
    expect(logger.profile("chain-profile") === logger).toBe(true);
    expect(logger.listenerCount("chain-test")).toBe(1);
    logger.removeAllListeners("chain-test");
    teardownLogger(logger);
  });

  it("results that are not the logger itself come back unchanged", () => {
    const { logger } = sinkLogger("chain-negative");

    expect(logger.emit("chain-nobody")).toBe(false);
    expect(logger.isLevelEnabled("info")).toBe(true);
    expect(typeof logger.write({ level: "info", message: "raw-write" } as any)).toBe("boolean");
    const timer = logger.startTimer();
    expect(timer === (logger as unknown)).toBe(false);
    expect(typeof timer.done).toBe("function");
    const child = logger.child({ requestId: "r1" });
    expect(child === logger).toBe(false);
    teardownLogger(logger);
  });

  it("a child and a grandchild return themselves, and a child's own write stays winston's", () => {
    const { logger, lines } = sinkLogger("chain-child");
    const child = logger.child({ requestId: "r1" });
    const grandchild = child.child({ step: 2 });

    expect(child.warn("child-warn") === child).toBe(true);
    expect(child.log("info", "child-log") === child).toBe(true);
    expect(child.on("chain-test", () => undefined) === child).toBe(true);
    expect(grandchild.info("grandchild-info") === grandchild).toBe(true);
    // The own, non-writable, non-configurable `write` is still returned as is
    // (the Proxy invariant), so every read yields the same function.
    expect(child.write === child.write).toBe(true);
    expect(child.write({ level: "info", message: "child-write" } as any)).toBeUndefined();

    expect(lines()).toEqual([
      expect.objectContaining({ message: "child-warn", requestId: "r1" }),
      expect.objectContaining({ message: "child-log", requestId: "r1" }),
      expect.objectContaining({ message: "grandchild-info", requestId: "r1", step: 2 }),
      expect.objectContaining({ message: "child-write", requestId: "r1" }),
    ]);
    logger.removeAllListeners("chain-test");
    teardownLogger(logger);
  });

  it("an unknown method returns the logger it was called on, like the level method it stands in for", () => {
    const { logger, lines } = sinkLogger("chain-unknown");
    const child = logger.child({ requestId: "r1" });

    expect((logger as any).success("root-success") === logger).toBe(true);
    expect((child as any).success("child-success") === child).toBe(true);
    (logger as any).success("chained-a").notice("chained-b");

    const info = lines().filter((line) => line.level === "info");
    expect(info).toEqual([
      expect.objectContaining({ message: "root-success" }),
      expect.objectContaining({ message: "child-success", requestId: "r1" }),
      expect.objectContaining({ message: "chained-a" }),
      expect.objectContaining({ message: "chained-b" }),
    ]);
    expect(info[2]).not.toHaveProperty("requestId");
    const warnings = lines().filter((line) => line.level === "warn");
    expect(warnings.map((line) => String(line.message))).toEqual([
      expect.stringContaining('Unknown logger method "success"'),
      expect.stringContaining('Unknown logger method "notice"'),
    ]);
    teardownLogger(logger);
  });

  it("a chain keeps the safety net: the fallback, the safe summary, and no thenable", async () => {
    const { logger, lines } = sinkLogger("chain-safety");
    const child = logger.child({ requestId: "r1" });

    expect(() => (logger.info("root-a") as any).success("root-b")).not.toThrow();
    expect(() => (child.info("child-a") as any).success("child-b")).not.toThrow();
    expect(JSON.parse(JSON.stringify(logger.info("summary")))).toEqual({
      type: "@hiprax/logger",
      moduleName: "chain-safety",
      label: "chain-safety",
      level: "silly",
      transports: 1,
    });
    const awaited = await Promise.resolve(logger.info("awaited"));
    expect(awaited === logger).toBe(true);

    const info = lines().filter((line) => line.level === "info");
    expect(info.map((line) => line.message)).toEqual([
      "root-a",
      "root-b",
      "child-a",
      "child-b",
      "summary",
      "awaited",
    ]);
    expect(info[3]).toMatchObject({ requestId: "r1" });
    expect(info[1]).not.toHaveProperty("requestId");
    teardownLogger(logger);
  });

  it("a detached level method still logs through the child and returns it", () => {
    const { logger, lines } = sinkLogger("chain-detached");
    const child = logger.child({ requestId: "r1" });
    const { info } = child;

    expect(info("detached") === child).toBe(true);
    expect(lines()).toEqual([expect.objectContaining({ message: "detached", requestId: "r1" })]);
    teardownLogger(logger);
  });

  it("constructor stays constructible, as a bound class", () => {
    const { logger } = sinkLogger("chain-constructor");
    const Ctor = logger.constructor as unknown as new () => unknown;

    expect(Ctor.name).toBe("bound DerivedLogger");
    expect(() => new Ctor()).not.toThrow();
    teardownLogger(logger);
  });

  it("logger.info(x).end() evicts the logger, so the next createLogger builds a live one", async () => {
    const root = createTempDir();
    const parent = createLogger(fileOptions(root, "chain-end"));
    const finished = new Promise((resolve) => parent.once("finish", resolve));

    parent.info("bye").end();
    await finished;

    const next = createLogger(fileOptions(root, "chain-end"));
    expect(next === parent).toBe(false);
    expect(next.transports.length).toBeGreaterThan(0);
    next.info("AFTER-CHAINED-END");
    await shutdownLogger(next);
    expect(readLogFiles(root, "chain-end")).toContain("AFTER-CHAINED-END");
  });

  it("logger.info(x).close() leaves crash capture, releases the shared file, and evicts", () => {
    const root = createTempDir();
    const parent = createLogger(fileOptions(root, "chain-close"));
    expect(__crashCaptureInternals.registered.size).toBe(1);
    expect(__sharedFileInternals.sharedFileRegistry.size).toBe(1);

    expect(parent.info("bye").close() === parent).toBe(true);

    expect(__crashCaptureInternals.registered.size).toBe(0);
    expect(__sharedFileInternals.sharedFileRegistry.size).toBe(0);
    const next = createLogger(fileOptions(root, "chain-close"));
    expect(next === parent).toBe(false);
    teardownLogger(next);
  });

  it("shutting down a child derived from a level method's result shuts the root down and evicts it", async () => {
    const root = createTempDir();
    const parent = createLogger(fileOptions(root, "chain-teardown"));
    const chained = parent.info("start");
    const child = chained.child({ requestId: "r1" });

    expect(typeof (child as any).success).toBe("function");
    const childShutdown = shutdownLogger(child);
    expect(shutdownLogger(parent)).toBe(childShutdown);
    expect(shutdownLogger(chained)).toBe(childShutdown);
    await childShutdown;

    expect(__crashCaptureInternals.registered.size).toBe(0);
    const next = createLogger(fileOptions(root, "chain-teardown"));
    expect(next === parent).toBe(false);
    expect(next.transports.length).toBeGreaterThan(0);
    await shutdownLogger(next);
  });
});

describe("maskMetaKeys masks what a nested value's own toJSON() returns", () => {
  afterEach(() => {
    resetLoggerRegistry();
    jest.restoreAllMocks();
  });

  const STACK = "Error: fixed\n    at fixed (fixed.js:1:1)";

  /** An Error with a deterministic stack, optionally carrying own properties. */
  const fixedError = (
    message: string,
    own: Record<string, unknown> = {},
    options?: ErrorOptions,
  ): Error => {
    const err = Object.assign(new Error(message, options), own);
    err.stack = STACK;
    return err;
  };

  /** An HTTP-client-style error whose toJSON() includes the request headers (the axios shape). */
  class ClientError extends Error {
    readonly #headers: Record<string, string>;

    public constructor(message: string, headers: Record<string, string>) {
      super(message);
      this.#headers = headers;
    }

    public toJSON(): Record<string, unknown> {
      return {
        name: "ClientError",
        message: this.message,
        config: { headers: { ...this.#headers } },
      };
    }
  }

  /** The metadata of a line: the pretty block after the message line, or the json fields. */
  const metaOf = (format: Format, fileOut: string): unknown => {
    if (format === "pretty") {
      return JSON.parse(fileOut.split("\n").slice(3).join("\n"));
    }
    const {
      level: _level,
      message: _message,
      module: _module,
      timestamp: _timestamp,
      ...meta
    } = JSON.parse(fileOut) as Record<string, unknown>;
    return meta;
  };

  const formats: Format[] = ["pretty", "json"];

  it("json: `level` and `timestamp` inside a top-level toJSON output are caller data and are masked", async () => {
    const make = (): Record<string, unknown> => ({
      message: "m",
      toJSON: () => ({
        level: { password: "S-OUT-LEVEL" },
        timestamp: { password: "S-OUT-TIMESTAMP" },
        other: 1,
      }),
    });

    const masked = await render("tojson-top-reserved", "json", (logger) => logger.info(make()), [
      "password",
    ]);
    const unmasked = await render("tojson-top-reserved", "json", (logger) => logger.info(make()));

    expect(masked.thrown).toBeUndefined();
    expect(unmasked.fileOut).toBe(
      '{"level":{"password":"S-OUT-LEVEL"},"other":1,"timestamp":{"password":"S-OUT-TIMESTAMP"}}\n',
    );
    expect(masked.fileOut).toBe(
      '{"level":{"password":"[REDACTED]"},"other":1,"timestamp":{"password":"[REDACTED]"}}\n',
    );
    expect(masked.consoleOut).toBe(masked.fileOut);
  });

  it("json: an error a top-level toJSON returns renders through its masked view, its own toJSON left out", async () => {
    const make = (): Record<string, unknown> => {
      const err = Object.assign(fixedError("top"), {
        password: "S-TOP-ERROR",
        toJSON: () => ({ leaked: "S-TOP-ERROR-JSON" }),
      });
      return { message: "m", toJSON: () => err };
    };

    const masked = await render("tojson-top-error", "json", (logger) => logger.info(make()), [
      "password",
    ]);
    const unmasked = await render("tojson-top-error", "json", (logger) => logger.info(make()));

    const stack = JSON.stringify(STACK);
    expect(masked.thrown).toBeUndefined();
    expect(unmasked.fileOut).toBe(
      `{"message":"top","name":"Error","password":"S-TOP-ERROR","stack":${stack}}\n`,
    );
    expect(masked.fileOut).toBe(
      `{"message":"top","name":"Error","password":"[REDACTED]","stack":${stack}}\n`,
    );
    expect(masked.consoleOut).toBe(masked.fileOut);
    expect(masked.fileOut + unmasked.fileOut).not.toContain("S-TOP-ERROR-JSON");
  });

  it("json: an array a top-level toJSON returns is read by its elements, even with a toJSON of its own", async () => {
    const make = (): Record<string, unknown> => ({
      message: "m",
      toJSON: () =>
        Object.assign([{ password: "S-TOP-ARRAY", keep: 1 }], { toJSON: () => "never" }),
    });

    const masked = await render("tojson-top-array", "json", (logger) => logger.info(make()), [
      "password",
    ]);
    const unmasked = await render("tojson-top-array", "json", (logger) => logger.info(make()));

    expect(masked.thrown).toBeUndefined();
    expect(unmasked.fileOut).toBe('[{"keep":1,"password":"S-TOP-ARRAY"}]\n');
    expect(masked.fileOut).toBe('[{"keep":1,"password":"[REDACTED]"}]\n');
    expect(masked.consoleOut).toBe(masked.fileOut);
  });

  describe.each(formats)("format: %s", (format) => {
    it("masks the toJSON() output of a value in a cause, in an AggregateError, and nested directly", async () => {
      const client = (): ClientError =>
        new ClientError("upstream failed", { Authorization: "Bearer S-AUTH" });
      const wrapped = fixedError("charge failed", {}, { cause: client() });
      const batch = Object.assign(new AggregateError([client()], "batch failed"), { stack: STACK });
      const inner = fixedError("inner", {}, { cause: { password: "S-INNER" } });
      const dto = { toJSON: () => ({ err: inner }) };
      const errorResult = { toJSON: () => fixedError("from toJSON", { password: "S-RESULT" }) };

      const out = await render(
        "tojson-mask",
        format,
        (logger) => logger.info("m", { wrapped, batch, direct: client(), dto, errorResult }),
        ["authorization", "password"],
      );

      expect(out.thrown).toBeUndefined();
      const maskedClient = {
        name: "ClientError",
        message: "upstream failed",
        config: { headers: { Authorization: "[REDACTED]" } },
      };
      expect(metaOf(format, out.fileOut)).toEqual({
        wrapped: { name: "Error", message: "charge failed", stack: STACK, cause: maskedClient },
        batch: {
          name: "AggregateError",
          message: "batch failed",
          stack: STACK,
          errors: [maskedClient],
        },
        direct: maskedClient,
        dto: {
          err: { name: "Error", message: "inner", stack: STACK, cause: { password: "[REDACTED]" } },
        },
        errorResult: {
          name: "Error",
          message: "from toJSON",
          stack: STACK,
          password: "[REDACTED]",
        },
      });
      for (const text of [out.fileOut, out.consoleOut]) {
        expect(text).not.toContain("S-AUTH");
        expect(text).not.toContain("S-INNER");
        expect(text).not.toContain("S-RESULT");
      }
      expectConsoleMatchesFile(format, out);
      // The caller's values are untouched.
      expect((inner.cause as { password: string }).password).toBe("S-INNER");
      expect(Object.keys(inner)).toEqual([]);
    });

    it("runs a nested plain object's toJSON on the masked copy, like the serializer does", async () => {
      const closure = { toJSON: () => ({ password: "S-CLOSURE", ok: 1 }) };
      const renamed = {
        password: "S-RENAMED",
        toJSON(): Record<string, unknown> {
          return { pw: this.password };
        },
      };
      const whole = {
        password: "S-WHOLE",
        toJSON(): unknown {
          return this.password;
        },
      };

      const out = await render(
        "tojson-plain",
        format,
        (logger) => logger.info("m", { closure, renamed, whole }),
        ["password"],
      );

      expect(out.thrown).toBeUndefined();
      expect(metaOf(format, out.fileOut)).toEqual({
        closure: { password: "[REDACTED]", ok: 1 },
        renamed: { pw: "[REDACTED]" },
        whole: "[REDACTED]",
      });
      expect(out.fileOut + out.consoleOut).not.toMatch(/S-CLOSURE|S-RENAMED|S-WHOLE/);
      expectConsoleMatchesFile(format, out);
      expect(renamed.password).toBe("S-RENAMED");
      expect(whole.password).toBe("S-WHOLE");
    });

    it("calls a class instance's toJSON on the instance itself, so #private fields work", async () => {
      class Token {
        readonly #secret = "S-PRIVATE";

        public toJSON(): Record<string, unknown> {
          return { kind: "token", password: this.#secret };
        }
      }
      class SelfRef {
        public password = "S-SELF";
        public v = 1;

        public toJSON(): this {
          return this;
        }
      }
      class SelfError extends Error {
        public password = "S-SELF-ERROR";

        public toJSON(): this {
          return this;
        }
      }
      const selfError = new SelfError("self error");
      selfError.stack = STACK;

      const out = await render(
        "tojson-instance",
        format,
        (logger) => logger.info("m", { token: new Token(), self: new SelfRef(), selfError }),
        ["password"],
      );

      expect(out.thrown).toBeUndefined();
      expect(metaOf(format, out.fileOut)).toEqual({
        token: { kind: "token", password: "[REDACTED]" },
        self: { password: "[REDACTED]", v: 1 },
        // The serializers render an Error result through its field view, so
        // the masked view keeps name / message / stack.
        selfError: { name: "Error", message: "self error", stack: STACK, password: "[REDACTED]" },
      });
      expect(out.fileOut + out.consoleOut).not.toMatch(/S-PRIVATE|S-SELF/);
      expectConsoleMatchesFile(format, out);
    });

    it("renders nested toJSON values exactly as it does without a mask when nothing is masked", async () => {
      class Dto {
        public id = 1;
        public toJSON(): Record<string, unknown> {
          return { id: this.id, tags: ["a"] };
        }
      }
      class Selfish {
        public v = 1;
        public toJSON(): this {
          return this;
        }
      }
      class Result {
        public r = 1;
      }
      const make = (): Record<string, unknown> => ({
        at: new Date(0),
        url: new URL("https://example.test/a?b=1"),
        buf: Buffer.from("hi"),
        stamp: { toJSON: () => "2026-01-02" },
        objectId: { toJSON: () => "65f0c0ffee" },
        dto: new Dto(),
        selfish: new Selfish(),
        list: { toJSON: () => [1, { two: 2 }] },
        instanceResult: { toJSON: () => new Result() },
        bufferResult: { toJSON: () => Buffer.from("ok") },
        errorResult: { toJSON: () => fixedError("r") },
        keyed: { toJSON: (key: string) => ({ key }) },
        arr: [{ toJSON: (key: string) => ({ key }) }],
        err: fixedError("x", {}, { cause: new ClientError("c", { accept: "json" }) }),
        dateCause: fixedError("d", {}, { cause: new Date(0) }),
        bufferCause: fixedError("b", {}, { cause: Buffer.from("hi") }),
      });

      const masked = await render("tojson-parity", format, (logger) => logger.info("m", make()), [
        "password",
      ]);
      const unmasked = await render("tojson-parity", format, (logger) => logger.info("m", make()));

      expect(masked.thrown).toBeUndefined();
      expect(masked.fileOut).toBe(unmasked.fileOut);
      expect(masked.consoleOut).toBe(unmasked.consoleOut);
      expect(masked.fileOut).not.toContain("[REDACTED]");
      const meta = metaOf(format, unmasked.fileOut) as Record<string, unknown>;
      expect(meta).toMatchObject({
        at: "1970-01-01T00:00:00.000Z",
        url: "https://example.test/a?b=1",
        buf: { type: "Buffer", data: [104, 105] },
        stamp: "2026-01-02",
        objectId: "65f0c0ffee",
        dto: { id: 1, tags: ["a"] },
        selfish: { v: 1 },
        list: [1, { two: 2 }],
        instanceResult: { r: 1 },
        errorResult: { name: "Error", message: "r", stack: STACK },
        keyed: { key: "keyed" },
        arr: [{ key: "0" }],
        err: {
          name: "Error",
          message: "x",
          stack: STACK,
          cause: { name: "ClientError", message: "c", config: { headers: { accept: "json" } } },
        },
        dateCause: { name: "Error", message: "d", stack: STACK, cause: "1970-01-01T00:00:00.000Z" },
        bufferCause: {
          name: "Error",
          message: "b",
          stack: STACK,
          cause: { type: "Buffer", data: [104, 105] },
        },
      });
      // A Buffer returned by a toJSON() is read by its own keys, as the serializer reads it.
      expect(Object.keys(meta.bufferResult as object)).toEqual(["0", "1"]);
    });

    it("never calls a nested toJSON in the walk without a mask; with one, a primitive result is resolved twice", async () => {
      const chains = format === "pretty" ? 2 : 1;
      const counted = (result: () => unknown) => {
        const counter = { calls: 0 };
        return { counter, value: { toJSON: () => ((counter.calls += 1), result()) } };
      };
      const bufferToJSON = jest.spyOn(Buffer.prototype, "toJSON");

      const plainOff = counted(() => ({ a: 1 }));
      const primitiveOff = counted(() => "p");
      await render("tojson-calls-off", format, (logger) =>
        logger.info("m", { o: plainOff.value, p: primitiveOff.value, b: Buffer.from("x") }),
      );
      const bufferCallsOff = bufferToJSON.mock.calls.length;
      const plainOn = counted(() => ({ a: 1 }));
      const primitiveOn = counted(() => "p");
      await render(
        "tojson-calls-on",
        format,
        (logger) =>
          logger.info("m", { o: plainOn.value, p: primitiveOn.value, b: Buffer.from("x") }),
        ["password"],
      );
      const bufferCallsOn = bufferToJSON.mock.calls.length - bufferCallsOff;

      // Without a mask only the serializer calls it, once per chain.
      expect(plainOff.counter.calls).toBe(chains);
      expect(primitiveOff.counter.calls).toBe(chains);
      // With a mask the walk makes the call; an object result is then printed
      // from the walk's copy, a primitive result is resolved again by the serializer.
      expect(plainOn.counter.calls).toBe(chains);
      expect(primitiveOn.counter.calls).toBe(2 * chains);
      // A Buffer is never resolved by the walk.
      expect(bufferCallsOff).toBe(chains);
      expect(bufferCallsOn).toBe(chains);
    });

    it("fails closed for a nested toJSON, or a toJSON getter, that throws: only that value fails", async () => {
      const hostile = {
        toJSON: (): never => {
          throw new Error("toJSON refused");
        },
      };
      class HostileGetter {
        public get toJSON(): never {
          throw new Error("getter refused");
        }
      }

      const out = await render(
        "tojson-throws",
        format,
        (logger) =>
          logger.info("m", {
            hostile,
            getter: new HostileGetter(),
            orderId: 7,
            password: "S-T",
          }),
        ["password"],
      );

      expect(out.thrown).toBeUndefined();
      expect(metaOf(format, out.fileOut)).toEqual({
        hostile: "[RedactionFailed]",
        getter: "[RedactionFailed]",
        orderId: 7,
        password: "[REDACTED]",
      });
      expect(out.fileOut).not.toContain("S-T");
      expectConsoleMatchesFile(format, out);
    });

    it("without a mask, a throwing nested toJSON renders exactly as before", async () => {
      const hostile = {
        toJSON: (): never => {
          throw new Error("toJSON refused");
        },
      };

      const out = await render("tojson-throws-off", format, (logger) =>
        logger.info("m", { hostile, orderId: 7 }),
      );

      expect(out.thrown).toBeUndefined();
      expect(out.fileOut).toBe(
        format === "pretty"
          ? prettyLine("tojson-throws-off", "m\n[UNSERIALIZABLE]")
          : `{"level":"info","timestamp":"${STAMP}","module":"tojson-throws-off","_unserializable":true}\n`,
      );
      expectConsoleMatchesFile(format, out);
    });

    it("renders [Circular] for a value met again inside its own toJSON() output", async () => {
      class Loop {
        public toJSON(): Record<string, unknown> {
          return { self: this, kept: 1 };
        }
      }

      const out = await render(
        "tojson-loop",
        format,
        (logger) => logger.info("m", { loop: new Loop() }),
        ["password"],
      );

      expect(out.thrown).toBeUndefined();
      expect(metaOf(format, out.fileOut)).toEqual({ loop: { self: "[Circular]", kept: 1 } });
      expectConsoleMatchesFile(format, out);
    });

    it("reads an array's own toJSON the way the serializer does", async () => {
      const make = (): Record<string, unknown> => ({
        summarized: Object.assign([{ password: "S-ARRAY", keep: 1 }], {
          toJSON: () => ({ count: 1, password: "S-ARRAY-OUT" }),
        }),
        labelled: Object.assign(["a"], { toJSON: () => "summary" }),
        itself: Object.assign([{ password: "S-ARRAY-SELF", keep: 2 }], {
          toJSON(this: unknown[]): unknown[] {
            return this;
          },
        }),
      });

      const masked = await render("tojson-array", format, (logger) => logger.info("m", make()), [
        "password",
      ]);
      const unmasked = await render("tojson-array", format, (logger) => logger.info("m", make()));

      expect(masked.thrown).toBeUndefined();
      expect(metaOf(format, masked.fileOut)).toEqual({
        summarized: { count: 1, password: "[REDACTED]" },
        labelled: "summary",
        itself: [{ password: "[REDACTED]", keep: 2 }],
      });
      expect(masked.fileOut + masked.consoleOut).not.toMatch(/S-ARRAY/);
      expectConsoleMatchesFile(format, masked);
      // Without a mask the serializer prints the same shapes, secrets included.
      expect(metaOf(format, unmasked.fileOut)).toEqual({
        summarized: { count: 1, password: "S-ARRAY-OUT" },
        labelled: "summary",
        itself: [{ password: "S-ARRAY-SELF", keep: 2 }],
      });
    });

    it("walks an error a toJSON() returns the way the serializer renders it, leaving out the error's own toJSON", async () => {
      // The serializers' replacer renders an Error result through its field
      // view, where a function-valued `toJSON` field is simply omitted.
      const make = (): Record<string, unknown> => {
        const err = Object.assign(fixedError("x"), {
          details: {},
          toJSON: () => ({ password: "S-ERROR-JSON" }),
        });
        const agg = Object.assign(new AggregateError([fixedError("m")], "agg"), {
          stack: STACK,
          toJSON: () => ({ password: "S-AGGREGATE-JSON" }),
        });
        return { holder: { toJSON: () => err }, aggregate: { toJSON: () => agg } };
      };

      const masked = await render(
        "tojson-error-own",
        format,
        (logger) => logger.info("m", make()),
        ["password"],
      );
      const unmasked = await render("tojson-error-own", format, (logger) =>
        logger.info("m", make()),
      );

      expect(masked.thrown).toBeUndefined();
      expect(masked.fileOut).toBe(unmasked.fileOut);
      expect(masked.consoleOut).toBe(unmasked.consoleOut);
      expect(metaOf(format, masked.fileOut)).toEqual({
        holder: { name: "Error", message: "x", stack: STACK, details: {} },
        aggregate: {
          name: "AggregateError",
          message: "agg",
          stack: STACK,
          errors: [{ name: "Error", message: "m", stack: STACK }],
        },
      });
      expect(masked.fileOut + masked.consoleOut).not.toMatch(/S-ERROR-JSON|S-AGGREGATE-JSON/);
    });

    it("documented limits: a class instance's toJSON returning a masked field as a string, and a plain toJSON calling a method on a resolved nested value", async () => {
      // Masking matches keys: a string result has none, and a class
      // instance's toJSON runs on the instance. A plain object's toJSON runs
      // on the masked copy, where a nested toJSON value is already its output.
      class Token {
        public password = "S-LIMIT";
        public toJSON(): string {
          return this.password;
        }
      }
      class Money {
        public cents = 100;
        public toJSON(): Record<string, unknown> {
          return { cents: this.cents };
        }
        public format(): string {
          return `$${this.cents / 100}`;
        }
      }
      const make = (): Record<string, unknown> => ({
        token: new Token(),
        priced: {
          amount: new Money(),
          toJSON(this: { amount: Money }): Record<string, unknown> {
            return { display: this.amount.format() };
          },
        },
      });

      const masked = await render("tojson-limits", format, (logger) => logger.info("m", make()), [
        "password",
      ]);
      const unmasked = await render("tojson-limits", format, (logger) => logger.info("m", make()));

      expect(masked.thrown).toBeUndefined();
      expect(metaOf(format, masked.fileOut)).toEqual({
        token: "S-LIMIT",
        priced: "[RedactionFailed]",
      });
      expect(metaOf(format, unmasked.fileOut)).toEqual({
        token: "S-LIMIT",
        priced: { display: "$1" },
      });
      expectConsoleMatchesFile(format, masked);
    });

    it("keeps the depth bound across a chain of toJSON results", async () => {
      const chain = (n: number): unknown =>
        n === 0
          ? { leaf: "S-LEAF", password: "S-DEEP" }
          : { toJSON: () => ({ next: chain(n - 1) }) };

      const out = await render(
        "tojson-depth",
        format,
        (logger) => logger.info("m", { chain: chain(300) }),
        ["password"],
      );

      expect(out.thrown).toBeUndefined();
      expect(out.fileOut).toContain("[MaxDepth]");
      expect(out.fileOut).not.toContain("S-DEEP");
      expect(out.fileOut).not.toContain("S-LEAF");
    });
  });
});
