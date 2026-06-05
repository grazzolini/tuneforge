import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { renderApp, resetAppTestHarness } from "./test/appTestHarness";

describe("Desktop app tools chord dictionary", () => {
  beforeEach(resetAppTestHarness);

  it("renders the chord dictionary page from the tools route", async () => {
    renderApp(["/tools?tool=chord-dictionary"]);

    expect(await screen.findByRole("heading", { name: "Chord Dictionary" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Chord Dictionary" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByLabelText("Chord search")).toHaveValue("C");
    expect(screen.getByRole("button", { name: "Guitar" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByLabelText("Display context")).toBeInTheDocument();
    expect(screen.getAllByText("CAGED").length).toBeGreaterThan(0);
    expect(screen.getByText("C E G")).toBeInTheDocument();
  });

  it("switches between dictionary and live follow surfaces", async () => {
    const user = userEvent.setup();
    renderApp(["/tools?tool=chord-dictionary"]);

    expect(await screen.findByRole("heading", { name: "Chord Dictionary" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Live Follow" }));

    expect(screen.queryByRole("dialog", { name: "C chord preview" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "C" }));
    expect(screen.getByRole("dialog", { name: "C chord preview" })).toBeInTheDocument();

    await user.click(
      within(screen.getByRole("group", { name: "Chord dictionary views" })).getByRole(
        "button",
        { name: "Dictionary" },
      ),
    );
    expect(screen.getByLabelText("Note inspector")).toBeInTheDocument();
  });
});
