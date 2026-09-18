import type { components } from "./generated/openapi";

export type MobileJobSchema = components["schemas"]["JobSchema"] & {
  analysis_request?: components["schemas"]["AnalysisRequest"] | null;
};

export type MobileCapabilities = {
  platform: "android" | "ios";
  mediaBackend: "android_media_codec" | "avfoundation" | "cpal_coreaudio";
  isEmulator: boolean;
  gpuBackend: "vulkan" | "nnapi" | "qnn" | "coreml" | null;
  analysisAvailable: boolean;
  beatThisAvailable?: boolean;
  beatThisModelStatus?: "ready" | "download-required" | "corrupt" | "unavailable";
  basicChordsAvailable: boolean;
  cremaAvailable?: boolean;
  cremaModelStatus?: "ready" | "download-required" | "corrupt" | "unavailable";
  whisperAvailable: boolean;
  whisperModelStatus: "ready" | "download-required" | "corrupt" | "unavailable";
  stemSeparationAvailable: boolean;
  generationTestingAvailable: boolean;
  maxRecommendedModel: "tiny" | "base" | "small" | "large-v3-turbo" | null;
  cpuFallbackAllowed: boolean;
};
