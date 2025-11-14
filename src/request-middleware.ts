import type { Request, Response, NextFunction } from "express";
import type {
  ExpressMiddleware,
  RequestLogEntry,
  RequestLoggerOptions,
  RequestLogEvent,
} from "./types";
import { createLogger } from "./logger";
import type { LogLevel } from "./types";

const DEFAULT_BODY_LIMIT = 3000;

const determineLevel = (statusCode: number): LogLevel => {
  if (statusCode >= 500) {
    return "error";
  }
  if (statusCode >= 400) {
    return "warn";
  }
  return "info";
};

const redactValue = (
  value: unknown,
  maskKeys: Set<string>,
  seen: WeakSet<object>
): unknown => {
  if (!value || typeof value !== "object") {
    return value;
  }

  if (seen.has(value as object)) {
    return "[Circular]";
  }
  seen.add(value as object);

  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, maskKeys, seen));
  }

  return Object.entries(value as Record<string, unknown>).reduce<
    Record<string, unknown>
  >((acc, [key, val]) => {
    acc[key] = maskKeys.has(key.toLowerCase())
      ? "[REDACTED]"
      : redactValue(val, maskKeys, seen);
    return acc;
  }, {});
};

const serializeBody = (
  body: unknown,
  maskKeys?: string[],
  maxLength = DEFAULT_BODY_LIMIT
) => {
  if (body === undefined || body === null) {
    return undefined;
  }

  const masked = redactValue(
    body,
    new Set((maskKeys ?? []).map((key) => key.toLowerCase())),
    new WeakSet()
  );

  try {
    const serialized =
      typeof masked === "string" ? masked : JSON.stringify(masked);
    if (serialized.length > maxLength) {
      return `${serialized.slice(0, maxLength)}…`;
    }
    return typeof masked === "string" ? masked : JSON.parse(serialized);
  } catch {
    const fallback = String(masked);
    return fallback.length > maxLength
      ? `${fallback.slice(0, maxLength)}…`
      : fallback;
  }
};

const normalizeHeaders = (
  headers: Record<string, unknown> | undefined,
  include?: boolean | string[]
) => {
  if (!include) {
    return undefined;
  }

  const allowEmpty = include === true;
  const ensureReturn = (record: Record<string, unknown>) => {
    if (Object.keys(record).length > 0) {
      return record;
    }
    return allowEmpty ? {} : undefined;
  };

  if (!headers) {
    return allowEmpty ? {} : undefined;
  }

  const normalized = Object.entries(headers).reduce<Record<string, unknown>>(
    (acc, [key, val]) => {
      acc[key.toLowerCase()] = val;
      return acc;
    },
    {}
  );

  if (include === true) {
    return ensureReturn(normalized);
  }

  /* c8 ignore next */
  const allowList = Array.isArray(include) ? include : [];
  const filtered = allowList.reduce<Record<string, unknown>>((acc, key) => {
    const normalizedKey = key.toLowerCase();
    if (normalized[normalizedKey] !== undefined) {
      acc[normalizedKey] = normalized[normalizedKey];
    }
    return acc;
  }, {});

  return ensureReturn(filtered);
};

const toNumber = (value: unknown): number | undefined => {
  if (value === undefined || value === null) {
    return undefined;
  }
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : undefined;
};

const buildDefaultMessage = (entry: RequestLogEntry) => {
  const base = `${entry.method} ${entry.url}`;
  return `${base} ${entry.statusCode} ${entry.responseTimeMs.toFixed(2)}ms (${
    entry.event
  })`;
};

/**
 * Creates an Express compatible middleware that logs HTTP requests and responses
 * using the configured Winston logger.
 */
export const createRequestLogger = (
  options: RequestLoggerOptions = {}
): ExpressMiddleware => {
  const {
    logger = createLogger({
      /* c8 ignore next */
      moduleName: options.label ? `http/${options.label}` : "http",
    }),
    level,
    messageBuilder = buildDefaultMessage,
    skip,
    enrich,
    includeRequestHeaders,
    includeResponseHeaders,
    includeRequestBody,
    maxBodyLength = DEFAULT_BODY_LIMIT,
    maskBodyKeys,
  } = options;

  return (req: Request, res: Response, next: NextFunction) => {
    if (skip?.(req, res)) {
      return next();
    }

    const start = process.hrtime.bigint();
    const initialContentLength = toNumber(req.headers["content-length"]);
    let handled = false;

    const finalize = (event: RequestLogEvent) => {
      /* c8 ignore start */
      if (handled) {
        return;
      }
      /* c8 ignore end */
      handled = true;

      res.removeListener("finish", finishHandler);
      res.removeListener("close", closeHandler);

      const durationNs = Number(process.hrtime.bigint() - start);
      const durationMs = durationNs / 1_000_000;

      const statusCode = res.statusCode ?? 0;
      const resolvedLevel =
        typeof level === "function"
          ? level(statusCode)
          : level ?? determineLevel(statusCode);

      const entry: RequestLogEntry = {
        event,
        method: req.method ?? "GET",
        url: req.originalUrl ?? req.url ?? "",
        statusCode,
        responseTimeMs: Number(durationMs.toFixed(2)),
        contentLength:
          toNumber(res.getHeader("content-length")) ?? initialContentLength,
        ip: req.ip ?? req.socket?.remoteAddress ?? undefined,
        userAgent:
          /* c8 ignore next */
          typeof req.get === "function"
            ? req.get("user-agent") ?? undefined
            : (
                req.headers["user-agent"] as string | string[] | undefined
              )?.toString(),
        requestId:
          /* c8 ignore next */
          typeof req.get === "function"
            ? req.get("x-request-id") ?? undefined
            : (
                req.headers["x-request-id"] as string | string[] | undefined
              )?.toString(),
      };

      if (includeRequestBody) {
        entry.requestBody = serializeBody(
          req.body,
          maskBodyKeys,
          maxBodyLength
        );
      }

      entry.requestHeaders = normalizeHeaders(
        req.headers as Record<string, unknown>,
        includeRequestHeaders
      );
      entry.responseHeaders = normalizeHeaders(
        res.getHeaders(),
        includeResponseHeaders
      );

      if (enrich) {
        /* c8 ignore next */
        entry.context = enrich(req, res, durationMs) ?? undefined;
      }

      const message = messageBuilder(entry);

      logger.log({
        level: resolvedLevel,
        message,
        http: entry,
      });
    };

    const finishHandler = () => finalize("completed");
    const closeHandler = () => finalize("aborted");

    res.once("finish", finishHandler);
    res.once("close", closeHandler);

    return next();
  };
};

/** @internal */
export const __requestInternals = {
  determineLevel,
  redactValue,
  serializeBody,
  normalizeHeaders,
  toNumber,
  buildDefaultMessage,
};
