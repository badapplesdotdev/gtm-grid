// GTM Grid × Attio — App Store submission demo (~48s, 1920×1080).
// One message per scene: intro → 5 product steps over real app captures → outro.

import React from "react";
import {
  AbsoluteFill,
  Easing,
  Img,
  Sequence,
  interpolate,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { loadFont } from "@remotion/google-fonts/DMSans";

const { fontFamily } = loadFont();

const EASE = Easing.bezier(0.16, 1, 0.3, 1);
const INK = "#111118";
const INK2 = "#5a5a6e";
const GREEN = "#22c55e";
const GREEN_DARK = "#136d34";

const Bg: React.FC = () => (
  <AbsoluteFill
    style={{
      background: "linear-gradient(180deg, #f8f8fa 0%, #eaf7ef 100%)",
    }}
  />
);

/** Fade+rise in over `dur` frames starting at `from` (local frames). */
const useIn = (from = 0, dur = 20) => {
  const frame = useCurrentFrame();
  return {
    opacity: interpolate(frame, [from, from + dur], [0, 1], {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
      easing: EASE,
    }),
    translate: `0px ${interpolate(frame, [from, from + dur], [24, 0], {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
      easing: EASE,
    })}px`,
  };
};

/** Whole-scene fade-out over the final 12 frames. */
const useOut = (sceneDur: number) => {
  const frame = useCurrentFrame();
  return interpolate(frame, [sceneDur - 12, sceneDur], [1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
};

const Intro: React.FC<{ dur: number }> = ({ dur }) => {
  const mark = useIn(0, 22);
  const title = useIn(8, 22);
  const sub = useIn(16, 22);
  const out = useOut(dur);
  return (
    <AbsoluteFill style={{ fontFamily, opacity: out }}>
      <Bg />
      <AbsoluteFill
        style={{
          alignItems: "center",
          justifyContent: "center",
          flexDirection: "column",
          gap: 36,
        }}
      >
        <Img
          src={staticFile("brand-icon.png")}
          style={{ width: 148, height: 148, borderRadius: 32, ...mark }}
        />
        <div
          style={{
            fontSize: 108,
            fontWeight: 700,
            color: INK,
            letterSpacing: "-0.03em",
            ...title,
          }}
        >
          GTM Grid <span style={{ color: INK2, fontWeight: 400 }}>×</span>{" "}
          <span style={{ color: GREEN_DARK }}>Attio</span>
        </div>
        <div style={{ fontSize: 46, color: INK2, ...sub }}>
          Your CRM records, in an AI enrichment grid
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

const Shot: React.FC<{
  src: string;
  dur: number;
  step: number;
  headline: string;
  callout?: string;
  /** Gentle settle-in zoom [from, to] — small values so nothing leaves frame. */
  zoom?: [number, number];
  /** Zoom origin within the image (where to drift toward). */
  origin?: string;
}> = ({ src, dur, step, headline, callout, zoom = [1, 1.06], origin = "50% 45%" }) => {
  const frame = useCurrentFrame();
  const head = useIn(0, 18);
  const call = useIn(14, 18);
  const out = useOut(dur);
  const scale = interpolate(frame, [0, dur], zoom, { easing: Easing.linear });
  const cardIn = interpolate(frame, [4, 26], [50, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: EASE,
  });
  const cardOpacity = interpolate(frame, [4, 22], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  // Full 16:10 capture, entirely in frame: 1380×862 card under a compact header.
  const CARD_W = 1380;
  const CARD_H = 862;
  return (
    <AbsoluteFill style={{ fontFamily, opacity: out }}>
      <Bg />
      <AbsoluteFill style={{ alignItems: "center", paddingTop: 44 }}>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 10 }}>
          <div
            style={{
              fontSize: 26,
              fontWeight: 700,
              letterSpacing: "0.14em",
              color: GREEN_DARK,
              textTransform: "uppercase",
              ...head,
            }}
          >
            Step {step} of 5
          </div>
          <div
            style={{
              fontSize: 62,
              fontWeight: 700,
              color: INK,
              letterSpacing: "-0.02em",
              ...head,
            }}
          >
            {headline}
          </div>
        </div>
      </AbsoluteFill>
      <AbsoluteFill style={{ alignItems: "center", justifyContent: "flex-end", paddingBottom: 22 }}>
        <div
          style={{
            width: CARD_W,
            height: CARD_H,
            borderRadius: 18,
            overflow: "hidden",
            border: "2px solid #e4e4ea",
            boxShadow: "0 30px 70px rgba(13,30,20,0.20)",
            translate: `0px ${cardIn}px`,
            opacity: cardOpacity,
            position: "relative",
          }}
        >
          <Img
            src={staticFile(src)}
            style={{
              width: CARD_W,
              height: CARD_H,
              scale: String(scale),
              transformOrigin: origin,
            }}
          />
          {callout ? (
            <div
              style={{
                position: "absolute",
                bottom: 20,
                left: 0,
                right: 0,
                display: "flex",
                justifyContent: "center",
                ...call,
              }}
            >
              <div
                style={{
                  fontSize: 30,
                  color: "#ffffff",
                  background: GREEN_DARK,
                  padding: "10px 26px",
                  borderRadius: 999,
                  boxShadow: "0 8px 24px rgba(13,30,20,0.35)",
                }}
              >
                {callout}
              </div>
            </div>
          ) : null}
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

const Outro: React.FC<{ dur: number }> = ({ dur }) => {
  const mark = useIn(0, 20);
  const url = useIn(10, 20);
  const sub = useIn(18, 20);
  const out = useOut(dur);
  return (
    <AbsoluteFill style={{ fontFamily, opacity: out }}>
      <Bg />
      <AbsoluteFill
        style={{ alignItems: "center", justifyContent: "center", flexDirection: "column", gap: 30 }}
      >
        <Img src={staticFile("brand-icon.png")} style={{ width: 120, height: 120, borderRadius: 26, ...mark }} />
        <div style={{ fontSize: 96, fontWeight: 700, color: INK, letterSpacing: "-0.03em", ...url }}>
          gtmgrid<span style={{ color: GREEN }}>.dev</span>
        </div>
        <div style={{ fontSize: 40, color: INK2, ...sub }}>
          Attio sync · read-only · refreshed daily
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

export const Demo: React.FC = () => {
  const { fps } = useVideoConfig();
  const s = (sec: number) => Math.round(sec * fps);
  // Scene lengths (seconds): intro 3.5, steps 7/7/9/9/8, outro 5.
  const scenes = [3.5, 7, 7, 9, 9, 8, 5].map(s);
  const starts = scenes.map((_, i) => scenes.slice(0, i).reduce((a, b) => a + b, 0));
  return (
    <AbsoluteFill style={{ background: "#f8f8fa" }}>
      <Sequence durationInFrames={scenes[0]}>
        <Intro dur={scenes[0]} />
      </Sequence>
      <Sequence from={starts[1]} durationInFrames={scenes[1]}>
        <Shot
          src="raw-0-chooser.png"
          dur={scenes[1]}
          step={1}
          headline="New table → From your CRM"
          origin="50% 60%"
          zoom={[1.0, 1.1]}
        />
      </Sequence>
      <Sequence from={starts[2]} durationInFrames={scenes[2]}>
        <Shot
          src="raw-0b-connect.png"
          dur={scenes[2]}
          step={2}
          headline="Connect Attio in one click"
          callout="Read-only — no write or delete permissions"
          origin="50% 50%"
          zoom={[1.0, 1.1]}
        />
      </Sequence>
      <Sequence from={starts[3]} durationInFrames={scenes[3]}>
        <Shot
          src="raw-1-wizard-configure.png"
          dur={scenes[3]}
          step={3}
          headline="Pick fields, filters & duplicate handling"
          origin="50% 45%"
          zoom={[1.0, 1.08]}
        />
      </Sequence>
      <Sequence from={starts[4]} durationInFrames={scenes[4]}>
        <Shot
          src="raw-2-synced-grid.png"
          dur={scenes[4]}
          step={4}
          headline="Records land in a live grid"
          callout="Synced columns stay read-only — add AI columns on top"
          origin="35% 25%"
          zoom={[1.0, 1.08]}
        />
      </Sequence>
      <Sequence from={starts[5]} durationInFrames={scenes[5]}>
        <Shot
          src="raw-3-sync-log.png"
          dur={scenes[5]}
          step={5}
          headline="Synced daily — explained in plain English"
          origin="45% 15%"
          zoom={[1.0, 1.1]}
        />
      </Sequence>
      <Sequence from={starts[6]} durationInFrames={scenes[6]}>
        <Outro dur={scenes[6]} />
      </Sequence>
    </AbsoluteFill>
  );
};
