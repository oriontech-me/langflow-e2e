// Types for `tmp-dir.mjs`, so the TypeScript lanes can import the ONE
// implementation instead of a second copy of it (issue #1732).
//
// The copy this replaces was justified with a claim that is false: "Node 20
// cannot `require()` an ESM `.mjs`". It can, unflagged, since 20.19 — measured on
// this repo's 20.20.2 — and CI pins `node-version: "20"`, which resolves to the
// newest 20.x. What actually stood in the way was TYPES, and that costs a
// declaration file rather than a fork of the implementation.
//
// The distinction is not pedantry: a second copy meant the `.ts` lane's helper had
// no behavioural coverage at all, so deleting its exit hook would have leaked every
// directory `test:units` creates — including the suite's worst offender, 4480
// directories — with every test still green.

export declare function makeTempDir(prefix: string): string;
export declare function removeAllTempDirs(): void;
