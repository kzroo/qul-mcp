---
name: qul
description: Build apps with Islamic content and look up Quran text, translations, tafsir (commentary), word-by-word meanings, and recitation audio from the Quranic Universal Library (QUL) by Tarteel. Use when building or changing anything that shows Quran text, translations, tafsir, recitations or surah data (Quran readers, ayah-of-the-day widgets, recitation players, tafsir screens, memorization or study apps), and when the user asks what an ayah says, wants a translation or tafsir, compares translations, or needs Arabic in a specific script, word-by-word data, reciter audio or ayah timings.
---

# Quranic Universal Library (QUL)

QUL (https://qul.tarteel.ai) is Tarteel's open library of Quran data. Use the `qul_*` MCP tools when they are available. If they are not, call the same JSON API directly (see "Without the MCP server").

## Building apps

The MCP tools are for you while you build. The app itself should not depend on this MCP server at runtime.

1. **Find the real resources first.** Use `qul_list_resources` to choose translations, tafsirs and recitations by language and author, and use their real IDs. Don't guess IDs or invent resource names. If the user hasn't picked one, propose two or three options with their names and IDs.
2. **Look at real responses before writing code against them.** Call the tool for a sample ayah with the scripts, translations and word fields the app needs, then write types and parsing to match. Use `text_format: "html"` to see the raw markup the app will receive: translations can contain footnote markers (`<sup foot_note=…>`), and tafsirs are HTML.
3. **Never type Quran text, translations or tafsir into code from memory,** including in seed data, fixtures, tests, mock screens and placeholder copy. Fetch the text and paste it exactly as returned, with its ayah key and source.
4. **Choose the production data source with the user:**
   - *Bundled datasets* (recommended for most apps): download JSON or SQLite from https://qul.tarteel.ai/resources (needs a free account, so the user downloads them) and ship or host them. Works offline, doesn't change under you.
   - *The JSON API* (`https://qul.tarteel.ai/api/v1`): no bundling, but QUL's docs still call it "in design", so paths can change. Cache responses, and keep API access in one module so it's easy to switch.
5. **Render Arabic correctly.** Set `dir="rtl"` and `lang="ar"` on Arabic text, use a font made for the script you chose (QUL publishes them at https://qul.tarteel.ai/resources/font), and define fallbacks such as `'Amiri Quran', 'Noto Naskh Arabic', serif`. Never strip or normalise diacritics in displayed text. A simplified script (e.g. `text_imlaei_simple`) is fine for search indexes, but not for display.
6. **Audio sync:** for ayah highlighting, use a surah recitation with `has_segments: true` and `qul_get_ayah_timings`. Times are in milliseconds from the start of that surah's file.
7. **Attribution and licenses:** show the translation or tafsir name wherever its text appears in the UI. Each resource has its own license; ask the user to check it on the Resources page before the app bundles or redistributes it.

## Rules for Quran content

- **Never quote the Quran or a translation from memory.** Fetch it, then quote it exactly as returned.
- **Always say where the text came from:** the translation or tafsir name (e.g. "Saheeh International"), and the ayah key.
- Present the Arabic before the translation when showing both. Keep the Arabic exactly as returned: do not normalise diacritics or re-type it.
- A tafsir is a scholar's commentary, not the Quran itself. Attribute it to its author, don't merge several tafsirs into one voice, and don't present part of a tafsir as the whole.
- For questions of religious rulings, show what the sources say and suggest the user consult a qualified scholar. Don't issue rulings.

## Identifiers

- Ayahs are `"chapter:verse"` keys, e.g. `"2:255"` (Ayat al-Kursi). Surahs are 1–114.
- A range must stay inside one surah. Split cross-surah requests into one call per surah.
- Translation, tafsir and recitation IDs come from `qul_list_resources`. Don't guess IDs, except the common ones below, which are stable:

| ID | Resource |
|---|---|
| 20 | Saheeh International (English translation) |
| 131 | Dr. Mustafa Khattab, The Clear Quran (English; works in `qul_get_verses` only, not as a `qul_get_translations` resource_id) |
| 169 | Tafsir Ibn Kathir (English, abridged) |
| 168 | Maarif-ul-Quran (English tafsir) |

## Which tool

| Need | Tool |
|---|---|
| Arabic text of an ayah or passage, optionally with translations | `qul_get_verses` (`from`, `to`, `translation_ids`) |
| Word-by-word meaning / transliteration | `qul_get_verses` with `word_translation_language: "en"` and `word_fields: ["en_transliteration"]` |
| One translation across a passage | `qul_get_translations` with `resource_id`, `from`, `to` |
| Compare translations of one ayah | `qul_get_translations` with `from` and `language` (no `resource_id`) |
| Tafsir | `qul_get_tafsir` (`resource_id` for one tafsir; omit it to see several) |
| Find IDs | `qul_list_resources` with `type` and `language` / `query` |
| Surah list or info | `qul_list_chapters`, `qul_get_chapter` |
| Recitation audio | `qul_list_resources` (`surah_recitations` or `ayah_recitations`), then `qul_get_audio` |
| Sync text with audio | `qul_get_ayah_timings` (surah recitations with `has_segments: true`) |
| Ayah of the day | `qul_random_ayah` |

## Keeping responses small

- Translations of one ayah number ~200: pass `language` and keep `limit` low.
- Tafsir is never truncated. A long one (some Arabic tafsirs run past 100,000 characters) comes back in numbered parts. When a response has `next`, call `next.call` to get the following part. **Read every part before summarizing, quoting, or drawing a conclusion from a tafsir**: the scholar's conclusion is often at the end.
- To compare tafsirs of one ayah, `limit` caps how many tafsirs are included, never how much of each.
- Tafsir entries often cover a group of ayahs. The `verses` field says which. Don't repeat the same entry for each ayah in the group.
- `qul_get_verses` returns at most 286 ayahs per call (50 with words).

## Without the MCP server

The tools wrap QUL's public JSON API. No key is needed. Base URL: `https://qul.tarteel.ai/api/v1`.

```
GET /chapters                                      # ?locale=ar
GET /chapters/{n}/verses?from=255&to=257&fields=text_uthmani&translations=20
       &words=true&word_translation_language=en&word_fields=en_transliteration
GET /resources/{translations|tafsirs|languages}?language=en
GET /translations/{id}/by_range?from=1:1&to=1:7
GET /translations/for_ayah/{key}?language=en&resource_ids=20,131
GET /tafsirs/{id}/by_range?from=2:255&to=2:255
GET /tafsirs/for_ayah/{key}?language=en
GET /audio/{surah_recitations|ayah_recitations}
GET /audio/surah_recitations/{id}                  # audio_files keyed by surah number
GET /audio/ayah_recitations/{id}?chapter=1         # audio_files keyed by ayah key
GET /audio/surah_segments/{id}?chapter=1           # ayah timings in ms
GET /translations/random?chapter=1&language=en
```

The verses and segments endpoints are paginated (`page`, `per_page`). QUL computes the page size as `per_page | 10` (bitwise OR), so ask for 10, 26, 58 or 286, or follow `pagination.next_page`.

QUL's API is still marked "coming soon" in its docs, so these paths may change. Full datasets (JSON/SQLite) are at https://qul.tarteel.ai/resources and need a free account to download.
