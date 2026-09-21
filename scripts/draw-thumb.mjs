/**
 * Renders assets/thumbnail.svg, the article's hero image, at 1200x630.
 * Typographic: the title carrying the weight, with the two numbers that
 * make the claim sitting underneath it.
 *   node scripts/draw-thumb.mjs
 */
import { writeFileSync } from "node:fs";

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 630" width="1200" height="630" role="img" aria-labelledby="t d">
  <title id="t">I measured my queue in DEV. Production disagreed.</title>
  <desc id="d">Title card. In DEV the pipeline reached 74 percent of the vendor allowance and 13 of 20 requested slots. In PROD it reached 98 percent and all 20.</desc>
  <rect width="1200" height="630" fill="#ffffff"/>
  <rect x="0" y="0" width="1200" height="7" fill="#3b6cf6"/>
  <g font-family="Inter, ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif">

    <text x="104" y="118" font-size="15" font-weight="600" letter-spacing="2.2" fill="#3b6cf6">LITTLE&#8217;S LAW, MEASURED</text>

    <text x="104" y="228" font-size="76" font-weight="600" letter-spacing="-2.4" fill="#16181d">I measured my queue in DEV.</text>
    <text x="104" y="312" font-size="76" font-weight="600" letter-spacing="-2.4" fill="#16181d">Production disagreed.</text>
    

    <line x1="104" y1="470" x2="1096" y2="470" stroke="#e7e9ec" stroke-width="1.5"/>

    <text x="104" y="534" font-size="30" font-weight="600" fill="#16181d">DEV</text>
    <text x="238" y="534" font-size="30" fill="#9aa1ab">&#8594;</text>
    <text x="288" y="534" font-size="30" font-weight="600" fill="#6d7480">74% of the vendor, capped at 13 of 20 slots</text>

    <text x="104" y="586" font-size="30" font-weight="600" fill="#16181d">PROD</text>
    <text x="238" y="586" font-size="30" fill="#9aa1ab">&#8594;</text>
    <text x="288" y="586" font-size="30" font-weight="600" fill="#3b6cf6">98% of the vendor, all 20 slots ran</text>

    <text x="1096" y="586" text-anchor="end" font-size="17" fill="#6d7480">against a vendor allowing 5 req/s</text>
  </g>
</svg>
`;
writeFileSync("assets/thumbnail.svg", svg);
console.log("wrote assets/thumbnail.svg");
