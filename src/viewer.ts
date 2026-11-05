import { selectScope } from './diagram.js';
import type { DiagramOpts } from './diagram.js';
import { G } from './graph.js';
import { pickWorkflows, workflowCard, workflowLinks } from './overview.js';
import { explain } from './queries.js';
import type { EdgeKind } from './types.js';

const KINDS: EdgeKind[] = ['main', 'capability', 'reads', 'calls', 'on_error', 'webhook_calls', 'responds_via'];

export interface ViewPayload {
  title: string;
  focus?: string;
  workflows: Record<string, string>;
  nodes: Array<{
    id: string; wf: string; name: string; type: string; summary: string;
    trigger: boolean; disabled: boolean; group?: string; card: string; kind?: 'workflow';
  }>;
  edges: Array<{ from: string; to: string; kind: EdgeKind; label?: string; fields?: string[]; confidence: string }>;
}

/** One node per workflow, one edge per kind of call between them. */
export function collapsedPayload(g: G, o: DiagramOpts): ViewPayload {
  if (o.focus) throw new Error('--collapse cannot be combined with --focus.');
  const wfs = pickWorkflows(g, o);
  const all = workflowLinks(g);
  return {
    title: `flownav · ${wfs.length} workflow(s) overview`,
    workflows: { overview: 'Workflow overview' },
    nodes: wfs.map((id) => {
      const w = g.g.workflows[id];
      return {
        id: `wf:${id}`, wf: 'overview', name: w.name, type: `${w.nodeCount} nodes`, summary: `${w.nodeCount} nodes`,
        trigger: false, disabled: w.active === false, card: workflowCard(g, id, all), kind: 'workflow' as const,
      };
    }),
    edges: workflowLinks(g, wfs).map((l) => ({
      from: `wf:${l.from}`, to: `wf:${l.to}`, kind: l.kind, label: l.count > 1 ? `${l.count}×` : undefined, confidence: 'EXTRACTED',
    })),
  };
}

export function viewPayload(g: G, o: DiagramOpts = {}): ViewPayload {
  if (o.collapse) return collapsedPayload(g, o);
  const ids = selectScope(g, o, KINDS);
  const nodes = [...ids].map((id) => g.nodeById.get(id)).filter((n): n is NonNullable<typeof n> => !!n);
  const keep = new Set(nodes.map((n) => n.id));
  const wfs: Record<string, string> = {};
  for (const n of nodes) wfs[n.wf] = g.g.workflows[n.wf]?.name ?? n.wf;
  return {
    title: `flownav · ${Object.keys(wfs).length} workflow(s) · ${nodes.length} node(s)`,
    focus: o.focus ? g.resolveNode(o.focus).id : undefined,
    workflows: wfs,
    nodes: nodes.map((n) => ({
      id: n.id, wf: n.wf, name: n.name, type: n.type, summary: n.summary,
      trigger: n.trigger, disabled: n.disabled, group: n.group, card: explain(g, n.id).text,
    })),
    edges: g.g.edges
      .filter((e) => KINDS.includes(e.kind) && keep.has(e.from) && keep.has(e.to) && e.from !== e.to)
      .map((e) => ({ from: e.from, to: e.to, kind: e.kind, label: e.label, fields: e.fields, confidence: e.confidence })),
  };
}

/** Self-contained HTML (no network access). Data is embedded as JSON and rendered with textContent only. */
export function viewHtml(g: G, o: DiagramOpts = {}): { html: string; nodes: number } {
  const p = viewPayload(g, o);
  const json = JSON.stringify(p).replace(/</g, '\\u003c');
  return { html: TEMPLATE.replace('__DATA__', () => json), nodes: p.nodes.length };
}

const TEMPLATE = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>flownav graph</title>
<style>
:root{--bg:#fafafa;--panel:#fff;--fg:#1f2328;--muted:#656d76;--line:#d0d7de;--accent:#0969da;--cluster:#f1f3f5;--edge:#8c959f;
--n-default:#fff;--n-trigger:#ddf4ff;--n-logic:#fff3bf;--n-code:#f3e8ff;--n-http:#d8f5e0;--n-ai:#ffe0dd;--n-call:#ffe4c7}
@media (prefers-color-scheme:dark){:root{--bg:#0d1117;--panel:#161b22;--fg:#e6edf3;--muted:#8b949e;--line:#30363d;--accent:#58a6ff;--cluster:#11161d;--edge:#6e7681;
--n-default:#1c2128;--n-trigger:#0c2d4a;--n-logic:#3b2f00;--n-code:#2d1b3d;--n-http:#0f3320;--n-ai:#4a1a1a;--n-call:#4a2a0a}}
*{box-sizing:border-box}
html,body{height:100%;margin:0}
body{background:var(--bg);color:var(--fg);font:14px/1.4 system-ui,-apple-system,"Segoe UI",sans-serif;display:grid;grid-template-rows:auto 1fr}
header{display:flex;flex-wrap:wrap;gap:8px 14px;align-items:center;padding:8px 16px;border-bottom:1px solid var(--line);background:var(--panel)}
header strong{font-weight:600}
input,select,button{font:inherit;color:var(--fg);background:var(--bg);border:1px solid var(--line);border-radius:6px;padding:4px 8px}
button{cursor:pointer}
label.k{display:inline-flex;gap:4px;align-items:center;color:var(--muted);font-size:13px}
main{display:grid;grid-template-columns:1fr 360px;min-height:0}
svg{width:100%;height:100%;display:block;cursor:grab;touch-action:none}
svg.drag{cursor:grabbing}
aside{border-left:1px solid var(--line);background:var(--panel);padding:12px 16px;overflow:auto;min-width:0}
aside h2{font-size:15px;margin:0 0 4px}
aside pre{white-space:pre-wrap;word-break:break-word;font:12px/1.5 ui-monospace,Consolas,monospace;background:var(--bg);border:1px solid var(--line);border-radius:6px;padding:8px}
aside .muted{color:var(--muted)}
aside ul{list-style:none;padding:0;margin:6px 0}
aside li button{width:100%;text-align:left;margin:2px 0;border-radius:6px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cluster{fill:var(--cluster);stroke:var(--line)}
.ctitle{fill:var(--muted);font-size:13px;font-weight:600}
.node rect{stroke:var(--line);stroke-width:1.2;fill:var(--n-default);rx:7}
.node.trigger rect{fill:var(--n-trigger);rx:18}
.node.logic rect{fill:var(--n-logic)}
.node.code rect{fill:var(--n-code)}
.node.http rect{fill:var(--n-http)}
.node.ai rect{fill:var(--n-ai)}
.node.call rect{fill:var(--n-call)}
.node.disabled{opacity:.5}
.node.disabled rect{stroke-dasharray:4 3}
.node{cursor:pointer}
.node:focus{outline:none}
.node:focus rect,.node.sel rect{stroke:var(--accent);stroke-width:2.5}
.node.hit rect{stroke:#e5534b;stroke-width:2.5}
.nt{fill:var(--fg);font-size:12.5px;font-weight:600;pointer-events:none}
.ns{fill:var(--muted);font-size:10.5px;pointer-events:none}
.e{fill:none;stroke:var(--edge);stroke-width:1.4}
.k-reads{stroke-dasharray:5 4;opacity:.75}
.k-capability{stroke-dasharray:2 3}
.k-responds_via{stroke-dasharray:1 4}
.k-calls,.k-on_error,.k-webhook_calls{stroke:var(--accent);stroke-width:2.6}
.el{fill:var(--muted);font-size:10.5px;text-anchor:middle;paint-order:stroke;stroke:var(--cluster);stroke-width:3px;pointer-events:none}
.dim{opacity:.1}
.node.dim{opacity:.12}
@media (max-width:800px){main{grid-template-columns:1fr;grid-template-rows:1fr 40%}aside{border-left:0;border-top:1px solid var(--line)}}
</style>
</head>
<body>
<header>
  <strong id="title"></strong>
  <input id="q" type="search" placeholder="Search nodes (Enter to jump)" size="26">
  <select id="wf" aria-label="Workflow"></select>
  <span id="kinds"></span>
  <button id="fit" type="button">Fit</button>
</header>
<main>
  <svg id="svg" role="img" aria-label="Workflow graph">
    <defs><marker id="ah" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="context-stroke"/></marker></defs>
    <g id="vp"></g>
  </svg>
  <aside id="panel"></aside>
</main>
<script id="data" type="application/json">__DATA__</script>
<script>
(function () {
  var D = JSON.parse(document.getElementById('data').textContent);
  var NS = 'http://www.w3.org/2000/svg';
  var NW = 176, NH = 38, COLW = 250, ROWH = 62, PAD = 36, HEAD = 34, GAP = 50;
  var LAYER = { main: 1, capability: 1, calls: 1, on_error: 1, webhook_calls: 1 };
  var svg = document.getElementById('svg'), vp = document.getElementById('vp'), panel = document.getElementById('panel');

  function el(tag, attrs, parent, text) {
    var e = document.createElementNS(NS, tag);
    for (var k in attrs) e.setAttribute(k, attrs[k]);
    if (text != null) e.textContent = text;
    if (parent) parent.appendChild(e);
    return e;
  }
  function h(tag, text, parent, cls) {
    var e = document.createElement(tag);
    if (text != null) e.textContent = text;
    if (cls) e.className = cls;
    if (parent) parent.appendChild(e);
    return e;
  }
  function clip(s, n) { return s.length > n ? s.slice(0, n - 1) + '…' : s; }
  function shortType(t) { return t.split('.').pop(); }

  document.getElementById('title').textContent = D.title;
  var byId = {};
  D.nodes.forEach(function (n) { byId[n.id] = n; });

  function category(n) {
    var t = shortType(n.type);
    if (n.kind === 'workflow') return 'call';
    if (n.trigger) return 'trigger';
    if (/langchain/.test(n.type)) return 'ai';
    if (['if', 'switch', 'merge', 'splitInBatches', 'filter', 'wait', 'noOp'].indexOf(t) >= 0) return 'logic';
    if (/^(code|function|functionItem)$/.test(t)) return 'code';
    if (t === 'httpRequest' || t === 'respondToWebhook') return 'http';
    if (t === 'executeWorkflow') return 'call';
    return 'default';
  }

  /* ---------- layered layout, one block per workflow ---------- */
  function layoutWorkflow(ns) {
    var inn = {}, out = {}, ids = {};
    ns.forEach(function (n) { inn[n.id] = []; out[n.id] = []; ids[n.id] = 1; });
    D.edges.forEach(function (e) {
      if (LAYER[e.kind] && ids[e.from] && ids[e.to]) { out[e.from].push(e.to); inn[e.to].push(e.from); }
    });
    var state = {}, back = {};
    function dfs(u) {
      state[u] = 1;
      out[u].forEach(function (v) {
        if (state[v] === 1) back[u + '>' + v] = 1;
        else if (!state[v]) dfs(v);
      });
      state[u] = 2;
    }
    ns.slice().sort(function (a, b) { return (b.trigger ? 1 : 0) - (a.trigger ? 1 : 0); })
      .forEach(function (n) { if (!state[n.id]) dfs(n.id); });
    var layer = {};
    function L(u) {
      if (layer[u] != null) return layer[u];
      layer[u] = 0;
      var m = 0;
      inn[u].forEach(function (p) { if (!back[p + '>' + u]) m = Math.max(m, L(p) + 1); });
      layer[u] = m;
      return m;
    }
    var layers = [];
    ns.forEach(function (n) { var l = L(n.id); (layers[l] = layers[l] || []).push(n.id); });
    var idx = {};
    function reindex() { layers.forEach(function (arr) { arr.forEach(function (id, i) { idx[id] = i; }); }); }
    function sortLayer(l, nb) {
      var key = {};
      layers[l].forEach(function (id) {
        var s = 0, c = 0;
        nb[id].forEach(function (p) { s += idx[p]; c++; });
        key[id] = c ? s / c : idx[id];
      });
      layers[l].sort(function (a, b) { return key[a] - key[b]; });
      reindex();
    }
    reindex();
    for (var it = 0; it < 4; it++) {
      for (var l = 1; l < layers.length; l++) sortLayer(l, inn);
      for (l = layers.length - 2; l >= 0; l--) sortLayer(l, out);
    }
    var maxLen = 0;
    layers.forEach(function (a) { maxLen = Math.max(maxLen, a.length); });
    var pos = {};
    layers.forEach(function (arr, li) {
      var off = (maxLen - arr.length) * ROWH / 2;
      arr.forEach(function (id, i) { pos[id] = { x: PAD + li * COLW, y: HEAD + PAD / 2 + off + i * ROWH }; });
    });
    return { pos: pos, w: PAD * 2 + (layers.length - 1) * COLW + NW, h: HEAD + PAD + maxLen * ROWH };
  }

  var wfIds = Object.keys(D.workflows).sort(function (a, b) { return D.workflows[a].localeCompare(D.workflows[b]); });
  var pos = {}, clusters = {}, y0 = 0, maxW = 0;
  wfIds.forEach(function (wf) {
    var ns = D.nodes.filter(function (n) { return n.wf === wf; });
    var lay = layoutWorkflow(ns);
    clusters[wf] = { y: y0, w: lay.w, h: lay.h };
    ns.forEach(function (n) { pos[n.id] = { x: lay.pos[n.id].x, y: lay.pos[n.id].y + y0 }; });
    y0 += lay.h + GAP;
    maxW = Math.max(maxW, lay.w);
  });

  /* ---------- draw ---------- */
  var gClusters = el('g', {}, vp), gEdges = el('g', {}, vp), gNodes = el('g', {}, vp);
  var clusterEls = {};
  wfIds.forEach(function (wf) {
    var c = clusters[wf], g = el('g', {}, gClusters);
    el('rect', { 'class': 'cluster', x: 0, y: c.y, width: c.w, height: c.h, rx: 12 }, g);
    el('text', { 'class': 'ctitle', x: 14, y: c.y + 22 }, g, D.workflows[wf]);
    clusterEls[wf] = g;
  });

  var edgeEls = D.edges.map(function (e) {
    var s = pos[e.from], t = pos[e.to];
    var sx = s.x + NW, sy = s.y + NH / 2, tx = t.x, ty = t.y + NH / 2, d, mx, my;
    if (tx > sx + 8) {
      var dx = Math.max(50, (tx - sx) / 2);
      d = 'M' + sx + ',' + sy + ' C' + (sx + dx) + ',' + sy + ' ' + (tx - dx) + ',' + ty + ' ' + tx + ',' + ty;
      mx = (sx + 3 * (sx + dx) + 3 * (tx - dx) + tx) / 8; my = (sy + 3 * sy + 3 * ty + ty) / 8;
    } else {
      d = 'M' + sx + ',' + sy + ' C' + (sx + 90) + ',' + (sy + 70) + ' ' + (tx - 90) + ',' + (ty + 70) + ' ' + tx + ',' + ty;
      mx = (sx + 3 * (sx + 90) + 3 * (tx - 90) + tx) / 8; my = (sy + 3 * (sy + 70) + 3 * (ty + 70) + ty) / 8;
    }
    var g = el('g', {}, gEdges);
    var p = el('path', { 'class': 'e k-' + e.kind, d: d, 'marker-end': 'url(#ah)' }, g);
    var tip = e.kind + (e.label ? ':' + e.label : '') + (e.fields && e.fields.length ? ' {' + e.fields.join(', ') + '}' : '') + ' [' + e.confidence + ']';
    el('title', {}, p, tip);
    var lab = null;
    if (e.label && e.kind !== 'reads' && e.kind !== 'capability') lab = el('text', { 'class': 'el', x: mx, y: my - 4 }, g, e.label);
    return { e: e, g: g };
  });

  var nodeEls = {};
  D.nodes.forEach(function (n) {
    var p = pos[n.id];
    var g = el('g', { 'class': 'node ' + category(n) + (n.disabled ? ' disabled' : ''), transform: 'translate(' + p.x + ',' + p.y + ')', tabindex: 0, role: 'button' }, gNodes);
    el('rect', { width: NW, height: NH }, g);
    el('text', { 'class': 'nt', x: 10, y: 16 }, g, clip(n.name, 24));
    el('text', { 'class': 'ns', x: 10, y: 30 }, g, clip(shortType(n.type), 28));
    el('title', {}, g, n.name + ' - ' + n.summary);
    g.addEventListener('pointerdown', function (ev) { ev.stopPropagation(); });
    g.addEventListener('click', function (ev) { ev.stopPropagation(); select(n.id); if (T.k < 0.5) centerOn(n.id); });
    g.addEventListener('keydown', function (ev) { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); select(n.id); } });
    nodeEls[n.id] = g;
  });

  /* ---------- controls ---------- */
  var kindOn = { responds_via: false }, wfSel = '', query = '', selected = null;
  var counts = {};
  D.edges.forEach(function (e) { counts[e.kind] = (counts[e.kind] || 0) + 1; });
  var kindsBox = document.getElementById('kinds');
  Object.keys(counts).forEach(function (k) {
    if (kindOn[k] === undefined) kindOn[k] = true;
    var lab = h('label', null, kindsBox, 'k'), cb = h('input', null, lab);
    cb.type = 'checkbox'; cb.checked = kindOn[k];
    cb.addEventListener('change', function () { kindOn[k] = cb.checked; refresh(); });
    lab.appendChild(document.createTextNode(k + ' (' + counts[k] + ')'));
  });
  var wfSelect = document.getElementById('wf');
  h('option', 'All workflows', wfSelect).value = '';
  wfIds.forEach(function (id) { h('option', D.workflows[id], wfSelect).value = id; });
  if (wfIds.length < 2) wfSelect.style.display = 'none';
  wfSelect.addEventListener('change', function () { wfSel = wfSelect.value; refresh(); fit(); });

  function nodeVisible(n) { return !wfSel || n.wf === wfSel; }
  function related(id) {
    var s = {}; s[id] = 1;
    D.edges.forEach(function (e) {
      if (!kindOn[e.kind]) return;
      if (e.from === id) s[e.to] = 1;
      if (e.to === id) s[e.from] = 1;
    });
    return s;
  }
  function hits() {
    if (!query) return null;
    var q = query.toLowerCase(), s = {};
    D.nodes.forEach(function (n) {
      if ((n.name + ' ' + n.type + ' ' + n.summary).toLowerCase().indexOf(q) >= 0) s[n.id] = 1;
    });
    return s;
  }
  function refresh() {
    var rel = selected ? related(selected) : null, hit = hits();
    wfIds.forEach(function (wf) { clusterEls[wf].style.display = !wfSel || wf === wfSel ? '' : 'none'; });
    D.nodes.forEach(function (n) {
      var g = nodeEls[n.id];
      g.style.display = nodeVisible(n) ? '' : 'none';
      var dim = (rel && !rel[n.id]) || (hit && !hit[n.id]);
      g.classList.toggle('dim', !!dim);
      g.classList.toggle('sel', n.id === selected);
      g.classList.toggle('hit', !!(hit && hit[n.id]));
    });
    edgeEls.forEach(function (x) {
      var e = x.e, vis = kindOn[e.kind] && nodeVisible(byId[e.from]) && nodeVisible(byId[e.to]);
      x.g.style.display = vis ? '' : 'none';
      var dim = (selected && e.from !== selected && e.to !== selected) || (hit && !(hit[e.from] || hit[e.to]));
      x.g.classList.toggle('dim', !!dim);
    });
  }

  /* ---------- pan / zoom ---------- */
  var T = { x: 0, y: 0, k: 1 };
  function apply() { vp.setAttribute('transform', 'translate(' + T.x + ',' + T.y + ') scale(' + T.k + ')'); }
  function fit() {
    var r = svg.getBoundingClientRect(), b = vp.getBBox();
    if (!b.width) return;
    T.k = Math.min(r.width / (b.width + 80), r.height / (b.height + 80), 1.2);
    T.x = (r.width - b.width * T.k) / 2 - b.x * T.k;
    T.y = (r.height - b.height * T.k) / 2 - b.y * T.k;
    apply();
  }
  function centerOn(id) {
    var r = svg.getBoundingClientRect(), p = pos[id];
    if (!p) return;
    T.k = Math.max(T.k, 0.8);
    T.x = r.width / 2 - (p.x + NW / 2) * T.k;
    T.y = r.height / 2 - (p.y + NH / 2) * T.k;
    apply();
  }
  svg.addEventListener('wheel', function (ev) {
    ev.preventDefault();
    var r = svg.getBoundingClientRect(), mx = ev.clientX - r.left, my = ev.clientY - r.top;
    var k2 = Math.min(3, Math.max(0.05, T.k * Math.exp(-ev.deltaY * 0.0015)));
    T.x = mx - (mx - T.x) * (k2 / T.k); T.y = my - (my - T.y) * (k2 / T.k); T.k = k2;
    apply();
  }, { passive: false });
  var drag = null, moved = false;
  svg.addEventListener('pointerdown', function (ev) {
    drag = { x: ev.clientX, y: ev.clientY, tx: T.x, ty: T.y }; moved = false;
    svg.setPointerCapture(ev.pointerId); svg.classList.add('drag');
  });
  svg.addEventListener('pointermove', function (ev) {
    if (!drag) return;
    var dx = ev.clientX - drag.x, dy = ev.clientY - drag.y;
    if (Math.abs(dx) + Math.abs(dy) > 3) moved = true;
    T.x = drag.tx + dx; T.y = drag.ty + dy; apply();
  });
  svg.addEventListener('pointerup', function () {
    svg.classList.remove('drag');
    if (drag && !moved) select(null);
    drag = null;
  });

  /* ---------- side panel ---------- */
  function select(id) {
    selected = id;
    refresh();
    panel.textContent = '';
    if (!id) { help(); return; }
    var n = byId[id];
    h('h2', n.name, panel);
    h('div', (D.workflows[n.wf] || n.wf) + (n.group ? ' · group: ' + n.group : ''), panel, 'muted');
    h('pre', n.card, panel);
    h('h2', 'Connections', panel);
    var ul = h('ul', null, panel), any = false;
    D.edges.forEach(function (e) {
      if (!kindOn[e.kind] || (e.from !== id && e.to !== id)) return;
      any = true;
      var out = e.from === id, other = out ? e.to : e.from;
      var b = h('button', (out ? '→ ' : '← ') + byId[other].name + '  · ' + e.kind + (e.label ? ':' + e.label : ''), h('li', null, ul));
      b.type = 'button';
      b.addEventListener('click', function () { select(other); centerOn(other); });
    });
    if (!any) h('li', 'none (with the edge kinds currently shown)', ul, 'muted');
  }
  function help() {
    h('h2', 'How to read this', panel);
    [
      'Click a node for its card and connections; click empty space to clear.',
      'Drag to pan, scroll to zoom, Fit to reset. Search dims non-matching nodes.',
      'Solid: main connection (labels such as true/false/loop). Dotted: AI sub-node. Dashed: expression read. Thick blue: cross-workflow call, error workflow or webhook call.',
      'Untick edge kinds in the header to declutter.'
    ].forEach(function (t) { h('p', t, panel, 'muted'); });
  }

  document.getElementById('fit').addEventListener('click', fit);
  document.getElementById('q').addEventListener('input', function (ev) { query = ev.target.value.trim(); refresh(); });
  document.getElementById('q').addEventListener('keydown', function (ev) {
    if (ev.key !== 'Enter') return;
    var s = hits(), first = null;
    if (s) D.nodes.forEach(function (n) { if (!first && s[n.id] && nodeVisible(n)) first = n.id; });
    if (first) { select(first); centerOn(first); }
  });
  document.addEventListener('keydown', function (ev) { if (ev.key === 'Escape') select(null); });
  window.addEventListener('resize', fit);

  refresh(); help(); fit();
  if (D.focus) { select(D.focus); centerOn(D.focus); }
})();
</script>
</body>
</html>
`;
