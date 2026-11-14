// The canvas bench (ledger CAN-206 / CAN-208, canvas.md §17): times the shipping route plan, scene
// build, grid path and hit test on the 200-node / 400-link network of src/canvas/geometry/bench.ts,
// against 0.90.34's recorded budget (route plan 4.2 ms, scene build 0.29 ms, grid 0.002–0.055 ms,
// hit test 0.015–0.017 ms). Run from qnet/:
//
//   node scripts/canvas-bench.ts
//
// Node ≥ 23.6 strips the types itself; the resolve hook below lets the extensionless imports the
// app's sources use ("./outline") find their .ts files, so the measured code is the shipped code.
// 0.90.34's own numbers for the very same network on this Mac: scripts/canvas-synthetic.swift `bench`.
import { registerHooks } from "node:module";

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (e) {
      if (specifier.startsWith(".") && !specifier.endsWith(".ts")) return nextResolve(`${specifier}.ts`, context);
      throw e;
    }
  },
});

const { runBench } = await import("../src/canvas/geometry/bench.ts");

const r = runBench();
const f = (x: number) => x.toFixed(3);
console.log("200 nodes / 400 links, viewport 1600x1000 (0.90.34's budget in brackets)");
console.log(`  route plan (once per layout change): ${f(r.planMs)} ms  [4.2]   bowed ${r.bowed} of 400`);
console.log(`  drag re-plan (per frame, if it were live): ${f(r.dragReplanMs)} ms  [4.1]   plan interpolation: ${f(r.interpolateMs)} ms  [0.03]`);
for (const s of r.perScale) {
  console.log(`  scale ${Math.round(s.scale * 100)}%: scene build ${f(s.sceneMs)} ms [0.29] | grid path ${f(s.gridMs)} ms [≤0.055] | hit test ${f(s.hitMs)} ms [≤0.017]`);
}
