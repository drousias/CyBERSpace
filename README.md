# CyBERSpace

A real-time, browser-based visualization of Cyprus internet traffic, rendered as a living galaxy. Every Autonomous System registered in Cyprus is a star; every BGP route announcement, withdrawal, and path change is a live event rendered in the scene as it happens.

## What is CyBERSpace

CyBERSpace turns the live BGP routing table for Cyprus into a 3D galaxy. Each star is a Cypriot Autonomous System (ISP, university, government network, CDN, etc.), positioned and sized based on its role and announced address space. A synthetic hub node, CyIX, sits at the center representing the Cyprus Internet Exchange. The galaxy is fed in real time from RIPE NCC's RIS Live BGP stream — when an AS announces or withdraws a route, or changes its path, the corresponding star reacts visually. The project exists to make an otherwise invisible piece of infrastructure (inter-AS routing) tangible and explorable, for network engineers, students, and anyone curious about how their country's internet is actually wired together.

## Live Demo

`https://<your-deployment-url>` *(placeholder — update once deployed)*

## How it works — The Data Pipeline

1. **RIPE NCC RIS Live** is a public WebSocket feed (`wss://ris-live.ripe.net/v1/ws/`) that streams BGP UPDATE messages from RIPE's Routing Information Service collectors in near real time. The server subscribes to UPDATE messages for every Autonomous System number (ASN) registered to Cyprus.

2. **What BGP is, briefly**: BGP (Border Gateway Protocol) is the protocol that networks use to tell each other "I can reach this block of IP addresses, and here's the path to get there." Every UPDATE message either *announces* a route (a network claiming reachability to an IP prefix, with the list of ASes the route passes through) or *withdraws* one (a network saying that reachability no longer exists).

3. **What an Autonomous System is**: an AS is a network (or group of networks) under one administrative entity — an ISP, a university, a company — identified by a unique ASN. The global internet is the sum of all ASes agreeing, via BGP, on how to route traffic between each other.

4. **Filtering for Cyprus**: on startup, the server fetches the full list of ASNs registered to Cyprus from the RIPEstat `country-asns` API (~130 ASNs, routed and non-routed). It subscribes to RIS Live for exactly those ASNs (capped at 200) and discards everything else. Every incoming BGP UPDATE is checked against this set — only messages where a Cyprus ASN appears in the AS path are processed further.

5. **Events that drive visuals**: each processed UPDATE produces one or more of: `node_added` (a Cyprus ASN seen for the first time becomes a star), `node_updated` (activity pulse / org info enrichment), `edge_added` (a peering relationship between two Cyprus ASes), `route_announced` (a new prefix claimed by a Cyprus AS, or a transit route passing through), `route_withdrawn` (a prefix no longer reachable), `path_changed` (the AS path to an already-announced prefix changed), and `wormhole` (a route that leaves Cyprus AS space and re-enters via a foreign AS). The frontend maps each of these to a distinct visual effect.

## BGP and ASes explained

The internet is not a single network — it's a federation of tens of thousands of independently operated networks, each one an **Autonomous System**. Your ISP is an AS. A university's campus network is often its own AS. Large cloud providers, content delivery networks, and government networks each run their own AS. Each AS is assigned a unique number (an ASN, e.g. AS6866) and owns one or more blocks of IP addresses.

These ASes don't automatically know how to reach each other. They establish relationships — peering or transit — and exchange routing information using **BGP**, the protocol that has glued the internet together since the early 1990s. When two ASes are connected, they tell each other which IP blocks they can deliver traffic to, and that information propagates outward, AS by AS, until (ideally) every network on the internet has a path to every reachable IP block.

A **route announcement** is an AS saying "I (or someone I'm connected to) can get traffic to this IP prefix, and here is the chain of ASes the traffic will pass through to get there." A **route withdrawal** is the opposite — an AS saying that path no longer exists, usually because of a link failure, a configuration change, or the network going offline. A **path change** happens when the same prefix is still reachable, but the sequence of ASes used to get there has changed — often a sign of a failover to a backup link or a shift in traffic engineering. These announcements and withdrawals happen continuously, globally, all day — RIS Live gives you a firehose of them.

Cyprus has roughly **130 registered ASNs** — a mix of ISPs (CYTA, PrimeTel, Cablenet), the University of Cyprus and other academic/research networks, government networks, and a handful of CDN/cloud presences. CyBERSpace narrows the global BGP firehose down to just the routing activity that touches one of these ~130 networks, and turns each event into something you can watch happen.

## Visual taxonomy

| Visual element | Network meaning |
|---|---|
| Star (sprite + halo, colored by org type) | A Cyprus Autonomous System (AS) |
| Star color: blue | ISP / Telecom |
| Star color: amber | University / Research |
| Star color: green | Government |
| Star color: purple | CDN / Cloud |
| Star color: grey | Unknown / unclassified org |
| Black hole at galaxy center (CyIX) | Synthetic hub node representing the Cyprus Internet Exchange (not a real ASN) |
| Star size | Number of prefixes currently announced by that AS |
| Star breathing pulse | Idle animation — always running, independent of BGP activity |
| Star brightness flash | A `node_updated` / BGP activity event for that AS |
| White flash | `path_changed` — the AS path to a prefix changed |
| Planets + moons orbiting a star | Procedurally generated per-AS "solar system" (decorative, seeded by ASN — not driven by live data) |
| Orbital rings | Static geometry marking each planet's orbit |
| Expanding green ring | `route_announced` — a new prefix announcement |
| Expanding red ring | `route_withdrawn` — a prefix withdrawal |
| Yellow streak | Withdrawal aftermath effect |
| Nebula line trail | The AS path of an announced/changed route |
| Cyan portal / wormhole arc | A route that exits Cyprus AS space and re-enters via a foreign AS |
| Line between two stars | A peering relationship (shared IXP presence, from PeeringDB) |
| Background starfield + galactic plane glow | Static decorative backdrop, rendered once |

## Architecture

### Backend (Node.js)

- **Express** — serves the static frontend (`index.html`) and any assets.
- **Socket.io** — pushes the initial galaxy snapshot to each connecting client, then streams `node_added`, `node_updated`, `edge_added`, `route_announced`, `route_withdrawn`, `path_changed`, `wormhole`, and periodic `position_update` events.
- **ws** — maintains a persistent WebSocket connection to RIPE NCC RIS Live, parses incoming BGP UPDATE messages, and reconnects automatically on disconnect.
- **d3-force** — runs a force-directed layout (`forceManyBody`, `forceLink`, `forceX`/`forceY`) to position stars based on peering relationships and attraction toward the CyIX hub. The simulation is ticked manually on an interval and only reheated (`alpha`) when a new node is added, so existing stars don't jitter on every BGP event.

### Frontend (Three.js, single-file `index.html`)

- Renders the galaxy entirely client-side: sprite-based stars with per-type gradient textures and additive-blended halos, two `InstancedMesh` pools for planets (rocky/gas giant) plus one for moons, a merged-geometry `LineSegments` for all orbital rings, a single static background starfield (`Points`), and a single static galactic-plane glow mesh.
- Object pools for all transient effects (echo stars, shockwave rings, nebula trails, withdrawal streaks) — nothing is created or destroyed at runtime.
- A level-of-detail system updates planet/moon orbital animation only for the 20 stars nearest the camera, recomputed every 2 seconds.
- OrbitControls for camera movement; a ticker, info panel, and landing/about overlay for UI.

### Deployment

- **Oracle Cloud Always Free** — an Ampere (ARM) compute instance running Ubuntu 22.04, hosting the Node.js server under PM2.
- **Cloudflare Tunnel** — exposes the app publicly over HTTPS/WSS without opening inbound ports or running a reverse proxy; Socket.io traffic is proxied transparently.

## Running locally

```bash
git clone https://github.com/<your-org>/CyBERSpace.git
cd CyBERSpace
npm install
node server.js
```

The server listens on port `3000` by default (override with `PORT=<port>`). Open `http://localhost:3000` in a browser.

## Data sources

- **RIPE NCC RIS Live** — public real-time WebSocket feed of BGP UPDATE messages from RIPE's global route collectors; the primary source of all live event data.
- **RIPEstat API** — provides the list of ASNs registered to Cyprus (`country-asns`) and per-AS organization names/holder info (`as-overview`).
- **PeeringDB** — provides peering relationships by identifying which Cyprus ASNs share a presence on the same internet exchange LAN, used to draw peering lines between stars.

## Tech stack

| Layer | Technology |
|---|---|
| Backend runtime | Node.js |
| HTTP server | Express |
| Real-time transport | Socket.io |
| BGP feed client | ws (WebSocket) |
| Graph layout | d3-force |
| 3D rendering | Three.js |
| Process management | PM2 |
| Hosting | Oracle Cloud (Always Free tier) |
| Public exposure | Cloudflare Tunnel |

## Author

**Alexandros Drousiotis**

University of Cyprus - KIOS CoE

Contact me: [adrous02@ucy.ac.cy](mailto:adrous02@ucy.ac.cy)

LinkedIn: [www.linkedin.com/in/drousiotis-alexandros](https://www.linkedin.com/in/drousiotis-alexandros)
