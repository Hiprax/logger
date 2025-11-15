import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import winston from "winston";
import DailyRotateFile from "winston-daily-rotate-file";
import { createLogger, __loggerInternals } from "../src/logger";
import { InvalidTimezoneError } from "../src/errors";

const createTempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "adv-logger-"));
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

const shutdownLogger = (logger: winston.Logger) => {
  logger.close();
  logger.transports.forEach((transport: winston.transport) => {
    if (typeof (transport as { close?: () => void }).close === "function") {
      (transport as { close: () => void }).close();
    }
  });
};

describe("createLogger", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("creates the log directory when missing", () => {
    const root = createTempDir();
    const target = path.join(root, "logs-output");
    fs.rmSync(target, { recursive: true, force: true });

    const logger = createLogger({
      logDirectory: target,
      includeConsole: false,
      includeFile: false,
      includeGlobalFile: false,
    });

    expect(fs.existsSync(target)).toBe(true);
    shutdownLogger(logger);
  });

  it("creates nested directories for scoped module names", () => {
    const root = createTempDir();
    const logger = createLogger({
      logDirectory: root,
      moduleName: "security/failedLogins",
      includeConsole: false,
      includeFile: false,
      includeGlobalFile: false,
    });

    expect(fs.existsSync(path.join(root, "security"))).toBe(true);
    shutdownLogger(logger);
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
    shutdownLogger(logger);
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
    shutdownLogger(logger);

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
    shutdownLogger(logger);
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
    shutdownLogger(logger);

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
    shutdownLogger(logger);
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
    shutdownLogger(logger);

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
    shutdownLogger(logger);

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
    shutdownLogger(logger);
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
    shutdownLogger(logger);

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
    shutdownLogger(logger);
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
    shutdownLogger(logger);
  });

  it("preserves metadata when fallback logging receives extra arguments", () => {
    const logger = createNoopTransportLogger();

    const logSpy = jest.fn();
    (logger as any).info = undefined;
    (logger as any).log = logSpy;

    const meta = { requestId: "abc" };
    (logger as any).phantom("hello", meta);

    expect(logSpy).toHaveBeenCalledWith("info", "hello", meta);
    shutdownLogger(logger);
  });

  it("injects an empty message when fallback is invoked without arguments", () => {
    const logger = createNoopTransportLogger();

    const infoSpy = jest.fn();
    (logger as any).info = infoSpy;

    (logger as any).void();

    expect(infoSpy).toHaveBeenCalledWith("");
    shutdownLogger(logger);
  });

  it("warns only once per unknown method", () => {
    const logger = createNoopTransportLogger();
    const warnSpy = jest.fn();
    (logger as any).warn = warnSpy;

    (logger as any).mystery();
    (logger as any).mystery();

    expect(warnSpy).toHaveBeenCalledTimes(1);
    shutdownLogger(logger);
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
    shutdownLogger(logger);
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
    shutdownLogger(logger);
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
    shutdownLogger(logger);
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
    shutdownLogger(logger);
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
    shutdownLogger(logger);
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
  });
});
