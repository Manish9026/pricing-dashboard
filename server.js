import { createReadStream } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..");
const publicDir = join(here, "public");
const port = Number(process.env.PORT || 4180);
const stores = [
  { source: "pricing-agent", dir: join(repo, "pricing-agent", "data", "competitor-records") },
  { source: "advanced-scrapper", dir: join(repo, "advanced-scrapper", "data", "competitor-records") },
];

const money = (value) => {
  const number = Number(value);
  return Number.isFinite(number) ? Math.round((number + Number.EPSILON) * 100) / 100 : null;
};

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

async function listRecords() {
  const found = [];
  for (const store of stores) {
    let names = [];
    try {
      names = await readdir(store.dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (name.startsWith("_")) continue;
      const latestPath = join(store.dir, name, "latest.json");
      const record = await readJson(latestPath);
      if (!record?.slug) continue;
      found.push({ source: store.source, dir: join(store.dir, name), record });
    }
  }
  const bySlug = new Map();
  for (const item of found) {
    const current = bySlug.get(item.record.slug);
    const newer = !current || Date.parse(item.record.recordedAt || 0) >= Date.parse(current.record.recordedAt || 0);
    const preferNewStore = item.source === "pricing-agent" && current?.source !== "pricing-agent"
      && Date.parse(item.record.recordedAt || 0) === Date.parse(current?.record.recordedAt || 0);
    if (!current || newer || preferNewStore) bySlug.set(item.record.slug, item);
  }
  return [...bySlug.values()].sort((left, right) => Date.parse(right.record.recordedAt || 0) - Date.parse(left.record.recordedAt || 0));
}

function planView(plan) {
  const rates = plan.rates || plan.our || {};
  const ranking = plan.ranking || {};
  const recommendation = plan.recommendation || {};
  const ourPrice = money(rates.currentGooglePrice ?? rates.googlePrice ?? plan.decision?.ourPrice);
  const competitors = [...(plan.competitors || [])]
    .map((row) => ({
      provider: row.provider || "Unknown",
      price: money(row.price ?? row.convertedPrice),
      optionName: row.optionName || null,
      url: row.url || null,
      suspicious: Boolean(row.suspicious),
      matchStatus: row.matchStatus || "exact",
      originalPrice: money(row.originalPrice),
      originalCurrency: row.originalCurrency || null,
    }))
    .filter((row) => row.price != null)
    .sort((left, right) => left.price - right.price);
  const trusted = competitors.filter((row) => !row.suspicious);
  const cheaper = trusted.filter((row) => ourPrice != null && row.price < ourPrice);
  const beaten = trusted.filter((row) => ourPrice != null && row.price > ourPrice);
  const future = ranking.becomeTopSeller || ranking.becomeTopSellerTrusted || null;
  return {
    planName: plan.planName || "Untitled plan",
    planId: plan.planId ?? null,
    activityPlanMappingId: plan.activityPlanMappingId ?? null,
    activitySlug: plan.activitySlug || null,
    provider: plan.provider || null,
    outcome: recommendation.outcome || ranking.outcome || null,
    explanation: recommendation.explanation || null,
    our: {
      netPrice: money(rates.netPrice),
      sitePrice: money(rates.sitePrice ?? rates.sellingPrice),
      googlePrice: ourPrice,
      floorPrice: money(rates.floorPrice),
      lowPercentage: rates.googleLowPricingPercentage ?? null,
    },
    recommendedPrice: money(recommendation.recommendedGooglePrice ?? ourPrice),
    futurePrice: money(future?.googlePriceTarget),
    futureNet: money(future?.netPriceRequired),
    futureBeatable: future?.beatableAtCurrentFloor ?? null,
    futureLeader: future?.leader || ranking.cheapestMatched || null,
    rankNow: ranking.rankNow ?? null,
    rankAfter: ranking.rankAfterIfApplied ?? ranking.rankAfter ?? null,
    sellers: ranking.totalMatchedSellers ?? trusted.length,
    cheapest: ranking.cheapestMatched || trusted[0] || null,
    blockedBy: ranking.blockedBy || null,
    margin: recommendation.marginChange || recommendation.margin || null,
    listing: recommendation.listingChange || recommendation.listing || null,
    cheaper,
    beaten,
    competitors,
  };
}

function flowView(record, plans) {
  if (Array.isArray(record.flow) && record.flow.length) return record.flow;
  const counts = record.stats?.matchCounts || {};
  return [
    { step: "resolve_activity", detail: "Activity loaded for this run.", stats: { slug: record.slug, activityName: record.activityName || "" } },
    { step: "resolve_poi", detail: "Point of interest used for the Google place and the price feed.", stats: { poiId: record.poiId ?? null, poiName: record.poiName || null, placeId: record.placeId || null } },
    { step: "catalog", detail: "Plans compared in this run.", stats: { onPoiFeed: plans.length, notOnPoiFeed: record.catalog?.notOnPoiFeed?.length || 0 } },
    { step: "google_scrape", detail: "Google Maps tickets captured for this place.", stats: { status: record.scrape?.status || null, offerCount: record.scrape?.offerCount ?? null, providerCount: null } },
    { step: "match", detail: "Offers matched to plans.", stats: { exact: counts.exact ?? 0, review: counts.review ?? 0, other: counts.other ?? 0 } },
    { step: "rank", detail: "Rank and price recommendation for each plan.", stats: { plans: plans.map((plan) => ({ planName: plan.planName, rankNow: plan.rankNow, googlePrice: plan.our.googlePrice, recommendedPrice: plan.recommendedPrice, outcome: plan.outcome })) } },
    { step: "writes", detail: "Whether prices were written back.", stats: { applied: Boolean(record.actionsThisRun?.pricingWritesApplied) } },
  ];
}

function present(item) {
  const record = item.record;
  const plans = (record.plans || []).map(planView);
  const summaryPlan = plans.find((plan) => plan.planName === record.summary?.planName) || plans[0] || null;
  return {
    source: item.source,
    slug: record.slug,
    activityName: record.activityName || record.slug,
    activityId: record.activityId ?? null,
    poiId: record.poiId ?? null,
    poiName: record.poiName || null,
    placeId: record.placeId || null,
    resolvedVia: record.resolvedVia || null,
    recordedAt: record.recordedAt || null,
    mode: record.mode || "normal",
    scrape: {
      status: record.scrape?.status || null,
      offerCount: record.scrape?.offerCount ?? null,
      ticketCount: record.scrape?.ticketCount ?? null,
      tourCount: record.scrape?.tourCount ?? null,
      source: record.scrape?.source || item.source,
      session: record.scrape?.session || null,
    },
    stats: {
      externalOffers: record.stats?.externalOffers ?? null,
      matchCounts: record.stats?.matchCounts || { exact: 0, review: 0, other: 0 },
      plansAnalyzed: record.stats?.plansAnalyzed ?? plans.length,
      ownGoogleListings: record.stats?.ownGoogleListings ?? (record.ownGoogleListings || []).length,
      competitorsAhead: record.stats?.competitorsAhead ?? (summaryPlan?.cheaper.length || 0),
      suspiciousTeasers: record.stats?.suspiciousTeasers ?? 0,
    },
    summary: summaryPlan,
    flow: flowView(record, plans),
    catalog: {
      onPoiFeed: record.catalog?.onPoiFeed || plans.map((plan) => ({ planName: plan.planName, activityPlanMappingId: plan.activityPlanMappingId, netPrice: plan.our.netPrice, status: "on_poi_feed" })),
      notOnPoiFeed: record.catalog?.notOnPoiFeed || [],
    },
    plans,
    matches: record.matches || [],
    grouping: record.grouping || { attached: [], review: [], applied: [] },
    ownGoogleListings: record.ownGoogleListings || [],
    marketOffers: record.marketOffers || record.marketTicketOffersSample || [],
    comparisonWithPrevious: record.comparisonWithPrevious || null,
    recordId: record.recordId || null,
    writesApplied: Boolean(record.actionsThisRun?.pricingWritesApplied),
  };
}

function card(view) {
  const summary = view.summary;
  return {
    slug: view.slug,
    activityName: view.activityName,
    poiId: view.poiId,
    poiName: view.poiName,
    placeId: view.placeId,
    recordedAt: view.recordedAt,
    source: view.source,
    offerCount: view.scrape.offerCount,
    planCount: view.plans.length,
    rankNow: summary?.rankNow ?? null,
    ourPrice: summary?.our.googlePrice ?? null,
    recommendedPrice: summary?.recommendedPrice ?? null,
    futurePrice: summary?.futurePrice ?? null,
    outcome: summary?.outcome ?? null,
    sellers: summary?.sellers ?? null,
  };
}

async function historyOf(item, limit = 30) {
  try {
    const text = await readFile(join(item.dir, "history.jsonl"), "utf8");
    return text.trim().split("\n").filter(Boolean).slice(-limit).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

function send(response, status, body, type = "application/json; charset=utf-8") {
  response.writeHead(status, { "content-type": type, "cache-control": "no-store" });
  response.end(typeof body === "string" ? body : JSON.stringify(body));
}

const types = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8" };

createServer(async (request, response) => {
  const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
  try {
    if (request.method === "GET" && url.pathname === "/api/runs") {
      const query = url.searchParams.get("q")?.trim().toLowerCase() || "";
      const runs = (await listRecords()).map((item) => card(present(item)));
      const filtered = query
        ? runs.filter((run) => `${run.slug} ${run.activityName} ${run.poiName || ""} ${run.poiId || ""}`.toLowerCase().includes(query))
        : runs;
      return send(response, 200, { runs: filtered });
    }
    const detail = url.pathname.match(/^\/api\/runs\/([^/]+)$/);
    if (request.method === "GET" && detail) {
      const slug = decodeURIComponent(detail[1]);
      const item = (await listRecords()).find((entry) => entry.record.slug === slug);
      if (!item) return send(response, 404, { error: "Run not found" });
      const view = present(item);
      view.history = await historyOf(item);
      return send(response, 200, view);
    }
    if (request.method === "GET" && (url.pathname === "/" || url.pathname.startsWith("/poi/"))) {
      return createReadStream(join(publicDir, "index.html")).pipe(response.writeHead(200, { "content-type": types[".html"] }));
    }
    const relative = decodeURIComponent(url.pathname).replace(/^[/\\]+/, "");
    const file = join(publicDir, relative);
    if (!file.startsWith(publicDir)) return send(response, 403, { error: "Forbidden" });
    const info = await stat(file).catch(() => null);
    if (!info?.isFile()) return send(response, 404, "Not found", "text/plain; charset=utf-8");
    return createReadStream(file).pipe(response.writeHead(200, { "content-type": types[extname(file)] || "application/octet-stream" }));
  } catch (error) {
    return send(response, 500, { error: error.message });
  }
}).listen(port, "127.0.0.1", () => {
  console.log(`Pricing dashboard http://127.0.0.1:${port}`);
});
