import type winston from "winston";
import { flushSharedFileTransportsForExit } from "./shared-file-transport";

/**
 * Process-wide crash-capture coordinator.
 *
 * ## Why this module exists
 *
 * Winston installs its own `process.on("uncaughtException")` /
 * `process.on("unhandledRejection")` listener **per logger instance** whenever
 * a transport carries the `handleExceptions` / `handleRejections` flags (see
 * `winston/lib/winston/logger.js` `add()` → `exceptions.handle()`). An
 * application that creates one logger per module therefore accumulates one
 * listener pair per module, and Node emits a `MaxListenersExceededWarning`
 * once the count passes the default limit of 10.
 *
 * This coordinator replaces that per-logger wiring with a single
 * process-owned listener pair. Every capture-enabled logger registers here
 * instead of asking winston to install its own handler; the flags are never
 * set on any transport, so winston installs **zero** process listeners. When a
 * fatal event fires, the crash is recorded **once** through a single elected
 * logger (the {@link getPrimaryEntry primary}) and — unless the primary opted out —
 * the process is flushed and terminated with exit code `1`, restoring Node's
 * default crash-on-fatal semantics.
 *
 * ## Instance scope
 *
 * The coordinator's state is module-level, so it is a singleton **per module
 * instance**. A consumer that loads both the ESM and CJS builds of this
 * package into the same process gets two independent coordinators (one listener
 * pair each) — the same inherent limitation the logger registry already has.
 */

/** Per-logger crash-capture policy recorded at registration time. */
interface CrashCapturePolicy {
  /**
   * Whether this logger writes to a file (module-scoped and/or the shared
   * global log). Used to elect a primary that can PERSIST the crash — see
   * {@link getPrimaryEntry}.
   */
  hasFileTransport: boolean;
  /**
   * When `true` (the default), a fatal event routed through this logger — when
   * it is the elected primary — flushes the logger and terminates the process
   * with exit code `1` after the crash is logged. When `false`, the crash is
   * logged and the process is left running (the pre-v1.0.0 "limp on" behavior).
   */
  exitOnUncaught: boolean;
}

/**
 * Maximum time (ms) the exit path waits for the primary logger's transports to
 * flush the crash record before terminating the process. Mirrors the 3000 ms
 * budget winston's own `ExceptionHandler._uncaughtException` uses.
 */
const EXIT_FLUSH_TIMEOUT_MS = 3000;

/**
 * Insertion-ordered map of registered **base** winston loggers (never the
 * public Proxy — the Proxy mints no-op shims for unknown property reads, which
 * would corrupt the bookkeeping and the `logger.exceptions` access below) to
 * the policy each registered with. A `Map` (rather than a `Set` plus a side
 * lookup) keeps insertion order — the first entry is the
 * {@link getPrimaryEntry primary} — while guaranteeing a registered logger always
 * has its policy available in the same read.
 */
const registered = new Map<winston.Logger, CrashCapturePolicy>();

/**
 * The installed process listeners, or `null` when the coordinator is not
 * installed. This single nullable slot IS the installed/not-installed state —
 * there is no separate boolean to drift out of sync with it.
 */
let handlersInstalled: {
  uncaught: (err: Error) => void;
  unhandled: (reason: unknown) => void;
} | null = null;

/**
 * Latches once the exit path has begun so a second fatal event fired during
 * the flush-then-exit window does not start a competing exit race. Only the
 * exit path latches — a logged-but-not-exited fatal (opt-out) leaves this
 * `false` so subsequent fatals are still captured.
 */
let exiting = false;

/**
 * The real process-exit behavior. Named (rather than inlined into the
 * `exitProcess` initializer) so `restoreExitFn` restores the SAME function
 * identity the module started with, instead of minting a second, separately
 * tracked copy of the same body.
 */
const defaultExitProcess = (code: number): void => {
  process.exit(code);
};

/**
 * Indirection over `process.exit` so tests can observe the exit decision
 * without terminating the jest runner. Overridable via
 * {@link __crashCaptureInternals}.setExitFn.
 */
let exitProcess: (code: number) => void = defaultExitProcess;

/**
 * Returns the elected primary logger and its policy — or `undefined` when no
 * logger is registered.
 *
 * Election order, first match wins, registration order breaking ties:
 * 1. A logger with a **file** transport. Because only the primary records the
 *    crash, electing a console-only logger while a file-backed one exists would
 *    mean the trace never reaches disk and is gone the moment the terminal
 *    scrolls. Preferring files preserves this package's long-standing promise
 *    that a crash is "persisted across restarts" — pre-v1.0.0 the same
 *    preference was expressed per-logger, by routing winston's exception flags
 *    to file transports ahead of the console.
 * 2. Any logger with at least one transport. A logger with none —
 *    `createLogger({ includeConsole: false, includeFile: false,
 *    includeGlobalFile: false })` and no `additionalTransports` — can physically
 *    record nothing; winston would just warn "Attempt to write logs with no
 *    transports" and drop the crash.
 * 3. Otherwise the first registered logger, so the exit policy is still honored
 *    even when nothing can be written.
 */
const getPrimaryEntry = (): [winston.Logger, CrashCapturePolicy] | undefined => {
  let firstWritable: [winston.Logger, CrashCapturePolicy] | undefined;
  let first: [winston.Logger, CrashCapturePolicy] | undefined;
  for (const entry of registered) {
    if (!first) {
      first = entry;
    }
    if (entry[0].transports.length === 0) {
      continue;
    }
    if (entry[1].hasFileTransport) {
      return entry;
    }
    if (!firstWritable) {
      firstWritable = entry;
    }
  }
  return firstWritable ?? first;
};

/**
 * Tears a transport down and resolves once its bytes are actually out. Used
 * only on the terminal exit path, so the listeners it attaches are never
 * cleaned up — the process is about to end.
 *
 * **Prefers `close()` over `end()`, and that is deliberate.** `close()` is a
 * `DailyRotateFile`'s direct drain (`logStream.end(() => this.emit("finish"))`),
 * so it holds without the transport honoring the `Writable._final` contract.
 * The rotating transports `logger.ts` builds are given the `_final` the class
 * omits (see `installRotateFileFinal`), so `end()` drains those as well; a
 * transport that arrives here from anywhere else carries no such guarantee, and
 * a stock `DailyRotateFile` would emit `finish` on the next tick while its
 * `logStream` was still buffering — awaiting that and then calling
 * `process.exit(1)` races the write and loses the crash record. `close()` is
 * correct for both, and the shared-global-file handle mirrors the same
 * contract. Transports with no `close()` (winston's `Console`, most custom
 * ones) buffer nothing that survives the tick and do emit `finish` from
 * `end()`.
 */
const settleTransport = (transport: winston.transport): Promise<void> =>
  new Promise<void>((resolve) => {
    const target = transport as winston.transport & {
      close?: () => void;
      end?: () => void;
    };
    const done = (): void => resolve();
    transport.once("finish", done);
    transport.once("close", done);
    try {
      if (typeof target.close === "function") {
        target.close();
      } else if (typeof target.end === "function") {
        target.end();
      } else {
        resolve();
      }
    } catch {
      // A transport already mid-teardown may throw; the listeners above (or
      // this resolve) still release the exit path.
      resolve();
    }
  });

/**
 * Drains the primary logger's transports — and every shared global file — then
 * terminates the process, bounded by {@link EXIT_FLUSH_TIMEOUT_MS} so a stuck
 * transport cannot wedge the exit, and finally calls {@link exitProcess}.
 */
const flushThenExit = (logger: winston.Logger): void => {
  // Drain each transport directly rather than via `logger.end()`: winston's
  // `Logger._final` calls `transport.end()`, which does NOT flush a rotating
  // file (see `settleTransport`). Each transport subscribes before it is torn
  // down, so a synchronous settle cannot be missed.
  // Drain the primary's own transports AND every shared global-file transport.
  // The latter is not redundant: shared files are refcounted, so releasing just
  // this logger's handle leaves the file open (and its buffer un-flushed)
  // whenever another logger still holds a reference — which, in the
  // one-logger-per-module setup this package targets, is the normal case. Since
  // `process.exit(1)` is about to take every logger down anyway, the refcount is
  // no longer a reason to keep the crash record buffered.
  const transports = [...logger.transports];
  const settled = Promise.all([
    ...transports.map((transport) => settleTransport(transport)),
    flushSharedFileTransportsForExit(),
  ]).then(() => undefined);

  // The timer is deliberately NOT `unref()`'d. This is the terminal path: it
  // must hold the event loop open until we actually call `exitProcess`. An
  // unref'd timer would let an otherwise-idle process fall off the end of the
  // loop and exit **0** — reporting success for a run that died of an uncaught
  // exception — precisely in the stuck-transport case the timeout exists for.
  // (winston's own equivalent is ref'd too.) It is cleared as soon as the race
  // settles so it never delays a healthy exit or outlives the flush in tests.
  let timeoutHandle: NodeJS.Timeout | undefined;
  const timeout = new Promise<void>((resolve) => {
    timeoutHandle = setTimeout(resolve, EXIT_FLUSH_TIMEOUT_MS);
  });

  void Promise.race([settled, timeout]).then(() => {
    if (timeoutHandle !== undefined) {
      clearTimeout(timeoutHandle);
    }
    exitProcess(1);
  });
};

/**
 * Records the crash through the elected primary logger exactly once, then —
 * when the primary opted into exit semantics — flushes and terminates the
 * process. Never throws: logging must not turn a recoverable capture into a
 * hard crash-in-the-crash-handler.
 */
const onFatal = (kind: "uncaughtException" | "unhandledRejection", err: unknown): void => {
  const primaryEntry = getPrimaryEntry();
  if (!primaryEntry) {
    return;
  }
  const [primary, policy] = primaryEntry;

  // `exceptions.getAllInfo` / `rejections.getAllInfo` are public winston APIs
  // (declared in winston's shipped typings) and pure — they build the full
  // structured payload winston's own handler would log: the multi-line
  // `<kind>: <message>` string, the parsed `stack` / `trace`, and the
  // `process` / `os` diagnostic blocks.
  const handler = kind === "uncaughtException" ? primary.exceptions : primary.rejections;
  let info: Record<string, unknown>;
  try {
    info = handler.getAllInfo(err as Error) as Record<string, unknown>;
  } catch {
    info = {
      level: "error",
      message: `${kind}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // Re-key winston's reserved `exception` / `rejection` markers. Those flags
  // exist ONLY to route an info object to transports carrying
  // `handleExceptions` — and `winston-transport`'s `_accept` / `_write`
  // (modern.js) actively DROP an `{ exception: true }` info from any transport
  // that lacks the flag. Because this package sets that flag on no transport
  // (owning crash capture here instead of via winston's per-logger listener),
  // leaving the marker in place would make the crash silently vanish from every
  // transport. We strip the reserved markers and surface the same information
  // under a non-filtered `crash` field so the crash is written to ALL of the
  // primary's transports as a normal error-level entry, and consumers can still
  // detect and branch on it.
  // `level` is pinned to "error" rather than carried from `rest`: a captured
  // fatal is error-level by definition, and both of winston's `getAllInfo`
  // implementations already hardcode `level: "error"` — as does the synthetic
  // fallback above — so this is the same value in every path, stated once and
  // unconditionally instead of via a branch that could never take its else arm.
  const { exception: _exception, rejection: _rejection, ...rest } = info;
  const entry = { ...rest, level: "error", crash: kind };

  try {
    (primary.log as (entry: unknown) => unknown)(entry);
  } catch {
    // Swallow — a transport that throws synchronously must not escalate into an
    // exception thrown from inside the process fatal-event listener.
  }

  // The primary's policy governs the process-level exit decision; `exiting`
  // latches so a second fatal during the flush window cannot race a second exit.
  if (!policy.exitOnUncaught || exiting) {
    return;
  }
  exiting = true;
  flushThenExit(primary);
};

const install = (): void => {
  if (handlersInstalled) {
    return;
  }
  const uncaught = (err: Error): void => onFatal("uncaughtException", err);
  const unhandled = (reason: unknown): void => onFatal("unhandledRejection", reason);
  process.on("uncaughtException", uncaught);
  process.on("unhandledRejection", unhandled);
  handlersInstalled = { uncaught, unhandled };
};

const uninstall = (): void => {
  if (!handlersInstalled) {
    return;
  }
  process.removeListener("uncaughtException", handlersInstalled.uncaught);
  process.removeListener("unhandledRejection", handlersInstalled.unhandled);
  handlersInstalled = null;
};

/**
 * Registers a base winston logger for process-wide crash capture. Installs the
 * single process-listener pair lazily on the first registration. Idempotent:
 * re-registering the same logger updates its policy without adding a second
 * listener.
 */
export const registerCrashCapture = (logger: winston.Logger, policy: CrashCapturePolicy): void => {
  registered.set(logger, policy);
  install();
};

/**
 * Deregisters a base winston logger. Uninstalls the process-listener pair once
 * the last capture-enabled logger is gone, so a process that shuts every logger
 * down returns to zero package-owned process listeners. A no-op for a logger
 * that was never registered.
 */
export const deregisterCrashCapture = (logger: winston.Logger): void => {
  if (!registered.delete(logger)) {
    return;
  }
  if (registered.size === 0) {
    uninstall();
  }
};

/**
 * Clears all crash-capture state and uninstalls the process-listener pair.
 * Called by `resetLoggerRegistry()` so a full registry reset also releases the
 * coordinator (closing the listener-orphan leak that a bare cache-clear would
 * otherwise leave behind).
 */
export const resetCrashCapture = (): void => {
  registered.clear();
  uninstall();
  exiting = false;
};

/** @internal — test-only surface. */
export const __crashCaptureInternals = {
  registered,
  getPrimaryEntry,
  install,
  uninstall,
  resetCrashCapture,
  /** Registers a raw logger-shaped stub, for exercising defensive paths. */
  registerCrashCapture,
  /** Overrides the process-exit indirection so tests never terminate the runner. */
  setExitFn: (fn: (code: number) => void): void => {
    exitProcess = fn;
  },
  /** Restores the real `process.exit` indirection. */
  restoreExitFn: (): void => {
    exitProcess = defaultExitProcess;
  },
  /** Invokes the uncaught-exception path directly (what the process listener runs). */
  invokeUncaught: (err: unknown): void => onFatal("uncaughtException", err),
  /** Invokes the unhandled-rejection path directly (what the process listener runs). */
  invokeUnhandled: (reason: unknown): void => onFatal("unhandledRejection", reason),
  isInstalled: (): boolean => handlersInstalled !== null,
  EXIT_FLUSH_TIMEOUT_MS,
};
