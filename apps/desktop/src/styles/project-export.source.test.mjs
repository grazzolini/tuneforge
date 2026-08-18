import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cwd } from "node:process";
import { describe, expect, it } from "vitest";

describe("narrow export package source", () => {
  it("shares destination geometry and does not override it at narrow widths", () => {
    const stylesheet = readFileSync(resolve(cwd(), "src/styles/project-export.css"), "utf8");
    const narrowStyles = stylesheet.slice(stylesheet.indexOf("@media (max-width: 720px)"));
    const geometry = stylesheet.match(/\.export-destination-option \.button\s*\{([^}]*)\}/)?.[1] ?? "";
    const optionLayout = stylesheet.match(/\.export-destination-option\s*\{([^}]*)\}/)?.[1] ?? "";

    expect(geometry).toMatch(/width:\s*100%/);
    expect(geometry).toMatch(/min-height:\s*44px/);
    expect(geometry).toMatch(/grid-template-columns:\s*1rem minmax\(0, 1fr\) 1rem/);
    expect(geometry).toMatch(/padding:\s*0\.56rem 0\.9rem/);
    expect(geometry).toMatch(/border-radius:\s*999px/);
    expect(optionLayout).toMatch(/align-content:\s*start/);
    expect(narrowStyles).not.toMatch(/\.export-destination-option \.button\s*\{/);
  });

  it("keeps the package and compact summary in flow", () => {
    const stylesheet = readFileSync(resolve(cwd(), "src/styles/project-export.css"), "utf8");
    const narrowStyles = stylesheet.slice(stylesheet.indexOf("@media (max-width: 720px)"));

    expect(narrowStyles).toMatch(/\.export-package\s*\{\s*position:\s*static;/);
    expect(narrowStyles).toMatch(/\.export-package__summary\s*\{[^}]*position:\s*static;/s);
    expect(narrowStyles).not.toMatch(/position:\s*sticky/);
    expect(narrowStyles).toMatch(/\.export-latest\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\) auto;/s);
    expect(narrowStyles).toMatch(/\.export-latest small\s*\{[^}]*grid-column:\s*1 \/ -1;/s);
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
