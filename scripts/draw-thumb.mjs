/**
 * Renders assets/thumbnail.svg, the article's hero card (1200x630).
 *
 * The claim is a disagreement between two environments, so the card is split
 * in two: the same sweep, the same request, two different answers.
 *
 *   node scripts/draw-thumb.mjs
 */
import { writeFileSync } from "node:fs";

const DEV  = [0.85, 1.65, 2.29, 3.27, 3.67, 3.67, 3.70, 3.70];
const PROD = [0.83, 1.75, 2.29, 3.70, 4.21, 4.35, 3.82, 4.89];

/** Sparkline inside a panel: x spans the 8 limits, y is req/s against the vendor's 5. */
function spark(vals, x0, y0, w, h) {
  const x = (i) => x0 + (w / (vals.length - 1)) * i;
  const y = (v) => y0 + h - (v / 5.4) * h;
  return {
    path: vals.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" "),
    cap: `${x(vals.length - 1).toFixed(1)},${y(vals[vals.length - 1]).toFixed(1)}`,
    limitY: y(5).toFixed(1),
  };
}

const d = spark(DEV, 96, 384, 400, 104);
const p = spark(PROD, 704, 384, 400, 104);

const panel = (s, x, label, colour, pct, slots, dashed) => `
    <text x="${x}" y="352" font-size="17" font-weight="600" letter-spacing="2" fill="${colour}">${label}</text>
    <line x1="${x}" y1="${s.limitY}" x2="${x + 400}" y2="${s.limitY}" stroke="#c7d1d9" stroke-dasharray="4 4"/>
    <path d="${s.path}" fill="none" stroke="${colour}" stroke-width="3.5"${dashed ? ' stroke-dasharray="7 4"' : ""}/>
    <circle cx="${s.cap.split(",")[0]}" cy="${s.cap.split(",")[1]}" r="6" fill="${colour}"/>
    <text x="${x}" y="566" font-size="72" font-weight="600" letter-spacing="-2" fill="${colour}">${pct}</text>
    <text x="${x + (pct.length > 3 ? 172 : 150)}" y="566" font-size="19" fill="#5b6a77">of the vendor's rate</text>
    <text x="${x}" y="598" font-size="19" fill="#5b6a77">${slots}</text>`;

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 630" width="1200" height="630" role="img" aria-labelledby="t d">
  <title id="t">I measured my queue in DEV. Production disagreed.</title>
  <desc id="d">The same concurrency sweep run twice. In DEV, throughput flattened at 74 percent of the vendor's allowance and a requested limit of 20 only ever ran 13. In PROD the same sweep reached 98 percent and all 20 slots ran.</desc>
  <rect width="1200" height="630" fill="#ffffff"/>
  <rect x="0" y="0" width="1200" height="6" fill="#3b6cf6"/>
  <line x1="600" y1="300" x2="600" y2="606" stroke="#e6ebef" stroke-width="1.5"/>
  <g font-family="Inter, ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif">

    <text x="96" y="104" font-size="17" font-weight="600" letter-spacing="2.6" fill="#3b6cf6">TRIGGER.DEV &#183; ONE SWEEP, TWO ENVIRONMENTS</text>
    <text x="96" y="196" font-size="66" font-weight="600" letter-spacing="-2.2" fill="#16212b">I measured my queue in DEV.</text>
    <text x="96" y="268" font-size="66" font-weight="600" letter-spacing="-2.2" fill="#8494a1">Production disagreed.</text>
${panel(d, 96, "DEV", "#8494a1", "74%", "13 of the 20 slots asked for", true)}
${panel(p, 704, "PROD", "#3b6cf6", "98%", "20 of the 20 slots asked for", false)}
  </g>
</svg>
`;
writeFileSync("assets/thumbnail.svg", svg);
console.log("wrote assets/thumbnail.svg");
