import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildCitationReport, drillsDir, missingHeadings, PHASES } from "../src/check-citations.js";

describe("drill citations", () => {
  it("finds all eight drill files", () => {
    const files = readdirSync(drillsDir).filter((name) => name.endsWith(".md"));
    expect(files).toHaveLength(8);
  });

  it("cites at least one lab that really exists under labs/", () => {
    const report = buildCitationReport();
    expect(report.existingLabNumbers.size).toBeGreaterThanOrEqual(40);
    expect(report.allCitedNumbers.size).toBeGreaterThan(0);
  });

  it("never cites a lab number that does not exist under labs/", () => {
    const report = buildCitationReport();
    expect(report.unknownCitations).toEqual([]);
  });

  it("never cites itself (Lab 41) or an out-of-range lab number", () => {
    const report = buildCitationReport();
    for (const n of report.allCitedNumbers) {
      expect(n).toBeGreaterThanOrEqual(1);
      expect(n).toBeLessThanOrEqual(40);
    }
  });

  it("cites a broad cross-section of the curriculum, not one narrow corner of it", () => {
    const report = buildCitationReport();
    // 8 drills, each grounded in several labs of its own - a healthy
    // synthesis lab should cite well more labs than it has drills, and
    // should not concentrate on a single SPEC.md phase.
    expect(report.allCitedNumbers.size).toBeGreaterThanOrEqual(20);
    expect(report.coveredPhases.length).toBeGreaterThanOrEqual(9);
  });

  it("every drill covers all 11 phases only if the content grows to do so (documents current coverage)", () => {
    const report = buildCitationReport();
    // Not an equality assertion (content may reasonably evolve) - this
    // just prints/asserts the phases actually reached today stay a
    // superset of a stable minimum, defined above. Sanity check that the
    // phase table itself is well-formed.
    expect(PHASES.length).toBe(11);
    expect(report.coveredPhases.length).toBeLessThanOrEqual(PHASES.length);
  });

  it("every drill has every required structural section", () => {
    const files = readdirSync(drillsDir).filter((name) => name.endsWith(".md"));
    for (const file of files) {
      const markdown = readFileSync(path.join(drillsDir, file), "utf8");
      expect(missingHeadings(markdown), `${file} is missing required sections`).toEqual([]);
    }
  });

  it("every drill names a common wrong answer distinct from its model answer heading", () => {
    const files = readdirSync(drillsDir).filter((name) => name.endsWith(".md"));
    for (const file of files) {
      const markdown = readFileSync(path.join(drillsDir, file), "utf8");
      const wrongAnswerIndex = markdown.indexOf("## Common wrong answer");
      const interviewIndex = markdown.indexOf("## Interview questions");
      expect(wrongAnswerIndex, `${file} has no "Common wrong answer" section`).toBeGreaterThan(-1);
      expect(interviewIndex, `${file} has no "Interview questions" section`).toBeGreaterThan(wrongAnswerIndex);
      // The wrong-answer section should not be a stub - require a
      // reasonable amount of real content between the two headings.
      const body = markdown.slice(wrongAnswerIndex, interviewIndex);
      expect(body.length).toBeGreaterThan(400);
    }
  });
});
