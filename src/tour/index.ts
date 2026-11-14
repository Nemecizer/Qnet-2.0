// The guided first model (new in 2.1, ROADMAP C2; ledger UX-201…): App.tsx mounts `<TourHost />`,
// which registers `tour:start` (Help ▸ Guided Tour; the Welcome view's "Take the Tour").
export { TourHost } from "./TourHost";
export { startTour, endTour, tourCompleted, tourOffered, useTourOffered, COMPLETED_KEY, SEEN_KEY } from "./state";
export { tourWords } from "./words";
