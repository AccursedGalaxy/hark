import { describe, expect, it } from "vitest";
import { renderUnit, unitInstallPath } from "./serviceUnit.js";

const TEMPLATE = `[Service]
WorkingDirectory=@@INSTALL_DIR@@
ExecStart=@@NODE@@ @@INSTALL_DIR@@/dist/server.js
`;

describe("renderUnit", () => {
  it("substitutes install dir and node binary", () => {
    const out = renderUnit({
      template: TEMPLATE,
      installDir: "/home/aki/Projects/hark",
      nodeBinary: "/usr/bin/node",
    });
    expect(out).toContain("WorkingDirectory=/home/aki/Projects/hark");
    expect(out).toContain(
      "ExecStart=/usr/bin/node /home/aki/Projects/hark/dist/server.js",
    );
  });

  it("replaces every occurrence of each placeholder", () => {
    const out = renderUnit({
      template: "@@INSTALL_DIR@@ x @@INSTALL_DIR@@ y @@NODE@@",
      installDir: "/p",
      nodeBinary: "/n",
    });
    expect(out).toBe("/p x /p y /n");
  });
});

describe("unitInstallPath", () => {
  it("targets the user's systemd unit directory", () => {
    expect(unitInstallPath("/home/aki")).toBe(
      "/home/aki/.config/systemd/user/hark.service",
    );
  });
});
