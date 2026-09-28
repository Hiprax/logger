import path from "node:path";
import ts from "typescript";

// The public types, as a consumer compiling with `exactOptionalPropertyTypes`
// sees them. Each fixture under `tests/fixtures/types/` is type-only (never
// executed) and is compiled here, in memory, with the repository's own
// tsconfig plus that flag. The root `tsc --noEmit` compiles the same fixtures
// with the flag off, so both settings are covered.
//
// Only the fixtures' own diagnostics are asserted. The program also type-checks
// the package's source, which is never compiled with this flag by a consumer
// (consumers read the published declarations), so its internal diagnostics
// under the flag are out of scope here.

const projectRoot = process.cwd();
const fixtureDir = path.join(projectRoot, "tests", "fixtures", "types");

const FIXTURES = {
  express: "eopt-express.ts",
  nodeHttp: "eopt-node-http.ts",
  options: "eopt-options.ts",
  explicitUndefined: "eopt-explicit-undefined.ts",
  misuse: "misuse.ts",
  control: "eopt-control.ts",
} as const;

type FixtureName = keyof typeof FIXTURES;

interface Compiled {
  program: ts.Program;
  sourceFiles: Record<FixtureName, ts.SourceFile | undefined>;
  diagnostics: Record<FixtureName, readonly ts.Diagnostic[]>;
}

const describeDiagnostic = (diagnostic: ts.Diagnostic): string => {
  const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, " ");
  if (diagnostic.file === undefined || diagnostic.start === undefined) {
    return `TS${diagnostic.code} ${message}`;
  }
  const { line } = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
  return `${path.basename(diagnostic.file.fileName)}:${line + 1} TS${diagnostic.code} ${message}`;
};

const compileFixtures = (): Compiled => {
  const configPath = path.join(projectRoot, "tsconfig.json");
  const read = ts.readConfigFile(configPath, (file) => ts.sys.readFile(file));
  if (read.error !== undefined) {
    throw new Error(describeDiagnostic(read.error));
  }
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, projectRoot);
  if (parsed.errors.length > 0) {
    throw new Error(parsed.errors.map(describeDiagnostic).join("\n"));
  }
  const names = Object.keys(FIXTURES) as FixtureName[];
  const program = ts.createProgram(
    names.map((name) => path.join(fixtureDir, FIXTURES[name])),
    { ...parsed.options, exactOptionalPropertyTypes: true, noEmit: true },
  );
  const sourceFiles = {} as Record<FixtureName, ts.SourceFile | undefined>;
  const diagnostics = {} as Record<FixtureName, readonly ts.Diagnostic[]>;
  for (const name of names) {
    const sourceFile = program.getSourceFile(path.join(fixtureDir, FIXTURES[name]));
    sourceFiles[name] = sourceFile;
    // Diagnostics are requested per SourceFile object, so a fixture is matched by
    // identity rather than by a path string (the Windows legs use backslashes).
    diagnostics[name] =
      sourceFile === undefined ? [] : ts.getPreEmitDiagnostics(program, sourceFile);
  }
  return { program, sourceFiles, diagnostics };
};

describe("public types under exactOptionalPropertyTypes", () => {
  let compiled: Compiled;

  // Building the program and checking every fixture takes a few seconds, so it
  // happens once, up front, with its own time budget.
  beforeAll(() => {
    compiled = compileFixtures();
  }, 60_000);

  it("compiles every fixture with the flag on and no configuration error", () => {
    expect(compiled.program.getCompilerOptions().exactOptionalPropertyTypes).toBe(true);
    for (const name of Object.keys(FIXTURES) as FixtureName[]) {
      expect(compiled.sourceFiles[name]).toBeDefined();
    }
    expect(compiled.program.getOptionsDiagnostics().map(describeDiagnostic)).toEqual([]);
    expect(compiled.program.getGlobalDiagnostics().map(describeDiagnostic)).toEqual([]);
  });

  it("the harness applies the flag: the control fixture reports exactly its one TS2375", () => {
    const sourceFile = compiled.sourceFiles.control as ts.SourceFile;
    const controlLine =
      sourceFile.text.split("\n").findIndex((line) => line.startsWith("export const control")) + 1;
    const reported = compiled.diagnostics.control.map((diagnostic) => {
      const { line } = sourceFile.getLineAndCharacterOfPosition(diagnostic.start as number);
      return { code: diagnostic.code, line: line + 1 };
    });
    expect(controlLine).toBeGreaterThan(0);
    expect(reported).toEqual([{ code: 2375, line: controlLine }]);
  });

  it("an Express app, a Router and a route-level mount take the middleware without a cast", () => {
    expect(compiled.diagnostics.express.map(describeDiagnostic)).toEqual([]);
  });

  it("a raw node:http server passes its request and response to the middleware without a cast", () => {
    expect(compiled.diagnostics.nodeHttp.map(describeDiagnostic)).toEqual([]);
  });

  it("every option of every public options type accepts a value that may be undefined", () => {
    expect(compiled.diagnostics.options.map(describeDiagnostic)).toEqual([]);
  });

  it("every optional property of every public interface accepts an explicit undefined", () => {
    expect(compiled.diagnostics.explicitUndefined.map(describeDiagnostic)).toEqual([]);
  });

  it("misuse is still rejected: every @ts-expect-error in the misuse fixture has its error", () => {
    expect(compiled.diagnostics.misuse.map(describeDiagnostic)).toEqual([]);
  });
});
