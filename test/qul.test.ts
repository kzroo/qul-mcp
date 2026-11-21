import { describe, expect, it } from "vitest";
import { htmlToText, packParts, parseAyahKey, splitText, stablePerPage } from "../src/qul.js";

describe("stablePerPage", () => {
  it("returns values unchanged by QUL's `per_page | 10`", () => {
    for (let n = 1; n <= 286; n++) {
      const v = stablePerPage(n);
      expect(v).toBeGreaterThanOrEqual(Math.min(n, 286));
      expect(Math.min(v | 10, 286)).toBe(v);
    }
  });
  it("picks the smallest stable value", () => {
    expect(stablePerPage(5)).toBe(10);
    expect(stablePerPage(50)).toBe(58);
    expect(stablePerPage(286)).toBe(286);
  });
});

describe("parseAyahKey", () => {
  it("parses valid keys", () => expect(parseAyahKey(" 2:255 ")).toEqual({ chapter: 2, verse: 255 }));
  it("rejects bad input", () => {
    expect(() => parseAyahKey("2-255")).toThrow(/not an ayah key/);
    expect(() => parseAyahKey("115:1")).toThrow(/out of range/);
    expect(() => parseAyahKey("1:0")).toThrow(/1 or more/);
  });
});

describe("htmlToText", () => {
  it("drops footnote markers and decodes entities", () => {
    expect(htmlToText("In the name of Allāh,<sup foot_note=226402>1</sup> the Merciful &amp; Kind")).toBe(
      "In the name of Allāh, the Merciful & Kind",
    );
  });
  it("keeps paragraph breaks", () => {
    expect(htmlToText('<h2>Title</h2><p lang="en">One</p><p>Two&#39;s</p>')).toBe("Title\n\nOne\n\nTwo's");
  });
});

const strip = (t: string) => t.replace(/\s+/g, "");

describe("splitText", () => {
  const para = (n: number) => `Paragraph ${n}. ` + "word ".repeat(40).trim() + ".";
  const text = Array.from({ length: 30 }, (_, i) => para(i)).join("\n\n");

  it("returns short text whole", () => expect(splitText("abc", 10)).toEqual(["abc"]));

  it("never loses text and respects the size", () => {
    for (const size of [50, 300, 1000]) {
      const chunks = splitText(text, size);
      expect(chunks.every((c) => c.length <= size)).toBe(true);
      expect(strip(chunks.join(""))).toBe(strip(text));
    }
  });

  it("breaks at paragraph boundaries when it can", () => {
    for (const c of splitText(text, 1000)) expect(c).toMatch(/^Paragraph \d+\..*\.$/s);
  });

  it("splits a single huge unbroken string", () => {
    const blob = "x".repeat(2500);
    expect(splitText(blob, 1000).join("")).toBe(blob);
  });

  it("splits HTML only between elements", () => {
    const html = Array.from({ length: 20 }, (_, i) => `<p class="en">Para ${i} ${"w ".repeat(30)}</p>`).join("");
    const chunks = splitText(html, 500, true);
    expect(chunks.join("")).toBe(html);
    for (const c of chunks) expect(c).toMatch(/^<p[\s\S]*<\/p>$/);
  });
});

describe("packParts", () => {
  it("keeps every entry complete and in order across parts", () => {
    const entries = [
      { item: "a", text: "short a" },
      { item: "b", text: Array.from({ length: 10 }, (_, i) => `b${i} ` + "z".repeat(90)).join("\n\n") },
      { item: "c", text: "short c" },
    ];
    const parts = packParts(entries, 300);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every((p) => p.reduce((n, x) => n + x.text.length, 0) <= 300)).toBe(true);
    for (const e of entries) {
      const pieces = parts.flat().filter((x) => x.item === e.item);
      expect(strip(pieces.map((x) => x.text).join(""))).toBe(strip(e.text));
    }
    const b = parts.flat().filter((x) => x.item === "b");
    expect(b.map((x) => x.segment?.index)).toEqual(b.map((_, i) => i + 1));
    expect(parts.flat().map((x) => x.item)).toEqual([..."a" , ...b.map(() => "b"), "c"]);
  });
});
