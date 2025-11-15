import fs from "node:fs";
import path from "node:path";
import winston from "winston";
import DailyRotateFile from "winston-daily-rotate-file";
import moment from "moment-timezone";
import { InvalidTimezoneError } from "./errors";
import type { LoggerOptions, TimestampContext, LogLevel, RotationStrategy } from "./types";

const TIMESTAMP_FORMAT = "YYYY-MM-DD HH:mm:ss";
const DEFAULT_LOG_DIR = path.resolve(process.cwd(), "logs");

const defaultRotation = Object.freeze({
  maxSize: "20m",
  maxFiles: "14d",
  datePattern: "YYYY-MM-DD",
  zippedArchive: false,
});

const ensureDirectory = (dir: string) => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
};

const sanitizeSegment = (value: string) => {
  const cleaned = value
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "-")
    .replace(/\s+/g, "-")
    .replace(/\.+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-]+|[-]+$/g, "")
    .trim();
  return cleaned || "logs";
};

const buildLogFilePath = (baseDir: string, name: string) => {
  const segments = name
    .split(/[\\/]+/)
    .filter(Boolean)
    .map((segment) => sanitizeSegment(segment));

  const relative = segments.length ? segments.join(path.sep) : sanitizeSegment(name || "logs");
  return path.join(baseDir, `${relative}-%DATE%.log`);
};

const normalizeTimezones = (zones?: string | string[]): string[] => {
  if (!zones) {
    return [];
  }

  const list = Array.isArray(zones) ? zones : [zones];
  const unique = Array.from(new Set(list.map((zone) => zone.trim()).filter(Boolean)));

  unique.forEach((zone) => {
    if (!moment.tz.zone(zone)) {
      throw new InvalidTimezoneError(zone);
    }
  });

  return unique;
};

interface FormatOptions {
  includeTimestamps?: boolean;
}

const formatMessage = (ctx: TimestampContext, options: FormatOptions = {}) =>
  winston.format.printf((info) => {
    const { includeTimestamps = true } = options;
    const level = (info.level ?? "info").toUpperCase();
    const label = ctx.label;
    const message =
      typeof info.message === "string" ? info.message : JSON.stringify(info.message, null, 2);

    const { stack, level: _level, message: _msg, ...metadata } = info;
    const cleanedMeta = Object.keys(metadata).length > 0 ? metadata : undefined;

    const lines: string[] = [];

    if (includeTimestamps) {
      const utc = moment.utc().format(TIMESTAMP_FORMAT);
      const additionalZones = ctx.timezones.map(
        (zone) => `${zone}: ${moment().tz(zone).format(TIMESTAMP_FORMAT)}`,
      );
      lines.push(`UTC: ${utc}`, ...additionalZones.map((entry) => entry));
    }

    lines.push(`[${level}] (${label})`, message);

    if (stack) {
      lines.push(typeof stack === "string" ? stack : JSON.stringify(stack, null, 2));
    }

    if (cleanedMeta) {
      lines.push(JSON.stringify(cleanedMeta, null, 2));
    }

    return `${lines.join("\n")}\n`;
  });

const buildRotateTransport = (options: {
  filename: string;
  level: LogLevel;
  rotation?: typeof defaultRotation | RotationStrategy;
}) => {
  const rotation = { ...defaultRotation, ...options.rotation };

  return new DailyRotateFile({
    filename: options.filename,
    datePattern: rotation.datePattern,
    maxSize: rotation.maxSize,
    maxFiles: rotation.maxFiles,
    zippedArchive: rotation.zippedArchive,
    level: options.level,
  });
};

/**
 * Creates a fully configured Winston logger with safe defaults, rotating files,
 * UTC timestamps, and optional timezone mirrors.
 *
 * @example
 * ```ts
 * import { createLogger } from '@hiprax/logger';
 *
 * const securityLogger = createLogger({
 *   moduleName: 'security/failedLogins',
 *   extraTimezones: ['Europe/London'],
 *   logDirectory: './logs'
 * });
 *
 * securityLogger.warn('Failed login attempt detected');
 * ```
 */
export const createLogger = (options: LoggerOptions = {}): winston.Logger => {
  const {
    moduleName = "global",
    logDirectory = DEFAULT_LOG_DIR,
    level = "info",
    consoleLevel = level,
    includeConsole = true,
    includeFile = true,
    includeGlobalFile = true,
    globalModuleName = "all-logs",
    extraTimezones,
    rotation = defaultRotation,
    globalRotation,
    additionalTransports = [],
  } = options;

  ensureDirectory(logDirectory);

  const timezones = normalizeTimezones(extraTimezones);
  const label = moduleName === "global" ? "GLOBAL" : moduleName;
  const ctx: TimestampContext = { label, timezones };
  const fileFormat = formatMessage(ctx);
  const sharedFormat = winston.format.combine(winston.format.errors({ stack: true }), fileFormat);
  const consoleMessageFormat = formatMessage(ctx, { includeTimestamps: false });
  const consoleFormat = winston.format.combine(
    winston.format.errors({ stack: true }),
    winston.format.colorize({ message: true }),
    consoleMessageFormat,
  );

  const transports: winston.transport[] = [];

  if (includeConsole) {
    transports.push(
      new winston.transports.Console({
        level: consoleLevel,
        handleExceptions: true,
        format: consoleFormat,
      }),
    );
  }

  const moduleFilename = buildLogFilePath(logDirectory, moduleName);
  const globalFilename = buildLogFilePath(logDirectory, globalModuleName);

  ensureDirectory(path.dirname(moduleFilename));
  ensureDirectory(path.dirname(globalFilename));

  if (includeFile) {
    transports.push(
      buildRotateTransport({
        filename: moduleFilename,
        level,
        rotation,
      }),
    );
  }

  if (includeGlobalFile) {
    transports.push(
      buildRotateTransport({
        filename: globalFilename,
        level,
        rotation: globalRotation ?? rotation,
      }),
    );
  }

  if (additionalTransports.length) {
    transports.push(...additionalTransports);
  }

  const baseLogger = winston.createLogger({
    level,
    format: sharedFormat,
    transports,
    exitOnError: false,
  });

  const warnedMethods = new Set<string>();

  const emitUnknownMethodWarning = (method: string) => {
    if (warnedMethods.has(method)) {
      return;
    }
    warnedMethods.add(method);
    const warningMessage = `Unknown logger method "${method}" called. Falling back to info().`;
    if (typeof baseLogger.warn === "function") {
      baseLogger.warn(warningMessage);
    } else {
      console.warn(warningMessage);
    }
  };

  const ensureLogArgs = (incoming: unknown[]): [any, ...any[]] => {
    if (incoming.length === 0) {
      return [""];
    }
    return incoming as [any, ...any[]];
  };

  const toMessageString = (value: unknown): string => {
    if (typeof value === "string") {
      return value;
    }
    try {
      const serialized = JSON.stringify(value);
      if (typeof serialized === "string") {
        return serialized;
      }
    } catch {
      // fall through to final string coercion
    }
    return String(value ?? "");
  };

  const invokeInfoFallback = (args: unknown[]) => {
    const infoArgs = ensureLogArgs(args);
    if (typeof baseLogger.info === "function") {
      return (baseLogger.info as (...inner: any[]) => winston.Logger)(...infoArgs);
    }
    if (typeof baseLogger.log === "function") {
      const [message, ...rest] = infoArgs;
      const normalizedMessage = toMessageString(message);
      if (rest.length > 0) {
        return (baseLogger.log as winston.LeveledLogMethod)("info", normalizedMessage, ...rest);
      }
      return baseLogger.log({
        level: "info",
        message: normalizedMessage,
      });
    }
    console.warn("Logger fallback invoked but no info/log method was available.");
    return undefined;
  };

  return new Proxy(baseLogger, {
    get(target, prop, receiver) {
      if (typeof prop === "string" && !(prop in target)) {
        return (...args: unknown[]) => {
          emitUnknownMethodWarning(prop);
          return invokeInfoFallback(args);
        };
      }

      const value = Reflect.get(target, prop, receiver);

      if (typeof value === "function") {
        return value.bind(target);
      }

      return value;
    },
  }) as winston.Logger;
};

/** @internal */
export const __loggerInternals = {
  sanitizeSegment,
  buildLogFilePath,
  formatMessage,
};
