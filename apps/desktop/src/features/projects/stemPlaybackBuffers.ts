import { api } from "../../lib/api";

type StemBufferLoaderOptions = {
  bufferCache: Map<string, Promise<AudioBuffer>>;
  getStemAudioContext: () => AudioContext | null;
};

export async function loadStemBuffer(
  artifactId: string,
  { bufferCache, getStemAudioContext }: StemBufferLoaderOptions,
) {
  const cachedBuffer = bufferCache.get(artifactId);
  if (cachedBuffer) {
    return cachedBuffer;
  }

  const context = getStemAudioContext();
  if (!context) {
    throw new Error("Stem playback requires AudioContext support.");
  }

  const bufferPromise = fetch(api.streamArtifactUrl(artifactId))
    .then(async (response) => {
      if (!response.ok) {
        throw new Error(`Failed to load stem artifact ${artifactId}.`);
      }
      return response.arrayBuffer();
    })
    .then((audioData) => context.decodeAudioData(audioData.slice(0)))
    .catch((error) => {
      bufferCache.delete(artifactId);
      throw error;
    });

  bufferCache.set(artifactId, bufferPromise);
  return bufferPromise;
}

export async function loadStemBuffers(
  artifactIds: string[],
  options: StemBufferLoaderOptions,
) {
  const loadedBuffers = await Promise.all(
    artifactIds.map(async (artifactId) => [
      artifactId,
      await loadStemBuffer(artifactId, options),
    ] as const),
  );
  return Object.fromEntries(loadedBuffers);
}
