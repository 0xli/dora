/**
 * Read-only status server for a dora registry.
 *
 * Binds to loopback by default: the roster is not secret, but it does map
 * every node's identity to its address, so it is not something to expose on
 * a public interface without a deliberate `--http-host`.
 */

import http from "node:http";
import type { RegistryStatus } from "./status.js";

export function startStatusServer(opts: {
  port: number;
  host?: string;
  build: () => RegistryStatus;
  log?: (msg: string) => void;
}): { stop: () => void } {
  const host = opts.host ?? "127.0.0.1";
  const server = http.createServer((req, res) => {
    const url = (req.url ?? "/").split("?")[0];
    if (req.method !== "GET") {
      res.writeHead(405).end();
      return;
    }
    if (url === "/api/status") {
      res.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
      });
      res.end(JSON.stringify(opts.build(), null, 2));
      return;
    }
    if (url === "/" || url === "/index.html") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(PAGE);
      return;
    }
    res.writeHead(404).end("not found");
  });
  server.listen(opts.port, host, () => {
    opts.log?.(`status UI on http://${host}:${opts.port}`);
  });
  server.unref?.();
  return { stop: () => server.close() };
}

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>dora — registry status</title>
<style>
:root{--bg:#0d1117;--panel:#161b22;--line:#30363d;--txt:#e6edf3;--dim:#8b949e;
  --ok:#3fb950;--warn:#d29922;--bad:#f85149;--acc:#58a6ff}
@media (prefers-color-scheme:light){:root{--bg:#f6f8fa;--panel:#fff;--line:#d0d7de;
  --txt:#1f2328;--dim:#636c76;--ok:#1a7f37;--warn:#9a6700;--bad:#cf222e;--acc:#0969da}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--txt);font:14px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace}
.wrap{max-width:1100px;margin:0 auto;padding:24px 16px 60px}
h1{font-size:18px;margin:0 0 2px}
h2{font-size:14px;margin:26px 0 8px;color:var(--dim);text-transform:uppercase;letter-spacing:.08em}
.sub{color:var(--dim);font-size:12px;margin-bottom:18px}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:10px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:12px 14px}
.card .k{color:var(--dim);font-size:11px;text-transform:uppercase;letter-spacing:.06em}
.card .v{font-size:20px;font-weight:700;margin-top:2px}
table{width:100%;border-collapse:collapse;background:var(--panel);border:1px solid var(--line);
  border-radius:8px;overflow:hidden;font-size:12.5px}
th,td{text-align:left;padding:7px 10px;border-bottom:1px solid var(--line);white-space:nowrap}
th{color:var(--dim);font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:.05em}
tr:last-child td{border-bottom:none}
.scroll{overflow-x:auto}
.pill{display:inline-block;padding:1px 7px;border-radius:99px;font-size:11px;font-weight:700}
.up{background:color-mix(in oklab,var(--ok),transparent 82%);color:var(--ok)}
.down{background:color-mix(in oklab,var(--bad),transparent 82%);color:var(--bad)}
.unk{background:color-mix(in oklab,var(--dim),transparent 85%);color:var(--dim)}
.self{color:var(--ok)}.rep{color:var(--acc)}.oob{color:var(--warn)}
.bar{height:6px;background:var(--line);border-radius:99px;overflow:hidden;margin-top:6px}
.bar>i{display:block;height:100%;background:var(--acc)}
.empty{color:var(--dim);padding:10px 0}
.err{background:color-mix(in oklab,var(--bad),transparent 88%);border:1px solid var(--bad);
  border-radius:8px;padding:10px 14px;color:var(--bad);margin-top:8px}
</style></head><body><div class="wrap" id="root">loading…</div>
<script>
const esc=s=>String(s??"").replace(/[&<>]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;"}[c]));
const dur=ms=>{if(ms==null)return"—";const s=Math.floor(ms/1000);
  if(s<60)return s+"s";const m=Math.floor(s/60);if(m<60)return m+"m";
  const h=Math.floor(m/60);if(h<24)return h+"h "+(m%60)+"m";return Math.floor(h/24)+"d "+(h%24)+"h"};
const pct=r=>r==null?"n/a":(r*100).toFixed(1)+"%";

function render(d){
  const s=d.self;
  const sib=d.siblings.map(x=>{
    const state=x.up===null?'<span class="pill unk">unknown</span>'
      :x.up?'<span class="pill up">up</span>':'<span class="pill down">DOWN</span>';
    return \`<tr><td>\${esc(x.name||x.userid.slice(0,12))}</td><td>\${state}</td>
      <td>\${pct(x.uptimeRatio)}</td><td>\${x.outages}</td>
      <td>\${x.failures}/\${x.probes}</td><td>\${x.recordsFrom}</td>
      <td>\${esc(x.lastUpAt||"never")}</td></tr>\`}).join("");

  const cov=d.coverage.map(c=>\`<tr><td>\${esc(c.band)}</td>
      <td>\${c.fromSelf?'<span class="self">own band</span>':'<span class="rep">replicated</span>'}</td>
      <td>\${c.records}</td>
      <td>\${c.records>0?'<span class="pill up">resolvable</span>':'<span class="pill down">no records</span>'}</td></tr>\`).join("");

  const recs=d.records.map(r=>{
    const o=r.origin==="self"?'<span class="self">own</span>'
      :r.origin==="replica"?'<span class="rep">replica</span>'
      :'<span class="oob">out-of-band</span>';
    return \`<tr><td>\${esc(r.virtualIp)}</td><td>\${esc(r.name)}</td><td>\${o}</td>
      <td>\${esc(r.replicatedFrom?r.replicatedFrom.slice(0,12):"—")}</td>
      <td>\${esc(r.userid.slice(0,16))}…</td></tr>\`}).join("");

  const conf=d.conflicts.length
    ? '<div class="err">'+d.conflicts.map(c=>\`\${esc(c.virtualIp)}: \${esc(c.heldByName)} vs \${esc(c.claimedByName)}\`).join("<br>")+'</div>'
    : '<div class="empty">none — every address has exactly one claimant</div>';

  document.getElementById("root").innerHTML=\`
  <h1>\${esc(s.name||"dora")} <span style="color:var(--dim);font-weight:400">registry</span></h1>
  <div class="sub">\${esc(s.userid)}<br>band \${esc(s.segment)} · up \${dur(s.uptimeMs)} · \${esc(d.generatedAt)}</div>
  <div class="cards">
    <div class="card"><div class="k">band used</div><div class="v">\${s.used} / \${s.capacity.toLocaleString()}</div>
      <div class="bar"><i style="width:\${Math.max(0.5,Math.min(100,s.usedPct)).toFixed(2)}%"></i></div></div>
    <div class="card"><div class="k">replicas held</div><div class="v">\${s.replicasHeld}</div></div>
    <div class="card"><div class="k">out-of-band</div><div class="v">\${s.outOfBand}</div></div>
    <div class="card"><div class="k">conflicts</div><div class="v" style="color:\${d.conflicts.length?"var(--bad)":"inherit"}">\${d.conflicts.length}</div></div>
  </div>
  <h2>band coverage — can this registry still answer if a peer dies?</h2>
  <div class="scroll"><table><tr><th>band</th><th>source</th><th>records</th><th>status</th></tr>\${cov}</table></div>
  <h2>siblings</h2>
  <div class="scroll">\${sib?\`<table><tr><th>registry</th><th>state</th><th>uptime</th><th>outages</th><th>fail/probes</th><th>records</th><th>last answered</th></tr>\${sib}</table>\`:'<div class="empty">replication not enabled (--peers)</div>'}</div>
  <h2>address conflicts</h2>\${conf}
  <h2>roster — \${d.records.length} record(s)</h2>
  <div class="scroll"><table><tr><th>virtual ip</th><th>name</th><th>origin</th><th>from</th><th>userid</th></tr>\${recs}</table></div>\`;
}

async function tick(){
  try{ render(await (await fetch("/api/status",{cache:"no-store"})).json()); }
  catch(e){ document.getElementById("root").innerHTML='<div class="err">'+esc(e.message)+'</div>'; }
}
tick(); setInterval(tick,10000);
</script></body></html>`;
