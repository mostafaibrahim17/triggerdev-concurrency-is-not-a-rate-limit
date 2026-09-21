/**
 * Renders assets/throughput-curve.svg: DEV vs PROD medians from the two sweeps.
 *   node scripts/draw-curve.mjs
 */
import { writeFileSync } from "node:fs";

const LIMITS = [1, 2, 3, 5, 7, 10, 15, 20];
const DEV  = [0.85, 1.65, 2.29, 3.27, 3.67, 3.67, 3.70, 3.70];
const PROD = [0.83, 1.75, 2.29, 3.70, 4.21, 4.35, 3.82, 4.89];

const W = 880, H = 430, L = 64, R = 30, T = 52, B = 64;
const pw = W - L - R, ph = H - T - B;
const x = (i) => L + (pw / (LIMITS.length - 1)) * i;
const y = (v) => T + ph - (v / 5.6) * ph;
const path = (a) => a.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");

const grid = [1, 2, 3, 4, 5].map((v) =>
  `<line x1="${L}" y1="${y(v)}" x2="${W - R}" y2="${y(v)}" stroke="currentColor" stroke-opacity="0.1"/>
  <text x="${L - 10}" y="${y(v) + 4}" text-anchor="end" font-size="11" fill="currentColor" fill-opacity="0.6">${v}</text>`).join("\n  ");

const dots = (a, c) => a.map((v, i) => `<circle cx="${x(i).toFixed(1)}" cy="${y(v).toFixed(1)}" r="4" fill="${c}"/>`).join("\n  ");

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-labelledby="t d" style="max-width:100%;height:auto">
  <title id="t">DEV plateaus at 74% of the vendor limit; PROD climbs to 98%</title>
  <desc id="d">Median vendor throughput across three sweeps per setting. In DEV the curve flattens between 3.67 and 3.70 requests per second from a limit of 7 onward, 74 percent of the vendor's allowance. In PROD the curve rises unevenly, dipping at a limit of 15, and reaches 4.89 at a limit of 20, brushing the vendor's 5 per second. The DEV plateau was the local dev worker, not the vendor.</desc>
  <g font-family="ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif">
  ${grid}
  <line x1="${L}" y1="${T + ph}" x2="${W - R}" y2="${T + ph}" stroke="currentColor" stroke-opacity="0.35"/>
  <line x1="${L}" y1="${y(5)}" x2="${W - R}" y2="${y(5)}" stroke="currentColor" stroke-opacity="0.45" stroke-dasharray="5 4"/>
  <text x="${W - R}" y="${y(5) - 7}" text-anchor="end" font-size="11" fill="currentColor" fill-opacity="0.65">vendor allows 5 req/s</text>

  <path d="${path(DEV)}" fill="none" stroke="currentColor" stroke-opacity="0.45" stroke-width="2.5" stroke-dasharray="6 3"/>
  ${dots(DEV, "currentColor")}
  <text x="${x(7).toFixed(1)}" y="${(y(3.70) + 20).toFixed(1)}" text-anchor="end" font-size="12" font-weight="600" fill="currentColor" fill-opacity="0.65">DEV, flat at 74%</text>

  <path d="${path(PROD)}" fill="none" stroke="#3b6cf6" stroke-width="2.5"/>
  ${dots(PROD, "#3b6cf6")}
  <text x="${x(7).toFixed(1)}" y="${(y(4.89) - 12).toFixed(1)}" text-anchor="end" font-size="12" font-weight="600" fill="#3b6cf6">PROD, 98% at a limit of 20</text>

  ${LIMITS.map((l, i) => `<text x="${x(i).toFixed(1)}" y="${T + ph + 22}" text-anchor="middle" font-size="12" fill="currentColor" fill-opacity="0.75">${l}</text>`).join("\n  ")}
  <text x="${L + pw / 2}" y="${H - 12}" text-anchor="middle" font-size="12" fill="currentColor" fill-opacity="0.7">concurrencyLimit</text>
  <text x="${L}" y="24" font-size="13" font-weight="600" fill="currentColor">vendor requests / second, median of 3 sweeps</text>
  </g>
</svg>
`;
writeFileSync("assets/throughput-curve.svg", svg);
console.log("wrote assets/throughput-curve.svg");
