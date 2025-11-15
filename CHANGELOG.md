# Changelog

## v0.6.0

- Console transport remains enabled by default, but its formatter now omits timestamps so only rotating files carry the time metadata (as requested).
- Added graceful fallbacks for unknown logger methods (unknown calls emit a warning and re-route to `info()`).
- Introduced `loggingEnabled`, `loggingMode`, and `includeHttpContext` options for `createRequestLogger`, enabling boolean toggles and environment-aware logging (with `'dev-only'`, `'prod-only'`, and `'test-only'` presets plus custom rules).
- Request HTTP metadata is now opt-in and no longer emitted unless `includeHttpContext` is true.
- Documentation refreshed to cover the new behavior and defaults.

## v0.5.0 (Initial Release)

- Initial release of the @hiprax/logger package.
