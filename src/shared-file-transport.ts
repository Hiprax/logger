import winston from "winston";

/**
 * Options accepted by the `winston-transport` base constructor that this module
 * uses. `log` and `close` let a transport be built from plain functions, so the
 * forwarding handle below needs no class (matching this package's functional
 * style).
 */
interface TransportStreamOptions {
  level?: string;
  log?: (info: unknown, next: () => void) => void;
  close?: () => void;
}

/**
 * The `winston-transport` base class, reached through `winston.Transport`
 * (re-exported by `winston/lib/winston.js`) rather than by importing
 * `winston-transport` directly. Two reasons:
 *
 * 1. `winston-transport` is a TRANSITIVE dependency — it is not in this
 *    package's `dependencies` — so importing it by name would be an undeclared
 *    dependency, and the bundler would inline its CommonJS body into the ESM
 *    build, where its internal `require("util")` throws at import time
 *    ("Dynamic require of \"util\" is not supported").
 * 2. Going through `winston` guarantees the exact same class object winston
 *    itself uses, so there is no risk of a duplicate copy from a differently
 *    hoisted install.
 *
 * The cast is required because winston's typings expose the class only under
 * the type-only alias `winston.transport`; the runtime value lives on the
 * capitalised `winston.Transport`.
 */
const TransportStream = (
  winston as unknown as {
    Transport: new (opts?: TransportStreamOptions) => winston.transport;
  }
).Transport;

/**
 * Shared, reference-counted global-log-file transports.
 *
 * ## Why this module exists
 *
 * Every logger created with `includeGlobalFile: true` writes to the SAME
 * resolved path (`<logDirectory>/<globalModuleName>-%DATE%.log`). Before
 * v1.0.0 each logger constructed its OWN `DailyRotateFile` for that one path,
 * so an app with one logger per module ended up with N open file handles and N
 * independent rotation state machines racing to rotate, size-check, and gzip
 * the same file.
 *
 * The obvious fix — hand the same `DailyRotateFile` instance to every logger —
 * is unsafe: winston's `Logger._final` calls `transport.end()` on every piped
 * transport, so shutting ONE logger down would end the shared transport and
 * silently destroy global-file logging for every other module (winston then
 * warns "Attempt to write logs with no transports" and drops the write).
 *
 * Instead each logger is piped a cheap per-logger **handle** — a plain
 * `winston-transport` whose `log()` forwards to the one shared transport. The
 * handle owns the per-logger stream lifecycle (winston may freely end it), and
 * the real transport is released only when the LAST handle lets go.
 */

/** One shared underlying transport plus its live handle bookkeeping. */
interface SharedFileEntry {
  /** The single real `DailyRotateFile` writing to `key`. */
  transport: winston.transport;
  /** Number of live handles still holding this entry open. */
  refCount: number;
  /** Live handles, used to fan out the shared transport's `error` events. */
  handles: Set<winston.transport>;
  /** Canonical rotation config of the creator, used to detect conflicts. */
  rotationSignature: string;
  /** Latches after the first conflicting-rotation warning for this path. */
  warned: boolean;
  /** The single `error` listener attached to {@link transport}. */
  errorListener: (err: Error) => void;
  /**
   * Memoised teardown, so the transport is closed at most once no matter how
   * many callers ask (last release AND the crash-exit flush can both fire).
   * Every caller awaits the SAME drain rather than racing a second `close()`.
   */
  closePromise?: Promise<void>;
}

const sharedFileRegistry = new Map<string, SharedFileEntry>();

/**
 * Tears the shared transport down and resolves once its bytes are actually on
 * disk. The transport's own `finish`/`close` is the signal.
 *
 * **`close()`, not `end()` — and that is deliberate.** `close()` is
 * `DailyRotateFile`'s direct drain (`logStream.end(() => this.emit("finish"))`,
 * `daily-rotate-file.js`), so it does not depend on the transport honoring the
 * `Writable._final` contract at all. That independence is the point: the
 * transports `logger.ts` builds are handed the `_final` the class itself omits
 * (see `installRotateFileFinal`), so `end()` would drain those too — but a
 * transport reaching this teardown from anywhere else has no such guarantee,
 * and `close()` covers both. Left as `end()` against a stock `DailyRotateFile`
 * this would emit `finish` on the next tick **while the underlying `logStream`
 * was still buffering** — verified: `end()` reports `finish` with 0 bytes
 * written, `close()` reports it with the bytes on disk — and the crash-exit path
 * (which calls `process.exit(1)` the moment this resolves) would race the write
 * and lose the record. `logStream` is created eagerly in the constructor, so
 * `close()` emits `finish` even on a transport that never wrote.
 */
const endSharedTransport = (entry: SharedFileEntry): Promise<void> => {
  if (entry.closePromise) {
    return entry.closePromise;
  }
  entry.closePromise = new Promise<void>((resolve) => {
    const transport = entry.transport as winston.transport & {
      end?: (cb?: () => void) => void;
      close?: () => void;
    };
    let settled = false;
    const settle = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      resolve();
    };
    transport.once("finish", settle);
    transport.once("close", settle);
    try {
      if (typeof transport.close === "function") {
        transport.close();
      } else if (typeof transport.end === "function") {
        transport.end();
      } else {
        settle();
      }
    } catch {
      // A transport already mid-teardown may throw on a second close/end; the
      // finish/close listeners above (or this settle) still release the caller.
      settle();
    }
  });
  return entry.closePromise;
};

/**
 * Closes and drains EVERY shared transport, regardless of refcount, resolving
 * once their bytes are on disk.
 *
 * **Exit path only.** Normal teardown is refcounted — a file stays open while
 * any logger still holds a handle. But when a fatal is about to call
 * `process.exit(1)`, every logger in the process is about to die, so the
 * refcount stops being a reason to keep buffering: draining only the crashing
 * logger's own handle would leave the shared `all-logs` file un-flushed
 * whenever ANY other logger still held a reference (i.e. always, in the
 * one-logger-per-module setup this package is built for) and the crash record
 * would be lost to `process.exit`.
 */
export const flushSharedFileTransportsForExit = (): Promise<void> =>
  Promise.all(
    Array.from(sharedFileRegistry.values()).map((entry) => endSharedTransport(entry)),
  ).then(() => undefined);

/**
 * Acquires a handle onto the shared transport for `key`, creating the
 * underlying transport on first acquisition. The returned handle is what gets
 * piped into the logger — never the shared transport itself.
 *
 * @param options.key - Resolved absolute global-log-file path (the share key).
 * @param options.level - The acquiring logger's level. Level gating happens on
 *   the handle, so loggers sharing one file keep independent levels.
 * @param options.rotationSignature - Canonical JSON of the acquiring logger's
 *   resolved global rotation config. A second acquisition with a different
 *   signature keeps the first logger's config and warns once.
 * @param options.createTransport - Factory for the real transport. Injected by
 *   the caller so this module does not depend on `logger.ts` (which would be a
 *   cycle) and stays trivially testable.
 */
export const acquireSharedGlobalFile = (options: {
  key: string;
  level: string;
  rotationSignature: string;
  createTransport: () => winston.transport;
}): winston.transport => {
  const { key, level, rotationSignature, createTransport } = options;

  let entry = sharedFileRegistry.get(key);
  if (!entry) {
    const transport = createTransport();
    const created: SharedFileEntry = {
      transport,
      refCount: 0,
      handles: new Set<winston.transport>(),
      rotationSignature,
      warned: false,
      // ONE `error` listener on the shared transport, fanned out to every live
      // handle. Attaching one listener per handle instead would put N
      // listeners on a single EventEmitter and re-create the very
      // MaxListenersExceededWarning this release exists to remove.
      errorListener: (err: Error): void => {
        if (created.handles.size === 0) {
          // Released, but the transport can still emit asynchronously while it
          // finishes pruning old files or gzipping a rotated one. With no live
          // handle to route to — and this being the transport's ONLY `error`
          // listener, since the shared transport is never piped into a logger —
          // detaching would leave an EventEmitter with zero error listeners and
          // turn the next such error into an `ERR_UNHANDLED_ERROR` throw that
          // takes the process down. Report through the bare console (never the
          // logger, to avoid recursion), matching `attachTransportErrorHandler`.
          console.error(
            `@hiprax/logger shared log file transport error after release: ${err && err.message ? err.message : String(err)}`,
          );
          return;
        }
        created.handles.forEach((handle) => {
          handle.emit("error", err);
        });
      },
    };
    transport.on("error", created.errorListener);
    sharedFileRegistry.set(key, created);
    entry = created;
  } else if (entry.rotationSignature !== rotationSignature && !entry.warned) {
    entry.warned = true;
    console.warn(
      `[@hiprax/logger] Conflicting global-file rotation config for ${JSON.stringify(key)}. ` +
        `The shared transport keeps the configuration it was created with; the new rotation options were ignored. ` +
        `Give the loggers different \`globalModuleName\` / \`logDirectory\` values if they need different rotation.`,
    );
  }

  const target = entry;
  let released = false;

  const release = (done: () => void): void => {
    if (released) {
      done();
      return;
    }
    released = true;
    target.handles.delete(handle);
    target.refCount -= 1;
    if (target.refCount > 0) {
      // Other loggers still write to this file; it must stay open. Their data
      // (and ours, already handed to the shared stream) is flushed when the
      // LAST handle releases.
      done();
      return;
    }
    // NOTE: `errorListener` is deliberately left attached. It is the shared
    // transport's only `error` listener, and the transport keeps emitting
    // asynchronously (prune / gzip) after release; see the listener itself.
    // Only drop the registry slot if it still points at THIS entry — a
    // `resetLoggerRegistry()` between acquisition and release may already have
    // cleared it, and a later logger may have installed a fresh entry for the
    // same path.
    if (sharedFileRegistry.get(key) === target) {
      sharedFileRegistry.delete(key);
    }
    void endSharedTransport(target).then(done);
  };

  const handle: winston.transport = new TransportStream({
    level,
    log: (info: unknown, next: () => void): void => {
      const sink = target.transport as winston.transport & {
        log?: (entry: unknown, cb: () => void) => void;
      };
      sink.log?.(info, () => undefined);
      next();
    },
    // winston-transport calls `close()` on `unpipe` (i.e. `logger.close()` /
    // `logger.clear()` / `logger.remove()`), and `teardownLogger`-style helpers
    // call it directly. `release` is idempotent, so both are safe.
    //
    // Emitting `finish` once the release completes mirrors `DailyRotateFile`'s
    // own contract — `close()` drains, then emits `finish` — so a caller that
    // flushes via `close()` (the crash-exit path does, because `end()` does not
    // actually drain a rotating file) gets a truthful settle signal instead of
    // waiting for an event that would never arrive.
    close: (): void => {
      release(() => {
        handle.emit("finish");
      });
    },
  });

  // Delay the handle's `finish` until the release completes. `logger.end()`
  // (what `shutdownLogger` uses) drives `Logger._final` -> `handle.end()` ->
  // this `_final`. Releasing here — and, on the LAST release, waiting for the
  // shared transport to finish — is what keeps `shutdownLogger`'s "resolves
  // once every transport has flushed" contract honest for the shared file.
  (handle as unknown as { _final: (cb: (err?: Error) => void) => void })._final = (cb) => {
    release(() => cb());
  };

  target.refCount += 1;
  target.handles.add(handle);
  return handle;
};

/**
 * Drops every shared-file registry slot WITHOUT closing the underlying
 * transports. Called by `resetLoggerRegistry()`, whose contract is that already
 * -created loggers keep working after a reset — closing their shared file out
 * from under them would break that. Each entry is still closed normally when
 * its last handle releases (via `shutdownLogger` / `logger.close()`).
 */
export const resetSharedFileRegistry = (): void => {
  sharedFileRegistry.clear();
};

/** @internal — test-only surface. */
export const __sharedFileInternals = {
  sharedFileRegistry,
  resetSharedFileRegistry,
};
