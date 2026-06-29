import { useEffect, useMemo, useState } from "react";
import {
  BadgeCheck,
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
  ShieldOff,
  SlidersHorizontal,
  Video,
  Wrench,
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
  "Pre-1.0: local development and unsigned package builds are the supported paths today.",
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
        const data = (await response.json()) as MediaManifest;
        setManifest({
          ...defaultManifest,
          ...data,
          items: Array.isArray(data.items) ? data.items : [],
        });
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
    <div className="hero-preview" aria-label="Tuneforge interface summary">
      <div className="hero-preview__header">
        <span className="dot dot--red" />
        <span className="dot dot--yellow" />
        <span className="dot dot--green" />
        <strong>Tuneforge local session</strong>
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

function MediaCard({ item }: { item: MediaItem }) {
  return (
    <article className="media-card">
      <div className="media-card__asset">
        {item.kind === "video" ? (
          <video
            controls
            muted
            playsInline
            poster={item.poster ? mediaUrl(item.poster) : undefined}
            preload="metadata"
            src={mediaUrl(item.src)}
          />
        ) : (
          <img alt={item.alt ?? item.title} src={mediaUrl(item.src)} loading="lazy" />
        )}
      </div>
      <div className="media-card__copy">
        <span className="tag">{item.label ?? item.kind}</span>
        <h3>{item.title}</h3>
        {item.caption ? <p>{item.caption}</p> : null}
      </div>
    </article>
  );
}

function MediaFallback({ manifest }: { manifest: MediaManifest }) {
  return (
    <div className="media-fallback">
      <Video aria-hidden="true" />
      <div>
        <h3>Release media not captured yet</h3>
        <p>
          The site is ready for generated screenshots and video, but this checkout has only the
          placeholder manifest. Capture output will appear from <code>apps/site/public/media/generated</code>.
        </p>
        <pre>{`node scripts/capture-release-media.mjs --run`}</pre>
        {manifest.notes?.length ? (
          <ul>
            {manifest.notes.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        ) : null}
      </div>
    </div>
  );
}

export function App() {
  const { loaded, manifest } = useMediaManifest();
  const mediaItems = useMemo(() => manifest.items.filter((item) => item.src), [manifest.items]);

  return (
    <div className="site-shell">
      <header className="site-nav" aria-label="Primary">
        <a className="brand" href="#top">
          <span className="brand__mark">
            <Music2 aria-hidden="true" />
          </span>
          <span>
            <strong>Tuneforge</strong>
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
            <h1 id="hero-title">Tuneforge</h1>
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
            <span className={`status-pill status-pill--${manifest.status}`}>
              {loaded ? manifest.status : "loading"}
            </span>
          </div>
          {mediaItems.length ? (
            <div className="media-grid">
              {mediaItems.map((item) => (
                <MediaCard item={item} key={item.id} />
              ))}
            </div>
          ) : (
            <MediaFallback manifest={manifest} />
          )}
        </section>

        <section className="section section--split" id="packages" aria-labelledby="packages-title">
          <div className="section__header">
            <p className="eyebrow">Distribution status</p>
            <h2 id="packages-title">Packages are local and unsigned today</h2>
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
    </div>
  );
}
