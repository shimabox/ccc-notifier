import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  invalidateCanonicalDashboards,
  isFullDashboardDue,
  makeFullDashboardState,
  writeFullDashboardStateAtomic,
} from "../src/dashboard-state";
import { paths } from "../src/store";

let home: string;
let oldHome: string | undefined;
let oldTz: string | undefined;

beforeEach(() => {
  oldHome = process.env.CCCN_HOME;
  oldTz = process.env.TZ;
  home = mkdtempSync(join(tmpdir(), "cccn-dashboard-state-"));
  process.env.CCCN_HOME = home;
  process.env.TZ = "Asia/Tokyo";
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  if (oldHome === undefined) delete process.env.CCCN_HOME;
  else process.env.CCCN_HOME = oldHome;
  if (oldTz === undefined) delete process.env.TZ;
  else process.env.TZ = oldTz;
});

describe("full dashboard daily state", () => {
  const now = new Date("2026-07-12T01:00:00.000Z"); // JST 2026-07-12 10:00

  function seedValid(): void {
    writeFileSync(paths().fullDashboardFile, "full", "utf8");
    writeFullDashboardStateAtomic(makeFullDashboardState(now));
  }

  it("same local day is not due, but a missing full HTML is due", () => {
    seedValid();
    expect(isFullDashboardDue(now)).toBe(false);
    rmSync(paths().fullDashboardFile);
    expect(isFullDashboardDue(now)).toBe(true);
  });

  it("treats a full-history placeholder as not generated even with valid state", () => {
    writeFileSync(paths().fullDashboardFile, '<meta name="cccn-placeholder" content="true">', "utf8");
    writeFullDashboardStateAtomic(makeFullDashboardState(now));
    expect(isFullDashboardDue(now)).toBe(true);
  });

  it("missing/corrupt/future state is due", () => {
    writeFileSync(paths().fullDashboardFile, "full", "utf8");
    expect(isFullDashboardDue(now)).toBe(true);
    writeFileSync(paths().dashboardFullStateFile, "{broken", "utf8");
    expect(isFullDashboardDue(now)).toBe(true);
    writeFileSync(
      paths().dashboardFullStateFile,
      JSON.stringify({ ...makeFullDashboardState(now), generatedAt: "2026-07-12T02:00:00.000Z" }),
      "utf8",
    );
    expect(isFullDashboardDue(now)).toBe(true);
  });

  it("local date rollover and timezone change are due", () => {
    seedValid();
    expect(isFullDashboardDue(new Date("2026-07-13T01:00:00.000Z"))).toBe(true);
    process.env.TZ = "UTC";
    expect(isFullDashboardDue(now)).toBe(true);
  });

  it("invalidates only canonical files/state", () => {
    const p = paths();
    for (const file of [p.recentDashboardFile, p.fullDashboardFile, p.dashboardFullStateFile]) {
      writeFileSync(file, "x", "utf8");
    }
    const custom = join(home, "custom.html");
    writeFileSync(custom, "keep", "utf8");
    invalidateCanonicalDashboards();
    expect([p.recentDashboardFile, p.fullDashboardFile, p.dashboardFullStateFile].every((f) => !existsSync(f))).toBe(true);
    expect(readFileSync(custom, "utf8")).toBe("keep");
  });
});
