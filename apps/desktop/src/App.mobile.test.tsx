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
      isEmulator: false,
      gpuBackend: null,
      analysisAvailable: true,
      basicChordsAvailable: true,
      whisperAvailable: false,
      stemSeparationAvailable: false,
      generationTestingAvailable: false,
      maxRecommendedModel: null,
      cpuFallbackAllowed: false,
    });

    renderApp(["/projects/proj_123"]);

    expect(await screen.findByRole("heading", { name: "Processing" })).toBeInTheDocument();
    expect(
      await screen.findByText(
        "Side-load a Whisper model to enable local lyrics. Stem generation is unavailable on this device.",
      ),
    ).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Analyze Track" })).toBeEnabled();
    expect(await screen.findByRole("button", { name: "Refresh Chords" })).toBeEnabled();
    expect(await screen.findByRole("button", { name: "Refresh Lyrics" })).toBeDisabled();
    expect(await screen.findByRole("button", { name: "Generate Stems" })).toBeDisabled();
  });

  it("allows emulator generation flow testing without reporting engines as available", async () => {
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

    renderApp(["/projects/proj_123"]);

    expect(
      await screen.findByText(
        "Emulator generation actions are enabled for flow testing; lyrics and stem engines are still unavailable.",
      ),
    ).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Refresh Lyrics" })).toBeEnabled();
    expect(await screen.findByRole("button", { name: "Generate Stems" })).toBeEnabled();
  });

  it("enables local lyrics when a side-loaded Whisper model is available", async () => {
    mockGetMobileCapabilities.mockResolvedValue({
      platform: "android",
      mediaBackend: "android_media_codec",
      isEmulator: false,
      gpuBackend: null,
      analysisAvailable: true,
      basicChordsAvailable: true,
      whisperAvailable: true,
      stemSeparationAvailable: false,
      generationTestingAvailable: false,
      maxRecommendedModel: "base",
      cpuFallbackAllowed: false,
    });

    renderApp(["/projects/proj_123"]);

    expect(
      await screen.findByText("Local lyrics are available. Stem generation is unavailable on this device."),
    ).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Refresh Lyrics" })).toBeEnabled();
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
