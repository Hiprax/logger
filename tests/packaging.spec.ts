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
    // Skipped when dist/ is absent (CI runs npm test before npm run build).
    // Run `npm run build` first to exercise these assertions locally.
    const itWhenDist = fs.existsSync(distDir) ? it : it.skip;

    itWhenDist("dist/index.d.ts exists (ESM declaration)", () => {
      expect(fs.existsSync(path.join(distDir, "index.d.ts"))).toBe(true);
    });

    itWhenDist("dist/index.d.cts exists (CJS declaration)", () => {
      expect(fs.existsSync(path.join(distDir, "index.d.cts"))).toBe(true);
    });
  });
});
