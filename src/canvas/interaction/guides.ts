// The drag's side of the smart guides (canvas.md §9, §12.2): the match and the per-axis helpers
// are the geometry area's (src/canvas/geometry/guides.ts, 0.90.34 `SmartGuides`); the drag calls
// them from `moveAnchoredNodes` and stores the result with `editor.setView({ activeAlignGuides })`.
export { dropX, dropY, GUIDE_TOLERANCE, guidesEmpty, matchGuides } from "../geometry/guides";
export { NO_GUIDES } from "../../editor";
