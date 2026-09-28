// Type-only fixture, never executed. `tests/consumer-types.spec.ts` compiles it
// with `exactOptionalPropertyTypes` on and expects zero diagnostics. Each line
// asserts that EVERY optional property of a public interface accepts an
// explicit `undefined`. The keys come from `keyof`, so an option added later
// is covered without editing this file. The two optional methods
// (`LoggableRequest.get`, `LoggableResponse.getHeaders`) are left out: a method
// signature cannot carry `| undefined`, and callers always either provide one
// or leave it out.
import type {
  LoggableRequest,
  LoggableResponse,
  LoggerOptions,
  RequestLogEntry,
  RequestLoggerOptions,
  RequestLoggingEnvironmentConfig,
  RotationStrategy,
  ShutdownOptions,
} from "../../../src/index";

/** The keys of `T` whose property is optional. */
type OptionalKeys<T> = {
  [K in keyof T]-?: Record<never, never> extends Pick<T, K> ? K : never;
}[keyof T];

/**
 * `true` when an object that sets every optional property of `T` to
 * `undefined` is assignable to `T`. With the flag off this is always `true`;
 * with it on, one optional property without `| undefined` makes it `false`.
 */
type AcceptsExplicitUndefined<T> =
  Record<OptionalKeys<T>, undefined> extends Pick<T, OptionalKeys<T>> ? true : false;

export const loggerOptions: AcceptsExplicitUndefined<LoggerOptions> = true;
export const colorizeObject: AcceptsExplicitUndefined<
  Exclude<NonNullable<LoggerOptions["colorize"]>, boolean>
> = true;
export const rotationStrategy: AcceptsExplicitUndefined<RotationStrategy> = true;
export const shutdownOptions: AcceptsExplicitUndefined<ShutdownOptions> = true;
export const requestLoggerOptions: AcceptsExplicitUndefined<RequestLoggerOptions> = true;
export const environmentConfig: AcceptsExplicitUndefined<RequestLoggingEnvironmentConfig> = true;
export const requestLogEntry: AcceptsExplicitUndefined<RequestLogEntry> = true;
export const loggableRequest: AcceptsExplicitUndefined<Omit<LoggableRequest, "get">> = true;
export const requestSocket: AcceptsExplicitUndefined<NonNullable<LoggableRequest["socket"]>> = true;
export const loggableResponse: AcceptsExplicitUndefined<Omit<LoggableResponse, "getHeaders">> =
  true;
