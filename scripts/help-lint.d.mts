// Types of scripts/help-lint.mjs, for src/test/help-content.test.ts.
export interface HelpManifestEntry {
  id: string;
  title: string;
  section: string;
  file: string;
  keywords: string[];
  kind: "topic" | "method" | "guide";
  windowTitle?: string;
  subtitle?: string;
  label?: string;
}
export interface HelpLintInput {
  manifest: unknown;
  files: Record<string, string>;
  sources?: Record<string, string>;
}
export const KINDS: string[];
export const GENERATED: Record<string, string>;
export const CLAIM_TOPICS: string[];
export function lintHelp(input: HelpLintInput): string[];
export function readRepository(root?: string): HelpLintInput & { missing?: string };
export function lintRepository(root?: string): string[];
