const { haversine } = require('../drone-planner.user.js');

test('same point returns 0', () => {
  expect(haversine({ lat: 35.6762, lng: 139.6503 }, { lat: 35.6762, lng: 139.6503 })).toBe(0);
});

test('London to Paris is approximately 340km', () => {
  const dist = haversine({ lat: 51.5074, lng: -0.1278 }, { lat: 48.8566, lng: 2.3522 });
  expect(dist).toBeGreaterThan(330000);
  expect(dist).toBeLessThan(350000);
});

test('two points 0.004° latitude apart are ≤550m', () => {
  // 0.004° ≈ 445m at equator
  const dist = haversine({ lat: 0, lng: 0 }, { lat: 0.004, lng: 0 });
  expect(dist).toBeLessThanOrEqual(550);
});

test('two points 0.006° latitude apart exceed 550m', () => {
  // 0.006° ≈ 668m at equator
  const dist = haversine({ lat: 0, lng: 0 }, { lat: 0.006, lng: 0 });
  expect(dist).toBeGreaterThan(550);
});
