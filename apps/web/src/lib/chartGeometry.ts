/**
 * Shared horizontal geometry for the time-series panels: the equity chart's
 * plot area and the heat-map's cell grid use the same left inset and right
 * pad, so a given date sits on the same vertical line in both. The heat-map's
 * pool-label column and the chart's y-axis gutter both occupy TIME_AXIS_LEFT.
 */

/** Left edge of the shared time axis (pool labels / y-axis gutter live inside it). */
export const TIME_AXIS_LEFT = 170;
/** Right padding after the last time point. */
export const TIME_AXIS_RIGHT_PAD = 12;
/** Width of the equity chart's y-axis tick column (inside TIME_AXIS_LEFT). */
export const Y_AXIS_WIDTH = 70;
