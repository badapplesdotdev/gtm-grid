"use client";

// Progressive scroll-reveal enhancement. Adds `.reveal` to a curated set of
// elements and flips them to `.in` as they enter the viewport (staggered in
// threes via `.d1/.d2/.d3`), and plays the agent-demo stream in once. Renders
// nothing — it's a behaviour, not UI — and is a no-op under reduced motion or
// without IntersectionObserver, where the CSS already shows everything.

import { useEffect } from "react";

const REVEAL_SEL =
  ".sec-head, .qs-card, .qs-caption, .conn-card, .feat-card, .lc-card, .lc-detail-lab, .price-card, .bill-note, .demo-card, .faq-item, .local-strip, .cta-band .wrap, .surf-card";
const STAGGER_GRIDS = ".conn-grid, .feat-grid, .pricing, .bill-notes, .surf-grid";

export function Reveal() {
  useEffect(() => {
    const reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduce || !("IntersectionObserver" in window)) return;

    const items = Array.from(document.querySelectorAll<HTMLElement>(REVEAL_SEL));
    items.forEach((el) => el.classList.add("reveal"));
    document.querySelectorAll(STAGGER_GRIDS).forEach((grid) => {
      Array.from(grid.children).forEach((c, i) => c.classList.add("d" + ((i % 3) + 1)));
    });

    const revObs = new IntersectionObserver(
      (entries, obs) => {
        entries.forEach((e) => {
          if (e.isIntersecting) {
            e.target.classList.add("in");
            obs.unobserve(e.target);
          }
        });
      },
      { threshold: 0.12, rootMargin: "0px 0px -8% 0px" },
    );
    items.forEach((el) => revObs.observe(el));

    let demoObs: IntersectionObserver | null = null;
    const demo = document.querySelector(".agent-demo");
    if (demo) {
      demo.classList.add("armed");
      demoObs = new IntersectionObserver(
        (entries, obs) => {
          entries.forEach((e) => {
            if (e.isIntersecting) {
              e.target.classList.add("playing");
              obs.unobserve(e.target);
            }
          });
        },
        { threshold: 0.3 },
      );
      demoObs.observe(demo);
    }

    return () => {
      revObs.disconnect();
      demoObs?.disconnect();
    };
  }, []);

  return null;
}
