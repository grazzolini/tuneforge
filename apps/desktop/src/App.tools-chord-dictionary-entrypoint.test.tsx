import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import {
  renderApp,
  resetAppTestHarness,
  setProjectChords,
} from "./test/appTestHarness";

describe("Desktop app chord dictionary project entrypoint", () => {
  beforeEach(resetAppTestHarness);

  it("opens Chord Dictionary from project analysis with playback follow params", async () => {
    const user = userEvent.setup();
    renderApp(["/projects/proj_123"]);

    expect(await screen.findByRole("heading", { name: "Demo Song" })).toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: "Analysis" }));

    const dictionaryLink = await screen.findByRole("link", {
      name: "Follow chords in Chord Dictionary",
    });
    expect(dictionaryLink).toHaveAttribute(
      "href",
      "/tools?tool=chord-dictionary&followPlayback=1&projectId=proj_123",
    );

    await user.click(dictionaryLink);

    expect(await screen.findByRole("heading", { name: "Chord Dictionary" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Chord Dictionary" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  it("does not show the project entrypoint without a chord timeline", async () => {
    const user = userEvent.setup();
    setProjectChords("proj_123", {
      project_id: "proj_123",
      backend: "default",
      source_artifact_id: "art_source",
      source_segments: [],
      has_user_edits: false,
      created_at: "2026-04-18T13:16:00.000Z",
      updated_at: "2026-04-18T13:16:00.000Z",
      timeline: [],
    });
    renderApp(["/projects/proj_123"]);

    expect(await screen.findByRole("heading", { name: "Demo Song" })).toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: "Analysis" }));

    expect(
      screen.queryByRole("link", { name: "Follow chords in Chord Dictionary" }),
    ).not.toBeInTheDocument();
  });

  it("arms Live Follow from query params without active project playback", async () => {
    renderApp(["/tools?tool=chord-dictionary&followPlayback=1&projectId=proj_123"]);

    expect(await screen.findByRole("heading", { name: "Chord Dictionary" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Chord Dictionary" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByRole("button", { name: "Dictionary" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    expect(screen.getByRole("button", { name: "Live Follow" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByText("No matching project playback")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Live Follow is armed from a project, but no matching playback session is active.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/proj_123/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Current chord")).not.toBeInTheDocument();
  });

  it("lets route-armed Live Follow return to Dictionary without rearming on tool remount", async () => {
    const user = userEvent.setup();
    renderApp(["/tools?tool=chord-dictionary&followPlayback=1&projectId=proj_123"]);

    expect(await screen.findByRole("heading", { name: "Chord Dictionary" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Live Follow" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    await user.click(screen.getByRole("button", { name: "Dictionary" }));

    expect(screen.getByRole("button", { name: "Dictionary" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByLabelText("Chord search")).toHaveValue("C");
    expect(screen.queryByText("No matching project playback")).not.toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "Metronome" }));
    expect(await screen.findByRole("heading", { name: "Metronome" })).toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: "Chord Dictionary" }));

    expect(await screen.findByRole("heading", { name: "Chord Dictionary" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Dictionary" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("button", { name: "Live Follow" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    expect(screen.getByLabelText("Chord search")).toHaveValue("C");
    expect(screen.queryByText("No matching project playback")).not.toBeInTheDocument();
  });
});
