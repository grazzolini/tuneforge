import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runtime = path.resolve(
  process.env.TUNEFORGE_FFMPEG_RUNTIME_DIR
    ?? path.join(workspaceRoot, "packaging", "ffmpeg", "generated", "macos-arm64"),
);
const libraryRoot = path.join(runtime, "lib");
const ownedFfmpeg = path.join(runtime, "bin", "ffmpeg");
const ownedFfprobe = path.join(runtime, "bin", "ffprobe");
const fixtureFfmpeg = process.env.TUNEFORGE_FIXTURE_FFMPEG ?? "ffmpeg";
const sanitizerFlags = process.env.TUNEFORGE_FFMPEG_SHIM_SANITIZERS === "1"
  ? ["-fsanitize=address,undefined", "-fno-omit-frame-pointer"]
  : [];
const work = mkdtempSync(path.join(tmpdir(), "tuneforge-ffmpeg-shim-test-"));
const runtimeEnv = {
  ...process.env,
  DYLD_LIBRARY_PATH: [libraryRoot, process.env.DYLD_LIBRARY_PATH].filter(Boolean).join(":"),
};

function fail(message) {
  throw new Error(message);
}

function run(command, args, { allowFailure = false, env = process.env } = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", env });
  if (result.error) throw result.error;
  if (!allowFailure && result.status !== 0) {
    fail(`${command} exited ${result.status}: ${(result.stderr ?? "").trim()}`);
  }
  return result;
}

function runAsync(command, args, { env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (status) => status === 0
      ? resolve({ status, stderr })
      : reject(new Error(`${command} exited ${status}: ${stderr.trim()}`)));
  });
}

function wav(file, {
  rate = 44_100, channels = 1, frequencies = [440], seconds = 2, amplitude = 16_000,
} = {}) {
  const frames = Math.round(rate * seconds);
  const data = Buffer.alloc(frames * channels * 2);
  for (let frame = 0; frame < frames; frame += 1) {
    for (let channel = 0; channel < channels; channel += 1) {
      const frequency = frequencies[channel] ?? frequencies[0];
      const sample = Math.round(Math.sin(2 * Math.PI * frequency * frame / rate) * amplitude);
      data.writeInt16LE(sample, (frame * channels + channel) * 2);
    }
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0); header.writeUInt32LE(36 + data.length, 4); header.write("WAVE", 8);
  header.write("fmt ", 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22); header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * channels * 2, 28); header.writeUInt16LE(channels * 2, 32);
  header.writeUInt16LE(16, 34); header.write("data", 36); header.writeUInt32LE(data.length, 40);
  writeFileSync(file, Buffer.concat([header, data]));
}

function probe(file) {
  const result = run(ownedFfprobe, [
    "-v", "error", "-select_streams", "a:0", "-show_entries",
    "stream=codec_name,profile,sample_rate,channels,bit_rate,duration", "-of", "json", file,
  ], { env: runtimeEnv });
  const stream = JSON.parse(result.stdout).streams?.[0];
  if (!stream) fail(`No audio stream in ${file}`);
  return stream;
}

function decodedPcm(file) {
  const decoded = path.join(work, `${path.basename(file)}-decoded.wav`);
  run(ownedFfmpeg, ["-v", "error", "-y", "-i", file, "-map", "0:a:0", "-c:a", "pcm_s16le", decoded], {
    env: runtimeEnv,
  });
  const bytes = readFileSync(decoded);
  let offset = 12;
  let rate = 0;
  let channels = 0;
  let data = null;
  while (offset + 8 <= bytes.length) {
    const id = bytes.toString("ascii", offset, offset + 4);
    const size = bytes.readUInt32LE(offset + 4);
    if (id === "fmt ") {
      channels = bytes.readUInt16LE(offset + 10);
      rate = bytes.readUInt32LE(offset + 12);
    } else if (id === "data") {
      data = bytes.subarray(offset + 8, offset + 8 + size);
      break;
    }
    offset += 8 + size + (size % 2);
  }
  if (!data || !rate || !channels) fail(`Invalid decoded WAV: ${decoded}`);
  const samples = [];
  for (let index = 0; index + channels * 2 <= data.length; index += channels * 2) {
    samples.push(data.readInt16LE(index) / 32768);
  }
  return { samples, rate, channels, duration: samples.length / rate };
}

function frequency(audio) {
  const samples = audio.samples.slice(0, 16_384);
  let bestFrequency = 0;
  let bestPower = -1;
  for (let candidate = 380; candidate <= 920; candidate += 1) {
    const coefficient = 2 * Math.cos(2 * Math.PI * candidate / audio.rate);
    let q1 = 0;
    let q2 = 0;
    for (let index = 0; index < samples.length; index += 1) {
      const window = 0.5 - 0.5 * Math.cos(2 * Math.PI * index / (samples.length - 1));
      const q0 = coefficient * q1 - q2 + samples[index] * window;
      q2 = q1;
      q1 = q0;
    }
    const power = q1 * q1 + q2 * q2 - coefficient * q1 * q2;
    if (power > bestPower) {
      bestPower = power;
      bestFrequency = candidate;
    }
  }
  return bestFrequency;
}

function peak(audio) {
  return audio.samples.reduce((maximum, sample) => Math.max(maximum, Math.abs(sample)), 0);
}

function assertNear(actual, expected, tolerance, label) {
  if (Math.abs(actual - expected) > tolerance) {
    fail(`${label}: expected ${expected} ± ${tolerance}, got ${actual}`);
  }
}

function render(harness, input, output, format, cents = 0, cancelMode = "never") {
  return run(harness, [input, output, format, String(cents), cancelMode], {
    allowFailure: cancelMode !== "never",
    env: runtimeEnv,
  });
}

try {
  const harness = path.join(work, "bridge-test");
  run("clang", [
    "-std=c11", "-Wall", "-Wextra", "-Werror",
    ...sanitizerFlags,
    `-I${path.join(runtime, "include")}`,
    path.join(workspaceRoot, "apps", "desktop", "src-tauri", "src", "mobile_ffmpeg", "bridge.c"),
    path.join(workspaceRoot, "apps", "desktop", "src-tauri", "src", "mobile_ffmpeg", "bridge_test.c"),
    `-L${libraryRoot}`, `-Wl,-rpath,${libraryRoot}`,
    "-lavfilter", "-lavformat", "-lavcodec", "-lswresample", "-lavutil", "-lmp3lame",
    "-o", harness,
  ]);

  const mono = path.join(work, "mono-44100.wav");
  const stereo = path.join(work, "stereo-48000.wav");
  const mono32 = path.join(work, "mono-32000.wav");
  const stereo44 = path.join(work, "stereo-44100.wav");
  const stereo96 = path.join(work, "stereo-96000.wav");
  const surround = path.join(work, "surround-48000.wav");
  const second = path.join(work, "second.wav");
  wav(mono);
  wav(stereo, { rate: 48_000, channels: 2, frequencies: [440, 660] });
  wav(mono32, { rate: 32_000 });
  wav(stereo44, { channels: 2, frequencies: [440, 660] });
  wav(stereo96, { rate: 96_000, channels: 2, frequencies: [440, 660] });
  wav(surround, { rate: 48_000, channels: 6, frequencies: [220, 330, 440, 550, 660, 770] });
  wav(second, { frequencies: [880] });

  const fixtureSpecs = [
    ["flac", ["-c:a", "flac"], "flac"],
    ["mp3", ["-c:a", "libmp3lame", "-b:a", "192k"], "mp3"],
    ["m4a", ["-c:a", "aac", "-b:a", "192k"], "m4a"],
    ["aac", ["-c:a", "aac", "-b:a", "192k", "-f", "adts"], "aac"],
    ["ogg", ["-ac", "2", "-c:a", "vorbis", "-strict", "experimental"], "ogg"],
    ["mp4", ["-c:a", "aac", "-b:a", "192k"], "mp4"],
    ["alac", ["-c:a", "alac"], "m4a"],
    ["pcm24", ["-c:a", "pcm_s24le"], "wav"],
    ["pcmf32", ["-c:a", "pcm_f32le"], "wav"],
  ];
  const inputs = [mono];
  for (const [name, options, extension] of fixtureSpecs) {
    const output = path.join(work, `${name}.${extension}`);
    run(fixtureFfmpeg, ["-v", "error", "-y", "-i", mono, ...options, output]);
    inputs.push(output);
  }
  const webm = path.join(work, "audio.webm");
  run(fixtureFfmpeg, ["-v", "error", "-y", "-i", mono, "-c:a", "libopus", webm]);
  inputs.push(webm);
  const mixedWebm = path.join(work, "mixed-av.webm");
  run(fixtureFfmpeg, [
    "-v", "error", "-y", "-f", "lavfi", "-i", "color=c=black:s=16x16:r=1:d=2",
    "-i", mono, "-shortest", "-c:v", "libvpx-vp9", "-c:a", "libopus", mixedWebm,
  ]);
  inputs.push(mixedWebm);
  const mixedVorbisWebm = path.join(work, "mixed-av-vorbis.webm");
  run(fixtureFfmpeg, [
    "-v", "error", "-y", "-f", "lavfi", "-i", "color=c=black:s=16x16:r=1:d=2",
    "-i", mono, "-map", "0:v:0", "-map", "1:a:0", "-shortest", "-c:v", "libvpx-vp9",
    "-ac", "2", "-c:a", "vorbis", "-strict",
    "experimental", mixedVorbisWebm,
  ]);
  inputs.push(mixedVorbisWebm);
  const multiple = path.join(work, "multiple.mka");
  run(fixtureFfmpeg, [
    "-v", "error", "-y", "-i", mono, "-i", second, "-map", "0:a:0", "-map", "1:a:0",
    "-c:a", "flac", multiple,
  ]);
  inputs.push(multiple);

  for (const [index, input] of inputs.entries()) {
    const output = path.join(work, `input-${index}.wav`);
    const result = render(harness, input, output, "wav");
    if (!result.stderr.includes("progress=100")) fail(`Progress did not complete for ${input}`);
    const audio = decodedPcm(output);
    assertNear(audio.duration, 2, 0.08, `duration for ${path.basename(input)}`);
    assertNear(frequency(audio), 440, 4, `first audio stream for ${path.basename(input)}`);
  }

  const outputProfiles = { wav: "pcm_s16le", flac: "flac", mp3: "mp3", m4a: "aac" };
  for (const [format, codec] of Object.entries(outputProfiles)) {
    const output = path.join(work, `profile.${format}`);
    render(harness, stereo, output, format);
    const stream = probe(output);
    if (stream.codec_name !== codec) fail(`${format} used ${stream.codec_name}, expected ${codec}`);
    if (Number(stream.sample_rate) !== 48_000 || stream.channels !== 2) {
      fail(`${format} did not preserve 48 kHz stereo`);
    }
    const audio = decodedPcm(output);
    assertNear(audio.duration, 2, format === "wav" || format === "flac" ? 0.03 : 0.15, `${format} duration`);
  }

  for (const source of [mono32, stereo44]) {
    const expected = decodedPcm(source);
    for (const format of Object.keys(outputProfiles)) {
      const output = path.join(work, `${path.basename(source)}.${format}`);
      render(harness, source, output, format);
      const stream = probe(output);
      if (Number(stream.sample_rate) !== expected.rate || stream.channels !== expected.channels) {
        fail(`${format} did not preserve ${expected.rate} Hz/${expected.channels} ch`);
      }
    }
  }

  for (const [source, label] of [[stereo96, "96 kHz"], [surround, "5.1"]]) {
    const output = path.join(work, `${path.basename(source)}.mp3`);
    render(harness, source, output, "mp3");
    const stream = probe(output);
    if (Number(stream.sample_rate) !== 48_000 || stream.channels !== 2) {
      fail(`${label} MP3 negotiation produced ${stream.sample_rate} Hz/${stream.channels} ch`);
    }
  }

  for (const name of ["m4a.m4a", "audio.webm"]) {
    const source = path.join(work, name);
    const decoded = decodedPcm(source);
    assertNear(decoded.duration, 2, 0.08, `${name} decoded priming/duration`);
    assertNear(frequency(decoded), 440, 4, `${name} decoded pitch`);
  }

  const headroom = path.join(work, "headroom.wav");
  wav(headroom, { amplitude: 29_000 });
  for (const format of Object.keys(outputProfiles)) {
    const output = path.join(work, `headroom.${format}`);
    render(harness, headroom, output, format);
    const outputPeak = peak(decodedPcm(output));
    if (outputPeak < 0.75 || outputPeak > 0.99999) {
      fail(`${format} peak/headroom out of bounds: ${outputPeak}`);
    }
  }

  const pitched = path.join(work, "pitched.wav");
  render(harness, mono, pitched, "wav", 1200);
  const pitchedAudio = decodedPcm(pitched);
  assertNear(pitchedAudio.duration, 2, 0.08, "pitch-shift duration compensation");
  assertNear(frequency(pitchedAudio), 880, 8, "pitch-shift frequency");

  const cancelled = path.join(work, "cancelled.wav");
  const cancelResult = render(harness, mono, cancelled, "wav", 0, "immediate");
  if (cancelResult.status === 0 || !cancelResult.stderr.includes("cancelled")) {
    fail("Immediate cancellation did not stop the shim");
  }
  if (existsSync(cancelled)) fail("Immediate cancellation left a partial output");
  const longInput = path.join(work, "long.wav");
  wav(longInput, { seconds: 30, channels: 2 });
  const cancelledMidway = path.join(work, "cancelled-midway.flac");
  const midwayResult = render(harness, longInput, cancelledMidway, "flac", 0, "35");
  if (midwayResult.status === 0 || !midwayResult.stderr.includes("cancelled")) {
    fail("Mid-operation cancellation did not stop the shim");
  }
  if (existsSync(cancelledMidway)) fail("Mid-operation cancellation left a partial output");
  const malformed = path.join(work, "malformed.mp3");
  writeFileSync(malformed, Buffer.from("not audio"));
  const malformedResult = run(harness, [malformed, path.join(work, "bad.wav"), "wav", "0", "never"], {
    allowFailure: true,
    env: runtimeEnv,
  });
  if (malformedResult.status === 0 || !malformedResult.stderr.includes("open input")) {
    fail(`Malformed input did not fail at the native boundary: ${malformedResult.stderr.trim()}`);
  }

  const truncated = path.join(work, "truncated.m4a");
  const m4aBytes = readFileSync(path.join(work, "m4a.m4a"));
  writeFileSync(truncated, m4aBytes.subarray(0, Math.max(32, Math.floor(m4aBytes.length / 2))));
  const truncatedResult = run(harness, [
    truncated, path.join(work, "truncated.wav"), "wav", "0", "never",
  ], { allowFailure: true, env: runtimeEnv });
  if (truncatedResult.status === 0) fail("Truncated input unexpectedly completed");
  if (existsSync(path.join(work, "truncated.wav"))) fail("Truncated input left a partial output");

  const concurrentA = path.join(work, "concurrent-a.flac");
  const concurrentB = path.join(work, "concurrent-b.m4a");
  await Promise.all([
    runAsync(harness, [stereo, concurrentA, "flac", "0", "never"], { env: runtimeEnv }),
    runAsync(harness, [mono32, concurrentB, "m4a", "0", "never"], { env: runtimeEnv }),
  ]);
  assertNear(decodedPcm(concurrentA).duration, 2, 0.03, "concurrent FLAC duration");
  assertNear(decodedPcm(concurrentB).duration, 2, 0.15, "concurrent M4A duration");

  process.stdout.write(`${JSON.stringify({
    inputs: inputs.length,
    outputs: 4,
    rateChannelProfiles: 8,
    negotiatedMp3Profiles: 2,
    cancellation: ["immediate", "mid-operation"],
    concurrency: 2,
    pitch: true,
  })}\n`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
