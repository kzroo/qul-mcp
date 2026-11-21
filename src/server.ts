import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { QulClient, QulError, htmlToText, packParts, parseAyahKey } from "./qul.js";

export const VERSION = "0.1.0";

// Script fields the verses endpoint accepts (from QUL's V1::VersePresenter).
const VERSE_SCRIPTS = [
  "text_uthmani",
  "text_uthmani_simple",
  "text_uthmani_tajweed",
  "text_indopak",
  "text_indopak_nastaleeq",
  "text_imlaei",
  "text_imlaei_simple",
  "text_qpc_hafs",
  "text_qpc_hafs_tajweed",
  "text_qpc_nastaleeq",
  "text_qpc_nastaleeq_hafs",
  "text_digital_khatt",
  "text_digital_khatt_v1",
  "text_digital_khatt_indopak",
] as const;

const VERSE_META = [
  "juz_number",
  "hizb_number",
  "rub_el_hizb_number",
  "ruku_number",
  "surah_ruku_number",
  "manzil_number",
  "sajdah_type",
  "sajdah_number",
  "words_count",
] as const;

const WORD_FIELDS = [
  "text_uthmani",
  "text_uthmani_simple",
  "text_imlaei",
  "text_imlaei_simple",
  "text_indopak",
  "text_qpc_hafs",
  "en_transliteration",
  "audio_url",
] as const;

const READ_ONLY = { readOnlyHint: true, openWorldHint: true } as const;

// Characters of tafsir per response. Tafsir is never cut: anything longer is
// split into numbered parts the caller fetches in turn. This keeps each
// response under MCP clients' output limits (Claude Code's default is 25k
// tokens, and Arabic text can tokenize at well under 2 characters per token).
const PART_CHARS = Number(process.env.QUL_PART_CHARS) || 30_000;

const chapterNumber = z.number().int().min(1).max(114).describe("Surah number, 1-114");
const ayahKey = z.string().describe('Ayah key as "chapter:verse", e.g. "2:255"');
const textFormat = z
  .enum(["text", "html"])
  .default("text")
  .describe('"text" strips HTML and footnote markers (default); "html" returns QUL\'s markup as-is');
const locale = z
  .string()
  .optional()
  .describe('ISO code for translated names, e.g. "en", "ar", "ur". Defaults to English.');

function ok(data: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 1) }] };
}

function fail(err: unknown): CallToolResult {
  const message = err instanceof QulError ? err.message : `Unexpected error: ${(err as Error)?.message ?? err}`;
  return { isError: true, content: [{ type: "text", text: message }] };
}

function safe<A>(fn: (args: A) => Promise<unknown>) {
  return async (args: A): Promise<CallToolResult> => {
    try {
      return ok(await fn(args));
    } catch (err) {
      return fail(err);
    }
  };
}

function formatText(text: string | null | undefined, format: "text" | "html"): string {
  if (!text) return "";
  return format === "text" ? htmlToText(text) : text;
}

function idList(ids?: number[]): string | undefined {
  return ids?.length ? ids.join(",") : undefined;
}

function matches(query: string | undefined, ...fields: unknown[]): boolean {
  if (!query) return true;
  const q = query.toLowerCase();
  return fields.some((f) => typeof f === "string" && f.toLowerCase().includes(q));
}

function compactChapter(c: any) {
  return {
    id: c.id,
    name_simple: c.name_simple,
    name_arabic: c.name_arabic,
    translated_name: c.translated_name?.name,
    verses_count: c.verses_count,
    revelation_place: c.revelation_place,
    revelation_order: c.revelation_order,
    bismillah_pre: c.bismillah_pre,
    pages: c.pages,
  };
}

function compactTranslation(t: any, format: "text" | "html") {
  return {
    verse_key: t.verse_key,
    resource_id: t.resource_id,
    resource_name: t.translated_name?.name ?? t.resource_name,
    language: t.language_name,
    text: formatText(t.text, format),
  };
}

/**
 * Returns one part of a set of tafsir entries. Entries are complete across
 * parts: a long one is split at paragraph breaks and labeled
 * `segment: { index, of }`, never truncated.
 */
function tafsirPart(list: any[], format: "text" | "html", part: number, nextCall: (part: number) => object) {
  const parts = packParts(
    list.map((t) => ({ item: t, text: formatText(t.text, format) })),
    PART_CHARS,
    format === "html",
  );
  const total = Math.max(parts.length, 1);
  if (part > total) throw new QulError(`There are only ${total} part(s); part ${part} does not exist.`);
  const pieces = parts[part - 1] ?? [];
  const out: Record<string, unknown> = {
    part,
    total_parts: total,
    tafsirs: pieces.map(({ item: t, text, segment }) => ({
      verses: t.verses,
      resource_id: t.resource_id,
      resource_name: t.translated_name?.name ?? t.resource_name,
      language: t.language_name,
      ...(segment ? { segment: `${segment.index} of ${segment.of}` } : {}),
      text,
    })),
  };
  if (part < total) {
    out.next = {
      note: `This tafsir continues. Fetch part ${part + 1} of ${total} before summarizing or quoting it.`,
      call: nextCall(part + 1),
    };
  }
  return out;
}

function ayahRange(from: string, to?: string) {
  const start = parseAyahKey(from);
  const end = parseAyahKey(to ?? from);
  if (start.chapter !== end.chapter) {
    throw new QulError(
      `A range must stay inside one surah (got ${from} to ${to}). Make one call per surah.`,
    );
  }
  if (end.verse < start.verse) throw new QulError(`Range end ${to} comes before start ${from}.`);
  return { chapter: start.chapter, from: start.verse, to: end.verse };
}

export function createServer(client = new QulClient()): McpServer {
  const server = new McpServer(
    { name: "qul", title: "Quranic Universal Library", version: VERSION },
    {
      instructions:
        "Read-only access to the Quranic Universal Library (QUL) by Tarteel: Quran text in many scripts, " +
        "translations, tafsirs, word-by-word data, and recitation audio with ayah timings. " +
        "Ayahs are identified by keys like \"2:255\". Find translation, tafsir and recitation IDs with " +
        "qul_list_resources before requesting them by ID. Never paraphrase Quran text or translations as if quoting: " +
        "quote what the tools return and name the translation or tafsir it came from.",
    },
  );

  server.registerTool(
    "qul_list_chapters",
    {
      title: "List surahs",
      description: "List all 114 surahs with Arabic and transliterated names, translated name, verse count and revelation place.",
      inputSchema: { locale },
      annotations: READ_ONLY,
    },
    safe(async ({ locale }) => {
      const data = await client.get("chapters", { locale });
      return data.chapters.map(compactChapter);
    }),
  );

  server.registerTool(
    "qul_get_chapter",
    {
      title: "Get surah info",
      description: "Get details for one surah: names, verse count, revelation place and order, mushaf page range.",
      inputSchema: { chapter: chapterNumber, locale },
      annotations: READ_ONLY,
    },
    safe(async ({ chapter, locale }) => {
      const data = await client.get(`chapters/${chapter}`, { locale });
      return compactChapter(data.chapter);
    }),
  );

  server.registerTool(
    "qul_get_verses",
    {
      title: "Get ayahs",
      description:
        "Get the Arabic text of one ayah or a range inside a surah, optionally with translations and word-by-word data. " +
        'For a single ayah pass the same key as from and to, e.g. from "2:255".',
      inputSchema: {
        from: ayahKey.describe('First ayah, e.g. "2:255"'),
        to: ayahKey.optional().describe('Last ayah in the same surah, e.g. "2:257". Defaults to from.'),
        scripts: z
          .array(z.enum(VERSE_SCRIPTS))
          .default(["text_uthmani"])
          .describe("Arabic script variants to include. Defaults to text_uthmani."),
        metadata: z
          .array(z.enum(VERSE_META))
          .optional()
          .describe("Extra per-ayah fields such as juz_number or sajdah_type"),
        translation_ids: z
          .array(z.number().int())
          .max(10)
          .optional()
          .describe("Translation resource IDs to attach (max 10), e.g. [20] for Saheeh International. See qul_list_resources."),
        include_words: z.boolean().default(false).describe("Include word-by-word breakdown"),
        word_fields: z
          .array(z.enum(WORD_FIELDS))
          .optional()
          .describe("Word fields to include when include_words is true, e.g. en_transliteration"),
        word_translation_language: z
          .string()
          .optional()
          .describe('ISO code for word-by-word meanings, e.g. "en", "ur", "id". Implies include_words.'),
        text_format: textFormat,
      },
      annotations: READ_ONLY,
    },
    safe(async (args) => {
      const range = ayahRange(args.from, args.to);
      const withWords = args.include_words || !!args.word_translation_language;
      const count = range.to - range.from + 1;
      const cap = withWords ? 50 : 286;
      if (count > cap) {
        throw new QulError(
          `That is ${count} ayahs; this tool returns at most ${cap} per call${withWords ? " with words" : ""}. Split the range.`,
        );
      }

      const fields = [...args.scripts, ...(args.metadata ?? [])];
      const { items } = await client.getAllPages(
        `chapters/${range.chapter}/verses`,
        {
          from: range.from,
          to: range.to,
          fields: fields.join(","),
          translations: idList(args.translation_ids),
          words: withWords || undefined,
          word_fields: withWords ? args.word_fields?.join(",") : undefined,
          word_translation_language: args.word_translation_language,
        },
        (page) => page.verses,
        count,
      );

      return items.map((v: any) => {
        const out: Record<string, unknown> = { verse_key: v.verse_key, page_number: v.page_number };
        for (const f of fields) if (f in v) out[f] = v[f];
        if (v.translations) {
          out.translations = v.translations.map((t: any) => ({
            name: t.name,
            text: formatText(t.text, args.text_format),
          }));
        }
        if (withWords && v.words) {
          out.words = v.words.map((w: any) => {
            const word: Record<string, unknown> = { position: w.position, text: w.text };
            for (const f of args.word_fields ?? []) if (f in w) word[f] = w[f];
            if (w.translation) word.translation = w.translation.text;
            return word;
          });
        }
        return out;
      });
    }),
  );

  server.registerTool(
    "qul_list_resources",
    {
      title: "List QUL resources",
      description:
        "List available translations, tafsirs, languages, or recitations, with the IDs other tools take. " +
        "Use language and query to narrow the list; translations alone number about 200.",
      inputSchema: {
        type: z
          .enum(["translations", "tafsirs", "languages", "surah_recitations", "ayah_recitations"])
          .describe(
            "surah_recitations are one audio file per surah (most have ayah timings); ayah_recitations are one file per ayah",
          ),
        language: z
          .string()
          .optional()
          .describe('ISO code to filter translations/tafsirs, e.g. "en", "ur". Ignored for recitations.'),
        query: z.string().optional().describe("Case-insensitive match on name, author, slug or language"),
        limit: z.number().int().min(1).max(500).default(50),
      },
      annotations: READ_ONLY,
    },
    safe(async ({ type, language, query, limit }) => {
      let rows: any[];
      if (type === "surah_recitations" || type === "ayah_recitations") {
        const data = await client.get(`audio/${type}`);
        rows = data.recitations
          .map((r: any) => ({
            id: r.id,
            name: String(r.name ?? "").trim(),
            style: r.style,
            qirat: r.qirat,
            has_segments: r.has_segments,
          }))
          .filter((r: any) => matches(query, r.name, r.style, r.qirat));
      } else if (type === "languages") {
        const data = await client.get("resources/languages", { language });
        rows = data.languages
          .map((l: any) => ({
            iso_code: l.iso_code,
            name: l.name,
            native_name: l.native_name || undefined,
            direction: l.direction,
            translations_count: l.translations_count,
            tafsirs_count: l.tafsirs_count,
          }))
          .filter((l: any) => matches(query, l.name, l.native_name, l.iso_code));
      } else {
        const data = await client.get(`resources/${type}`, { language });
        rows = data[type]
          .map((r: any) => ({
            id: r.id,
            name: r.translated_name?.name ?? r.name,
            author: r.author_name,
            language: r.language_name,
            slug: r.slug,
            records_count: r.records_count,
          }))
          .filter((r: any) => matches(query, r.name, r.author, r.slug, r.language));
      }
      return { total: rows.length, showing: Math.min(rows.length, limit), results: rows.slice(0, limit) };
    }),
  );

  server.registerTool(
    "qul_get_translations",
    {
      title: "Get translations",
      description:
        "Get translations from one translation for a range of ayahs, or from several translations for one ayah. " +
        "Pass resource_id with from/to for a passage, or omit resource_id to compare translations of a single ayah.",
      inputSchema: {
        from: ayahKey,
        to: ayahKey.optional().describe("Last ayah of the range (only with resource_id). Defaults to from."),
        resource_id: z.number().int().optional().describe("One translation ID, e.g. 20 (Saheeh International)"),
        resource_ids: z
          .array(z.number().int())
          .optional()
          .describe("When comparing one ayah: limit to these translation IDs"),
        language: z.string().optional().describe('When comparing one ayah: limit to one language, e.g. "en"'),
        limit: z.number().int().min(1).max(300).default(10).describe("Maximum translations returned"),
        text_format: textFormat,
      },
      annotations: READ_ONLY,
    },
    safe(async (args) => {
      if (args.resource_id !== undefined) {
        const range = ayahRange(args.from, args.to);
        const data = await client.get(`translations/${args.resource_id}/by_range`, {
          from: `${range.chapter}:${range.from}`,
          to: `${range.chapter}:${range.to}`,
          per_page: 286,
        });
        return data.translations.slice(0, Math.max(args.limit, range.to - range.from + 1))
          .map((t: any) => compactTranslation(t, args.text_format));
      }
      if (args.to && args.to !== args.from) {
        throw new QulError("A range needs resource_id. Without it, this compares translations of one ayah.");
      }
      parseAyahKey(args.from);
      const data = await client.get(`translations/for_ayah/${args.from.trim()}`, {
        language: args.language,
        resource_ids: idList(args.resource_ids),
      });
      const list = data.translations;
      return {
        total: list.length,
        showing: Math.min(list.length, args.limit),
        translations: list.slice(0, args.limit).map((t: any) => compactTranslation(t, args.text_format)),
      };
    }),
  );

  server.registerTool(
    "qul_get_tafsir",
    {
      title: "Get tafsir",
      description:
        "Get tafsir (commentary) for an ayah. Pass resource_id for one tafsir (optionally over a range), or omit it " +
        "to get several tafsirs for one ayah. Tafsir entries often cover a group of ayahs; see the verses field. " +
        "Text is always complete: long tafsir comes in numbered parts, and the response's next.call says how to get the next one.",
      inputSchema: {
        from: ayahKey,
        to: ayahKey.optional().describe("Last ayah of the range (only with resource_id). Defaults to from."),
        resource_id: z.number().int().optional().describe("One tafsir ID, e.g. 169 (Ibn Kathir, English)"),
        resource_ids: z.array(z.number().int()).optional().describe("When not using resource_id: limit to these IDs"),
        language: z.string().optional().describe('When not using resource_id: limit to one language, e.g. "en"'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(50)
          .default(3)
          .describe("When not using resource_id: how many different tafsirs to include"),
        part: z
          .number()
          .int()
          .min(1)
          .default(1)
          .describe("Long tafsir is split into parts, never cut. Pass the part number from the previous response's next.call."),
        text_format: textFormat,
      },
      annotations: READ_ONLY,
    },
    safe(async (args) => {
      let list: any[];
      let total: number;
      if (args.resource_id !== undefined) {
        const range = ayahRange(args.from, args.to);
        const data = await client.get(`tafsirs/${args.resource_id}/by_range`, {
          from: `${range.chapter}:${range.from}`,
          to: `${range.chapter}:${range.to}`,
          per_page: 286,
        });
        list = data.tafsirs;
        total = list.length;
      } else {
        if (args.to && args.to !== args.from) {
          throw new QulError("A range needs resource_id. Without it, this returns several tafsirs for one ayah.");
        }
        parseAyahKey(args.from);
        const data = await client.get(`tafsirs/for_ayah/${args.from.trim()}`, {
          language: args.language,
          resource_ids: idList(args.resource_ids),
        });
        total = data.tafsirs.length;
        list = data.tafsirs.slice(0, args.limit);
      }
      const { part, text_format, ...rest } = args;
      return {
        ...(args.resource_id === undefined ? { tafsirs_available: total, tafsirs_included: list.length } : {}),
        ...tafsirPart(list, text_format, part, (next) => ({
          tool: "qul_get_tafsir",
          arguments: { ...rest, text_format, part: next },
        })),
      };
    }),
  );

  server.registerTool(
    "qul_get_audio",
    {
      title: "Get recitation audio",
      description:
        "Get audio URLs for a recitation. For a surah_recitation pass chapter; for an ayah_recitation pass chapter " +
        "and optionally ayah. Find recitation IDs with qul_list_resources.",
      inputSchema: {
        kind: z.enum(["surah", "ayah"]).describe('"surah" for surah_recitations IDs, "ayah" for ayah_recitations IDs'),
        recitation_id: z.number().int(),
        chapter: chapterNumber,
        ayah: z.number().int().min(1).optional().describe("Only for kind=ayah: one ayah number in the surah"),
      },
      annotations: READ_ONLY,
    },
    safe(async ({ kind, recitation_id, chapter, ayah }) => {
      if (kind === "surah") {
        const data = await client.get(`audio/surah_recitations/${recitation_id}`, { chapter });
        const r = data.recitation;
        const file = r.audio_files?.[String(chapter)];
        if (!file) throw new QulError(`Recitation ${recitation_id} has no audio for surah ${chapter}.`);
        return {
          recitation: { id: r.id, name: String(r.name ?? "").trim(), style: r.style, qirat: r.qirat },
          chapter,
          audio_url: file.audio_url,
          duration_seconds: file.duration,
          file_size_bytes: file.file_size,
          has_ayah_timings: r.has_segments,
        };
      }
      const data = await client.get(`audio/ayah_recitations/${recitation_id}`, { chapter });
      const r = data.recitation;
      let files = Object.entries(r.audio_files ?? {}).map(([key, f]: [string, any]) => ({
        verse_key: key,
        audio_url: f.audio_url,
      }));
      if (ayah !== undefined) files = files.filter((f) => f.verse_key === `${chapter}:${ayah}`);
      if (!files.length) throw new QulError(`No ayah audio found for recitation ${recitation_id} at ${chapter}${ayah ? ":" + ayah : ""}.`);
      return {
        recitation: { id: r.id, name: String(r.name ?? "").trim(), style: r.style, qirat: r.qirat },
        files,
      };
    }),
  );

  server.registerTool(
    "qul_get_ayah_timings",
    {
      title: "Get ayah timings",
      description:
        "Get start/end times (milliseconds) of each ayah inside a surah recitation's audio file, for syncing text " +
        "with audio. Only works for surah_recitations with has_segments=true.",
      inputSchema: {
        recitation_id: z.number().int().describe("A surah_recitations ID"),
        chapter: chapterNumber,
        from_ayah: z.number().int().min(1).optional(),
        to_ayah: z.number().int().min(1).optional(),
        include_word_segments: z
          .boolean()
          .default(false)
          .describe("Include word-level timing arrays where QUL has them"),
      },
      annotations: READ_ONLY,
    },
    safe(async ({ recitation_id, chapter, from_ayah, to_ayah, include_word_segments }) => {
      const params: Record<string, number | undefined> = { chapter };
      let limit = 286;
      if (from_ayah !== undefined) {
        params.from = from_ayah;
        params.to = to_ayah ?? from_ayah;
        limit = params.to - from_ayah + 1;
      }
      const { items, firstPage } = await client.getAllPages(
        `audio/surah_segments/${recitation_id}`,
        params,
        (page) =>
          Object.entries(page.segments ?? {}).map(([key, s]: [string, any]) => ({
            verse_key: key,
            time_from_ms: s.time_from,
            time_to_ms: s.time_to,
            ...(include_word_segments && s.segments?.length ? { word_segments: s.segments } : {}),
          })),
        limit,
      );
      return { audio_url: firstPage?.audio?.url, duration_seconds: firstPage?.audio?.duration, ayahs: items };
    }),
  );

  server.registerTool(
    "qul_random_ayah",
    {
      title: "Random ayah",
      description: "Pick a random ayah and return one translation or tafsir of it, optionally within one surah.",
      inputSchema: {
        type: z.enum(["translation", "tafsir"]).default("translation"),
        chapter: chapterNumber.optional(),
        language: z.string().default("en").describe('ISO language code, e.g. "en"'),
        resource_ids: z.array(z.number().int()).optional().describe("Pick only from these translation/tafsir IDs"),
        text_format: textFormat,
      },
      annotations: { ...READ_ONLY, idempotentHint: false },
    },
    safe(async ({ type, chapter, language, resource_ids, text_format }) => {
      const path = type === "translation" ? "translations/random" : "tafsirs/random";
      const data = await client.get(path, { chapter, language, resource_ids: idList(resource_ids) });
      const item = data[type];
      if (!item) throw new QulError("QUL returned no result for those filters.");
      if (type === "translation") return compactTranslation(item, text_format);
      // A random pick can't be re-fetched by part, so point long ones at qul_get_tafsir.
      const first = item.verses?.[0];
      const last = item.verses?.[item.verses.length - 1];
      return tafsirPart([item], text_format, 1, (next) => ({
        tool: "qul_get_tafsir",
        arguments: { from: first, to: last, resource_id: item.resource_id, text_format, part: next },
      }));
    }),
  );

  return server;
}
