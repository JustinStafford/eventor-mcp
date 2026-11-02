import { z, type ZodRawShape } from "zod";
import type { AuthMode } from "./client.js";
import type { Instance } from "./config.js";

/**
 * Declarative description of every Eventor API endpoint. Tools are generated
 * from this table, so adding an endpoint is a matter of adding an entry here.
 *
 * Sources: the public "Documentation for API methods" page of each Eventor
 * instance (au, se, no, iof), plus the organiser export/import endpoints used
 * by event software such as MeOS (marked experimental: undocumented).
 */
export interface EndpointDef {
  name: string;
  title: string;
  description: string;
  method: "GET" | "PUT" | "POST";
  /** Path relative to the API root; `{param}` segments are filled from params. */
  path: string;
  params: ZodRawShape;
  /** Instances that document this endpoint; omitted means all. */
  instances?: Instance[];
  auth: AuthMode | "organiser";
  /** Returned element, for the description. */
  returns: string;
  /** Request body is an XML document taken from the `xml` param. */
  xmlBody?: boolean;
  write?: boolean;
  experimental?: boolean;
  /** Fixed query parameters always sent. */
  fixedQuery?: Record<string, string>;
  /** Parameters applied locally to the parsed response rather than sent to Eventor. */
  localParams?: ZodRawShape;
  filter?: (doc: unknown, args: Record<string, unknown>) => unknown;
}

/** Local filters for list_organisations, whose full response is ~200k characters. */
function filterOrganisations(doc: unknown, args: Record<string, unknown>): unknown {
  const list = (doc as { OrganisationList?: { Organisation?: Array<Record<string, unknown>> } }).OrganisationList;
  if (!list?.Organisation) return doc;
  const name = typeof args.nameContains === "string" ? args.nameContains.toLowerCase() : undefined;
  const types = args.organisationTypeIds as number[] | undefined;
  const parent = args.parentOrganisationId as number | undefined;
  const parentOf = (o: Record<string, unknown>) =>
    (o.ParentOrganisation as { OrganisationId?: string } | undefined)?.OrganisationId;
  const orgs = list.Organisation.filter(
    (o) =>
      (!name || [o.Name, o.ShortName, o.MediaName].some((n) => typeof n === "string" && n.toLowerCase().includes(name))) &&
      (!types || types.map(String).includes(String(o.OrganisationTypeId))) &&
      (parent === undefined || parentOf(o) === String(parent)),
  );
  return { OrganisationList: { ...list, Organisation: orgs } };
}

// ---- reusable parameter schemas -------------------------------------------------

const id = (what: string) => z.number().int().positive().describe(what);
const ids = (what: string) => z.array(z.number().int().positive()).min(1).describe(`${what} Sent as a comma-separated list.`);
const dateTime = (what: string) =>
  z.string().regex(/^\d{4}-\d{2}-\d{2}( \d{2}:\d{2}(:\d{2})?)?$/, "Use yyyy-mm-dd or yyyy-mm-dd hh:mm:ss").describe(
    `${what} Format yyyy-mm-dd or yyyy-mm-dd hh:mm:ss (date-only "from" values start at 00:00:00, "to" values end at 23:59:59).`,
  );
const flag = (what: string) => z.boolean().describe(what);

const eventSearch = {
  fromDate: dateTime("Only events on or after this time.").optional(),
  toDate: dateTime("Only events on or before this time.").optional(),
  fromModifyDate: dateTime("Only events changed after this time.").optional(),
  toModifyDate: dateTime("Only events changed before this time.").optional(),
  eventIds: ids("Event IDs. Omit for all events.").optional(),
  organisationIds: ids(
    "Organising club IDs. A state/federation ID includes all events organised by its clubs. Omit for all.",
  ).optional(),
  classificationIds: ids(
    "Event classification IDs: 1=championship, 2=national, 3=state/district, 4=local, 5=club, 6=international.",
  ).optional(),
};

const ownOrg = "Must be your own organisation's ID (the club owning the API key; see get_api_key_organisation).";

const iofVersion = z.enum(["3.0", "2.0.3"]).default("3.0").describe("IOF XML version of the response.");
const useLogin = flag(
  "Authenticate with the configured personal Eventor login (EVENTOR_USERNAME/PASSWORD) instead of the club API key. Some organiser endpoints only accept one or the other.",
).optional();

export const xmlParam = (what: string) => z.string().min(1).describe(what);
export const confirmParam = z
  .literal(true)
  .describe("Must be true. Only set it after the user has explicitly approved this exact change in the conversation.");

// ---- the endpoint table ----------------------------------------------------------

export const ENDPOINTS: EndpointDef[] = [
  // Events
  {
    name: "list_events",
    title: "List events",
    description: "Search the event calendar. Combine date range, organiser and classification filters to keep results small.",
    method: "GET",
    path: "events",
    auth: "apiKey",
    returns: "EventList",
    params: {
      ...eventSearch,
      includeEntryBreaks: flag("Include entry deadlines.").optional(),
      includeAttributes: flag("Include event attributes.").optional(),
      parentIds: ids("Parent event IDs (IOF Eventor only).").optional(),
    },
  },
  {
    name: "list_events_iofxml",
    title: "List events (IOF XML)",
    description: "Search the event calendar, returned as an IOF XML 3.0 EventList.",
    method: "GET",
    path: "events/iofxml",
    instances: ["au", "iof"],
    auth: "apiKey",
    returns: "IOF XML 3.0 EventList",
    params: { ...eventSearch, eventRaceId: id("Event race ID. Omit for all races.").optional() },
  },
  {
    name: "list_wrs_events",
    title: "List World Ranking events",
    description: "Search events with World Ranking Score (WRS) information.",
    method: "GET",
    path: "wrsevents",
    instances: ["iof"],
    auth: "apiKey",
    returns: "EventList",
    params: {
      ...eventSearch,
      includeEntryBreaks: flag("Include entry deadlines.").optional(),
      includeAttributes: flag("Include event attributes.").optional(),
      parentIds: ids("Parent event IDs.").optional(),
    },
  },
  {
    name: "list_event_documents",
    title: "List event documents",
    description: "List documents (invitations, bulletins, final details, etc.) attached to matching events.",
    method: "GET",
    path: "events/documents",
    auth: "apiKey",
    returns: "DocumentList",
    params: {
      fromDate: eventSearch.fromDate,
      toDate: eventSearch.toDate,
      eventIds: eventSearch.eventIds,
      organisationIds: eventSearch.organisationIds,
    },
  },
  {
    name: "get_event",
    title: "Get event",
    description: "Get a single event, including races, organisers, and entry breaks.",
    method: "GET",
    path: "event/{eventId}",
    auth: "apiKey",
    returns: "Event",
    params: { eventId: id("Event ID.") },
  },
  {
    name: "get_event_iofxml",
    title: "Get event (IOF XML)",
    description: "Get a single event as an IOF XML 3.0 EventList.",
    method: "GET",
    path: "event/iofxml/{eventId}",
    instances: ["au", "iof"],
    auth: "apiKey",
    returns: "IOF XML 3.0 EventList",
    params: { eventId: id("Event ID.") },
  },
  {
    name: "list_event_classes",
    title: "List event classes",
    description: "List all classes (courses/categories) in an event.",
    method: "GET",
    path: "eventclasses",
    auth: "apiKey",
    returns: "EventClassList",
    params: {
      eventId: id("Event ID."),
      includeEntryFees: flag("Include entry fee IDs and their application order per class.").optional(),
    },
  },
  {
    name: "list_entry_fees",
    title: "List entry fees",
    description: "List all entry fees defined for an event.",
    method: "GET",
    path: "entryfees/events/{eventId}",
    auth: "apiKey",
    returns: "EntryFeeList",
    params: { eventId: id("Event ID.") },
  },

  // Organisations and people
  {
    name: "get_api_key_organisation",
    title: "Get API key's organisation",
    description: "Return the organisation (club) that owns the configured API key. Use this to find your own organisation ID.",
    method: "GET",
    path: "organisation/apiKey",
    auth: "apiKey",
    returns: "Organisation",
    params: {},
  },
  {
    name: "list_organisations",
    title: "List organisations",
    description:
      "List federations, state associations and clubs. The full list is ~200k characters, so use the local filters (nameContains, organisationTypeIds, parentOrganisationId) where possible.",
    method: "GET",
    path: "organisations",
    auth: "apiKey",
    returns: "OrganisationList",
    params: { includeProperties: flag("Include extended organisation information.").optional() },
    localParams: {
      nameContains: z.string().min(1).describe("Only organisations whose name contains this text (case-insensitive).").optional(),
      organisationTypeIds: ids("Only these types: 1=national federation, 2=state/regional association, 3=club, 5=IOF.").optional(),
      parentOrganisationId: id("Only direct children of this organisation, e.g. the clubs of a state association.").optional(),
    },
    filter: filterOrganisations,
  },
  {
    name: "list_organisations_iofxml",
    title: "List organisations (IOF XML)",
    description: "List all organisations as an IOF XML 3.0 OrganisationList.",
    method: "GET",
    path: "organisations/iofxml",
    instances: ["au", "iof"],
    auth: "apiKey",
    returns: "IOF XML 3.0 OrganisationList",
    params: {},
  },
  {
    name: "get_organisation",
    title: "Get organisation",
    description: "Get a single federation, state association or club.",
    method: "GET",
    path: "organisation/{id}",
    auth: "apiKey",
    returns: "Organisation",
    params: { id: id("Organisation ID.") },
  },
  {
    name: "list_organisation_persons",
    title: "List club members",
    description: "List all persons who are members of your organisation.",
    method: "GET",
    path: "persons/organisations/{organisationId}",
    auth: "apiKey",
    returns: "PersonList",
    params: {
      organisationId: id(`Organisation ID. ${ownOrg}`),
      includeContactDetails: flag("Include addresses, phone numbers and email addresses.").optional(),
      includePersonProperties: flag("Include extended person information.").optional(),
      includePersonIdentifiers: flag("Include persons' external IDs.").optional(),
    },
  },
  {
    name: "list_memberships",
    title: "List memberships",
    description: "List all memberships of your organisation for a given year.",
    method: "GET",
    path: "memberships",
    instances: ["au"],
    auth: "apiKey",
    returns: "OrganisationMembershipList",
    params: {
      organisationId: id(`Organisation ID. ${ownOrg}`),
      year: z.number().int().min(1990).max(2100).describe("Membership year."),
      includeChildOrganisations: flag("Include memberships of underlying organisations (not applicable to clubs).").optional(),
      includeContactDetails: flag("Include contact details.").optional(),
    },
  },
  {
    name: "list_competitors",
    title: "List competitor settings",
    description: "List event settings (punching card numbers, pre-selected classes) for members of your organisation who have set them.",
    method: "GET",
    path: "competitors",
    auth: "apiKey",
    returns: "CompetitorList",
    params: { organisationId: id(`Organisation ID. ${ownOrg}`) },
  },
  {
    name: "get_competitor",
    title: "Get competitor settings",
    description:
      "Get one person's event settings (pre-selected classes, punching cards). competitorId is Eventor's internal competitor ID, not the public personId. " +
      "Note: on Eventor Australia this returned 403 for competitor IDs and an empty element for person IDs when tested; list_competitors returns the same data reliably.",
    method: "GET",
    path: "competitor/{competitorId}",
    auth: "apiKey",
    returns: "Competitor",
    params: { competitorId: id("Internal competitor ID of a member of your organisation.") },
  },
  {
    name: "save_competitor",
    title: "Save competitor settings",
    description:
      "WRITES TO EVENTOR. Save a member's event settings (pre-selected classes, punching cards). Fetch the current settings with get_competitor (raw: true), edit the XML, then send it back.",
    method: "PUT",
    path: "competitor",
    auth: "apiKey",
    returns: "Competitor",
    xmlBody: true,
    write: true,
    params: {
      xml: xmlParam("A complete Eventor <Competitor> XML element for a member of your organisation."),
    },
  },
  {
    name: "get_external_login_url",
    title: "Get external login URL",
    description:
      "Create a single-use link (valid five minutes) that logs a member into Eventor. Only share it with that person.",
    method: "GET",
    path: "externalLoginUrl",
    auth: "apiKey",
    returns: "ExternalLoginUrl",
    params: {
      personId: id("Person ID of a member of the organisation."),
      organisationId: id(`Organisation ID. ${ownOrg}`),
      includeContactDetails: flag("Include contact details.").optional(),
    },
  },
  {
    name: "authenticate_person",
    title: "Authenticate person",
    description:
      "Return the Eventor person matching the configured personal login (EVENTOR_USERNAME/PASSWORD). Useful to check the login works and find your personId.",
    method: "GET",
    path: "authenticatePerson",
    auth: "person",
    returns: "Person",
    params: {},
  },

  // Entries
  {
    name: "list_entries",
    title: "List entries",
    description: "List persons entered into events. Filter by organisation, event, class and dates to keep results small.",
    method: "GET",
    path: "entries",
    auth: "apiKey",
    returns: "EntryList",
    params: {
      organisationIds: ids("Organisation IDs whose entries to fetch. Omit for all.").optional(),
      eventIds: ids("Event IDs. Omit for all.").optional(),
      eventClassIds: ids("Class IDs from list_event_classes. Omit for all.").optional(),
      fromEventDate: dateTime("Events held at or after this time.").optional(),
      toEventDate: dateTime("Events held at or before this time.").optional(),
      fromEntryDate: dateTime("Entries made at or after this time.").optional(),
      toEntryDate: dateTime("Entries made at or before this time.").optional(),
      fromModifyDate: dateTime("Entries changed at or after this time.").optional(),
      toModifyDate: dateTime("Entries changed at or before this time.").optional(),
      includeEntryFees: flag("Include entry fee information.").optional(),
      includePersonElement: flag("Include full person details instead of just the ID.").optional(),
      includeOrganisationElement: flag("Include full organisation details instead of just the ID.").optional(),
      includeEventElement: flag("Include full event details instead of just the ID.").optional(),
    },
  },
  {
    name: "get_competitor_count",
    title: "Count entries",
    description: "Count entries for organisations, optionally by event and person.",
    method: "GET",
    path: "competitorcount",
    auth: "apiKey",
    returns: "CompetitorCountList",
    params: {
      organisationIds: ids("Organisation IDs."),
      eventIds: ids("Event IDs. Omit for all.").optional(),
      personIds: ids("Person IDs (must be members of the given organisations).").optional(),
    },
  },

  // Start lists
  {
    name: "get_event_starts",
    title: "Get event start list",
    description: "Get start times for an event.",
    method: "GET",
    path: "starts/event",
    auth: "apiKey",
    returns: "StartList",
    params: { eventId: id("Event ID.") },
  },
  {
    name: "get_event_starts_iofxml",
    title: "Get event start list (IOF XML)",
    description: "Get start times for an event as an IOF XML 3.0 StartList.",
    method: "GET",
    path: "starts/event/iofxml",
    instances: ["au", "se", "iof"],
    auth: "apiKey",
    returns: "IOF XML 3.0 StartList",
    params: { eventId: id("Event ID."), eventRaceId: id("Event race ID (multi-race events).").optional() },
  },
  {
    name: "get_person_starts",
    title: "Get a person's start times",
    description: "Get a person's start times across events.",
    method: "GET",
    path: "starts/person",
    auth: "apiKey",
    returns: "StartListList",
    params: {
      personId: id("Person ID."),
      eventIds: ids("Event IDs. Omit for all.").optional(),
      fromDate: dateTime("Events on or after this time.").optional(),
      toDate: dateTime("Events on or before this time.").optional(),
    },
  },
  {
    name: "get_organisation_starts",
    title: "Get club start times",
    description: "Get start times for your club's competitors in an event.",
    method: "GET",
    path: "starts/organisation",
    auth: "apiKey",
    returns: "StartList",
    params: { organisationIds: ids(`Organisation IDs. ${ownOrg}`), eventId: id("Event ID.").optional() },
  },

  // Results
  {
    name: "get_event_results",
    title: "Get event results",
    description: "Get results for an event. Use `top` to limit per class; split times make responses much larger.",
    method: "GET",
    path: "results/event",
    auth: "apiKey",
    returns: "ResultList",
    params: {
      eventId: id("Event ID."),
      includeSplitTimes: flag("Include split times.").optional(),
      top: z.number().int().positive().describe("Only this many competitors from the top of each class.").optional(),
    },
  },
  {
    name: "get_event_results_iofxml",
    title: "Get event results (IOF XML)",
    description: "Get results for an event as an IOF XML 3.0 ResultList.",
    method: "GET",
    path: "results/event/iofxml",
    instances: ["au", "se", "iof"],
    auth: "apiKey",
    returns: "IOF XML 3.0 ResultList",
    params: {
      eventId: id("Event ID."),
      eventRaceId: id("Event race ID (multi-race events).").optional(),
      includeSplitTimes: flag("Include split times.").optional(),
      totalResult: flag("Return the total result over all races (Eventor Sweden).").optional(),
    },
  },
  {
    name: "get_wrs_class_results",
    title: "Get World Ranking class results",
    description: "Get results for one class of a World Ranking event.",
    method: "GET",
    path: "wrsresults/event",
    instances: ["iof"],
    auth: "apiKey",
    returns: "ResultList",
    params: { classId: id("Event class ID.") },
  },
  {
    name: "get_person_results",
    title: "Get a person's results",
    description: "Get a person's results across events.",
    method: "GET",
    path: "results/person",
    auth: "apiKey",
    returns: "ResultListList",
    params: {
      personId: id("Person ID."),
      eventIds: ids("Event IDs. Omit for all.").optional(),
      fromDate: dateTime("Events on or after this time.").optional(),
      toDate: dateTime("Events on or before this time.").optional(),
      includeSplitTimes: flag("Include split times.").optional(),
      top: z.number().int().positive().describe("Also include this many competitors from the top of each class.").optional(),
    },
  },
  {
    name: "get_organisation_results",
    title: "Get club results",
    description: "Get results for your club's competitors in an event.",
    method: "GET",
    path: "results/organisation",
    auth: "apiKey",
    returns: "ResultList",
    params: {
      organisationIds: ids(`Organisation IDs. ${ownOrg}`),
      eventId: id("Event ID.").optional(),
      includeSplitTimes: flag("Include split times.").optional(),
      top: z.number().int().positive().describe("Also include this many competitors from the top of each class.").optional(),
    },
  },

  // Activities
  {
    name: "list_activities",
    title: "List club activities",
    description: "List your club's activities (trainings, social events, etc.) in a period.",
    method: "GET",
    path: "activities",
    auth: "apiKey",
    returns: "ActivityList",
    params: {
      organisationId: id(`Organisation ID. ${ownOrg}`),
      from: dateTime("Start of the period."),
      to: dateTime("End of the period."),
      includeRegistrations: flag("Include registrations for each activity.").optional(),
    },
  },
  {
    name: "get_activity",
    title: "Get club activity",
    description: "Get one of your club's activities.",
    method: "GET",
    path: "activity",
    auth: "apiKey",
    returns: "Activity",
    params: {
      organisationId: id(`Organisation ID. ${ownOrg}`),
      id: id("Activity ID from list_activities."),
      includeRegistrations: flag("Include registrations.").optional(),
    },
  },

  // Organiser endpoints (undocumented; used by event software such as MeOS)
  {
    name: "export_organisations",
    title: "Export organisations (organiser)",
    description: "Organiser export of all organisations in IOF XML, as used by event software.",
    method: "GET",
    path: "export/organisations",
    auth: "organiser",
    returns: "IOF XML OrganisationList",
    experimental: true,
    params: { version: iofVersion, useLogin },
  },
  {
    name: "export_event",
    title: "Export event (organiser)",
    description:
      "Organiser export of an event in IOF XML, including its races, officials and services (e.g. meals, accommodation) with fees.",
    method: "GET",
    path: "export/event",
    auth: "organiser",
    returns: "IOF XML EventList",
    experimental: true,
    params: { eventId: id("Event ID."), version: iofVersion, useLogin },
  },
  {
    name: "export_base_classes",
    title: "Export base classes (organiser)",
    description: "Organiser export of the federation's standard (base) class register in IOF XML.",
    method: "GET",
    path: "export/baseclasses",
    auth: "organiser",
    returns: "IOF XML ClassList",
    experimental: true,
    params: { version: iofVersion, useLogin },
  },
  {
    name: "export_classes",
    title: "Export event classes (organiser)",
    description: "Organiser export of an event's classes in IOF XML, for importing into event software.",
    method: "GET",
    path: "export/classes",
    auth: "organiser",
    returns: "IOF XML ClassList",
    experimental: true,
    params: {
      eventId: id("Event ID."),
      includeEntryFees: flag("Include entry fees.").optional(),
      version: iofVersion,
      useLogin,
    },
  },
  {
    name: "export_entries",
    title: "Export event entries (organiser)",
    description: "Organiser export of an event's entries in IOF XML (names, classes, clubs, punching cards).",
    method: "GET",
    path: "export/entries",
    auth: "organiser",
    returns: "IOF XML EntryList",
    experimental: true,
    params: {
      eventId: id("Event ID."),
      includeEntryFees: flag("Include entry fees.").optional(),
      includePersonElement: flag("Include full person details.").optional(),
      version: iofVersion,
      useLogin,
    },
  },
  {
    name: "export_competitors",
    title: "Export competitors (organiser)",
    description: "Organiser export of registered competitors (with punching cards) for organisations, in IOF XML.",
    method: "GET",
    path: "export/competitors",
    auth: "organiser",
    returns: "IOF XML CompetitorList",
    experimental: true,
    params: {
      organisationIds: ids("Organisation IDs."),
      version: iofVersion,
      useLogin,
    },
  },
  {
    name: "export_cached_competitors",
    title: "Export competitor database (organiser)",
    description:
      "Organiser export of the whole competitor database (as MeOS downloads it). Very large; prefer narrower tools unless you need everything.",
    method: "GET",
    path: "export/cachedcompetitors",
    auth: "organiser",
    returns: "IOF XML CompetitorList",
    experimental: true,
    fixedQuery: { zip: "false" },
    params: {
      organisationIds: ids("Organisation IDs. Omit for everyone.").optional(),
      includePreselectedClasses: flag("Include pre-selected classes.").optional(),
      version: iofVersion,
      useLogin,
    },
  },
  {
    name: "import_startlist",
    title: "Publish start list (organiser)",
    description: "WRITES TO EVENTOR. Upload an IOF XML 3.0 StartList for an event you organise; it becomes public.",
    method: "POST",
    path: "import/startlist",
    auth: "organiser",
    returns: "Import status",
    xmlBody: true,
    write: true,
    experimental: true,
    params: { xml: xmlParam("A complete IOF XML 3.0 <StartList> document."), useLogin },
  },
  {
    name: "import_resultlist",
    title: "Publish result list (organiser)",
    description: "WRITES TO EVENTOR. Upload an IOF XML 3.0 ResultList for an event you organise; it becomes public.",
    method: "POST",
    path: "import/resultlist",
    auth: "organiser",
    returns: "Import status",
    xmlBody: true,
    write: true,
    experimental: true,
    params: { xml: xmlParam("A complete IOF XML 3.0 <ResultList> document."), useLogin },
  },
];

/** Endpoints available on the configured instance (all of them for a custom base URL). */
export function endpointsFor(instance: Instance | undefined, readOnly = false): EndpointDef[] {
  return ENDPOINTS.filter(
    (e) => (!instance || !e.instances || e.instances.includes(instance)) && !(readOnly && e.write),
  );
}
