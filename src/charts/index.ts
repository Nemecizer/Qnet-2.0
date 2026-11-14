// The chart primitives (new in 2.1, ROADMAP B1): hand-built SVG in React, coloured only by the
// tokens in src/styles.css, each with a keyboard read-out and a table alternative, and each
// exportable through `chartSvgString`.
export { extent, finite, niceStep, niceTicks, stepDecimals, linearScale, bandScale, tickLabel, type Ticks, type LinearScale, type BandScale } from "./scale";
export { v, CHART_FONT, SIZE, TIER_STYLE, SERIES_COUNT, SERIES_SHAPES, seriesToken, lightValue, fitText, type MarkShape, type Interval } from "./theme";
export { ChartFrame, type FrameSize } from "./ChartFrame";
export { ChartShell, nextMark, headerHeight, type Mark, type TableAlternative } from "./ChartShell";
export { ValueAxisX, ValueAxisY, axisXHeight } from "./axis";
export { Legend, legendLayout, HatchDefs, type LegendItem } from "./Legend";
export { Shape, shapePath } from "./shapes";
export { BarChart, barLayout, barTable, type BarChartProps, type BarRow, type BarSeries, type BarDatum } from "./BarChart";
export { DotInterval, dotLayout, dotTable, type DotIntervalProps, type DotRow, type DotSeries, type DotValue } from "./DotInterval";
export { LineChart, lineLayout, lineTable, type LineChartProps, type LineSeries, type LinePoint, type LineRule } from "./LineChart";
export { chartSvgString, chartSvgElement, resolveTokens, CHART_PAPER, CHART_MARGIN } from "./svgString";
