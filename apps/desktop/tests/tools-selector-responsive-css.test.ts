import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const projectLayoutCss = readFileSync("src/styles/project-layout.css", "utf8");

function cssBlock(source: string, signature: string) {
  const signatureIndex = source.indexOf(signature);
  if (signatureIndex < 0) {
    throw new Error(`CSS signature not found: ${signature}`);
  }
  const openBraceIndex = source.indexOf("{", signatureIndex + signature.length);
  if (openBraceIndex < 0) {
    throw new Error(`CSS block not found: ${signature}`);
  }

  let depth = 1;
  for (let index = openBraceIndex + 1; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") depth -= 1;
    if (depth === 0) return source.slice(openBraceIndex + 1, index);
  }
  throw new Error(`Unclosed CSS block: ${signature}`);
}

function lastCssBlock(source: string, signature: string) {
  const signatureIndex = source.lastIndexOf(signature);
  return cssBlock(source.slice(signatureIndex), signature);
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

describe("Tools selector responsive CSS", () => {
  it("uses a contained two-row selector without changing shared workspace tabs", () => {
    const mobileRules = lastCssBlock(projectLayoutCss, "@media (max-width: 720px)");
    const selectorDeclarations = cssDeclarations(
      cssBlock(mobileRules, ".project-workspace-tabs--tools"),
    );
    const buttonDeclarations = cssDeclarations(
      cssBlock(mobileRules, ".project-workspace-tabs--tools .project-workspace-tabs__button"),
    );

    expect(selectorDeclarations).toMatchObject({
      display: "flex",
      width: "100%",
      gap: "0.45rem",
      padding: "0.5rem",
      "border-radius": "18px",
    });
    expect(buttonDeclarations).toMatchObject({
      flex: "1 1 calc((100% - 0.45rem) / 2)",
      "min-inline-size": "0",
      "min-block-size": "3rem",
    });
    expect(mobileRules).not.toContain(".project-workspace-tabs {\n    display: flex");
  });
});
