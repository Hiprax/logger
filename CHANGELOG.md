# Changelog

## v0.7.0

### Added

- **Logger instance registry**: `createLogger()` now caches instances by `moduleName` + `logDirectory`. Calling it with the same configuration returns the same logger, preventing duplicate transports, file handles, and console output across modules.
- **`resetLoggerRegistry()`**: New exported function to clear the logger cache, useful for testing or hot-reload scenarios.
- **`ExpressMiddleware` type export**: The `ExpressMiddleware` type alias is now re-exported from the package barrel for consumers who need to type the return value of `createRequestLogger()`.
- **`lint` and `type-check` scripts**: Added `npm run lint` and `npm run type-check` commands to `package.json`.

### Fixed

- **TOCTOU race condition** in `ensureDirectory()`: Removed the `existsSync` guard in favor of calling `mkdirSync({ recursive: true })` directly, which is idempotent and eliminates the race window (`src/logger.ts`).
- **`serializeBody` unnecessary JSON round-trip**: Object bodies within the size limit are now returned directly instead of going through a `JSON.stringify` → `JSON.parse` cycle (`src/request-middleware.ts`).
- **`.npmignore` test directory**: Changed `__tests__/` to `tests/` to match the actual directory name.
- **Unused `NextFunction` import** removed from `src/types.ts`.

### Changed

- **ESLint migrated to flat config**: Replaced legacy `.eslintrc.cjs` with `eslint.config.mjs` for ESLint v9 compatibility. Added `typescript-eslint` and `@eslint/js` as dev dependencies.

## v0.6.0

- Console transport remains enabled by default, but its formatter now omits timestamps so only rotating files carry the time metadata (as requested).
- Added graceful fallbacks for unknown logger methods (unknown calls emit a warning and re-route to `info()`).
- Introduced `loggingEnabled`, `loggingMode`, and `includeHttpContext` options for `createRequestLogger`, enabling boolean toggles and environment-aware logging (with `'dev-only'`, `'prod-only'`, and `'test-only'` presets plus custom rules).
- Request HTTP metadata is now opt-in and no longer emitted unless `includeHttpContext` is true.
- Documentation refreshed to cover the new behavior and defaults.

## v0.5.0 (Initial Release)

- Initial release of the @hiprax/logger package.
