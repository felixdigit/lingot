import type { Registry, RegistryVenture } from "./registry";
import { CONCERNS, type DoctorReport, type VentureDoctorReport } from "./doctor";
import { dbProject } from "./venture";

/**
 * `lingot map` -- org map v0, GENERATED from registry.json (generated beats written).
 * Reference rendering: Felix's hand-drawn v0 (~/work/ortova/docs/founder/
 * studio-operating-model.html): monochrome, one canvas, BASE + HARNESS PASS toggle.
 * With a doctor report (P3), the harness pass renders LIVE verdicts -- green/red
 * per concern per venture; without one it renders hollow stubs. The org chart is
 * the harness's own dashboard.
 */

const W = 960;

interface DoctorView {
  readonly date: string;
  readonly byVenture: Map<string, VentureDoctorReport>;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

interface Slot {
  readonly v: RegistryVenture;
  readonly x: number;
  readonly w: number;
}

function ventureSlots(ventures: readonly RegistryVenture[]): Slot[] {
  const row = ventures
    .filter((v) => v.kind === "venture")
    .sort(
      (a, b) =>
        b.manifest.interfaces.provides.length - a.manifest.interfaces.provides.length ||
        b.owners.length - a.owners.length ||
        a.name.localeCompare(b.name),
    );
  const margin = 40;
  const gap = 18;
  const w = Math.min(200, Math.floor((W - margin * 2 - gap * (row.length - 1)) / Math.max(row.length, 1)));
  return row.map((v, i) => ({ v, x: margin + i * (w + gap), w }));
}

function ventureBox(slot: Slot, y: number, h: number, harness: boolean, doctor?: DoctorView): string {
  const { v, x, w } = slot;
  const cx = x + w / 2;
  const m = v.manifest;
  const docRep = doctor?.byVenture.get(v.name);
  const parts: string[] = [];
  parts.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" class="box"/>`);
  parts.push(`<text x="${cx}" y="${y + 20}" text-anchor="middle" font-size="12" font-weight="700">${esc(v.name.toUpperCase())}</text>`);
  const ownersLine = v.owners.join(" &#183; ") + (v.placement === "parked" ? " &#183; parked" : "");
  parts.push(`<text x="${cx}" y="${y + 34}" text-anchor="middle" font-size="8.5" class="cap">${ownersLine}</text>`);
  const fit = (px: number, fontPx: number) => Math.max(10, Math.floor(px / (fontPx * 0.62)));
  const repo = m.identity.aliases?.repo;
  if (repo) {
    parts.push(`<text x="${cx}" y="${y + 47}" text-anchor="middle" font-size="8" class="cap">${esc(truncate("repo: " + repo, fit(w - 12, 8)))}</text>`);
  }
  if (harness) {
    const kernel = m.harness.kernel ?? "organic";
    parts.push(`<rect x="${cx - 26}" y="${y - 7}" width="52" height="13" class="chip"/>`);
    parts.push(`<text x="${cx}" y="${y + 3}" text-anchor="middle" font-size="7.5">${esc(kernel)}</text>`);
    const modules = Object.entries(m.harness.modules).map(([name, cfg]) => {
      if (name === "zone-set" && typeof cfg === "object" && cfg !== null && "fronts" in cfg) return `zone-set:${(cfg as { fronts: number }).fronts}`;
      if (name === "co-owner" && typeof cfg === "object" && cfg !== null && "with" in cfg) return `co-owner:${(cfg as { with: string }).with}`;
      return name;
    });
    const modText = modules.length > 0 ? modules.join(" &#183; ") : "no modules declared";
    const lines = wrapText(modText, 30);
    lines.slice(0, 3).forEach((line, i) => {
      parts.push(`<text x="${cx}" y="${y + 62 + i * 11}" text-anchor="middle" font-size="7.5" class="cap">${line}</text>`);
    });
    // Five concern squares -- live doctor verdicts when a report exists, hollow stubs otherwise.
    const letters = ["A", "T", "L", "Q", "L"];
    const sqW = 12;
    const sq0 = cx - (5 * sqW + 4 * 6) / 2;
    letters.forEach((letter, i) => {
      const sx = sq0 + i * (sqW + 6);
      const verdict = docRep?.concerns.find((c) => c.concern === CONCERNS[i])?.verdict;
      const cls = verdict === "green" ? "sqok" : verdict === "red" ? "sqred" : "rsq";
      parts.push(`<rect x="${sx}" y="${y + 92}" width="${sqW}" height="${sqW}" class="${cls}"/>`);
      parts.push(
        `<text x="${sx + sqW / 2}" y="${y + 101.5}" text-anchor="middle" font-size="7" ${verdict ? 'fill="#f6f4ef"' : 'class="cap"'}>${letter}</text>`,
      );
    });
    const reds = docRep ? docRep.findings.filter((f) => f.level === "red").length : 0;
    parts.push(
      `<text x="${cx}" y="${y + 117}" text-anchor="middle" font-size="7.5" class="cap">${
        doctor ? `doctor ${doctor.date}${docRep ? ` &#183; ${reds} red` : ""}` : "doctor &#183; P3"
      }</text>`,
    );
    const stateBits = ["generator", "worksite", "decisions"].map(
      (k) => `${k[0]}${m.state[k] ? "&#10003;" : "&#8212;"}`,
    );
    parts.push(`<text x="${cx}" y="${y + 133}" text-anchor="middle" font-size="8" class="cap">state: ${stateBits.join(" &#183; ")}</text>`);
  }
  const claim = dbProject(m.db);
  const chipChars = fit(w - 32, 8.5);
  const dbLabel = claim
    ? claim === "studio"
      ? `db: studio &#183; ${esc(m.db?.schema ?? "?")}.*`
      : esc(truncate("db: " + (m.db?.display ?? claim), chipChars))
    : m.identity.aliases?.db
      ? esc(truncate("db: " + m.identity.aliases.db, chipChars))
      : "no db declared";
  const chipY = y + h - 32;
  parts.push(`<rect x="${x + 12}" y="${chipY}" width="${w - 24}" height="22" class="soft"/>`);
  parts.push(`<text x="${cx}" y="${chipY + 14.5}" text-anchor="middle" font-size="8.5">${dbLabel}</text>`);
  return parts.join("\n    ");
}

function wrapText(s: string, max: number): string[] {
  const words = s.split(" ");
  const lines: string[] = [];
  let cur = "";
  for (const word of words) {
    if (cur && (cur + " " + word).length > max) {
      lines.push(cur);
      cur = word;
    } else {
      cur = cur ? cur + " " + word : word;
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

function consumeEdges(slots: Slot[], rowBottom: number): string {
  const byName = new Map(slots.map((s) => [s.v.name, s]));
  const parts: string[] = [];
  let depth = 0;
  for (const slot of slots) {
    for (const edge of slot.v.manifest.interfaces.consumes) {
      const provider = edge.of ? byName.get(edge.of) : undefined;
      if (!provider) continue;
      const x1 = slot.x + slot.w / 2;
      const x2 = provider.x + provider.w / 2;
      const dip = rowBottom + 34 + depth * 22;
      depth += 1;
      const live = edge.status === "live";
      const mid = (x1 + x2) / 2;
      parts.push(`<path d="M ${x1} ${rowBottom} Q ${mid} ${dip + 18} ${x2} ${rowBottom + 4}" class="${live ? "flow" : "dash"}"/>`);
      parts.push(`<polygon points="${x2},${rowBottom + 4} ${x2 - 4},${rowBottom + 13} ${x2 + 4},${rowBottom + 13}" fill="${live ? "#1c1b19" : "#8b877e"}"/>`);
      parts.push(
        `<text x="${mid}" y="${dip + 22}" text-anchor="middle" font-size="8" class="cap">${esc(edge.name)}${live ? "" : ` (${esc(edge.status ?? "planned")})`}</text>`,
      );
    }
  }
  return parts.join("\n    ");
}

function studioBox(studio: RegistryVenture | undefined, harness: boolean): string {
  const provides = studio?.manifest.interfaces.provides.map((p) => p.name) ?? [];
  const caption = harness ? "laws &#183; manifests &#183; registry &#183; the compiler ships kernel+modules" : "the engine center &#183; Felix-only";
  const inner = [
    { label: "LINGOT", cap: harness ? "laws &#183; checks &#183; compiler" : "the OS &#183; the compiler" },
    { label: "ENGINE", cap: "@nexod/* &#183; machinery" },
    { label: "REGISTRY", cap: harness ? "census &#183; triage &#183; map" : "venture cards" },
  ];
  const parts: string[] = [];
  parts.push(`<rect x="150" y="96" width="660" height="116" class="box"/>`);
  parts.push(`<text x="480" y="118" text-anchor="middle" font-size="13" font-weight="700">${esc((studio?.name ?? "nexod").toUpperCase())} &#183; THE STUDIO</text>`);
  parts.push(`<text x="480" y="132" text-anchor="middle" font-size="8.5" class="cap">${caption}</text>`);
  inner.forEach((box, i) => {
    const x = 175 + i * 215;
    parts.push(`<rect x="${x}" y="${140}" width="190" height="56" class="inner"/>`);
    parts.push(`<text x="${x + 95}" y="${162}" text-anchor="middle" font-size="11.5" font-weight="700">${box.label}</text>`);
    parts.push(`<text x="${x + 95}" y="${178}" text-anchor="middle" font-size="8.5" class="cap">${box.cap}</text>`);
  });
  if (provides.length > 0) {
    parts.push(`<text x="480" y="207" text-anchor="middle" font-size="8" class="cap">provides: ${provides.map((p) => esc(p)).join(" &#183; ")}</text>`);
  }
  return parts.join("\n    ");
}

function pass(registry: Registry, harness: boolean, doctor?: DoctorView): string {
  const studio = registry.ventures.find((v) => v.kind === "studio");
  const slots = ventureSlots(registry.ventures);
  const vy = 300;
  const vh = harness ? 200 : 120;
  const rowBottom = vy + vh;
  const parts: string[] = [];
  // FELIX
  parts.push(`<rect x="400" y="12" width="160" height="42" class="box"/>`);
  parts.push(`<text x="480" y="31" text-anchor="middle" font-size="14" font-weight="700">FELIX</text>`);
  parts.push(`<text x="480" y="46" text-anchor="middle" font-size="9.5" class="cap">judgment &#183; gates</text>`);
  if (harness) {
    for (let i = 0; i < 5; i++) {
      const gx = 416 + i * 32;
      parts.push(`<polygon points="${gx},60 ${gx + 5},66 ${gx},72 ${gx - 5},66" class="gate"/>`);
    }
    parts.push(`<text x="562" y="70" font-size="8" class="cap">db &#183; push &#183; deploy &#183; $ &#183; outward</text>`);
  }
  parts.push(`<line x1="480" y1="54" x2="480" y2="94" class="flow"/>`);
  parts.push(studioBox(studio, harness));
  // Studio -> ventures verticals
  if (harness) {
    for (const slot of slots) {
      const cx = slot.x + slot.w / 2;
      parts.push(`<polygon points="${262 + slots.indexOf(slot) * 6},212 ${278 + slots.indexOf(slot) * 6},212 ${cx + 26},${vy - 2} ${cx - 26},${vy - 2}" class="beam"/>`);
    }
    parts.push(`<text x="222" y="260" text-anchor="end" font-size="9" class="cap">harness compiled &#8595; (P4)</text>`);
  } else {
    parts.push(`<line x1="230" y1="212" x2="230" y2="${vy - 4}" class="flow"/>`);
    parts.push(`<polygon points="230,${vy - 4} 225,${vy - 14} 235,${vy - 14}" fill="#1c1b19"/>`);
    parts.push(`<text x="222" y="260" text-anchor="end" font-size="9" class="cap">harness &#8595;</text>`);
  }
  parts.push(`<line x1="740" y1="212" x2="740" y2="${vy - 4}" class="flow"/>`);
  parts.push(`<polygon points="740,${vy - 4} 735,${vy - 14} 745,${vy - 14}" fill="#1c1b19"/>`);
  parts.push(`<text x="750" y="260" font-size="9" class="cap">@nexod/* &#8595;</text>`);
  parts.push(`<line x1="850" y1="${vy - 4}" x2="850" y2="212" class="dash"/>`);
  parts.push(`<polygon points="850,212 845,222 855,222" fill="#8b877e"/>`);
  parts.push(`<text x="860" y="260" font-size="9" class="cap">learnings &#8593;</text>`);
  // Venture row + edges
  for (const slot of slots) parts.push(ventureBox(slot, vy, vh, harness, doctor));
  parts.push(consumeEdges(slots, rowBottom));
  if (harness) {
    const rowNames = new Set(slots.map((s) => s.v.name));
    const edgeCount = slots.reduce(
      (n, s) => n + s.v.manifest.interfaces.consumes.filter((e) => e.of && rowNames.has(e.of)).length,
      0,
    );
    const legendY = rowBottom + 34 + edgeCount * 22 + 26;
    const tail = doctor
      ? `&#8212; LIVE VERDICTS: lingot doctor ${doctor.date} (filled = green, red = failing)`
      : "&#8212; VERDICTS LAND AT P3 (THE DOCTOR)";
    parts.push(
      `<text x="480" y="${legendY}" text-anchor="middle" font-size="9" font-weight="700">A&#183;T&#183;L&#183;Q&#183;L = AUTHORITY &#183; TRUTH &#183; LABOR &#183; QUALITY &#183; LEARNING ${tail}</text>`,
    );
  }
  return parts.join("\n    ");
}

function straysStrip(registry: Registry, y: number): string {
  const parts: string[] = [];
  parts.push(`<line x1="40" y1="${y - 14}" x2="${W - 40}" y2="${y - 14}" class="dash"/>`);
  parts.push(`<text x="40" y="${y + 2}" font-size="9.5" font-weight="700">STRAYS &#183; TRIAGE (Felix-gated -- nothing moves before approval)</text>`);
  registry.strays.forEach((s, i) => {
    const ty = y + 18 + i * 13;
    const wt = s.worktree ? ` [worktree of ${s.worktree.of} @ ${s.worktree.branch}]` : "";
    const t = s.triage ? `&#8594; ${s.triage.proposal} (${s.triage.status})` : "&#8594; UNTRIAGED";
    parts.push(
      `<text x="52" y="${ty}" font-size="8.5" class="cap">${esc(s.relpath.padEnd(38, " "))} ${esc(s.classification)}${esc(wt)} ${t}</text>`,
    );
  });
  const channels = registry.ventures.filter((v) => v.kind === "channel");
  const personal = registry.ventures.filter((v) => v.kind === "personal");
  const cy = y + 18 + registry.strays.length * 13 + 8;
  const bits: string[] = [];
  if (channels.length > 0) bits.push(`channels: ${channels.map((c) => esc(c.name)).join(" &#183; ")} &#8212; handoffs only`);
  if (personal.length > 0) bits.push(`personal plane: ${personal.map((p) => esc(p.name)).join(" &#183; ")}`);
  if (bits.length > 0) {
    parts.push(
      `<text x="52" y="${cy}" font-size="8.5" class="cap">${bits.join(" &#183;&#183; ")} &#8212; ventures never reach into each other</text>`,
    );
  }
  return parts.join("\n    ");
}

export function renderMap(registry: Registry, doctorReport?: DoctorReport): string {
  const doctor: DoctorView | undefined = doctorReport
    ? { date: doctorReport.generated.slice(0, 10), byVenture: new Map(doctorReport.ventures.map((v) => [v.name, v])) }
    : undefined;
  const rowVentures = registry.ventures.filter((v) => v.kind === "venture");
  const rowNames = new Set(rowVentures.map((v) => v.name));
  const edgeCount = rowVentures.reduce(
    (n, v) => n + v.manifest.interfaces.consumes.filter((e) => e.of && rowNames.has(e.of)).length,
    0,
  );
  // The harness pass is the tallest content: venture row bottom (500) + edge stack + legend + margin.
  const straysY = Math.max(640, 500 + 34 + edgeCount * 22 + 26 + 34);
  const height = straysY + 18 + registry.strays.length * 13 + 60;
  const generated = registry.generated.slice(0, 16).replace("T", " ");
  const verdictColor = registry.verdict === "green" ? "#1c1b19" : "#8a1f1f";
  const doctorBadge = doctorReport
    ? ` &middot; doctor: <span style="color:${doctorReport.verdict === "green" ? "#1c1b19" : "#8a1f1f"}; font-weight:700">${doctorReport.verdict.toUpperCase()}</span> (${doctorReport.totals.reds} red)`
    : "";
  return `<title>Nexod &middot; Org Map (generated)</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { background: #f6f4ef; color: #1c1b19; font-family: ui-monospace, "SF Mono", Menlo, monospace; }
  .wrap { max-width: 1100px; margin: 0 auto; padding: 26px 20px 40px; }
  .hdr { display: flex; justify-content: space-between; align-items: baseline; gap: 16px;
    border-bottom: 2px solid #1c1b19; padding-bottom: 10px; margin-bottom: 14px; flex-wrap: wrap; }
  .hdr .t { font-size: 13px; letter-spacing: .16em; font-weight: 700; }
  .hdr .d { font-size: 10.5px; letter-spacing: .1em; color: #8b877e; }
  .passes { display: flex; }
  .passes button { font-family: inherit; font-size: 10.5px; letter-spacing: .12em; font-weight: 600;
    padding: 6px 14px; background: #f6f4ef; border: 1px solid #1c1b19; cursor: pointer; color: #1c1b19; }
  .passes button + button { border-left: none; }
  .passes button.on { background: #1c1b19; color: #f6f4ef; }
  svg text { font-family: ui-monospace, "SF Mono", Menlo, monospace; fill: #1c1b19; }
  svg .cap { fill: #8b877e; }
  svg .box { fill: #fbfaf6; stroke: #1c1b19; stroke-width: 1.5; }
  svg .soft { fill: #f0ede6; stroke: #a8a399; stroke-width: 1; }
  svg .inner { fill: #f6f4ef; stroke: #8b877e; stroke-width: 1; }
  svg .flow { stroke: #1c1b19; stroke-width: 1.5; fill: none; }
  svg .dash { stroke: #8b877e; stroke-width: 1.2; fill: none; stroke-dasharray: 5 4; }
  svg .beam { fill: #e7e2d6; opacity: .65; }
  svg .gate { fill: #1c1b19; }
  svg .obar { fill: none; stroke: #1c1b19; stroke-width: 1; }
  svg .chip { fill: #f6f4ef; stroke: #1c1b19; stroke-width: 1; }
  svg .rsq  { fill: none; stroke: #57544e; stroke-width: 1; }
  svg .sqok { fill: #1c1b19; stroke: #1c1b19; stroke-width: 1; }
  svg .sqred { fill: #8a1f1f; stroke: #8a1f1f; stroke-width: 1; }
  .hidden { display: none; }
</style>

<div class="wrap">
  <div class="hdr">
    <span class="t">NEXOD &middot; ORG MAP &middot; GENERATED</span>
    <div class="passes">
      <button id="b-base" class="on" onclick="setPass(false)">BASE</button>
      <button id="b-har" onclick="setPass(true)">HARNESS PASS</button>
    </div>
    <span class="d">${generated} &middot; lingot map v0 &middot; sweep: <span style="color:${verdictColor}; font-weight:700">${registry.verdict.toUpperCase()}</span>${doctorBadge}</span>
  </div>

  <svg viewBox="0 0 ${W} ${height}" width="100%" role="img" aria-label="Nexod org map, generated from the venture registry">
  <g id="render-base">
    ${pass(registry, false, doctor)}
  </g>
  <g id="render-harness" class="hidden">
    ${pass(registry, true, doctor)}
  </g>
  <g>
    ${straysStrip(registry, straysY)}
    <text x="480" y="${height - 22}" text-anchor="middle" font-size="10.5" font-weight="700">own repo &middot; own DB &middot; own fleet &middot; same engine</text>
    <text x="480" y="${height - 8}" text-anchor="middle" font-size="8.5" class="cap">generated from registry.json${doctorReport ? " + doctor.json" : ""} by lingot map &middot; the org chart is the harness's own dashboard</text>
  </g>
  </svg>
</div>

<script>
  function setPass(harness) {
    document.getElementById('render-harness').classList.toggle('hidden', !harness);
    document.getElementById('render-base').classList.toggle('hidden', harness);
    document.getElementById('b-har').classList.toggle('on', harness);
    document.getElementById('b-base').classList.toggle('on', !harness);
  }
</script>
`;
}
