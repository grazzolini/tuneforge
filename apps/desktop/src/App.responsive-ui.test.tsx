import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import {
  findAudioByArtifactId,
  markAudioReady,
  renderApp,
  resetAppTestHarness,
} from "./test/appTestHarness";

describe("Desktop app responsive UI revamp", () => {
  beforeEach(resetAppTestHarness);

  it("keeps library navigation expanded and uses dense project rows", async () => {
    renderApp(["/"]);

    expect(await screen.findByRole("heading", { name: "Practice Projects" })).toBeInTheDocument();
    expect(document.querySelector(".app-shell")).not.toHaveClass("app-shell--compact");
    expect(screen.getAllByRole("link", { name: "Library" }).length).toBeGreaterThan(0);
    await screen.findByRole("link", { name: "Open Demo Song project" });
    expect(document.querySelector(".project-library-table__header")).toBeInTheDocument();
    expect(document.querySelectorAll(".project-library-row").length).toBeGreaterThan(0);
  });

  it("uses compact app chrome on project routes while preserving accessible navigation", async () => {
    renderApp(["/projects/proj_123"]);

    expect(await screen.findByRole("heading", { name: "Demo Song" })).toBeInTheDocument();
    expect(document.querySelector(".app-shell")).toHaveClass("app-shell--compact");
    expect(screen.getAllByRole("link", { name: "Library" }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole("link", { name: "Tools" }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole("link", { name: "Settings" }).length).toBeGreaterThan(0);
  });

  it("splits project work into Studio and Analysis panels", async () => {
    const user = userEvent.setup();
    renderApp(["/projects/proj_123"]);

    expect(await screen.findByRole("heading", { name: "Demo Song" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Studio" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("group", { name: "Source and mix list" })).toBeInTheDocument();
    const createMixButton = screen.getByRole("button", { name: "Create Mix" });
    expect(createMixButton.closest(".mix-builder__footer")).not.toBeNull();
    expect(screen.getByRole("heading", { name: "Processing" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Analyze Track" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Hide Inspector" }));
    expect(screen.getByRole("button", { name: "Show Inspector" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Create Mix" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Show Inspector" }));

    await user.click(screen.getByRole("tab", { name: "Analysis" }));

    expect(screen.getByRole("heading", { name: "Project Analysis" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Processing" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Analyze Track" })).not.toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Source and mix list" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Hide Inspector" })).not.toBeInTheDocument();
  });

  it("keeps playback transport at the bottom of the fixed practice frame", async () => {
    const user = userEvent.setup();
    renderApp(["/projects/proj_123"]);

    expect(await screen.findByRole("heading", { name: "Demo Song" })).toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: "Playback" }));

    const workspace = document.querySelector(".playback-workspace--practice");
    const transportDock = document.querySelector(".playback-transport-dock");
    expect(workspace).not.toBeNull();
    expect(transportDock).not.toBeNull();
    expect(workspace).toContainElement(transportDock as HTMLElement);
    expect((transportDock as HTMLElement).parentElement).toBe(workspace);
    expect(within(transportDock as HTMLElement).getByRole("button", { name: "Play playback" })).toBeInTheDocument();
  });

  it("collapses practice chrome while playback is active and restores it on pause", async () => {
    const user = userEvent.setup();
    renderApp(["/projects/proj_123"]);

    expect(await screen.findByRole("heading", { name: "Demo Song" })).toBeInTheDocument();
    markAudioReady(findAudioByArtifactId("art_source"));
    await user.click(screen.getByRole("tab", { name: "Playback" }));

    const workspace = document.querySelector(".playback-workspace") as HTMLElement;
    await user.click(screen.getByRole("button", { name: "Play playback" }));
    await waitFor(() => expect(workspace).toHaveClass("playback-workspace--focus"));

    await user.click(screen.getByRole("button", { name: "Pause playback" }));
    await waitFor(() => expect(workspace).not.toHaveClass("playback-workspace--focus"));
  });
});
