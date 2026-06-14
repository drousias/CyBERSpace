'use strict';

/* ============================================================================
 * CYBERSPACE — Cyprus Internet Traffic as a Living Galaxy
 * Backend: Express + Socket.io + ws (RIPE RIS Live) + d3-force (layout)
 * ==========================================================================*/

const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const WebSocket = require('ws');
const { forceSimulation, forceManyBody, forceLink, forceX, forceY } = require('d3-force');

// ---------------------------------------------------------------------------
// CONFIG
// ---------------------------------------------------------------------------
const PORT = process.env.PORT || 3000;
// CyIX has no BGP ASN of its own - it's a layer 2 exchange fabric. It is
// represented as a synthetic hub node, fixed at the origin (the "black hole").
const CYIX_ID = 'CYIX';
// Country whose ASNs populate the galaxy (ISO 3166-1 alpha-2).
const COUNTRY_CODE = process.env.COUNTRY_CODE || 'CY';
// The anchor ASes, pulled strongly toward CyIX at the center (default: CYTA, PrimeTel, Cablenet).
const ANCHOR_ASNS = (process.env.ANCHOR_ASNS || '6866,8544,35432')
  .split(',').map((s) => parseInt(s.trim(), 10)).filter((n) => !Number.isNaN(n));
const FALLBACK_ASNS = ANCHOR_ASNS; // used if the RIPE DB seed fetch fails
const EVENT_RETENTION_MS = parseInt(process.env.EVENT_RETENTION_MS, 10) || 10 * 60 * 1000; // 10 minutes
const MAX_SUBSCRIBE_ASNS = parseInt(process.env.MAX_SUBSCRIBE_ASNS, 10) || 200; // cap RIS Live subscriptions (CY has ~130 ASNs)
const POSITION_BROADCAST_MS = parseInt(process.env.POSITION_BROADCAST_MS, 10) || 2000;
const SIM_TICK_MS = parseInt(process.env.SIM_TICK_MS, 10) || 100;
const DECAY_MS = parseInt(process.env.DECAY_MS, 10) || 3000;
const RIS_LIVE_CLIENT_NAME = process.env.RIS_LIVE_CLIENT_NAME || 'cyberspace-galaxy';

// ---------------------------------------------------------------------------
// STATE
// ---------------------------------------------------------------------------
const cyAsnSet = new Set();           // all "Cyprus" ASNs (incl. CyIX)
const nodes = new Map();              // asn -> node object (stars / black hole)
const links = [];                     // [{ a, b, weight }] peering edges
const prefixOwners = new Map();       // prefix -> { asn, path }
const events = [];                    // recent event log (last 10 min)

let simulation = null;

// ---------------------------------------------------------------------------
// HELPERS
// ---------------------------------------------------------------------------
function classifyOrgType(name) {
  const n = (name || '').toUpperCase();
  if (/UNIV|RESEARCH|ACADEM|CYNET|SCIENCE/.test(n)) return 'university';
  if (/GOV(ERNMENT)?\b|MINISTRY|PARLIAMENT|\bMOD\b|MUNICIP/.test(n)) return 'government';
  if (/\bCDN\b|CLOUD|AMAZON|GOOGLE|MICROSOFT|AKAMAI|CLOUDFLARE|FASTLY|OVH|DIGITALOCEAN|AZURE|META\b/.test(n)) return 'cdn';
  if (/TELECOM|CYTA|CABLE|COMMUNICATIONS|PRIMETEL|MOBILE|\bISP\b|NET(WORK)?S?\b|HOSTING/.test(n)) return 'isp';
  return 'unknown';
}

function dedupePath(p) {
  return p.filter((v, i) => i === 0 || v !== p[i - 1]);
}

function edgeKey(a, b) {
  return `${Math.min(a, b)}-${Math.max(a, b)}`;
}

// Simple bounded-concurrency map, tolerant of individual failures.
async function mapLimit(items, limit, fn) {
  const queue = [...items];
  const workers = Array.from({ length: Math.min(limit, queue.length) || 1 }, async () => {
    while (queue.length) {
      const item = queue.shift();
      try { await fn(item); } catch (err) { /* swallow per-item errors */ }
    }
  });
  await Promise.all(workers);
}

function pushEvent(type, data) {
  const evt = { type, data, timestamp: Date.now() };
  events.push(evt);
  io.emit(type, data);
}

function publicNode(node) {
  return {
    asn: node.asn,
    name: node.name,
    type: node.type,
    prefixCount: node.prefixCount,
    peerCount: node.peerCount,
    updateRate: node.updateRate,
    isCyix: node.isCyix,
    x: node.x,
    y: node.y,
  };
}

// ---------------------------------------------------------------------------
// SEED DATA: RIPE DB (CY ASNs) + RIPEstat (org names) + PeeringDB (peering)
// ---------------------------------------------------------------------------
// RIPEstat returns routed/non_routed ASNs as strings like
// "{AsnSingle(6866), AsnSingle(8544), ...}" - extract the numbers.
function extractAsns(setLikeString) {
  return [...String(setLikeString || '').matchAll(/AsnSingle\((\d+)\)/g)].map((m) => parseInt(m[1], 10));
}

async function fetchCyAsns() {
  try {
    const res = await fetch(
      `https://stat.ripe.net/data/country-asns/data.json?resource=${COUNTRY_CODE}&lod=1`,
      { signal: AbortSignal.timeout(20000) }
    );
    if (!res.ok) throw new Error(`RIPEstat returned ${res.status}`);
    const json = await res.json();
    const country = json.data && json.data.countries && json.data.countries[0];
    if (!country) throw new Error('no country data found');
    const asns = [...extractAsns(country.routed), ...extractAsns(country.non_routed)];
    if (!asns.length) throw new Error('no registered ASNs found');
    return [...new Set(asns)];
  } catch (err) {
    console.error('[seed] RIPEstat country-asns fetch failed, using fallback list:', err.message);
    return [...FALLBACK_ASNS];
  }
}

async function fetchOrgInfo(asn) {
  try {
    const res = await fetch(
      `https://stat.ripe.net/data/as-overview/data.json?resource=AS${asn}`,
      { signal: AbortSignal.timeout(8000) }
    );
    if (!res.ok) throw new Error(`stat.ripe.net returned ${res.status}`);
    const json = await res.json();
    const holder = (json.data && json.data.holder) || `AS${asn}`;
    return { name: holder, type: classifyOrgType(holder) };
  } catch (err) {
    return { name: `AS${asn}`, type: 'unknown' };
  }
}

// Builds peering edges by finding ASNs that co-locate on the same PeeringDB
// IX LAN. Weight = number of shared exchange points.
async function fetchPeeringData(asns) {
  const ixMap = new Map(); // ixlan_id -> Set(asn)
  await mapLimit(asns, 5, async (asn) => {
    const res = await fetch(`https://www.peeringdb.com/api/netixlan?asn=${asn}`, {
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`peeringdb returned ${res.status}`);
    const json = await res.json();
    for (const entry of (json.data || [])) {
      if (!ixMap.has(entry.ixlan_id)) ixMap.set(entry.ixlan_id, new Set());
      ixMap.get(entry.ixlan_id).add(asn);
    }
  });
  const weights = new Map();
  for (const asnSet of ixMap.values()) {
    const list = [...asnSet];
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const key = edgeKey(list[i], list[j]);
        weights.set(key, (weights.get(key) || 0) + 1);
      }
    }
  }
  return weights;
}

// ---------------------------------------------------------------------------
// GALAXY STATE: nodes / edges / simulation
// ---------------------------------------------------------------------------
function ensureNode(asn, info = {}) {
  if (nodes.has(asn)) return nodes.get(asn);
  const isCyix = info.isCyix === true;
  const isAnchor = ANCHOR_ASNS.includes(asn);
  const angle = Math.random() * Math.PI * 2;
  // Anchors spawn close to the center; everything else spawns further out
  // and drifts inward via the force layout.
  const radius = isCyix ? 0 : isAnchor ? 20 + Math.random() * 30 : 400 + Math.random() * 300;
  const node = {
    asn,
    name: isCyix ? 'CyIX' : (info.name || `AS${asn}`),
    type: isCyix ? 'cyix' : (info.type || 'unknown'),
    prefixCount: 0,
    peerCount: 0,
    updateRate: 0,
    isCyix,
    x: isCyix ? 0 : Math.cos(angle) * radius,
    y: isCyix ? 0 : Math.sin(angle) * radius,
    vx: 0,
    vy: 0,
  };
  if (isCyix) { node.fx = 0; node.fy = 0; } // black hole fixed at origin
  nodes.set(asn, node);
  rebuildSimulation();
  // Reheat the layout only when a new node appears, so existing stars settle
  // into a stable position and don't jitter on every BGP event.
  simulation.alpha(0.3);
  io.emit('node_added', publicNode(node));
  return node;
}

function ensureEdge(a, b, weightDelta = 1) {
  if (a === b || !nodes.has(a) || !nodes.has(b)) return;
  let edge = links.find((l) => (l.a === a && l.b === b) || (l.a === b && l.b === a));
  if (!edge) {
    edge = { a, b, weight: 0 };
    links.push(edge);
    nodes.get(a).peerCount++;
    nodes.get(b).peerCount++;
  }
  edge.weight += weightDelta;
  // Keep the link force's topology in sync, but do NOT reheat (alpha is left
  // untouched) so this never causes existing stars to reposition.
  rebuildSimulation();
  io.emit('edge_added', { source: edge.a, target: edge.b, weight: edge.weight });
}

// (Re)binds the d3-force simulation to the current nodes/links. Node objects
// (with live x/y/vx/vy) are reused in place so positions persist - this does
// not affect simulation.alpha, so it never reheats the layout by itself.
function rebuildSimulation() {
  const nodeArray = [...nodes.values()];
  const linkObjs = links.map((l) => ({ source: l.a, target: l.b, weight: l.weight }));
  // Links touching the synthetic CyIX hub are short and strongly attractive,
  // pulling the anchor ASes in close to the center.
  const isCyixLink = (l) => l.source.isCyix || l.target.isCyix;
  const linkForce = forceLink(linkObjs).id((d) => d.asn)
    .distance((l) => (isCyixLink(l) ? 25 : 120))
    .strength((l) => (isCyixLink(l) ? 0.9 : Math.min(0.8, 0.1 + l.weight * 0.05)));

  if (!simulation) {
    simulation = forceSimulation(nodeArray)
      .force('charge', forceManyBody().strength(-400))
      .force('link', linkForce)
      .force('x', forceX(0).strength(0.015))
      .force('y', forceY(0).strength(0.015))
      .stop(); // ticked manually below
  } else {
    simulation.nodes(nodeArray);
    simulation.force('link', linkForce);
  }
}

// Asynchronously fills in org name/type for a node once RIPEstat responds.
async function enrichNode(asn) {
  const info = await fetchOrgInfo(asn);
  const node = nodes.get(asn);
  if (!node) return;
  node.name = info.name;
  node.type = info.type;
  io.emit('node_updated', publicNode(node));
}

function bumpUpdateRate(node) {
  node.updateRate = Math.min(50, node.updateRate + 1);
  io.emit('node_updated', publicNode(node));
}

// ---------------------------------------------------------------------------
// BGP PROCESSING (RIPE RIS Live)
// ---------------------------------------------------------------------------
function handleAnnouncement(prefix, fullPath, cyInPath) {
  const path = fullPath;
  const originAsn = path[path.length - 1];
  const prevOwner = prefixOwners.get(prefix);

  // Make sure every CY ASN on this path exists as a star, and register peering
  // edges between consecutive CY ASNs in the path.
  for (const asn of cyInPath) {
    const node = ensureNode(asn);
    if (node.name === `AS${asn}`) enrichNode(asn); // first time we see it
    bumpUpdateRate(node);
  }
  for (let i = 0; i < path.length - 1; i++) {
    if (cyAsnSet.has(path[i]) && cyAsnSet.has(path[i + 1])) ensureEdge(path[i], path[i + 1], 1);
  }

  if (cyAsnSet.has(originAsn)) {
    const node = ensureNode(originAsn);
    if (!prevOwner) {
      node.prefixCount++;
      io.emit('node_updated', publicNode(node));
    }
    prefixOwners.set(prefix, { asn: originAsn, path });

    if (prevOwner && prevOwner.asn === originAsn && JSON.stringify(prevOwner.path) !== JSON.stringify(path)) {
      pushEvent('path_changed', { prefix, asn: originAsn, oldPath: prevOwner.path, newPath: path });
    } else {
      pushEvent('route_announced', { prefix, asn: originAsn, path });
    }
  } else {
    // Transit-only route through CY (no planet, but still draw the nebula trail).
    pushEvent('route_announced', { prefix, path, transit: true });
  }

  detectWormhole(path);
}

// Wormhole: a route that leaves Cyprus ASNs and re-enters via a foreign AS.
function detectWormhole(path) {
  const cyIndices = [];
  path.forEach((asn, i) => { if (cyAsnSet.has(asn)) cyIndices.push(i); });
  if (cyIndices.length < 2) return;
  const first = cyIndices[0];
  const last = cyIndices[cyIndices.length - 1];
  if (last - first < 2) return; // no foreign hop in between
  const foreignBetween = path.slice(first + 1, last).filter((a) => !cyAsnSet.has(a));
  if (!foreignBetween.length) return;
  pushEvent('wormhole', { from: path[first], to: path[last], via: foreignBetween[0] });
}

function handleWithdrawal(prefix, owner) {
  const node = nodes.get(owner.asn);
  if (node) {
    node.prefixCount = Math.max(0, node.prefixCount - 1);
    bumpUpdateRate(node);
  }
  prefixOwners.delete(prefix);
  pushEvent('route_withdrawn', { prefix, asn: owner.asn });
}

function processBgpMessage(data) {
  if (data.type !== 'UPDATE') return;
  const path = dedupePath((data.path || []).filter((p) => typeof p === 'number'));
  const cyInPath = path.filter((asn) => cyAsnSet.has(asn));

  if (cyInPath.length > 0) {
    for (const ann of (data.announcements || [])) {
      for (const prefix of (ann.prefixes || [])) {
        handleAnnouncement(prefix, path, cyInPath);
      }
    }
  }

  for (const w of (data.withdrawals || [])) {
    const prefix = typeof w === 'string' ? w : w.prefix;
    if (!prefix) continue;
    const owner = prefixOwners.get(prefix);
    if (owner && cyAsnSet.has(owner.asn)) handleWithdrawal(prefix, owner);
  }
}

// ---------------------------------------------------------------------------
// RIPE RIS LIVE WEBSOCKET CLIENT
// ---------------------------------------------------------------------------
function connectRisLive() {
  const ws = new WebSocket(`wss://ris-live.ripe.net/v1/ws/?client=${RIS_LIVE_CLIENT_NAME}`);

  ws.on('open', () => {
    console.log('[ris-live] connected, subscribing to CY ASNs');
    const targets = [...cyAsnSet].slice(0, MAX_SUBSCRIBE_ASNS);
    for (const asn of targets) {
      ws.send(JSON.stringify({ type: 'ris_subscribe', data: { type: 'UPDATE', path: String(asn) } }));
    }
  });

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);
      if (msg.type === 'ris_message' && msg.data) processBgpMessage(msg.data);
    } catch (err) { /* ignore malformed frames */ }
  });

  ws.on('close', () => {
    console.warn('[ris-live] connection closed, reconnecting in 5s');
    setTimeout(connectRisLive, 5000);
  });

  ws.on('error', (err) => {
    console.error('[ris-live] error:', err.message);
    ws.close();
  });
}

// ---------------------------------------------------------------------------
// EXPRESS + SOCKET.IO
// ---------------------------------------------------------------------------
const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.static(__dirname)); // allow index.html at project root too

function buildSnapshot() {
  const cutoff = Date.now() - EVENT_RETENTION_MS;
  return {
    cyixId: CYIX_ID,
    nodes: [...nodes.values()].map(publicNode),
    edges: links.map((l) => ({ source: l.a, target: l.b, weight: l.weight })),
    routes: [...prefixOwners.entries()].map(([prefix, o]) => ({ prefix, asn: o.asn, path: o.path })),
    replayEvents: events.filter((e) => e.timestamp >= cutoff),
  };
}

io.on('connection', (socket) => {
  socket.emit('snapshot', buildSnapshot());
});

// Trim old events from the retention window.
setInterval(() => {
  const cutoff = Date.now() - EVENT_RETENTION_MS;
  while (events.length && events[0].timestamp < cutoff) events.shift();
}, 30000);

// Manual simulation ticking (smooth, low CPU).
setInterval(() => {
  if (simulation) simulation.tick();
}, SIM_TICK_MS);

// Broadcast positions + pulse rates every 2s; clients interpolate.
setInterval(() => {
  const positions = {};
  for (const node of nodes.values()) {
    positions[node.asn] = [Math.round(node.x * 100) / 100, Math.round(node.y * 100) / 100, node.updateRate];
  }
  io.emit('position_update', positions);
}, POSITION_BROADCAST_MS);

// Decay star pulse rates over time.
setInterval(() => {
  for (const node of nodes.values()) {
    if (node.updateRate > 0) node.updateRate = Math.max(0, node.updateRate - 1);
  }
}, DECAY_MS);

// ---------------------------------------------------------------------------
// STARTUP
// ---------------------------------------------------------------------------
async function init() {
  const cyAsns = await fetchCyAsns();
  for (const asn of cyAsns) cyAsnSet.add(asn);
  for (const asn of FALLBACK_ASNS) cyAsnSet.add(asn);

  // Synthetic CyIX hub - not a real ASN, fixed at the origin (black hole).
  ensureNode(CYIX_ID, { isCyix: true });

  // Seed all known nodes immediately so the galaxy isn't empty on load.
  for (const asn of cyAsnSet) ensureNode(asn);

  // Strong attraction from the three anchor ASes toward CyIX.
  for (const asn of ANCHOR_ASNS) {
    if (cyAsnSet.has(asn)) ensureEdge(asn, CYIX_ID, 1);
  }

  // Enrich with org names/types (bounded concurrency, non-blocking).
  mapLimit([...cyAsnSet], 5, (asn) => enrichNode(asn));

  // Seed peering edges from PeeringDB (best-effort).
  fetchPeeringData([...cyAsnSet])
    .then((weights) => {
      for (const [key, weight] of weights) {
        const [a, b] = key.split('-').map(Number);
        ensureEdge(a, b, weight);
      }
    })
    .catch((err) => console.error('[seed] PeeringDB fetch failed:', err.message));

  connectRisLive();
}

server.listen(PORT, () => {
  console.log(`CYBERSPACE galaxy server listening on port ${PORT}`);
  init();
});
