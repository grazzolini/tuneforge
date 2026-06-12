export type ToolId = "tuner" | "metronome" | "chord-dictionary";

export function nextToolSearchParams(searchParams: URLSearchParams, tool: ToolId) {
  const nextSearchParams = new URLSearchParams(searchParams);
  if (tool === "tuner") {
    nextSearchParams.delete("tool");
    nextSearchParams.delete("bpm");
    nextSearchParams.delete("followPlayback");
    nextSearchParams.delete("projectId");
  } else if (tool === "metronome") {
    nextSearchParams.set("tool", "metronome");
    nextSearchParams.delete("followPlayback");
    nextSearchParams.delete("projectId");
  } else {
    nextSearchParams.set("tool", "chord-dictionary");
    nextSearchParams.delete("bpm");
  }
  return nextSearchParams;
}
