export type MobileCapabilities = {
  platform: "android" | "ios";
  mediaBackend: "android_media_codec" | "avfoundation";
  gpuBackend: "vulkan" | "nnapi" | "qnn" | "coreml" | null;
  whisperAvailable: boolean;
  stemSeparationAvailable: boolean;
  maxRecommendedModel: "tiny" | "base" | "small" | null;
  cpuFallbackAllowed: false;
};
