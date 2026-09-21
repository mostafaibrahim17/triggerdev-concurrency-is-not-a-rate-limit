/**
 * Sets MOCK_API_URL in the PROD environment so deployed workers can reach the
 * tunnel in front of the local mock vendor.
 *
 *   TUNNEL_URL=https://... npm run set-prod-env
 */
import { envvars, configure } from "@trigger.dev/sdk";

async function main() {
  const ref = process.env.TRIGGER_PROJECT_REF;
  const url = process.env.TUNNEL_URL;
  const key = process.env.TRIGGER_PROD_KEY;
  if (!ref || !url || !key) throw new Error("need TRIGGER_PROJECT_REF, TUNNEL_URL, TRIGGER_PROD_KEY");

  configure({ secretKey: key });
  await envvars.upload(ref, "prod", {
    variables: { MOCK_API_URL: url },
    override: true,
  });
  const list = await envvars.list(ref, "prod");
  console.log("prod env vars:", list.map((v) => v.name).join(", ") || "(none)");
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
