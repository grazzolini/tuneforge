import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import {
  findAudioByArtifactId,
  markAudioReady,
  mockGetMobileCapabilities,
  renderApp,
  resetAppTestHarness,
} from "./test/appTestHarness";

function enableAndroidRuntime() {
  mockGetMobileCapabilities.mockResolvedValue({
    platform: "android",
    mediaBackend: "android_media_codec",
    isEmulator: true,
    gpuBackend: null,
    analysisAvailable: true,
    basicChordsAvailable: true,
    whisperAvailable: false,
    stemSeparationAvailable: false,
    generationTestingAvailable: true,
    maxRecommendedModel: null,
    cpuFallbackAllowed: false,
  });
}

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

  it("keeps sidebar Library navigation usable after entering Playback", async () => {
    const user = userEvent.setup();
    renderApp(["/projects/proj_123"]);

    expect(await screen.findByRole("heading", { name: "Demo Song" })).toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: "Playback" }));
    expect(screen.getByRole("tab", { name: "Playback" })).toHaveAttribute("aria-selected", "true");

    const sidebarNav = document.querySelector(".sidebar .nav");
    expect(sidebarNav).not.toBeNull();
    await user.click(within(sidebarNav as HTMLElement).getByRole("link", { name: "Library" }));

    expect(await screen.findByRole("heading", { name: "Practice Projects" })).toBeInTheDocument();
    expect(document.querySelector(".app-shell")).not.toHaveClass("app-shell--compact");
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
    expect(transportDock?.querySelector(".transport")).not.toHaveClass("transport--mobile");
    expect(
      within(transportDock as HTMLElement).getByRole("button", { name: "Tempo at original" }),
    ).toBeInTheDocument();
  });

  it("keeps desktop Follow controls in the existing action row", async () => {
    const user = userEvent.setup();
    renderApp(["/projects/proj_123"]);

    await user.click(await screen.findByRole("tab", { name: "Playback" }));

    const header = document.querySelector<HTMLElement>(".playback-practice-surface__header");
    const heading = header?.querySelector<HTMLElement>(".playback-practice-surface__heading");
    const actions = header?.querySelector<HTMLElement>(".playback-practice-actions");
    const lyricsFollow = within(header as HTMLElement).getByRole("button", {
      name: "Lyrics Follow",
    });

    expect(header).not.toBeNull();
    expect(heading).not.toBeNull();
    expect(actions).not.toBeNull();
    expect(heading).not.toContainElement(lyricsFollow);
    expect(actions).toContainElement(lyricsFollow);
  });

  it("uses a two-part mobile transport without duplicating Practice Controls tempo", async () => {
    const user = userEvent.setup();
    enableAndroidRuntime();
    renderApp(["/projects/proj_123"]);

    await user.click(await screen.findByRole("tab", { name: "Playback" }));

    const transportDock = document.querySelector<HTMLElement>(".playback-transport-dock");
    const transport = transportDock?.querySelector<HTMLElement>(".transport--mobile");
    expect(transportDock).not.toBeNull();
    expect(transport).not.toBeNull();
    expect(transport?.querySelector(":scope > .transport__controls")).not.toBeNull();
    expect(transport?.querySelector(":scope > .transport__timeline")).not.toBeNull();
    expect(within(transportDock as HTMLElement).queryByText("Tempo")).not.toBeInTheDocument();
    expect(
      within(transportDock as HTMLElement).queryByRole("button", { name: /tempo/i }),
    ).not.toBeInTheDocument();
    expect(
      within(transportDock as HTMLElement).getByRole("slider", { name: "Playback position" }),
    ).toBeInTheDocument();
    expect(
      within(transportDock as HTMLElement).getAllByRole("button").map((button) =>
        button.getAttribute("aria-label"),
      ),
    ).toEqual([
      "Seek back 10 seconds",
      "Play playback",
      "Stop playback",
      "Seek forward 10 seconds",
      "Set loop start",
    ]);
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
