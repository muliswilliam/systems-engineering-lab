// Lab 41 self-check: this lab makes no correctness claim that is
// automatically machine-gradable (system-design answers are open-ended),
// but two things about its own drills ARE machine-checkable and worth
// checking automatically so this lab does not silently drift out of sync
// with the other 40 labs as they change:
//
//   1. Every "Lab NN" citation in every drill actually points at a lab
//      directory that exists under labs/ - if a future rename/renumber
//      of an earlier lab breaks a citation here, this catches it instead
//      of leaving a dangling reference in a written answer.
//   2. The drills, taken together, cite a broad cross-section of the
//      curriculum's phases (SPEC.md's Phase 1-11), not just one corner of
//      it - operationalizing the "range of difficulty/scope, and a range
//      of the concepts this curriculum actually taught" requirement this
//      lab was built against.
//
// This is deliberately NOT a grader for the drills' own reasoning - see
// the README's "Architecture" section for why building one would be the
// wrong kind of machinery for an open-ended design question.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const labDir = path.resolve(here, "..");
export const repoRoot = path.resolve(labDir, "../..");
export const drillsDir = path.join(labDir, "drills");

// SPEC.md's own Phase groupings (Phase 11 is this lab's own phase, the
// capstone lab 40 is its own final entry in Phase 11 too).
export const PHASES: Array<{ name: string; from: number; to: number }> = [
  { name: "Phase 1 - Postgres/Drizzle foundations", from: 1, to: 4 },
  { name: "Phase 2 - Transactions and concurrency", from: 5, to: 9 },
  { name: "Phase 3 - Locks and concurrency control", from: 10, to: 13 },
  { name: "Phase 4 - Background work and messaging", from: 14, to: 20 },
  { name: "Phase 5 - Caching and distributed coordination", from: 21, to: 22 },
  { name: "Phase 6 - Connections and Postgres scaling", from: 23, to: 28 },
  { name: "Phase 7 - Safe schema evolution", from: 29, to: 30 },
  { name: "Phase 8 - Postgres operations and performance", from: 31, to: 35 },
  { name: "Phase 9 - Reliability engineering", from: 36, to: 37 },
  { name: "Phase 10 - Observability and security", from: 38, to: 39 },
  { name: "Phase 11 - Capstone", from: 40, to: 40 },
];

export interface DrillCitations {
  file: string;
  labNumbers: number[];
}

export interface CitationReport {
  existingLabNumbers: Set<number>;
  perDrill: DrillCitations[];
  allCitedNumbers: Set<number>;
  unknownCitations: Array<{ file: string; labNumber: number }>;
  coveredPhases: string[];
}

const REQUIRED_HEADINGS = [
  "## Prompt",
  "## Model answer",
  "### 1. Invariants",
  "### 2. Consistency requirements",
  "### 3. Storage choice",
  "### 4. Concurrency mechanism",
  "### 5. Failure modes",
  "### 6. Scale estimate",
  "### 7. Observability",
  "## Common wrong answer",
  "## Interview questions",
];

function listExistingLabNumbers(): Set<number> {
  const numbers = new Set<number>();
  const labsPath = path.join(repoRoot, "labs");
  for (const entry of readdirSync(labsPath, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const match = entry.name.match(/^(\d{2})-/);
    const digits = match?.[1];
    if (digits) numbers.add(Number.parseInt(digits, 10));
  }
  return numbers;
}

function listDrillFiles(): string[] {
  return readdirSync(drillsDir)
    .filter((name) => name.endsWith(".md"))
    .sort()
    .map((name) => path.join(drillsDir, name));
}

function extractLabNumbers(markdown: string): number[] {
  const numbers: number[] = [];
  const pattern = /\bLabs?\s+(\d{1,2}(?:\s*\/\s*\d{1,2})*)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(markdown)) !== null) {
    const group = match[1];
    if (!group) continue;
    for (const raw of group.split("/")) {
      numbers.push(Number.parseInt(raw.trim(), 10));
    }
  }
  return numbers;
}

export function missingHeadings(markdown: string): string[] {
  return REQUIRED_HEADINGS.filter((heading) => !markdown.includes(heading));
}

export function buildCitationReport(): CitationReport {
  const existingLabNumbers = listExistingLabNumbers();
  const perDrill: DrillCitations[] = [];
  const allCitedNumbers = new Set<number>();
  const unknownCitations: Array<{ file: string; labNumber: number }> = [];

  for (const filePath of listDrillFiles()) {
    const markdown = readFileSync(filePath, "utf8");
    const file = path.basename(filePath);
    const labNumbers = extractLabNumbers(markdown);
    perDrill.push({ file, labNumbers });
    for (const n of labNumbers) {
      allCitedNumbers.add(n);
      if (!existingLabNumbers.has(n)) {
        unknownCitations.push({ file, labNumber: n });
      }
    }
  }

  const coveredPhases = PHASES.filter((phase) =>
    [...allCitedNumbers].some((n) => n >= phase.from && n <= phase.to),
  ).map((phase) => phase.name);

  return { existingLabNumbers, perDrill, allCitedNumbers, unknownCitations, coveredPhases };
}

function main() {
  const report = buildCitationReport();
  console.log(`Labs found under labs/: ${report.existingLabNumbers.size}`);
  console.log(`Drills checked: ${report.perDrill.length}`);
  console.log(`Distinct labs cited across all drills: ${report.allCitedNumbers.size}`);
  console.log(`Phases covered: ${report.coveredPhases.length} / ${PHASES.length}`);
  for (const phase of PHASES) {
    const hit = report.coveredPhases.includes(phase.name);
    console.log(`  [${hit ? "x" : " "}] ${phase.name}`);
  }
  if (report.unknownCitations.length > 0) {
    console.error("Unknown lab citations found:");
    for (const u of report.unknownCitations) {
      console.error(`  ${u.file} cites "Lab ${String(u.labNumber).padStart(2, "0")}", which does not exist under labs/`);
    }
    process.exitCode = 1;
  }
  for (const drill of report.perDrill) {
    const markdown = readFileSync(path.join(drillsDir, drill.file), "utf8");
    const missing = missingHeadings(markdown);
    if (missing.length > 0) {
      console.error(`${drill.file} is missing required section(s): ${missing.join(", ")}`);
      process.exitCode = 1;
    }
  }
  if (process.exitCode !== 1) {
    console.log("All citations resolve to real labs, and every drill covers the required structure.");
  }
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main();
}
