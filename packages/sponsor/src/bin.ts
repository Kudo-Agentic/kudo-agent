import { sponsorOptionsFromEnv } from "./config.js";
import { serveSponsor } from "./serve.js";

const options = sponsorOptionsFromEnv();
const port = Number(process.env.PORT ?? 3334);
serveSponsor({ ...options, port, trustProxy: process.env.SPONSOR_TRUST_PROXY === "1" });

const configured = !!(options.alchemyApiKey && options.policyId && options.secret);
console.error(
  `kudo-sponsor: listening on :${port}/sponsor, ${configured ? "configured" : "NOT configured (set ALCHEMY_API_KEY, ALCHEMY_POLICY_ID and SPONSOR_SECRET)"}`,
);
