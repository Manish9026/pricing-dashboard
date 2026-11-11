const app = document.querySelector("#app");
const search = document.querySelector("#search");
const inr = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 });

const money = (value) => (value == null || Number.isNaN(Number(value)) ? "—" : inr.format(value));
const when = (value) => value ? new Date(value).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" }) : "—";
const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
const outcomeClass = (outcome) => outcome === "cheapest" ? "pill" : outcome === "lower" ? "pill warn" : "pill bad";

async function getJson(path) {
  const response = await fetch(path);
  if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || response.statusText);
  return response.json();
}

function route() {
  const path = location.pathname;
  const poi = path.match(/^\/poi\/([^/]+)/);
  if (poi) return renderPoi(decodeURIComponent(poi[1]));
  const params = new URLSearchParams(location.search);
  search.value = params.get("q") || "";
  return renderHome(params.get("q") || "");
}

async function renderHome(query) {
  app.innerHTML = `<section class="page-head"><div><h1>Recent runs</h1><p class="sub">Open a place to see the flow, then a plan for the full price comparison.</p></div></section><div id="list" class="grid"><p class="empty">Loading runs…</p></div>`;
  try {
    const data = await getJson(`/api/runs${query ? `?q=${encodeURIComponent(query)}` : ""}`);
    const list = document.querySelector("#list");
    if (!data.runs.length) {
      list.innerHTML = `<p class="empty">No runs match that search.</p>`;
      return;
    }
    list.innerHTML = data.runs.map((run) => `
      <a class="card run" href="/poi/${encodeURIComponent(run.slug)}">
        <strong>${esc(run.activityName)}</strong>
        <p class="sub">${esc(run.slug)}</p>
        <div class="meta">
          <span class="${outcomeClass(run.outcome)}">${esc(run.outcome || "no rank")}</span>
          <span>Rank ${run.rankNow ?? "—"}</span>
          <span>Ours ${money(run.ourPrice)}</span>
          <span>${run.offerCount ?? "—"} offers</span>
          <span>${run.planCount} plans</span>
        </div>
        <p class="note">${when(run.recordedAt)} · ${esc(run.source)}</p>
      </a>`).join("");
  } catch (error) {
    document.querySelector("#list").innerHTML = `<p class="empty">${esc(error.message)}</p>`;
  }
}

async function renderPoi(slug) {
  app.innerHTML = `<p class="empty">Loading ${esc(slug)}…</p>`;
  try {
    const run = await getJson(`/api/runs/${encodeURIComponent(slug)}`);
    const summary = run.summary || {};
    const selected = new URLSearchParams(location.search).get("plan");
    app.innerHTML = `
      <section class="page-head">
        <div>
          <p class="note"><a href="/">Recent runs</a></p>
          <h1>${esc(run.activityName)}</h1>
          <p class="sub">POI ${esc(run.poiId ?? "—")}${run.poiName ? ` · ${esc(run.poiName)}` : ""} · ${esc(run.placeId || "no place id")}</p>
          <p class="note">${when(run.recordedAt)} · ${esc(run.source)} · scrape ${esc(run.scrape.status || "—")}</p>
        </div>
      </section>
      <section class="stats">
        ${stat("Offers", run.scrape.offerCount)}
        ${stat("Exact matches", run.stats.matchCounts.exact)}
        ${stat("In review", run.stats.matchCounts.review)}
        ${stat("Our rank", summary.rankNow)}
        ${stat("Our price", money(summary.our?.googlePrice))}
        ${stat("Recommended", money(summary.recommendedPrice))}
      </section>
      <section class="layout">
        <aside class="panel">
          <h2>Flow</h2>
          <div class="flow">${run.flow.map((step, index) => `
            <article class="step">
              <div class="num">${index + 1}</div>
              <div>
                <strong>${esc(step.step.replaceAll("_", " "))}</strong>
                <p>${esc(step.detail || "")}</p>
                <p>${esc(flowStats(step))}</p>
              </div>
            </article>`).join("")}</div>
        </aside>
        <section>
          <h2>Activities and plans</h2>
          <div class="plans">${run.plans.map((plan) => planCard(plan, selected)).join("") || `<p class="empty">No priced plans on this run.</p>`}</div>
          ${catalogBlock(run)}
          ${historyBlock(run)}
        </section>
      </section>
      ${selected ? detailSheet(run, selected) : ""}`;
    document.querySelectorAll("[data-plan]").forEach((button) => {
      button.addEventListener("click", () => {
        const url = new URL(location.href);
        url.searchParams.set("plan", button.dataset.plan);
        history.pushState({}, "", url);
        renderPoi(slug);
      });
    });
    document.querySelector("[data-close]")?.addEventListener("click", () => {
      const url = new URL(location.href);
      url.searchParams.delete("plan");
      history.pushState({}, "", url);
      renderPoi(slug);
    });
    document.querySelector("[data-back]")?.addEventListener("click", () => document.querySelector("[data-close]").click());
  } catch (error) {
    app.innerHTML = `<p class="empty">${esc(error.message)}</p>`;
  }
}

function stat(label, value) {
  return `<article class="stat"><span>${esc(label)}</span><b>${esc(value ?? "—")}</b></article>`;
}

function flowStats(step) {
  const stats = step.stats || {};
  if (step.step === "rank" && Array.isArray(stats.plans)) return `${stats.plans.length} plans ranked`;
  return Object.entries(stats)
    .filter(([, value]) => value != null && typeof value !== "object")
    .slice(0, 4)
    .map(([key, value]) => `${key} ${value}`)
    .join(" · ");
}

function planCard(plan, selected) {
  const id = plan.activityPlanMappingId || plan.planName;
  return `<button class="plan ${String(selected) === String(id) ? "active" : ""}" data-plan="${esc(id)}">
    <div class="plan-top">
      <strong>${esc(plan.planName)}</strong>
      <span class="${outcomeClass(plan.outcome)}">${esc(plan.outcome || "unranked")}</span>
    </div>
    <div class="prices">
      <span>Rank <b>${esc(plan.rankNow ?? "—")}</b></span>
      <span>Ours <b>${money(plan.our.googlePrice)}</b></span>
      <span>Recommended <b>${money(plan.recommendedPrice)}</b></span>
      <span>Sellers <b>${esc(plan.sellers)}</b></span>
    </div>
  </button>`;
}

function catalogBlock(run) {
  const missing = run.catalog?.notOnPoiFeed || [];
  if (!missing.length) return "";
  return `<section class="panel" style="margin-top:16px"><h2>Not on the POI feed</h2><div class="plans">${missing.map((plan) => `<p><strong>${esc(plan.planName)}</strong> <span class="note">${esc(plan.reason || "missing")}</span></p>`).join("")}</div></section>`;
}

function historyBlock(run) {
  if (!run.history?.length) return "";
  return `<section class="panel" style="margin-top:16px"><h2>Earlier runs</h2><table class="table"><thead><tr><th>When</th><th>Rank</th><th>Our price</th><th>Recommended</th><th>Outcome</th></tr></thead><tbody>${run.history.slice().reverse().map((line) => `<tr><td>${when(line.recordedAt)}</td><td>${esc(line.rankNow ?? "—")}</td><td>${money(line.ourGooglePrice)}</td><td>${money(line.recommendedPrice)}</td><td>${esc(line.outcome || "—")}</td></tr>`).join("")}</tbody></table></section>`;
}

function detailSheet(run, selected) {
  const plan = run.plans.find((item) => String(item.activityPlanMappingId || item.planName) === String(selected));
  if (!plan) return "";
  return `<div class="sheet-back" data-back></div>
    <aside class="sheet" role="dialog" aria-label="${esc(plan.planName)}">
      <header>
        <div>
          <p class="note">${esc(run.activityName)}</p>
          <h1>${esc(plan.planName)}</h1>
          <p class="sub">${esc(plan.provider || "catalog plan")} · mapping ${esc(plan.activityPlanMappingId ?? "—")}</p>
        </div>
        <button class="close" data-close>Close</button>
      </header>
      <div class="price-row">
        ${stat("Our price", money(plan.our.googlePrice))}
        ${stat("Recommended", money(plan.recommendedPrice))}
        ${stat("Future price", money(plan.futurePrice))}
      </div>
      <div class="price-row">
        ${stat("Net", money(plan.our.netPrice))}
        ${stat("Site", money(plan.our.sitePrice))}
        ${stat("Floor", money(plan.our.floorPrice))}
      </div>
      <p>${esc(plan.explanation || "No recommendation note.")}</p>
      <p class="note">Rank ${esc(plan.rankNow ?? "—")} of ${esc(plan.sellers)} trusted sellers. After a change: ${esc(plan.rankAfter ?? "—")}. Low % ${esc(plan.our.lowPercentage ?? "—")}.</p>
      <p class="note">Margin ${esc(plan.margin?.status || "—")} ${esc(plan.margin?.reason || "")}. Listing ${esc(plan.listing?.status || "—")} ${esc(plan.listing?.reason || "")}.</p>
      ${plan.futurePrice != null ? `<p class="note">To be rank 1, list at ${money(plan.futurePrice)}${plan.futureLeader ? ` (₹1 under ${esc(plan.futureLeader.provider)} at ${money(plan.futureLeader.price)})` : ""}.${plan.futureNet != null ? ` That needs net below ${money(plan.futureNet)}.` : ""} ${plan.futureBeatable === false ? "The floor blocks that price." : ""}</p>` : ""}
      <h2>Cheaper than us</h2>
      ${sellerTable(plan.cheaper, "No matched seller is below our Google price.")}
      <h2>Sellers we beat</h2>
      ${sellerTable(plan.beaten, "No matched seller is above our Google price.")}
      <h2>Full competitor list</h2>
      ${sellerTable(plan.competitors, "No competitors were matched to this plan.")}
    </aside>`;
}

function sellerTable(rows, empty) {
  if (!rows?.length) return `<p class="note">${esc(empty)}</p>`;
  return `<table class="table"><thead><tr><th>Seller</th><th>Offer</th><th>Price</th></tr></thead><tbody>${rows.map((row) => `
    <tr>
      <td>${row.url ? `<a href="${esc(row.url)}" target="_blank" rel="noreferrer">${esc(row.provider)}</a>` : esc(row.provider)}${row.suspicious ? ` <span class="pill bad">teaser</span>` : ""}</td>
      <td>${esc(row.optionName || "—")}</td>
      <td>${money(row.price)}</td>
    </tr>`).join("")}</tbody></table>`;
}

document.querySelector("#search-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const query = search.value.trim();
  history.pushState({}, "", query ? `/?q=${encodeURIComponent(query)}` : "/");
  route();
});
window.addEventListener("popstate", route);
route();
