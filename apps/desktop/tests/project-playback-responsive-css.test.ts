import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const projectPlaybackCss = readFileSync("src/styles/project-playback.css", "utf8");

function cssBlock(source: string, signature: string) {
  const signatureIndex = source.indexOf(signature);
  if (signatureIndex < 0) {
    throw new Error(`CSS signature not found: ${signature}`);
  }
  const openBraceIndex = source.indexOf("{", signatureIndex + signature.length);
  if (openBraceIndex < 0) {
    throw new Error(`CSS block not found: ${signature}`);
  }
  return cssBlockAfterOpenBrace(source, signature, openBraceIndex);
}

function cssRuleBlock(source: string, selector: string) {
  let searchIndex = 0;
  while (searchIndex < source.length) {
    const selectorIndex = source.indexOf(selector, searchIndex);
    if (selectorIndex < 0) {
      break;
    }
    const remainder = source.slice(selectorIndex + selector.length);
    const openBraceOffset = remainder.search(/^\s*\{/);
    if (openBraceOffset === 0) {
      const openBraceIndex = source.indexOf("{", selectorIndex + selector.length);
      return cssBlockAfterOpenBrace(source, selector, openBraceIndex);
    }
    searchIndex = selectorIndex + selector.length;
  }
  throw new Error(`CSS rule not found: ${selector}`);
}

function cssBlockAfterOpenBrace(source: string, signature: string, openBraceIndex: number) {
  let depth = 1;
  for (let index = openBraceIndex + 1; index < source.length; index += 1) {
    if (source[index] === "{") {
      depth += 1;
    } else if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) {
        return source.slice(openBraceIndex + 1, index);
      }
    }
  }
  throw new Error(`Unclosed CSS block: ${signature}`);
}

function cssDeclarations(block: string) {
  return Object.fromEntries(
    block
      .split(";")
      .map((declaration) => declaration.trim())
      .filter(Boolean)
      .map((declaration) => {
        const separatorIndex = declaration.indexOf(":");
        return [
          declaration.slice(0, separatorIndex).trim(),
          declaration.slice(separatorIndex + 1).trim(),
        ];
      }),
  );
}

describe("project Playback responsive CSS", () => {
  it("keeps narrow Practice header and controls outside clipped nested scrolling", () => {
    const narrowRules = cssBlock(projectPlaybackCss, "@media (max-width: 720px)");
    const headerDeclarations = cssDeclarations(
      cssRuleBlock(narrowRules, ".playback-practice-surface__header"),
    );
    const controlDeclarations = cssDeclarations(
      cssRuleBlock(narrowRules, ".playback-practice-surface__controls"),
    );

    expect(headerDeclarations).toMatchObject({
      flex: "0 0 auto",
      "max-height": "none",
      overflow: "visible",
    });
    expect(controlDeclarations).toMatchObject({
      "align-items": "stretch",
      "flex-direction": "column",
      overflow: "visible",
    });
    expect(headerDeclarations).not.toMatchObject({
      "max-height": "4.25rem",
      overflow: "auto",
    });
  });

  it("preserves a usable Practice body by letting the narrow project page grow", () => {
    const narrowRules = cssBlock(projectPlaybackCss, "@media (max-width: 720px)");
    const screenDeclarations = cssDeclarations(
      cssRuleBlock(narrowRules, ".project-screen--playback"),
    );
    const workspaceDeclarations = cssDeclarations(
      cssRuleBlock(narrowRules, ".playback-workspace--practice"),
    );
    const surfaceDeclarations = cssDeclarations(
      cssRuleBlock(narrowRules, ".playback-practice-surface"),
    );
    const bodyDeclarations = cssDeclarations(
      cssRuleBlock(narrowRules, ".playback-practice-body"),
    );
    const leadSheetDeclarations = cssDeclarations(cssRuleBlock(narrowRules, ".lead-sheet"));

    expect(screenDeclarations).toMatchObject({
      height: "auto",
      overflow: "visible",
    });
    expect(workspaceDeclarations).toMatchObject({
      flex: "0 0 auto",
      "grid-template-rows": "minmax(0, 2.75rem) auto auto",
      overflow: "visible",
    });
    expect(surfaceDeclarations).toMatchObject({
      height: "auto",
      overflow: "visible",
    });
    expect(bodyDeclarations).toMatchObject({
      flex: "0 0 auto",
      "min-block-size": "15rem",
    });
    expect(leadSheetDeclarations).toMatchObject({
      "block-size": "15rem",
      flex: "0 0 15rem",
      "min-block-size": "15rem",
    });
  });

  it("keeps short-height desktop expansion out of the narrow cascade", () => {
    const shortDesktopRules = cssBlock(
      projectPlaybackCss,
      "@media (max-height: 760px) and (min-width: 721px)",
    );
    const desktopLeadSheetDeclarations = cssDeclarations(
      cssBlock(shortDesktopRules, ".lead-sheet,"),
    );
    const narrowRules = cssBlock(projectPlaybackCss, "@media (max-width: 720px)");
    const narrowLeadSheetDeclarations = cssDeclarations(
      cssRuleBlock(narrowRules, ".lead-sheet"),
    );

    expect(desktopLeadSheetDeclarations).toMatchObject({
      "max-height": "26rem",
      "min-height": "26rem",
    });
    expect(narrowLeadSheetDeclarations).toMatchObject({
      "block-size": "15rem",
      "min-block-size": "15rem",
    });
    expect(projectPlaybackCss).not.toContain("@media (max-height: 760px) {");
  });

  it("centers narrow chord labels inside visible touch targets", () => {
    const narrowRules = cssBlock(projectPlaybackCss, "@media (max-width: 720px)");
    const markerDeclarations = cssDeclarations(
      cssRuleBlock(narrowRules, ".lead-sheet-chord"),
    );
    const labelDeclarations = cssDeclarations(
      cssRuleBlock(narrowRules, ".lead-sheet-chord .musical-label--chord-chip"),
    );
    const labelTextDeclarations = cssDeclarations(
      cssBlock(
        narrowRules,
        ".lead-sheet-chord .musical-label--chord-chip .musical-label__primary,",
      ),
    );

    expect(markerDeclarations).toMatchObject({
      display: "inline-grid",
      "min-block-size": "3rem",
      "min-inline-size": "3rem",
      "padding-inline": "0.55rem",
      "place-items": "center",
    });
    expect(labelDeclarations).toMatchObject({
      "align-items": "center",
      "justify-content": "center",
      "text-align": "center",
    });
    expect(labelTextDeclarations).toMatchObject({
      overflow: "visible",
      "text-align": "center",
      "text-overflow": "clip",
    });
  });
});
