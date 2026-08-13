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
});
