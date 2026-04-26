export type MobileCapabilities = {
  platform: "android" | "ios";
  mediaBackend: "android_media_codec" | "avfoundation";
  isEmulator: boolean;
  gpuBackend: "vulkan" | "nnapi" | "qnn" | "coreml" | null;
  analysisAvailable: boolean;
  basicChordsAvailable: boolean;
  whisperAvailable: boolean;
  stemSeparationAvailable: boolean;
  generationTestingAvailable: boolean;
  maxRecommendedModel: "tiny" | "base" | "small" | null;
  cpuFallbackAllowed: boolean;
};
