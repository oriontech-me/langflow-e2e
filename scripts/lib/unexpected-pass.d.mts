// Types for unexpected-pass.mjs — see scripts/lib/tmp-dir.d.mts for why the `.mjs`
// helpers carry a hand-written declaration rather than being compiled.
export declare const UNEXPECTED_PASS_SIGNATURE: string;
export declare function isUnexpectedPass(test: unknown): boolean;
export declare function collectUnexpectedPasses(report: unknown): Array<{
  file: string;
  line: number;
  title: string;
  attempts: number;
  passedAttempts: number;
}>;
export declare function isUnexpectedPassEntry(entry: unknown): boolean;
