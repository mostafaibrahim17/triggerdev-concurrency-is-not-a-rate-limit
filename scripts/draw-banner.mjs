/**
 * Renders assets/banner.svg, the repo's header image (1200x260).
 *   node scripts/draw-banner.mjs
 */
import { writeFileSync } from "node:fs";

// DEV plateaus, PROD climbs. Same sweep, drawn small enough to read as a glyph.
const L = [1, 2, 3, 5, 7, 10, 15, 20];
const DEV = [0.85, 1.65, 2.29, 3.27, 3.67, 3.67, 3.70, 3.70];
const PROD = [0.83, 1.75, 2.29, 3.70, 4.21, 4.35, 3.82, 4.89];
const x = (i) => 720 + (430 / (L.length - 1)) * i;
const y = (v) => 214 - (v / 5.4) * 150;
const path = (a) => a.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 260" width="1200" height="260" role="img" aria-labelledby="t d">
  <title id="t">concurrencyLimit is not a rate limit</title>
  <desc id="d">Repository banner. A queue sized by Little's Law against a vendor allowing five requests a second, with a small chart showing DEV throughput flat at 74 percent of the allowance while PROD climbs to 98 percent.</desc>
  <rect width="1200" height="260" fill="#ffffff"/>
  <rect x="0.5" y="0.5" width="1199" height="259" fill="none" stroke="#dbe2e8"/>
  <rect x="0" y="0" width="1200" height="4" fill="#3b6cf6"/>
  <g font-family="ui-monospace, SFMono-Regular, Menlo, monospace">
    <text x="64" y="78" font-size="15" font-weight="600" letter-spacing="2.4" fill="#3b6cf6">TRIGGER.DEV &#183; SDK 4.5.10</text>
    <text x="64" y="140" font-size="44" font-weight="600" fill="#16212b">concurrencyLimit</text>
    <text x="64" y="192" font-size="44" font-weight="600" fill="#8494a1">is not a rate limit</text>
    <text x="64" y="228" font-size="15" fill="#5b6a77">10,000 lookups &#183; a vendor allowing 5 req/s &#183; measured in DEV and PROD</text>
  </g>
  <g font-family="ui-sans-serif, system-ui, sans-serif">
    <line x1="720" y1="${y(5).toFixed(1)}" x2="1150" y2="${y(5).toFixed(1)}" stroke="#8494a1" stroke-dasharray="4 4" stroke-width="1.2"/>
    <text x="1150" y="${(y(5) - 8).toFixed(1)}" text-anchor="end" font-size="11" fill="#5b6a77">vendor allows 5 req/s</text>
    <path d="${path(DEV)}" fill="none" stroke="#8494a1" stroke-width="2.4" stroke-dasharray="5 3"/>
    <path d="${path(PROD)}" fill="none" stroke="#3b6cf6" stroke-width="2.8"/>
    ${PROD.map((v, i) => `<circle cx="${x(i).toFixed(1)}" cy="${y(v).toFixed(1)}" r="3" fill="#3b6cf6"/>`).join("")}
    <text x="1150" y="${(y(3.70) + 22).toFixed(1)}" text-anchor="end" font-size="12" font-weight="600" fill="#5b6a77">DEV, 74%</text>
    <text x="1150" y="${(y(4.89) - 10).toFixed(1)}" text-anchor="end" font-size="12" font-weight="600" fill="#3b6cf6">PROD, 98%</text>
  </g>
</svg>
`;
writeFileSync("assets/banner.svg", svg);
console.log("wrote assets/banner.svg");
