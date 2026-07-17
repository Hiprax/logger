import fs from "node:fs";
import path from "node:path";

interface PkgExportCondition {
  types: string;
  default: string;
}

interface PkgDotExport {
  import: PkgExportCondition;
  require: PkgExportCondition;
}

interface PkgExports {
  ".": PkgDotExport;
}

interface Pkg {
  exports: PkgExports;
}

const projectRoot = process.cwd();
const pkg = JSON.parse(fs.readFileSync(path.join(projectRoot, "package.json"), "utf-8")) as Pkg;
const distDir = path.join(projectRoot, "dist");
const dotExport = pkg.exports["."];

describe("package.json exports map", () => {
  describe("import condition (ESM consumers)", () => {
    it("resolves types to the ESM declaration file", () => {
      expect(dotExport.import.types).toBe("./dist/index.d.ts");
    });

    it("resolves default to the ESM runtime bundle", () => {
      expect(dotExport.import.default).toBe("./dist/index.mjs");
    });
  });

  describe("require condition (CJS consumers)", () => {
    it("resolves types to the CJS declaration file — fixes CJS TS consumers under moduleResolution node16/nodenext", () => {
      expect(dotExport.require.types).toBe("./dist/index.d.cts");
    });

    it("resolves default to the CJS runtime bundle", () => {
      expect(dotExport.require.default).toBe("./dist/index.cjs");
    });
  });

  describe("declaration files present on disk (post-build)", () => {
    // CI builds before it tests (the Build step precedes Test in both ci.yml and
    // release.yml), so dist/ is present and these assertions run there. Under CI
    // the skip is DISABLED: `it` is used unconditionally, so if a future workflow
    // edit ever reorders Test ahead of Build, dist/ is absent on the fresh
    // checkout and these assertions FAIL loudly instead of silently skipping —
    // the only automated guard that Build-before-Test stays in place, since a
    // skipped test keeps CI green and a tsup regression dropping index.d.cts
    // would then publish the TS1479 failure this spec exists to catch. Locally
    // (`npm test` with no prior build, no CI env) it still skips gracefully; run
    // `npm run build` first to exercise these assertions locally.
    const isCI = process.env.CI === "true";
    const itWhenDist = fs.existsSync(distDir) || isCI ? it : it.skip;

    itWhenDist("dist/index.d.ts exists (ESM declaration)", () => {
      expect(fs.existsSync(path.join(distDir, "index.d.ts"))).toBe(true);
    });

    itWhenDist("dist/index.d.cts exists (CJS declaration)", () => {
      expect(fs.existsSync(path.join(distDir, "index.d.cts"))).toBe(true);
    });
  });
});
