// ==UserScript==
// @id             drone-path-planner
// @name           IITC Plugin: Drone Path Planner
// @category       Layer
// @version        0.2.0
// @description    Calculates minimum-hop drone routes between two portals
// @include        https://intel.ingress.com/*
// @include        https://intel-x.ingress.com/*
// @match          https://intel.ingress.com/*
// @match          https://intel-x.ingress.com/*
// @grant          none
// ==/UserScript==

// ─── Pure functions (top-level for testability) ──────────────────────────────

function haversine(a, b) {
  const R = 6371000;
  const toRad = deg => deg * Math.PI / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const sinLat = Math.sin(dLat / 2);
  const sinLng = Math.sin(dLng / 2);
  const x = sinLat * sinLat +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * sinLng * sinLng;
  return 2 * R * Math.asin(Math.sqrt(x));
}

class MinHeap {
  constructor() { this._d = []; }

  push(item) { this._d.push(item); this._up(this._d.length - 1); }

  pop() {
    const top = this._d[0];
    const last = this._d.pop();
    if (this._d.length > 0) { this._d[0] = last; this._down(0); }
    return top;
  }

  peek() { return this._d[0]; }
  isEmpty() { return this._d.length === 0; }
  toArray() { return [...this._d]; }

  _up(i) {
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this._d[p].f <= this._d[i].f) break;
      [this._d[p], this._d[i]] = [this._d[i], this._d[p]];
      i = p;
    }
  }

  _down(i) {
    const n = this._d.length;
    for (;;) {
      let s = i;
      const l = 2 * i + 1, r = 2 * i + 2;
      if (l < n && this._d[l].f < this._d[s].f) s = l;
      if (r < n && this._d[r].f < this._d[s].f) s = r;
      if (s === i) break;
      [this._d[s], this._d[i]] = [this._d[i], this._d[s]];
      i = s;
    }
  }
}

function createAstar(startGuid, goalGuid, getNeighbours, heuristic) {
  const openSet = new MinHeap();
  const closedSet = new Set();
  const frozenSet = new Set(); // nodes at data boundary awaiting map pan
  const cameFrom = new Map();
  const gScore = new Map();

  const h0 = heuristic(startGuid);
  gScore.set(startGuid, 0);
  openSet.push({ guid: startGuid, g: 0, h: h0, f: h0 });

  function reconstructPath() {
    const path = [];
    let cur = goalGuid;
    while (cur !== undefined) { path.push(cur); cur = cameFrom.get(cur); }
    return path.reverse();
  }

  return {
    step() {
      if (openSet.isEmpty()) {
        if (frozenSet.size > 0) {
          // All frontier nodes are at data boundary; Pathfinder must pan and call resumeAfterPan()
          return { status: 'need_data', frozenGuid: null };
        }
        return { status: 'no_path', closedSet: new Set(closedSet) };
      }

      const node = openSet.pop();
      const { guid, g } = node;

      // Skip stale heap entries (lazy deletion — a better path was already found)
      if (g > (gScore.get(guid) ?? Infinity)) return { status: 'continue' };

      if (guid === goalGuid) {
        closedSet.add(guid);
        return { status: 'found', path: reconstructPath() };
      }

      const neighbours = getNeighbours(guid);

      if (neighbours.length === 0) {
        // At data boundary — freeze instead of closing so pan can retry
        frozenSet.add(guid);
        return { status: 'need_data', frozenGuid: guid };
      }

      closedSet.add(guid);

      for (const nb of neighbours) {
        if (closedSet.has(nb.guid) || frozenSet.has(nb.guid)) continue;
        const tentG = g + 1;
        if (!gScore.has(nb.guid) || tentG < gScore.get(nb.guid)) {
          cameFrom.set(nb.guid, guid);
          gScore.set(nb.guid, tentG);
          const h = heuristic(nb.guid);
          openSet.push({ guid: nb.guid, g: tentG, h, f: tentG + h });
        }
      }

      return { status: 'continue' };
    },

    // Called by Pathfinder after mapDataRefreshEnd to retry frozen nodes
    resumeAfterPan() {
      for (const guid of frozenSet) {
        const g = gScore.get(guid) ?? 0;
        const h = heuristic(guid);
        openSet.push({ guid, g, h, f: g + h });
      }
      frozenSet.clear();
    },

    getBestOpenNode() { return openSet.peek(); },
    getClosedSet()    { return closedSet; }
  };
}

// ─── IITC wrapper ─────────────────────────────────────────────────────────────

function wrapper(plugin_info) {
  if (typeof window.plugin !== 'function') window.plugin = function() {};
  // Prevent double-initialisation when both IITC plugin system and Tampermonkey load the script
  if (window.plugin.dronePathPlanner) return;

  const P = window.plugin.dronePathPlanner = {};
  const MAX_PANS    = 20;
  const MAX_HOP_DIST = 500; // metres

  // ─── CSS ──────────────────────────────────────────────────────────────────
  const style = document.createElement('style');
  style.textContent = `
    #drone-planner-float {
      position: fixed;
      top: 60px;
      right: 10px;
      width: 250px;
      background: #1e1e1e;
      border: 1px solid #555;
      border-radius: 6px;
      box-shadow: 0 4px 16px rgba(0,0,0,0.6);
      z-index: 8000;
      color: #eee;
      font-family: sans-serif;
    }
    #drone-planner-float .dp-titlebar {
      background: #2a2a2a;
      padding: 6px 10px;
      cursor: move;
      border-radius: 6px 6px 0 0;
      display: flex;
      justify-content: space-between;
      align-items: center;
      font-size: 13px;
      font-weight: bold;
    }
    #drone-planner-float .dp-titlebar #dp-toggle {
      cursor: pointer;
      opacity: 0.7;
      padding: 0 2px;
    }
    #drone-planner-float .dp-body { padding: 8px 10px; }
    .dp-info   { font-size: 12px; color: #ccc; margin-bottom: 4px; }
    .dp-status { font-size: 11px; color: #aaa; margin-bottom: 4px; }
    #drone-planner-float button {
      margin: 4px 2px; padding: 4px 8px; cursor: pointer; font-size: 12px;
    }
    #dp-list { max-height: 200px; overflow-y: auto; padding-left: 18px; margin: 4px 0; }
    #dp-list li { font-size: 11px; color: #bbb; margin: 2px 0; cursor: pointer; }
    #dp-list li:hover { color: #fff; }
    .drone-hop-label { background: #f4c20d; color: #fff; border-radius: 50%;
      width: 20px; height: 20px; line-height: 20px; text-align: center;
      font-size: 10px; font-weight: bold; border: 2px solid #fff;
      position: absolute; transform: translate(-50%, -50%); }
    .drone-start-label { background: #34a853; }
    .drone-end-label   { background: #f4c20d; }
  `;
  document.head.appendChild(style);

  // ─── Selection module ─────────────────────────────────────────────────────
  P.Selection = {
    startGuid: null,
    endGuid: null,
    _startMarker: null,
    _endMarker: null,

    init() {
      window.addHook('portalDetailsUpdated', this._onPortalDetailsUpdated.bind(this));
    },

    _onPortalDetailsUpdated(data) {
      const prev = document.getElementById('dp-portal-actions');
      if (prev) prev.remove();

      const details = document.getElementById('portaldetails');
      if (!details) return;

      const guid = data.guid;
      const self = this;

      const div = document.createElement('div');
      div.id = 'dp-portal-actions';
      div.style.cssText = 'margin:4px 0;padding:6px 0;border-top:1px solid #555';

      const linkS = document.createElement('a');
      linkS.href = '#';
      linkS.textContent = '✈ Set as Drone Start';
      linkS.style.cssText = 'display:block;padding:3px 0;color:#6cf;cursor:pointer';
      linkS.addEventListener('click', e => { e.preventDefault(); self.setStart(guid); });

      const linkE = document.createElement('a');
      linkE.href = '#';
      linkE.textContent = '✈ Set as Drone End';
      linkE.style.cssText = 'display:block;padding:3px 0;color:#6cf;cursor:pointer';
      linkE.addEventListener('click', e => { e.preventDefault(); self.setEnd(guid); });

      div.appendChild(linkS);
      div.appendChild(linkE);
      details.appendChild(div);
    },

    setStart(guid) {
      P.Pathfinder.abort();
      P.Renderer.clear();
      this.startGuid = guid;
      if (this._startMarker) P.Renderer._layer.removeLayer(this._startMarker);
      const node = P.Graph.getPortalNode(guid);
      if (node) {
        this._startMarker = L.marker([node.lat, node.lng], {
          icon: P.Renderer._makeHopIcon('S', 'drone-start-label')
        });
        P.Renderer._layer.addLayer(this._startMarker);
      }
      const endNode = this.endGuid ? P.Graph.getPortalNode(this.endGuid) : null;
      P.Renderer.updateSelectionUI(node && node.title, endNode && endNode.title);
    },

    setEnd(guid) {
      P.Pathfinder.abort();
      P.Renderer.clear();
      this.endGuid = guid;
      if (this._endMarker) P.Renderer._layer.removeLayer(this._endMarker);
      const node = P.Graph.getPortalNode(guid);
      if (node) {
        this._endMarker = L.marker([node.lat, node.lng], {
          icon: P.Renderer._makeHopIcon('E', 'drone-end-label')
        });
        P.Renderer._layer.addLayer(this._endMarker);
      }
      const startNode = this.startGuid ? P.Graph.getPortalNode(this.startGuid) : null;
      P.Renderer.updateSelectionUI(startNode && startNode.title, node && node.title);
    },

    reset() {
      this.startGuid = null;
      this.endGuid   = null;
      this._startMarker = null;
      this._endMarker   = null;
      P.Renderer.updateSelectionUI(null, null);
    }
  };

  // ─── Graph module ─────────────────────────────────────────────────────────
  P.Graph = {
    getPortalNode(guid) {
      const p = window.portals[guid];
      if (!p) return null;
      return {
        guid,
        lat:   p.options.data.latE6 / 1e6,
        lng:   p.options.data.lngE6 / 1e6,
        title: p.options.data.title || '(untitled)'
      };
    },

    getNeighbours(guid) {
      const from = this.getPortalNode(guid);
      if (!from) return [];
      const result = [];
      for (const g of Object.keys(window.portals)) {
        if (g === guid) continue;
        const to = this.getPortalNode(g);
        if (to && haversine(from, to) <= MAX_HOP_DIST) result.push(to);
      }
      return result;
    }
  };

  // ─── Pathfinder module ────────────────────────────────────────────────────
  P.Pathfinder = {
    _searcher: null,
    _running:  false,
    _panCount: 0,
    _goalGuid: null,
    _pendingRefreshHook: null,

    run(startGuid, goalGuid) {
      this.abort();

      if (startGuid === goalGuid) {
        P.Renderer.setStatus('Start and end are the same'); return;
      }
      if (window.map.getZoom() < 15) {
        P.Renderer.setStatus('Zoom to level 15 or above first'); return;
      }
      const startNode = P.Graph.getPortalNode(startGuid);
      if (!startNode) {
        P.Renderer.setStatus('Start portal not loaded — move it into view first'); return;
      }
      const goalNode = P.Graph.getPortalNode(goalGuid);
      if (!goalNode) {
        P.Renderer.setStatus('End portal not loaded — move it into view first'); return;
      }

      this._running  = true;
      this._panCount = 0;
      this._goalGuid = goalGuid;

      this._searcher = createAstar(
        startGuid,
        goalGuid,
        guid => P.Graph.getNeighbours(guid),
        guid => {
          const n = P.Graph.getPortalNode(guid);
          return n ? Math.ceil(haversine(n, goalNode) / MAX_HOP_DIST) : 999;
        }
      );

      P.Renderer.setStatus('Searching…');
      this._step();
    },

    _findClosestToGoal(closedSet) {
      const goalNode = P.Graph.getPortalNode(this._goalGuid);
      if (!goalNode) return null;
      let closestGuid = null, minDist = Infinity;
      for (const guid of closedSet) {
        const n = P.Graph.getPortalNode(guid);
        if (!n) continue;
        const d = haversine(n, goalNode);
        if (d < minDist) { minDist = d; closestGuid = guid; }
      }
      return closestGuid;
    },

    _step() {
      if (!this._running) return;

      const result = this._searcher.step();

      if (result.status === 'found') {
        this._running = false;
        P.Renderer.showPath(result.path);
        return;
      }

      if (result.status === 'no_path') {
        this._running = false;
        P.Renderer.showGap(
          this._findClosestToGoal(result.closedSet),
          this._goalGuid
        );
        return;
      }

      if (result.status === 'need_data') {
        if (this._panCount >= MAX_PANS) {
          this._running = false;
          P.Renderer.showGap(
            this._findClosestToGoal(this._searcher.getClosedSet()),
            this._goalGuid
          );
          return;
        }

        this._panCount++;
        const best     = this._searcher.getBestOpenNode();
        const goalNode = P.Graph.getPortalNode(this._goalGuid);

        let panTarget = goalNode ? [goalNode.lat, goalNode.lng] : null;
        if (best && goalNode) {
          const fromNode = P.Graph.getPortalNode(best.guid);
          if (fromNode) {
            panTarget = [(fromNode.lat + goalNode.lat) / 2,
                         (fromNode.lng + goalNode.lng) / 2];
          }
        }

        if (!panTarget) {
          this._running = false;
          P.Renderer.showGap(
            this._findClosestToGoal(this._searcher.getClosedSet()),
            this._goalGuid
          );
          return;
        }

        P.Renderer.setStatus(`Searching… (pan ${this._panCount})`);
        window.map.setView(panTarget, 15);

        const self = this;
        function onRefresh() {
          window.removeHook('mapDataRefreshEnd', onRefresh);
          self._pendingRefreshHook = null;
          if (!self._running) return;
          self._searcher.resumeAfterPan();
          setTimeout(() => self._step(), 0);
        }
        this._pendingRefreshHook = onRefresh;
        window.addHook('mapDataRefreshEnd', onRefresh);
        return;
      }

      // status === 'continue'
      setTimeout(() => this._step(), 0);
    },

    abort() {
      this._running = false;
      this._searcher = null;
      if (this._pendingRefreshHook) {
        window.removeHook('mapDataRefreshEnd', this._pendingRefreshHook);
        this._pendingRefreshHook = null;
      }
    }
  };

  // ─── Renderer module ──────────────────────────────────────────────────────
  P.Renderer = {
    _layer: null,

    init() {
      this._layer = new L.LayerGroup();
      window.layerChooser.addOverlay(this._layer, 'Drone Path');
      window.map.addLayer(this._layer);
      this._buildPanel();
    },

    _buildPanel() {
      // Floating panel appended to body (not sidebar)
      const panel = document.createElement('div');
      panel.id = 'drone-planner-float';
      panel.innerHTML = `
        <div class="dp-titlebar">
          <span>✈ Drone Path Planner</span>
          <span id="dp-toggle">▾</span>
        </div>
        <div class="dp-body" id="dp-body">
          <div class="dp-info" id="dp-start">Start: None</div>
          <div class="dp-info" id="dp-end">End: None</div>
          <div class="dp-status" id="dp-status"></div>
          <button id="dp-calc" style="display:none">Calculate</button>
          <button id="dp-clear" style="display:none">Clear</button>
          <ol id="dp-list" style="display:none"></ol>
        </div>
      `;
      document.body.appendChild(panel);

      // Collapse / expand
      document.getElementById('dp-toggle').addEventListener('click', () => {
        const body = document.getElementById('dp-body');
        const collapsed = body.style.display === 'none';
        body.style.display = collapsed ? '' : 'none';
        document.getElementById('dp-toggle').textContent = collapsed ? '▾' : '▸';
      });

      // Drag
      const titlebar = panel.querySelector('.dp-titlebar');
      let drag = null;
      titlebar.addEventListener('mousedown', e => {
        if (e.target.id === 'dp-toggle') return;
        drag = { x: e.clientX - panel.offsetLeft, y: e.clientY - panel.offsetTop };
      });
      document.addEventListener('mousemove', e => {
        if (!drag) return;
        panel.style.left  = (e.clientX - drag.x) + 'px';
        panel.style.top   = (e.clientY - drag.y) + 'px';
        panel.style.right = 'auto';
      });
      document.addEventListener('mouseup', () => { drag = null; });

      // Toolbox toggle link
      const toolbox = document.getElementById('toolbox');
      if (toolbox) {
        const link = document.createElement('a');
        link.href = '#';
        link.textContent = 'Drone Planner';
        link.addEventListener('click', e => {
          e.preventDefault();
          panel.style.display = panel.style.display === 'none' ? '' : 'none';
        });
        toolbox.appendChild(link);
      }

      document.getElementById('dp-calc').addEventListener('click', () => {
        P.Pathfinder.run(P.Selection.startGuid, P.Selection.endGuid);
      });
      document.getElementById('dp-clear').addEventListener('click', () => {
        P.Pathfinder.abort();
        P.Renderer.clear();
        P.Selection.reset();
      });
    },

    updateSelectionUI(startTitle, endTitle) {
      document.getElementById('dp-start').textContent = 'Start: ' + (startTitle || 'None');
      document.getElementById('dp-end').textContent   = 'End: '   + (endTitle   || 'None');
      const canCalc = !!(P.Selection.startGuid && P.Selection.endGuid);
      document.getElementById('dp-calc').style.display = canCalc ? '' : 'none';
    },

    setStatus(text) {
      const el = document.getElementById('dp-status');
      if (el) el.textContent = text;
    },

    _makeHopIcon(label, extraClass) {
      return L.divIcon({
        className: '',
        html: `<div class="drone-hop-label ${extraClass || ''}">${label}</div>`,
        iconSize: [20, 20],
        iconAnchor: [10, 10]
      });
    },

    showPath(path) {
      this.clear();
      const nodes = path.map(g => P.Graph.getPortalNode(g)).filter(Boolean);
      if (nodes.length < 2) return;

      const latLngs = nodes.map(n => [n.lat, n.lng]);
      this._layer.addLayer(L.polyline(latLngs, { color: '#f4c20d', weight: 3, opacity: 0.9 }));

      nodes.forEach((node, i) => {
        const isStart = i === 0;
        const isEnd   = i === nodes.length - 1;
        const label   = isStart ? 'S' : isEnd ? 'E' : String(i);
        const cls     = isStart ? 'drone-start-label' : isEnd ? 'drone-end-label' : '';
        const marker  = L.marker([node.lat, node.lng], { icon: this._makeHopIcon(label, cls) });
        marker.on('click', () => {
          window.map.panTo([node.lat, node.lng]);
          window.selectPortal(node.guid, 'click');
          window.renderPortalDetails(node.guid);
        });
        this._layer.addLayer(marker);
      });

      const hops = path.length - 1;
      const totalDist = nodes.slice(1).reduce((s, n, i) => s + haversine(nodes[i], n), 0);
      this.setStatus(`${hops} hop${hops !== 1 ? 's' : ''}, total ${(totalDist / 1000).toFixed(2)} km`);

      const list = document.getElementById('dp-list');
      list.style.display = '';
      list.innerHTML = '';
      nodes.forEach((n, i) => {
        const distStr = i < nodes.length - 1
          ? ` → ${Math.round(haversine(n, nodes[i + 1]))} m` : '';
        const lbl = i === 0 ? 'S' : i === nodes.length - 1 ? 'E' : String(i);
        const li = document.createElement('li');
        li.dataset.lat = n.lat;
        li.dataset.lng = n.lng;
        li.textContent = `${lbl}. ${n.title}${distStr}`;
        li.addEventListener('click', () => {
          window.map.panTo([n.lat, n.lng]);
          window.selectPortal(n.guid, 'click');
          window.renderPortalDetails(n.guid);
        });
        list.appendChild(li);
      });

      document.getElementById('dp-clear').style.display = '';
      document.getElementById('dp-calc').style.display = 'none';
    },

    showGap(closestGuid, goalGuid) {
      this.clear();
      const from = P.Graph.getPortalNode(closestGuid);
      const to   = P.Graph.getPortalNode(goalGuid);
      if (!from || !to) { this.setStatus('Unreachable (insufficient portal data)'); return; }

      this._layer.addLayer(L.polyline(
        [[from.lat, from.lng], [to.lat, to.lng]],
        { color: '#ea4335', weight: 2, dashArray: '6 6', opacity: 0.9 }
      ));
      this._layer.addLayer(L.circle([from.lat, from.lng], {
        radius: MAX_HOP_DIST, color: '#ea4335',
        fillColor: '#ea4335', fillOpacity: 0.1, weight: 1
      }));

      const gapDist = Math.round(haversine(from, to));
      this.setStatus(`Unreachable. Gap: ${gapDist} m (limit: ${MAX_HOP_DIST} m)`);
      document.getElementById('dp-clear').style.display = '';
    },

    clear() {
      if (this._layer) this._layer.clearLayers();
      this.setStatus('');
      const list = document.getElementById('dp-list');
      if (list) { list.style.display = 'none'; list.innerHTML = ''; }
      const clearBtn = document.getElementById('dp-clear');
      if (clearBtn) clearBtn.style.display = 'none';
      const calcBtn  = document.getElementById('dp-calc');
      if (calcBtn) calcBtn.style.display =
        (P.Selection.startGuid && P.Selection.endGuid) ? '' : 'none';
    }
  };

  // ─── Setup ────────────────────────────────────────────────────────────────
  const setup = function() {
    P.Renderer.init();
    P.Selection.init();
    console.log('[DronePathPlanner] loaded');
  };

  setup.info = plugin_info;
  if (!window.bootPlugins) window.bootPlugins = [];
  window.bootPlugins.push(setup);
  if (window.iitcLoaded && typeof setup === 'function') setup();
}

// ─── Boot ────────────────────────────────────────────────────────────────────

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { haversine, createAstar };
} else {
  const info = {};
  if (typeof GM_info !== 'undefined' && GM_info && GM_info.script) {
    info.script = {
      version: GM_info.script.version,
      name: GM_info.script.name,
      description: GM_info.script.description
    };
  }
  wrapper(info);
}
