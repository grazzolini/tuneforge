import type { ExportCapabilities, ProjectImportRequest } from "./api";

export type DurableAudioFormat = NonNullable<ProjectImportRequest["output_format"]>;

export type DurableAudioFormatProfile = {
  description: string;
  label: string;
  lossy: boolean;
  value: DurableAudioFormat;
};

export const DURABLE_AUDIO_FORMAT_PROFILES: readonly DurableAudioFormatProfile[] = [
  {
    value: "wav",
    label: "WAV/PCM",
    description: "Uncompressed and lossless PCM16. Largest files and broadest compatibility. Default.",
    lossy: false,
  },
  {
    value: "flac",
    label: "FLAC",
    description: "Lossless compressed FLAC level 5. Smaller files without quality loss.",
    lossy: false,
  },
  {
    value: "mp3",
    label: "MP3 (192 kbps)",
    description: "Lossy MP3 at 192 kbps. Smaller files with broad compatibility.",
    lossy: true,
  },
  {
    value: "m4a",
    label: "M4A (AAC-LC, 192 kbps)",
    description: "Lossy AAC-LC in M4A at 192 kbps. Smaller files with modern playback support.",
    lossy: true,
  },
] as const;

export const DURABLE_AUDIO_CAPABILITIES_QUERY_KEY = ["export-capabilities"] as const;

export function isDurableAudioFormat(value: unknown): value is DurableAudioFormat {
  return value === "wav" || value === "flac" || value === "mp3" || value === "m4a";
}

export function durableAudioFormatLabel(value: DurableAudioFormat) {
  return DURABLE_AUDIO_FORMAT_PROFILES.find((profile) => profile.value === value)?.label ?? value;
}

export function durableAudioFormatIsLossy(value: DurableAudioFormat) {
  return DURABLE_AUDIO_FORMAT_PROFILES.some((profile) => profile.value === value && profile.lossy);
}

export type DurableAudioActionFormat = {
  format: DurableAudioFormat;
  outputFormat?: DurableAudioFormat;
};

export function requireDurableAudioActionFormat(
  capabilities: ExportCapabilities,
  preferredFormat: DurableAudioFormat,
): DurableAudioActionFormat {
  if (capabilities.platform === "android") {
    const wav = capabilities.formats.find((format) => format.id === "wav");
    if (!wav?.available) {
      throw new Error(wav?.reason || "WAV durable audio is unavailable on this device.");
    }
    return { format: "wav" };
  }

  const capability = capabilities.formats.find((format) => format.id === preferredFormat);
  if (!capability?.available) {
    const label = durableAudioFormatLabel(preferredFormat);
    throw new Error(
      capability?.reason
        ? `${label} is unavailable: ${capability.reason}`
        : `${label} is unavailable because the backend did not report encoder support.`,
    );
  }
  return { format: preferredFormat, outputFormat: preferredFormat };
}
