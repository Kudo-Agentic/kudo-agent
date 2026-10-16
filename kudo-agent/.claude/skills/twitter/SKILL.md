---
name: twitter
description: Post tweets from this agent's X account and read back the posted URL. Use whenever a task involves tweeting, posting to X or Twitter, or producing the tweet URL that settles a covenant's leg. Covers OAuth 1.0a request signing with no dependencies, the pre-flight that catches a read-only token, and what each 403 actually means.
---

# Posting to X

This agent posts through the X API v2 directly. There is no MCP server and no
helper library — requests are signed with OAuth 1.0a using only `node:crypto`,
which is available in the image.

## Credentials

| Variable | From |
|---|---|
| `TWITTER_API_KEY` | app consumer key |
| `TWITTER_API_SECRET_KEY` | app consumer secret |
| `TWITTER_ACCESS_TOKEN` | user access token |
| `TWITTER_ACCESS_TOKEN_SECRET` | user access token secret |
| `TWITTER_HANDLE` | the account's handle, used to build tweet URLs |

All four credentials are required. If any one is missing or empty the request
is unsigned and X answers `403 Unsupported Authentication` — the error says
"Authenticating with Unknown", which looks like a permissions problem but is
not. Check all four are present before anything else.

## Pre-flight: is this token allowed to post?

Run this before the first post of a session. It is a read, and it reports the
token's own access level — which is the only reliable way to know whether a
post will be refused.

```bash
node -e '
const crypto = require("crypto");
const e = encodeURIComponent;
const url = "https://api.twitter.com/1.1/account/verify_credentials.json";
const o = {
  oauth_consumer_key: process.env.TWITTER_API_KEY,
  oauth_nonce: crypto.randomBytes(16).toString("hex"),
  oauth_signature_method: "HMAC-SHA1",
  oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
  oauth_token: process.env.TWITTER_ACCESS_TOKEN,
  oauth_version: "1.0",
};
const base = "GET&" + e(url) + "&" + e(Object.keys(o).sort().map(k => e(k) + "=" + e(o[k])).join("&"));
const key = e(process.env.TWITTER_API_SECRET_KEY) + "&" + e(process.env.TWITTER_ACCESS_TOKEN_SECRET);
o.oauth_signature = crypto.createHmac("sha1", key).update(base).digest("base64");
const header = "OAuth " + Object.keys(o).sort().map(k => e(k) + "=\"" + e(o[k]) + "\"").join(", ");
fetch(url, { headers: { Authorization: header } }).then(async r => {
  const body = await r.json();
  console.log("status:", r.status, "| access-level:", r.headers.get("x-access-level"), "| @" + (body.screen_name || "?"));
});'
```

`x-access-level` must read **`read-write`**. If it reads `read`, posting will
fail no matter what the developer portal shows — see the 403 section below.

## Posting

```bash
node -e '
const crypto = require("crypto");
const e = encodeURIComponent;
const text = process.argv[1];
const url = "https://api.twitter.com/2/tweets";
const o = {
  oauth_consumer_key: process.env.TWITTER_API_KEY,
  oauth_nonce: crypto.randomBytes(16).toString("hex"),
  oauth_signature_method: "HMAC-SHA1",
  oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
  oauth_token: process.env.TWITTER_ACCESS_TOKEN,
  oauth_version: "1.0",
};
// JSON body parameters are NOT part of the OAuth signature base string.
const base = "POST&" + e(url) + "&" + e(Object.keys(o).sort().map(k => e(k) + "=" + e(o[k])).join("&"));
const key = e(process.env.TWITTER_API_SECRET_KEY) + "&" + e(process.env.TWITTER_ACCESS_TOKEN_SECRET);
o.oauth_signature = crypto.createHmac("sha1", key).update(base).digest("base64");
const header = "OAuth " + Object.keys(o).sort().map(k => e(k) + "=\"" + e(o[k]) + "\"").join(", ");
fetch(url, {
  method: "POST",
  headers: { Authorization: header, "Content-Type": "application/json" },
  body: JSON.stringify({ text }),
}).then(async r => {
  const body = await r.json();
  if (!r.ok) { console.error("FAILED", r.status, JSON.stringify(body)); process.exit(1); }
  console.log("https://twitter.com/" + process.env.TWITTER_HANDLE + "/status/" + body.data.id);
});' "<tweet text here>"
```

It prints the tweet URL and nothing else, so the URL can be used directly as a
covenant's settlement data. Pass the text as an argument rather than
interpolating it into the script — tweets contain quotes, apostrophes and em
dashes that will otherwise break the shell or the JavaScript.

## Writing the tweet

- 280 characters maximum. Count before posting; a rejected post still costs a
  round trip.
- X refuses exact duplicates of a recent tweet. Vary the text rather than
  retrying the same string.
- Write the tweet the ask actually describes. If the ask names a subject
  ("tweet about sub-second finality"), the tweet must be about that subject —
  a covenant's ask is the record of what was owed.
- Only assert things that are true. If a tweet would state a figure, either
  have measured it or leave it out.

## What the 403s mean

| Response | Cause | Fix |
|---|---|---|
| `"Your client app is not configured with the appropriate oauth1 app permissions"` | the **token** is read-only | In the developer portal set the app to *Read and write*, then **regenerate the access token and secret**. Changing the setting alone does nothing — an existing token keeps the permission it was minted under. The consumer key and secret stay the same. |
| `"Authenticating with Unknown is forbidden"` | one or more credentials missing or empty | Check all four variables are set and non-empty; a mangled env file produces this. |
| `401` on the pre-flight | wrong secret, or signature built wrong | Confirm the signing key is `consumer_secret & token_secret`, both URL-encoded. |

The permissions case is the common one and the fix is counter-intuitive: the
portal can show *Read and write* while the token in hand is still `read`. Trust
`x-access-level`, not the portal.

## After posting

The tweet URL is the deliverable. When a covenant's ask or promise was a tweet,
that URL is what gets written as settlement data — see the kudo-covenants
skill for which party signs which leg.

Never claim a tweet was posted without a URL from a successful response, and
never reuse an older tweet's URL to settle a new covenant.
