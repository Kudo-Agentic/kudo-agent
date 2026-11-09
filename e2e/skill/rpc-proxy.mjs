// cast 1.7 sends both `input` and `data` in call objects; Hardhat's fork
// rejects the duplicate. Drop `data` when `input` is present, pass the rest on.
// :8546 forwards everything; :8547 also answers every eth_getLogs with an
// error, standing in for an RPC that rate-limits or caps log ranges.
import { createServer } from "node:http";
const fix = (m) => { for (const p of m.params ?? []) if (p && typeof p === "object" && "input" in p && "data" in p) delete p.data; return m; };
const serve = (port, refuseLogs) =>
  createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d)).on("end", async () => {
      const msg = JSON.parse(body);
      res.setHeader("content-type", "application/json");
      if (refuseLogs && !Array.isArray(msg) && msg.method === "eth_getLogs") {
        return res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: 429, message: "Too Many Requests" } }));
      }
      const out = Array.isArray(msg) ? msg.map(fix) : fix(msg);
      const r = await fetch("http://127.0.0.1:8545", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(out) });
      res.end(await r.text());
    });
  }).listen(port, () => console.error(`[proxy] :${port} → :8545${refuseLogs ? " (refuses eth_getLogs)" : ""}`));
serve(8546, false);
serve(8547, true);
