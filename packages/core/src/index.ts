/**
 * @aero-autopilot/core, root barrel. Subpath imports
 * (`@aero-autopilot/core/math`, `/model`, `/strategies`, `/scheduler`,
 * `/backtest`, `/data`, `/fixtures`) are preferred; the root re-exports
 * everything for convenience.
 */

export * from "./math/index.js";
export * from "./model/index.js";
export * from "./scheduler/index.js";
export * from "./strategies/index.js";
export * from "./backtest/index.js";
export * from "./data/index.js";
export * from "./fixtures/index.js";
