import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cwd } from "node:process";
import { describe, expect, it } from "vitest";

describe("narrow export package source", () => {
  it("keeps the package in flow and sticks only its compact summary", () => {
    const stylesheet = readFileSync(resolve(cwd(), "src/styles/project-export.css"), "utf8");
    const narrowStyles = stylesheet.slice(stylesheet.indexOf("@media (max-width: 720px)"));

    expect(narrowStyles).toMatch(/\.export-package\s*\{\s*position:\s*static;/);
    expect(narrowStyles).toMatch(/\.export-package__summary\s*\{[^}]*position:\s*sticky;/s);
    expect(narrowStyles).not.toMatch(/\.export-package\s*\{[^}]*position:\s*sticky;/s);
  });

  it("keeps export recovery notices below overlays and inside the viewport", () => {
    const stylesheet = readFileSync(resolve(cwd(), "src/styles/project-export.css"), "utf8");
    const shell = readFileSync(
      resolve(cwd(), "src/features/projects/components/ProjectShell.tsx"),
      "utf8",
    );

    expect(stylesheet).toMatch(/\.project-export-recovery-toast\s*\{[^}]*position:\s*fixed;/s);
    expect(stylesheet).toMatch(/\.project-export-recovery-toast\s*\{[^}]*z-index:\s*20;/s);
    expect(stylesheet).toMatch(/\.project-export-recovery-toast\s*\{[^}]*max-width:\s*min\(28rem, calc\(100vw - 2rem\)\);/s);
    expect(shell).toMatch(/setTimeout\(\(\) => setShowExportRecoveryNotice\(false\), 4000\)/);
    expect(shell).toMatch(/exportRecoveryNoticeProjectId !== projectId/);
  });
});
