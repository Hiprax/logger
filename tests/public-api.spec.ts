import * as api from "../src/index";
import { __requestInternals } from "../src/request-middleware";

// The package's runtime surface is exactly what `src/index.ts` exports (the
// `exports` map has a single "." entry). Pinning the full list makes adding,
// removing or renaming an export a deliberate, reviewed change. `Object.entries`
// reads every export, which also runs each re-export binding.

describe("public runtime surface (src/index.ts)", () => {
  const exported = Object.fromEntries(Object.entries(api)) as Record<string, unknown>;

  it("exports exactly the documented runtime names, none of them undefined", () => {
    expect(Object.keys(exported).sort()).toEqual(
      [
        "DEFAULT_MASKED_BODY_KEYS",
        "DEFAULT_MASKED_HEADER_KEYS",
        "DEFAULT_MASKED_QUERY_KEYS",
        "InvalidTimezoneError",
        "LoggerOptionError",
        "REQUEST_START_SYMBOL",
        "RequestLoggerOptionError",
        "createLogger",
        "createNoopLogger",
        "createRequestLogger",
        "defaultRotation",
        "getDefaultRotation",
        "resetLoggerRegistry",
        "shutdownAllLoggers",
        "shutdownLogger",
      ].sort(),
    );
    for (const [name, value] of Object.entries(exported)) {
      expect({ name, defined: value !== undefined }).toEqual({ name, defined: true });
    }
  });

  it("exports the very default mask lists the middleware applies", () => {
    expect(exported.DEFAULT_MASKED_BODY_KEYS).toBe(__requestInternals.DEFAULT_MASKED_BODY_KEYS);
    expect(exported.DEFAULT_MASKED_HEADER_KEYS).toBe(__requestInternals.DEFAULT_MASKED_HEADER_KEYS);
    expect(exported.DEFAULT_MASKED_QUERY_KEYS).toBe(__requestInternals.DEFAULT_MASKED_QUERY_KEYS);
  });
});
