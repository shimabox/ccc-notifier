import { afterEach, describe, expect, it } from "vitest";

import { isWSL } from "../src/env";

/** process.platform を一時的に上書きする(afterEach で復元)。 */
function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
}

describe("isWSL", () => {
  const originalPlatform = process.platform;
  const originalDistro = process.env.WSL_DISTRO_NAME;

  afterEach(() => {
    setPlatform(originalPlatform);
    delete process.env.CCCN_FORCE_WSL;
    if (originalDistro === undefined) delete process.env.WSL_DISTRO_NAME;
    else process.env.WSL_DISTRO_NAME = originalDistro;
  });

  it("returns true when CCCN_FORCE_WSL=1 regardless of platform", () => {
    setPlatform("darwin");
    process.env.CCCN_FORCE_WSL = "1";
    expect(isWSL()).toBe(true);
  });

  it("returns false when CCCN_FORCE_WSL=0 even if WSL_DISTRO_NAME is set", () => {
    setPlatform("linux");
    process.env.CCCN_FORCE_WSL = "0";
    process.env.WSL_DISTRO_NAME = "Ubuntu";
    expect(isWSL()).toBe(false);
  });

  it("returns false on non-linux platforms", () => {
    setPlatform("win32");
    delete process.env.WSL_DISTRO_NAME;
    expect(isWSL()).toBe(false);
  });

  it("returns true on linux when WSL_DISTRO_NAME is set", () => {
    setPlatform("linux");
    process.env.WSL_DISTRO_NAME = "Ubuntu";
    expect(isWSL()).toBe(true);
  });
});
