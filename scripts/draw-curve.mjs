/**
 * Renders assets/throughput-curve.svg: DEV vs PROD medians from the two sweeps.
 *   node scripts/draw-curve.mjs
 */
import { writeFileSync } from "node:fs";

const LIMITS = [1, 2, 3, 5, 7, 10, 15, 20];
const DEV  = [0.85, 1.65, 2.29, 3.27, 3.67, 3.67, 3.70, 3.70];
const PROD = [0.83, 1.75, 2.29, 3.70, 4.21, 4.35, 3.82, 4.89];

const W = 1000, H = 460, L = 78, R = 36, T = 62, B = 74;
const pw = W - L - R, ph = H - T - B;
const x = (i) => L + (pw / (LIMITS.length - 1)) * i;
const y = (v) => T + ph - (v / 5.6) * ph;
const path = (a) => a.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");

const grid = [1, 2, 3, 4, 5].map((v) =>
  `<line x1="${L}" y1="${y(v)}" x2="${W - R}" y2="${y(v)}" stroke="#e6ebef"/>
  <text x="${L - 10}" y="${y(v) + 4}" text-anchor="end" font-size="14" fill="#5b6a77">${v}</text>`).join("\n  ");

const dots = (a, c) => a.map((v, i) => `<circle cx="${x(i).toFixed(1)}" cy="${y(v).toFixed(1)}" r="5" fill="${c}"/>`).join("\n  ");

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-labelledby="t d" style="max-width:100%;height:auto">
  <title id="t">DEV plateaus at 74% of the vendor limit; PROD climbs to 98%</title>
  <desc id="d">Median vendor throughput across three sweeps per setting. In DEV the curve flattens between 3.67 and 3.70 requests per second from a limit of 7 onward, 74 percent of the vendor's allowance. In PROD the curve rises unevenly, dipping at a limit of 15, and reaches 4.89 at a limit of 20, brushing the vendor's 5 per second. The DEV plateau was the local dev worker, not the vendor.</desc>
  <rect width="${W}" height="${H}" fill="#ffffff"/>
  <rect x="0.5" y="0.5" width="${W-1}" height="${H-1}" fill="none" stroke="#dbe2e8"/>
  <g font-family="ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif">
  ${grid}
  <line x1="${L}" y1="${T + ph}" x2="${W - R}" y2="${T + ph}" stroke="#c7d1d9"/>
  <line x1="${L}" y1="${y(5)}" x2="${W - R}" y2="${y(5)}" stroke="#8494a1" stroke-dasharray="5 4"/>
  <text x="${W - R}" y="${y(5) - 7}" text-anchor="end" font-size="14" fill="#5b6a77">vendor allows 5 req/s</text>

  <path d="${path(DEV)}" fill="none" stroke="#8494a1" stroke-width="3" stroke-dasharray="6 3"/>
  ${dots(DEV, "#8494a1")}
  <text x="${x(7).toFixed(1)}" y="${(y(3.70) + 20).toFixed(1)}" text-anchor="end" font-size="15" font-weight="600" fill="#5b6a77">DEV, flat at 74%</text>

  <path d="${path(PROD)}" fill="none" stroke="#3b6cf6" stroke-width="3"/>
  ${dots(PROD, "#3b6cf6")}
  <text x="${x(7).toFixed(1)}" y="${(y(4.89) - 12).toFixed(1)}" text-anchor="end" font-size="15" font-weight="600" fill="#3b6cf6">PROD, 98% at a limit of 20</text>

  ${LIMITS.map((l, i) => `<text x="${x(i).toFixed(1)}" y="${T + ph + 22}" text-anchor="middle" font-size="14" fill="#5b6a77">${l}</text>`).join("\n  ")}
  <text x="${L + pw / 2}" y="${H - 12}" text-anchor="middle" font-size="14" fill="#5b6a77">concurrencyLimit</text>
  <text x="${L}" y="24" font-size="16" font-weight="600" fill="#16212b">vendor requests / second, median of 3 sweeps</text>
  </g>
</svg>
`;
writeFileSync("assets/throughput-curve.svg", svg);
console.log("wrote assets/throughput-curve.svg");
