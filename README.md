# qul-mcp

An [MCP](https://modelcontextprotocol.io) server and agent skill for the
[Quranic Universal Library (QUL)](https://qul.tarteel.ai) by Tarteel. It lets
Claude and other MCP clients look up Quran text, translations, tafsir,
word-by-word data and recitation audio.

It is read-only and needs no API key. It calls QUL's public JSON API at
`https://qul.tarteel.ai/api/v1`.

> **Not an official Tarteel project.** QUL's docs still list its public API as
> "coming soon", so endpoints may change. The full datasets (JSON/SQLite) are
> at <https://qul.tarteel.ai/resources> and need a free account.

## Tools

| Tool | What it does |
|---|---|
| `qul_list_chapters` | All 114 surahs with names, verse counts, revelation place |
| `qul_get_chapter` | Details for one surah |
| `qul_get_verses` | Arabic text of an ayah or range in any of 14 scripts, with optional translations and word-by-word meanings |
| `qul_list_resources` | Find IDs for translations, tafsirs, languages and recitations |
| `qul_get_translations` | One translation over a passage, or compare many translations of one ayah |
| `qul_get_tafsir` | Tafsir for an ayah or range, as plain text or HTML. Never truncated: long tafsir comes in numbered parts |
| `qul_get_audio` | Audio URLs for a surah or ayah recitation |
| `qul_get_ayah_timings` | Start/end time of each ayah inside a surah's audio file |
| `qul_random_ayah` | A random ayah with a translation or tafsir |

Ayahs are identified as `"chapter:verse"`, e.g. `"2:255"`.

## Install

Requires Node.js 20+.

```sh
git clone https://github.com/kzroo/qul-mcp.git
cd qul-mcp
npm install        # also builds dist/
```

### Claude Code

```sh
claude mcp add qul -- node /absolute/path/to/qul-mcp/dist/index.js
```

Optionally install the skill, which tells Claude when to use these tools and
how to quote Quran content responsibly:

```sh
mkdir -p ~/.claude/skills && cp -r skills/qul ~/.claude/skills/
```

### Claude Desktop and other MCP clients

```json
{
  "mcpServers": {
    "qul": {
      "command": "node",
      "args": ["/absolute/path/to/qul-mcp/dist/index.js"]
    }
  }
}
```

Long tafsir is split into parts of about 30,000 characters so each response
fits within MCP clients' output limits (Claude Code's default is 25,000
tokens). Set `QUL_PART_CHARS` to change the size.

Set `QUL_API_BASE_URL` to point at another QUL instance, for example a local
one at `http://localhost:3000/api/v1`.

## Development

```sh
npm run build       # compile to dist/
npm test            # unit tests
npm run test:live   # end-to-end tests against qul.tarteel.ai
```

## Notes on the QUL API

- The verses and segments endpoints paginate. QUL computes the page size as
  `[per_page | 10, 286].min`. That is a bitwise OR, so `per_page=5` returns 15
  rows and `per_page=50` returns 58. This server picks page sizes that come
  through unchanged and follows `next_page`.
- Some translations (e.g. 131, The Clear Quran) are not available from
  `/translations/{id}/by_range` but do appear when attached to verses with
  `translations=131`.

## License

MIT. Quran data comes from QUL; check each resource's license on
<https://qul.tarteel.ai/resources> before redistributing it.
