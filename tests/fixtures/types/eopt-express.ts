// Type-only fixture, never executed. `tests/consumer-types.spec.ts` compiles it
// with `exactOptionalPropertyTypes` on and expects zero diagnostics; the root
// tsconfig compiles it with the flag off. It mounts the middleware the ways an
// Express application does, with no cast at any mount site.
import express, { Router, type RequestHandler } from "express";
import { createRequestLogger } from "../../../src/index";

export const app = express();
app.use(express.json());
app.use(createRequestLogger({ includeHttpContext: true, includeRequestBody: true }));

export const router = Router();
router.use(createRequestLogger());
router.post("/login", createRequestLogger({ label: "login" }), (_req, res) => {
  res.json({ ok: true });
});

export const handler: RequestHandler = createRequestLogger();
