# eventor-mcp

An [MCP](https://modelcontextprotocol.io) server that exposes the **full [Eventor](https://eventor.orienteering.asn.au) orienteering API** as tools, so Claude and other MCP clients can query events, entries, start lists, results, clubs, members and activities, and, when you allow it, publish start and result lists.

It works with **Eventor Australia** (the default), **Sweden**, **Norway** and **IOF**, or any Eventor install via a custom base URL.

## Coverage

Every endpoint on each instance's [API documentation page](https://eventor.orienteering.asn.au/api/documentation) has a tool. Endpoints that only one instance offers are only registered for that instance.

| Area | Tools |
|---|---|
| Events | `list_events`, `list_events_iofxml`, `list_wrs_events` (IOF), `list_event_documents`, `get_event`, `get_event_iofxml`, `list_event_classes`, `list_entry_fees` |
| Organisations & people | `get_api_key_organisation`, `list_organisations`, `list_organisations_iofxml`, `get_organisation`, `list_organisation_persons`, `list_memberships` (AU), `list_competitors`, `get_competitor`, `save_competitor` ✏️, `get_external_login_url`, `authenticate_person` |
| Entries | `list_entries`, `get_competitor_count` |
| Start lists | `get_event_starts`, `get_event_starts_iofxml`, `get_person_starts`, `get_organisation_starts` |
| Results | `get_event_results`, `get_event_results_iofxml`, `get_wrs_class_results` (IOF), `get_person_results`, `get_organisation_results` |
| Club activities | `list_activities`, `get_activity` |
| Organiser (experimental) | `export_organisations`, `export_event`, `export_base_classes`, `export_classes`, `export_entries`, `export_competitors`, `export_cached_competitors`, `import_startlist` ✏️, `import_resultlist` ✏️ |
| Utilities | `eventor_get` (GET any path), `clear_cache` |

✏️ = writes to Eventor. These tools are marked destructive and need `confirm: true`, which the model should only set after you approve the change. Set `EVENTOR_READ_ONLY=true` to hide them completely.

The organiser export/import endpoints aren't in Eventor's public docs. Event software such as MeOS uses them, and they may behave differently between instances. On Eventor Australia, all seven exports work with a club API key (tested November 2026).

### What the API can't do

Eventor's API can't create or edit events, classes, entry fees, documents or entries, and it can't change an event's status. On the website these are only HTML forms behind a CAPTCHA-protected login, with no API equivalent. The only writes the API supports are competitor settings and start list/result list uploads, and this server covers all three. The import tools haven't been tested, because they publish data.

### Tested against Eventor Australia

Every read tool was called against real Newcastle Orienteering Club data, and all returned data except one: `get_competitor` returned 403 for competitor IDs and an empty element for person IDs. Use `list_competitors` instead. `get_activity` wasn't tested because the club has no activities in Eventor, and `get_external_login_url` wasn't called because it creates a real login link. The write tools haven't been run.

Responses are converted from Eventor's XML to compact JSON. Pass `raw: true` to get the XML unchanged, for example to load an IOF XML start list into event software. GET responses are cached for 5 minutes, as Eventor's terms of use ask.

## Setup

You need Node.js 20+ and your club's Eventor API key. A club administrator can find it in Eventor under the organisation's admin settings.

```bash
git clone https://github.com/JustinStafford/eventor-mcp.git
cd eventor-mcp
npm install
npm run build
```

### Claude Code

```bash
claude mcp add eventor --scope user -e EVENTOR_API_KEY=your-key -- node /path/to/eventor-mcp/dist/index.js
```

### Claude Desktop

Add this to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "eventor": {
      "command": "node",
      "args": ["/path/to/eventor-mcp/dist/index.js"],
      "env": { "EVENTOR_API_KEY": "your-key" }
    }
  }
}
```

Instead of putting secrets in the client config, you can put them in a `.env` file (see `.env.example`). The server checks the directory it runs from, then its own install directory (the clone), then `~/.config/eventor-mcp/.env`. Variables already set in the environment take precedence. `.env` is git-ignored.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `EVENTOR_INSTANCE` | `au` | `au`, `se`, `no` or `iof` |
| `EVENTOR_BASE_URL` | – | Any Eventor API root; overrides `EVENTOR_INSTANCE` and enables every tool |
| `EVENTOR_API_KEY` | – | Club API key (sent as the `ApiKey` header) |
| `EVENTOR_USERNAME` / `EVENTOR_PASSWORD` | – | Personal Eventor login, for `authenticate_person` and organiser tools with `useLogin: true` |
| `EVENTOR_CACHE_TTL_SECONDS` | `300` | Response cache lifetime; `0` disables it |
| `EVENTOR_MAX_RESPONSE_CHARS` | `200000` | Longer responses are truncated with a hint to narrow the query |
| `EVENTOR_READ_ONLY` | `false` | Hide all tools that write to Eventor |

Credentials are only read from the environment. They never appear in tool arguments or results.

## Things to know

- **Your own club only.** An API key belongs to one organisation. Members, competitors, memberships, activities, external login links and club starts/results only work for that organisation's ID. Call `get_api_key_organisation` first to find it.
- **Keep queries narrow.** `list_organisations`, `list_entries` and results with split times can be very large. Use date ranges, IDs and `top`. `list_organisations` also has local filters (`nameContains`, `organisationTypeIds`, `parentOrganisationId`) that are applied after the download.
- Dates are `yyyy-mm-dd` or `yyyy-mm-dd hh:mm:ss`. A date-only "from" starts at 00:00:00 and a date-only "to" ends at 23:59:59.

## Development

```bash
npm test          # vitest, with Eventor mocked
npm run typecheck
npm run build
```

Tools are generated from the endpoint table in [`src/endpoints.ts`](src/endpoints.ts). To support a new endpoint, add an entry there.

## License

MIT
