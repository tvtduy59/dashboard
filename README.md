# Team Issues Dashboard

A one-screen dashboard for tracking your own work and your team's progress, using **GitHub Issues** as the task tracker.
It's a static page (HTML + CSS + JS) with no build step and no backend. It calls the GitHub REST API directly from your browser.

Until you connect a repository, it shows **demo data** so you can see how it looks.

## What's on the screen

| Area | What it tells you |
|---|---|
| **KPI strip** | Open, In progress (+ in review), Blocked, Completed and Opened in the selected range (with change vs. the previous period), Velocity (completed/week), Median cycle time (open → close), Stale issues |
| **Burn-up / Throughput** | Total scope vs. completed over time (the shaded gap is the remaining work), or opened vs. completed per day/week |
| **Team progress** | For each member: open, active, done in range, completion %, median cycle time, and a trend sparkline. Click a row to focus on that person |
| **My work** | Your open issues (or the focused member's), grouped Blocked → In progress → In review → To do. Stale ages are shown in red |
| **Milestones** | % complete, open/closed counts, due date, overdue warning |
| **Open issue age / Labels** | How old the backlog is, or which labels dominate it |
| **Workload by status** | Stacked open work per member. Shows at a glance who is overloaded or blocked |
| **Recent activity** | Latest opened and completed issues |

Controls: time range **2W / 4W / 12W / 26W**, **Focus** member picker, refresh (or press `R`), light/dark toggle.
Data refreshes automatically every 5 minutes while the tab is visible.

## Run it

Any static file server works, or just open `index.html` directly:

```bash
# option 1: open the file
open index.html            # macOS  (xdg-open on Linux)

# option 2: serve locally
python3 -m http.server 8080   # then visit http://localhost:8080
```

You can also host it on **GitHub Pages** (Settings → Pages → deploy from branch, root folder). The token is never part of the site. Each viewer enters their own token, and it stays in their browser.

## Connect your repo

1. Create a token at **GitHub → Settings → Developer settings → Personal access tokens**
   - **Fine-grained (recommended):** Repository access = your tasks repo. Permissions: **Issues: Read-only** and **Metadata: Read-only**.
   - **Classic:** `repo` scope for a private repo, no scope for a public one.
2. Click **Connect GitHub** in the top-right and paste the token.
3. Enter the repository as `owner/repo`. Several repos can be comma separated, and a full GitHub URL also works.
4. Your username is detected automatically. You can type it in if detection fails. This is the person shown under **My work**.

The token is saved only in this browser's `localStorage` and sent only to `api.github.com`. Use **Forget token** in settings to remove it.
Tip: `index.html?repo=owner/repo` pre-fills the repository field.

## How status is derived

GitHub Issues has no built-in "in progress" state, so open issues are classified by **label**, checked in this order:

| Status | Default label pattern (regex, case-insensitive) |
|---|---|
| Blocked | `block\|on hold\|waiting` |
| In review | `review\|qa\|testing\|verify` |
| In progress | `in progress\|doing\|wip\|started\|working` |
| To do | no status label, has an assignee |
| Backlog | no status label, no assignee |

You can change these patterns in **Settings → Status label mapping** to match your team's labels.
Issues closed as *not planned* or *duplicate* don't count as delivered work. Work is credited to the issue's assignees.
Labels containing `P0`, `P1`, `urgent`, `critical` or `priority: high` push an issue to the top of its group in *My work*.

## Limits

- Loads the 3,000 most recently created issues per repo (30 API pages). An authenticated token has 5,000 requests/hour, so this is well within quota.
- Pull requests are ignored.
- GitHub Projects (v2) custom "Status" fields aren't read. Use labels for status.

## Files

```
index.html        layout
css/styles.css    theme tokens (light + dark), grid, components
js/app.js         GitHub API client, metrics, rendering (Chart.js 4 from jsDelivr)
js/demo.js        deterministic sample data
```
