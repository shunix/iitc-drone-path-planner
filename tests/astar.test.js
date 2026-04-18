const { haversine, createAstar } = require('../drone-planner.user.js');

// Linear graph: P0-P1-P2-P3-P4, each ~334m apart (≤550m).
// P0→P2 is ~668m > 550m so direct jump is forbidden.
const PORTALS = [
  { guid: 'P0', lat: 0,     lng: 0 },
  { guid: 'P1', lat: 0.003, lng: 0 },
  { guid: 'P2', lat: 0.006, lng: 0 },
  { guid: 'P3', lat: 0.009, lng: 0 },
  { guid: 'P4', lat: 0.012, lng: 0 },
];

function getNeighbours(guid) {
  const curr = PORTALS.find(p => p.guid === guid);
  return PORTALS.filter(p => p.guid !== guid && haversine(curr, p) <= 550);
}

function makeHeuristic(goalGuid) {
  const goal = PORTALS.find(p => p.guid === goalGuid);
  return function heuristic(guid) {
    const curr = PORTALS.find(p => p.guid === guid);
    return Math.ceil(haversine(curr, goal) / 550);
  };
}

function runSync(searcher) {
  let result;
  let steps = 0;
  do {
    result = searcher.step();
    steps++;
    if (steps > 10000) throw new Error('runSync exceeded step limit');
  } while (result.status === 'continue' || result.status === 'need_data');
  return result;
}

test('finds 4-hop path in linear graph', () => {
  const searcher = createAstar('P0', 'P4', getNeighbours, makeHeuristic('P4'));
  const result = runSync(searcher);
  expect(result.status).toBe('found');
  expect(result.path).toEqual(['P0', 'P1', 'P2', 'P3', 'P4']);
  expect(result.path.length - 1).toBe(4);
});

test('finds 1-hop path when directly adjacent', () => {
  const searcher = createAstar('P0', 'P1', getNeighbours, makeHeuristic('P1'));
  const result = runSync(searcher);
  expect(result.status).toBe('found');
  expect(result.path).toEqual(['P0', 'P1']);
});


test('finds optimal (shorter) path in diamond graph', () => {
  // Diamond: P0 can reach P1 and P2; P1 reaches P3 in 1 hop; P2 reaches PA then P3 in 2 hops
  // Optimal: P0 → P1 → P3 (2 hops). Suboptimal: P0 → P2 → PA → P3 (3 hops).
  const diamond = [
    { guid: 'P0', lat: 0,      lng: 0      }, // start
    { guid: 'P1', lat: 0.003,  lng: 0      }, // 334m from P0 ✓
    { guid: 'P2', lat: 0,      lng: 0.003  }, // 334m from P0 ✓
    { guid: 'PA', lat: 0,      lng: 0.006  }, // 334m from P2, 668m from P0 ✗
    { guid: 'P3', lat: 0.004,  lng: 0.004  }, // ~628m from P0 ✗, ~458m from P1 ✓, ~458m from P2 ✓
  ];
  function getNeighboursDiamond(guid) {
    const curr = diamond.find(p => p.guid === guid);
    return diamond.filter(p => p.guid !== guid && haversine(curr, p) <= 550);
  }
  function heuristicDiamond(guid) {
    const curr = diamond.find(p => p.guid === guid);
    const goal = diamond.find(p => p.guid === 'P3');
    return Math.ceil(haversine(curr, goal) / 550);
  }
  const searcher = createAstar('P0', 'P3', getNeighboursDiamond, heuristicDiamond);
  const result = runSync(searcher);
  expect(result.status).toBe('found');
  expect(result.path.length - 1).toBe(2); // optimal is 2 hops
  expect(result.path[0]).toBe('P0');
  expect(result.path[result.path.length - 1]).toBe('P3');
});

test('resumeAfterPan re-queues frozen nodes and finds path', () => {
  // P0 and P2 are 668m apart (too far to jump directly).
  // P1 at (0.003, 0) is 334m from P0 and 334m from P2.
  // Phase 1: getNeighbours returns [] for P0 (simulating no data loaded around P0).
  //           A* freezes P0 and returns need_data.
  // Phase 2: after "pan", getNeighbours now returns real neighbours.
  //           resumeAfterPan() re-queues P0. A* should then find P0→P1→P2.
  const pts = [
    { guid: 'P0', lat: 0,     lng: 0 },
    { guid: 'P1', lat: 0.003, lng: 0 },
    { guid: 'P2', lat: 0.006, lng: 0 },
  ];
  let dataLoaded = false;
  function getNeighboursPhased(guid) {
    if (!dataLoaded) return []; // simulate no data
    const curr = pts.find(p => p.guid === guid);
    return pts.filter(p => p.guid !== guid && haversine(curr, p) <= 550);
  }
  function heuristicP2(guid) {
    const curr = pts.find(p => p.guid === guid);
    const goal = pts.find(p => p.guid === 'P2');
    return Math.ceil(haversine(curr, goal) / 550);
  }
  const searcher = createAstar('P0', 'P2', getNeighboursPhased, heuristicP2);

  // Step 1: P0 has no neighbours → need_data returned
  const r1 = searcher.step();
  expect(r1.status).toBe('need_data');

  // "Map pans, data loads"
  dataLoaded = true;
  searcher.resumeAfterPan();

  // Step 2+: should now find path
  const r2 = runSync(searcher);
  expect(r2.status).toBe('found');
  expect(r2.path).toEqual(['P0', 'P1', 'P2']);
});

test('returns no_path for truly disconnected graph (neighbours exist but goal unreachable)', () => {
  // Two clusters: {A, B} and {C, D} each within 550m of each other, but 10km apart.
  const cluster1 = [
    { guid: 'A', lat: 0, lng: 0 },
    { guid: 'B', lat: 0.003, lng: 0 },
  ];
  const cluster2 = [
    { guid: 'C', lat: 0.09, lng: 0 },  // ~10km from cluster1
    { guid: 'D', lat: 0.093, lng: 0 },
  ];
  const all = [...cluster1, ...cluster2];
  function getNeighboursDisconnected(guid) {
    const curr = all.find(p => p.guid === guid);
    return all.filter(p => p.guid !== guid && haversine(curr, p) <= 550);
  }
  function heuristicD(guid) {
    const curr = all.find(p => p.guid === guid);
    const goal = all.find(p => p.guid === 'D');
    return Math.ceil(haversine(curr, goal) / 550);
  }
  const searcher = createAstar('A', 'D', getNeighboursDisconnected, heuristicD);
  const result = runSync(searcher);
  expect(result.status).toBe('no_path');
  expect(result.closedSet).toBeDefined();
});
