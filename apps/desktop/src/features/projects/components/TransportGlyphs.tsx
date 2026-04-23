import { useId } from "react";
import type { SeekDirection } from "../projectViewUtils";

export function MetallicGlyphDefs({ gradientId }: { gradientId: string }) {
  return (
    <defs>
      <linearGradient id={gradientId} x1="8%" y1="8%" x2="92%" y2="92%">
        <stop offset="0%" stopColor="#FFFBEB" />
        <stop offset="20%" stopColor="#F8FAFC" />
        <stop offset="48%" stopColor="#CBD5E1" />
        <stop offset="76%" stopColor="#64748B" />
        <stop offset="100%" stopColor="#F8FAFC" />
      </linearGradient>
    </defs>
  );
}

export function PlayPauseGlyph({ isPlaying }: { isPlaying: boolean }) {
  const gradientId = useId();
  const fill = `url(#${gradientId})`;

  return (
    <svg
      aria-hidden="true"
      className="transport__icon transport__icon--playpause"
      focusable="false"
      viewBox="0 0 40 40"
    >
      <MetallicGlyphDefs gradientId={gradientId} />
      {isPlaying ? (
        <>
          <rect
            fill={fill}
            height="19"
            rx="2.6"
            stroke="rgba(255, 255, 255, 0.5)"
            strokeWidth="1"
            width="6.5"
            x="10.75"
            y="10.5"
          />
          <rect
            fill={fill}
            height="19"
            rx="2.6"
            stroke="rgba(255, 255, 255, 0.5)"
            strokeWidth="1"
            width="6.5"
            x="22.75"
            y="10.5"
          />
        </>
      ) : (
        <path
          d="M13 9.75L29.5 20L13 30.25Z"
          fill={fill}
          stroke="rgba(255, 255, 255, 0.55)"
          strokeLinejoin="round"
          strokeWidth="1"
        />
      )}
    </svg>
  );
}

export function StopGlyph() {
  const gradientId = useId();
  const fill = `url(#${gradientId})`;

  return (
    <svg
      aria-hidden="true"
      className="transport__icon transport__icon--stop"
      focusable="false"
      viewBox="0 0 40 40"
    >
      <MetallicGlyphDefs gradientId={gradientId} />
      <rect
        className="transport__stop-block"
        fill={fill}
        height="19"
        rx="4.5"
        stroke="rgba(255, 255, 255, 0.5)"
        strokeWidth="1"
        width="19"
        x="10.5"
        y="10.5"
      />
    </svg>
  );
}

export function SeekGlyph({ animate = false, direction }: { animate?: boolean; direction: SeekDirection }) {
  const animationClass = animate ? ` transport__seek-glyph--animate-${direction}` : "";
  const triangleClass = `transport__seek-triangle transport__seek-triangle--${direction}`;

  return (
    <span
      aria-hidden="true"
      className={`transport__icon transport__icon--seek transport__seek-glyph${animationClass}`}
    >
      <span className="transport__seek-slot">
        <span className={triangleClass} />
        <span className={`${triangleClass} transport__seek-triangle--overlay`} />
      </span>
      <span className="transport__seek-slot">
        <span className={triangleClass} />
        <span className={`${triangleClass} transport__seek-triangle--overlay`} />
      </span>
    </span>
  );
}

