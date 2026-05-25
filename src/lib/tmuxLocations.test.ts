import { describe, expect, it } from "vitest";
import { formatLocation, parsePaneList } from "./tmuxLocations.js";

const S = String.fromCharCode(0x1f);

describe("parsePaneList", () => {
  it("parses one pane per line into a Map keyed by pane id", () => {
    const out =
      `%1${S}dev${S}0${S}nvim${S}0\n` +
      `%2${S}dev${S}1${S}web${S}0\n` +
      `%18${S}claude${S}2${S}hark${S}1\n`;
    const map = parsePaneList(out);
    expect(map.size).toBe(3);
    expect(map.get("%2")).toEqual({
      sessionName: "dev",
      windowIndex: 1,
      windowName: "web",
      paneIndex: 0,
    });
    expect(map.get("%18")?.sessionName).toBe("claude");
  });

  it("tolerates spaces and colons inside window names", () => {
    const out = `%5${S}work${S}3${S}my: weird name${S}0\n`;
    const map = parsePaneList(out);
    expect(map.get("%5")?.windowName).toBe("my: weird name");
  });

  it("skips malformed lines", () => {
    const out = `garbage\n%9${S}dev${S}0${S}ok${S}0\n`;
    const map = parsePaneList(out);
    expect(map.size).toBe(1);
    expect(map.get("%9")?.windowName).toBe("ok");
  });

  it("returns empty map for empty stdout", () => {
    expect(parsePaneList("").size).toBe(0);
  });
});

describe("formatLocation", () => {
  it("renders sessionName:windowIndex.paneIndex", () => {
    expect(
      formatLocation({
        sessionName: "dev",
        windowIndex: 2,
        windowName: "web",
        paneIndex: 0,
      }),
    ).toBe("dev:2.0");
  });

  it("disambiguates sibling panes in the same window", () => {
    const base = { sessionName: "dev", windowIndex: 2, windowName: "hark" };
    expect(formatLocation({ ...base, paneIndex: 0 })).toBe("dev:2.0");
    expect(formatLocation({ ...base, paneIndex: 1 })).toBe("dev:2.1");
  });
});
