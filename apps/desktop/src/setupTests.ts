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
  state: AudioContextState = "running";
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

  createBufferSource = vi.fn(() => {
    const source = {
      buffer: null,
      onended: null,
      connect: vi.fn(),
      disconnect: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
    } as unknown as MockAudioBufferSourceNode;
    this.createdSources.push(source);
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
      start: vi.fn(),
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
      connect: vi.fn(),
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

Object.defineProperty(globalThis, "__mockMediaDevices", {
  writable: true,
  value: mockMediaDevicesController,
});
