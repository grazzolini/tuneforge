import "@testing-library/jest-dom/vitest";
import { vi } from "vitest";

type MockAudioBufferSourceNode = AudioBufferSourceNode & {
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
};

type MockAudioParam = AudioParam & {
  exponentialRampToValueAtTime: ReturnType<typeof vi.fn>;
  setValueAtTime: ReturnType<typeof vi.fn>;
};

type MockGainNode = GainNode & {
  gain: MockAudioParam;
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
};

type MockOscillatorNode = OscillatorNode & {
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  frequency: MockAudioParam;
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
};

type MockAnalyserNode = AnalyserNode & {
  getFloatTimeDomainData: ReturnType<typeof vi.fn>;
  setSamples: (samples: Float32Array | null) => void;
};

type MockMediaStreamAudioSourceNode = MediaStreamAudioSourceNode & {
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
};

type MockAudioContextInstance = AudioContext & {
  advanceTime: (seconds: number) => void;
  createdAnalysers: MockAnalyserNode[];
  createdOscillators: MockOscillatorNode[];
  createdMediaStreamSources: MockMediaStreamAudioSourceNode[];
  createdSources: MockAudioBufferSourceNode[];
  createAnalyser: ReturnType<typeof vi.fn>;
  createBuffer: ReturnType<typeof vi.fn>;
  createBufferSource: ReturnType<typeof vi.fn>;
  createGain: ReturnType<typeof vi.fn>;
  createOscillator: ReturnType<typeof vi.fn>;
  createMediaStreamSource: ReturnType<typeof vi.fn>;
  decodeAudioData: ReturnType<typeof vi.fn>;
  resume: ReturnType<typeof vi.fn>;
  suspend: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
};

type MockMediaDevicesController = {
  clearGetUserMediaError: () => void;
  enumerateDevices: ReturnType<typeof vi.fn>;
  getUserMedia: ReturnType<typeof vi.fn>;
  revealLabels: () => void;
  rejectGetUserMedia: (error: Error | DOMException) => void;
  reset: () => void;
  setDevices: (devices: MediaDeviceInfo[]) => void;
};

type MockMediaSessionActionHandler = (details?: MediaSessionActionDetails) => void;

type MockMediaSessionController = MediaSession & {
  actionHandlers: Map<string, MockMediaSessionActionHandler>;
  dispatchAction: (action: string, details?: MediaSessionActionDetails) => void;
  reset: () => void;
  throwOnAction: (action: MediaSessionAction | "seekto") => void;
};

type MockWakeLockSentinel = {
  released: boolean;
  release: ReturnType<typeof vi.fn>;
  addEventListener: ReturnType<typeof vi.fn>;
  dispatchRelease: () => void;
  removeEventListener: ReturnType<typeof vi.fn>;
};

type MockWakeLockController = {
  request: ReturnType<typeof vi.fn>;
  sentinels: MockWakeLockSentinel[];
  reset: () => void;
};

function createStorageMock(): Storage {
  let storage = new Map<string, string>();

  return {
    get length() {
      return storage.size;
    },
    clear() {
      storage = new Map<string, string>();
    },
    getItem(key: string) {
      return storage.get(key) ?? null;
    },
    key(index: number) {
      return Array.from(storage.keys())[index] ?? null;
    },
    removeItem(key: string) {
      storage.delete(key);
    },
    setItem(key: string, value: string) {
      storage.set(key, value);
    },
  };
}

Object.defineProperty(window, "localStorage", {
  writable: true,
  value: createStorageMock(),
});

Object.defineProperty(window, "sessionStorage", {
  writable: true,
  value: createStorageMock(),
});

function makeMediaDevice(deviceId: string, label: string): MediaDeviceInfo {
  return {
    deviceId,
    groupId: `group-${deviceId}`,
    kind: "audioinput",
    label,
    toJSON: () => ({}),
  } as MediaDeviceInfo;
}

function makeMediaStream(): MediaStream {
  const track = {
    kind: "audio",
    stop: vi.fn(),
  } as unknown as MediaStreamTrack;

  return {
    getAudioTracks: vi.fn(() => [track]),
    getTracks: vi.fn(() => [track]),
  } as unknown as MediaStream;
}

const defaultMediaDevices = [
  makeMediaDevice("built-in", "Built-in Microphone"),
  makeMediaDevice("usb", "USB Interface"),
];
let mediaDevices = [...defaultMediaDevices];
let mediaDeviceLabelsVisible = false;
let getUserMediaError: Error | DOMException | null = null;

const mockMediaDevices = {
  addEventListener: vi.fn(),
  enumerateDevices: vi.fn(async () =>
    mediaDevices.map((device) => ({
      ...device,
      label: mediaDeviceLabelsVisible ? device.label : "",
    })),
  ),
  getUserMedia: vi.fn(async () => {
    if (getUserMediaError) {
      throw getUserMediaError;
    }
    mediaDeviceLabelsVisible = true;
    return makeMediaStream();
  }),
  removeEventListener: vi.fn(),
};

const mockMediaDevicesController: MockMediaDevicesController = {
  clearGetUserMediaError() {
    getUserMediaError = null;
  },
  enumerateDevices: mockMediaDevices.enumerateDevices,
  getUserMedia: mockMediaDevices.getUserMedia,
  revealLabels() {
    mediaDeviceLabelsVisible = true;
  },
  rejectGetUserMedia(error) {
    getUserMediaError = error;
  },
  reset() {
    mediaDevices = [...defaultMediaDevices];
    mediaDeviceLabelsVisible = false;
    getUserMediaError = null;
    mockMediaDevices.addEventListener.mockClear();
    mockMediaDevices.enumerateDevices.mockClear();
    mockMediaDevices.getUserMedia.mockClear();
    mockMediaDevices.removeEventListener.mockClear();
  },
  setDevices(devices) {
    mediaDevices = devices;
  },
};

Object.defineProperty(navigator, "mediaDevices", {
  configurable: true,
  value: mockMediaDevices,
});

const mockMediaSessionActionHandlers = new Map<string, MockMediaSessionActionHandler>();
const mockMediaSessionThrowingActions = new Set<MediaSessionAction | "seekto">();
const mockSetMediaSessionActionHandler = vi.fn(
  (action: MediaSessionAction | "seekto", handler: MockMediaSessionActionHandler | null) => {
    if (mockMediaSessionThrowingActions.has(action)) {
      throw new Error(`Unsupported media session action: ${action}`);
    }
    if (handler) {
      mockMediaSessionActionHandlers.set(action, handler);
      return;
    }
    mockMediaSessionActionHandlers.delete(action);
  },
);
const mockSetMediaSessionPositionState = vi.fn();
const mockMediaSession = {
  metadata: null,
  playbackState: "none",
  setActionHandler: mockSetMediaSessionActionHandler,
  setPositionState: mockSetMediaSessionPositionState,
  actionHandlers: mockMediaSessionActionHandlers,
  dispatchAction(action: string, details?: MediaSessionActionDetails) {
    mockMediaSessionActionHandlers.get(action)?.(details);
  },
  reset: () => {
    mockMediaSession.metadata = null;
    mockMediaSession.playbackState = "none";
    mockMediaSessionActionHandlers.clear();
    mockMediaSessionThrowingActions.clear();
    mockSetMediaSessionActionHandler.mockClear();
    mockSetMediaSessionPositionState.mockClear();
  },
  throwOnAction: (action: MediaSessionAction | "seekto") => {
    mockMediaSessionThrowingActions.add(action);
  },
} as unknown as MockMediaSessionController;

class MockMediaMetadata {
  album?: string;
  artist?: string;
  artwork?: MediaImage[];
  title?: string;

  constructor(init: MediaMetadataInit = {}) {
    this.album = init.album;
    this.artist = init.artist;
    this.artwork = init.artwork;
    this.title = init.title;
  }
}

const mockWakeLock: MockWakeLockController = {
  request: vi.fn(async () => {
    const releaseListeners = new Set<() => void>();
    const sentinel: MockWakeLockSentinel = {
      released: false,
      release: vi.fn(async () => {
        sentinel.released = true;
      }),
      addEventListener: vi.fn((type: "release", listener: () => void) => {
        if (type === "release") {
          releaseListeners.add(listener);
        }
      }),
      dispatchRelease() {
        sentinel.released = true;
        releaseListeners.forEach((listener) => listener());
      },
      removeEventListener: vi.fn((type: "release", listener: () => void) => {
        if (type === "release") {
          releaseListeners.delete(listener);
        }
      }),
    };
    mockWakeLock.sentinels.push(sentinel);
    return sentinel;
  }),
  sentinels: [],
  reset() {
    this.request.mockClear();
    this.sentinels.splice(0, this.sentinels.length);
  },
};

Object.defineProperty(navigator, "mediaSession", {
  configurable: true,
  value: mockMediaSession,
});

Object.defineProperty(navigator, "wakeLock", {
  configurable: true,
  value: mockWakeLock,
});

Object.defineProperty(globalThis, "MediaMetadata", {
  configurable: true,
  value: MockMediaMetadata,
});

Object.defineProperty(window, "MediaMetadata", {
  configurable: true,
  value: MockMediaMetadata,
});

Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
});

Object.defineProperty(window.HTMLElement.prototype, "scrollIntoView", {
  writable: true,
  value: vi.fn(),
});

Object.defineProperty(window.HTMLMediaElement.prototype, "play", {
  writable: true,
  value: vi.fn().mockResolvedValue(undefined),
});

Object.defineProperty(window.HTMLMediaElement.prototype, "pause", {
  writable: true,
  value: vi.fn(),
});

const mockAudioContexts: MockAudioContextInstance[] = [];
let mockAudioContextInitialState: AudioContextState = "running";
let mockAudioSourceStartError: Error | null = null;
const RAF_STEP_SECONDS = 1 / 60;
let nextAnimationFrameId = 1;
let mockAnimationTimeMs = 0;
const pendingAnimationFrames = new Map<number, ReturnType<typeof setTimeout>>();

function advanceMockAudioTime(seconds: number) {
  mockAudioContexts.forEach((audioContext) => {
    audioContext.advanceTime(seconds);
  });
}

Object.defineProperty(window, "requestAnimationFrame", {
  writable: true,
  value: vi.fn((callback: FrameRequestCallback) => {
    const frameId = nextAnimationFrameId++;
    const timer = setTimeout(() => {
      pendingAnimationFrames.delete(frameId);
      mockAnimationTimeMs += RAF_STEP_SECONDS * 1000;
      advanceMockAudioTime(RAF_STEP_SECONDS);
      callback(mockAnimationTimeMs);
    }, 0);
    pendingAnimationFrames.set(frameId, timer);
    return frameId;
  }),
});

Object.defineProperty(window, "cancelAnimationFrame", {
  writable: true,
  value: vi.fn((frameId: number) => {
    const timer = pendingAnimationFrames.get(frameId);
    if (!timer) {
      return;
    }
    clearTimeout(timer);
    pendingAnimationFrames.delete(frameId);
  }),
});

class MockAudioContext {
  destination = {} as AudioDestinationNode;
  sampleRate = 48000;
  state: AudioContextState = mockAudioContextInitialState;
  createdAnalysers: MockAnalyserNode[] = [];
  createdOscillators: MockOscillatorNode[] = [];
  createdMediaStreamSources: MockMediaStreamAudioSourceNode[] = [];
  createdSources: MockAudioBufferSourceNode[] = [];
  private currentTimeSeconds = 0;

  constructor() {
    mockAudioContexts.push(this as unknown as MockAudioContextInstance);
  }

  get currentTime() {
    return this.currentTimeSeconds;
  }

  advanceTime = (seconds: number) => {
    if (this.state !== "running") {
      return;
    }
    this.currentTimeSeconds += seconds;
  };

  resume = vi.fn(async () => {
    if (this.state === "closed") {
      return;
    }
    this.state = "running";
  });

  suspend = vi.fn(async () => {
    this.state = "suspended";
  });

  close = vi.fn(async () => {
    this.state = "closed";
  });

  decodeAudioData = vi.fn(async (audioData: ArrayBuffer) => {
    const view = new DataView(audioData);
    const duration = audioData.byteLength >= 8 ? view.getFloat64(0, true) || 182 : 182;
    return { duration } as AudioBuffer;
  });

  createBuffer = vi.fn((numberOfChannels: number, length: number, sampleRate: number) => ({
    duration: sampleRate > 0 ? length / sampleRate : 0,
    length,
    numberOfChannels,
    sampleRate,
  }) as AudioBuffer);

  createBufferSource = vi.fn(() => {
    const source = {
      buffer: null,
      onended: null,
      connect: vi.fn(),
      disconnect: vi.fn(),
      start: vi.fn(() => {
        if (
          !(this as MockAudioContext & { __tuneforgePriming?: boolean }).__tuneforgePriming &&
          mockAudioSourceStartError
        ) {
          const error = mockAudioSourceStartError;
          mockAudioSourceStartError = null;
          throw error;
        }
        this.createdAnalysers.forEach((analyser) => {
          analyser.setSamples(new Float32Array([0.08, -0.08, 0.04, -0.04]));
        });
      }),
      stop: vi.fn(),
    } as unknown as MockAudioBufferSourceNode;
    if (!(this as MockAudioContext & { __tuneforgePriming?: boolean }).__tuneforgePriming) {
      this.createdSources.push(source);
    }
    return source;
  });

  createGain = vi.fn(() => ({
    gain: {
      value: 1,
      exponentialRampToValueAtTime: vi.fn(),
      setValueAtTime: vi.fn(),
    },
    connect: vi.fn(),
    disconnect: vi.fn(),
  }) as unknown as MockGainNode);

  createOscillator = vi.fn(() => {
    const oscillator = {
      connect: vi.fn(),
      disconnect: vi.fn(),
      frequency: {
        value: 440,
        exponentialRampToValueAtTime: vi.fn(),
        setValueAtTime: vi.fn(),
      },
      onended: null,
      start: vi.fn(() => {
        this.createdAnalysers.forEach((analyser) => {
          analyser.setSamples(new Float32Array([0.08, -0.08, 0.04, -0.04]));
        });
      }),
      stop: vi.fn(),
      type: "sine",
    } as unknown as MockOscillatorNode;
    this.createdOscillators.push(oscillator);
    return oscillator;
  });

  createAnalyser = vi.fn(() => {
    let samples: Float32Array | null = null;
    const analyser = {
      connect: vi.fn(),
      disconnect: vi.fn(),
      fftSize: 2048,
      frequencyBinCount: 1024,
      getFloatTimeDomainData: vi.fn((target: Float32Array) => {
        if (!samples) {
          target.fill(0);
          return;
        }
        for (let index = 0; index < target.length; index += 1) {
          target[index] = samples[index % samples.length] ?? 0;
        }
      }),
      smoothingTimeConstant: 0,
      setSamples(nextSamples: Float32Array | null) {
        samples = nextSamples;
      },
    } as unknown as MockAnalyserNode;
    this.createdAnalysers.push(analyser);
    return analyser;
  });

  createMediaStreamSource = vi.fn(() => {
    const source = {
      connect: vi.fn((node: AudioNode) => {
        const analyser = node as MockAnalyserNode;
        if (typeof analyser.setSamples === "function") {
          analyser.setSamples(new Float32Array([0.08, -0.08, 0.04, -0.04]));
        }
      }),
      disconnect: vi.fn(),
    } as unknown as MockMediaStreamAudioSourceNode;
    this.createdMediaStreamSources.push(source);
    return source;
  });
}

const mockFetch = vi.fn(async () => {
  const bytes = new ArrayBuffer(8);
  new DataView(bytes).setFloat64(0, 182, true);
  return {
    ok: true,
    arrayBuffer: vi.fn(async () => bytes),
  } as unknown as Response;
});

Object.defineProperty(globalThis, "fetch", {
  writable: true,
  value: mockFetch,
});

Object.defineProperty(window, "AudioContext", {
  writable: true,
  value: MockAudioContext,
});

Object.defineProperty(window, "webkitAudioContext", {
  writable: true,
  value: MockAudioContext,
});

Object.defineProperty(globalThis, "__mockAudioContexts", {
  writable: true,
  value: mockAudioContexts,
});

Object.defineProperty(globalThis, "__setMockAudioContextInitialState", {
  writable: true,
  value: (state: AudioContextState) => {
    mockAudioContextInitialState = state;
  },
});

Object.defineProperty(globalThis, "__setMockAudioSourceStartError", {
  writable: true,
  value: (error: Error | null) => {
    mockAudioSourceStartError = error;
  },
});

Object.defineProperty(globalThis, "__mockMediaDevices", {
  writable: true,
  value: mockMediaDevicesController,
});

Object.defineProperty(globalThis, "__mockMediaSession", {
  writable: true,
  value: mockMediaSession,
});

Object.defineProperty(globalThis, "__mockWakeLock", {
  writable: true,
  value: mockWakeLock,
});
