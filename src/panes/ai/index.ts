// The AI Assistant pane (PLAN.md §7 P7; ledger §13.3–§13.6, §8.12).
export { AIPane } from "./AIPane";
export { cancelRequest as stopAiRequest, isBusy as aiBusy, getAiState, resetAi } from "./model";
export { aiWords } from "./words";
export { AiKeyField, AiModelRefresh, AiTestConnection, flushPendingKey } from "./settingsControls";
// Explaining (new in 2.1, ROADMAP E4): the "Explain" affordance other views carry.
export { ExplainButton, explainWithAssistant, type ExplainAbout } from "./explain/open";
