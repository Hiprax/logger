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

const formatMessage = (ctx: TimestampContext) =>
  winston.format.printf((info) => {
    const utc = moment.utc().format(TIMESTAMP_FORMAT);
    const additionalZones = ctx.timezones.map(
      (zone) => `${zone}: ${moment().tz(zone).format(TIMESTAMP_FORMAT)}`,
    );
    const level = (info.level ?? "info").toUpperCase();
    const label = ctx.label;
    const message =
      typeof info.message === "string" ? info.message : JSON.stringify(info.message, null, 2);

    const { stack, level: _level, message: _msg, ...metadata } = info;
    const cleanedMeta = Object.keys(metadata).length > 0 ? metadata : undefined;

    const lines = [
      `UTC: ${utc}`,
      ...additionalZones.map((entry) => entry),
      `[${level}] (${label})`,
      message,
    ];

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
  const baseFormat = formatMessage(ctx);
  const sharedFormat = winston.format.combine(winston.format.errors({ stack: true }), baseFormat);
  const consoleFormat = winston.format.combine(
    winston.format.errors({ stack: true }),
    winston.format.colorize({ message: true }),
    baseFormat,
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

  return winston.createLogger({
    level,
    format: sharedFormat,
    transports,
    exitOnError: false,
  });
};

/** @internal */
export const __loggerInternals = {
  sanitizeSegment,
  buildLogFilePath,
  formatMessage,
};
