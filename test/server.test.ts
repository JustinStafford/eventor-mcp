import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, vi } from "vitest";
import { buildQuery, EventorClient, parseXml } from "../src/client.js";
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
  it("covers every documented Eventor Australia endpoint", () => {
    const au = endpointsFor("au").map((e) => `${e.method} ${e.path}`);
    for (const p of [
      "GET events", "GET events/iofxml", "GET events/documents", "GET event/{eventId}", "GET event/iofxml/{eventId}",
      "GET eventclasses", "GET entryfees/events/{eventId}", "GET organisation/apiKey", "GET organisations",
      "GET organisations/iofxml", "GET organisation/{id}", "GET persons/organisations/{organisationId}",
      "GET competitors", "GET externalLoginUrl", "GET authenticatePerson", "GET entries", "GET competitorcount",
      "GET starts/event", "GET starts/event/iofxml", "GET starts/person", "GET starts/organisation",
      "GET results/event", "GET results/event/iofxml", "GET results/person", "GET results/organisation",
      "GET activities", "GET activity", "GET competitor/{competitorId}", "PUT competitor", "GET memberships",
    ]) {
      expect(au).toContain(p);
    }
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
  it("lists all Australian tools plus utilities", async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    expect(tools.length).toBe(endpointsFor("au").length + 2);
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

  it("uses the personal login for authenticate_person and organiser useLogin", async () => {
    const env = { ...baseEnv, EVENTOR_USERNAME: "me", EVENTOR_PASSWORD: "pw" };
    const { client, fetchFn } = await connect(env);
    await client.callTool({ name: "authenticate_person", arguments: {} });
    await client.callTool({ name: "export_classes", arguments: { eventId: 5, useLogin: true } });
    for (const [, init] of fetchFn.mock.calls) {
      const h = init!.headers as Record<string, string>;
      expect(h.Username).toBe("me");
      expect(h.Password).toBe("pw");
      expect(h.ApiKey).toBeUndefined();
    }
    expect(new URL(fetchFn.mock.calls[1][0] as string).searchParams.get("version")).toBe("3.0");
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

  it("eventor_get rejects absolute URLs", async () => {
    const { client, fetchFn } = await connect();
    const res = await client.callTool({ name: "eventor_get", arguments: { path: "https://evil.example/x" } });
    expect(res.isError).toBe(true);
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
