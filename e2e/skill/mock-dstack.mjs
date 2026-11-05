// Stand-in for Phala's dstack guest agent: /GetKey and /Info over the unix socket.
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { rmSync } from "node:fs";
const SOCK = "/var/run/dstack.sock";
try { rmSync(SOCK); } catch {}
createServer((req, res) => {
  let body = "";
  req.on("data", (d) => (body += d)).on("end", () => {
    const url = new URL(req.url, "http://dstack");
    if (url.pathname === "/GetKey") {
      const { path, purpose } = body ? JSON.parse(body) : Object.fromEntries(url.searchParams);
      const key = createHash("sha256").update(`test-app/${path}`).digest("hex"); // deterministic per path, like dstack's KDF
      return res.end(JSON.stringify({ key, signature_chain: ["00", "00"], purpose }));
    }
    if (url.pathname === "/Info") return res.end(JSON.stringify({ app_id: "0x5Fd1Ec3cA0B1e2F3a4B5c6D7e8F9a0B1c2D3e4F5", app_name: "kudo-test" }));
    res.statusCode = 404; res.end();
  });
}).listen(SOCK, () => console.error("[dstack] listening on " + SOCK));
