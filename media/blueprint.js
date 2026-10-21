/* Go Blueprint — webview canvas. */
(function () {
  'use strict';

  const vscode = typeof acquireVsCodeApi === 'function'
    ? acquireVsCodeApi()
    : { postMessage() {}, getState() { return null; }, setState() {} };
  const elk = new ELK();

  const KINDS = ['calls', 'ref', 'implements', 'embeds', 'uses', 'dispatch', 'grpc'];
  const KIND_LABEL = { calls: 'calls', ref: 'func refs', implements: 'implements', embeds: 'embeds', uses: 'field types', dispatch: 'iface → impl', grpc: 'gRPC / proto' };
  const KIND_COLOR = {
    calls: '#e9e9e9', ref: '#9aa4ad', implements: '#47d17c', embeds: '#4ea4ff', uses: '#f2b84b', dispatch: '#d07de8', grpc: '#3fd5e6',
  };
  const KIND_FILL = { struct: '#1d5aa6', interface: '#23824a', type: '#6f45a8', func: '#a8561a', service: '#0e7c86', message: '#9a3a76',
    method: '#34557d', imethod: '#2f6a4a', rpc: '#0e6a73' };
  const EXPLODABLE = new Set(['struct', 'interface', 'type']); // types whose methods can be pulled out
  const CARD_KINDS = new Set(['struct', 'interface', 'type', 'func', 'service', 'message']);
  const KIND_ICON = { struct: 'S', interface: 'I', type: 'T', func: 'ƒ', method: 'M', imethod: 'M', service: 'G', message: 'P', rpc: 'R' };
  const STREAM_BADGE = { server: 'stream →', client: '→ stream', bidi: '⇄ stream' };
  const GRPC_LABELS = new Set(['request', 'response', 'stream', 'serves', 'builds', 'client']);
  const FRAME_PAD = { top: 52, left: 24, right: 24, bottom: 24 };

  // Relations to hidden cards, shown as "reveal" chips at the bottom of a card.
  const RELS = [
    { key: 'callers', label: '← callers', dir: 'in', kinds: ['calls', 'ref'] },
    { key: 'callees', label: 'calls →', dir: 'out', kinds: ['calls', 'ref'] },
    { key: 'impls', label: '← implemented by', dir: 'in', kinds: ['implements'] },
    { key: 'ifaces', label: 'implements →', dir: 'out', kinds: ['implements'] },
    { key: 'users', label: '← used by', dir: 'in', kinds: ['uses', 'embeds'] },
    { key: 'deps', label: 'uses →', dir: 'out', kinds: ['uses', 'embeds'] },
    { key: 'dispIn', label: '← interface', dir: 'in', kinds: ['dispatch'] },
    { key: 'dispOut', label: 'impls →', dir: 'out', kinds: ['dispatch'] },
    { key: 'grpcIn', label: '← gRPC', dir: 'in', kinds: ['grpc'] },
    { key: 'grpcOut', label: 'gRPC →', dir: 'out', kinds: ['grpc'] },
  ];
  const REL_OF = {};
  for (const r of RELS) for (const k of r.kinds) REL_OF[k + ':' + r.dir] = r.key;

  // ------------------------------------------------------------------ state

  const saved = vscode.getState() || {};
  const DEFAULT_KINDS = { calls: true, ref: true, implements: true, embeds: true, uses: true, dispatch: false, grpc: true };
  const S = Object.assign({
    edgeKinds: { ...DEFAULT_KINDS },
    hiddenPkgs: [],
    collapsedPkgs: [], // package layers shown as one miniature card
    exploded: [],      // types whose methods are shown as separate cards
    retOpen: [],       // funcs / methods whose return types are expanded
    hiddenCards: [],
    extra: [],         // cards revealed on top of the filters / focus
    revealedBy: {},    // card id -> { rel key -> ids it revealed } (for collapsing them back)
    open: [],          // endpoints with an open info dropdown
    showFields: true,
    showPrivate: true,
    showDocs: false,
    compact: false,
    groupByPkg: true,
    depth: 2,
    dir: 'both',
    focus: null,       // { id, depth? }
    history: [],       // previous focus ids
    sidebar: true,
    vertical: false,   // "режим Леня": top-down layout
    sidebarW: 240,     // px, resizable
    sidebarFont: 12,   // px
    initialized: false,
  }, saved.settings || {});
  S.edgeKinds = { ...DEFAULT_KINDS, ...S.edgeKinds }; // kinds added in newer versions
  let view = saved.view || { x: 40, y: 40, k: 0.8 };

  let G = null;                 // graph from the analyzer
  const byId = new Map();       // node id -> node
  const membersOf = new Map();  // card id -> member nodes
  const outIdx = new Map();     // node id -> edges from it
  const inIdx = new Map();      // node id -> edges to it
  let cardsAll = [];
  let pkgInfo = new Map();      // pkg path -> { path, short, color, count }

  let visible = { cards: [], edges: [], vis: new Set(), reached: null, hiddenRel: new Map() };
  // Card positions are kept per view (full graph / each focus) and per mode
  // (top-down or not, grouped or not), so arrangements survive switching.
  const posMaps = new Map();    // ctx -> Map(card id -> {x, y})
  for (const [k, obj] of Object.entries(saved.layouts || {})) {
    posMaps.set(k, new Map(Object.entries(obj).map(([id, [x, y]]) => [id, { x, y }])));
  }
  let pos = new Map();          // the current view's map
  const meas = new Map();       // card id -> {w, h, hdrY, rows: Map(ep -> y), list: [row draw info]}
  const cardEls = new Map();    // card id -> element
  let wires = [];               // {e, a, b, g, path, hit, q, bb}
  const wiresByCard = new Map();
  let lastVisKey = '';
  let frameBoxes = [];          // package frames in world coords (for canvas + hit tests)
  let linkedCards = new Set();  // cards at the other end of highlighted wires
  let selection = null;         // { card, ep } — ep null when the header is selected
  let searchQ = '';
  const srcCache = new Map();
  let cfgPaths = { protoPaths: [], extraPackages: [] }; // from the extension settings
  const layerSnaps = new Map(); // pkg -> { rects, wires, origin } captured when a layer is collapsed   // "file:line-end" -> { text, start, total } | { error }

  // render mode
  let lod = false;              // true = canvas renderer instead of DOM
  const LOD_K = 0.55;           // below this zoom the canvas renderer is used
  let moving = false;           // a pan/zoom gesture is in progress
  let zooming = false;          // ...and it changes the scale
  let moveTimer = 0;
  let scene = null;             // cached bitmap of the scene used while moving
  let drag = null;              // { mode: 'pan'|'card'|'frame', ... }

  let saveTimer = null;
  function serializeLayouts() {
    const out = {};
    for (const [k, m] of [...posMaps].slice(-8)) { // the most recently used views
      const o = {};
      for (const [id, p] of m) o[id] = [Math.round(p.x), Math.round(p.y)];
      out[k] = o;
    }
    return out;
  }

  function ctxKey() {
    return (S.focus ? 'focus:' + S.focus.id : 'full') + '|' + (S.vertical ? 'v' : 'h') + (S.groupByPkg ? 'g' : 'n');
  }

  function useCtx() {
    const k = ctxKey();
    let m = posMaps.get(k);
    if (!m) m = new Map();
    posMaps.delete(k);
    posMaps.set(k, m); // most recent last
    while (posMaps.size > 12) posMaps.delete(posMaps.keys().next().value);
    pos = m;
  }

  function saveState() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => vscode.setState({ settings: S, view, layouts: serializeLayouts() }), 250);
  }

  // ------------------------------------------------------------------ DOM

  const $ = (sel, root = document) => root.querySelector(sel);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  $('#app').innerHTML = `
    <div id="toolbar">
      <div class="grp" id="search-wrap">
        <input id="search" placeholder="Search symbol…  ( / )" spellcheck="false" autocomplete="off">
        <div id="results"></div>
      </div>
      <div class="grp" id="kinds"></div>
      <div class="grp">
        <span class="lbl">Focus</span>
        <select id="dir" title="Direction">
          <option value="both">⇄ both</option>
          <option value="out">→ callees</option>
          <option value="in">← callers</option>
        </select>
        <select id="depth" title="Depth">${[1, 2, 3, 4, 5, 8].map((d) => `<option value="${d}">depth ${d}</option>`).join('')}</select>
        <button id="back" title="Back (Backspace)">◀</button>
        <button id="unfocus" title="Show everything (Esc)">✕</button>
      </div>
      <div class="grp">
        <button id="t-fields" title="Show struct fields">fields</button>
        <button id="t-private" title="Show unexported symbols">private</button>
        <button id="t-docs" title="Show doc comments">docs</button>
        <button id="t-compact" title="Headers only">compact</button>
        <button id="t-group" title="Group by package">packages</button>
        <button id="t-lenya" title="Сверху вниз">⬇ режим Леня</button>
        <button id="t-sidebar" title="Package list">☰</button>
      </div>
      <div class="grp">
        <button id="fit" title="Fit (F)">fit</button>
        <button id="relayout" title="Auto-layout again">layout</button>
        <button id="refresh" title="Re-analyze module">⟳</button>
      </div>
    </div>
    <div id="sidebar"></div>
    <div id="sbr" title="Потяните, чтобы изменить ширину панели"></div>
    <div id="viewport">
      <div id="world">
        <div id="frames"></div>
        <svg id="wires" xmlns="http://www.w3.org/2000/svg"><defs id="defs"></defs><g id="wg"></g></svg>
        <div id="cards"></div>
      </div>
      <canvas id="lod"></canvas>
      <div id="layers"></div>
      <div id="focusbar"></div>
      <canvas id="minimap" width="440" height="300"></canvas>
      <div id="help">drag: move · wheel/pinch: zoom · background drag: pan · ⓘ: code info · dbl-click: open source · right-click: menu</div>
      <div id="busy"><div class="box">Loading…</div></div>
    </div>
    <div id="status"></div>
    <div id="tooltip"></div>
    <div id="tip"></div>
    <div id="ctx"></div>`;

  const viewport = $('#viewport');
  const world = $('#world');
  const framesEl = $('#frames');
  const cardsEl = $('#cards');
  const wg = $('#wg');
  const tooltip = $('#tooltip');
  const ctx = $('#ctx');
  const busy = $('#busy');
  const minimap = $('#minimap');
  const lodCanvas = $('#lod');
  const lodCtx = lodCanvas.getContext('2d');
  const sceneCanvas = document.createElement('canvas');
  const sceneCtx = sceneCanvas.getContext('2d');

  // arrow markers per wire kind
  KIND_COLOR.member = '#8a8a8a';
  KIND_LABEL.member = 'метод типа';
  $('#defs').innerHTML = KINDS.concat(['member']).map((k) =>
    `<marker id="ar-${k}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse">
       <path d="M0,0 L10,5 L0,10 z" fill="${KIND_COLOR[k]}"/></marker>`).join('');

  // ------------------------------------------------------------------ toolbar

  $('#kinds').innerHTML = KINDS.map((k) =>
    `<span class="chip" data-k="${k}" style="--c:${KIND_COLOR[k]}"><i></i>${KIND_LABEL[k]}</span>`).join('');
  $('#kinds').addEventListener('click', (ev) => {
    const chip = ev.target.closest('.chip');
    if (!chip) return;
    const k = chip.dataset.k;
    S.edgeKinds[k] = !S.edgeKinds[k];
    syncToolbar();
    rebuild({ relayout: true });
  });

  const toggles = {
    't-fields': 'showFields',
    't-private': 'showPrivate',
    't-docs': 'showDocs',
    't-compact': 'compact',
    't-group': 'groupByPkg',
    't-lenya': 'vertical',
  };
  for (const [id, key] of Object.entries(toggles)) {
    $('#' + id).addEventListener('click', () => {
      S[key] = !S[key];
      syncToolbar();
      // view toggles keep the arrangement and zoom; mode switches (packages,
      // режим Леня) have their own arrangement, laid out the first time
      rebuild({ fit: key === 'groupByPkg' || key === 'vertical' });
    });
  }
  $('#t-sidebar').addEventListener('click', () => { S.sidebar = !S.sidebar; syncToolbar(); applyView(); });
  $('#fit').addEventListener('click', () => fitView());
  $('#relayout').addEventListener('click', () => rebuild({ reset: true, fit: true }));
  $('#refresh').addEventListener('click', () => vscode.postMessage({ type: 'refresh' }));
  $('#back').addEventListener('click', () => goBack());
  $('#unfocus').addEventListener('click', () => setFocus(null));
  $('#dir').addEventListener('change', (e) => {
    S.dir = e.target.value;
    if (S.focus) rebuild({ relayout: true, fit: true }); else saveState();
  });
  $('#depth').addEventListener('change', (e) => {
    S.depth = +e.target.value;
    if (S.focus) { delete S.focus.depth; rebuild({ relayout: true, fit: true }); } else saveState();
  });

  // sidebar width: drag the handle between the panel and the canvas
  $('#sbr').addEventListener('pointerdown', (ev) => {
    const handle = ev.currentTarget;
    handle.setPointerCapture(ev.pointerId);
    handle.classList.add('on');
    const x0 = ev.clientX, w0 = S.sidebarW;
    const move = (e) => {
      S.sidebarW = Math.max(150, Math.min(700, w0 + e.clientX - x0));
      $('#sidebar').style.width = S.sidebarW + 'px';
      scene = null;
      applyView();
    };
    const up = () => {
      handle.classList.remove('on');
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      saveState();
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
  });
  $('#sbr').addEventListener('dblclick', () => { S.sidebarW = 240; syncToolbar(); applyView(); saveState(); });

  // toolbar hints: Russian description + schematic (media/tips.js)
  const tipEl = $('#tip');
  for (const chip of document.querySelectorAll('#kinds .chip')) chip.dataset.tip = chip.dataset.k;
  for (const id of ['t-fields', 't-private', 't-docs', 't-compact', 't-group', 't-lenya', 't-sidebar', 'dir', 'depth', 'back', 'unfocus', 'fit', 'relayout', 'refresh', 'search']) {
    const el = $('#' + id);
    el.dataset.tip = id;
    el.removeAttribute('title');
  }
  let tipTimer = 0, tipFor = null;
  function showHint(el) {
    const t = (window.BP_TIPS || {})[el.dataset.tip];
    if (!t) return;
    tipFor = el;
    tipEl.innerHTML = (t.svg ? `<div class="tp-svg">${t.svg()}</div>` : '') +
      `<div class="tp-t">${esc(t.title)}</div><div class="tp-d">${esc(t.text)}</div>`;
    tipEl.style.display = 'block';
    const r = el.getBoundingClientRect();
    tipEl.style.left = Math.max(8, Math.min(r.left, window.innerWidth - tipEl.offsetWidth - 8)) + 'px';
    tipEl.style.top = (r.bottom + 6) + 'px';
  }
  function hideHint() { tipEl.style.display = 'none'; tipFor = null; }
  $('#toolbar').addEventListener('mouseover', (ev) => {
    const el = ev.target.closest('[data-tip]');
    if (el === tipFor) return;
    clearTimeout(tipTimer);
    if (!el) { hideHint(); return; }
    // once a hint is open, moving to the next control switches instantly
    tipTimer = setTimeout(() => showHint(el), tipEl.style.display === 'block' ? 0 : 350);
  });
  $('#toolbar').addEventListener('mouseleave', () => { clearTimeout(tipTimer); hideHint(); });
  $('#toolbar').addEventListener('pointerdown', () => { clearTimeout(tipTimer); hideHint(); });

  function syncToolbar() {
    for (const chip of document.querySelectorAll('#kinds .chip')) chip.classList.toggle('on', !!S.edgeKinds[chip.dataset.k]);
    for (const [id, key] of Object.entries(toggles)) $('#' + id).classList.toggle('on', !!S[key]);
    $('#t-sidebar').classList.toggle('on', S.sidebar);
    world.classList.toggle('tb', !!S.vertical);
    const sb = $('#sidebar');
    sb.classList.toggle('hidden', !S.sidebar);
    $('#sbr').classList.toggle('hidden', !S.sidebar);
    sb.style.width = S.sidebarW + 'px';
    sb.style.fontSize = S.sidebarFont + 'px';
    $('#dir').value = S.dir;
    $('#depth').value = String(S.depth);
    $('#back').disabled = S.history.length === 0;
    $('#unfocus').disabled = !S.focus;
  }

  // ------------------------------------------------------------------ model

  function shortPkg(p) {
    if (!G) return p;
    if (p === G.module) return G.module.split('/').pop();
    return p.startsWith(G.module + '/') ? p.slice(G.module.length + 1) : p;
  }

  function hashHue(s) {
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return h % 360;
  }

  function displayName(id) {
    const n = byId.get(id);
    if (!n) {
      const o = ownerOf(id);
      return o ? displayName(o) + '.' + id.slice(id.lastIndexOf('#') + 1) : id.split('/').pop();
    }
    return (n.parent && byId.has(n.parent) ? byId.get(n.parent).name + '.' : '') + n.name;
  }

  function loadGraph(graph) {
    G = graph;
    byId.clear();
    membersOf.clear();
    outIdx.clear();
    inIdx.clear();
    srcCache.clear();
    for (const n of G.nodes) byId.set(n.id, n);
    cardsAll = G.nodes.filter((n) => CARD_KINDS.has(n.kind));
    for (const n of G.nodes) {
      if (!n.parent || !byId.has(n.parent)) continue;
      if (!membersOf.has(n.parent)) membersOf.set(n.parent, []);
      membersOf.get(n.parent).push(n);
    }
    for (const list of membersOf.values()) {
      list.sort((a, b) => {
        if (a.kind === 'imethod' && b.kind === 'imethod') return a.line - b.line;
        if (a.exported !== b.exported) return a.exported ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
    }
    for (const e of G.edges) {
      if (!outIdx.has(e.from)) outIdx.set(e.from, []);
      outIdx.get(e.from).push(e);
      if (!inIdx.has(e.to)) inIdx.set(e.to, []);
      inIdx.get(e.to).push(e);
    }
    pkgInfo = new Map();
    const addPkg = (p) => {
      if (!pkgInfo.has(p)) pkgInfo.set(p, { path: p, short: shortPkg(p), color: `hsl(${hashHue(p)} 55% 55%)`, count: 0 });
    };
    for (const p of G.packages || []) addPkg(p.path);
    for (const c of cardsAll) { addPkg(c.pkg); pkgInfo.get(c.pkg).count++; }
    if (S.focus && !focusValid(S.focus.id)) S.focus = null;
    S.history = S.history.filter(focusValid);
    S.extra = S.extra.filter((id) => byId.has(id));
    pruneRevealed();
    S.open = S.open.filter((id) => byId.has(id));
    S.exploded = S.exploded.filter((id) => byId.has(id));
    S.retOpen = (S.retOpen || []).filter((id) => byId.has(id));
    explodedSet = new Set(S.exploded);
  }

  // A focus target is a node id, or "file:<path>" for the code of one file.
  const fileOf = (id) => (id && id.startsWith('file:') ? id.slice(5) : null);
  function focusValid(id) {
    const f = fileOf(id);
    return f ? G.nodes.some((n) => n.file === f) : byId.has(id);
  }

  // The card that renders an endpoint: methods live in their receiver's card,
  // "Type#field" endpoints live in the type's card.
  let explodedSet = new Set(S.exploded);
  function ownerOf(id) {
    const n = byId.get(id);
    if (n) {
      if (!n.parent) return id;
      if (!byId.has(n.parent)) return null;
      return explodedSet.has(n.parent) ? id : n.parent;
    }
    const i = id.lastIndexOf('#');
    if (i > 0 && byId.has(id.slice(0, i))) return id.slice(0, i);
    return null;
  }

  // Wire endpoints as rendered: struct-field edges start at the field row.
  function edgeFrom(e) {
    if (!e.label) return e.from;
    if (e.kind === 'uses' || e.kind === 'embeds') return e.from + '#' + e.label;
    // nested protobuf message: wire starts at the message field
    if (e.kind === 'grpc' && !GRPC_LABELS.has(e.label)) return e.from + '#' + e.label;
    return e.from;
  }

  function cardPassesFilters(c) {
    if (S.hiddenCards.includes(c.id)) return false;
    if (!S.showPrivate && !c.exported) return false;
    return true;
  }

  function computeVisible() {
    pruneRevealed();
    const hiddenP = new Set(S.hiddenPkgs);
    const enabled = G.edges.filter((e) => S.edgeKinds[e.kind]);
    let ids;
    let reached = null;

    if (S.focus && focusValid(S.focus.id)) {
      // Hidden layers apply in focus too: their cards are not shown and the
      // branch does not continue through them (the focus itself always stays).
      const allowed = new Set(cardsAll.filter((c) => cardPassesFilters(c) && !hiddenP.has(c.pkg)).map((c) => c.id));
      const out = new Map(), inn = new Map();
      const push = (m, k, v) => { if (!m.has(k)) m.set(k, []); m.get(k).push(v); };
      for (const e of enabled) {
        push(out, e.from, e.to);
        push(inn, e.to, e.from);
      }
      const file = fileOf(S.focus.id);
      const root = file ? null : byId.get(S.focus.id);
      let frontier;
      if (file) {
        // everything declared in the file: cards and methods (whose receiver may live elsewhere)
        frontier = G.nodes.filter((n) => n.file === file && (CARD_KINDS.has(n.kind) || (n.parent && byId.has(n.parent)))).map((n) => n.id);
      } else {
        frontier = [root.id];
        if (CARD_KINDS.has(root.kind)) for (const m of membersOf.get(root.id) || []) frontier.push(m.id);
      }
      reached = new Set(frontier);
      const depth = S.focus.depth != null ? S.focus.depth : S.depth;
      for (let d = 0; d < depth && frontier.length; d++) {
        const next = [];
        for (const id of frontier) {
          const nb = [];
          if (S.dir !== 'in') nb.push(...(out.get(id) || []));
          if (S.dir !== 'out') nb.push(...(inn.get(id) || []));
          for (const t of nb) {
            if (reached.has(t)) continue;
            const o = ownerOf(t);
            if (!o || !(allowed.has(o) || (byId.get(o).parent && allowed.has(byId.get(o).parent)))) continue;
            reached.add(t);
            next.push(t);
          }
        }
        frontier = next;
      }
      ids = new Set();
      for (const id of reached) { const o = ownerOf(id); if (o) ids.add(o); }
      if (root) ids.add(ownerOf(root.id));
    } else {
      ids = new Set(cardsAll.filter((c) => !hiddenP.has(c.pkg) && cardPassesFilters(c)).map((c) => c.id));
    }
    for (const id of S.extra) {
      const c = byId.get(id);
      if (c && (S.showPrivate || c.exported)) ids.add(id);
    }
    // an exploded type comes with all its methods as separate cards
    const memberEdges = [];
    for (const T of explodedSet) {
      const ms = (membersOf.get(T) || []).filter(memberVisible);
      if (!ids.has(T) && !ms.some((m) => ids.has(m.id))) continue;
      ids.add(T);
      for (const m of ms) {
        ids.add(m.id);
        memberEdges.push({ from: T, to: m.id, kind: 'member', count: 1 });
      }
    }

    // collapsed layers: the package's cards are replaced by one miniature card
    const collapsed = new Set(S.collapsedPkgs);
    for (const id of [...byId.keys()]) if (id.startsWith('layer:')) byId.delete(id);
    const cards = [];
    const layerOf = new Map(); // card id -> layer card id
    const candidates = [];
    for (const c of cardsAll) {
      candidates.push(c);
      if (explodedSet.has(c.id)) for (const m of membersOf.get(c.id) || []) candidates.push(m);
    }
    for (const c of candidates) {
      if (!ids.has(c.id)) continue;
      if (!collapsed.has(c.pkg)) { cards.push(c); continue; }
      const lid = 'layer:' + c.pkg;
      let L = byId.get(lid);
      if (!L) {
        L = { id: lid, kind: 'layer', name: shortPkg(c.pkg), pkg: c.pkg, exported: true, file: '', line: 0, endLine: 0, members: [] };
        byId.set(lid, L);
        cards.push(L);
      }
      L.members.push(c);
      layerOf.set(c.id, lid);
    }
    const vis = new Set(cards.map((c) => c.id));

    // wires touching collapsed cards are re-attached to the layer card
    let edgeList = memberEdges.length ? enabled.concat(memberEdges) : enabled;
    if (layerOf.size) {
      const merged = new Map();
      edgeList = [];
      for (const e of (memberEdges.length ? enabled.concat(memberEdges) : enabled)) {
        const oa = ownerOf(e.from), ob = ownerOf(e.to);
        const la = oa && layerOf.get(oa), lb = ob && layerOf.get(ob);
        if (!la && !lb) { edgeList.push(e); continue; }
        if ((la || oa) === (lb || ob)) continue; // inside the collapsed layer
        const from = la || e.from, to = lb || e.to, label = la ? '' : (e.label || '');
        const key = from + '\u0000' + to + '\u0000' + e.kind + '\u0000' + label;
        let m = merged.get(key);
        if (!m) {
          m = { from, to, kind: e.kind, label, count: 0, sites: [], layer: true };
          merged.set(key, m);
          edgeList.push(m);
        }
        m.count += e.count || 1;
        if (e.sites && m.sites.length < 20) m.sites.push(...e.sites.slice(0, 20 - m.sites.length));
      }
    }

    const edges = [];
    const hiddenRel = new Map(); // card -> Map(relKey -> Set(hidden card ids))
    for (const e of edgeList) {
      const a = ownerOf(e.from), b = ownerOf(e.to);
      if (!a || !b) continue;
      const va = vis.has(a), vb = vis.has(b);
      if (va && vb) { edges.push(e); continue; }
      if (va === vb || a === b) continue;
      const [card, other, dir] = va ? [a, b, 'out'] : [b, a, 'in'];
      const oc = byId.get(other);
      if (!oc || (!S.showPrivate && !oc.exported)) continue;
      const key = REL_OF[e.kind + ':' + dir];
      if (!hiddenRel.has(card)) hiddenRel.set(card, new Map());
      const m = hiddenRel.get(card);
      if (!m.has(key)) m.set(key, new Set());
      m.get(key).add(other);
    }
    return { cards, edges, vis, reached, hiddenRel };
  }

  // ------------------------------------------------------------------ cards

  function memberVisible(m) {
    return S.showPrivate || m.exported;
  }

  function moreHTML(c) {
    const rel = visible.hiddenRel.get(c.id);
    const rev = S.revealedBy[c.id];
    if ((!rel || !rel.size) && !rev) return '';
    let h = '';
    const all = new Set();
    for (const r of RELS) {
      const set = rel && rel.get(r.key);
      if (!set) continue;
      for (const id of set) all.add(id);
      const names = [...set].slice(0, 12).map(displayName).join(', ') + (set.size > 12 ? ', …' : '');
      h += `<span class="mr" data-card="${esc(c.id)}" data-rel="${r.key}" title="Show: ${esc(names)}">${r.label} <b>${set.size}</b></span>`;
    }
    if (rel && rel.size > 1) h += `<span class="mr all" data-card="${esc(c.id)}" data-rel="*" title="Show all related">all <b>+${all.size}</b></span>`;
    // the reverse: cards this one revealed can be collapsed back
    if (rev) {
      const keys = RELS.filter((r) => rev[r.key]);
      const shown = new Set();
      for (const r of keys) {
        for (const id of rev[r.key]) shown.add(id);
        const names = rev[r.key].slice(0, 12).map(displayName).join(', ') + (rev[r.key].length > 12 ? ', …' : '');
        h += `<span class="mr un" data-card="${esc(c.id)}" data-unrel="${r.key}" title="Свернуть: ${esc(names)}">− ${r.label} <b>${rev[r.key].length}</b></span>`;
      }
      if (keys.length > 1) h += `<span class="mr un all" data-card="${esc(c.id)}" data-unrel="*" title="Свернуть всё, что раскрыто из этого блока">свернуть всё <b>−${shown.size}</b></span>`;
    }
    return `<div class="more">${h}</div>`;
  }

  // Miniature of a package layer: its cards as colored blocks plus internal wires.
  function layerSnapshot(pkg, ids) {
    const rects = [];
    for (const id of ids) {
      const p = pos.get(id), m = meas.get(id), c = byId.get(id);
      if (p && m && c) rects.push({ id, x: p.x, y: p.y, w: m.w, h: m.h, hh: m.hdrY * 2, kind: c.kind });
    }
    if (rects.length !== ids.length) return null;
    const idx = new Map(rects.map((r) => [r.id, r]));
    const wires = [];
    for (const e of G.edges) {
      if (!S.edgeKinds[e.kind]) continue;
      const a = idx.get(ownerOf(e.from)), b = idx.get(ownerOf(e.to));
      if (a && b && a !== b) {
        wires.push(S.vertical
          ? [a.x + a.w / 2, a.y + a.h, b.x + b.w / 2, b.y, e.kind, true]
          : [a.x + a.w, a.y + a.hh / 2, b.x, b.y + b.hh / 2, e.kind, false]);
      }
    }
    return { rects, wires };
  }

  // Fallback when the layer was never laid out: a grid sized by member counts.
  function layerGrid(members) {
    const cols = Math.max(1, Math.ceil(Math.sqrt(members.length * 1.4)));
    const rects = members.map((c, i) => {
      const rows = (membersOf.get(c.id) || []).length + (c.fields ? c.fields.length : 0);
      return { id: c.id, x: (i % cols) * 190, y: Math.floor(i / cols) * 130, w: 160, h: 26 + Math.min(rows, 10) * 9, hh: 22, kind: c.kind };
    });
    return { rects, wires: [] };
  }

  function layerThumb(L) {
    const snap = layerSnaps.get(L.pkg) || layerGrid(L.members);
    L.snap = snap;
    let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
    for (const r of snap.rects) { x1 = Math.min(x1, r.x); y1 = Math.min(y1, r.y); x2 = Math.max(x2, r.x + r.w); y2 = Math.max(y2, r.y + r.h); }
    if (x1 === Infinity) return '';
    const pad = 20, vw = x2 - x1 + pad * 2, vh = y2 - y1 + pad * 2;
    const W = 260, H = Math.max(60, Math.min(170, W * vh / vw));
    let svg = `<svg class="lsvg" viewBox="${x1 - pad} ${y1 - pad} ${vw} ${vh}" width="${W}" height="${H}" preserveAspectRatio="xMidYMid meet">`;
    for (const [ax, ay, bx, by, kind, vert] of snap.wires) {
      const dx = Math.max(30, Math.abs(bx - ax) * 0.45), dy = Math.max(30, Math.abs(by - ay) * 0.45);
      const d = vert ? `M${ax},${ay} C${ax},${ay + dy} ${bx},${by - dy} ${bx},${by}` : `M${ax},${ay} C${ax + dx},${ay} ${bx - dx},${by} ${bx},${by}`;
      svg += `<path d="${d}" stroke="${KIND_COLOR[kind]}" stroke-opacity=".5" stroke-width="${Math.max(2, vw / 260)}" fill="none"/>`;
    }
    for (const r of snap.rects) {
      svg += `<rect x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" rx="6" fill="#1c1c20" stroke="#000" stroke-width="2"/>` +
        `<rect x="${r.x}" y="${r.y}" width="${r.w}" height="${r.hh}" rx="6" fill="${KIND_FILL[r.kind] || '#555'}"/>`;
    }
    return svg + '</svg>';
  }

  function layerHTML(L) {
    const info = pkgInfo.get(L.pkg) || { color: '#888', short: L.pkg };
    const counts = {};
    for (const c of L.members) counts[c.kind] = (counts[c.kind] || 0) + 1;
    const stat = Object.entries(counts).map(([k, n]) => `<span><i style="background:${KIND_FILL[k]}"></i>${KIND_ICON[k]} ${n}</span>`).join('');
    return `<div class="card k-layer" data-card="${esc(L.id)}" style="--kc:${info.color}">
      <div class="hdr" data-ep="${esc(L.id)}"><span class="pin l" data-side="in"></span><span class="ic">▦</span><span class="t">${esc(info.short)}</span>
        <span class="fbtn" data-lexpand="${esc(L.pkg)}" title="Развернуть слой">▸</span><span class="fbtn" data-fhide="${esc(L.pkg)}" title="Скрыть слой">✕</span><span class="pin r" data-side="out"></span></div>
      <div class="body lthumb">${layerThumb(L)}<div class="lstat">${stat}<span class="lhint">двойной клик — развернуть</span></div></div>${moreHTML(L)}</div>`;
  }

  // A method pulled out of its type into its own card.
  function explodeBtn(c) {
    if (!EXPLODABLE.has(c.kind) || !(membersOf.get(c.id) || []).some(memberVisible)) return '';
    return explodedSet.has(c.id)
      ? `<span class="fbtn" data-implode="${esc(c.id)}" title="Свернуть методы обратно в ${esc(c.name)}">⇱</span>`
      : `<span class="fbtn" data-explode="${esc(c.id)}" title="Вынести методы ${esc(c.name)} в отдельные блоки">⇲</span>`;
  }

  function explodeType(id) {
    if (explodedSet.has(id)) return;
    S.exploded = [...S.exploded, id];
    explodedSet = new Set(S.exploded);
    selection = null;
    return rebuild({ relayout: true, anchor: id });
  }

  function implodeType(id) {
    if (!explodedSet.has(id)) return;
    S.exploded = S.exploded.filter((x) => x !== id);
    explodedSet = new Set(S.exploded);
    selection = null;
    return rebuild({ relayout: true, anchor: id });
  }

  // Return values of a func / method card: hidden until the header button is pressed.
  function retBtn(c) {
    if (S.compact || !c.returns || !c.returns.length) return '';
    return S.retOpen.includes(c.id)
      ? `<span class="fbtn on" data-rets="${esc(c.id)}" title="Скрыть структуру возвращаемого типа">⇡</span>`
      : `<span class="fbtn" data-rets="${esc(c.id)}" title="Показать структуру возвращаемого типа">⇣</span>`;
  }

  function retHTML(c) {
    if (S.compact || !c.returns || !S.retOpen.includes(c.id)) return '';
    let h = '<div class="sep"></div>';
    for (const r of c.returns) {
      const tag = r.kind ? `<span class="lb">${r.kind}</span>` : '';
      h += `<div class="row ret"><span class="nm">↳ ${esc(r.name || 'return')}</span>${tag}<span class="ty">${esc(r.type)}</span></div>`;
      for (const f of (r.fields || []).filter((f) => S.showPrivate || f.exported)) {
        h += r.kind === 'interface'
          ? `<div class="row rf${f.exported ? '' : ' priv'}"><span class="nm">${esc(f.name)}</span><span class="sg">${esc(f.type)}</span></div>`
          : `<div class="row rf${f.exported ? '' : ' priv'}"><span class="nm">${f.embedded ? '' : esc(f.name)}</span><span class="ty${f.embedded ? ' emb' : ''}">${esc(f.type)}</span></div>`;
      }
    }
    return h;
  }

  function toggleReturns(id) {
    S.retOpen = S.retOpen.includes(id) ? S.retOpen.filter((x) => x !== id) : [...S.retOpen, id];
    return rebuild({ anchor: id });
  }

  function methodCardHTML(m) {
    const T = byId.get(m.parent);
    const icon = m.kind === 'rpc' ? 'R' : 'M';
    return `<div class="card k-mcard of-${T.kind}" data-card="${esc(m.id)}">
      <div class="hdr" data-ep="${esc(m.id)}"><span class="pin l ex" data-side="in"></span><span class="ic">${icon}</span><span class="t"><span class="own">${esc(T.name)}.</span>${m.ptrRecv ? '<span class="ptr">*</span>' : ''}${esc(m.name)}</span>
        ${retBtn(m)}<span class="fbtn" data-implode="${esc(T.id)}" title="Свернуть методы обратно в ${esc(T.name)}">⇱</span><span class="xp" data-xp="${esc(m.id)}" title="Code info">ⓘ</span><span class="pin r ex" data-side="out"></span></div>
      <div class="body">${S.compact ? '' : `<div class="row sig"><span class="sg">${esc(m.sig)}</span></div>`}<div class="row mof"><span class="tag">${m.kind === 'imethod' ? 'метод интерфейса' : 'метод'} ${esc(T.name)}</span></div>${retHTML(m)}</div>${moreHTML(m)}</div>`;
  }

  function cardHTML(c) {
    if (c.kind === 'layer') return layerHTML(c);
    if (c.parent) return methodCardHTML(c);
    const pk = !S.groupByPkg || S.focus ? `<span class="pk">${esc(shortPkg(c.pkg))}</span>` : '';
    const pinKind = c.kind === 'func' ? 'ex' : '';
    let h = `<div class="card k-${c.kind}" data-card="${esc(c.id)}">
      <div class="hdr" data-ep="${esc(c.id)}"><span class="pin l ${pinKind}" data-side="in"></span><span class="ic">${KIND_ICON[c.kind]}</span><span class="t">${esc(c.name)}</span>${pk}${explodeBtn(c)}${retBtn(c)}<span class="xp" data-xp="${esc(c.id)}" title="Code info">ⓘ</span><span class="pin r ${pinKind}" data-side="out"></span></div>`;
    if (S.compact) return h + moreHTML(c) + '</div>';

    let body = '';
    if (S.showDocs && c.doc) body += `<div class="doc">${esc(c.doc.split('\n')[0])}</div>`;
    if (c.kind === 'message') {
      for (const f of c.fields || []) {
        body += `<div class="row field pf" data-ep="${esc(c.id + '#' + f.name)}">
          <span class="num">${f.num || ''}</span><span class="nm">${esc(f.proto || f.name)}</span>${f.label ? `<span class="lb">${esc(f.label)}</span>` : ''}<span class="ty">${esc(f.type)}</span><span class="pin r" data-side="out"></span></div>`;
      }
      if (!body) body = '<div class="row sig"><span class="sg">(no fields)</span></div>';
      return h + `<div class="body">${body}</div>` + moreHTML(c) + '</div>';
    }
    if (c.kind === 'service') {
      for (const m of membersOf.get(c.id) || []) {
        body += `<div class="row method rpc" data-ep="${esc(m.id)}">
          <span class="pin l ex" data-side="in"></span><span class="nm">${esc(m.name)}</span><span class="sg">${esc(m.sig)}</span>${STREAM_BADGE[m.stream] ? `<span class="st">${STREAM_BADGE[m.stream]}</span>` : ''}<span class="xp" data-xp="${esc(m.id)}" title="Code info">ⓘ</span><span class="pin r ex" data-side="out"></span></div>`;
      }
      return h + `<div class="body">${body}</div>` + moreHTML(c) + '</div>';
    }
    if (c.kind === 'func') body += `<div class="row sig"><span class="sg">${esc(c.sig)}</span></div>` + retHTML(c);
    if (c.kind === 'type' && c.underlying) body += `<div class="row sig"><span class="sg">${esc(c.underlying)}</span></div>`;
    const fields = S.showFields && c.fields ? c.fields.filter((f) => S.showPrivate || f.exported) : [];
    for (const f of fields) {
      const ep = c.id + '#' + f.name;
      body += `<div class="row field${f.exported ? '' : ' priv'}" data-ep="${esc(ep)}">
        <span class="nm">${f.embedded ? '' : esc(f.name)}</span><span class="ty${f.embedded ? ' emb' : ''}">${esc(f.type)}</span><span class="pin r" data-side="out"></span></div>`;
    }
    const members = (membersOf.get(c.id) || []).filter(memberVisible);
    if (members.length && explodedSet.has(c.id)) {
      if (fields.length) body += '<div class="sep"></div>';
      body += `<div class="row xrow"><span class="sg">↳ ${members.length} метод${plural(members.length)} вынесен${members.length === 1 ? '' : 'ы'} в блоки</span><span class="fbtn wide" data-implode="${esc(c.id)}" title="Свернуть методы обратно в ${esc(c.name)}">⇱ свернуть</span></div>`;
    } else if (members.length) {
      if (fields.length) body += '<div class="sep"></div>';
      for (const m of members) {
        body += `<div class="row method${m.exported ? '' : ' priv'}" data-ep="${esc(m.id)}">
          <span class="pin l ex" data-side="in"></span><span class="nm">${m.ptrRecv ? '<span class="ptr">*</span>' : ''}${esc(m.name)}</span><span class="sg">${esc(m.sig)}</span><span class="xp" data-xp="${esc(m.id)}" title="Code info">ⓘ</span><span class="pin r ex" data-side="out"></span></div>`;
      }
    }
    if (body) h += `<div class="body">${body}</div>`;
    return h + moreHTML(c) + '</div>';
  }

  function renderCards(cards) {
    cardsEl.innerHTML = cards.map(cardHTML).join('');
    cardEls.clear();
    meas.clear();
    for (const el of cardsEl.children) cardEls.set(el.dataset.card, el);
    // measure in one pass (layout is forced once); visibility:hidden still lays out
    for (const [id, el] of cardEls) {
      const rows = new Map();
      const list = [];
      const hdr = el.firstElementChild;
      for (const r of el.querySelectorAll('[data-ep]')) rows.set(r.dataset.ep, r.offsetTop + r.offsetHeight / 2);
      for (const r of el.querySelectorAll('.row')) {
        const nm = r.querySelector('.nm'), sg = r.querySelector('.sg'), ty = r.querySelector('.ty');
        list.push({
          y: r.offsetTop + r.offsetHeight / 2,
          nm: nm ? nm.textContent : '', sg: sg ? sg.textContent : '', ty: ty ? ty.textContent : '',
          priv: r.classList.contains('priv'),
        });
      }
      const more = el.querySelector('.more');
      meas.set(id, {
        w: el.offsetWidth, h: el.offsetHeight, hdrY: hdr.offsetTop + hdr.offsetHeight / 2, rows, list,
        more: more ? { y: more.offsetTop, h: more.offsetHeight } : null,
      });
    }
    for (const id of cardEls.keys()) renderDropdowns(id);
  }

  function placeCard(id) {
    const el = cardEls.get(id), p = pos.get(id);
    if (el && p) el.style.transform = `translate(${p.x}px, ${p.y}px)`;
  }

  // ------------------------------------------------------------------ info dropdowns

  const GO_KW = new Set('break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var'.split(' '));
  const GO_BUILTIN = new Set(('bool byte complex64 complex128 error float32 float64 int int8 int16 int32 int64 rune string uint uint8 uint16 uint32 uint64 uintptr any comparable ' +
    'true false nil iota append cap clear close complex copy delete imag len make max min new panic print println real recover').split(' '));
  const PROTO_KW = new Set('syntax package import option message service rpc returns stream enum oneof map repeated optional required reserved extend extensions to max true false'.split(' '));
  const PROTO_BUILTIN = new Set('double float int32 int64 uint32 uint64 sint32 sint64 fixed32 fixed64 sfixed32 sfixed64 bool string bytes'.split(' '));
  const GO_TOKEN = /(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|("(?:[^"\\\n]|\\.)*"|`[^`]*`|'(?:[^'\\\n]|\\.)*')|(\b0[xX][0-9a-fA-F_]+\b|\b\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?\b)|([A-Za-z_]\w*)(?=(\s*\())?/g;

  function highlightGo(src, proto) {
    const KW = proto ? PROTO_KW : GO_KW, BI = proto ? PROTO_BUILTIN : GO_BUILTIN;
    let out = '', last = 0, m;
    GO_TOKEN.lastIndex = 0;
    while ((m = GO_TOKEN.exec(src))) {
      out += esc(src.slice(last, m.index));
      last = GO_TOKEN.lastIndex;
      const t = esc(m[0]);
      if (m[1]) out += `<span class="c-com">${t}</span>`;
      else if (m[2]) out += `<span class="c-str">${t}</span>`;
      else if (m[3]) out += `<span class="c-num">${t}</span>`;
      else if (KW.has(m[4])) out += `<span class="c-kw">${t}</span>`;
      else if (BI.has(m[4])) out += `<span class="c-bi">${t}</span>`;
      else if (m[5] !== undefined) out += `<span class="c-fn">${t}</span>`;
      else if (/^[A-Z]/.test(m[4])) out += `<span class="c-ty">${t}</span>`;
      else out += t;
    }
    return out + esc(src.slice(last));
  }

  function srcKey(n) {
    return `${n.file}:${n.line}-${n.endLine}`;
  }

  function declLine(n) {
    const parent = n.parent && byId.get(n.parent);
    switch (n.kind) {
      case 'func': return `func ${n.name}${n.sig}`;
      case 'method': return `func (${n.ptrRecv ? '*' : ''}${parent ? parent.name : '?'}) ${n.name}${n.sig}`;
      case 'imethod': return `${parent ? parent.name : '?'}.${n.name}${n.sig}`;
      case 'type': return `type ${n.name} ${n.underlying || ''}`;
      case 'service': return `service ${n.name}`;
      case 'rpc': return `rpc ${n.name}${n.sig.replace(' → ', ' returns (').replace(/$/, ')')}`;
      case 'message': return `message ${n.name}`;
      default: return `type ${n.name} ${n.kind}`;
    }
  }

  // Grouped relations of an endpoint, from the full graph (not only visible wires).
  function relationsOf(n) {
    const groups = [];
    const add = (label, edges, pick) => {
      const items = new Map();
      for (const e of edges) {
        const id = pick(e);
        if (!byId.has(id) && !ownerOf(id)) continue;
        const it = items.get(id) || { id, count: 0, ref: false };
        it.count += e.count || 1;
        if (e.kind === 'ref') it.ref = true;
        items.set(id, it);
      }
      if (items.size) groups.push({ label, items: [...items.values()].sort((a, b) => displayName(a.id).localeCompare(displayName(b.id))) });
    };
    const outs = outIdx.get(n.id) || [], ins = inIdx.get(n.id) || [];
    const of = (list, ...kinds) => list.filter((e) => kinds.includes(e.kind));
    const rpc = (list, ...labels) => list.filter((e) => e.kind === 'grpc' && labels.includes(e.label));
    const nested = (list) => list.filter((e) => e.kind === 'grpc' && !GRPC_LABELS.has(e.label));
    if (n.kind === 'service') {
      const handlers = new Set(), clients = new Set();
      for (const m of membersOf.get(n.id) || []) {
        for (const e of inIdx.get(m.id) || []) {
          if (e.kind !== 'grpc') continue;
          if (e.label === 'serves') handlers.add(ownerOf(e.from));
          if (e.label === 'client') clients.add(ownerOf(e.from));
        }
      }
      const items = (set) => [...set].filter(Boolean).map((id) => ({ id, count: 0 }));
      if (handlers.size) groups.push({ label: 'Implemented by', items: items(handlers) });
      if (clients.size) groups.push({ label: 'Called from (client)', items: items(clients) });
      return groups;
    }
    if (n.kind === 'rpc') {
      add('Handled by', rpc(ins, 'serves'), (e) => e.from);
      add('Called from (client)', rpc(ins, 'client'), (e) => e.from);
      add('Request', rpc(outs, 'request'), (e) => e.to);
      add(n.stream === 'server' || n.stream === 'bidi' ? 'Streams' : 'Response', rpc(outs, 'response', 'stream'), (e) => e.to);
      return groups;
    }
    if (n.kind === 'message') {
      add('Request of', rpc(ins, 'request'), (e) => e.from);
      add('Response of', rpc(ins, 'response'), (e) => e.from);
      add('Streamed by', rpc(ins, 'stream'), (e) => e.from);
      add('Built by', rpc(ins, 'builds'), (e) => e.from);
      add('Contains', nested(outs), (e) => e.to);
      add('Contained in', nested(ins), (e) => e.from);
      add('Field of', of(ins, 'uses', 'embeds'), (e) => e.from);
      return groups;
    }
    if (CARD_KINDS.has(n.kind) && n.kind !== 'func') {
      add('Implements', of(outs, 'implements'), (e) => e.to);
      add('Implemented by', of(ins, 'implements'), (e) => e.from);
      add('Embeds', of(outs, 'embeds'), (e) => e.to);
      add('Field types', of(outs, 'uses'), (e) => e.to);
      add('Used by', of(ins, 'uses', 'embeds'), (e) => e.from);
      const ms = membersOf.get(n.id) || [];
      const callers = new Set();
      for (const m of ms) for (const e of inIdx.get(m.id) || []) if (e.kind === 'calls' || e.kind === 'ref') callers.add(ownerOf(e.from));
      callers.delete(n.id);
      if (callers.size) groups.push({ label: 'Methods called from', items: [...callers].filter(Boolean).map((id) => ({ id, count: 0 })) });
    } else {
      add('Called by', of(ins, 'calls', 'ref'), (e) => e.from);
      add('Calls', of(outs, 'calls', 'ref'), (e) => e.to);
      if (n.kind === 'imethod') add('Implementations', of(outs, 'dispatch'), (e) => e.to);
      if (n.kind === 'method') add('Implements method of', of(ins, 'dispatch'), (e) => e.from);
      add('Serves RPC', rpc(outs, 'serves'), (e) => e.to);
      add('Calls RPC (client)', rpc(outs, 'client'), (e) => e.to);
      add('Builds messages', rpc(outs, 'builds'), (e) => e.to);
    }
    return groups;
  }

  function ddHTML(ep) {
    const n = byId.get(ep);
    if (!n) return '';
    const key = srcKey(n);
    const src = srcCache.get(key);
    const lines = n.endLine - n.line + 1;
    let h = `<div class="dd-h"><span class="ic k-${n.kind}">${KIND_ICON[n.kind] || '?'}</span><b>${esc(displayName(ep))}</b>
      <a class="loc" data-open="${esc(ep)}" title="Open in editor">${esc(n.file)}:${n.line}</a><span class="x" data-ddclose="${esc(ep)}" title="Close">✕</span></div>`;
    const isProto = n.file.endsWith('.proto');
    h += `<div class="dd-sig">${highlightGo(declLine(n), ['service', 'rpc', 'message'].includes(n.kind))}</div>`;
    if (n.doc) h += `<div class="dd-doc">${esc(n.doc)}</div>`;
    const stats = [`${lines} line${lines === 1 ? '' : 's'}`, shortPkg(n.pkg)];
    if (n.kind === 'service') stats.push(`${(membersOf.get(n.id) || []).length} RPCs`);
    else if (n.kind === 'message') stats.push(`${(n.fields || []).length} fields`);
    else if (n.kind === 'rpc') stats.push(n.stream === 'unary' ? 'unary' : STREAM_BADGE[n.stream]);
    else if (CARD_KINDS.has(n.kind) && n.kind !== 'func') {
      stats.push(`${(membersOf.get(n.id) || []).length} methods`);
      if (n.fields) stats.push(`${n.fields.length} fields`);
    }
    h += `<div class="dd-stats">${stats.map(esc).join(' · ')}</div>`;
    const groups = relationsOf(n);
    if (groups.length) {
      h += '<div class="dd-rel">';
      for (const g of groups) {
        h += `<div class="g"><span class="gl">${esc(g.label)} <i>${g.items.length}</i></span>`;
        for (const it of g.items.slice(0, 40)) {
          const shown = visible.vis.has(ownerOf(it.id));
          h += `<span class="go${shown ? '' : ' hid'}" data-go="${esc(it.id)}" title="${shown ? 'Go to' : 'Hidden — click to show'}">${esc(displayName(it.id))}${it.count > 1 ? `<i>×${it.count}</i>` : ''}${it.ref ? '<i>ref</i>' : ''}</span>`;
        }
        if (g.items.length > 40) h += `<span class="gl">+${g.items.length - 40} more</span>`;
        h += '</div>';
      }
      h += '</div>';
    }
    if (!src) {
      h += '<div class="dd-code"><div class="dd-wait">loading source…</div></div>';
    } else if (src.error) {
      h += `<div class="dd-code"><div class="dd-wait">${esc(src.error)}</div></div>`;
    } else {
      const shown = src.text.split('\n').length;
      const nums = Array.from({ length: shown }, (_, i) => src.start + i).join('\n');
      h += `<div class="dd-code"><pre class="ln">${nums}</pre><pre class="src">${highlightGo(src.text, isProto)}</pre></div>`;
      if (src.total > shown) h += `<div class="dd-stats">… ${src.total - shown} more lines — <a data-open="${esc(ep)}">open in editor</a></div>`;
    }
    return h;
  }

  function requestSource(n) {
    const key = srcKey(n);
    if (srcCache.has(key)) return;
    srcCache.set(key, null);
    vscode.postMessage({ type: 'source', key, file: n.file, line: n.line, endLine: n.endLine });
  }

  // Dropdowns live inside their card, so they move, cull and hide with it.
  function renderDropdowns(cardId) {
    const el = cardEls.get(cardId);
    if (!el) return;
    for (const d of el.querySelectorAll('.dd')) d.remove();
    let any = false;
    for (const ep of S.open) {
      if (ownerOf(ep) !== cardId) continue;
      const n = byId.get(ep);
      if (!n) continue;
      const row = ep === cardId ? null : [...el.querySelectorAll('[data-ep]')].find((r) => r.dataset.ep === ep);
      if (ep !== cardId && !row) continue; // member row hidden (private / compact)
      requestSource(n);
      const d = document.createElement('div');
      d.className = 'dd';
      d.dataset.dd = ep;
      d.dataset.key = srcKey(n);
      d.style.top = (row ? row.offsetTop + row.offsetHeight : el.firstElementChild.offsetHeight) + 'px';
      d.innerHTML = ddHTML(ep);
      el.append(d);
      any = true;
    }
    el.classList.toggle('has-dd', any);
  }

  function toggleInfo(ep) {
    const i = S.open.indexOf(ep);
    if (i >= 0) S.open.splice(i, 1); else S.open.push(ep);
    renderDropdowns(ownerOf(ep));
    saveState();
  }

  // ------------------------------------------------------------------ reveal related

  async function revealIds(ids, anchor) {
    const add = [...ids].filter((id) => !visible.vis.has(id));
    if (!add.length) return;
    S.extra = [...new Set([...S.extra, ...add])];
    S.hiddenCards = S.hiddenCards.filter((id) => !add.includes(id));
    await rebuild({ relayout: true, anchor });
  }

  function revealRel(cardId, key) {
    const rel = visible.hiddenRel.get(cardId);
    if (!rel) return;
    const ids = new Set();
    const rev = S.revealedBy[cardId] || {};
    for (const [k, set] of rel) {
      if (key !== '*' && k !== key) continue;
      const add = [...set].filter((id) => !visible.vis.has(id));
      if (add.length) rev[k] = [...new Set([...(rev[k] || []), ...add])];
      for (const id of set) ids.add(id);
    }
    if (Object.keys(rev).length) S.revealedBy = { ...S.revealedBy, [cardId]: rev };
    return revealIds(ids, cardId);
  }

  // Collapses what a card revealed through its chips, together with whatever
  // those cards revealed in turn. Cards also revealed from elsewhere stay.
  function collapseRel(cardId, key) {
    const rev = S.revealedBy[cardId];
    if (!rev) return;
    const by = { ...S.revealedBy };
    const drop = new Set();
    const queue = [];
    const rest = {};
    for (const [k, ids] of Object.entries(rev)) {
      if (key === '*' || k === key) queue.push(...ids);
      else rest[k] = ids;
    }
    if (Object.keys(rest).length) by[cardId] = rest; else delete by[cardId];
    while (queue.length) {
      const id = queue.pop();
      if (drop.has(id) || id === cardId) continue;
      drop.add(id);
      for (const ids of Object.values(by[id] || {})) queue.push(...ids);
      delete by[id];
    }
    const kept = new Set();
    for (const r of Object.values(by)) for (const ids of Object.values(r)) for (const id of ids) kept.add(id);
    S.extra = S.extra.filter((id) => !drop.has(id) || kept.has(id));
    S.revealedBy = by;
    pruneRevealed();
    if (selection && drop.has(selection.card) && !S.extra.includes(selection.card)) selection = null;
    return rebuild({ anchor: cardId });
  }

  // Forget reveal records for cards that are no longer revealed (reset, hidden, …).
  function pruneRevealed() {
    const extra = new Set(S.extra);
    const out = {};
    for (const [card, rev] of Object.entries(S.revealedBy || {})) {
      if (!byId.has(card)) continue;
      const r = {};
      for (const [k, ids] of Object.entries(rev)) {
        const left = ids.filter((id) => extra.has(id));
        if (left.length) r[k] = left;
      }
      if (Object.keys(r).length) out[card] = r;
    }
    S.revealedBy = out;
  }

  async function goTo(id, fromEp) {
    const owner = ownerOf(id);
    if (!owner) return;
    const oc = byId.get(owner);
    if (oc && S.collapsedPkgs.includes(oc.pkg)) await expandLayer(oc.pkg);
    if (!visible.vis.has(owner)) await revealIds([owner], fromEp ? ownerOf(fromEp) : null);
    select(owner, id);
    centerOn(owner);
  }

  // ------------------------------------------------------------------ layers (package frames)

  function snapLayer(pkg) {
    const ids = visible.cards.filter((c) => c.pkg === pkg && c.kind !== 'layer').map((c) => c.id);
    const snap = ids.length ? layerSnapshot(pkg, ids) : null;
    const f = frameBoxes.find((b) => b.pkg === pkg);
    if (snap) layerSnaps.set(pkg, { ...snap, origin: f ? { x: f.x, y: f.y } : null });
    if (f) pos.set('layer:' + pkg, { x: f.x, y: f.y }); // the miniature takes the frame's place
  }

  // cards come back where they were, shifted if the miniature was dragged
  function unsnapLayer(pkg) {
    const snap = layerSnaps.get(pkg), lp = pos.get('layer:' + pkg);
    if (snap && snap.origin && lp) {
      const dx = lp.x - snap.origin.x, dy = lp.y - snap.origin.y;
      for (const r of snap.rects) pos.set(r.id, { x: r.x + dx, y: r.y + dy });
    }
  }

  function collapseLayer(pkg) {
    if (S.collapsedPkgs.includes(pkg)) return;
    snapLayer(pkg);
    S.collapsedPkgs = [...S.collapsedPkgs, pkg];
    selection = null;
    return rebuild();
  }

  function expandLayer(pkg) {
    unsnapLayer(pkg);
    S.collapsedPkgs = S.collapsedPkgs.filter((p) => p !== pkg);
    selection = null;
    return rebuild();
  }

  // Every way of hiding packages goes through here: cards revealed by chips
  // (S.extra) are shown on top of the filter, so the newly hidden ones are dropped.
  function setHiddenPkgs(list) {
    const before = new Set(S.hiddenPkgs);
    S.hiddenPkgs = [...new Set(list)];
    const added = new Set(S.hiddenPkgs.filter((p) => !before.has(p)));
    if (added.size) S.extra = S.extra.filter((id) => { const c = byId.get(id); return !c || !added.has(c.pkg); });
    if (selection) {
      const c = byId.get(selection.card);
      if (c && added.has(c.pkg)) selection = null;
    }
  }

  function hideLayer(pkg) {
    setHiddenPkgs([...S.hiddenPkgs, pkg]);
    selection = null;
    return rebuild();
  }

  function showLayer(pkg) {
    S.hiddenPkgs = S.hiddenPkgs.filter((p) => p !== pkg);
    return rebuild();
  }

  // Hidden / collapsed layers live in a tray on the canvas, so the sidebar isn't needed.
  let trayOpen = false;
  function renderTray() {
    const tray = $('#layers');
    const hidden = S.hiddenPkgs.filter((p) => pkgInfo.has(p) && pkgInfo.get(p).count > 0);
    const col = S.collapsedPkgs.filter((p) => pkgInfo.has(p));
    if (!hidden.length && !col.length) { tray.innerHTML = ''; tray.style.display = 'none'; return; }
    tray.style.display = 'block';
    let h = '<div class="lt-bar">';
    if (hidden.length) h += `<button data-lt="toggle" class="${trayOpen ? 'on' : ''}">Скрытые слои: ${hidden.length} ${trayOpen ? '▴' : '▾'}</button>`;
    if (col.length) h += `<button data-lt="expand-all" title="Развернуть все свёрнутые слои">Свёрнуто: ${col.length} · развернуть</button>`;
    h += '</div>';
    if (trayOpen && hidden.length) {
      h += '<div class="lt-list">' + hidden.slice().sort((a, b) => pkgInfo.get(a).short.localeCompare(pkgInfo.get(b).short)).map((p) =>
        `<div class="lt-i"><span class="sw" style="background:${pkgInfo.get(p).color}"></span><span class="n">${esc(pkgInfo.get(p).short)}</span><span class="c">${pkgInfo.get(p).count}</span><a data-lt="show" data-pkg="${esc(p)}">показать</a></div>`,
      ).join('') + `<div class="lt-all"><a data-lt="show-all">показать все</a></div></div>`;
    }
    tray.innerHTML = h;
  }

  $('#layers').addEventListener('click', (ev) => {
    const el = ev.target.closest('[data-lt]');
    if (!el) return;
    const act = el.dataset.lt;
    if (act === 'toggle') { trayOpen = !trayOpen; renderTray(); return; }
    if (act === 'show') return showLayer(el.dataset.pkg);
    if (act === 'show-all') { S.hiddenPkgs = []; trayOpen = false; return rebuild({ relayout: true, fit: true }); }
    if (act === 'expand-all') {
      for (const p of S.collapsedPkgs) unsnapLayer(p);
      S.collapsedPkgs = [];
      return rebuild();
    }
  });

  // ------------------------------------------------------------------ incremental placement

  const GAP = 26;
  const rectOf = (id) => {
    const p = pos.get(id), m = meas.get(id);
    return p && m ? { x1: p.x, y1: p.y, x2: p.x + m.w, y2: p.y + m.h } : null;
  };
  const hits = (a, b, g) => a.x1 < b.x2 + g && a.x2 + g > b.x1 && a.y1 < b.y2 + g && a.y2 + g > b.y1;

  // Put new cards next to the cards they connect to, without moving anyone.
  function placeNear(cards) {
    const todo = new Set(cards.map((c) => c.id));
    const placed = visible.cards.map((c) => c.id).filter((id) => pos.has(id) && !todo.has(id));
    const preds = new Map(), succs = new Map();
    for (const e of visible.edges) {
      const a = ownerOf(e.from), b = ownerOf(e.to);
      if (!a || !b || a === b) continue;
      if (!succs.has(a)) succs.set(a, []);
      succs.get(a).push(b);
      if (!preds.has(b)) preds.set(b, []);
      preds.get(b).push(a);
    }
    const free = (id, x, y) => {
      const m = meas.get(id);
      // slide along the cross axis until the spot is free
      for (let i = 0; i < 400; i++) {
        const r = { x1: x, y1: y, x2: x + m.w, y2: y + m.h };
        const blocker = placed.map(rectOf).find((o) => o && hits(r, o, GAP));
        if (!blocker) return { x, y };
        if (S.vertical) x = blocker.x2 + GAP; else y = blocker.y2 + GAP;
      }
      return { x, y };
    };
    for (let pass = 0; pass < 3 && todo.size; pass++) {
      for (const id of [...todo]) {
        const m = meas.get(id);
        const P = (preds.get(id) || []).filter((o) => pos.has(o) && !todo.has(o)).map(rectOf).filter(Boolean);
        const Q = (succs.get(id) || []).filter((o) => pos.has(o) && !todo.has(o)).map(rectOf).filter(Boolean);
        let x, y;
        const avg = (rs, f) => rs.reduce((a, r) => a + f(r), 0) / rs.length;
        if (P.length) {
          if (S.vertical) { y = Math.max(...P.map((r) => r.y2)) + 90; x = avg(P, (r) => (r.x1 + r.x2) / 2) - m.w / 2; }
          else { x = Math.max(...P.map((r) => r.x2)) + 90; y = avg(P, (r) => r.y1); }
        } else if (Q.length) {
          if (S.vertical) { y = Math.min(...Q.map((r) => r.y1)) - 90 - m.h; x = avg(Q, (r) => (r.x1 + r.x2) / 2) - m.w / 2; }
          else { x = Math.min(...Q.map((r) => r.x1)) - 90 - m.w; y = avg(Q, (r) => r.y1); }
        } else if (pass < 2) {
          continue; // wait: a neighbour may get placed in this pass
        } else {
          // no placed neighbour: below its package's cards, else below everything
          const c = byId.get(id);
          const same = placed.filter((o) => byId.get(o) && byId.get(o).pkg === c.pkg).map(rectOf).filter(Boolean);
          const rs = same.length ? same : placed.map(rectOf).filter(Boolean);
          x = rs.length ? Math.min(...rs.map((r) => r.x1)) : 0;
          y = rs.length ? Math.max(...rs.map((r) => r.y2)) + 60 : 0;
        }
        pos.set(id, free(id, x, y));
        placed.push(id);
        todo.delete(id);
      }
    }
  }

  // Many new cards: auto-layout just them and park the block beside the rest.
  async function layoutBlock(cards) {
    const ids = new Set(cards.map((c) => c.id));
    const old = visible.cards.map((c) => c.id).filter((id) => !ids.has(id)).map(rectOf).filter(Boolean);
    await layout(cards, visible.edges.filter((e) => ids.has(ownerOf(e.from)) && ids.has(ownerOf(e.to))));
    if (!old.length) return;
    const nb = cards.map((c) => rectOf(c.id)).filter(Boolean);
    const bx = Math.min(...nb.map((r) => r.x1)), by = Math.min(...nb.map((r) => r.y1));
    const ox = Math.min(...old.map((r) => r.x1)), oy = Math.min(...old.map((r) => r.y1));
    const dx = S.vertical ? Math.max(...old.map((r) => r.x2)) + 160 - bx : ox - bx;
    const dy = S.vertical ? oy - by : Math.max(...old.map((r) => r.y2)) + 160 - by;
    for (const c of cards) { const p = pos.get(c.id); pos.set(c.id, { x: p.x + dx, y: p.y + dy }); }
  }

  // Cards that grew (fields, docs…) or landed on others are pushed apart;
  // cards that don't overlap anything are never moved.
  function resolveOverlaps() {
    const ids = visible.cards.map((c) => c.id).filter((id) => pos.has(id) && meas.has(id));
    const along = S.vertical ? 'x' : 'y';
    ids.sort((a, b) => pos.get(a)[along] - pos.get(b)[along]);
    const done = [];
    for (const id of ids) {
      for (let guard = 0; guard < 200; guard++) {
        const r = rectOf(id);
        const o = done.map(rectOf).find((q) => hits(r, q, 12));
        if (!o) break;
        const p = pos.get(id);
        pos.set(id, S.vertical ? { x: o.x2 + 16, y: p.y } : { x: p.x, y: o.y2 + 16 });
      }
      done.push(id);
    }
  }

  // ------------------------------------------------------------------ layout

  async function layout(cards, edges) {
    const pairs = new Map();
    for (const e of edges) {
      const a = ownerOf(e.from), b = ownerOf(e.to);
      if (!a || !b || a === b) continue;
      pairs.set(a + '\u0000' + b, [a, b]);
    }
    const node = (c) => ({ id: c.id, width: meas.get(c.id).w, height: meas.get(c.id).h });
    const base = {
      'elk.algorithm': 'layered',
      'elk.direction': S.vertical ? 'DOWN' : 'RIGHT',
      'elk.edgeRouting': 'POLYLINE',
      'elk.separateConnectedComponents': 'true',
      'elk.layered.crossingMinimization.strategy': 'LAYER_SWEEP',
      'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX',
      'elk.layered.cycleBreaking.strategy': 'GREEDY',
    };

    if (!S.groupByPkg) {
      const res = await elk.layout({
        id: 'root',
        layoutOptions: { ...base, 'elk.spacing.nodeNode': '30', 'elk.layered.spacing.nodeNodeBetweenLayers': '110',
          'elk.spacing.componentComponent': '60', 'elk.aspectRatio': '1.7', 'elk.padding': '[top=20,left=20,bottom=20,right=20]' },
        children: cards.map(node),
        edges: [...pairs.values()].map(([a, b], i) => ({ id: 'e' + i, sources: [a], targets: [b] })),
      });
      for (const c of res.children) pos.set(c.id, { x: c.x, y: c.y });
      return;
    }

    // Two-level: lay out each package on its own, then lay out the packages.
    const byPkg = new Map();
    const layerCards = cards.filter((c) => c.kind === 'layer');
    for (const c of cards) {
      if (c.kind === 'layer') continue;
      if (!byPkg.has(c.pkg)) byPkg.set(c.pkg, []);
      byPkg.get(c.pkg).push(c);
    }
    const pkgOf = new Map(cards.map((c) => [c.id, c.pkg]));
    const inner = new Map();
    for (const [pkg, list] of byPkg) {
      const ids = new Set(list.map((c) => c.id));
      const intra = [...pairs.values()].filter(([a, b]) => ids.has(a) && ids.has(b));
      const res = await elk.layout({
        id: 'pkg',
        layoutOptions: { ...base, 'elk.spacing.nodeNode': '26', 'elk.layered.spacing.nodeNodeBetweenLayers': '90',
          'elk.spacing.componentComponent': '36', 'elk.aspectRatio': '1.6',
          'elk.padding': `[top=${FRAME_PAD.top},left=${FRAME_PAD.left},bottom=${FRAME_PAD.bottom},right=${FRAME_PAD.right}]` },
        children: list.map(node),
        edges: intra.map(([a, b], i) => ({ id: 'e' + i, sources: [a], targets: [b] })),
      });
      inner.set(pkg, res);
    }
    const pkgPairs = new Map();
    for (const [a, b] of pairs.values()) {
      const pa = pkgOf.get(a), pb = pkgOf.get(b);
      if (pa !== pb) pkgPairs.set(pa + '\u0000' + pb, [pa, pb]);
    }
    const outer = await elk.layout({
      id: 'root',
      layoutOptions: { ...base, 'elk.spacing.nodeNode': '60', 'elk.layered.spacing.nodeNodeBetweenLayers': '160',
        'elk.spacing.componentComponent': '90', 'elk.aspectRatio': '1.6', 'elk.padding': '[top=20,left=20,bottom=20,right=20]' },
      children: [...inner.entries()].map(([pkg, r]) => ({ id: pkg, width: r.width, height: r.height }))
        .concat(layerCards.map((c) => ({ id: c.pkg, width: meas.get(c.id).w, height: meas.get(c.id).h }))),
      edges: [...pkgPairs.values()].map(([a, b], i) => ({ id: 'p' + i, sources: [a], targets: [b] })),
    });
    for (const p of outer.children) {
      if (inner.has(p.id)) for (const c of inner.get(p.id).children) pos.set(c.id, { x: p.x + c.x, y: p.y + c.y });
      else pos.set('layer:' + p.id, { x: p.x, y: p.y });
    }
  }

  // ------------------------------------------------------------------ frames

  function renderFrames() {
    frameBoxes = [];
    invalidateScene();
    if (!S.groupByPkg) { framesEl.innerHTML = ''; return; }
    const boxes = new Map();
    for (const c of visible.cards) {
      const p = pos.get(c.id), m = meas.get(c.id);
      if (!p || !m || c.kind === 'layer') continue;
      let b = boxes.get(c.pkg);
      if (!b) boxes.set(c.pkg, b = { x1: Infinity, y1: Infinity, x2: -Infinity, y2: -Infinity, n: 0 });
      b.x1 = Math.min(b.x1, p.x); b.y1 = Math.min(b.y1, p.y);
      b.x2 = Math.max(b.x2, p.x + m.w); b.y2 = Math.max(b.y2, p.y + m.h);
      b.n++;
    }
    let h = '';
    for (const [pkg, b] of boxes) {
      const info = pkgInfo.get(pkg) || { short: pkg, color: '#888' };
      const x = b.x1 - FRAME_PAD.left, y = b.y1 - FRAME_PAD.top;
      const w = b.x2 - b.x1 + FRAME_PAD.left + FRAME_PAD.right, hh = b.y2 - b.y1 + FRAME_PAD.top + FRAME_PAD.bottom;
      frameBoxes.push({ pkg, x, y, w, h: hh, n: b.n, short: info.short, color: info.color });
      h += `<div class="frame" style="--fc:${info.color};transform:translate(${x}px,${y}px);width:${w}px;height:${hh}px">
        <div class="fh" data-pkg="${esc(pkg)}">${esc(info.short)}<small>${b.n} · ${esc(pkg)}</small><span class="fbtns">
          <span class="fbtn" data-fcollapse="${esc(pkg)}" title="Свернуть слой в миниатюру">▾</span><span class="fbtn" data-fhide="${esc(pkg)}" title="Скрыть слой">✕</span></span></div></div>`;
    }
    framesEl.innerHTML = h;
  }

  // ------------------------------------------------------------------ wires

  function pinPos(ep, side) {
    const owner = ownerOf(ep);
    const p = pos.get(owner), m = meas.get(owner);
    if (!p || !m) return null;
    const y = m.rows.has(ep) ? m.rows.get(ep) : m.hdrY;
    return { x: side === 'out' ? p.x + m.w : p.x, y: p.y + y, owner };
  }

  // Cubic bezier control points [x0,y0, x1,y1, x2,y2, x3,y3] for a wire.
  function wireGeom(a, b, same) {
    if (a.vert) {
      // top-down: leave the bottom edge, enter the top edge
      const dy = b.y >= a.y
        ? Math.max(40, (b.y - a.y) * 0.45)
        : Math.max(140, (a.y - b.y) * 0.35 + Math.abs(b.x - a.x) * 0.1);
      return [a.x, a.y, a.x, a.y + dy, b.x, b.y - dy, b.x, b.y];
    }
    if (same) {
      // call within the same card: loop out of the right edge and back in
      const r = 34 + Math.min(80, Math.abs(b.y - a.y) * 0.25);
      return [a.x, a.y, a.x + r, a.y, a.x + r, b.y, a.x + 2, b.y];
    }
    const dx = b.x >= a.x
      ? Math.max(40, (b.x - a.x) * 0.45)
      : Math.max(140, (a.x - b.x) * 0.35 + Math.abs(b.y - a.y) * 0.1);
    return [a.x, a.y, a.x + dx, a.y, b.x - dx, b.y, b.x, b.y];
  }

  // A bezier lies inside the hull of its control points.
  function setWireGeom(w, q) {
    w.q = q;
    w.bb = {
      x1: Math.min(q[0], q[2], q[4], q[6]), y1: Math.min(q[1], q[3], q[5], q[7]),
      x2: Math.max(q[0], q[2], q[4], q[6]), y2: Math.max(q[1], q[3], q[5], q[7]),
    };
    const d = `M${q[0]},${q[1]} C${q[2]},${q[3]} ${q[4]},${q[5]} ${q[6]},${q[7]}`;
    w.path.setAttribute('d', d);
    w.hit.setAttribute('d', d);
  }

  // top-down mode: wires spread along the card's bottom (out) and top (in) edges
  function edgePin(owner, side, slot) {
    const p = pos.get(owner), m = meas.get(owner);
    if (!p || !m) return null;
    const f = slot ? (slot.i + 1) / (slot.n + 1) : 0.5;
    const pad = Math.min(24, m.w * 0.15);
    return { x: p.x + pad + (m.w - pad * 2) * f, y: side === 'out' ? p.y + m.h : p.y, owner, vert: true };
  }

  function wireEnds(w) {
    if (S.vertical) {
      const oa = ownerOf(edgeFrom(w.e)), ob = ownerOf(w.e.to);
      if (oa && oa !== ob) return { a: edgePin(oa, 'out', w.outSlot), b: edgePin(ob, 'in', w.inSlot), same: false };
    }
    const a = pinPos(edgeFrom(w.e), 'out');
    const same = a && ownerOf(w.e.to) === a.owner;
    const b = pinPos(w.e.to, same ? 'out' : 'in');
    return { a, b, same };
  }

  function renderWires(edges) {
    const NS = 'http://www.w3.org/2000/svg';
    wg.textContent = '';
    wires = [];
    wiresByCard.clear();
    const frag = document.createDocumentFragment();
    for (const e of edges) {
      if (e.from === e.to) continue;
      const w = { e };
      const { a, b, same } = wireEnds(w);
      if (!a || !b) continue;
      const g = document.createElementNS(NS, 'g');
      const path = document.createElementNS(NS, 'path');
      const hit = document.createElementNS(NS, 'path');
      w.width = 1.5 + Math.min(2.5, Math.log2(e.count || 1) * 0.7);
      path.setAttribute('class', 'w ' + e.kind + (same ? ' self' : '') +
        (e.kind === 'grpc' && GRPC_LABELS.has(e.label) ? ' l-' + e.label : ''));
      path.setAttribute('stroke-width', w.width.toFixed(2));
      path.setAttribute('marker-end', `url(#ar-${e.kind})`);
      hit.setAttribute('class', 'hit');
      g.append(hit, path);
      frag.append(g);
      Object.assign(w, { g, path, hit, a: a.owner, b: b.owner, same });
      if (!S.vertical) setWireGeom(w, wireGeom(a, b, same));
      hit.__wire = w;
      wires.push(w);
      for (const c of new Set([a.owner, b.owner])) {
        if (!wiresByCard.has(c)) wiresByCard.set(c, []);
        wiresByCard.get(c).push(w);
      }
      markPin(edgeFrom(e), 'out', e.kind);
      markPin(e.to, same ? 'out' : 'in', e.kind);
    }
    if (S.vertical) {
      assignSlots();
      for (const w of wires) {
        const { a, b, same } = wireEnds(w);
        if (a && b) setWireGeom(w, wireGeom(a, b, same));
      }
    }
    wg.append(frag);
    invalidateScene();
  }

  // Order wires along each card edge by where their other end is, so they don't cross at the card.
  function assignSlots() {
    const cx = (id) => { const p = pos.get(id), m = meas.get(id); return p && m ? p.x + m.w / 2 : 0; };
    const outs = new Map(), ins = new Map();
    for (const w of wires) {
      if (w.a === w.b) continue;
      if (!outs.has(w.a)) outs.set(w.a, []);
      outs.get(w.a).push(w);
      if (!ins.has(w.b)) ins.set(w.b, []);
      ins.get(w.b).push(w);
    }
    for (const list of outs.values()) {
      list.sort((x, y) => cx(x.b) - cx(y.b));
      list.forEach((w, i) => { w.outSlot = { i, n: list.length }; });
    }
    for (const list of ins.values()) {
      list.sort((x, y) => cx(x.a) - cx(y.a));
      list.forEach((w, i) => { w.inSlot = { i, n: list.length }; });
    }
  }

  function markPin(ep, side, kind) {
    const card = cardEls.get(ownerOf(ep));
    if (!card) return;
    let row = null;
    for (const r of card.querySelectorAll('[data-ep]')) if (r.dataset.ep === ep) { row = r; break; }
    if (!row) row = card.firstElementChild;
    const pin = row.querySelector(`.pin[data-side="${side}"]`);
    if (pin) {
      pin.classList.add('on');
      if (!pin.classList.contains('ex')) pin.style.setProperty('--pc', KIND_COLOR[kind]);
    }
  }

  function updateWiresFor(cardIds) {
    const done = new Set();
    for (const id of cardIds) {
      for (const w of wiresByCard.get(id) || []) {
        if (done.has(w)) continue;
        done.add(w);
        const { a, b, same } = wireEnds(w);
        if (a && b) setWireGeom(w, wireGeom(a, b, same));
      }
    }
    invalidateScene();
  }

  // ------------------------------------------------------------------ selection

  function applySelection() {
    world.classList.toggle('has-sel', !!selection);
    for (const el of cardsEl.querySelectorAll('.card.sel, .card.linked, .row.sel')) el.classList.remove('sel', 'linked');
    for (const w of wires) if (w.hl) { w.hl = false; w.path.classList.remove('hl', 'anim'); }
    linkedCards = new Set();
    invalidateScene();
    if (!selection) return;
    const card = cardEls.get(selection.card);
    if (!card) { selection = null; world.classList.remove('has-sel'); return; }
    card.classList.add('sel');
    if (selection.ep) {
      for (const r of card.querySelectorAll('[data-ep]')) if (r.dataset.ep === selection.ep) r.classList.add('sel');
    }
    const hl = (wiresByCard.get(selection.card) || []).filter((w) =>
      !selection.ep || edgeFrom(w.e) === selection.ep || w.e.to === selection.ep);
    // marching-ants animation repaints every frame, so only for a few wires
    const animate = hl.length <= 24;
    for (const w of hl) {
      w.hl = true;
      w.path.classList.add('hl');
      if (animate) w.path.classList.add('anim');
      w.g.parentNode.appendChild(w.g); // bring to front
      for (const c of [w.a, w.b]) {
        linkedCards.add(c);
        const el = cardEls.get(c);
        if (el) el.classList.add('linked');
      }
    }
  }

  function select(cardId, ep) {
    selection = cardId ? { card: cardId, ep: ep && ep !== cardId ? ep : null } : null;
    applySelection();
  }

  function applyFocusMarks() {
    for (const el of cardsEl.querySelectorAll('.focus-root, .reached')) el.classList.remove('focus-root', 'reached');
    if (!S.focus) return;
    const el = cardEls.get(ownerOf(S.focus.id));
    if (el) el.classList.add('focus-root');
    if (visible.reached) {
      for (const r of cardsEl.querySelectorAll('.row[data-ep]')) if (visible.reached.has(r.dataset.ep)) r.classList.add('reached');
    }
  }

  function cardMatches(id, q) {
    const c = byId.get(id);
    if (c.kind === 'layer') return c.name.toLowerCase().includes(q) || c.members.some((m) => cardMatches(m.id, q));
    return c.name.toLowerCase().includes(q) || (membersOf.get(id) || []).some((m) => m.name.toLowerCase().includes(q));
  }

  function applySearch() {
    const q = searchQ.trim().toLowerCase();
    world.classList.toggle('searching', !!q);
    for (const [id, el] of cardEls) {
      if (!q) { el.classList.remove('match'); continue; }
      el.classList.toggle('match', cardMatches(id, q));
    }
    invalidateScene();
  }

  // ------------------------------------------------------------------ rebuild

  let rebuilding = Promise.resolve();
  function rebuild(opts) {
    rebuilding = rebuilding.then(() => doRebuild(opts || {})).catch((e) => showError(String(e && e.stack || e)));
    return rebuilding;
  }

  // reset: the explicit "layout" action — the only thing that rearranges cards
  // the user has placed. Everything else keeps positions and only places new cards.
  async function doRebuild({ reset = false, fit = false, anchor = null } = {}) {
    if (!G) return;
    syncToolbar();
    useCtx();
    // keep the anchor card at the same place on screen across a relayout
    let anchorScreen = null;
    if (anchor && pos.has(anchor)) {
      const p = pos.get(anchor);
      anchorScreen = { x: view.x + p.x * view.k, y: view.y + p.y * view.k };
    }
    visible = computeVisible();
    renderFocusBar(); // show the new focus right away, even while the layout runs
    renderCards(visible.cards);
    const key = visible.cards.map((c) => c.id).sort().join('|');
    const missing = visible.cards.filter((c) => !pos.has(c.id));
    if (reset || missing.length === visible.cards.length) {
      // a view seen for the first time (or an explicit reset): full auto-layout
      if (reset) for (const c of visible.cards) pos.delete(c.id);
      setBusy(`Laying out ${visible.cards.length} nodes…`);
      await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
      await layout(visible.cards, visible.edges);
      setBusy(null);
      if (!anchorScreen) fit = true;
    } else if (missing.length > Math.max(12, visible.cards.length * 0.4)) {
      // many new cards: lay them out as their own block next to the existing ones
      setBusy(`Laying out ${missing.length} nodes…`);
      await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
      await layoutBlock(missing);
      setBusy(null);
    } else if (missing.length) {
      placeNear(missing);
    }
    resolveOverlaps();
    lastVisKey = key;
    for (const c of visible.cards) placeCard(c.id);
    renderFrames();
    renderWires(visible.edges);
    if (selection && !visible.vis.has(selection.card)) selection = null;
    applySelection();
    applyFocusMarks();
    applySearch();
    renderSidebar();
    renderTray();
    renderFocusBar();
    renderStatus();
    if (anchorScreen && pos.has(anchor)) {
      const p = pos.get(anchor);
      view.x = anchorScreen.x - p.x * view.k;
      view.y = anchorScreen.y - p.y * view.k;
      fit = false;
    }
    for (const el of cardEls.values()) el.__off = undefined;
    for (const w of wires) w.off = undefined;
    if (fit) fitView(); else applyView();
  }

  function setFocus(id, { push = true, depth } = {}) {
    const cur = S.focus && S.focus.id;
    if (!cur && id) {
      // entering focus: a fresh trail, and remember where we were to come back
      S.history = [];
      S.preFocusView = { ...view };
    }
    if (!id) return exitFocus();
    if (push && cur && cur !== id) S.history.push(cur);
    if (S.history.length > 50) S.history.shift();
    S.focus = id ? { id } : null;
    if (id && depth != null) S.focus.depth = depth;
    // focusing on a symbol inside a collapsed layer opens that layer
    const fc = id && byId.get(ownerOf(id));
    if (fc && S.collapsedPkgs.includes(fc.pkg)) S.collapsedPkgs = S.collapsedPkgs.filter((p) => p !== fc.pkg);
    S.extra = [];
    selection = null;
    return rebuild({ relayout: true, fit: true });
  }

  // back to the normal view, at the same place and zoom as before the focus
  async function exitFocus() {
    if (!S.focus) return;
    if (S.mode === 'file' && S.fileScope) {
      if (S.focus.id === 'file:' + S.fileScope) return vscode.postMessage({ type: 'openFull' });
      S.history = [];
      return setFocus('file:' + S.fileScope, { push: false, depth: 0 });
    }
    const pv = S.preFocusView;
    S.focus = null;
    S.history = [];
    S.extra = [];
    S.preFocusView = null;
    selection = null;
    await rebuild({ relayout: true, fit: !pv });
    if (pv) { view = { ...pv }; applyView(); }
  }

  const KIND_RU = {
    func: 'функция', method: 'метод', struct: 'структура', interface: 'интерфейс', type: 'тип',
    imethod: 'метод интерфейса', service: 'gRPC-сервис', rpc: 'RPC', message: 'proto-сообщение',
  };
  const DIR_RU = { both: '⇄ в обе стороны', out: '→ что вызывает', in: '← кто вызывает' };

  // Banner on the canvas while a focus is active: what is focused, how far, and the way out.
  function renderFocusBar() {
    const bar = $('#focusbar');
    viewport.classList.toggle('focused', !!S.focus);
    if (!S.focus || !focusValid(S.focus.id)) { bar.style.display = 'none'; bar.innerHTML = ''; return; }
    const file = fileOf(S.focus.id);
    const n = file ? { id: S.focus.id, kind: 'file' } : byId.get(S.focus.id);
    const d = S.focus.depth != null ? S.focus.depth : S.depth;
    const only = d === 0;
    const fileView = S.mode === 'file' && S.fileScope;
    const atFile = fileView && S.focus.id === 'file:' + S.fileScope;
    const exitBtn = !fileView
      ? '<button data-fb="exit" class="fb-exit" title="Вернуться к обычному виду (Esc)">✕ Выйти из фокуса</button>'
      : atFile
        ? '<button data-fb="exit" class="fb-exit" title="Открыть вкладку с графом всего модуля">Полный граф ↗</button>'
        : `<button data-fb="exit" class="fb-exit" title="Вернуться к коду файла (Esc)">✕ Вернуться к ${esc(S.fileScope.split('/').pop())}</button>`;
    const trail = S.history.slice(-4).map((id, i, arr) => {
      const idx = S.history.length - arr.length + i;
      return `<a data-fb="trail" data-i="${idx}" title="Вернуться сюда">${esc(displayName(id))}</a>`;
    });
    const hiddenCount = S.history.length > 4 ? `<span class="fb-more">… ${S.history.length - 4} ›</span>` : '';
    bar.innerHTML = `<div class="fb">
        <span class="fb-dot"></span><span class="fb-l">${file ? 'Файл' : only ? 'Только' : 'Фокус'}</span>
        <span class="fb-ic k-${n.kind}">${file ? 'F' : KIND_ICON[n.kind] || '?'}</span>
        <b class="fb-n" data-fb="center" title="${file ? esc(file) : 'Показать в центре'}">${esc(displayName(n.id))}</b>
        <span class="fb-k">${file ? esc(file.split('/').slice(0, -1).join('/')) : KIND_RU[n.kind] || n.kind}</span>
        <span class="fb-s">${only ? '' : `${DIR_RU[S.dir]} · глубина ${d} · `}${visible.cards.length} блок${plural(visible.cards.length)}${S.extra.length ? ` · раскрыто ${S.extra.length}` : ''}</span>
        <span class="fb-btns">
          <button data-fb="back" ${S.history.length ? '' : 'disabled'} title="Предыдущий фокус (Backspace)">◀ Назад</button>
          ${S.extra.length ? '<button data-fb="reset" title="Убрать блоки, раскрытые чипами calls → / uses → …">Свернуть раскрытое</button>' : ''}
          ${exitBtn}
        </span>
      </div>` +
      (trail.length ? `<div class="fb-trail">${hiddenCount}${trail.join('<i>›</i>')}<i>›</i><b>${esc(displayName(n.id))}</b></div>` : '');
    bar.style.display = 'block';
  }

  function plural(n) {
    const m10 = n % 10, m100 = n % 100;
    if (m10 === 1 && m100 !== 11) return '';
    if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return 'а';
    return 'ов';
  }

  $('#focusbar').addEventListener('click', (ev) => {
    const el = ev.target.closest('[data-fb]');
    if (!el || el.disabled) return;
    switch (el.dataset.fb) {
      case 'exit': return exitFocus();
      case 'back': return goBack();
      case 'center': return fileOf(S.focus.id) ? fitView() : centerOn(ownerOf(S.focus.id));
      case 'reset': S.extra = []; return rebuild({ relayout: true, fit: true });
      case 'trail': {
        const i = +el.dataset.i;
        const id = S.history[i];
        S.history = S.history.slice(0, i);
        return setFocus(id, { push: false });
      }
    }
  });

  function goBack() {
    if (!S.history.length) return;
    setFocus(S.history.pop(), { push: false });
  }

  // ------------------------------------------------------------------ sidebar / status

  function protoSection() {
    const pi = (G && G.proto) || {};
    const row = (which, v) => `<div class="pp"><span title="${esc(v)}">${esc(v)}</span><a data-act="rm-path" data-which="${which}" data-value="${esc(v)}" title="Убрать">✕</a></div>`;
    const rpcs = G ? G.nodes.filter((n) => n.kind === 'rpc').length : 0;
    let h = `<h3>gRPC / proto<span><a data-act="settings" title="Открыть настройки">⚙</a></span></h3>
      <div class="sb-info">${pi.services || 0} сервисов · ${rpcs} RPC · ${pi.messages || 0} сообщений<br>
      .proto файлов найдено: ${pi.files || 0}</div>`;
    for (const w of pi.warnings || []) h += `<div class="sb-hint warn">⚠ ${esc(w)}</div>`;
    if (pi.fromProto) {
      h += `<div class="sb-hint">Построено напрямую из .proto (${pi.fromProto} файл${plural(pi.fromProto)}): сгенерированного Go-кода нет, поэтому не видно, какой код обслуживает RPC. Чтобы связать с обработчиками, откройте граф Go-модуля сервера или добавьте папку с *.pb.go.</div>`;
    }
    if (!pi.services && !pi.messages) {
      h += `<div class="sb-hint">gRPC-сервисы не найдены: нет ни сгенерированного кода (*_grpc.pb.go), ни .proto с service. Добавьте папку с .proto или пакет / папку с *.pb.go.</div>`;
    } else if (pi.services && !pi.files) {
      h += `<div class="sb-hint">.proto файлы не найдены — карточки ссылаются на *.pb.go. Укажите папку с .proto.</div>`;
    }
    h += `<div class="sb-sub">Папки с .proto</div>` + (cfgPaths.protoPaths || []).map((v) => row('proto', v)).join('') +
      `<button class="sb-btn" data-act="add-path" data-which="proto">+ папка с .proto</button>`;
    h += `<div class="sb-sub">Пакеты со сгенерированным кодом</div>` + (cfgPaths.extraPackages || []).map((v) => row('gen', v)).join('') +
      `<button class="sb-btn" data-act="add-path" data-which="gen">+ пакет / папка с *.pb.go</button>`;
    if (pi.roots && pi.roots.length) h += `<div class="sb-roots" title="${esc(pi.roots.join('\n'))}">поиск .proto: ${esc(pi.roots.join(', '))}</div>`;
    return h;
  }

  function renderSidebar() {
    const sb = $('#sidebar');
    const hidden = new Set(S.hiddenPkgs);
    const pk = [...pkgInfo.values()].filter((p) => p.count > 0).sort((a, b) => a.short.localeCompare(b.short));
    sb.innerHTML = `<div class="sb-head"><span>Панель</span><span class="sb-tools">
        <a data-act="font-" title="Мельче">A−</a><a data-act="font+" title="Крупнее">A+</a><a data-act="hide-sb" title="Скрыть панель (☰ в тулбаре — вернуть)">‹</a></span></div>` +
      `<h3>Packages<span><a data-act="all">all</a><a data-act="none">none</a></span></h3>` +
      pk.map((p) => `<label title="${esc(p.path)}"><input type="checkbox" data-pkg="${esc(p.path)}" ${hidden.has(p.path) ? '' : 'checked'}>
        <span class="sw" style="background:${p.color}"></span><span class="name">${esc(p.short)}</span><span class="cnt">${p.count}</span></label>`).join('') +
      (S.extra.length ? `<h3>Revealed nodes<span><a data-act="unreveal">hide ${S.extra.length}</a></span></h3>` : '') +
      (S.hiddenCards.length ? `<h3>Hidden nodes<span><a data-act="unhide">show ${S.hiddenCards.length}</a></span></h3>` : '') +
      protoSection();
  }

  $('#sidebar').addEventListener('change', (ev) => {
    const pkg = ev.target.dataset.pkg;
    if (!pkg) return;
    const set = new Set(S.hiddenPkgs);
    if (ev.target.checked) set.delete(pkg); else set.add(pkg);
    setHiddenPkgs([...set]);
    rebuild({ relayout: true, fit: true });
  });
  $('#sidebar').addEventListener('click', (ev) => {
    const el = ev.target.closest('[data-act]');
    const act = el && el.dataset.act;
    if (!act) return;
    // panel-only actions: no rebuild
    if (act === 'font-' || act === 'font+') {
      S.sidebarFont = Math.max(9, Math.min(18, S.sidebarFont + (act === 'font+' ? 1 : -1)));
      syncToolbar(); saveState(); return;
    }
    if (act === 'hide-sb') { S.sidebar = false; syncToolbar(); applyView(); saveState(); return; }
    if (act === 'add-path') { vscode.postMessage({ type: 'addPath', which: el.dataset.which }); return; }
    if (act === 'rm-path') { vscode.postMessage({ type: 'removePath', which: el.dataset.which, value: el.dataset.value }); return; }
    if (act === 'settings') { vscode.postMessage({ type: 'settings' }); return; }
    if (act === 'all') S.hiddenPkgs = [];
    if (act === 'none') setHiddenPkgs([...pkgInfo.keys()]);
    if (act === 'unhide') S.hiddenCards = [];
    if (act === 'unreveal') S.extra = [];
    rebuild({ relayout: true, fit: true });
  });

  function renderStatus() {
    const st = $('#status');
    const parts = [
      `<span>${esc(G.module || '')}</span>`,
      `<span>${visible.cards.length}/${cardsAll.length} nodes</span>`,
      `<span>${wires.length} wires</span>`,
      `<span id="zoom">${Math.round(view.k * 100)}%</span>`,
    ];
    if (S.focus) {
      const d = S.focus.depth != null ? S.focus.depth : S.depth;
      parts.push(`<span class="focus">${d === 0 ? 'only' : 'focus'}: ${esc(displayName(S.focus.id))}${d === 0 ? '' : ` · ${S.dir} · depth ${d}`}</span>`);
    }
    if (G.errors && G.errors.length) parts.push(`<span class="err" id="errs">⚠ ${G.errors.length} load errors</span>`);
    st.innerHTML = parts.join('');
    const errs = $('#errs');
    if (errs) errs.onclick = () => showError(G.errors.join('\n'), true);
  }

  function setBusy(text) {
    busy.classList.toggle('on', !!text);
    if (text) busy.innerHTML = `<div class="box">${esc(text)}</div>`;
  }

  function showError(text, dismissable) {
    busy.classList.add('on');
    busy.innerHTML = `<div class="box error">${esc(text)}\n\n<button id="err-ok">${dismissable ? 'Close' : 'Retry'}</button></div>`;
    $('#err-ok').onclick = () => {
      busy.classList.remove('on');
      if (!dismissable) vscode.postMessage({ type: 'refresh' });
    };
  }

  // ------------------------------------------------------------------ view / rendering

  // All view changes are coalesced into one update per animation frame.
  let viewRaf = 0;
  function applyView() {
    if (!viewRaf) viewRaf = requestAnimationFrame(renderFrame);
  }

  // Content changed (selection, drag, search…): the cached bitmap is stale.
  function invalidateScene() {
    scene = null;
    if (lod) applyView();
  }

  // Called on every pan/zoom step. While a gesture runs, frames are a single
  // drawImage of a cached bitmap; the real render happens when it settles.
  function markMoving(isZoom) {
    moving = true;
    if (isZoom) zooming = true;
    clearTimeout(moveTimer);
    moveTimer = setTimeout(() => {
      moving = zooming = false;
      scene = null;
      world.style.willChange = 'auto';
      applyView();
    }, 160);
  }

  function renderFrame() {
    viewRaf = 0;
    const M = 128 * view.k;
    const m = M / 8 >= 6 ? M / 8 : M;
    viewport.style.backgroundSize = `${M}px ${M}px, ${M}px ${M}px, ${m}px ${m}px, ${m}px ${m}px`;
    viewport.style.backgroundPosition = `${view.x}px ${view.y}px`;

    const wantLod = view.k < LOD_K || zooming;
    if (wantLod !== lod) {
      lod = wantLod;
      // visibility (not display) keeps the DOM laid out, so showing it again is cheap
      world.style.visibility = lod ? 'hidden' : '';
      lodCanvas.style.display = lod ? 'block' : 'none';
      hideTip();
    }
    if (lod) {
      if (moving) drawCached(); else drawDirect();
    } else {
      world.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.k})`;
      cull();
    }
    drawMinimap();
    const z = $('#zoom');
    if (z) z.textContent = Math.round(view.k * 100) + '%';
    saveState();
  }

  // Visible world rectangle plus a margin (in screen px).
  function worldViewRect(marginPx) {
    const k = view.k;
    return {
      x1: (-view.x - marginPx) / k, y1: (-view.y - marginPx) / k,
      x2: (viewport.clientWidth - view.x + marginPx) / k, y2: (viewport.clientHeight - view.y + marginPx) / k,
    };
  }
  const overlaps = (a, b) => a.x1 < b.x2 && a.x2 > b.x1 && a.y1 < b.y2 && a.y2 > b.y1;
  const contains = (a, b) => a.x1 <= b.x1 && a.y1 <= b.y1 && a.x2 >= b.x2 && a.y2 >= b.y2;

  // DOM mode: take off-screen cards and wires out of rendering entirely.
  function cull() {
    const r = worldViewRect(300);
    for (const c of visible.cards) {
      const el = cardEls.get(c.id), p = pos.get(c.id), mm = meas.get(c.id);
      if (!el || !p || !mm) continue;
      const off = !overlaps(r, { x1: p.x, y1: p.y, x2: p.x + mm.w, y2: p.y + mm.h + (el.classList.contains('has-dd') ? 700 : 0) }) &&
        !(drag && drag.ids && drag.ids.includes(c.id));
      if (el.__off !== off) { el.__off = off; el.classList.toggle('off', off); }
    }
    for (const w of wires) {
      const off = !overlaps(r, w.bb);
      if (w.off !== off) { w.off = off; w.g.classList.toggle('off', off); }
    }
  }

  function sizeCanvas() {
    const dpr = window.devicePixelRatio || 1;
    const W = viewport.clientWidth, H = viewport.clientHeight;
    if (lodCanvas.width !== Math.round(W * dpr) || lodCanvas.height !== Math.round(H * dpr)) {
      lodCanvas.width = Math.round(W * dpr);
      lodCanvas.height = Math.round(H * dpr);
      lodCanvas.style.width = W + 'px';
      lodCanvas.style.height = H + 'px';
    }
    return dpr;
  }

  function drawDirect() {
    const dpr = sizeCanvas();
    const c = lodCtx;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, lodCanvas.width, lodCanvas.height);
    c.setTransform(dpr * view.k, 0, 0, dpr * view.k, dpr * view.x, dpr * view.y);
    drawScene(c, worldViewRect(50), view.k);
  }

  // Render the area around the viewport once into an offscreen bitmap, then
  // just scale/translate that bitmap while the gesture lasts.
  function drawCached() {
    const dpr = sizeCanvas();
    const k = view.k;
    const vr = worldViewRect(0);
    if (!scene || k / scene.k < 0.6 || k / scene.k > 1.7 || !contains(scene.rect, vr)) {
      const mx = (vr.x2 - vr.x1) * 0.5, my = (vr.y2 - vr.y1) * 0.5;
      const rect = { x1: vr.x1 - mx, y1: vr.y1 - my, x2: vr.x2 + mx, y2: vr.y2 + my };
      let sk = k * Math.min(dpr, 1.5);
      const area = (rect.x2 - rect.x1) * (rect.y2 - rect.y1) * sk * sk;
      if (area > 12e6) sk *= Math.sqrt(12e6 / area);
      sceneCanvas.width = Math.ceil((rect.x2 - rect.x1) * sk);
      sceneCanvas.height = Math.ceil((rect.y2 - rect.y1) * sk);
      sceneCtx.setTransform(sk, 0, 0, sk, -rect.x1 * sk, -rect.y1 * sk);
      drawScene(sceneCtx, rect, sk / Math.min(dpr, 1.5));
      scene = { k: sk, rect };
    }
    const c = lodCtx;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, lodCanvas.width, lodCanvas.height);
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.imageSmoothingEnabled = true;
    const r = scene.rect;
    c.drawImage(sceneCanvas, view.x + r.x1 * k, view.y + r.y1 * k, (r.x2 - r.x1) * k, (r.y2 - r.y1) * k);
  }

  // Draw the graph as shapes into ctx (already transformed to world coords).
  // k is the zoom it will be seen at: it picks the level of detail.
  function drawScene(c, r, k) {
    const px = 1 / k; // one screen pixel in world units
    const q = searchQ.trim().toLowerCase();
    const sel = !!selection;

    for (const f of frameBoxes) {
      if (!overlaps(r, { x1: f.x, y1: f.y, x2: f.x + f.w, y2: f.y + f.h })) continue;
      c.globalAlpha = sel || q ? 0.04 : 0.08;
      c.fillStyle = f.color;
      c.fillRect(f.x, f.y, f.w, f.h);
      c.globalAlpha = sel || q ? 0.12 : 0.3;
      c.fillRect(f.x, f.y, f.w, 34);
      c.globalAlpha = 0.5;
      c.strokeStyle = f.color;
      c.lineWidth = px;
      c.strokeRect(f.x, f.y, f.w, f.h);
    }

    // wires: one path per kind (and highlight state) → few stroke calls
    const groups = new Map();
    for (const w of wires) {
      if (!overlaps(r, w.bb)) continue;
      const key = w.e.kind + (w.hl ? ':hl' : '');
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(w);
    }
    for (const [key, list] of groups) {
      const [kind, hl] = key.split(':');
      c.beginPath();
      for (const w of list) {
        const p = w.q;
        c.moveTo(p[0], p[1]);
        c.bezierCurveTo(p[2], p[3], p[4], p[5], p[6], p[7]);
      }
      c.strokeStyle = KIND_COLOR[kind];
      c.globalAlpha = hl ? 1 : (sel || q ? 0.06 : (k >= 0.5 ? 0.85 : kind === 'uses' ? 0.35 : 0.45));
      c.lineWidth = hl ? Math.max(3, 2.6 * px) : Math.max(1.6, 1.1 * px);
      const dp = Math.max(1, px);
      c.setLineDash(kind === 'implements' || kind === 'dispatch' || kind === 'ref' || kind === 'member' ? [8 * dp, 5 * dp] : []);
      c.stroke();
    }
    c.setLineDash([]);

    const showTitle = k >= 0.18;
    const showBars = k >= 0.25 && k < 0.45;
    const showText = k >= 0.45;
    const mono = 'Menlo, Consolas, "DejaVu Sans Mono", monospace';
    c.textBaseline = 'middle';
    for (const card of visible.cards) {
      const p = pos.get(card.id), m = meas.get(card.id);
      if (!p || !m || !overlaps(r, { x1: p.x, y1: p.y, x2: p.x + m.w, y2: p.y + m.h })) continue;
      let alpha = 1;
      if (sel && selection.card !== card.id && !linkedCards.has(card.id)) alpha = 0.3;
      if (q && !cardMatches(card.id, q)) alpha = 0.22;
      c.globalAlpha = alpha;
      const hh = m.hdrY * 2;
      c.fillStyle = '#121214';
      c.fillRect(p.x, p.y, m.w, m.h);
      c.fillStyle = fillOf(card);
      c.fillRect(p.x, p.y, m.w, hh);
      if (card.kind === 'layer' && card.snap) drawLayerMini(c, card, p, m, hh);
      if (showBars) {
        c.fillStyle = '#5a5a5a';
        for (const row of m.list) c.fillRect(p.x + 14, row.y + p.y - 2, Math.min(m.w * 0.55, 140), 4);
      } else if (showText) {
        c.font = `11.5px ${mono}`;
        for (const row of m.list) {
          const y = p.y + row.y;
          let x = p.x + 16;
          if (row.nm) {
            c.fillStyle = row.priv ? '#a9a9a9' : '#e8e8e8';
            c.fillText(row.nm, x, y);
            x += c.measureText(row.nm).width + 7;
          }
          if (row.sg) {
            c.fillStyle = '#8d8d8d';
            c.fillText(row.sg, x, y, Math.max(10, p.x + m.w - 16 - x));
          }
          if (row.ty) {
            c.fillStyle = '#e6b45a';
            c.textAlign = 'right';
            c.fillText(row.ty, p.x + m.w - 16, y, m.w * 0.6);
            c.textAlign = 'left';
          }
        }
      }
      if (m.more && k >= 0.25) {
        c.fillStyle = '#2b2b2b';
        c.fillRect(p.x + 6, p.y + m.more.y + 3, m.w - 12, m.more.h - 6);
      }
      if (showTitle) {
        c.font = `600 13px ${mono}`;
        c.fillStyle = '#fff';
        c.fillText(card.name, p.x + 38, p.y + m.hdrY, m.w - 60);
      }
      if (selection && selection.card === card.id) {
        c.strokeStyle = '#f0a030'; c.lineWidth = Math.max(2, 3 * px); c.strokeRect(p.x, p.y, m.w, m.h);
      } else if (S.focus && ownerOf(S.focus.id) === card.id) {
        c.strokeStyle = '#f0a030'; c.lineWidth = Math.max(2, 2 * px); c.strokeRect(p.x, p.y, m.w, m.h);
      } else if (q && alpha === 1) {
        c.strokeStyle = '#ffe066'; c.lineWidth = Math.max(2, 2 * px); c.strokeRect(p.x, p.y, m.w, m.h);
      }
    }

    // frame buttons (collapse / hide) so they work at any zoom
    for (const f of frameBoxes) {
      const bs = frameButtons(f, k);
      if (!bs) continue;
      for (const bt of bs) {
        if (!overlaps(r, { x1: bt.x, y1: bt.y, x2: bt.x + bt.s, y2: bt.y + bt.s })) continue;
        c.globalAlpha = 0.9;
        c.fillStyle = 'rgba(0,0,0,.55)';
        c.fillRect(bt.x, bt.y, bt.s, bt.s);
        c.globalAlpha = 1;
        c.fillStyle = '#fff';
        c.font = `${bt.s * 0.7}px -apple-system, "Segoe UI", sans-serif`;
        c.textAlign = 'center';
        c.textBaseline = 'middle';
        c.fillText(bt.act === 'fcollapse' ? '▾' : '✕', bt.x + bt.s / 2, bt.y + bt.s / 2 + bt.s * 0.04);
        c.textAlign = 'left';
      }
    }

    // package names stay readable at any zoom
    c.globalAlpha = 1;
    c.fillStyle = '#fff';
    c.textBaseline = 'top';
    const fs = Math.max(16, 13 * px);
    c.font = `600 ${fs}px -apple-system, "Segoe UI", sans-serif`;
    // greedy placement, biggest packages first: skip labels that would overlap
    const placed = [];
    for (const f of [...frameBoxes].sort((a, b) => b.n - a.n)) {
      if (!overlaps(r, { x1: f.x, y1: f.y, x2: f.x + f.w, y2: f.y + f.h })) continue;
      if (f.w * k < 40) continue;
      // a label taller than the frame's title band goes above the frame
      const y = fs > 30 ? f.y - fs - 3 * px : f.y + 6;
      const w = Math.min(c.measureText(f.short).width, Math.max(f.w - 16, 200 * px));
      const box = { x1: f.x + 8, y1: y, x2: f.x + 8 + w, y2: y + fs };
      if (placed.some((b) => overlaps(b, box))) continue;
      placed.push(box);
      c.fillText(f.short, f.x + 8, y, w);
    }
    c.textBaseline = 'alphabetic';
  }

  function fillOf(card) {
    if (card.kind === 'layer') return (pkgInfo.get(card.pkg) || {}).color || '#666';
    return KIND_FILL[card.kind] || '#555';
  }

  // the layer's miniature, scaled into its card body
  function drawLayerMini(c, card, p, m, hh) {
    const rs = card.snap.rects;
    let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
    for (const r of rs) { x1 = Math.min(x1, r.x); y1 = Math.min(y1, r.y); x2 = Math.max(x2, r.x + r.w); y2 = Math.max(y2, r.y + r.h); }
    if (x1 === Infinity) return;
    const bw = m.w - 16, bh = m.h - hh - 34;
    const sc = Math.min(bw / (x2 - x1), bh / (y2 - y1));
    const ox = p.x + 8 + (bw - (x2 - x1) * sc) / 2 - x1 * sc, oy = p.y + hh + 6 + (bh - (y2 - y1) * sc) / 2 - y1 * sc;
    for (const r of rs) {
      c.fillStyle = '#1c1c20';
      c.fillRect(ox + r.x * sc, oy + r.y * sc, r.w * sc, r.h * sc);
      c.fillStyle = KIND_FILL[r.kind] || '#555';
      c.fillRect(ox + r.x * sc, oy + r.y * sc, r.w * sc, Math.max(1, r.hh * sc));
    }
  }

  function bounds(ids) {
    let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
    for (const id of ids) {
      const p = pos.get(id), m = meas.get(id);
      if (!p || !m) continue;
      x1 = Math.min(x1, p.x); y1 = Math.min(y1, p.y);
      x2 = Math.max(x2, p.x + m.w); y2 = Math.max(y2, p.y + m.h);
    }
    if (x1 === Infinity) return null;
    if (S.groupByPkg) { x1 -= FRAME_PAD.left; y1 -= FRAME_PAD.top; x2 += FRAME_PAD.right; y2 += FRAME_PAD.bottom; }
    return { x1, y1, x2, y2 };
  }

  function fitView(ids) {
    const b = bounds(ids || visible.cards.map((c) => c.id));
    if (!b) return applyView();
    const W = viewport.clientWidth, H = viewport.clientHeight, pad = 40;
    // keep the focus banner from covering the top cards
    const bar = $('#focusbar');
    const top = bar && bar.style.display === 'block' ? bar.offsetTop + bar.offsetHeight + 16 : pad;
    const k = Math.max(0.04, Math.min(1.1, Math.min((W - pad * 2) / (b.x2 - b.x1), (H - top - pad) / (b.y2 - b.y1))));
    view = { k, x: (W - (b.x2 - b.x1) * k) / 2 - b.x1 * k, y: top + (H - top - pad - (b.y2 - b.y1) * k) / 2 - b.y1 * k };
    applyView();
  }

  function centerOn(id) {
    const p = pos.get(id), m = meas.get(id);
    if (!p || !m) return;
    const k = Math.max(view.k, 0.75);
    view = { k, x: viewport.clientWidth / 2 - (p.x + m.w / 2) * k, y: viewport.clientHeight / 2 - (p.y + m.h / 2) * k };
    applyView();
    const el = cardEls.get(id);
    if (el) { el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash'); }
  }

  function zoomAt(cx, cy, factor) {
    const k = Math.max(0.03, Math.min(2.5, view.k * factor));
    const f = k / view.k;
    view = { k, x: cx - (cx - view.x) * f, y: cy - (cy - view.y) * f };
    markMoving(true);
    applyView();
  }

  function toWorld(clientX, clientY) {
    const r = viewport.getBoundingClientRect();
    return { x: (clientX - r.left - view.x) / view.k, y: (clientY - r.top - view.y) / view.k };
  }

  // ------------------------------------------------------------------ minimap

  let mmRaf = 0;
  let mmMap = null;
  function drawMinimap() {
    if (mmRaf) return;
    mmRaf = requestAnimationFrame(() => {
      mmRaf = 0;
      const c2 = minimap.getContext('2d');
      const W = minimap.width, H = minimap.height;
      c2.clearRect(0, 0, W, H);
      const b = bounds(visible.cards.map((c) => c.id));
      if (!b) return;
      const vw = viewport.clientWidth, vh = viewport.clientHeight;
      const vx1 = -view.x / view.k, vy1 = -view.y / view.k, vx2 = vx1 + vw / view.k, vy2 = vy1 + vh / view.k;
      const x1 = Math.min(b.x1, vx1), y1 = Math.min(b.y1, vy1), x2 = Math.max(b.x2, vx2), y2 = Math.max(b.y2, vy2);
      const s = Math.min((W - 16) / (x2 - x1), (H - 16) / (y2 - y1));
      const ox = (W - (x2 - x1) * s) / 2 - x1 * s, oy = (H - (y2 - y1) * s) / 2 - y1 * s;
      mmMap = { s, ox, oy };
      for (const c of visible.cards) {
        const p = pos.get(c.id), m = meas.get(c.id);
        if (!p || !m) continue;
        c2.fillStyle = fillOf(c);
        c2.fillRect(ox + p.x * s, oy + p.y * s, Math.max(1.5, m.w * s), Math.max(1.5, m.h * s));
      }
      c2.strokeStyle = '#f0a030';
      c2.lineWidth = 2;
      c2.strokeRect(ox + vx1 * s, oy + vy1 * s, (vx2 - vx1) * s, (vy2 - vy1) * s);
    });
  }

  function minimapNav(ev) {
    if (!mmMap) return;
    const r = minimap.getBoundingClientRect();
    const mx = (ev.clientX - r.left) * (minimap.width / r.width), my = (ev.clientY - r.top) * (minimap.height / r.height);
    const wx = (mx - mmMap.ox) / mmMap.s, wy = (my - mmMap.oy) / mmMap.s;
    view.x = viewport.clientWidth / 2 - wx * view.k;
    view.y = viewport.clientHeight / 2 - wy * view.k;
    markMoving(false);
    applyView();
  }
  minimap.addEventListener('pointerdown', (ev) => {
    ev.stopPropagation();
    minimap.setPointerCapture(ev.pointerId);
    minimapNav(ev);
    const move = (e) => minimapNav(e);
    const up = () => { minimap.removeEventListener('pointermove', move); minimap.removeEventListener('pointerup', up); };
    minimap.addEventListener('pointermove', move);
    minimap.addEventListener('pointerup', up);
  });

  // ------------------------------------------------------------------ hit testing

  // ▾ / ✕ squares in a frame's top-right corner, a constant ~18px on screen.
  function frameButtons(f, k) {
    const px = 1 / k, s = 18 * px, gap = 4 * px, pad = 6 * px;
    if (f.w * k < 90) return null;
    const y = f.y + pad;
    return [
      { act: 'fcollapse', pkg: f.pkg, x: f.x + f.w - pad - s * 2 - gap, y, s },
      { act: 'fhide', pkg: f.pkg, x: f.x + f.w - pad - s, y, s },
    ];
  }

  // Hit test in world coordinates, used by the canvas renderer.
  function hitTest(clientX, clientY) {
    const pt = toWorld(clientX, clientY);
    for (let i = visible.cards.length - 1; i >= 0; i--) {
      const id = visible.cards[i].id;
      const p = pos.get(id), m = meas.get(id);
      if (!p || !m || pt.x < p.x || pt.x > p.x + m.w || pt.y < p.y || pt.y > p.y + m.h) continue;
      const ly = pt.y - p.y;
      let ep = id, best = Infinity;
      if (ly > m.hdrY * 2) {
        for (const [rid, y] of m.rows) {
          const d = Math.abs(y - ly);
          if (d < best && d < 10) { best = d; ep = rid; }
        }
      }
      return { card: id, ep };
    }
    for (const f of frameBoxes) {
      for (const bt of frameButtons(f, view.k) || []) {
        if (pt.x >= bt.x && pt.x <= bt.x + bt.s && pt.y >= bt.y && pt.y <= bt.y + bt.s) {
          return { fbtn: { dataset: { [bt.act]: bt.pkg } } };
        }
      }
    }
    for (const f of frameBoxes) {
      if (pt.x >= f.x && pt.x <= f.x + f.w && pt.y >= f.y && pt.y <= f.y + Math.max(34, 20 / view.k)) return { pkg: f.pkg };
    }
    return {};
  }

  // What is under the pointer, in either render mode.
  function targetAt(ev) {
    if (lod) return hitTest(ev.clientX, ev.clientY);
    const t = ev.target;
    if (!t.closest) return {};
    const dd = t.closest('.dd');
    if (dd) return { dd };
    const fb = t.closest('.fbtn');
    if (fb) return { fbtn: fb };
    const xp = t.closest('.xp');
    if (xp) return { xp: xp.dataset.xp };
    const mr = t.closest('.mr');
    if (mr) return { more: mr };
    const cardEl = t.closest('.card');
    if (cardEl) {
      const row = t.closest('[data-ep]');
      return { card: cardEl.dataset.card, ep: row ? row.dataset.ep : cardEl.dataset.card };
    }
    const fh = t.closest('.fh');
    if (fh) return { pkg: fh.dataset.pkg };
    const hit = t.closest('.hit');
    if (hit && hit.__wire) return { wire: hit.__wire };
    return {};
  }

  // ------------------------------------------------------------------ pointer interaction

  viewport.addEventListener('pointerdown', (ev) => {
    hideCtx();
    if (ev.target.closest('#minimap, #layers, #focusbar')) return;
    const t = targetAt(ev);
    if (t.fbtn) {
      if (ev.button !== 0) return;
      const d = t.fbtn.dataset;
      if (d.explode) explodeType(d.explode);
      else if (d.implode) implodeType(d.implode);
      else if (d.rets) toggleReturns(d.rets);
      else if (d.fcollapse) collapseLayer(d.fcollapse);
      else if (d.lexpand) expandLayer(d.lexpand);
      else if (d.fhide) hideLayer(d.fhide);
      return;
    }
    if (t.dd) {
      // clicks inside an info dropdown; plain presses fall through to text selection
      const el = ev.target;
      const close = el.closest('[data-ddclose]');
      const go = el.closest('[data-go]');
      const open = el.closest('[data-open]');
      if (close) toggleInfo(close.dataset.ddclose);
      else if (go) goTo(go.dataset.go, t.dd.dataset.dd);
      else if (open) { const n = byId.get(open.dataset.open); if (n) openSource(n.file, n.line); }
      return;
    }
    if (t.xp) { if (ev.button === 0) toggleInfo(t.xp); return; }
    if (t.more) {
      if (ev.button !== 0) return;
      const d = t.more.dataset;
      if (d.unrel) collapseRel(d.card, d.unrel); else revealRel(d.card, d.rel);
      return;
    }
    const start = { x: ev.clientX, y: ev.clientY };
    if (ev.button === 1 || (ev.button === 0 && !t.card && !t.pkg)) {
      drag = { mode: 'pan', start, view: { ...view }, moved: false };
      viewport.classList.add('panning');
    } else if (ev.button === 0 && t.card) {
      const id = t.card;
      drag = { mode: 'card', start, ids: [id], orig: [{ ...pos.get(id) }], moved: false, id, ep: t.ep };
      const el = cardEls.get(id);
      if (el) el.classList.add('dragging');
    } else if (ev.button === 0 && t.pkg) {
      const ids = visible.cards.filter((c) => c.pkg === t.pkg).map((c) => c.id);
      drag = { mode: 'frame', start, ids, orig: ids.map((id) => ({ ...pos.get(id) })), moved: false };
    } else return;
    drag.pointerId = ev.pointerId;
  });

  viewport.addEventListener('pointermove', (ev) => {
    if (!drag) return hover(ev);
    const dx = ev.clientX - drag.start.x, dy = ev.clientY - drag.start.y;
    if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 4) return;
    if (!drag.moved) {
      // capture only once a real drag starts, so plain clicks keep their targets
      try { viewport.setPointerCapture(drag.pointerId); } catch { /* pointer gone */ }
      if (drag.mode === 'pan' && !lod) world.style.willChange = 'transform';
    }
    drag.moved = true;
    if (drag.mode === 'pan') {
      view.x = drag.view.x + dx;
      view.y = drag.view.y + dy;
      markMoving(false);
      applyView();
    } else {
      drag.ids.forEach((id, i) => {
        pos.set(id, { x: drag.orig[i].x + dx / view.k, y: drag.orig[i].y + dy / view.k });
        placeCard(id);
      });
      updateWiresFor(drag.ids);
      if (!drag.frameRaf) drag.frameRaf = requestAnimationFrame(() => { if (drag) drag.frameRaf = 0; renderFrames(); });
    }
  });

  function endDrag(ev) {
    if (!drag) return;
    const d = drag;
    drag = null;
    viewport.classList.remove('panning');
    for (const el of cardsEl.querySelectorAll('.dragging')) el.classList.remove('dragging');
    if (d.mode !== 'pan' && d.moved) { renderFrames(); applyView(); }
    if (!d.moved) {
      if (d.mode === 'pan' && ev.button === 0) select(null);
      if (d.mode === 'card') select(d.id, d.ep);
    }
  }
  viewport.addEventListener('pointerup', endDrag);
  viewport.addEventListener('pointercancel', endDrag);

  viewport.addEventListener('wheel', (ev) => {
    // let info dropdowns scroll natively
    if (!lod && !ev.ctrlKey && ev.target.closest && ev.target.closest('.dd-code, .dd-rel')) return;
    if (ev.target.closest && ev.target.closest('#layers, #focusbar')) return;
    ev.preventDefault();
    const r = viewport.getBoundingClientRect();
    const cx = ev.clientX - r.left, cy = ev.clientY - r.top;
    const isMouseWheel = ev.deltaMode !== 0 || (ev.deltaX === 0 && Number.isInteger(ev.deltaY) && Math.abs(ev.deltaY) >= 50);
    if (ev.ctrlKey || ev.metaKey || isMouseWheel) {
      const delta = ev.deltaMode === 1 ? ev.deltaY * 16 : ev.deltaY;
      zoomAt(cx, cy, Math.exp(-delta * (ev.ctrlKey ? 0.01 : 0.0015)));
    } else {
      view.x -= ev.deltaX;
      view.y -= ev.deltaY;
      if (!lod) world.style.willChange = 'transform';
      markMoving(false);
      applyView();
    }
  }, { passive: false });

  viewport.addEventListener('dblclick', (ev) => {
    if (ev.target.closest && ev.target.closest('#layers, #focusbar')) return;
    const t = targetAt(ev);
    if (t.fbtn) return;
    if (t.card && t.card.startsWith('layer:')) return expandLayer(byId.get(t.card).pkg);
    if (t.pkg && !t.card) return collapseLayer(t.pkg);
    if (t.dd || t.xp || t.more) return;
    if (t.wire) {
      const e = t.wire.e;
      const site = e.sites && e.sites[0];
      if (site) return openSource(site.file, site.line);
      const n = byId.get(e.from) || byId.get(ownerOf(e.from));
      if (n) openSource(n.file, n.line);
      return;
    }
    if (!t.ep) return;
    const n = byId.get(t.ep);
    if (n) return openSource(n.file, n.line);
    // struct field row: "Type#field"
    const owner = byId.get(ownerOf(t.ep));
    if (!owner) return;
    const fname = t.ep.slice(t.ep.lastIndexOf('#') + 1);
    const f = (owner.fields || []).find((x) => x.name === fname);
    openSource(owner.file, f ? f.line : owner.line);
  });

  function openSource(file, line) {
    vscode.postMessage({ type: 'open', file, line });
  }

  // tooltips for wires and symbols
  let hoverW = null;
  function hover(ev) {
    if (moving) return;
    const t = targetAt(ev);
    const w = t.wire;
    if (w !== hoverW) {
      if (hoverW) hoverW.path.classList.remove('hover');
      hoverW = w || null;
      if (hoverW) hoverW.path.classList.add('hover');
    }
    if (w) {
      const e = w.e;
      const named = e.label && !(e.kind === 'grpc' && GRPC_LABELS.has(e.label));
      let s = `<code>${esc(displayName(e.from))}${named ? '.' + esc(e.label) : ''}</code>  →  <code>${esc(displayName(e.to))}</code>\n${KIND_LABEL[e.kind]}${e.kind === 'grpc' && GRPC_LABELS.has(e.label) ? ' · ' + e.label : ''}${e.count > 1 ? ' ×' + e.count : ''}`;
      if (e.sites && e.sites.length) s += '\n' + e.sites.slice(0, 5).map((x) => `${x.file}:${x.line}`).join('\n') + (e.sites.length > 5 ? '\n…' : '') + '\n(double-click: open call site)';
      showTip(ev, s);
      return;
    }
    if (t.ep && !t.dd) {
      const n = byId.get(t.ep);
      if (n && n.kind === 'layer') {
        showTip(ev, `Слой <code>${esc(n.pkg)}</code>\n${n.members.length} карточек свёрнуто — провода идут к миниатюре.\nДвойной клик или ▸ — развернуть.`);
        return;
      }
      if (n) {
        showTip(ev, `<code>${esc(declLine(n))}</code>\n${esc(shortPkg(n.pkg))} · ${esc(n.file)}:${n.line}${n.doc ? '\n\n' + esc(n.doc) : ''}`);
        return;
      }
    }
    hideTip();
  }
  viewport.addEventListener('pointerleave', hideTip);

  function showTip(ev, html) {
    tooltip.innerHTML = html;
    tooltip.style.display = 'block';
    const x = Math.min(ev.clientX + 14, window.innerWidth - tooltip.offsetWidth - 8);
    const y = Math.min(ev.clientY + 16, window.innerHeight - tooltip.offsetHeight - 8);
    tooltip.style.left = x + 'px';
    tooltip.style.top = y + 'px';
  }
  function hideTip() { tooltip.style.display = 'none'; }

  // ------------------------------------------------------------------ context menu

  viewport.addEventListener('contextmenu', (ev) => {
    ev.preventDefault();
    const t = targetAt(ev);
    if (t.dd) return;
    const items = [];
    const onlyLayer = (pkg) => () => { setHiddenPkgs([...pkgInfo.keys()].filter((p) => p !== pkg)); rebuild({ relayout: true, fit: true }); };
    if (t.card && t.card.startsWith('layer:')) {
      const pkg = byId.get(t.card).pkg;
      select(t.card, null);
      items.push(['Развернуть слой', () => expandLayer(pkg)]);
      items.push(['Скрыть слой', () => hideLayer(pkg)]);
      items.push(['Только этот слой', onlyLayer(pkg)]);
    } else if (t.pkg && !t.card) {
      items.push(['Свернуть слой', () => collapseLayer(t.pkg)]);
      items.push(['Скрыть слой', () => hideLayer(t.pkg)]);
      items.push(['Только этот слой', onlyLayer(t.pkg)]);
      items.push(null);
      items.push(['Свернуть все остальные слои', () => {
        const others = [...new Set(visible.cards.filter((c) => c.kind !== 'layer' && c.pkg !== t.pkg).map((c) => c.pkg))];
        for (const p of others) snapLayer(p);
        S.collapsedPkgs = [...new Set([...S.collapsedPkgs, ...others])];
        rebuild();
      }]);
    } else if (t.card) {
      const cardId = t.card;
      let target = t.ep || cardId;
      if (!byId.has(target)) target = cardId; // field rows act on the type
      select(cardId, target);
      const name = displayName(target);
      items.push([`Focus on ${name}`, () => { S.dir = 'both'; setFocus(target); }]);
      items.push(['Callers ←', () => { S.dir = 'in'; setFocus(target); }]);
      items.push(['Callees →', () => { S.dir = 'out'; setFocus(target); }]);
      items.push([`Show only ${byId.get(cardId).name}`, () => setFocus(cardId, { depth: 0 })]);
      const rel = visible.hiddenRel.get(cardId);
      if (rel && rel.size) {
        items.push(null);
        for (const r of RELS) if (rel.has(r.key)) items.push([`Show ${r.label} (${rel.get(r.key).size})`, () => revealRel(cardId, r.key)]);
      }
      items.push(null);
      items.push([S.open.includes(target) ? 'Hide code info' : 'Code info', () => toggleInfo(target)]);
      items.push(['Open source', () => { const n = byId.get(target); openSource(n.file, n.line); }]);
      const cc = byId.get(cardId);
      if (cc.parent && explodedSet.has(cc.parent)) items.push([`Свернуть методы обратно в ${byId.get(cc.parent).name}`, () => implodeType(cc.parent)]);
      else if (EXPLODABLE.has(cc.kind) && (membersOf.get(cc.id) || []).some(memberVisible)) {
        items.push(explodedSet.has(cc.id)
          ? ['Свернуть методы обратно', () => implodeType(cc.id)]
          : ['Вынести методы в отдельные блоки', () => explodeType(cc.id)]);
      }
      if (cc.returns && cc.returns.length && !S.compact) {
        items.push([S.retOpen.includes(cc.id) ? 'Скрыть возвращаемый тип' : 'Показать возвращаемый тип', () => toggleReturns(cc.id)]);
      }
      items.push(['Hide node', () => {
        S.hiddenCards.push(cardId);
        S.extra = S.extra.filter((id) => id !== cardId);
        rebuild({ relayout: true });
      }]);
      if (!S.focus) {
        const c = byId.get(cardId);
        items.push(['Only this package', () => { setHiddenPkgs([...pkgInfo.keys()].filter((p) => p !== c.pkg)); rebuild({ relayout: true, fit: true }); }]);
        items.push(['Hide this package', () => { setHiddenPkgs([...S.hiddenPkgs, c.pkg]); rebuild({ relayout: true, fit: true }); }]);
      }
    } else {
      items.push(['Fit view', () => fitView()]);
      items.push(['Auto-layout', () => rebuild({ reset: true, fit: true })]);
      if (S.open.length) items.push(['Close all code info', () => { S.open = []; for (const id of cardEls.keys()) renderDropdowns(id); saveState(); }]);
      if (S.focus) items.push(['Exit focus', () => setFocus(null)]);
    }
    ctx.innerHTML = '';
    for (const it of items) {
      if (!it) { ctx.append(document.createElement('hr')); continue; }
      const d = document.createElement('div');
      d.textContent = it[0];
      d.onclick = () => { hideCtx(); it[1](); };
      ctx.append(d);
    }
    ctx.style.display = 'block';
    ctx.style.left = Math.min(ev.clientX, window.innerWidth - ctx.offsetWidth - 4) + 'px';
    ctx.style.top = Math.min(ev.clientY, window.innerHeight - ctx.offsetHeight - 4) + 'px';
  });
  function hideCtx() { ctx.style.display = 'none'; }
  window.addEventListener('blur', hideCtx);

  // ------------------------------------------------------------------ search

  const searchEl = $('#search');
  const resultsEl = $('#results');
  let results = [], resultIdx = 0;

  function runSearch() {
    searchQ = searchEl.value;
    const q = searchQ.trim().toLowerCase();
    applySearch();
    if (!q || !G) { resultsEl.classList.remove('open'); results = []; return; }
    const scored = [];
    for (const n of G.nodes) {
      if (!CARD_KINDS.has(n.kind) && !(n.parent && byId.has(n.parent))) continue;
      const full = displayName(n.id).toLowerCase();
      const nm = n.name.toLowerCase();
      let s = -1;
      if (nm === q) s = 0; else if (nm.startsWith(q)) s = 1; else if (full.includes(q)) s = 2; else if (nm.includes(q)) s = 3;
      if (s >= 0) scored.push([s, full.length, n]);
    }
    scored.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    results = scored.slice(0, 40).map((x) => x[2]);
    resultIdx = 0;
    resultsEl.innerHTML = results.map((n, i) =>
      `<div class="r${i === 0 ? ' act' : ''}" data-i="${i}"><span class="n">${esc(KIND_ICON[n.kind] || 'm')} ${esc(displayName(n.id))}</span><span class="p">${esc(shortPkg(n.pkg))}</span></div>`,
    ).join('') || '<div class="r"><span class="p">no matches</span></div>';
    resultsEl.classList.add('open');
  }

  function pickResult(i) {
    const n = results[i];
    if (!n) return;
    resultsEl.classList.remove('open');
    searchEl.value = '';
    searchQ = '';
    searchEl.blur();
    const owner = ownerOf(n.id);
    if (visible.vis.has(owner) && !S.focus) {
      applySearch();
      select(owner, n.id);
      centerOn(owner);
    } else {
      setFocus(n.id);
    }
  }

  searchEl.addEventListener('input', runSearch);
  searchEl.addEventListener('focus', runSearch);
  searchEl.addEventListener('blur', () => setTimeout(() => resultsEl.classList.remove('open'), 150));
  searchEl.addEventListener('keydown', (ev) => {
    if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
      ev.preventDefault();
      resultIdx = Math.max(0, Math.min(results.length - 1, resultIdx + (ev.key === 'ArrowDown' ? 1 : -1)));
      for (const r of resultsEl.children) r.classList.toggle('act', +r.dataset.i === resultIdx);
      const act = resultsEl.children[resultIdx];
      if (act) act.scrollIntoView({ block: 'nearest' });
    } else if (ev.key === 'Enter') {
      ev.preventDefault();
      pickResult(resultIdx);
    } else if (ev.key === 'Escape') {
      searchEl.value = '';
      runSearch();
      searchEl.blur();
    }
  });
  resultsEl.addEventListener('pointerdown', (ev) => {
    const r = ev.target.closest('.r[data-i]');
    if (r) { ev.preventDefault(); pickResult(+r.dataset.i); }
  });

  // ------------------------------------------------------------------ keyboard

  window.addEventListener('keydown', (ev) => {
    if (ev.target.matches && ev.target.matches('input, select')) return;
    if (ev.target.closest && ev.target.closest('.dd')) return;
    if (ev.key === '/' || ((ev.metaKey || ev.ctrlKey) && ev.key === 'f')) { ev.preventDefault(); searchEl.focus(); searchEl.select(); }
    else if (ev.key === 'f' || ev.key === 'F') fitView();
    else if (ev.key === 'l' || ev.key === 'L' || ev.key === 'д' || ev.key === 'Д') $('#t-lenya').click();
    else if ((ev.key === 'e' || ev.key === 'E' || ev.key === 'у' || ev.key === 'У') && selection) {
      const c = byId.get(selection.card);
      if (c && c.parent && explodedSet.has(c.parent)) implodeType(c.parent);
      else if (c && EXPLODABLE.has(c.kind)) (explodedSet.has(c.id) ? implodeType : explodeType)(c.id);
    }
    else if (ev.key === 'i' && selection) toggleInfo(selection.ep || selection.card);
    else if (ev.key === 'Escape') {
      if (ctx.style.display === 'block') hideCtx();
      else if (selection) select(null);
      else if (S.focus) setFocus(null);
    } else if (ev.key === 'Backspace') goBack();
    else if (ev.key === 'Enter' && selection) setFocus(selection.ep || selection.card);
    else if (ev.key === '+' || ev.key === '=') zoomAt(viewport.clientWidth / 2, viewport.clientHeight / 2, 1.2);
    else if (ev.key === '-') zoomAt(viewport.clientWidth / 2, viewport.clientHeight / 2, 1 / 1.2);
  });

  window.addEventListener('resize', () => { scene = null; applyView(); });

  // ------------------------------------------------------------------ messages

  function nodeAt(file, line) {
    let best = null;
    for (const n of G.nodes) {
      if (n.file !== file || line < n.line || line > n.endLine) continue;
      if (!CARD_KINDS.has(n.kind) && !(n.parent && byId.has(n.parent))) continue;
      if (!best || n.endLine - n.line < best.endLine - best.line) best = n;
    }
    return best;
  }

  // File view: only the code of one file; optionally focus the symbol at a line.
  async function applyScope(file, line) {
    S.mode = 'file';
    S.fileScope = file;
    S.focus = null;
    S.history = [];
    S.preFocusView = null;
    await setFocus('file:' + file, { push: false, depth: 0 });
    if (line) {
      const n = nodeAt(file, line);
      if (n) await setFocus(n.id); // Back / "Вернуться к файлу" return to the whole file
    }
  }

  window.addEventListener('message', async (ev) => {
    const m = ev.data;
    switch (m.type) {
      case 'busy':
        if (!G) setBusy(m.text);
        break;
      case 'error':
        showError(m.text);
        break;
      case 'graph': {
        setBusy(null);
        if (m.config) cfgPaths = m.config;
        loadGraph(m.graph);
        S.initialized = true;
        if (m.scope) S.mode = m.scope.mode;
        if (m.initial && m.scope && m.scope.mode === 'file') {
          await applyScope(m.scope.file, m.scope.line);
          break;
        }
        await rebuild({ fit: m.initial && !saved.view });
        if (m.initial && saved.view) applyView();
        break;
      }
      case 'scope': {
        await rebuilding;
        if (G) await applyScope(m.file, m.line);
        break;
      }
      case 'focusAt': {
        await rebuilding;
        if (!G) break;
        const n = nodeAt(m.file, m.line);
        if (n) setFocus(n.id);
        break;
      }
      case 'source': {
        srcCache.set(m.key, m.error ? { error: m.error } : { text: m.text, start: m.start, total: m.total });
        for (const d of cardsEl.querySelectorAll('.dd')) {
          if (d.dataset.key === m.key) d.innerHTML = ddHTML(d.dataset.dd);
        }
        break;
      }
    }
  });

  syncToolbar();
  applyView();
  setBusy('Analyzing…');
  vscode.postMessage({ type: 'ready' });

  // exposed for tests
  window.__bp = {
    S, get pos() { return pos; }, meas, rebuild, setFocus, fitView, centerOn, zoomAt, toggleInfo, revealRel, select, collapseLayer, expandLayer, hideLayer, explodeType, implodeType,
    get frames() { return frameBoxes; },
    get visible() { return visible; }, get wires() { return wires; }, get view() { return view; },
  };
})();
