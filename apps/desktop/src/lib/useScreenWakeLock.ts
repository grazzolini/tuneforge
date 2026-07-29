import { useEffect, useRef } from "react";
import {
  setPowerInhibitionActivity,
  updateBrowserWakeLockStatus,
  type PowerInhibitionReason,
} from "./powerInhibition";

export type ScreenWakeLockOwner = "playback" | "tuner-capture";

type WakeLockSentinelLike = {
  release: () => Promise<void>;
  addEventListener?: (type: "release", listener: () => void) => void;
  removeEventListener?: (type: "release", listener: () => void) => void;
};

type NavigatorWithWakeLock = Navigator & {
  wakeLock?: {
    request: (type: "screen") => Promise<WakeLockSentinelLike>;
  };
};

const owners = new Set<ScreenWakeLockOwner>();
let sentinel: WakeLockSentinelLike | null = null;
let sentinelReleaseHandler: (() => void) | null = null;
let requestInFlight = false;
let wakeLockRequestId = 0;
let ownershipGeneration = 0;
let visibilitySubscribed = false;

function publish(
  phase: Parameters<typeof updateBrowserWakeLockStatus>[0]["phase"],
  screenProtected: boolean,
  errorMessage: string | null = null,
) {
  updateBrowserWakeLockStatus({
    phase,
    backend: screenProtected ? "browser-screen-wake-lock" : null,
    screenProtected,
    errorMessage,
  });
}

function clearSentinel() {
  if (sentinel && sentinelReleaseHandler) {
    sentinel.removeEventListener?.("release", sentinelReleaseHandler);
  }
  sentinel = null;
  sentinelReleaseHandler = null;
}

function handleVisibilityChange() {
  if (document.visibilityState === "visible" && owners.size > 0 && !sentinel) {
    void acquireWakeLock();
  }
}

function setVisibilitySubscription(active: boolean) {
  if (active && !visibilitySubscribed) {
    document.addEventListener("visibilitychange", handleVisibilityChange);
    visibilitySubscribed = true;
  } else if (!active && visibilitySubscribed) {
    document.removeEventListener("visibilitychange", handleVisibilityChange);
    visibilitySubscribed = false;
  }
}

function canPublishDetachedRelease(generation: number) {
  return generation === ownershipGeneration && owners.size === 0 && !sentinel;
}

async function releaseDetachedSentinel(
  nextSentinel: WakeLockSentinelLike,
  generation: number,
) {
  if (canPublishDetachedRelease(generation)) {
    publish("releasing", true);
  }
  try {
    await nextSentinel.release();
    if (canPublishDetachedRelease(generation)) {
      publish("inactive", false);
    }
  } catch {
    if (canPublishDetachedRelease(generation)) {
      publish(
        "release-failed",
        true,
        "Screen Wake Lock release could not be confirmed.",
      );
    }
  }
}

function releaseCurrentSentinel(generation: number) {
  const activeSentinel = sentinel;
  clearSentinel();
  if (!activeSentinel) {
    if (generation === ownershipGeneration && owners.size === 0 && !requestInFlight) {
      publish("inactive", false);
    }
    return;
  }

  publish("releasing", true);
  void activeSentinel.release()
    .then(() => {
      if (generation !== ownershipGeneration || owners.size > 0 || sentinel || requestInFlight) {
        return;
      }
      publish("inactive", false);
    })
    .catch(() => {
      if (generation !== ownershipGeneration || owners.size > 0 || sentinel || requestInFlight) {
        return;
      }
      publish(
        "release-failed",
        true,
        "Screen Wake Lock release could not be confirmed.",
      );
    });
}

async function acquireWakeLock() {
  if (
    owners.size === 0 ||
    sentinel ||
    requestInFlight ||
    document.visibilityState === "hidden"
  ) {
    return;
  }
  const wakeLock = (navigator as NavigatorWithWakeLock).wakeLock;
  if (!wakeLock) {
    publish("unsupported", false, "Screen Wake Lock is unavailable in this browser.");
    return;
  }

  const generation = ownershipGeneration;
  const requestId = ++wakeLockRequestId;
  requestInFlight = true;
  publish("acquiring", false);
  try {
    const nextSentinel = await wakeLock.request("screen");
    if (generation !== ownershipGeneration || owners.size === 0) {
      void releaseDetachedSentinel(nextSentinel, ownershipGeneration);
      return;
    }

    sentinel = nextSentinel;
    sentinelReleaseHandler = () => {
      if (sentinel !== nextSentinel) {
        return;
      }
      clearSentinel();
      if (owners.size > 0 && document.visibilityState === "visible") {
        void acquireWakeLock();
      } else {
        publish("inactive", false);
      }
    };
    sentinel.addEventListener?.("release", sentinelReleaseHandler);
    publish("active", true);
  } catch {
    if (generation === ownershipGeneration && owners.size > 0) {
      publish("failed", false, "Screen Wake Lock could not be enabled.");
    }
  } finally {
    if (requestId === wakeLockRequestId) {
      requestInFlight = false;
      if (
        generation !== ownershipGeneration &&
        owners.size > 0 &&
        !sentinel &&
        document.visibilityState === "visible"
      ) {
        void acquireWakeLock();
      }
    }
  }
}

function setScreenWakeLockOwner(owner: ScreenWakeLockOwner, active: boolean) {
  const wasOwned = owners.has(owner);
  if (active === wasOwned) {
    return;
  }

  if (active) {
    const wasEmpty = owners.size === 0;
    owners.add(owner);
    if (wasEmpty) {
      ownershipGeneration += 1;
      setVisibilitySubscription(true);
      void acquireWakeLock();
    }
    return;
  }

  owners.delete(owner);
  if (owners.size > 0) {
    return;
  }
  ownershipGeneration += 1;
  setVisibilitySubscription(false);
  if (sentinel) {
    releaseCurrentSentinel(ownershipGeneration);
  } else {
    publish("inactive", false);
  }
}

export function resetScreenWakeLockForTests() {
  ownershipGeneration += 1;
  wakeLockRequestId += 1;
  owners.clear();
  requestInFlight = false;
  clearSentinel();
  setVisibilitySubscription(false);
  publish("inactive", false);
}

export function useScreenWakeLock(owner: ScreenWakeLockOwner, active: boolean) {
  useEffect(() => {
    setScreenWakeLockOwner(owner, active);
    return () => {
      if (active) {
        setScreenWakeLockOwner(owner, false);
      }
    };
  }, [active, owner]);
}

function isTauriRuntime() {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export function usePowerInhibitionActivity(reason: PowerInhibitionReason, active: boolean) {
  const ownsProtectionRef = useRef(false);

  useEffect(() => {
    if (!active || !isTauriRuntime()) {
      return;
    }
    ownsProtectionRef.current = true;
    void setPowerInhibitionActivity(reason, true);
    return () => {
      if (ownsProtectionRef.current) {
        ownsProtectionRef.current = false;
        void setPowerInhibitionActivity(reason, false);
      }
    };
  }, [active, reason]);
}
