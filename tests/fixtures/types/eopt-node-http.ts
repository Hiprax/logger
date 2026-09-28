// Type-only fixture, never executed. `tests/consumer-types.spec.ts` compiles it
// with `exactOptionalPropertyTypes` on and expects zero diagnostics. A raw
// `node:http` server hands its `IncomingMessage` / `ServerResponse` to the
// middleware with no cast.
import http from "node:http";
import { createRequestLogger } from "../../../src/index";

const middleware = createRequestLogger({ includeHttpContext: true });

export const server = http.createServer((req, res) => {
  middleware(req, res, () => {
    res.end();
  });
});
