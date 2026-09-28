// Type-only fixture, never executed. `tests/consumer-types.spec.ts` compiles it
// with `exactOptionalPropertyTypes` on and expects zero diagnostics. Every
// option of every public options type receives a value that may be
// `undefined`, the way configuration read from the environment does.
import type winston from "winston";
import {
  createLogger,
  createRequestLogger,
  DEFAULT_MASKED_BODY_KEYS,
  shutdownAllLoggers,
  shutdownLogger,
  type LogLevel,
  type LoggableRequest,
  type LoggableResponse,
  type RequestLogEntry,
  type RequestLoggingMode,
  type RotationStrategy,
} from "../../../src/index";

declare const text: string | undefined;
declare const flag: boolean | undefined;
declare const level: LogLevel | undefined;
declare const list: string[] | undefined;
declare const count: number | undefined;
declare const transports: winston.transport[] | undefined;
declare const headerCapture: boolean | string[] | undefined;
declare const onTransportError: ((err: Error, transport: winston.transport) => void) | undefined;
declare const clock: (() => Date) | undefined;
declare const format: "pretty" | "json" | undefined;
declare const mode: RequestLoggingMode | undefined;
declare const skip: ((req: LoggableRequest, res: LoggableResponse) => boolean) | undefined;
declare const enrich:
  | ((req: LoggableRequest, res: LoggableResponse, durationMs: number) => Record<string, unknown>)
  | undefined;

export const rotation: RotationStrategy = {
  maxSize: text,
  maxFiles: text,
  datePattern: text,
  zippedArchive: flag,
};

export const logger = createLogger({
  moduleName: text,
  logDirectory: text,
  level,
  consoleLevel: level,
  includeConsole: flag,
  includeFile: flag,
  includeGlobalFile: flag,
  globalModuleName: text,
  extraTimezones: text,
  rotation,
  globalRotation: rotation,
  additionalTransports: transports,
  onTransportError,
  clock,
  captureUncaught: flag,
  exitOnUncaught: flag,
  colorize: { level: flag, message: flag, all: flag },
  maskMetaKeys: list,
  format,
  escapeMessageNewlines: flag,
});

export const middleware = createRequestLogger({
  logger,
  level,
  label: text,
  messageBuilder: (entry: RequestLogEntry) => `${entry.method} ${entry.ip ?? "-"}`,
  skip,
  enrich,
  includeRequestHeaders: headerCapture,
  includeResponseHeaders: headerCapture,
  includeRequestBody: flag,
  maxBodyLength: count,
  maskBodyKeys: list,
  maskHeaderKeys: list,
  maskQueryKeys: list,
  redactPaths: list,
  loggingEnabled: flag,
  loggingMode: mode,
  includeHttpContext: flag,
});

export const bodyMaskingOff = createRequestLogger({ maskBodyKeys: false });

export const bodyMaskingExtended = createRequestLogger({
  maskBodyKeys: [...DEFAULT_MASKED_BODY_KEYS, "ssn"],
});

export const byEnvironment = createRequestLogger({
  loggingMode: { sources: list, allow: list, fallback: flag },
});

export const shutdown = async (): Promise<void> => {
  await shutdownLogger(logger, { timeoutMs: count });
  await shutdownAllLoggers({ timeoutMs: count });
};
