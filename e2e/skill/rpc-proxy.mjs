// cast 1.7 sends both `input` and `data` in call objects; Hardhat's fork
// rejects the duplicate. Drop `data` when `input` is present, pass the rest on.
import { createServer } from "node:http";
const fix = (m) => { for (const p of m.params ?? []) if (p && typeof p === "object" && "input" in p && "data" in p) delete p.data; return m; };
createServer((req, res) => {
  let body = "";
  req.on("data", (d) => (body += d)).on("end", async () => {
    const msg = JSON.parse(body);
    const out = Array.isArray(msg) ? msg.map(fix) : fix(msg);
    const r = await fetch("http://127.0.0.1:8545", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(out) });
    res.setHeader("content-type", "application/json"); res.end(await r.text());
  });
}).listen(8546, () => console.error("[proxy] :8546 → :8545"));
