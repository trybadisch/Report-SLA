const api = typeof browser !== "undefined" ? browser : chrome;

function ensureTheme() {
  if (document.getElementById("h1-theme-css")) return;
  try {
    const link = document.createElement("link");
    link.id = "h1-theme-css";
    link.rel = "stylesheet";
    link.href = api.runtime.getURL("theme.css");
    document.documentElement.append(link);
  } catch (e) {
    console.warn("Could not inject theme.css:", e);
  }
}

function getCSRFToken() {
  const meta = document.querySelector('meta[name="csrf-token"]');
  return meta?.content || null;
}

async function waitForCSRF(timeoutMs = 7000) {
  const start = Date.now();
  let token = getCSRFToken();
  while (!token && Date.now() - start < timeoutMs) {
    await new Promise(r => setTimeout(r, 100));
    token = getCSRFToken();
  }
  if (!token) throw new Error("CSRF token not found on page");
  return token;
}

function fillTemplate(template, reportId) {
  return template
    .replace(/\[report_id\]/g, String(reportId))
    .replace(/\[reportId\]/g, String(reportId));
}

async function postGraphQL(bodyString, csrfToken) {
  const res = await fetch("/graphql", {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      "X-Csrf-Token": csrfToken,
      "Accept": "application/json"
    },
    body: bodyString
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.errors) {
    console.error("GraphQL errors:", json.errors || res.statusText);
    throw new Error(json.errors?.[0]?.message || `GraphQL status ${res.status}`);
  }
  return json;
}

function extractFromMetadata(json) {
  const node = json?.data?.reports?.edges?.[0]?.node || {};
  return {
    status: node?.substate ?? "N/A",
    researcher: node?.reporter?.username ?? "N/A",
    title: node?.title ?? "N/A",
    programName: node?.team?.name ?? "N/A",
  };
}

function extractAllActionsFromTimeline(json, reportId) {
  const edges =
    json?.data?.reports?.nodes?.[0]?.activities?.edges || [];

  return edges.map(e => {
    const n = e?.node || {};
    return {
      reportId: String(reportId),
      actionType: n.type || "N/A",
      actor: n.actor?.username || "N/A",
      createdAt: n.created_at || "N/A",
      internal: n.internal
    };
  });
}

async function scrapeOne(reportId, csrfToken, templates) {
  const timeBody = fillTemplate(templates.timelineTemplate, reportId);
  const timeJson = await postGraphQL(timeBody, csrfToken);

  return extractAllActionsFromTimeline(timeJson, reportId);
}

async function scrapeInBatches(reportIds, batchSize, templates) {
  const csrfToken = await waitForCSRF();
  const allRows = [];

  for (let i = 0; i < reportIds.length; i += batchSize) {
    const slice = reportIds.slice(i, i + batchSize);

    const batchResults = await Promise.all(
      slice.map(id =>
        scrapeOne(id, csrfToken, templates)
          .catch(() => [])
      )
    );

    batchResults.flat().forEach(r => allRows.push(r));

    await new Promise(r => setTimeout(r, 120));
  }

  return allRows;
}

function ensureOverlay() {
  if (document.getElementById("h1-scrape-overlay")) return;
  const el = document.createElement("div");
  el.id = "h1-scrape-overlay";
  el.innerHTML = `
    <div class="inner">
      <h2>Scraping HackerOne reports…</h2>
      <p id="h1-overlay-status">Starting…</p>
    </div>
  `;
  ensureTheme();
  document.documentElement.append(el);
}
function setOverlay(text){ const p=document.getElementById("h1-overlay-status"); if(p) p.textContent=text; }

api.runtime.onMessage.addListener(async (msg) => {
  if (msg?.type === "FETCH_REPORT_IDS_FROM_INBOX") {
    console.log("[H1] Inbox scrape request received", msg);

    try {
      ensureOverlay();
      setOverlay("Fetching reports from inbox…");

      const reportIds = await fetchReportIdsFromInbox({
        inbox: msg.inbox,
        startDate: msg.startDate,
        endDate: msg.endDate
      });

      if (!reportIds.length) {
        throw new Error("No reports found");
      }

      setOverlay(`Found ${reportIds.length} reports. Scraping…`);

      const results = await scrapeInBatches(
        reportIds,
        msg.batchSize || 5,
        {
          metadataTemplate: msg.metadataTemplate,
          timelineTemplate: msg.timelineTemplate
        }
      );

      const csv = actionsToCSV(results);

      const safeInbox = msg.inbox.replace(/[^a-z0-9_-]/gi, "_");

      const from = toDDMMYY(msg.startDate);
      const to   = toDDMMYY(msg.endDate);

      const filename = `${safeInbox}_${from}_${to}.csv`;

      downloadCSV(csv, filename);

      setOverlay("CSV downloaded.");
      // await api.runtime.sendMessage({ type: "SCRAPE_DONE" });

      setTimeout(() => {
        const o = document.getElementById("h1-scrape-overlay");
        if (o) o.remove();
      }, 500);

    } catch (e) {
      console.error("[H1] Inbox scrape failed", e);
      setOverlay(`Error: ${e.message}`);
    }
  }
});

function toDDMMYY(dateStr) {
  const [y, m, d] = dateStr.split("-");
  return `${d}-${m}-${y.slice(2)}`;
}



function actionsToCSV(rows) {

  const FILTERED_ACTIONS = new Set([
    "ActivitiesReportRetestApproved",
    "ActivitiesUserCompletedRetest",
    "ActivitiesBugRetesting",
    "ActivitiesBountyAwarded",
    "ActivitiesReportOrganizationInboxesUpdated",
    "ActivitiesReportVulnerabilityTypesUpdated",
    "ActivitiesReportSeverityUpdated",
    "ActivitiesReportCollaboratorJoined",
    "ActivitiesReportCollaboratorInvited",
    "ActivitiesChangedScope",
    "ActivitiesNmiReminderComment",
    "ActivitiesReportTitleUpdated",
    "ActivitiesReportVulnerabilityInformationUpdated"
  ]);

  const normalized = rows
    .filter(r => !FILTERED_ACTIONS.has(r.actionType))
    .map(r => {
      let actionType = r.actionType;

      if (actionType === "ActivitiesComment") {
        if (r.internal === true) {
          actionType = "ActivitiesCommentInternal";
        } else if (r.internal === false) {
          actionType = "ActivitiesCommentExternal";
        }
      }

      return {
        ...r,
        actionType
      };
    });

  const header = [
    "report_id",
    "action_type",
    "actor_username",
    "created_at"
  ];

  const escapeCSV = v =>
    `"${String(v ?? "").replace(/"/g, '""')}"`;

  const lines = [
    header.join(","),
    ...normalized.map(r =>
      [
        r.reportId,
        r.actionType,
        r.actor,
        r.createdAt
      ].map(escapeCSV).join(",")
    )
  ];

  return lines.join("\n");
}

function downloadCSV(csv, filename) {
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);

  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();

  URL.revokeObjectURL(url);
  a.remove();
}

async function fetchReportIdsFromInbox({ inbox, startDate, endDate }) {
  const csrf = getCSRFToken();
  if (!csrf) {
    throw new Error("CSRF token not found");
  }

  const params = new URLSearchParams({
    organization_inbox_handle: inbox,
    view: "all",
    start_date: startDate,
    end_date: endDate,
    sort_direction: "descending",
    sort_type: "latest_activity",
    limit: "1000",
    page: "1",
    subject: "user",
    report_id: "0",
    text_query: ""
  });

  [
    "new",
    "informative",
    "pending-program-review",
    "needs-more-info",
    "triaged",
    "retesting",
    "duplicate",
    "not-applicable",
    "resolved",
    "spam"
  ].forEach(s => params.append("substates[]", s));

  const url = `/bugs.json?${params.toString()}`;

  console.log("[H1] Fetching inbox report IDs…");

  const res = await fetch(url, {
    method: "POST",
    credentials: "include",
    headers: {
      "Accept": "application/json",
      "X-CSRF-Token": csrf
    }
  });

  if (!res.ok) {
    throw new Error(`Inbox fetch failed (${res.status})`);
  }

  const json = await res.json();
  const ids = (json?.bugs || [])
    .map(b => b?.id)
    .filter(Boolean)
    .map(String);

  return [...new Set(ids)];
}
