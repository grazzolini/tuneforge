import { describe, expect, it } from "vitest";
import type { ExportCapabilities } from "./api";
import {
  requireDurableAudioActionFormat,
} from "./durableAudio";

function capabilities(platform: "desktop" | "android", unavailable?: string): ExportCapabilities {
  return {
    platform,
    formats: ["wav", "flac", "mp3", "m4a"].map((id) => ({
      id,
      available: id !== unavailable,
      reason: id === unavailable ? "Encoder missing." : null,
    })),
    destinations: [],
    max_artifact_count: null,
  };
}

describe("durable audio capability guard", () => {
  it("returns the selected desktop output format", () => {
    expect(requireDurableAudioActionFormat(capabilities("desktop"), "flac")).toEqual({
      format: "flac",
      outputFormat: "flac",
    });
  });

  it("blocks an unavailable desktop encoder without fallback", () => {
    expect(() => requireDurableAudioActionFormat(capabilities("desktop", "mp3"), "mp3"))
      .toThrow("MP3 (192 kbps) is unavailable: Encoder missing.");
  });

  it("keeps Android actions on omitted-field WAV despite a hidden compressed preference", () => {
    expect(requireDurableAudioActionFormat(capabilities("android"), "m4a")).toEqual({
      format: "wav",
    });
  });
});
