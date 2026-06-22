import "./_home/site.css";
import { HomeClient } from "./_home/HomeClient";
import { PAGE_HTML } from "./_home/markup";

// Marketing homepage — a verbatim port of the Claude Design handoff
// (gtm-grid/Website.html): "Grid — the headless GTM engine". HomeClient injects
// the design's body under a scoped `.gtm-home` wrapper (styles in
// _home/site.css, scoped so they can't leak into /invite or /download) and runs
// all of its interactivity (connector wall, hero animation, FAQ, quick-start
// tabs, pricing toggle).
export default function Home() {
  return <HomeClient html={PAGE_HTML} />;
}
