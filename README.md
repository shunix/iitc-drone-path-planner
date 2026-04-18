# IITC Drone Path Planner

> [中文文档](README.zh.md)

An [IITC](https://iitc.app/) (Ingress Intel Total Conversion) userscript plugin that automatically calculates the minimum-hop Drone path between two portals on the Ingress Intel map. Drones can only jump up to **500 metres** per hop.

---

## Features

- **Optimal path** — A\* search guarantees the fewest hops
- **Auto data loading** — pans the map to load portal data along the route when the path extends beyond the current view
- **Gap detection** — highlights the unreachable gap when no path exists (red dashed line + 500 m coverage circle)
- **Map visualisation** — yellow polyline with numbered hop labels
- **Sidebar panel** — scrollable portal list; click any portal to pan the map and open its details
- **One-click clear** — reset and re-plan instantly

---

## Installation

1. Install Firefox and the [Tampermonkey](https://www.tampermonkey.net/) extension
2. Install [IITC](https://iitc.app/)
3. Click **[Install Script](https://raw.githubusercontent.com/shunix/iitc-drone-path-planner/main/drone-planner.user.js)** — Tampermonkey will prompt you to install it
4. Open [Ingress Intel](https://intel.ingress.com/) — the plugin loads automatically with IITC

---

## Usage

1. Zoom the map to **level 15 or above** (IITC loads portal data at this zoom level)
2. **Click** any portal on the map — its details appear in the sidebar
3. At the bottom of the portal details panel, two links appear:
   - `✈ 设为 Drone 起点` — set as **start** portal (marked **S** on the map)
   - `✈ 设为 Drone 终点` — set as **end** portal (marked **E** on the map)
4. Once both are set, the **Drone Path Planner** panel shows a **开始计算** button
5. Click it to start the search:
   - Live status updates during search (pan count shown)
   - On success: hop count and total distance displayed; yellow path drawn on the map
   - On failure: gap location highlighted in red
6. Click any portal in the result list to pan the map and open its details
7. Click **清除路径** to reset

---

## Implementation

### Architecture

Single-file IITC userscript, organised into four internal modules:

| Module | Responsibility |
|--------|----------------|
| `Selection` | Listens to `portalDetailsUpdated` hook; injects start/end links into the portal details sidebar panel |
| `Graph` | Reads `window.portals`; computes Haversine distances; returns ≤ 500 m neighbours on demand |
| `Pathfinder` | A\* main loop; map-pan scheduling; gap detection |
| `Renderer` | Leaflet layer management; sidebar panel; result display |

### A\* Search

**Heuristic:** `h = ceil(haversine(current, goal) / 500)`

This heuristic is admissible (never overestimates), so A\* is guaranteed to return an optimal solution.

**Priority queue:** Binary min-heap sorted by `f = g + h`.

**Boundary node handling (`frozenSet`):** When a node has no neighbours in the currently loaded map data, it is placed into `frozenSet` (not `closedSet`) and the map pans toward the goal to load more data. After `mapDataRefreshEnd` fires, frozen nodes are returned to the priority queue.

**Non-blocking execution:** Each A\* step is scheduled with `setTimeout(fn, 0)` to keep the browser responsive. Maximum 20 auto-pans before stopping and running gap detection.

### IITC Integration

- **Portal selection** — uses `portalDetailsUpdated` (the correct hook in current IITC; the legacy `portalContextmenu` hook was removed)
- **Data loading** — listens for `mapDataRefreshEnd` to resume search after map panning
- **Layer management** — registers a "Drone Path" overlay via `layerChooser.addOverlay`; can be toggled in the IITC layer picker

### External Dependencies

Only IITC-provided globals — Leaflet, jQuery, `window.portals`, `window.map`, `window.addHook`, `window.layerChooser`. No third-party libraries.

---

## Development

### Requirements

- Node.js ≥ 18
- Firefox (for Playwright)

### Install dependencies

```bash
npm install
```

### Unit tests

Tests for pure functions: Haversine distance and A\* core logic (optimal path, gap detection, pan-resume round-trip).

```bash
npm test
```

### E2E tests

Playwright drives a local mock-IITC page in Firefox, covering the full user flow.

```bash
npm run test:e2e
```

E2E coverage:
- Plugin load and sidebar initialisation
- Portal details panel injection
- Start / end portal selection and S / E marker display
- 2-hop path (A → B → C), 1-hop path (A → B)
- Gap detection (isolated portal)
- Clear path
- Start == end error handling
- Zoom level guard (< 15)

---

## File Structure

```
drone-planner.user.js       # Plugin — single-file IITC userscript
tests/
  haversine.test.js         # Haversine unit tests
  astar.test.js             # A* unit tests
  e2e/
    drone-planner.spec.js   # Playwright E2E tests
playwright.config.js        # Playwright config (Firefox, headless)
package.json
README.md                   # This file (English)
README.zh.md                # 中文文档
```

---

## License

MIT
