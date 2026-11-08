import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildQuery, EventorClient, MAX_CACHE_CHARS, MAX_CACHE_ENTRIES, parseXml } from "../src/client.js";
import { loadConfig } from "../src/config.js";
import { ENDPOINTS, endpointsFor } from "../src/endpoints.js";
import { createServer, formatBody, normaliseDate } from "../src/server.js";

const baseEnv = { EVENTOR_INSTANCE: "au", EVENTOR_API_KEY: "test-key" };

function mockFetch(body = "<Organisation><OrganisationId>42</OrganisationId></Organisation>", status = 200) {
  return vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
    new Response(body, { status, headers: { "content-type": "text/xml" } }),
  );
}

async function connect(env: Record<string, string> = baseEnv, fetchFn = mockFetch()) {
  const config = loadConfig(env);
  const server = createServer(config, new EventorClient(config, fetchFn as unknown as typeof fetch));
  const client = new Client({ name: "test", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return { client, fetchFn };
}

function text(result: Awaited<ReturnType<Client["callTool"]>>): string {
  return (result.content as Array<{ type: string; text: string }>)[0].text;
}

describe("config", () => {
  it("defaults to Eventor Australia", () => {
    expect(loadConfig({}).baseUrl).toBe("https://eventor.orienteering.asn.au/api/");
  });
  it("accepts a custom base URL and adds a trailing slash", () => {
    const c = loadConfig({ EVENTOR_BASE_URL: "https://example.org/api" });
    expect(c.baseUrl).toBe("https://example.org/api/");
    expect(c.instance).toBeUndefined();
  });
  it("rejects unknown instances", () => {
    expect(() => loadConfig({ EVENTOR_INSTANCE: "xx" })).toThrow(/Unknown EVENTOR_INSTANCE/);
  });
});

describe("helpers", () => {
  it("joins arrays and drops empty query values", () => {
    expect(buildQuery({ a: [1, 2], b: undefined, c: true, d: "" }).toString()).toBe("a=1%2C2&c=true");
  });
  it("normalises date-only from/to values", () => {
    expect(normaliseDate("fromDate", "2026-01-02")).toBe("2026-01-02 00:00:00");
    expect(normaliseDate("toEventDate", "2026-01-02")).toBe("2026-01-02 23:59:59");
    expect(normaliseDate("to", "2026-01-02 10:30")).toBe("2026-01-02 10:30:00");
  });
  it("always parses Eventor list children as arrays and keeps IDs as strings", () => {
    const doc = parseXml("<EventList><Event><EventId>0123</EventId></Event></EventList>") as any;
    expect(doc.EventList.Event).toEqual([{ EventId: "0123" }]);
  });
  it("truncates long responses", () => {
    const out = formatBody("x".repeat(50), true, 10);
    expect(out.startsWith("xxxxxxxxxx\n")).toBe(true);
    expect(out).toMatch(/Truncated/);
  });
});

describe("endpoint table", () => {
  it("has unique tool names", () => {
    const names = ENDPOINTS.map((e) => e.name);
    expect(new Set(names).size).toBe(names.length);
  });
  it("covers the documented Eventor Australia endpoints, except two left out on purpose", () => {
    const au = endpointsFor("au").map((e) => `${e.method} ${e.path}`);
    for (const p of [
      "GET events", "GET events/iofxml", "GET events/documents", "GET event/{eventId}", "GET event/iofxml/{eventId}",
      "GET eventclasses", "GET entryfees/events/{eventId}", "GET organisation/apiKey", "GET organisations",
      "GET organisations/iofxml", "GET organisation/{id}", "GET persons/organisations/{organisationId}",
      "GET competitors", "GET entries", "GET competitorcount",
      "GET starts/event", "GET starts/event/iofxml", "GET starts/person", "GET starts/organisation",
      "GET results/event", "GET results/event/iofxml", "GET results/person", "GET results/organisation",
      "GET activities", "GET activity", "GET competitor/{competitorId}", "PUT competitor", "GET memberships",
    ]) {
      expect(au).toContain(p);
    }
    expect(au).not.toContain("GET externalLoginUrl");
    expect(au).not.toContain("GET authenticatePerson");
  });
  it("filters instance-specific endpoints", () => {
    const no = endpointsFor("no").map((e) => e.name);
    expect(no).not.toContain("list_memberships");
    expect(no).not.toContain("list_wrs_events");
    expect(endpointsFor("iof").map((e) => e.name)).toContain("list_wrs_events");
  });
  it("hides write tools in read-only mode", () => {
    expect(endpointsFor("au", true).some((e) => e.write)).toBe(false);
  });
});

describe("MCP server", () => {
  it("lists all Australian tools plus clear_cache", async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    expect(tools.length).toBe(endpointsFor("au").length + 1);
    const names = tools.map((t) => t.name);
    for (const removed of ["eventor_get", "get_external_login_url", "authenticate_person"]) {
      expect(names).not.toContain(removed);
    }
    const save = tools.find((t) => t.name === "save_competitor")!;
    expect(save.annotations?.destructiveHint).toBe(true);
    expect(save.inputSchema.required).toContain("confirm");
  });

  it("sends the API key, fills path params and builds the query", async () => {
    const { client, fetchFn } = await connect();
    await client.callTool({ name: "get_event", arguments: { eventId: 123 } });
    await client.callTool({
      name: "list_events",
      arguments: { fromDate: "2026-01-01", organisationIds: [1, 2], includeEntryBreaks: true },
    });
    const [url1, init1] = fetchFn.mock.calls[0];
    expect(url1).toBe("https://eventor.orienteering.asn.au/api/event/123");
    expect((init1!.headers as Record<string, string>).ApiKey).toBe("test-key");
    const url2 = new URL(fetchFn.mock.calls[1][0] as string);
    expect(url2.pathname).toBe("/api/events");
    expect(url2.searchParams.get("fromDate")).toBe("2026-01-01 00:00:00");
    expect(url2.searchParams.get("organisationIds")).toBe("1,2");
    expect(url2.searchParams.get("includeEntryBreaks")).toBe("true");
  });

  it("returns JSON by default and XML with raw", async () => {
    const { client } = await connect();
    const json = text(await client.callTool({ name: "get_api_key_organisation", arguments: {} }));
    expect(JSON.parse(json)).toEqual({ Organisation: { OrganisationId: "42" } });
    const xml = text(await client.callTool({ name: "get_organisation", arguments: { id: 42, raw: true } }));
    expect(xml).toMatch(/^<Organisation>/);
  });

  it("flattens value wrappers and drops namespace attributes", () => {
    const doc = parseXml('<A xmlns:xsi="x"><CountryId value="36"/><Name lang="en">Oz</Name></A>');
    expect(doc).toEqual({ A: { CountryId: "36", Name: { "#text": "Oz", "@lang": "en" } } });
  });

  it("filters list_organisations locally without sending filter params", async () => {
    const xml =
      "<OrganisationList>" +
      "<Organisation><OrganisationId>5</OrganisationId><Name>Orienteering NSW</Name><OrganisationTypeId>2</OrganisationTypeId></Organisation>" +
      "<Organisation><OrganisationId>29</OrganisationId><Name>Newcastle Orienteering Club</Name><OrganisationTypeId>3</OrganisationTypeId><ParentOrganisation><OrganisationId>5</OrganisationId></ParentOrganisation></Organisation>" +
      "<Organisation><OrganisationId>30</OrganisationId><Name>Bushflyers</Name><OrganisationTypeId>3</OrganisationTypeId><ParentOrganisation><OrganisationId>5</OrganisationId></ParentOrganisation></Organisation>" +
      "</OrganisationList>";
    const { client, fetchFn } = await connect(baseEnv, mockFetch(xml));
    const ids = async (args: Record<string, unknown>) =>
      JSON.parse(text(await client.callTool({ name: "list_organisations", arguments: args }))).OrganisationList.Organisation.map(
        (o: { OrganisationId: string }) => o.OrganisationId,
      );
    expect(await ids({ nameContains: "newcastle" })).toEqual(["29"]);
    expect(await ids({ organisationTypeIds: [3], parentOrganisationId: 5 })).toEqual(["29", "30"]);
    expect(await ids({ organisationTypeIds: [2] })).toEqual(["5"]);
    expect(new URL(fetchFn.mock.calls[0][0] as string).search).toBe("");
  });

  it("caches GET responses", async () => {
    const { client, fetchFn } = await connect();
    await client.callTool({ name: "get_organisation", arguments: { id: 1 } });
    await client.callTool({ name: "get_organisation", arguments: { id: 1 } });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    await client.callTool({ name: "clear_cache", arguments: {} });
    await client.callTool({ name: "get_organisation", arguments: { id: 1 } });
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("refuses writes without confirm", async () => {
    const { client, fetchFn } = await connect();
    const res = await client.callTool({ name: "save_competitor", arguments: { xml: "<Competitor/>" } });
    expect(res.isError).toBe(true);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("PUTs XML bodies for confirmed writes", async () => {
    const { client, fetchFn } = await connect();
    await client.callTool({ name: "save_competitor", arguments: { xml: "<Competitor/>", confirm: true } });
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe("https://eventor.orienteering.asn.au/api/competitor");
    expect(init!.method).toBe("PUT");
    expect(init!.body).toBe("<Competitor/>");
  });

  it("uses the personal login for organiser useLogin", async () => {
    const env = { ...baseEnv, EVENTOR_USERNAME: "me", EVENTOR_PASSWORD: "pw" };
    const { client, fetchFn } = await connect(env);
    await client.callTool({ name: "export_classes", arguments: { eventId: 5, useLogin: true } });
    const [url, init] = fetchFn.mock.calls[0];
    const h = init!.headers as Record<string, string>;
    expect(h.Username).toBe("me");
    expect(h.Password).toBe("pw");
    expect(h.ApiKey).toBeUndefined();
    expect(new URL(url as string).searchParams.get("version")).toBe("3.0");
  });

  it("reports missing credentials and HTTP errors as tool errors", async () => {
    const { client } = await connect({ EVENTOR_INSTANCE: "au" });
    const res = await client.callTool({ name: "get_event", arguments: { eventId: 1 } });
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/EVENTOR_API_KEY/);

    const { client: c2 } = await connect(baseEnv, mockFetch("Forbidden", 403));
    const res2 = await c2.callTool({ name: "list_competitors", arguments: { organisationId: 9 } });
    expect(res2.isError).toBe(true);
    expect(text(res2)).toMatch(/HTTP 403.*own club/);
  });

  it("offers no tool that takes a free-form path", async () => {
    const { client } = await connect();
    for (const tool of (await client.listTools()).tools) {
      expect(Object.keys(tool.inputSchema.properties ?? {})).not.toContain("path");
    }
  });

  it("does not follow redirects, which would carry the API key along", async () => {
    const { client, fetchFn } = await connect();
    await client.callTool({ name: "get_event", arguments: { eventId: 1 } });
    expect(fetchFn.mock.calls[0][1]!.redirect).toBe("error");
  });

  it("rejects unknown arguments instead of ignoring them", async () => {
    const { client, fetchFn } = await connect();
    const res = await client.callTool({ name: "get_event", arguments: { eventId: 1, nonsense: "x" } });
    expect(res.isError).toBe(true);
    expect(fetchFn).not.toHaveBeenCalled();
    const util = await client.callTool({ name: "clear_cache", arguments: { nonsense: "x" } });
    expect(util.isError).toBe(true);
  });

  describe("EVENTOR_EXCLUDE_TOOLS", () => {
    const hidden = ["export_cached_competitors", "get_event"];
    const env = { ...baseEnv, EVENTOR_EXCLUDE_TOOLS: ` ${hidden.join(" , ")} ` };

    it("removes the named tools and leaves the rest", async () => {
      const { client } = await connect(env);
      const names = (await client.listTools()).tools.map((t) => t.name);
      for (const name of hidden) expect(names).not.toContain(name);
      expect(names).toContain("clear_cache");
      expect(names.length).toBe(endpointsFor("au").length + 1 - hidden.length);
    });

    it("makes an excluded tool uncallable", async () => {
      const { client, fetchFn } = await connect(env);
      const res = await client.callTool({ name: "get_event", arguments: { eventId: 1 } });
      expect(res.isError).toBe(true);
      expect(fetchFn).not.toHaveBeenCalled();
    });

    it("can exclude clear_cache", async () => {
      const { client } = await connect({ ...baseEnv, EVENTOR_EXCLUDE_TOOLS: "clear_cache" });
      expect((await client.listTools()).tools.length).toBe(endpointsFor("au").length);
    });

    it("fails at startup on a misspelled name", () => {
      expect(() => createServer(loadConfig({ ...baseEnv, EVENTOR_EXCLUDE_TOOLS: "get_evnt" }))).toThrow(/get_evnt/);
    });
  });

  it("offers useLogin only when a personal login is configured", async () => {
    const properties = async (env: Record<string, string>) => {
      const { client } = await connect(env);
      const tool = (await client.listTools()).tools.find((t) => t.name === "export_classes")!;
      return Object.keys(tool.inputSchema.properties ?? {});
    };
    expect(await properties(baseEnv)).not.toContain("useLogin");
    expect(await properties({ ...baseEnv, EVENTOR_USERNAME: "me", EVENTOR_PASSWORD: "pw" })).toContain("useLogin");
  });
});

describe("API root guard", () => {
  function clientWith() {
    const fetchFn = mockFetch();
    return { fetchFn, c: new EventorClient(loadConfig(baseEnv), fetchFn as unknown as typeof fetch) };
  }

  it.each([
    "https://evil.example/x",
    "\\\\evil.example/x",
    "\\/evil.example/x",
    " https://evil.example/x",
    "\thttps://evil.example/x",
    "ht\ntps://evil.example/x",
    "HTTPS://evil.example/x",
    "ftp://evil.example/x",
    "file:///etc/passwd",
    "javascript:alert(1)",
    "../account/login",
    "%2e%2e/account/login",
    "%2E%2e/%2e%2e/account/login",
  ])("never sends credentials outside the API root: %j", async (path) => {
    const { c, fetchFn } = clientWith();
    await expect(c.request(path)).rejects.toThrow(/API root/);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("allows paths inside the API root", async () => {
    const { c, fetchFn } = clientWith();
    await c.request("/api/events", { query: { eventIds: "1" } });
    expect(fetchFn.mock.calls[0][0]).toBe("https://eventor.orienteering.asn.au/api/events?eventIds=1");
  });
});

describe("response cache limits", () => {
  const entries = (c: EventorClient) => (c as unknown as { cache: Map<string, unknown> }).cache.size;
  const chars = (c: EventorClient) => (c as unknown as { cacheChars: number }).cacheChars;

  function clientWith(body: string) {
    const config = loadConfig(baseEnv);
    return new EventorClient(config, mockFetch(body) as unknown as typeof fetch);
  }

  afterEach(() => vi.restoreAllMocks());

  it("never holds more than the entry limit, dropping the oldest first", async () => {
    const fetchFn = mockFetch("<A/>");
    const c = new EventorClient(loadConfig(baseEnv), fetchFn as unknown as typeof fetch);
    for (let i = 0; i < MAX_CACHE_ENTRIES + 25; i++) await c.request(`event/${i}`);
    expect(entries(c)).toBe(MAX_CACHE_ENTRIES);
    const calls = fetchFn.mock.calls.length;
    await c.request(`event/${MAX_CACHE_ENTRIES + 24}`);
    expect(fetchFn.mock.calls.length).toBe(calls);
    await c.request("event/0");
    expect(fetchFn.mock.calls.length).toBe(calls + 1);
  });

  it("drops expired entries when storing a new one", async () => {
    const c = clientWith("<A/>");
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    await c.request("event/1");
    await c.request("event/2");
    expect(entries(c)).toBe(2);
    now.mockReturnValue(1_000_000 + 301_000);
    await c.request("event/3");
    expect(entries(c)).toBe(1);
  });

  it("keeps the total size under the limit and skips anything larger", async () => {
    const half = clientWith("x".repeat(MAX_CACHE_CHARS / 2 + 1));
    await half.request("event/1");
    await half.request("event/2");
    expect(entries(half)).toBe(1);
    expect(chars(half)).toBe(MAX_CACHE_CHARS / 2 + 1);

    const huge = clientWith("x".repeat(MAX_CACHE_CHARS + 1));
    await huge.request("event/1");
    expect(entries(huge)).toBe(0);
    expect(chars(huge)).toBe(0);
  });

  it("keeps its size count right after a clear", async () => {
    const c = clientWith("<A/>");
    await c.request("event/1");
    c.clearCache();
    expect(chars(c)).toBe(0);
  });
});
