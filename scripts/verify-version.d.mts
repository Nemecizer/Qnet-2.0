// Types of scripts/verify-version.mjs, for src/test/verify-version.test.ts.
export interface VersionSite {
  file: string;
  where: string;
  version: string;
}
export interface VersionCheck {
  /** src-tauri/tauri.conf.json's version, or null when it could not be read. */
  version: string | null;
  sites: VersionSite[];
  problems: string[];
}
export const SOURCE: string;
export const FIXED_FILES: string[];
export function workspaceMembers(rootCargo: string): string[];
export function checkVersions(files: Record<string, string>): VersionCheck;
export function readRepository(root?: string): Record<string, string>;
export function verifyRepository(root?: string): VersionCheck;
export function checkBundle(app: string, version: string): { problems: string[]; checked: number };
