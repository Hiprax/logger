import type winston from 'winston';
import type { Request, Response, NextFunction, RequestHandler } from 'express';

export type LogLevel =
  | 'error'
  | 'warn'
  | 'info'
  | 'http'
  | 'verbose'
  | 'debug'
  | 'silly';

export interface RotationStrategy {
  /**
   * Maximum size of a single log file before rotation occurs.
   * Accepts values such as `20m`, `200k`, etc.
   */
  maxSize?: string;
  /**
   * Maximum number of files to keep. Can be specified in days (e.g., `14d`)
   * or as a numeric count (`7`).
   */
  maxFiles?: string;
  /**
   * Pattern used to name rotated files. Defaults to YYYY-MM-DD.
   */
  datePattern?: string;
  /**
   * Whether rotated files should be zipped.
   */
  zippedArchive?: boolean;
}

export interface LoggerOptions {
  moduleName?: string;
  /**
   * Directory to store log files. Created automatically when missing.
   */
  logDirectory?: string;
  /**
   * Logging level for all transports.
   */
  level?: LogLevel;
  /**
   * Logging level used specifically for the console transport.
   */
  consoleLevel?: LogLevel;
  /**
   * Enables or disables the console transport.
   */
  includeConsole?: boolean;
  /**
   * Enables or disables the module specific rotating file transport.
   */
  includeFile?: boolean;
  /**
   * Enables or disables the shared/global rotating file transport.
   */
  includeGlobalFile?: boolean;
  /**
   * Name used for the aggregated log file.
   */
  globalModuleName?: string;
  /**
   * Additional IANA timezones to render alongside UTC in the log output.
   */
  extraTimezones?: string | string[];
  /**
   * Rotation tuning for the module specific transport.
   */
  rotation?: RotationStrategy;
  /**
   * Rotation tuning for the global transport. Falls back to `rotation` when omitted.
   */
  globalRotation?: RotationStrategy;
  /**
   * Provides custom Winston transports that will be appended to the logger.
   */
  additionalTransports?: winston.transport[];
}

export interface TimestampContext {
  label: string;
  timezones: string[];
}

export type RequestLogEvent = 'completed' | 'aborted';

export interface RequestLogEntry {
  event: RequestLogEvent;
  method: string;
  url: string;
  statusCode: number;
  responseTimeMs: number;
  contentLength?: number;
  ip?: string;
  userAgent?: string;
  requestId?: string;
  requestBody?: unknown;
  requestHeaders?: Record<string, unknown>;
  responseHeaders?: Record<string, unknown>;
  context?: Record<string, unknown>;
}

export interface RequestLoggerOptions {
  /**
   * Custom logger instance. When omitted a scoped logger will be created automatically.
   */
  logger?: winston.Logger;
  /**
   * Overrides the log level or dynamically derives it from the response status code.
   */
  level?: LogLevel | ((statusCode: number) => LogLevel);
  /**
   * Adds a label to differentiate multiple middleware instances.
   */
  label?: string;
  /**
   * Customizes the log message string.
   */
  messageBuilder?: (entry: RequestLogEntry) => string;
  /**
   * Provides an escape hatch to skip logging for specific requests.
   */
  skip?: (req: Request, res: Response) => boolean;
  /**
   * Injects additional context into the structured payload.
   */
  enrich?: (req: Request, res: Response, durationMs: number) => Record<string, unknown>;
  /**
   * When true, includes request headers. Provide an allow list to control which keys to emit.
   */
  includeRequestHeaders?: boolean | string[];
  /**
   * When true, includes response headers. Provide an allow list to control which keys to emit.
   */
  includeResponseHeaders?: boolean | string[];
  /**
   * When true, logs the parsed request body. Provide an allow list of keys to redact everything else.
   */
  includeRequestBody?: boolean;
  /**
   * Max serialized body length to guard against huge payloads.
   */
  maxBodyLength?: number;
  /**
   * Keys within the request body that should be replaced with `[REDACTED]`.
   */
  maskBodyKeys?: string[];
}

export type ExpressMiddleware = RequestHandler;

