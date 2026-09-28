// Type-only fixture, never executed. `tests/consumer-types.spec.ts` compiles it
// with `exactOptionalPropertyTypes` on and expects zero diagnostics: each
// `@ts-expect-error` below must still find its error, or TypeScript reports the
// unused directive (TS2578). Accepting `undefined` must not make the options
// accept anything else.
import { createLogger, createRequestLogger } from "../../../src/index";

export const misuse = (): void => {
  // @ts-expect-error a bare string is not a list of paths
  createRequestLogger({ redactPaths: "body.password" });
  // @ts-expect-error not a log level
  createLogger({ level: "verbose2" });
  // @ts-expect-error true is not a mask list (only false opts out)
  createRequestLogger({ maskHeaderKeys: true });
  // @ts-expect-error true is not a mask list
  createRequestLogger({ maskBodyKeys: true });
  // @ts-expect-error the body limit is a number
  createRequestLogger({ maxBodyLength: "3000" });
};
