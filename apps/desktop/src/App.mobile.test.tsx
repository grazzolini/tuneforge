import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import {
  mockGetMobileCapabilities,
  resetAppTestHarness,
  renderApp,
} from "./test/appTestHarness";

describe("Desktop app mobile capability gates", () => {
  beforeEach(resetAppTestHarness);

  it("disables generation actions when mobile acceleration is unavailable", async () => {
    mockGetMobileCapabilities.mockResolvedValue({
      platform: "android",
      mediaBackend: "android_media_codec",
      gpuBackend: null,
      whisperAvailable: false,
      stemSeparationAvailable: false,
      maxRecommendedModel: null,
      cpuFallbackAllowed: false,
    });

    renderApp(["/projects/proj_123"]);

    expect(await screen.findByRole("heading", { name: "Processing" })).toBeInTheDocument();
    expect(
      await screen.findByText("Local generation requires GPU acceleration on this device."),
    ).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Analyze Track" })).toBeDisabled();
    expect(await screen.findByRole("button", { name: "Refresh Chords" })).toBeDisabled();
    expect(await screen.findByRole("button", { name: "Refresh Lyrics" })).toBeDisabled();
    expect(await screen.findByRole("button", { name: "Generate Stems" })).toBeDisabled();
  });

  it("keeps generation controls out of the playback workspace", async () => {
    const user = userEvent.setup();
    renderApp(["/projects/proj_123"]);

    await user.click(await screen.findByRole("tab", { name: "Playback" }));

    const playbackSurface = screen.getByRole("heading", { name: "Lyrics + chords" }).closest("main");
    expect(playbackSurface).not.toBeNull();
    expect(
      within(playbackSurface as HTMLElement).queryByRole("button", { name: /Generate|Refresh/i }),
    ).not.toBeInTheDocument();
  });
});
