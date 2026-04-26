/**
 * Smoke test for the browser pool mechanics.
 *
 * Self-contained: re-implements the pool logic with a mock browser so it
 * runs anywhere without real Playwright binaries.
 *
 * Verifies:
 *   1. Sequential warm reuse — second call shares the same browser instance.
 *   2. Parallel deduplication — concurrent cold launches share one Promise,
 *      producing exactly one browser instance.
 *   3. Reference counting — idle timer is only set after all in-flight
 *      requests have released.
 *   4. Crash recovery — a disconnected browser is replaced on the next call.
 */

// ── Types (mirrors index.ts) ─────────────────────────────────────────────────

type BrowserName = "chromium" | "firefox" | "webkit";

interface PoolEntry {
  browserPromise: Promise<any>;
  activeCount: number;
  idleTimer: ReturnType<typeof setTimeout> | null;
}

// ── Self-contained pool implementation (mirrors index.ts) ────────────────────

const pool = new Map<BrowserName, PoolEntry>();

async function mockAcquire(browserName: BrowserName, launcher: () => any): Promise<any> {
  const existing = pool.get(browserName);
  if (existing) {
    const browser = await existing.browserPromise;
    if (browser.isConnected()) {
      if (existing.idleTimer) { clearTimeout(existing.idleTimer); existing.idleTimer = null; }
      existing.activeCount++;
      return browser;
    }
    pool.delete(browserName);
  }

  const launchPromise = (async () => {
    try { return launcher(); }
    catch (err) { pool.delete(browserName); throw err; }
  })();
  pool.set(browserName, { browserPromise: launchPromise, activeCount: 1, idleTimer: null });
  return launchPromise;
}

function mockRelease(browserName: BrowserName, idleMs = 60_000): void {
  const entry = pool.get(browserName);
  if (!entry) return;
  entry.activeCount--;
  if (entry.activeCount > 0) return;
  entry.idleTimer = setTimeout(() => {
    pool.delete(browserName);
    entry.browserPromise.then((b: any) => b.close()).catch(() => {});
  }, idleMs);
}

// ── Mock browser factory ─────────────────────────────────────────────────────

let nextId = 0;

function makeMockBrowser() {
  const id = `browser-${++nextId}`;
  let connected = true;
  return {
    _id: id,
    isConnected: () => connected,
    disconnect: () => { connected = false; },
    close: async () => { connected = false; },
  };
}

// ── Assertions ───────────────────────────────────────────────────────────────

let passed = 0, failed = 0;

function assert(condition: boolean, message: string) {
  if (condition) { console.log(`  ✓ ${message}`); passed++; }
  else           { console.error(`  ✗ ${message}`); failed++; }
}

// ── Test 1: Sequential warm reuse ────────────────────────────────────────────
console.log("\nTest 1: Sequential warm reuse");
{
  pool.clear(); let launches = 0;
  const launch = () => { launches++; return makeMockBrowser(); };

  const b1 = await mockAcquire("chromium", launch);
  mockRelease("chromium");

  const b2 = await mockAcquire("chromium", launch);
  mockRelease("chromium");

  assert(launches === 1, "Only one browser launched across two sequential calls");
  assert(b1 === b2,      "Both calls got the same browser instance");
  assert(pool.get("chromium")?.activeCount === 0, "activeCount is 0 after both releases");
  assert(pool.get("chromium")?.idleTimer !== null, "Idle timer set after last release");
  clearTimeout(pool.get("chromium")!.idleTimer!);
  pool.clear();
}

// ── Test 2: Parallel deduplication ───────────────────────────────────────────
console.log("\nTest 2: Parallel deduplication (concurrent cold launches)");
{
  pool.clear(); let launches = 0;
  const launch = () => { launches++; return makeMockBrowser(); };

  const [b1, b2] = await Promise.all([
    mockAcquire("chromium", launch),
    mockAcquire("chromium", launch),
  ]);

  assert(launches === 1, "Only one browser launched despite two concurrent calls");
  assert(b1 === b2,      "Both parallel requests got the same browser instance");
  assert(pool.get("chromium")?.activeCount === 2, "activeCount is 2 while both in-flight");

  mockRelease("chromium");
  assert(pool.get("chromium")?.activeCount === 1,   "activeCount drops to 1 after first release");
  assert(pool.get("chromium")?.idleTimer === null,   "No idle timer while second request still active");

  mockRelease("chromium");
  assert(pool.get("chromium")?.activeCount === 0,    "activeCount drops to 0 after second release");
  assert(pool.get("chromium")?.idleTimer !== null,   "Idle timer set only after both released");
  clearTimeout(pool.get("chromium")!.idleTimer!);
  pool.clear();
}

// ── Test 3: Idle timer eviction ───────────────────────────────────────────────
console.log("\nTest 3: Idle timer eviction");
{
  pool.clear(); let launches = 0;
  const launch = () => { launches++; return makeMockBrowser(); };

  const b1 = await mockAcquire("chromium", launch);
  mockRelease("chromium", 10); // very short idle timeout

  assert(pool.has("chromium"), "Browser still in pool immediately after release");
  await new Promise((r) => setTimeout(r, 50));
  assert(!pool.has("chromium"),          "Browser evicted from pool after idle timeout");
  assert(!(b1 as any).isConnected(),     "Evicted browser was closed");
}

// ── Test 4: Crash recovery ────────────────────────────────────────────────────
console.log("\nTest 4: Crash recovery — disconnected browser is replaced");
{
  pool.clear(); let launches = 0;
  const launch = () => { launches++; return makeMockBrowser(); };

  const b1 = await mockAcquire("chromium", launch);
  mockRelease("chromium");
  clearTimeout(pool.get("chromium")!.idleTimer!);

  (b1 as any).disconnect();
  assert(!b1.isConnected(), "Browser reports disconnected");

  const b2 = await mockAcquire("chromium", launch);
  assert(launches === 2,    "New browser launched after crash");
  assert(b1 !== b2,         "Got a fresh browser instance, not the crashed one");
  assert(b2.isConnected(),  "New browser is connected");
  mockRelease("chromium");
  clearTimeout(pool.get("chromium")!.idleTimer!);
  pool.clear();
}

// ── Summary ───────────────────────────────────────────────────────────────────
console.log(`\n${passed + failed} assertions: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
