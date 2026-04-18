const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

const PLUGIN_CODE = fs.readFileSync(
  path.join(__dirname, '../../drone-planner.user.js'),
  'utf8'
);

// Portals arranged in a line ~400m apart (well within 550m hop limit).
// At lat=0: 0.004 degrees lng ≈ 445m.
const TEST_PORTALS = [
  { guid: 'p-A', lat: 0, lng: 0,     title: 'Portal A' },
  { guid: 'p-B', lat: 0, lng: 0.004, title: 'Portal B' },
  { guid: 'p-C', lat: 0, lng: 0.008, title: 'Portal C' },
  // Isolated portal – ~5.5 km away, unreachable
  { guid: 'p-Z', lat: 0, lng: 0.05,  title: 'Portal Z (isolated)' },
];

function buildMockPage(portals) {
  const portalsJson = JSON.stringify(portals);
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css">
  <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
  <style>
    html, body { margin: 0; padding: 0; height: 100%; }
    #map { width: 800px; height: 600px; }
    #sidebar { width: 300px; background: #222; color: #eee; padding: 8px; }
    #portaldetails { padding: 8px; }
  </style>
</head>
<body>
  <div id="map"></div>
  <div id="sidebar">
    <div id="portaldetails"></div>
  </div>
  <script>
    // ── IITC hook system ──────────────────────────────────────────────────────
    window._hooks = {};
    window.addHook = function(name, fn) {
      if (!window._hooks[name]) window._hooks[name] = [];
      window._hooks[name].push(fn);
    };
    window.removeHook = function(name, fn) {
      if (!window._hooks[name]) return;
      window._hooks[name] = window._hooks[name].filter(f => f !== fn);
    };
    window.runHooks = function(name, data) {
      (window._hooks[name] || []).forEach(fn => fn(data));
    };

    // ── Leaflet map ───────────────────────────────────────────────────────────
    window.map = L.map('map').setView([0, 0.004], 15);

    // ── layerChooser mock ─────────────────────────────────────────────────────
    window.layerChooser = {
      addOverlay: function(layer) { window.map.addLayer(layer); }
    };

    // ── plugin namespace ──────────────────────────────────────────────────────
    window.plugin = function() {};

    // ── portal data ───────────────────────────────────────────────────────────
    window.portals = {};

    var portalDefs = ${portalsJson};
    portalDefs.forEach(function(def) {
      var marker = L.circleMarker([def.lat, def.lng], {
        radius: 8, color: '#00ff00', fillColor: '#00ff00', fillOpacity: 0.8
      });
      marker.options.guid = def.guid;
      marker.options.data = {
        latE6: Math.round(def.lat * 1e6),
        lngE6: Math.round(def.lng * 1e6),
        title: def.title
      };
      marker.addTo(window.map);
      window.portals[def.guid] = marker;

      // Mirror IITC: clicking or right-clicking a portal calls renderPortalDetails,
      // which eventually fires portalDetailsUpdated.
      marker.on('click contextmenu', function() {
        window.runHooks('portalDetailsUpdated', {
          guid: def.guid,
          portal: marker,
          portalDetails: {},
          portalData: {}
        });
      });
    });

    // ── boot flag ─────────────────────────────────────────────────────────────
    window.iitcLoaded = true;
    window.bootPlugins = [];
  </script>
</body>
</html>`;
}

async function loadPlugin(page) {
  await page.setContent(buildMockPage(TEST_PORTALS), { waitUntil: 'networkidle' });
  await page.addScriptTag({ content: PLUGIN_CODE });
  await page.evaluate(() => {
    if (!document.getElementById('drone-planner-panel') && window.bootPlugins.length) {
      window.bootPlugins[0]();
    }
  });
  await page.waitForSelector('#drone-planner-panel', { timeout: 5000 });
}

// Simulate IITC firing portalDetailsUpdated for a portal (as happens on click/right-click)
// then click one of the injected drone action links.
async function detailsClick(page, guid, text) {
  await page.evaluate((g) => {
    window.runHooks('portalDetailsUpdated', {
      guid: g,
      portal: window.portals[g],
      portalDetails: {},
      portalData: {}
    });
  }, guid);
  await page.waitForSelector('#dp-portal-actions');
  await page.locator('#dp-portal-actions').getByText(text).click();
}

async function selectStartEnd(page, startGuid, endGuid) {
  await detailsClick(page, startGuid, '设为 Drone 起点');
  await detailsClick(page, endGuid,   '设为 Drone 终点');
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test.describe('Drone Planner – initial load', () => {
  test('sidebar panel created with default state', async ({ page }) => {
    await loadPlugin(page);
    await expect(page.locator('#dp-start')).toHaveText('起点：未选择');
    await expect(page.locator('#dp-end')).toHaveText('终点：未选择');
    await expect(page.locator('#dp-calc')).toBeHidden();
    await expect(page.locator('#dp-clear')).toBeHidden();
  });
});

test.describe('Drone Planner – portal selection via portal details panel', () => {
  test.beforeEach(async ({ page }) => { await loadPlugin(page); });

  test('clicking portal injects drone action links into #portaldetails', async ({ page }) => {
    await page.evaluate(() => window.runHooks('portalDetailsUpdated', {
      guid: 'p-A', portal: window.portals['p-A'], portalDetails: {}, portalData: {}
    }));
    await page.waitForSelector('#dp-portal-actions');
    await expect(page.locator('#dp-portal-actions a').filter({ hasText: '设为 Drone 起点' })).toBeVisible();
    await expect(page.locator('#dp-portal-actions a').filter({ hasText: '设为 Drone 终点' })).toBeVisible();
  });

  test('clicking 起点 updates sidebar start label', async ({ page }) => {
    await detailsClick(page, 'p-A', '设为 Drone 起点');
    await expect(page.locator('#dp-start')).toHaveText('起点：Portal A');
    await expect(page.locator('#dp-calc')).toBeHidden();
  });

  test('clicking 终点 updates sidebar end label', async ({ page }) => {
    await detailsClick(page, 'p-C', '设为 Drone 终点');
    await expect(page.locator('#dp-end')).toHaveText('终点：Portal C');
    await expect(page.locator('#dp-calc')).toBeHidden();
  });

  test('setting both portals reveals 开始计算 button', async ({ page }) => {
    await selectStartEnd(page, 'p-A', 'p-C');
    await expect(page.locator('#dp-calc')).toBeVisible();
  });

  test('S marker appears on map after setting start', async ({ page }) => {
    await detailsClick(page, 'p-A', '设为 Drone 起点');
    await expect(page.locator('.drone-start-label')).toBeVisible();
    await expect(page.locator('.drone-start-label')).toHaveText('S');
  });

  test('E marker appears on map after setting end', async ({ page }) => {
    await detailsClick(page, 'p-C', '设为 Drone 终点');
    await expect(page.locator('.drone-end-label')).toBeVisible();
    await expect(page.locator('.drone-end-label')).toHaveText('E');
  });

  test('re-selecting a portal replaces the action buttons', async ({ page }) => {
    // Select p-A
    await page.evaluate(() => window.runHooks('portalDetailsUpdated', {
      guid: 'p-A', portal: window.portals['p-A'], portalDetails: {}, portalData: {}
    }));
    await page.waitForSelector('#dp-portal-actions');
    // Select p-C – old buttons replaced
    await page.evaluate(() => window.runHooks('portalDetailsUpdated', {
      guid: 'p-C', portal: window.portals['p-C'], portalDetails: {}, portalData: {}
    }));
    // Only one #dp-portal-actions should exist
    await expect(page.locator('#dp-portal-actions')).toHaveCount(1);
  });
});

test.describe('Drone Planner – path finding', () => {
  test.beforeEach(async ({ page }) => { await loadPlugin(page); });

  test('finds 2-hop path A→B→C and shows result', async ({ page }) => {
    await selectStartEnd(page, 'p-A', 'p-C');
    await page.locator('#dp-calc').click();

    await expect(page.locator('#dp-status')).toContainText('跳', { timeout: 10000 });
    expect(await page.locator('#dp-status').textContent()).toMatch(/2\s*跳/);

    // Blue drone-path polyline rendered
    await expect(page.locator('.leaflet-overlay-pane path[stroke="#f4c20d"]')).toBeVisible();
    await expect(page.locator('#dp-list li')).toHaveCount(3);
    await expect(page.locator('#dp-clear')).toBeVisible();
  });

  test('1-hop path for adjacent portals A→B', async ({ page }) => {
    await selectStartEnd(page, 'p-A', 'p-B');
    await page.locator('#dp-calc').click();
    await expect(page.locator('#dp-status')).toContainText('1 跳', { timeout: 10000 });
    await expect(page.locator('#dp-list li')).toHaveCount(2);
  });

  test('gap detection when target is isolated', async ({ page }) => {
    await selectStartEnd(page, 'p-A', 'p-Z');
    await page.locator('#dp-calc').click();
    await expect(page.locator('#dp-status')).toContainText('无法到达', { timeout: 15000 });
    // Red gap elements rendered (dashed polyline + 550m circle, both red)
    await expect(page.locator('.leaflet-overlay-pane path[stroke="#ea4335"]').first()).toBeVisible();
  });

  test('clear button resets map and sidebar', async ({ page }) => {
    await selectStartEnd(page, 'p-A', 'p-C');
    await page.locator('#dp-calc').click();
    await expect(page.locator('#dp-status')).toContainText('跳', { timeout: 10000 });

    await page.locator('#dp-clear').click();
    await expect(page.locator('#dp-status')).toHaveText('');
    await expect(page.locator('#dp-list')).toBeHidden();
    await expect(page.locator('#dp-clear')).toBeHidden();
    await expect(page.locator('#dp-start')).toHaveText('起点：未选择');
    await expect(page.locator('#dp-end')).toContainText('未选择');
  });

  test('start == end shows error, no crash', async ({ page }) => {
    await selectStartEnd(page, 'p-A', 'p-A');
    await page.locator('#dp-calc').click();
    await expect(page.locator('#dp-status')).toContainText('起终点相同', { timeout: 5000 });
  });

  test('portal list items are clickable (pans map)', async ({ page }) => {
    await selectStartEnd(page, 'p-A', 'p-C');
    await page.locator('#dp-calc').click();
    await expect(page.locator('#dp-status')).toContainText('跳', { timeout: 10000 });
    await page.locator('#dp-list li').first().click();
  });
});

test.describe('Drone Planner – map zoom guard', () => {
  test('shows error when zoom < 15', async ({ page }) => {
    await page.setContent(buildMockPage(TEST_PORTALS), { waitUntil: 'networkidle' });
    await page.evaluate(() => window.map.setView([0, 0.004], 13));
    await page.addScriptTag({ content: PLUGIN_CODE });
    await page.evaluate(() => {
      if (!document.getElementById('drone-planner-panel') && window.bootPlugins.length) {
        window.bootPlugins[0]();
      }
    });
    await page.waitForSelector('#drone-planner-panel');

    await selectStartEnd(page, 'p-A', 'p-C');
    await page.locator('#dp-calc').click();
    await expect(page.locator('#dp-status')).toContainText('15 级', { timeout: 3000 });
  });
});
