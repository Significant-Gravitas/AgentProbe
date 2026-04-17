export const DEFAULT_DASHBOARD_HTML = "__INLINE_DASHBOARD__";

const DASHBOARD_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>AgentProbe Server</title>
    <style>
      :root {
        color-scheme: light dark;
        font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
      }
      body {
        margin: 0;
        background: #0f1115;
        color: #f5f5f5;
        min-height: 100vh;
      }
      header {
        padding: 16px 24px;
        border-bottom: 1px solid #1e222b;
        display: flex;
        gap: 16px;
        align-items: center;
        background: #171a21;
      }
      header nav {
        display: flex;
        gap: 12px;
      }
      header nav a {
        color: #c9d1d9;
        text-decoration: none;
        padding: 6px 10px;
        border-radius: 6px;
      }
      header nav a.active {
        background: #1f6feb;
        color: white;
      }
      main {
        padding: 24px;
        max-width: 1200px;
        margin: 0 auto;
      }
      table {
        width: 100%;
        border-collapse: collapse;
        margin-top: 16px;
      }
      th,
      td {
        padding: 8px 12px;
        text-align: left;
        border-bottom: 1px solid #1e222b;
        font-size: 13px;
      }
      th {
        color: #8b949e;
        font-weight: 600;
      }
      tr:hover td {
        background: #171a21;
      }
      .badge {
        display: inline-block;
        padding: 2px 8px;
        border-radius: 999px;
        font-size: 11px;
        font-weight: 600;
      }
      .badge-pass {
        background: #1a7f37;
      }
      .badge-fail {
        background: #d73a49;
      }
      .badge-running {
        background: #1f6feb;
      }
      .badge-unknown {
        background: #6e7681;
      }
      pre {
        background: #0a0d12;
        padding: 12px;
        border-radius: 6px;
        overflow: auto;
        font-size: 12px;
      }
      code {
        font-family: "Menlo", "Consolas", monospace;
      }
      a {
        color: #58a6ff;
      }
      .card {
        background: #171a21;
        border: 1px solid #1e222b;
        border-radius: 8px;
        padding: 16px;
        margin-bottom: 16px;
      }
      .grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
        gap: 12px;
      }
      .stat {
        background: #0f1115;
        border: 1px solid #1e222b;
        border-radius: 8px;
        padding: 12px;
      }
      .stat-label {
        font-size: 12px;
        color: #8b949e;
        text-transform: uppercase;
      }
      .stat-value {
        font-size: 24px;
        font-weight: 700;
        margin-top: 4px;
      }
      #error {
        display: none;
        padding: 12px;
        background: #5a1d1d;
        border: 1px solid #d73a49;
        border-radius: 6px;
        margin-bottom: 16px;
      }
      label {
        display: block;
        font-size: 12px;
        color: #8b949e;
        margin-bottom: 4px;
      }
      input[type="password"],
      input[type="text"] {
        padding: 6px 8px;
        border-radius: 4px;
        border: 1px solid #30363d;
        background: #0a0d12;
        color: #f5f5f5;
      }
      button {
        padding: 6px 12px;
        border-radius: 4px;
        border: none;
        background: #1f6feb;
        color: white;
        cursor: pointer;
      }
    </style>
  </head>
  <body>
    <header>
      <strong>AgentProbe</strong>
      <nav>
        <a href="/" data-view="overview">Overview</a>
        <a href="/runs" data-view="runs">Runs</a>
        <a href="/suites" data-view="suites">Suites</a>
        <a href="/settings" data-view="settings">Settings</a>
      </nav>
    </header>
    <main>
      <div id="error"></div>
      <section id="content"></section>
    </main>
    <script>
      (function () {
        const TOKEN_KEY = "agentprobe:token";
        const HAS_TOKEN = __HAS_TOKEN__;
        const content = document.getElementById("content");
        const errorBox = document.getElementById("error");

        function currentToken() {
          return window.localStorage.getItem(TOKEN_KEY) || "";
        }

        function setToken(value) {
          if (!value) {
            window.localStorage.removeItem(TOKEN_KEY);
          } else {
            window.localStorage.setItem(TOKEN_KEY, value);
          }
        }

        function setActiveNav(pathname) {
          const links = document.querySelectorAll("header nav a");
          links.forEach(function (link) {
            const href = link.getAttribute("href");
            link.classList.toggle(
              "active",
              pathname === href ||
                (href !== "/" && pathname.startsWith(href)),
            );
          });
        }

        async function api(path) {
          const headers = {};
          const token = currentToken();
          if (token) {
            headers.authorization = "Bearer " + token;
          }
          const response = await fetch(path, { headers: headers });
          const text = await response.text();
          let body = null;
          try {
            body = JSON.parse(text);
          } catch (error) {
            body = { raw: text };
          }
          if (!response.ok) {
            throw new Error(
              (body && body.error && body.error.message) ||
                "Request failed: " + response.status,
            );
          }
          return body;
        }

        function escapeHtml(value) {
          return String(value).replace(/[&<>"]/g, function (ch) {
            return {
              "&": "&amp;",
              "<": "&lt;",
              ">": "&gt;",
              '"': "&quot;",
            }[ch];
          });
        }

        function runStatusBadge(run) {
          if (run.status === "running") {
            return '<span class="badge badge-running">running</span>';
          }
          if (run.status === "completed") {
            const cls = run.passed ? "badge-pass" : "badge-fail";
            return (
              '<span class="badge ' +
              cls +
              '">' +
              (run.passed ? "pass" : "fail") +
              "</span>"
            );
          }
          return (
            '<span class="badge badge-unknown">' +
            escapeHtml(run.status) +
            "</span>"
          );
        }

        async function renderOverview() {
          try {
            const runs = await api("/api/runs?limit=5");
            const suites = await api("/api/suites");
            const totals = (runs.runs || []).reduce(
              function (acc, run) {
                acc.total += 1;
                if (run.passed === true) acc.passed += 1;
                if (run.passed === false) acc.failed += 1;
                return acc;
              },
              { total: 0, passed: 0, failed: 0 },
            );
            content.innerHTML =
              '<div class="grid">' +
              '<div class="stat"><div class="stat-label">Recent runs</div><div class="stat-value">' +
              runs.total +
              "</div></div>" +
              '<div class="stat"><div class="stat-label">Passed</div><div class="stat-value">' +
              totals.passed +
              "</div></div>" +
              '<div class="stat"><div class="stat-label">Failed</div><div class="stat-value">' +
              totals.failed +
              "</div></div>" +
              '<div class="stat"><div class="stat-label">Suites</div><div class="stat-value">' +
              (suites.suites || []).length +
              "</div></div>" +
              "</div>" +
              '<div class="card"><h3>Latest runs</h3>' +
              renderRunsTable(runs.runs || []) +
              "</div>";
          } catch (error) {
            showError(error);
          }
        }

        function renderRunsTable(runs) {
          if (!runs.length) {
            return "<p>No runs recorded yet.</p>";
          }
          const rows = runs
            .map(function (run) {
              const counts = run.aggregateCounts || {};
              return (
                "<tr>" +
                '<td><a href="/runs/' +
                escapeHtml(run.runId) +
                '">' +
                escapeHtml(run.runId.slice(0, 12)) +
                "</a></td>" +
                "<td>" +
                runStatusBadge(run) +
                "</td>" +
                "<td>" +
                escapeHtml(run.preset || "") +
                "</td>" +
                "<td>" +
                escapeHtml(run.startedAt) +
                "</td>" +
                "<td>" +
                (counts.scenarioPassedCount || 0) +
                "/" +
                (counts.scenarioTotal || 0) +
                "</td>" +
                "</tr>"
              );
            })
            .join("");
          return (
            "<table><thead><tr>" +
            "<th>Run</th><th>Status</th><th>Preset</th><th>Started</th><th>Passed/Total</th>" +
            "</tr></thead><tbody>" +
            rows +
            "</tbody></table>"
          );
        }

        async function renderRuns() {
          try {
            const runs = await api("/api/runs");
            content.innerHTML =
              '<div class="card"><h2>Runs</h2>' +
              renderRunsTable(runs.runs || []) +
              "</div>";
          } catch (error) {
            showError(error);
          }
        }

        async function renderRun(runId) {
          try {
            const run = (await api("/api/runs/" + encodeURIComponent(runId))).run;
            const scenarios = run.scenarios || [];
            const rows = scenarios
              .map(function (scenario) {
                return (
                  "<tr><td><a href=\\"/runs/" +
                  escapeHtml(run.runId) +
                  "/scenarios/" +
                  scenario.ordinal +
                  '">' +
                  scenario.ordinal +
                  "</a></td>" +
                  "<td>" +
                  escapeHtml(scenario.scenarioId) +
                  "</td>" +
                  "<td>" +
                  escapeHtml(scenario.status) +
                  "</td>" +
                  "<td>" +
                  (scenario.passed === true
                    ? '<span class="badge badge-pass">pass</span>'
                    : scenario.passed === false
                      ? '<span class="badge badge-fail">fail</span>'
                      : "-") +
                  "</td>" +
                  "<td>" +
                  (scenario.overallScore === null ||
                  scenario.overallScore === undefined
                    ? "-"
                    : scenario.overallScore.toFixed(2)) +
                  "</td></tr>"
                );
              })
              .join("");
            content.innerHTML =
              '<div class="card"><h2>Run ' +
              escapeHtml(run.runId) +
              "</h2>" +
              "<p>" +
              runStatusBadge(run) +
              " started " +
              escapeHtml(run.startedAt) +
              "</p>" +
              "<p>" +
              '<a href="/api/runs/' +
              encodeURIComponent(run.runId) +
              '/report.html">Open HTML report</a></p>' +
              "<table><thead><tr><th>#</th><th>Scenario</th><th>Status</th><th>Pass</th><th>Score</th></tr></thead><tbody>" +
              rows +
              "</tbody></table></div>";
          } catch (error) {
            showError(error);
          }
        }

        async function renderScenario(runId, ordinal) {
          try {
            const data = await api(
              "/api/runs/" +
                encodeURIComponent(runId) +
                "/scenarios/" +
                encodeURIComponent(ordinal),
            );
            content.innerHTML =
              '<div class="card"><h2>' +
              escapeHtml(data.scenario.scenarioName) +
              " (ordinal " +
              data.scenario.ordinal +
              ")</h2>" +
              '<p><a href="/runs/' +
              escapeHtml(data.run.runId) +
              '">Back to run</a></p>' +
              "<pre>" +
              escapeHtml(JSON.stringify(data.scenario, null, 2)) +
              "</pre></div>";
          } catch (error) {
            showError(error);
          }
        }

        async function renderSuites() {
          try {
            const data = await api("/api/suites");
            const suites = data.suites || [];
            const body = suites
              .map(function (suite) {
                return (
                  "<tr><td>" +
                  escapeHtml(suite.id) +
                  "</td><td>" +
                  escapeHtml(suite.schema) +
                  "</td><td>" +
                  escapeHtml(suite.relativePath) +
                  "</td><td>" +
                  suite.objectCount +
                  "</td></tr>"
                );
              })
              .join("");
            content.innerHTML =
              '<div class="card"><h2>Suites</h2>' +
              "<p>Data path: <code>" +
              escapeHtml(data.data_path) +
              "</code></p>" +
              "<table><thead><tr><th>Suite</th><th>Schema</th><th>Relative path</th><th>Objects</th></tr></thead><tbody>" +
              body +
              "</tbody></table></div>";
          } catch (error) {
            showError(error);
          }
        }

        function renderSettings() {
          const token = currentToken();
          content.innerHTML =
            '<div class="card"><h2>Settings</h2>' +
            "<p>Token required: <strong>" +
            (HAS_TOKEN ? "yes" : "no") +
            "</strong></p>" +
            '<label for="token">Bearer token</label>' +
            '<input id="token" type="password" value="' +
            escapeHtml(token) +
            '" placeholder="paste token" />' +
            " <button id=\\"save-token\\">Save</button></div>";
          const input = document.getElementById("token");
          document
            .getElementById("save-token")
            .addEventListener("click", function () {
              setToken(input.value.trim());
              errorBox.style.display = "none";
              errorBox.textContent = "";
            });
        }

        function showError(error) {
          errorBox.style.display = "block";
          errorBox.textContent = error.message;
        }

        function handleRoute() {
          errorBox.style.display = "none";
          errorBox.textContent = "";
          const path = window.location.pathname;
          setActiveNav(path);
          if (path === "/" || path === "/index.html") {
            renderOverview();
            return;
          }
          if (path === "/runs") {
            renderRuns();
            return;
          }
          if (path === "/suites") {
            renderSuites();
            return;
          }
          if (path === "/settings") {
            renderSettings();
            return;
          }
          const runMatch = path.match(/^\\/runs\\/([^\\/]+)$/);
          if (runMatch) {
            renderRun(runMatch[1]);
            return;
          }
          const scenarioMatch = path.match(
            /^\\/runs\\/([^\\/]+)\\/scenarios\\/([0-9]+)$/,
          );
          if (scenarioMatch) {
            renderScenario(scenarioMatch[1], scenarioMatch[2]);
            return;
          }
          content.innerHTML = "<p>Page not found.</p>";
        }

        document.addEventListener("click", function (event) {
          const anchor = event.target.closest && event.target.closest("a");
          if (!anchor) return;
          const href = anchor.getAttribute("href");
          if (!href || !href.startsWith("/") || href.startsWith("//")) return;
          if (
            href.startsWith("/api/") ||
            href.endsWith(".html") ||
            anchor.getAttribute("target")
          ) {
            return;
          }
          event.preventDefault();
          window.history.pushState({}, "", href);
          handleRoute();
        });

        window.addEventListener("popstate", handleRoute);
        handleRoute();
      })();
    </script>
  </body>
</html>
`;

export function dashboardHtml(options: { hasToken: boolean }): string {
  return DASHBOARD_HTML.replace(
    "__HAS_TOKEN__",
    options.hasToken ? "true" : "false",
  );
}
