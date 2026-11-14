// The SF Symbols the inspectors drew in 0.90.34, as the lucide icons 2.0 draws (PLAN.md §4
// "Replaced": a fixed name table; the names a .bnet keeps are src/editor/pictures.ts's).
import type { LucideIcon } from "lucide-react";
import { Activity, AppWindow, AudioWaveform, ChartColumn, Circle, Diamond, Grid3x3, Minus, RectangleHorizontal, Columns3, Spline, TrendingDown, TrendingUp } from "lucide-react";
import type { NodeKind } from "../../lib/bnet";
import type { Distribution } from "./distributions";

/** `QueueDistribution.symbol` → lucide. */
export const FAMILY_ICONS: Record<Distribution, LucideIcon> = {
  exponential: TrendingDown, // chart.line.downtrend.xyaxis
  gamma: AudioWaveform, // waveform.path
  uniform: RectangleHorizontal, // rectangle.fill
  constant: Minus, // minus
  weibull: Activity, // waveform.path.ecg
  erlang: ChartColumn, // chart.bar.fill
  lognormal: TrendingUp, // chart.line.uptrend.xyaxis
  pareto: Spline, // chart.line.flattrend.xyaxis
  poisson: Grid3x3, // circle.grid.cross
};

/** `NodeKind.systemImage` → lucide: circle.fill, rectangle.split.3x1.fill, diamond.fill, app.fill. */
export const KIND_ICONS: Record<NodeKind, LucideIcon> = { station: Circle, buffer: Columns3, source: Diamond, sink: AppWindow };
