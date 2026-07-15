import { useEffect, useMemo, useRef, useState } from "react";
import {
  BadgeCheck,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  Code2,
  Download,
  ExternalLink,
  FileText,
  HardDrive,
  ListMusic,
  Mic,
  Music2,
  PackageCheck,
  Play,
  ShieldOff,
  SlidersHorizontal,
  Video,
  Wrench,
  X,
} from "lucide-react";

type MediaItem = {
  id: string;
  title: string;
  kind: "screenshot" | "video";
  src: string;
  alt?: string;
  caption?: string;
  label?: string;
  poster?: string;
};

type MediaManifest = {
  schemaVersion: number;
  status: "pending" | "partial" | "captured";
  generatedAt: string | null;
  source: string;
  items: MediaItem[];
  notes?: string[];
};

const repoUrl = "https://github.com/grazzolini/tuneforge";
const defaultManifest: MediaManifest = {
  schemaVersion: 1,
  status: "pending",
  generatedAt: null,
  source: "apps/site fallback",
  items: [],
  notes: ["Release media has not been generated yet."],
};

const capabilities = [
  {
    icon: ListMusic,
    title: "Practice library",
    body: "Import common audio and video formats, keep per-song analysis, and return to saved practice state.",
  },
  {
    icon: SlidersHorizontal,
    title: "Local stem and mix tools",
    body: "Split stems with local Demucs, create practice mixes, transpose, retune, preview, and export.",
  },
  {
    icon: Mic,
    title: "Chords and lyrics",
    body: "Generate editable chord timelines and local Whisper transcripts with timestamps when available.",
  },
  {
    icon: Wrench,
    title: "Player utilities",
    body: "Use the chromatic tuner, metronome, chord dictionary, count-in, loop, and tempo controls from one shell.",
  },
];

const packageRows = [
  ["macOS", "Local unsigned app and DMG build", "Requires host ffmpeg and ffprobe on PATH"],
  ["Linux", "Local Flatpak build", "Uses /app/bin/ffmpeg and /app/bin/ffprobe sandbox wrappers"],
  ["Android", "Optional/manual while mobile evolves", "Capability-gated local workflow, not the full desktop stack"],
  ["Models", "Caches used by default", "Bundling model weights is explicit and separate from dependency inclusion"],
];

const limitationRows = [
  "Local development and package builds keep the same local-only workflow; generated packages are unsigned and not notarized.",
  "No cloud sync, no account system, no telemetry, and no public backend exposure.",
  "FFmpeg and FFprobe are intentionally not bundled; development and macOS packages use host PATH, while Flatpak uses sandbox runtime wrappers.",
  "First heavy ML use may need local model downloads or existing caches.",
  "Flatpak builds are large because desktop ML dependencies are included by default.",
  "Mobile remains in transition and should present clear disabled states for unsupported local capabilities.",
];

const links = [
  { label: "GitHub", href: repoUrl, icon: Code2 },
  { label: "Releases", href: `${repoUrl}/releases`, icon: Download },
  { label: "Product spec", href: `${repoUrl}/blob/main/docs/SPEC.md`, icon: FileText },
  { label: "Packaging", href: `${repoUrl}/blob/main/docs/PACKAGING.md`, icon: PackageCheck },
];

function mediaUrl(src: string) {
  const base = import.meta.env.BASE_URL.endsWith("/")
    ? import.meta.env.BASE_URL
    : `${import.meta.env.BASE_URL}/`;
  return `${base}${src.replace(/^\/+/, "")}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isOptionalString(value: unknown) {
  return value === undefined || typeof value === "string";
}

function parseMediaItem(value: unknown): MediaItem | null {
  if (!isRecord(value)) {
    return null;
  }

  const { alt, caption, id, kind, label, poster, src, title } = value;
  if (
    typeof id !== "string" ||
    !id ||
    typeof title !== "string" ||
    !title ||
    (kind !== "screenshot" && kind !== "video") ||
    typeof src !== "string" ||
    !src ||
    !isOptionalString(alt) ||
    !isOptionalString(caption) ||
    !isOptionalString(label) ||
    !isOptionalString(poster) ||
    (kind === "screenshot" && (typeof alt !== "string" || !alt)) ||
    (kind === "video" && (typeof poster !== "string" || !poster))
  ) {
    return null;
  }

  return { id, title, kind, src, alt, caption, label, poster };
}

function parseMediaManifest(value: unknown): MediaManifest | null {
  if (!isRecord(value) || !Array.isArray(value.items)) {
    return null;
  }

  const { generatedAt, notes, schemaVersion, source, status } = value;
  if (
    schemaVersion !== 1 ||
    (status !== "pending" && status !== "partial" && status !== "captured") ||
    (generatedAt !== null && typeof generatedAt !== "string") ||
    typeof source !== "string" ||
    (notes !== undefined && (!Array.isArray(notes) || !notes.every((note) => typeof note === "string")))
  ) {
    return null;
  }

  const items = value.items.map(parseMediaItem);
  if (items.some((item) => item === null)) {
    return null;
  }

  const parsedItems = items as MediaItem[];
  if (new Set(parsedItems.map((item) => item.id)).size !== parsedItems.length) {
    return null;
  }

  return {
    schemaVersion,
    status,
    generatedAt,
    source,
    items: parsedItems,
    notes: notes as string[] | undefined,
  };
}

function useMediaManifest() {
  const [manifest, setManifest] = useState<MediaManifest>(defaultManifest);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    const manifestPath = mediaUrl("media/generated/manifest.json");

    async function loadManifest() {
      try {
        const response = await fetch(manifestPath, {
          cache: "no-store",
          signal: controller.signal,
        });
        if (!response.ok) {
          throw new Error(`Media manifest returned ${response.status}.`);
        }
        const data = parseMediaManifest(await response.json());
        if (!data) {
          throw new Error("Media manifest is malformed.");
        }
        setManifest(data);
      } catch {
        if (!controller.signal.aborted) {
          setManifest(defaultManifest);
        }
      } finally {
        if (!controller.signal.aborted) {
          setLoaded(true);
        }
      }
    }

    void loadManifest();
    return () => controller.abort();
  }, []);

  return { loaded, manifest };
}

function HeroPreview() {
  return (
    <div className="hero-preview" aria-label="TuneForge interface summary">
      <div className="hero-preview__header">
        <span className="dot dot--red" />
        <span className="dot dot--yellow" />
        <span className="dot dot--green" />
        <strong>TuneForge local session</strong>
      </div>
      <div className="hero-preview__grid">
        <div className="hero-preview__timeline">
          <span style={{ inlineSize: "26%" }} />
          <span style={{ inlineSize: "18%" }} />
          <span style={{ inlineSize: "31%" }} />
          <span style={{ inlineSize: "15%" }} />
        </div>
        <div className="hero-preview__chords">
          {["G", "D", "Em", "C"].map((chord) => (
            <span key={chord}>{chord}</span>
          ))}
        </div>
        <div className="hero-preview__mix">
          {["Vocals", "Drums", "Bass", "Guitar"].map((stem, index) => (
            <div key={stem}>
              <span>{stem}</span>
              <meter min={0} max={100} value={[58, 82, 66, 74][index]} />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function MediaCard({
  buttonRef,
  item,
  onOpen,
}: {
  buttonRef: (node: HTMLButtonElement | null) => void;
  item: MediaItem;
  onOpen: () => void;
}) {
  return (
    <article className="media-card">
      <div className="media-card__asset">
        {item.kind === "video" ? (
          <>
            <img alt={item.alt ?? ""} src={mediaUrl(item.poster ?? "")} loading="lazy" />
            <span className="media-card__play" aria-hidden="true">
              <Play />
              Watch video
            </span>
          </>
        ) : (
          <img alt={item.alt ?? item.title} src={mediaUrl(item.src)} loading="lazy" />
        )}
      </div>
      <div className="media-card__copy">
        <span className="tag">{item.label ?? item.kind}</span>
        <h3>{item.title}</h3>
        {item.caption ? <p>{item.caption}</p> : null}
      </div>
      <button
        aria-label={`Open ${item.title} in gallery`}
        className="media-card__launcher"
        onClick={onOpen}
        ref={buttonRef}
        type="button"
      />
    </article>
  );
}

function MediaViewer({
  activeIndex,
  items,
  onClose,
  onNavigate,
}: {
  activeIndex: number;
  items: MediaItem[];
  onClose: () => void;
  onNavigate: (step: number) => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const item = items[activeIndex];

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) {
      dialog.showModal();
    }
  }, []);

  function pauseVideo() {
    videoRef.current?.pause();
  }

  function close() {
    pauseVideo();
    dialogRef.current?.close();
  }

  function navigate(step: number) {
    pauseVideo();
    onNavigate(step);
  }

  return (
    <dialog
      aria-describedby={item.caption ? "media-viewer-caption" : undefined}
      aria-labelledby="media-viewer-title"
      className="media-viewer"
      onCancel={pauseVideo}
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          close();
        }
      }}
      onClose={onClose}
      onKeyDown={(event) => {
        const video = videoRef.current;
        const isArrowKey = event.key === "ArrowLeft" || event.key === "ArrowRight";
        const isVideoControlEvent =
          video && (event.target === video || document.activeElement === video);
        if (isArrowKey && isVideoControlEvent) {
          return;
        }

        if (event.key === "ArrowLeft") {
          event.preventDefault();
          navigate(-1);
        } else if (event.key === "ArrowRight") {
          event.preventDefault();
          navigate(1);
        } else if (event.key === "Escape") {
          event.preventDefault();
          close();
        }
      }}
      ref={dialogRef}
    >
      <div className="media-viewer__panel">
        <header className="media-viewer__header">
          <span className="media-viewer__counter">
            {activeIndex + 1} of {items.length}
          </span>
          <div>
            <span className="tag">{item.label ?? item.kind}</span>
            <h2 id="media-viewer-title">{item.title}</h2>
          </div>
          <button
            aria-label="Close gallery"
            autoFocus
            className="media-viewer__close"
            onClick={close}
            type="button"
          >
            <X aria-hidden="true" />
          </button>
        </header>

        <div className="media-viewer__stage">
          {item.kind === "video" ? (
            <video
              controls
              muted
              playsInline
              poster={mediaUrl(item.poster ?? "")}
              preload="metadata"
              ref={videoRef}
              src={mediaUrl(item.src)}
              tabIndex={0}
            />
          ) : (
            <img alt={item.alt ?? item.title} src={mediaUrl(item.src)} />
          )}
        </div>

        <footer className="media-viewer__footer">
          <button onClick={() => navigate(-1)} type="button">
            <ChevronLeft aria-hidden="true" />
            Previous
          </button>
          <p id="media-viewer-caption">{item.caption ?? "TuneForge release media"}</p>
          <button onClick={() => navigate(1)} type="button">
            Next
            <ChevronRight aria-hidden="true" />
          </button>
        </footer>
      </div>
    </dialog>
  );
}

function MediaFallback() {
  return (
    <div className="media-fallback">
      <Video aria-hidden="true" />
      <div>
        <h3>Release preview unavailable</h3>
        <p>
          Screenshots and video are unavailable right now. Explore the latest release or browse the
          project while the gallery is refreshed.
        </p>
        <div className="media-fallback__links">
          <a className="button button--primary" href={`${repoUrl}/releases`}>
            View releases
          </a>
          <a className="button" href={repoUrl}>
            Browse repository
          </a>
        </div>
      </div>
    </div>
  );
}

export function App() {
  const { loaded, manifest } = useMediaManifest();
  const mediaItems = useMemo(() => manifest.items.filter((item) => item.src), [manifest.items]);
  const [activeMediaIndex, setActiveMediaIndex] = useState<number | null>(null);
  const mediaButtonsRef = useRef<Array<HTMLButtonElement | null>>([]);
  const lastTriggerRef = useRef<HTMLButtonElement | null>(null);

  function openMedia(index: number) {
    lastTriggerRef.current = mediaButtonsRef.current[index] ?? null;
    setActiveMediaIndex(index);
  }

  function closeMedia() {
    setActiveMediaIndex(null);
    queueMicrotask(() => lastTriggerRef.current?.focus());
  }

  function navigateMedia(step: number) {
    setActiveMediaIndex((current) => {
      if (current === null) {
        return current;
      }
      return (current + step + mediaItems.length) % mediaItems.length;
    });
  }

  return (
    <div className="site-shell">
      <header className="site-nav" aria-label="Primary">
        <a className="brand" href="#top">
          <span className="brand__mark">
            <Music2 aria-hidden="true" />
          </span>
          <span>
            <strong>TuneForge</strong>
            <small>Local practice rig</small>
          </span>
        </a>
        <nav>
          <a href="#media">Media</a>
          <a href="#packages">Packages</a>
          <a href="#limits">Limits</a>
          <a href={`${repoUrl}/releases`}>Releases</a>
        </nav>
      </header>

      <main id="top">
        <section className="hero-section" aria-labelledby="hero-title">
          <div className="hero-section__content">
            <p className="eyebrow">Local-first desktop app for musicians</p>
            <h1 id="hero-title">TuneForge</h1>
            <p className="hero-section__lede">
              Split stems, inspect chords and lyrics, retune, transpose, rehearse, and export
              practice mixes without accounts, cloud processing, analytics, or telemetry.
            </p>
            <div className="hero-section__actions" aria-label="Primary links">
              <a className="button button--primary" href={`${repoUrl}/releases`}>
                <Download aria-hidden="true" />
                Releases
              </a>
              <a className="button" href={`${repoUrl}/blob/main/README.md`}>
                <FileText aria-hidden="true" />
                Read docs
              </a>
            </div>
            <dl className="truth-strip">
              <div>
                <dt>No account</dt>
                <dd>Single-user local library</dd>
              </div>
              <div>
                <dt>No cloud</dt>
                <dd>Processing stays on host</dd>
              </div>
              <div>
                <dt>FFmpeg</dt>
                <dd>Host PATH or Flatpak runtime</dd>
              </div>
            </dl>
          </div>
          <HeroPreview />
        </section>

        <section className="section section--capabilities" aria-labelledby="capabilities-title">
          <div className="section__header">
            <p className="eyebrow">What works locally</p>
            <h2 id="capabilities-title">A player-focused song toolkit</h2>
          </div>
          <div className="capability-grid">
            {capabilities.map((capability) => {
              const Icon = capability.icon;
              return (
                <article className="capability-card" key={capability.title}>
                  <Icon aria-hidden="true" />
                  <h3>{capability.title}</h3>
                  <p>{capability.body}</p>
                </article>
              );
            })}
          </div>
        </section>

        <section className="section" id="media" aria-labelledby="media-title">
          <div className="section__header section__header--split">
            <div>
              <p className="eyebrow">Screenshots and video</p>
              <h2 id="media-title">Release media</h2>
            </div>
            <span className="status-pill" aria-live="polite">
              {loaded
                ? `${mediaItems.length} media ${mediaItems.length === 1 ? "item" : "items"}`
                : "Loading media"}
            </span>
          </div>
          {mediaItems.length ? (
            <div className="media-grid">
              {mediaItems.map((item, index) => (
                <MediaCard
                  buttonRef={(node) => {
                    mediaButtonsRef.current[index] = node;
                  }}
                  item={item}
                  key={item.id}
                  onOpen={() => openMedia(index)}
                />
              ))}
            </div>
          ) : loaded ? (
            <MediaFallback />
          ) : (
            <p className="media-loading">Loading release media…</p>
          )}
        </section>

        <section className="section section--split" id="packages" aria-labelledby="packages-title">
          <div className="section__header">
            <p className="eyebrow">Distribution status</p>
            <h2 id="packages-title">Packages are local and unsigned</h2>
            <p>
              Desktop packaging exists for local builds. The generated apps do not include FFmpeg or
              FFprobe; macOS uses host PATH and Flatpak uses sandbox runtime wrappers. macOS
              artifacts are not signed or notarized.
            </p>
          </div>
          <div className="package-table" role="table" aria-label="Package status">
            {packageRows.map(([platform, status, note]) => (
              <div role="row" key={platform}>
                <strong role="cell">{platform}</strong>
                <span role="cell">{status}</span>
                <small role="cell">{note}</small>
              </div>
            ))}
          </div>
        </section>

        <section className="section section--links" aria-labelledby="links-title">
          <div className="section__header">
            <p className="eyebrow">Project links</p>
            <h2 id="links-title">Docs and release notes</h2>
          </div>
          <div className="link-grid">
            {links.map((link) => {
              const Icon = link.icon;
              return (
                <a href={link.href} key={link.label}>
                  <Icon aria-hidden="true" />
                  <span>{link.label}</span>
                  <ExternalLink aria-hidden="true" />
                </a>
              );
            })}
          </div>
        </section>

        <section className="section section--limits" id="limits" aria-labelledby="limits-title">
          <div className="section__header">
            <p className="eyebrow">Known limitations</p>
            <h2 id="limits-title">Clear boundaries</h2>
          </div>
          <ul className="limit-list">
            {limitationRows.map((limitation, index) => (
              <li key={limitation}>
                {index === 0 ? <CircleAlert aria-hidden="true" /> : <ShieldOff aria-hidden="true" />}
                <span>{limitation}</span>
              </li>
            ))}
          </ul>
        </section>
      </main>

      <footer className="site-footer">
        <span>
          <HardDrive aria-hidden="true" />
          Local-first, no trackers.
        </span>
        <span>
          <BadgeCheck aria-hidden="true" />
          Built from repository content and generated media only.
        </span>
      </footer>
      {activeMediaIndex !== null && mediaItems[activeMediaIndex] ? (
        <MediaViewer
          activeIndex={activeMediaIndex}
          items={mediaItems}
          onClose={closeMedia}
          onNavigate={navigateMedia}
        />
      ) : null}
    </div>
  );
}
