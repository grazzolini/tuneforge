import { describe, expect, it } from "vitest";
import type { ArtifactSchema } from "../../lib/api";
import {
  buildExportAudioSets,
  androidAudioExportUnavailableReason,
  defaultExportWorkspaceState,
  reconcileExportWorkspaceState,
  exportOutputNames,
  exportPresetForSelection,
} from "./exportWorkspaceUtils";

const createdAt = "2026-08-13T10:00:00Z";

function artifact(
  id: string,
  type: string,
  createdAt: string,
  sourceArtifactId?: string,
): ArtifactSchema {
  return {
    id,
    project_id: "project-1",
    type,
    format: "wav",
    path: `/tmp/${id}.wav`,
    size_bytes: 1,
    generated_by: "test",
    can_delete: true,
    can_regenerate: false,
    metadata: sourceArtifactId ? { source_artifact_id: sourceArtifactId } : {},
    created_at: createdAt,
  };
}

function capabilities({
  platform = "desktop",
  formats = ["wav", "flac", "mp3", "m4a"],
  destinations = ["single_file", "folder", "zip"],
  maxArtifactCount = null,
}: {
  platform?: "desktop" | "android";
  formats?: string[];
  destinations?: string[];
  maxArtifactCount?: number | null;
} = {}) {
  return {
    platform,
    formats: ["wav", "flac", "mp3", "m4a"].map((id) => ({
      id,
      available: formats.includes(id),
      reason: null,
    })),
    destinations: ["single_file", "folder", "zip"].map((id) => ({
      id,
      available: destinations.includes(id),
      reason: null,
    })),
    max_artifact_count: maxArtifactCount,
  };
}

describe("export workspace utilities", () => {
  it("numbers practice mixes by creation time with an ID tiebreaker", () => {
    const audioSets = buildExportAudioSets([
      artifact("mix-z", "preview_mix", "2026-08-13T12:00:00Z"),
      artifact("source", "source_audio", "2026-08-13T10:00:00Z"),
      artifact("mix-b", "preview_mix", "2026-08-13T11:00:00Z"),
      artifact("mix-a", "preview_mix", "2026-08-13T11:00:00Z"),
      artifact("vocals", "vocal_stem", "2026-08-13T12:01:00Z", "mix-a"),
    ]);

    expect(audioSets.map((audioSet) => [audioSet.artifact.id, audioSet.label])).toEqual([
      ["source", "Source Track"],
      ["mix-a", "Practice Mix 1"],
      ["mix-b", "Practice Mix 2"],
      ["mix-z", "Practice Mix 3"],
    ]);
    expect(audioSets[1]?.stems.map((stem) => stem.id)).toEqual(["vocals"]);
  });

  it("recognizes exact presets and keeps manual subsets custom", () => {
    const [audioSet] = buildExportAudioSets([
      artifact("source", "source_audio", "2026-08-13T10:00:00Z"),
      artifact("vocals", "vocal_stem", "2026-08-13T10:01:00Z", "source"),
      artifact("drums", "drums_stem", "2026-08-13T10:02:00Z", "source"),
    ]);
    expect(audioSet).toBeDefined();
    if (!audioSet) return;

    expect(exportPresetForSelection(audioSet, new Set(["source"]))).toBe("track");
    expect(exportPresetForSelection(audioSet, new Set(["vocals", "drums"]))).toBe("stems");
    expect(exportPresetForSelection(audioSet, new Set(["source", "vocals", "drums"]))).toBe(
      "track-and-stems",
    );
    expect(exportPresetForSelection(audioSet, new Set(["source", "vocals"]))).toBe("custom");
    expect(exportOutputNames(audioSet, new Set(["source", "vocals"]), "My take", "m4a")).toEqual([
      "My take - Source.m4a",
      "My take - Source - Vocals.m4a",
    ]);
  });

  it("restores valid custom choices, including a desktop destination", () => {
    const [audioSet] = buildExportAudioSets([
      artifact("source", "source_audio", createdAt),
      artifact("vocals", "vocal_stem", createdAt, "source"),
    ]);
    expect(audioSet).toBeDefined();
    if (!audioSet) return;

    expect(reconcileExportWorkspaceState({
      storedState: {
        audioSetId: "source",
        selectedArtifactIds: ["vocals"],
        selectedGeneratedDocumentIds: [],
        outputFormat: "flac",
        filenameBase: "Session",
        destinationType: "single_file",
        desktopDestinationTarget: "/tmp/exports/session.flac",
      },
      audioSets: [audioSet],
      selectedPrimaryArtifactId: "source",
      filenameBase: "Demo Song",
      capabilities: capabilities(),
      defaultOutputFormat: "wav",
      availableGeneratedDocumentIds: new Set(),
    })).toEqual({
      recovery: false,
      state: {
        audioSetId: "source",
        selectedArtifactIds: ["vocals"],
        selectedGeneratedDocumentIds: [],
        outputFormat: "flac",
        filenameBase: "Session",
        destinationType: "single_file",
        desktopDestinationTarget: "/tmp/exports/session.flac",
      },
    });
  });

  it("uses the available backend default for fresh state and stable capability fallbacks", () => {
    const audioSets = buildExportAudioSets([artifact("source", "source_audio", createdAt)]);
    const createState = (defaultOutputFormat: string | null, formats: string[]) =>
      defaultExportWorkspaceState({
        audioSets,
        selectedPrimaryArtifactId: "source",
        filenameBase: "Demo Song",
        capabilities: capabilities({ formats }),
        defaultOutputFormat,
      });

    expect(createState("wav", ["wav", "flac"])?.outputFormat).toBe("wav");
    expect(createState("ogg", ["flac", "m4a"])?.outputFormat).toBe("flac");
    expect(createState("wav", ["flac", "m4a"])?.outputFormat).toBe("flac");
    expect(createState("flac", [])?.outputFormat).toBe("flac");
    expect(createState("ogg", [])?.outputFormat).toBe("m4a");
  });

  it("defaults to track-first audio selections and a compatible destination", () => {
    const audioSets = buildExportAudioSets([
      artifact("source", "source_audio", createdAt),
      artifact("vocals", "vocal_stem", createdAt, "source"),
      artifact("drums", "drums_stem", createdAt, "source"),
    ]);
    const createState = (maxArtifactCount: number | null, destinations?: string[]) =>
      defaultExportWorkspaceState({
        audioSets,
        selectedPrimaryArtifactId: "source",
        filenameBase: "Demo Song",
        capabilities: capabilities({ maxArtifactCount, destinations }),
        defaultOutputFormat: "wav",
      });

    expect(createState(null)).toMatchObject({
      selectedArtifactIds: ["source", "vocals", "drums"],
      destinationType: "folder",
    });
    expect(createState(2, ["single_file", "zip"])).toMatchObject({
      selectedArtifactIds: ["source", "vocals"],
      destinationType: "zip",
    });
    expect(createState(1)).toMatchObject({
      selectedArtifactIds: ["source"],
      destinationType: "single_file",
    });
    expect(defaultExportWorkspaceState({
      audioSets: buildExportAudioSets([artifact("solo", "source_audio", createdAt)]),
      selectedPrimaryArtifactId: "solo",
      filenameBase: "Solo",
      capabilities: capabilities(),
      defaultOutputFormat: "wav",
    })).toMatchObject({ selectedArtifactIds: ["solo"], destinationType: "single_file" });
  });

  it("recovers a corrupt stored format to the backend default and clears its target", () => {
    const audioSets = buildExportAudioSets([artifact("source", "source_audio", createdAt)]);

    expect(reconcileExportWorkspaceState({
      storedState: {
        audioSetId: "source",
        selectedArtifactIds: ["source"],
        selectedGeneratedDocumentIds: [],
        outputFormat: null,
        filenameBase: "Session",
        destinationType: "single_file",
        desktopDestinationTarget: "/tmp/exports/session.aac",
      },
      audioSets,
      selectedPrimaryArtifactId: "source",
      filenameBase: "Demo Song",
      capabilities: capabilities(),
      defaultOutputFormat: "wav",
      availableGeneratedDocumentIds: new Set(),
    })).toMatchObject({
      recovery: true,
      state: { outputFormat: "wav", desktopDestinationTarget: null },
    });
  });

  it("recovers stale cross-set choices with stable primary-first limits and safe fallbacks", () => {
    const audioSets = buildExportAudioSets([
      artifact("source", "source_audio", createdAt),
      artifact("mix", "preview_mix", "2026-08-13T12:00:00Z"),
      artifact("vocals", "vocal_stem", createdAt, "mix"),
      artifact("drums", "drums_stem", createdAt, "mix"),
    ]);
    expect(reconcileExportWorkspaceState({
      storedState: {
        audioSetId: "gone",
        selectedArtifactIds: ["drums", "mix", "missing", "source"],
        selectedGeneratedDocumentIds: [],
        outputFormat: "wav",
        filenameBase: "Session",
        destinationType: "zip",
        desktopDestinationTarget: "\\\\server\\share\\take.zip",
      },
      audioSets,
      selectedPrimaryArtifactId: "mix",
      filenameBase: "Demo Song",
      capabilities: capabilities({ formats: ["m4a"], maxArtifactCount: 1 }),
      defaultOutputFormat: "wav",
      availableGeneratedDocumentIds: new Set(),
    })).toMatchObject({
      recovery: true,
      state: {
        audioSetId: "mix",
        selectedArtifactIds: ["mix"],
        outputFormat: "m4a",
        destinationType: "single_file",
        desktopDestinationTarget: null,
      },
    });
  });

  it("clears stored targets for Android and invalid local-looking values", () => {
    const audioSets = buildExportAudioSets([artifact("source", "source_audio", createdAt)]);
    const draft = {
      audioSetId: "source",
      selectedArtifactIds: ["source"],
      selectedGeneratedDocumentIds: [],
      outputFormat: "m4a" as const,
      filenameBase: "Session",
      destinationType: "single_file" as const,
      desktopDestinationTarget: "file:///private/secret.m4a",
    };
    expect(reconcileExportWorkspaceState({
      storedState: draft,
      audioSets,
      selectedPrimaryArtifactId: "source",
      filenameBase: "Demo Song",
      capabilities: capabilities(),
      defaultOutputFormat: "wav",
      availableGeneratedDocumentIds: new Set(),
    }).state?.desktopDestinationTarget).toBeNull();
    expect(reconcileExportWorkspaceState({
      storedState: { ...draft, desktopDestinationTarget: "C:\\exports\\session.m4a" },
      audioSets,
      selectedPrimaryArtifactId: "source",
      filenameBase: "Demo Song",
      capabilities: capabilities({ platform: "android" }),
      defaultOutputFormat: "m4a",
      availableGeneratedDocumentIds: new Set(),
    }).state?.desktopDestinationTarget).toBeNull();
  });

  it("preserves available document-only drafts and discards unavailable document ids", () => {
    const storedState = {
      audioSetId: null,
      selectedArtifactIds: [],
      selectedGeneratedDocumentIds: ["lyrics", "lyrics_with_chords"] as const,
      outputFormat: "wav" as const,
      filenameBase: "Document set",
      destinationType: "folder" as const,
      desktopDestinationTarget: "/tmp/documents",
    };
    const reconciled = reconcileExportWorkspaceState({
      storedState: {
        ...storedState,
        selectedGeneratedDocumentIds: [...storedState.selectedGeneratedDocumentIds],
      },
      audioSets: [],
      selectedPrimaryArtifactId: null,
      filenameBase: "Demo Song",
      capabilities: capabilities(),
      defaultOutputFormat: "wav",
      availableGeneratedDocumentIds: new Set(["lyrics"]),
    });

    expect(reconciled).toMatchObject({
      recovery: true,
      state: {
        audioSetId: null,
        selectedArtifactIds: [],
        selectedGeneratedDocumentIds: ["lyrics"],
        destinationType: "single_file",
      },
    });
    expect(reconcileExportWorkspaceState({
      storedState: {
        ...storedState,
        selectedGeneratedDocumentIds: ["lyrics"],
        destinationType: "single_file",
        desktopDestinationTarget: "/tmp/lyrics.txt",
      },
      audioSets: [],
      selectedPrimaryArtifactId: null,
      filenameBase: "Demo Song",
      capabilities: capabilities(),
      defaultOutputFormat: "wav",
      availableGeneratedDocumentIds: new Set(["lyrics"] as const),
    }).state?.desktopDestinationTarget).toBe("/tmp/lyrics.txt");
  });

  it("reconciles Android audio and documents as one combined deliverable", () => {
    const source = artifact("source", "source_audio", createdAt);
    const mp3Mix = {
      ...artifact("mix", "preview_mix", createdAt),
      format: "mp3",
      path: "/tmp/mix.mp3",
    };
    const androidCapabilities = capabilities({
      platform: "android",
      formats: ["wav"],
      destinations: ["single_file"],
      maxArtifactCount: 1,
    });

    expect(androidAudioExportUnavailableReason(source)).toBeNull();
    expect(androidAudioExportUnavailableReason(mp3Mix)).toMatch(/locally stored WAV/);
    expect(reconcileExportWorkspaceState({
      storedState: {
        audioSetId: "source",
        selectedArtifactIds: ["source"],
        selectedGeneratedDocumentIds: ["lyrics", "lyrics_with_chords"],
        outputFormat: "m4a",
        filenameBase: "Session",
        destinationType: "folder",
        desktopDestinationTarget: "content://caller/forbidden",
      },
      audioSets: buildExportAudioSets([source, mp3Mix]),
      selectedPrimaryArtifactId: "source",
      filenameBase: "Demo Song",
      capabilities: androidCapabilities,
      defaultOutputFormat: "m4a",
      availableGeneratedDocumentIds: new Set(["lyrics", "lyrics_with_chords"] as const),
    })).toMatchObject({
      recovery: true,
      state: {
        selectedArtifactIds: ["source"],
        selectedGeneratedDocumentIds: [],
        outputFormat: "wav",
        destinationType: "single_file",
        desktopDestinationTarget: null,
      },
    });
    expect(defaultExportWorkspaceState({
      audioSets: buildExportAudioSets([mp3Mix]),
      selectedPrimaryArtifactId: "mix",
      filenameBase: "Demo Song",
      capabilities: androidCapabilities,
      defaultOutputFormat: "m4a",
    })?.selectedArtifactIds).toEqual([]);
  });
});
