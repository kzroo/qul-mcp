// End-to-end tests against the real QUL API. Run with `npm run test:live`.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { beforeAll, describe, expect, it } from "vitest";
import { createServer } from "../src/server.js";

const live = process.env.QUL_LIVE ? describe : describe.skip;

live("qul-mcp against qul.tarteel.ai", () => {
  const client = new Client({ name: "test", version: "0" });

  beforeAll(async () => {
    const [a, b] = InMemoryTransport.createLinkedPair();
    await createServer().connect(a);
    await client.connect(b);
  });

  async function call(name: string, args: Record<string, unknown> = {}) {
    const res: any = await client.callTool({ name, arguments: args });
    const text = res.content[0].text;
    if (res.isError) return { error: text };
    return JSON.parse(text);
  }

  it("lists 114 surahs", async () => {
    const list = await call("qul_list_chapters");
    expect(list).toHaveLength(114);
    expect(list[0]).toMatchObject({ id: 1, name_simple: "Al-Fatihah", verses_count: 7 });
  });

  it("gets a range of ayahs with a translation, across QUL's page size", async () => {
    const verses = await call("qul_get_verses", { from: "2:1", to: "2:25", translation_ids: [20] });
    expect(verses.map((v: any) => v.verse_key)).toEqual(Array.from({ length: 25 }, (_, i) => `2:${i + 1}`));
    expect(verses[0].text_uthmani).toBeTruthy();
    expect(verses[0].translations[0].text).not.toMatch(/<sup/);
  });

  it("gets word-by-word meanings", async () => {
    const [v] = await call("qul_get_verses", {
      from: "1:1",
      word_translation_language: "en",
      word_fields: ["en_transliteration"],
    });
    expect(v.words[0]).toMatchObject({ position: 1, en_transliteration: "bis'mi", translation: "In (the) name" });
  });

  it("rejects ranges that cross surahs", async () => {
    const res = await call("qul_get_verses", { from: "1:7", to: "2:1" });
    expect(res.error).toMatch(/inside one surah/);
  });

  it("lists and filters resources", async () => {
    const res = await call("qul_list_resources", { type: "translations", language: "en", query: "saheeh" });
    expect(res.results.some((r: any) => r.id === 20)).toBe(true);
    const recs = await call("qul_list_resources", { type: "surah_recitations", limit: 5 });
    expect(recs.results.length).toBeGreaterThan(0);
  });

  it("gets one translation over a range and compares translations of one ayah", async () => {
    const range = await call("qul_get_translations", { from: "1:1", to: "1:7", resource_id: 20 });
    expect(range).toHaveLength(7);
    const compare = await call("qul_get_translations", { from: "1:1", language: "en", limit: 3 });
    expect(compare.translations).toHaveLength(3);
    expect(compare.total).toBeGreaterThan(3);
  });

  it("returns short tafsir whole in one part", async () => {
    const res = await call("qul_get_tafsir", { from: "2:255", resource_id: 169 });
    expect(res).toMatchObject({ part: 1, total_parts: 1 });
    expect(res.next).toBeUndefined();
    expect(res.tafsirs[0].verses).toContain("2:255");
    expect(res.tafsirs[0].text).not.toMatch(/<p|<div/);
  });

  it("splits a 100k-character tafsir into parts without losing any of it", async () => {
    // Tafsir Ibn Uthaymeen on 2:255 is ~106k characters of Arabic.
    const raw = await fetch("https://qul.tarteel.ai/api/v1/tafsirs/1485/by_range?from=2:255&to=2:255").then((r) => r.json());
    const { htmlToText } = await import("../src/qul.js");
    const full = htmlToText(raw.tafsirs[0].text);

    let args: any = { from: "2:255", resource_id: 1485 };
    const texts: string[] = [];
    let total = 0;
    for (let guard = 0; guard < 20; guard++) {
      const res = await call("qul_get_tafsir", args);
      total = res.total_parts;
      texts.push(...res.tafsirs.map((t: any) => t.text));
      if (!res.next) break;
      expect(res.next.call.tool).toBe("qul_get_tafsir");
      args = res.next.call.arguments;
    }
    expect(total).toBeGreaterThan(1);
    expect(texts).toHaveLength(total);
    expect(texts.join("").replace(/\s+/g, "")).toBe(full.replace(/\s+/g, ""));
  });

  it("caps how many tafsirs are compared but never their length", async () => {
    const res = await call("qul_get_tafsir", { from: "1:1", language: "en", limit: 2 });
    expect(res.tafsirs_included).toBe(2);
    expect(res.tafsirs_available).toBeGreaterThan(2);
  });

  it("gets surah audio, ayah audio and ayah timings", async () => {
    const surah = await call("qul_get_audio", { kind: "surah", recitation_id: 43, chapter: 1 });
    expect(surah.audio_url).toMatch(/^https:.*\.mp3$/);
    const ayah = await call("qul_get_audio", { kind: "ayah", recitation_id: 15, chapter: 1, ayah: 2 });
    expect(ayah.files).toEqual([{ verse_key: "1:2", audio_url: expect.stringMatching(/001002\.mp3$/) }]);
    const timings = await call("qul_get_ayah_timings", { recitation_id: 43, chapter: 1 });
    expect(timings.ayahs).toHaveLength(7);
    expect(timings.ayahs[0].time_to_ms).toBeGreaterThan(timings.ayahs[0].time_from_ms);
  });

  it("returns a random translation", async () => {
    const res = await call("qul_random_ayah", { chapter: 1 });
    expect(res.verse_key).toMatch(/^1:\d$/);
  });

  it("surfaces QUL's own error messages", async () => {
    const res = await call("qul_get_translations", { from: "9:999", language: "en" });
    expect(res.error).toMatch(/not found/i);
  });
});
