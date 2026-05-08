export function getWebAudioContextConstructor() {
  if (typeof window === "undefined") {
    return null;
  }

  return (
    window.AudioContext ??
    (window as Window & typeof globalThis & { webkitAudioContext?: typeof AudioContext })
      .webkitAudioContext ??
    null
  );
}

export async function activateWebAudioContext(context: AudioContext) {
  if (context.state === "suspended") {
    await context.resume();
  }

  if (context.state !== "running") {
    throw new Error(`Web Audio context is ${context.state}, not running.`);
  }
}

export function primeWebAudioContext(context: AudioContext) {
  const primedContext = context as AudioContext & { __tuneforgePriming?: boolean };
  try {
    primedContext.__tuneforgePriming = true;
    const source = context.createBufferSource();
    const gain = context.createGain();
    source.buffer = context.createBuffer(1, 1, context.sampleRate);
    gain.gain.value = 0;
    source.connect(gain);
    gain.connect(context.destination);
    source.start(0);
    window.setTimeout(() => {
      try {
        source.disconnect();
        gain.disconnect();
      } catch {
        // Nodes can already be disconnected by the backend.
      }
    }, 0);
  } catch {
    // Priming is opportunistic. Activation still decides whether playback can continue.
  } finally {
    delete primedContext.__tuneforgePriming;
  }
}
