import React from "react";
import { Composition } from "remotion";
import { Demo } from "./Demo";
import "./index.css";

export const RemotionRoot: React.FC = () => {
  return (
    <Composition
      id="GtmGridAttioDemo"
      component={Demo}
      durationInFrames={Math.round(48.5 * 30)}
      fps={30}
      width={1920}
      height={1080}
    />
  );
};
