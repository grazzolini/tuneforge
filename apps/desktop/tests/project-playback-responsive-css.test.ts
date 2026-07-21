import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const projectPlaybackCss = readFileSync("src/styles/project-playback.css", "utf8");
const projectLayoutCss = readFileSync("src/styles/project-layout.css", "utf8");
const responsiveUtilitiesCss = readFileSync("src/styles/utilities-responsive.css", "utf8");

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
  it("fixes Android Playback to the viewport while preserving narrow desktop page growth", () => {
    const mobileLayoutRules = cssBlock(projectLayoutCss, "@media (max-width: 720px)");
    const mobileScreenDeclarations = cssDeclarations(
      cssRuleBlock(
        mobileLayoutRules,
        ".project-screen--playback:has(.mobile-playback-app-bar)",
      ),
    );
    const narrowRules = cssBlock(projectPlaybackCss, "@media (max-width: 720px)");
    const narrowDesktopScreenDeclarations = cssDeclarations(
      cssRuleBlock(narrowRules, ".project-screen--playback"),
    );

    expect(mobileScreenDeclarations).toMatchObject({
      "block-size": "100%",
      "min-block-size": "0",
      overflow: "hidden",
      "overscroll-behavior": "none",
    });
    expect(narrowDesktopScreenDeclarations).toMatchObject({
      height: "auto",
      overflow: "visible",
    });
  });

  it("removes mobile app chrome from the fixed Playback frame scroll chain", () => {
    const narrowRules = cssBlock(responsiveUtilitiesCss, "@media (max-width: 720px)");
    const shellDeclarations = cssDeclarations(
      cssRuleBlock(narrowRules, ".app-shell:has(.mobile-playback-app-bar)"),
    );
    const sidebarDeclarations = cssDeclarations(
      cssRuleBlock(narrowRules, ".app-shell:has(.mobile-playback-app-bar) .sidebar"),
    );
    const mainDeclarations = cssDeclarations(
      cssRuleBlock(narrowRules, ".app-shell:has(.mobile-playback-app-bar) .main-content"),
    );

    expect(shellDeclarations).toMatchObject({
      "grid-template-rows": "minmax(0, 1fr)",
      overflow: "hidden",
    });
    expect(sidebarDeclarations).toMatchObject({ display: "none" });
    expect(mainDeclarations).toMatchObject({
      "--screen-padding": "0.5rem",
      overflow: "hidden",
      "overscroll-behavior": "none",
    });
  });

  it("keeps short mobile titles compact while allowing intrinsic large-text reflow", () => {
    const mobileRules = cssBlock(
      projectPlaybackCss,
      "@media (max-width: 720px) and (min-width: 0px)",
    );
    const appBarDeclarations = cssDeclarations(
      cssRuleBlock(projectPlaybackCss, ".screen__header.mobile-playback-app-bar"),
    );
    const identityDeclarations = cssDeclarations(
      cssRuleBlock(projectPlaybackCss, ".mobile-playback-app-bar__identity"),
    );
    const backDeclarations = cssDeclarations(
      cssBlock(projectPlaybackCss, ".mobile-playback-app-bar__back,"),
    );
    const titleDeclarations = cssDeclarations(
      cssRuleBlock(projectPlaybackCss, ".mobile-playback-app-bar__identity h1"),
    );
    const mobileHoverDeclarations = cssDeclarations(
      cssBlock(projectPlaybackCss, ".mobile-playback-app-bar .button:hover,"),
    );
    const fixedTargetDeclarations = cssDeclarations(
      cssBlock(mobileRules, ".mobile-playback-app-bar__back,"),
    );
    const mobileIdentityDeclarations = cssDeclarations(
      cssRuleBlock(mobileRules, ".mobile-playback-app-bar__identity"),
    );
    const mobileActionsDeclarations = cssDeclarations(
      cssRuleBlock(mobileRules, ".mobile-playback-app-bar__actions"),
    );

    expect(appBarDeclarations).toMatchObject({
      display: "grid",
      "grid-template-columns": "3rem minmax(0, 1fr) auto",
      "min-width": "0",
    });
    expect(backDeclarations).toMatchObject({
      "min-block-size": "3rem",
      "min-inline-size": "3rem",
    });
    expect(identityDeclarations).toMatchObject({
      "grid-template-columns": "minmax(0, 1fr) auto",
      "min-width": "0",
    });
    expect(titleDeclarations).toMatchObject({
      "line-height": "1.08",
      overflow: "visible",
      "overflow-wrap": "anywhere",
      "text-overflow": "clip",
      "white-space": "normal",
    });
    expect(mobileHoverDeclarations).toMatchObject({ transform: "none" });
    expect(fixedTargetDeclarations).toMatchObject({
      "min-block-size": "48px",
      "min-inline-size": "48px",
    });
    expect(mobileIdentityDeclarations).toMatchObject({ "column-gap": "7.2px" });
    expect(mobileActionsDeclarations).toMatchObject({ gap: "5.6px" });
    expect(projectPlaybackCss).toContain(".transport--mobile .transport__button:hover");
    expect(projectPlaybackCss).not.toContain("@media (max-width: 360px)");
  });

  it("reserves a dominant independent mobile Practice scroller above the dock", () => {
    const mobileRules = cssBlock(
      projectPlaybackCss,
      "@media (max-width: 720px) and (min-width: 0px)",
    );
    const workspaceDeclarations = cssDeclarations(
      cssBlock(
        mobileRules,
        ".playback-workspace--practice:has(.transport--mobile),",
      ),
    );
    const surfaceDeclarations = cssDeclarations(
      cssRuleBlock(
        mobileRules,
        ".playback-workspace--practice:has(.transport--mobile) .playback-practice-surface",
      ),
    );
    const bodyDeclarations = cssDeclarations(
      cssBlock(
        mobileRules,
        ".playback-workspace--practice:has(.transport--mobile) .playback-practice-body,",
      ),
    );
    const leadSheetDeclarations = cssDeclarations(
      cssRuleBlock(
        mobileRules,
        ".playback-workspace--practice:has(.transport--mobile) .lead-sheet",
      ),
    );

    expect(workspaceDeclarations).toMatchObject({
      flex: "1 1 0",
      "grid-template-rows": "minmax(0, 1fr) auto",
      overflow: "hidden",
    });
    expect(surfaceDeclarations).toMatchObject({
      "block-size": "100%",
      "grid-template-rows": "auto minmax(0, 1fr)",
      overflow: "hidden",
    });
    expect(bodyDeclarations).toMatchObject({
      "min-block-size": "50%",
      "overflow-x": "hidden",
      "overflow-y": "auto",
      "overscroll-behavior": "contain",
    });
    expect(leadSheetDeclarations).toMatchObject({
      "block-size": "auto",
      "max-block-size": "none",
      overflow: "visible",
    });
    expect(mobileRules).not.toContain(".lead-sheet-word__chords:empty");
  });

  it("fits active and adjacent Practice context at 360dp without shrinking targets", () => {
    const narrowMobileRules = cssBlock(projectPlaybackCss, "@media (max-width: 400px)");
    const leadSheetDeclarations = cssDeclarations(
      cssRuleBlock(
        narrowMobileRules,
        ".playback-workspace--practice:has(.transport--mobile) .lead-sheet",
      ),
    );
    const edgeDeclarations = cssDeclarations(
      cssRuleBlock(
        narrowMobileRules,
        ".playback-workspace--practice:has(.transport--mobile) .lead-sheet__edge",
      ),
    );
    const rowDeclarations = cssDeclarations(
      cssRuleBlock(
        narrowMobileRules,
        ".playback-workspace--practice:has(.transport--mobile) .lead-sheet__row",
      ),
    );
    const emptyWordChordDeclarations = cssDeclarations(
      cssRuleBlock(
        narrowMobileRules,
        ".playback-workspace--practice:has(.transport--mobile) .lead-sheet-word__chords:empty",
      ),
    );
    const emptyChordWordDeclarations = cssDeclarations(
      cssBlock(
        narrowMobileRules,
        ".playback-workspace--practice:has(.transport--mobile) .lead-sheet-word:has(",
      ),
    );
    const chordTargetDeclarations = cssDeclarations(
      cssRuleBlock(cssBlock(projectPlaybackCss, "@media (max-width: 720px)"), ".lead-sheet-chord"),
    );

    expect(leadSheetDeclarations).toMatchObject({
      gap: "0.55rem",
      padding: "0.35rem 0.45rem",
    });
    expect(edgeDeclarations).toMatchObject({ "flex-basis": "0.5rem" });
    expect(rowDeclarations).toMatchObject({ padding: "0.65rem 0.75rem" });
    expect(emptyWordChordDeclarations).toMatchObject({ "min-block-size": "0" });
    expect(emptyChordWordDeclarations).toMatchObject({ "min-block-size": "0" });
    expect(chordTargetDeclarations).toMatchObject({
      "min-block-size": "3rem",
      "min-inline-size": "3rem",
    });
  });

  it("caps the two-row mobile transport at 128dp with 48dp tap targets", () => {
    const transportDeclarations = cssDeclarations(
      cssRuleBlock(projectPlaybackCss, ".transport--mobile"),
    );
    const buttonDeclarations = cssDeclarations(
      cssBlock(projectPlaybackCss, ".transport--mobile .transport__button--play,"),
    );
    const scrubberDeclarations = cssDeclarations(
      cssRuleBlock(
        projectPlaybackCss,
        '.transport--mobile .transport__scrubber input[type="range"]',
      ),
    );
    const timelineDeclarations = cssDeclarations(
      cssRuleBlock(projectPlaybackCss, ".transport--mobile .transport__timeline"),
    );
    const mobileScrubberDeclarations = cssDeclarations(
      cssRuleBlock(projectPlaybackCss, ".transport--mobile .transport__scrubber"),
    );
    const timesDeclarations = cssDeclarations(
      cssRuleBlock(projectPlaybackCss, ".transport--mobile .transport__times"),
    );
    const statusDeclarations = cssDeclarations(
      cssRuleBlock(projectPlaybackCss, ".transport--mobile .transport__status"),
    );
    const statusStackDeclarations = cssDeclarations(
      cssRuleBlock(projectPlaybackCss, ".transport--mobile .transport__status-stack"),
    );
    const statusTimelineDeclarations = cssDeclarations(
      cssRuleBlock(
        projectPlaybackCss,
        ".transport--mobile .transport__timeline:has(.transport__status-stack)",
      ),
    );
    const mobileRules = cssBlock(
      projectPlaybackCss,
      "@media (max-width: 720px) and (min-width: 0px)",
    );
    const dockDeclarations = cssDeclarations(
      cssRuleBlock(
        mobileRules,
        ".playback-workspace--practice:has(.transport--mobile) .playback-transport-dock",
      ),
    );
    const fixedTransportDeclarations = cssDeclarations(
      cssRuleBlock(mobileRules, "\n  .transport--mobile"),
    );
    const fixedControlsDeclarations = cssDeclarations(
      cssRuleBlock(mobileRules, ".transport--mobile .transport__controls"),
    );
    const fixedButtonDeclarations = cssDeclarations(
      cssBlock(mobileRules, ".transport--mobile .transport__button--play,"),
    );
    const fixedTimelineDeclarations = cssDeclarations(
      cssRuleBlock(mobileRules, ".transport--mobile .transport__timeline"),
    );
    const fixedScrubberDeclarations = cssDeclarations(
      cssRuleBlock(mobileRules, ".transport--mobile .transport__scrubber"),
    );
    const fixedRangeDeclarations = cssDeclarations(
      cssRuleBlock(mobileRules, '.transport--mobile .transport__scrubber input[type="range"]'),
    );
    const fixedStatusDeclarations = cssDeclarations(
      cssRuleBlock(mobileRules, ".transport--mobile .transport__status-stack"),
    );

    expect(transportDeclarations).toMatchObject({
      "grid-template-columns": "minmax(0, 1fr)",
      "grid-template-rows": "3rem 3rem",
    });
    expect(buttonDeclarations).toMatchObject({
      "--transport-button-size": "3rem",
      "min-block-size": "3rem",
      "min-inline-size": "3rem",
    });
    expect(scrubberDeclarations).toMatchObject({
      "grid-column": "2",
      "grid-row": "1",
      "min-block-size": "3rem",
    });
    expect(timelineDeclarations).toMatchObject({
      display: "grid",
      "grid-template-columns": "minmax(0, 1fr)",
      "grid-template-rows": "3rem",
      overflow: "visible",
    });
    expect(mobileScrubberDeclarations).toMatchObject({
      "grid-template-columns": "auto minmax(3rem, 1fr) auto",
      "grid-template-rows": "3rem",
    });
    expect(timesDeclarations).toMatchObject({ display: "contents" });
    expect(statusDeclarations).toMatchObject({
      background: "transparent",
      overflow: "visible",
      "overflow-wrap": "anywhere",
    });
    expect(statusDeclarations).not.toHaveProperty("inset");
    expect(statusDeclarations).not.toHaveProperty("position");
    expect(statusStackDeclarations).toMatchObject({
      "grid-column": "2",
      "grid-row": "1",
      "max-block-size": "3rem",
      "overflow-y": "auto",
    });
    expect(statusTimelineDeclarations).toMatchObject({
      "grid-template-columns": "minmax(0, 1fr) minmax(5rem, min(9rem, 38vw))",
    });
    expect(dockDeclarations).toMatchObject({
      "max-block-size": "128px",
      overflow: "hidden",
    });
    expect(fixedTransportDeclarations).toMatchObject({
      "grid-template-rows": "48px 48px",
      gap: "5.6px",
    });
    expect(fixedControlsDeclarations).toMatchObject({
      "grid-template-columns": "repeat(5, minmax(48px, 1fr))",
      gap: "clamp(3.2px, 1.6vw, 8px)",
    });
    expect(fixedButtonDeclarations).toMatchObject({
      "--transport-button-size": "48px",
      "min-block-size": "48px",
      "min-inline-size": "48px",
    });
    expect(fixedTimelineDeclarations).toMatchObject({ "grid-template-rows": "48px" });
    expect(fixedScrubberDeclarations).toMatchObject({
      "grid-template-columns": "auto minmax(48px, 1fr) auto",
      "grid-template-rows": "48px",
    });
    expect(fixedRangeDeclarations).toMatchObject({ "min-block-size": "48px" });
    expect(fixedStatusDeclarations).toMatchObject({ "max-block-size": "48px" });
  });

  it("gives the large-text drawer capo selector a dedicated chevron row", () => {
    const triggerDeclarations = cssDeclarations(
      cssRuleBlock(
        projectPlaybackCss,
        ".mobile-practice-controls .key-stepper--small .target-selector__trigger",
      ),
    );
    const chevronDeclarations = cssDeclarations(
      cssRuleBlock(
        projectPlaybackCss,
        ".mobile-practice-controls .key-stepper--small .target-selector__chevron",
      ),
    );
    const drawerTargetDeclarations = cssDeclarations(
      cssRuleBlock(
        projectPlaybackCss,
        ".mobile-practice-controls .playback-practice-rail--drawer :is(button, input, select)",
      ),
    );

    expect(triggerDeclarations).toMatchObject({
      "grid-template-columns": "minmax(0, 0.55fr) minmax(0, 1.6fr) minmax(0, 0.55fr)",
      "grid-template-rows": "minmax(3rem, max-content) minmax(1rem, max-content)",
    });
    expect(chevronDeclarations).toMatchObject({
      position: "static",
      "grid-column": "2",
      "grid-row": "2",
      transform: "none",
    });
    expect(drawerTargetDeclarations).toMatchObject({ "min-block-size": "3rem" });
  });

  it("keeps drawer content scrollable and its close control reachable at large text", () => {
    const drawerDeclarations = cssDeclarations(
      cssRuleBlock(projectPlaybackCss, ".mobile-practice-controls"),
    );
    const headerDeclarations = cssDeclarations(
      cssRuleBlock(projectPlaybackCss, ".mobile-practice-controls__header"),
    );
    const closeDeclarations = cssDeclarations(
      cssRuleBlock(projectPlaybackCss, ".mobile-practice-controls__close"),
    );
    const railContentDeclarations = cssDeclarations(
      cssRuleBlock(
        projectPlaybackCss,
        ".mobile-practice-controls .playback-practice-rail--drawer .playback-practice-rail__content",
      ),
    );

    expect(drawerDeclarations).toMatchObject({
      "max-block-size": "calc(100dvh - var(--safe-area-top) - 0.5rem)",
      overflow: "hidden",
    });
    expect(headerDeclarations).toMatchObject({
      "grid-template-columns": "minmax(0, 1fr) 3rem",
      flex: "0 0 auto",
    });
    expect(closeDeclarations).toMatchObject({
      "min-block-size": "3rem",
      "min-inline-size": "3rem",
    });
    expect(railContentDeclarations).toMatchObject({
      "overflow-x": "hidden",
      "overflow-y": "auto",
      "overscroll-behavior": "contain",
    });
  });

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

  it("places mobile Follow beside the reflowing heading above the full-width mode selector", () => {
    const mobileRules = cssBlock(
      projectPlaybackCss,
      "@media (max-width: 720px) and (min-width: 0px)",
    );
    const headingDeclarations = cssDeclarations(
      cssRuleBlock(
        mobileRules,
        ".playback-workspace--practice:has(.transport--mobile) .playback-practice-surface__heading",
      ),
    );
    const followDeclarations = cssDeclarations(
      cssRuleBlock(
        mobileRules,
        ".playback-workspace--practice:has(.transport--mobile) .playback-follow-chip",
      ),
    );
    const explanationDeclarations = cssDeclarations(
      cssRuleBlock(
        mobileRules,
        ".playback-workspace--practice:has(.transport--mobile) .playback-follow-explanation",
      ),
    );
    const modeDeclarations = cssDeclarations(
      cssRuleBlock(
        mobileRules,
        ".playback-workspace--practice:has(.transport--mobile) .playback-mode-toggle",
      ),
    );

    expect(headingDeclarations).toMatchObject({
      display: "grid",
      "grid-template-columns": "minmax(0, 1fr) auto",
      "min-width": "0",
    });
    expect(headingDeclarations).not.toHaveProperty("max-height");
    expect(headingDeclarations).not.toHaveProperty("overflow");
    expect(followDeclarations).toMatchObject({
      "justify-self": "end",
      "min-block-size": "48px",
      "min-inline-size": "48px",
      "max-inline-size": "100%",
      "overflow-wrap": "anywhere",
      "white-space": "normal",
    });
    expect(explanationDeclarations).toMatchObject({
      "grid-column": "1 / -1",
      "min-width": "0",
      "overflow-wrap": "anywhere",
    });
    expect(modeDeclarations).toMatchObject({
      "grid-template-columns": "repeat(3, minmax(0, 1fr))",
      "inline-size": "100%",
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
