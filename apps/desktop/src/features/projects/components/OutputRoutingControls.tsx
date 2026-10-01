import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { Check, ChevronDown, RotateCcw, Speaker } from "lucide-react";
import type { ArtifactSchema } from "../../../lib/api";
import {
  browserOutputRoutingSnapshot,
  subscribeBrowserOutputRouting,
} from "../../../lib/audioOutput";
import { useAudioOutput } from "../../../lib/audioOutputContext";
import { isWebAudioBackendForced, type NativeDestinationRoute } from "../../../lib/nativeAudio";
import {
  INHERIT_OUTPUT_ROUTE,
  SYSTEM_DEFAULT_OUTPUT_ROUTE,
  type OutputRouteSelection,
} from "../../../lib/outputRouting";
import { usePlayback } from "../playback-context";
import { isDrumSubstem, stemControlKey } from "../drumStemGroup";
import { artifactLabel } from "../projectViewUtils";

type DeviceChoice = { id: string; label: string };
type RouteRowProps = {
  label: string;
  inheritLabel: string;
  selection: OutputRouteSelection;
  destination: NativeDestinationRoute | null;
  devices: DeviceChoice[];
  disabled: boolean;
  selectionSupported: boolean;
  native: boolean;
  authorizeBrowserOutputDevice: (id: string) => Promise<string | null>;
  refreshDevices?: () => Promise<void>;
  onSelect: (selection: OutputRouteSelection) => void;
};

function sameSelection(a: OutputRouteSelection, b: OutputRouteSelection) {
  return a.kind === b.kind
    && (a.kind !== "explicit-device" || (b.kind === "explicit-device" && a.deviceId === b.deviceId));
}

function deviceName(id: string, devices: DeviceChoice[]) {
  return devices.find((device) => device.id === id)?.label || id;
}

function OutputRouteRow({
  label,
  inheritLabel,
  selection,
  destination,
  devices,
  disabled,
  selectionSupported,
  native,
  authorizeBrowserOutputDevice,
  refreshDevices,
  onSelect,
}: RouteRowProps) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const requestRef = useRef(0);
  const choicesId = useId();
  useEffect(() => () => { requestRef.current += 1; }, []);

  const savedDeviceAvailable = selection.kind !== "explicit-device"
    || devices.some((device) => device.id === selection.deviceId);
  const selectedLabel = selection.kind === "inherit"
    ? inheritLabel
    : selection.kind === "system-default"
      ? "System Default"
      : savedDeviceAvailable
        ? deviceName(selection.deviceId, devices)
        : `Unavailable · ${selection.deviceId}`;
  const currentDestination = destination && sameSelection(destination.selection, selection)
    ? destination : null;
  const effectiveLabel = currentDestination?.effectiveDeviceId
    ? deviceName(currentDestination.effectiveDeviceId, devices) : "System Default";
  const statusText = currentDestination?.status === "fallback-default"
    ? `Using ${effectiveLabel} after output loss. Saved choice kept.`
    : currentDestination?.status === "unavailable"
      ? "Output unavailable. Saved choice kept."
      : currentDestination?.status === "pending"
        ? "Connecting to output…"
        : currentDestination?.status === "requested-unverified"
          ? `Requested ${effectiveLabel}; Android cannot verify the physical output.`
          : currentDestination?.effectiveDeviceId
            ? `Effective output: ${effectiveLabel}`
            : !savedDeviceAvailable
              ? "Saved output is unavailable on this device."
              : null;

  const choose = async (next: OutputRouteSelection, restoreFocus: boolean) => {
    const request = ++requestRef.current;
    setError(null);
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus();
    if (next.kind === "explicit-device" && !native) {
      try {
        const granted = await authorizeBrowserOutputDevice(next.deviceId);
        if (request !== requestRef.current) return;
        if (!granted) {
          setError("This browser cannot select that output.");
          return;
        }
        onSelect({ kind: "explicit-device", deviceId: granted });
      } catch {
        if (request === requestRef.current) {
          setError("Output permission was denied. Choose an output to try again.");
        }
      }
      return;
    }
    onSelect(next);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Escape" || !open) return;
    event.preventDefault();
    event.stopPropagation();
    setOpen(false);
    triggerRef.current?.focus();
  };

  return (
    <div className="output-route-row" onKeyDown={handleKeyDown} onPointerLeave={() => setOpen(false)}>
      <div className="output-route-row__heading">
        <span>{label}</span>
        {selection.kind === "explicit-device" && !savedDeviceAvailable ? (
          <span className="output-route-row__warning">Unavailable</span>
        ) : null}
      </div>
      <button
        aria-controls={choicesId}
        aria-expanded={open}
        aria-label={`${label} output: ${selectedLabel}`}
        className="output-route-row__trigger"
        disabled={disabled}
        onClick={() => {
          if (!open) void refreshDevices?.();
          setOpen(!open);
        }}
        ref={triggerRef}
        type="button"
      >
        <Speaker aria-hidden="true" />
        <span title={selectedLabel}>{selectedLabel}</span>
        <ChevronDown aria-hidden="true" />
      </button>
      {statusText ? <p className="output-route-row__status" role="status">{statusText}</p> : null}
      {error ? <p className="field-error" role="alert">{error}</p> : null}
      {open ? (
        <div aria-label={`${label} output choices`} className="output-route-row__choices"
          data-output-route-choices="open" id={choicesId} role="group">
          {[
            { selection: INHERIT_OUTPUT_ROUTE, label: inheritLabel },
            { selection: SYSTEM_DEFAULT_OUTPUT_ROUTE, label: "System Default" },
            ...devices.map((device) => ({
              selection: { kind: "explicit-device", deviceId: device.id } as OutputRouteSelection,
              label: device.label,
            })),
          ].map((choice) => (
            <button
              aria-pressed={sameSelection(selection, choice.selection)}
              className="output-route-row__choice"
              disabled={disabled || (choice.selection.kind === "explicit-device" && !selectionSupported)}
              key={choice.selection.kind === "explicit-device" ? choice.selection.deviceId : choice.selection.kind}
              onClick={(event) => void choose(choice.selection, event.detail === 0)}
              type="button"
            >
              <Speaker aria-hidden="true" />
              <span title={choice.label}>{choice.label}</span>
              {sameSelection(selection, choice.selection) ? <Check aria-hidden="true" /> : null}
            </button>
          ))}
          {selection.kind === "explicit-device" && !savedDeviceAvailable ? (
            <p className="output-route-row__unavailable" role="status">
              Saved device: {selection.deviceId}. Select it again after it returns to retry.
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function useOutputRoutingView() {
  const playback = usePlayback();
  const appOutput = useAudioOutput();
  const native = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window
    && !isWebAudioBackendForced();
  const [browserSnapshot, setBrowserSnapshot] = useState(browserOutputRoutingSnapshot);
  useEffect(() => {
    if (native) return;
    setBrowserSnapshot(browserOutputRoutingSnapshot());
    return subscribeBrowserOutputRouting(() => setBrowserSnapshot(browserOutputRoutingSnapshot()));
  }, [native]);
  const devices: DeviceChoice[] = native
    ? appOutput.outputDevices?.devices.map((device) => ({
      id: device.id,
      label: device.label || device.id,
    })) ?? []
    : appOutput.browserOutputDevices
      .filter((device) => device.deviceId && device.deviceId !== "default")
      .map((device, index) => ({
        id: device.deviceId,
        label: device.label.trim() || `Audio output ${index + 1}`,
      }));
  return {
    playback,
    appOutput,
    native,
    devices,
    selectionSupported: native
      ? appOutput.outputCapabilities?.outputSelectionPersistence !== "default-only"
        && appOutput.outputDevices?.supported !== false
      : appOutput.browserOutputSelectionSupported,
    snapshot: native ? playback.outputRoutingSnapshot : browserSnapshot,
  };
}

export function ProjectOutputRoute() {
  const { playback, appOutput, native, devices, selectionSupported, snapshot } = useOutputRoutingView();
  return (
    <section className="output-routing output-routing--project" aria-label="Project output">
      <h3>Project output</h3>
      <OutputRouteRow
        authorizeBrowserOutputDevice={appOutput.authorizeBrowserOutputDevice}
        refreshDevices={appOutput.refreshOutputDevices}
        destination={snapshot?.project ?? null}
        devices={devices}
        disabled={!playback.session}
        inheritLabel="Follow Settings"
        label="Project"
        native={native}
        onSelect={playback.setProjectOutputRoute}
        selection={playback.outputRouting.project}
        selectionSupported={selectionSupported}
      />
      {!selectionSupported ? (
        <p className="artifact-meta">This runtime uses System Default. Saved choices stay available for supported devices.</p>
      ) : null}
      {playback.outputRoutingSaveError ? (
        <p className="field-error" role="alert">{playback.outputRoutingSaveError}</p>
      ) : null}
    </section>
  );
}

export function OutputRoutingPanel({ stemArtifacts }: { stemArtifacts: ArtifactSchema[] }) {
  const { playback, appOutput, native, devices, selectionSupported, snapshot } = useOutputRoutingView();
  const lanes = playback.session?.routeLanes ?? [];
  const hasOverrides = playback.outputRouting.project.kind !== "inherit"
    || playback.outputRouting.cue.kind !== "inherit"
    || Object.values(playback.outputRouting.stems).some((selection) => selection.kind !== "inherit");
  return (
    <section className="output-routing output-routing--details" aria-label="Output routes">
      <div className="output-routing__heading">
        <h3>Output routes</h3>
        <button className="button button--ghost button--small" disabled={!hasOverrides}
          onClick={playback.resetOutputRoutes} type="button">
          <RotateCcw aria-hidden="true" /> Reset all outputs
        </button>
      </div>
      {stemArtifacts.length ? stemArtifacts.map((artifact) => {
        const lane = lanes.find((entry) => entry.laneId === artifact.id);
        const parent = isDrumSubstem(artifact) ? stemArtifacts.find((candidate) =>
          candidate.type === "drums_stem" && candidate.id === artifact.metadata?.parent_artifact_id) : null;
        const parentStableKey = lane?.parentStableKey ?? (parent ? stemControlKey(parent) : null);
        const stableKey = lane?.stableKey ?? stemControlKey(artifact);
        const destination = snapshot?.lanes.find((entry) => entry.laneId === artifact.id) ?? null;
        return (
          <OutputRouteRow
            authorizeBrowserOutputDevice={appOutput.authorizeBrowserOutputDevice}
            refreshDevices={appOutput.refreshOutputDevices}
            destination={destination}
            devices={devices}
            disabled={!playback.session}
            inheritLabel={parentStableKey ? "Follow Drums" : "Follow project"}
            key={stableKey}
            label={artifactLabel(artifact)}
            native={native}
            onSelect={(selection) => playback.setStemOutputRoute(stableKey, selection)}
            selection={playback.outputRouting.stems[stableKey] ?? INHERIT_OUTPUT_ROUTE}
            selectionSupported={selectionSupported}
          />
        );
      }) : <p className="artifact-meta">Generate or sync stems to route individual parts.</p>}
      <OutputRouteRow
        authorizeBrowserOutputDevice={appOutput.authorizeBrowserOutputDevice}
        refreshDevices={appOutput.refreshOutputDevices}
        destination={snapshot?.cue ?? null}
        devices={devices}
        disabled={!playback.session}
        inheritLabel="Follow project"
        label="Metronome & count-in"
        native={native}
        onSelect={playback.setCueOutputRoute}
        selection={playback.outputRouting.cue}
        selectionSupported={selectionSupported}
      />
      <p className="artifact-meta">
        Count-in, loop count-in, and playback-following metronome share this route. Independent Tools metronome follows Settings.
      </p>
    </section>
  );
}

export function RoutingTabs({
  active,
  label,
  onChange,
}: {
  active: "stems" | "outputs";
  label: string;
  onChange: (next: "stems" | "outputs") => void;
}) {
  return (
    <div aria-label={label} className="output-routing-tabs" role="tablist">
      {(["stems", "outputs"] as const).map((tab) => (
        <button
          aria-selected={active === tab}
          className={`output-routing-tabs__tab${active === tab ? " output-routing-tabs__tab--active" : ""}`}
          key={tab}
          onClick={() => onChange(tab)}
          role="tab"
          type="button"
        >
          {tab === "stems" ? "Stems" : "Outputs"}
        </button>
      ))}
    </div>
  );
}
