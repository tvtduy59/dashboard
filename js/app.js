/* Team Issues Dashboard — reads GitHub Issues straight from the REST API in
   the browser. No build step, no backend. Token lives in localStorage only. */
(function () {
  'use strict';

  const DAY = 864e5;
  const WEEK = 7 * DAY;
  const API = 'https://api.github.com';
  const MAX_PAGES = 30; // 30 × 100 = up to 3,000 most-recent issues per repo
  const AUTO_REFRESH_MS = 5 * 60 * 1000;

  const DEFAULTS = {
    token: '', repos: '', me: '', staleDays: 14,
    reProgress: 'in[ _-]?progress|doing|wip|started|working',
    reReview: 'review|qa|testing|verify',
    reBlocked: 'block|on[ _-]?hold|waiting',
  };

  // ───────────────────────── Storage ─────────────────────────
  const store = {
    get(k, d) { try { const v = localStorage.getItem('ghdash.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem('ghdash.' + k, JSON.stringify(v)); } catch { /* storage blocked */ } },
    del(k) { try { localStorage.removeItem('ghdash.' + k); } catch { /* storage blocked */ } },
  };

  const state = {
    cfg: Object.assign({}, DEFAULTS, store.get('cfg', {})),
    weeks: store.get('weeks', 4),
    focus: null,
    data: null,
    charts: {},
    tabs: Object.assign({ flow: 'burnup', dist: 'age' }, store.get('tabs', {})),
    timer: null,
  };

  // ───────────────────────── Helpers ─────────────────────────
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
  const median = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
  const fmtDays = (d) => d == null ? '—' : d < 1 ? '<1d' : d < 10 ? d.toFixed(1).replace(/\.0$/, '') + 'd' : Math.round(d) + 'd';
  const fmtDate = (t, withYear) => new Date(t).toLocaleDateString(undefined, withYear ? { month: 'short', day: 'numeric', year: 'numeric' } : { month: 'short', day: 'numeric' });
  function ago(t) {
    const s = (Date.now() - t) / 1000;
    if (s < 60) return 'just now';
    if (s < 3600) return Math.floor(s / 60) + 'm ago';
    if (s < 86400) return Math.floor(s / 3600) + 'h ago';
    if (s < 86400 * 30) return Math.floor(s / 86400) + 'd ago';
    return fmtDate(t);
  }
  const ageShort = (t) => { const d = (Date.now() - t) / DAY; return d < 1 ? Math.max(1, Math.round(d * 24)) + 'h' : d < 60 ? Math.floor(d) + 'd' : Math.floor(d / 30) + 'mo'; };
  const safeRe = (src) => { try { return new RegExp(src, 'i'); } catch { return /$^/; } };

  function toast(msg, isError, ms = 4200) {
    const el = $('#toast');
    el.textContent = msg; el.className = 'toast' + (isError ? ' error' : ''); el.hidden = false;
    clearTimeout(toast._t); toast._t = setTimeout(() => (el.hidden = true), ms);
  }
  const loading = (on, text) => { $('#loading').hidden = !on; if (text) $('#loadingText').textContent = text; };

  // Avatar: real image for GitHub users, initials disc for demo / fallback.
  const AV_COLORS = ['#2a78d6', '#eb6834', '#1baf7a', '#c98500', '#d55181', '#008300', '#4a3aa7', '#e34948'];
  function avatar(login, size = 22) {
    const url = state.data?.avatars?.[login];
    if (url) return `<img class="avatar" style="width:${size}px;height:${size}px" src="${esc(url)}&s=${size * 2}" alt="" loading="lazy">`;
    let h = 0; for (const c of login) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    return `<span class="avatar" style="width:${size}px;height:${size}px;background:${AV_COLORS[h % AV_COLORS.length]}">${esc(login.slice(0, 2).toUpperCase())}</span>`;
  }

  // ───────────────────────── Status model ─────────────────────────
  const STATUS = {
    blocked: { label: 'Blocked', color: '--critical' },
    progress: { label: 'In progress', color: '--s-progress' },
    review: { label: 'In review', color: '--s-review' },
    todo: { label: 'To do', color: '--s-todo' },
    backlog: { label: 'Backlog', color: '--s-backlog' },
    done: { label: 'Done', color: '--good' },
  };
  const ICONS = {
    backlog: (c) => `<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="6" fill="none" stroke="${c}" stroke-width="1.6" stroke-dasharray="2.4 2"/></svg>`,
    todo: (c) => `<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="6" fill="none" stroke="${c}" stroke-width="1.8"/></svg>`,
    progress: (c) => `<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="6" fill="none" stroke="${c}" stroke-width="1.8"/><path d="M8 4a4 4 0 0 1 0 8z" fill="${c}"/></svg>`,
    review: (c) => `<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="6" fill="none" stroke="${c}" stroke-width="1.8"/><path d="M8 4a4 4 0 1 1-4 4h4z" fill="${c}"/></svg>`,
    blocked: (c) => `<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="6.5" fill="${c}"/><path d="M5 8h6" stroke="#fff" stroke-width="2" stroke-linecap="round"/></svg>`,
    done: (c) => `<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="6.5" fill="${c}"/><path d="M5 8.2l2 2 4-4.2" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
    opened: (c) => `<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="6" fill="none" stroke="${c}" stroke-width="1.8"/><circle cx="8" cy="8" r="1.8" fill="${c}"/></svg>`,
  };
  const statusIcon = (s) => `<span class="st" title="${STATUS[s].label}">${ICONS[s](css(STATUS[s].color))}</span>`;

  function classify(issues, cfg) {
    const reP = safeRe(cfg.reProgress), reR = safeRe(cfg.reReview), reB = safeRe(cfg.reBlocked);
    for (const i of issues) {
      if (i.state === 'closed') { i.status = 'done'; continue; }
      const names = i.labels.map((l) => l.name);
      if (names.some((n) => reB.test(n))) i.status = 'blocked';
      else if (names.some((n) => reR.test(n))) i.status = 'review';
      else if (names.some((n) => reP.test(n))) i.status = 'progress';
      else i.status = i.assignees.length ? 'todo' : 'backlog';
      i.priority = names.some((n) => /p0|p1|urgent|critical|priority[:/ -]*(high|p?[01])|high[ -]?priority/i.test(n)) ? 1 : 0;
    }
    return issues;
  }
  const isStatusLabel = (name, cfg) => [cfg.reProgress, cfg.reReview, cfg.reBlocked].some((r) => safeRe(r).test(name));

  // ───────────────────────── GitHub API ─────────────────────────
  async function gh(url, token) {
    const res = await fetch(url.startsWith('http') ? url : API + url, {
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(token ? { Authorization: 'Bearer ' + token } : {}),
      },
    });
    if (!res.ok) {
      let msg = `GitHub API error ${res.status}`;
      if (res.status === 401) msg = 'GitHub rejected the token (401). Check the PAT and its expiry.';
      else if (res.status === 404) msg = 'Repository not found — check the name, or the token has no access to it (404).';
      else if (res.status === 403 || res.status === 429) {
        const reset = res.headers.get('x-ratelimit-reset');
        msg = res.headers.get('x-ratelimit-remaining') === '0'
          ? `GitHub rate limit reached. Resets at ${reset ? new Date(reset * 1000).toLocaleTimeString() : 'soon'}.`
          : 'Access denied (403). The token may lack Issues read permission.';
      }
      throw new Error(msg);
    }
    const link = res.headers.get('link');
    const next = link && /<([^>]+)>;\s*rel="next"/.exec(link);
    return { json: await res.json(), next: next ? next[1] : null };
  }
  async function ghAll(path, token, onPage) {
    let url = path, out = [], n = 0;
    while (url && n < MAX_PAGES) {
      const r = await gh(url, token);
      out = out.concat(r.json); url = r.next; n++;
      onPage && onPage(out.length);
    }
    return out;
  }

  async function loadGitHub(cfg) {
    const repos = cfg.repos.split(/[\s,]+/).map((s) => s.trim().replace(/^https?:\/\/github\.com\//, '').replace(/\.git$|\/$/g, '')).filter(Boolean);
    if (!repos.length) throw new Error('Add at least one repository (owner/repo).');
    for (const r of repos) if (!/^[\w.-]+\/[\w.-]+$/.test(r)) throw new Error(`"${r}" is not a valid owner/repo.`);

    let me = cfg.me.trim().replace(/^@/, '');
    if (!me && cfg.token) {
      try { me = (await gh('/user', cfg.token)).json.login; } catch { /* fine-grained tokens may not read /user */ }
    }

    const avatars = {};
    const issues = [], milestones = [];
    for (const repo of repos) {
      const raw = await ghAll(`/repos/${repo}/issues?state=all&per_page=100&sort=created&direction=desc`, cfg.token,
        (n) => loading(true, `Loading ${repo} … ${n} items`));
      for (const i of raw) {
        if (i.pull_request) continue;
        for (const a of i.assignees || []) avatars[a.login] = a.avatar_url;
        if (i.user) avatars[i.user.login] ||= i.user.avatar_url;
        issues.push({
          repo, number: i.number, title: i.title, url: i.html_url, state: i.state,
          created: +new Date(i.created_at),
          closed: i.closed_at ? +new Date(i.closed_at) : null,
          updated: +new Date(i.updated_at),
          reason: i.state_reason || (i.state === 'closed' ? 'completed' : null),
          labels: (i.labels || []).map((l) => (typeof l === 'string' ? { name: l, color: '888888' } : { name: l.name, color: l.color })),
          assignees: (i.assignees || []).map((a) => a.login),
          author: i.user ? i.user.login : null,
          milestone: i.milestone ? i.milestone.title : null,
          comments: i.comments,
        });
      }
      const ms = await ghAll(`/repos/${repo}/milestones?state=all&per_page=100&sort=due_on`, cfg.token);
      for (const m of ms) {
        milestones.push({
          repo, title: m.title, url: m.html_url, state: m.state,
          due: m.due_on ? +new Date(m.due_on) : null,
          open: m.open_issues, closed: m.closed_issues,
          closedAt: m.closed_at ? +new Date(m.closed_at) : null,
        });
      }
    }
    return { issues, milestones, avatars, me, repos, fetchedAt: Date.now(), demo: false };
  }

  // ───────────────────────── Metrics ─────────────────────────
  function compute(data, weeks, focus) {
    const cfg = state.cfg;
    const now = Date.now();
    const span = weeks * WEEK;
    const start = now - span, prevStart = start - span;
    const staleMs = (+cfg.staleDays || 14) * DAY;

    // "not planned"/duplicate closures are scope removal, not delivered work.
    const all = classify(data.issues.filter((i) => i.reason !== 'not_planned' && i.reason !== 'duplicate'), cfg);
    const open = all.filter((i) => i.state === 'open');
    const done = all.filter((i) => i.state === 'closed' && i.closed);
    const doneIn = done.filter((i) => i.closed >= start);
    const donePrev = done.filter((i) => i.closed >= prevStart && i.closed < start);
    const openedIn = all.filter((i) => i.created >= start);
    const openedPrev = all.filter((i) => i.created >= prevStart && i.created < start);
    const cycle = doneIn.map((i) => (i.closed - i.created) / DAY);
    const cyclePrev = donePrev.map((i) => (i.closed - i.created) / DAY);

    const count = (s) => open.filter((i) => i.status === s).length;
    const kpi = {
      open: open.length,
      progress: count('progress') + count('review'),
      review: count('review'),
      blocked: count('blocked'),
      done: doneIn.length, donePrev: donePrev.length,
      opened: openedIn.length, openedPrev: openedPrev.length,
      cycle: median(cycle), cyclePrev: median(cyclePrev),
      stale: open.filter((i) => now - i.updated > staleMs).length,
      unassigned: open.filter((i) => !i.assignees.length).length,
      velocity: doneIn.length / weeks,
    };

    // Buckets for time series: daily for ≤4 weeks, weekly beyond.
    const step = weeks <= 4 ? DAY : WEEK;
    const nB = Math.round(span / step);
    const bucketStart = (k) => start + k * step;
    const bLabels = [], opened = [], closed = [], scope = [], completed = [];
    for (let k = 0; k < nB; k++) {
      const a = bucketStart(k), b = a + step;
      bLabels.push(step === DAY ? fmtDate(b - 1) : 'Wk of ' + fmtDate(a));
      opened.push(all.filter((i) => i.created >= a && i.created < b).length);
      closed.push(done.filter((i) => i.closed >= a && i.closed < b).length);
      scope.push(all.filter((i) => i.created < b).length);
      completed.push(done.filter((i) => i.closed < b).length);
    }

    // Team: everyone assigned to open work or completed work in range.
    const members = new Map();
    const M = (login) => {
      if (!members.has(login)) members.set(login, { login, open: 0, active: 0, blocked: 0, todo: 0, progress: 0, review: 0, done: 0, cycles: [], trend: new Array(Math.min(nB, 13)).fill(0) });
      return members.get(login);
    };
    for (const i of open) for (const a of i.assignees) { const m = M(a); m.open++; m[i.status] = (m[i.status] || 0) + 1; if (i.status === 'progress' || i.status === 'review') m.active++; }
    const tB = Math.min(nB, 13), tStep = span / tB;
    for (const i of doneIn) for (const a of i.assignees) {
      const m = M(a); m.done++; m.cycles.push((i.closed - i.created) / DAY);
      m.trend[Math.min(tB - 1, Math.floor((i.closed - start) / tStep))]++;
    }
    if (data.me) M(data.me);
    const team = [...members.values()].map((m) => ({
      ...m, cycle: median(m.cycles), rate: m.done + m.open ? m.done / (m.done + m.open) : 0,
    })).sort((a, b) => b.done - a.done || b.open - a.open || a.login.localeCompare(b.login));

    // Focus person's queue
    const who = focus || data.me;
    const order = { blocked: 0, progress: 1, review: 2, todo: 3, backlog: 4 };
    const mine = open.filter((i) => who && i.assignees.includes(who))
      .sort((a, b) => order[a.status] - order[b.status] || b.priority - a.priority || b.updated - a.updated);
    const mineDone = doneIn.filter((i) => who && i.assignees.includes(who)).length;

    // Distribution: open issue age
    const ageBuckets = [['< 1 wk', 7], ['1–4 wks', 28], ['1–3 mo', 91], ['3–6 mo', 182], ['> 6 mo', Infinity]];
    const ages = ageBuckets.map(() => 0);
    for (const i of open) { const d = (now - i.created) / DAY; ages[ageBuckets.findIndex((b) => d < b[1])]++; }

    // Distribution: labels on open issues (excluding workflow-status labels)
    const lab = new Map();
    for (const i of open) for (const l of i.labels) if (!isStatusLabel(l.name, cfg)) lab.set(l.name, (lab.get(l.name) || 0) + 1);
    const labels = [...lab.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);

    // Milestones: open first, by due date; closed ones only if recent
    const ms = data.milestones
      .filter((m) => m.state === 'open' || (m.closedAt || m.due || 0) > now - 30 * DAY)
      .sort((a, b) => (a.state === 'open' ? 0 : 1) - (b.state === 'open' ? 0 : 1) || (a.due ?? Infinity) - (b.due ?? Infinity));

    // Activity feed: opened + closed events, newest first
    const events = [];
    for (const i of data.issues) {
      events.push({ t: i.created, kind: 'opened', who: i.author, i });
      if (i.closed) events.push({ t: i.closed, kind: i.reason === 'not_planned' || i.reason === 'duplicate' ? 'dropped' : 'done', who: i.assignees[0] || null, i });
    }
    events.sort((a, b) => b.t - a.t);

    return { kpi, series: { labels: bLabels, opened, closed, scope, completed }, team, who, mine, mineDone, ages, ageBuckets, labels, ms, events: events.slice(0, 40), weeks };
  }

  // ───────────────────────── Rendering ─────────────────────────
  function delta(cur, prev, higherIsGood = true, unit = '') {
    if (prev == null || cur == null) return '<span class="delta flat">no prior data</span>';
    if (!prev && !cur) return '<span class="delta flat">— vs prev</span>';
    const diff = cur - prev;
    if (Math.abs(diff) < 0.05) return '<span class="delta flat">= vs prev</span>';
    const good = diff > 0 === higherIsGood;
    const pct = prev ? Math.round((diff / prev) * 100) : null;
    const sign = diff > 0 ? '+' : '−';
    const txt = unit ? sign + fmtDays(Math.abs(diff)) : pct != null ? sign + Math.abs(pct) + '%' : sign + Math.abs(diff);
    return `<span class="delta ${good ? 'up' : 'down'}">${diff > 0 ? '▲' : '▼'} ${txt}</span> vs prev`;
  }

  function renderKPIs(c) {
    const k = c.kpi, w = c.weeks + 'w';
    const tiles = [
      { label: 'Open issues', dot: '--s-todo', value: k.open, foot: `${k.unassigned} unassigned` },
      { label: 'In progress', dot: '--s-progress', value: k.progress, foot: `${k.review} in review` },
      { label: 'Blocked', dot: '--critical', value: k.blocked, foot: k.open ? `${Math.round((k.blocked / k.open) * 100)}% of open` : '—' },
      { label: `Completed · ${w}`, dot: '--good', value: k.done, foot: delta(k.done, k.donePrev, true) },
      { label: `Opened · ${w}`, dot: '--s-opened', value: k.opened, foot: delta(k.opened, k.openedPrev, false) },
      { label: 'Velocity', value: k.velocity.toFixed(1), unit: '/wk', foot: `net ${k.done - k.opened >= 0 ? '−' : '+'}${Math.abs(k.done - k.opened)} backlog` },
      { label: 'Median cycle time', value: k.cycle == null ? '—' : fmtDays(k.cycle), foot: delta(k.cycle, k.cyclePrev, false, 'd') },
      { label: `Stale > ${state.cfg.staleDays || 14}d`, dot: '--serious', value: k.stale, foot: 'open, no updates' },
    ];
    $('#kpis').innerHTML = tiles.map((t) => `
      <div class="kpi">
        <div class="k-label">${t.dot ? `<i class="k-dot" style="background:var(${t.dot})"></i>` : ''}${esc(t.label)}</div>
        <div class="k-value">${esc(t.value)}${t.unit ? `<small>${t.unit}</small>` : ''}</div>
        <div class="k-foot">${t.foot}</div>
      </div>`).join('');
  }

  function baseOpts() {
    const muted = css('--muted');
    return {
      responsive: true, maintainAspectRatio: false, animation: { duration: 350 },
      interaction: { mode: 'index', intersect: false },
      layout: { padding: { top: 4, right: 4 } },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: css('--surface-2'), titleColor: css('--text'), bodyColor: css('--text-2'),
          borderColor: css('--border'), borderWidth: 1, padding: 9, boxPadding: 4, usePointStyle: true,
          titleFont: { weight: '600', size: 12 }, bodyFont: { size: 12 },
        },
      },
      scales: {
        x: { grid: { display: false }, border: { color: css('--axis') }, ticks: { color: muted, maxRotation: 0, autoSkip: true, maxTicksLimit: 7, font: { size: 11 } } },
        y: { beginAtZero: true, grid: { color: css('--grid') }, border: { display: false }, ticks: { color: muted, precision: 0, maxTicksLimit: 5, font: { size: 11 } } },
      },
    };
  }
  function chart(id, cfg) {
    if (state.charts[id]) state.charts[id].destroy();
    state.charts[id] = new Chart(document.getElementById(id), cfg);
  }
  const legendHTML = (items) => items.map(([label, color, line]) => `<span><i class="${line ? 'line' : ''}" style="background:${color}"></i>${esc(label)}</span>`).join('');

  function renderFlow(c) {
    const s = c.series, mode = state.tabs.flow;
    const blue = css('--s-progress'), green = css('--good'), orange = css('--s-opened'), surface = css('--surface');
    const shortLabels = s.labels.map((l) => l.replace('Wk of ', ''));
    if (mode === 'burnup') {
      $('#flowTitle').textContent = 'Burn-up';
      $('#flowLegend').innerHTML = legendHTML([['Total scope', blue, 1], ['Completed', green, 1], ['Remaining', hexA(green, 0.25)]]);
      const o = baseOpts();
      o.scales.y.beginAtZero = false;
      o.plugins.tooltip.callbacks = {
        title: (it) => s.labels[it[0].dataIndex],
        footer: (it) => { const i = it[0].dataIndex; return `Remaining: ${s.scope[i] - s.completed[i]}`; },
      };
      chart('flowChart', {
        type: 'line',
        data: {
          labels: shortLabels,
          datasets: [
            { label: 'Total scope', data: s.scope, borderColor: blue, backgroundColor: blue, borderWidth: 2, pointRadius: 0, pointHoverRadius: 4, pointHoverBorderColor: surface, pointHoverBorderWidth: 2, tension: 0.25, fill: false },
            { label: 'Completed', data: s.completed, borderColor: green, backgroundColor: hexA(green, 0.12), borderWidth: 2, pointRadius: 0, pointHoverRadius: 4, pointHoverBorderColor: surface, pointHoverBorderWidth: 2, tension: 0.25, fill: '-1' },
          ],
        },
        options: o,
      });
    } else {
      $('#flowTitle').textContent = 'Throughput';
      $('#flowLegend').innerHTML = legendHTML([['Opened', orange], ['Completed', green]]);
      const o = baseOpts();
      o.plugins.tooltip.callbacks = { title: (it) => s.labels[it[0].dataIndex] };
      const bar = { borderRadius: { topLeft: 4, topRight: 4 }, borderSkipped: 'bottom', categoryPercentage: 0.72, barPercentage: 0.9, borderColor: surface, borderWidth: { top: 0, left: 1, right: 1, bottom: 0 } };
      chart('flowChart', {
        type: 'bar',
        data: {
          labels: shortLabels,
          datasets: [
            { label: 'Opened', data: s.opened, backgroundColor: orange, ...bar },
            { label: 'Completed', data: s.closed, backgroundColor: green, ...bar },
          ],
        },
        options: o,
      });
    }
  }

  function sparkline(vals) {
    const W = 70, H = 20, P = 2;
    const max = Math.max(1, ...vals), n = vals.length;
    const pts = vals.map((v, i) => [P + (i * (W - 2 * P)) / Math.max(1, n - 1), H - P - (v / max) * (H - 2 * P)]);
    const d = pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join('');
    const last = pts[pts.length - 1];
    return `<svg class="spark" viewBox="0 0 ${W} ${H}" aria-label="Completed per period: ${vals.join(', ')}"><title>Completed per period: ${vals.join(', ')}</title>
      <path class="a" d="${d}L${last[0].toFixed(1)} ${H - P}L${P} ${H - P}Z"/><path class="l" d="${d}"/><circle cx="${last[0]}" cy="${last[1]}" r="2"/></svg>`;
  }

  function renderTeam(c) {
    const who = c.who;
    $('#teamHint').textContent = `${c.team.length} members · click a row to focus`;
    $('#teamTable tbody').innerHTML = c.team.length ? c.team.map((m) => {
      const pct = Math.round(m.rate * 100);
      return `<tr data-login="${esc(m.login)}" class="${m.login === who ? 'focused' : ''}">
        <td><div class="who">${avatar(m.login)}<span title="${esc(m.login)}">${esc(m.login)}</span>${m.login === state.data.me ? '<em class="me-tag">you</em>' : ''}</div></td>
        <td class="num">${m.open}${m.blocked ? ` <span class="chip warn" title="${m.blocked} blocked">${m.blocked} blk</span>` : ''}</td>
        <td class="num">${m.active}</td>
        <td class="num"><b>${m.done}</b></td>
        <td><div class="bar" title="${m.done} done / ${m.done + m.open} total"><div class="track"><div class="fill" style="width:${pct}%"></div></div><b>${pct}%</b></div></td>
        <td class="num">${fmtDays(m.cycle)}</td>
        <td>${sparkline(m.trend)}</td>
      </tr>`;
    }).join('') : '<tr><td colspan="7" class="empty">No assigned issues yet.</td></tr>';
  }

  function taskRow(i) {
    const stale = Date.now() - i.updated > (+state.cfg.staleDays || 14) * DAY;
    const chips = i.labels.filter((l) => !isStatusLabel(l.name, state.cfg)).slice(0, 2)
      .map((l) => `<span class="chip"><i style="background:#${esc(l.color)}"></i>${esc(l.name)}</span>`).join('');
    const multi = state.data.repos.length > 1 ? `<span>${esc(i.repo.split('/')[1])}</span>·` : '';
    return `<li>
      ${statusIcon(i.status)}
      <a class="t-title" href="${esc(i.url)}" target="_blank" rel="noopener" title="${esc(i.title)}"><span class="n">#${i.number}</span>${esc(i.title)}</a>
      <span class="t-age ${stale ? 'stale' : ''}" title="${stale ? 'Stale — ' : ''}updated ${ago(i.updated)}">${ageShort(i.created)}</span>
      <div class="t-meta">${multi}<span>${STATUS[i.status].label}</span>${i.milestone ? `· <span title="Milestone">⚑ ${esc(i.milestone)}</span>` : ''}${chips}</div>
    </li>`;
  }

  function renderMine(c) {
    const isMe = c.who && c.who === state.data.me;
    $('#mineTitle').textContent = c.who ? (isMe ? 'My work' : `${c.who}'s work`) : 'My work';
    $('#mineHint').textContent = c.who ? `${c.mine.length} open · ${c.mineDone} done in ${c.weeks}w` : '';
    if (!c.who) { $('#mineList').innerHTML = '<li class="empty">Set your GitHub username in settings to see your queue.</li>'; return; }
    if (!c.mine.length) { $('#mineList').innerHTML = `<li class="empty">No open issues assigned to @${esc(c.who)} 🎉</li>`; return; }
    let html = '', last = null;
    for (const i of c.mine) {
      if (i.status !== last) {
        const n = c.mine.filter((x) => x.status === i.status).length;
        html += `<li class="group-h">${STATUS[i.status].label} <span>${n}</span></li>`;
        last = i.status;
      }
      html += taskRow(i);
    }
    $('#mineList').innerHTML = html;
  }

  function renderMilestones(c) {
    const now = Date.now();
    const open = c.ms.filter((m) => m.state === 'open');
    const late = open.filter((m) => m.due && m.due < now && m.open > 0).length;
    $('#msHint').textContent = `${open.length} open${late ? ` · ${late} overdue` : ''}`;
    if (!c.ms.length) { $('#msList').innerHTML = '<li class="empty">No milestones in this repository.</li>'; return; }
    $('#msList').innerHTML = c.ms.map((m) => {
      const total = m.open + m.closed, pct = total ? Math.round((m.closed / total) * 100) : 0;
      let dueTxt = 'No due date', cls = '';
      if (m.due) {
        const d = Math.round((m.due - now) / DAY);
        if (m.state === 'closed') dueTxt = 'Closed';
        else if (d < 0 && m.open) { dueTxt = `Overdue ${-d}d`; cls = 'late'; }
        else if (d <= 7) { dueTxt = d <= 0 ? 'Due today' : `Due in ${d}d`; cls = 'soon'; }
        else dueTxt = `Due ${fmtDate(m.due)}`;
      }
      return `<li>
        <div class="ms-top"><a href="${esc(m.url)}" target="_blank" rel="noopener" title="${esc(m.title)}">${esc(m.title)}</a><span class="pct">${pct}%</span></div>
        <div class="ms-bar" title="${m.closed} closed / ${total} total">${pct ? `<div class="done ${pct === 100 ? 'full' : ''}" style="width:${pct}%"></div>` : ''}</div>
        <div class="ms-bot"><span>${m.closed}/${total} done · ${m.open} open</span><span class="${cls}">${cls === 'late' ? '⚠ ' : ''}${dueTxt}</span></div>
      </li>`;
    }).join('');
  }

  function renderDist(c) {
    const o = baseOpts();
    o.interaction = { mode: 'nearest', intersect: false, axis: 'xy' };
    if (state.tabs.dist === 'age') {
      $('#distTitle').textContent = 'Open issue age';
      const ramp = ['--r1', '--r2', '--r3', '--r4', '--r5'].map(css);
      o.plugins.tooltip.callbacks = { label: (it) => ` ${it.raw} open issue${it.raw === 1 ? '' : 's'}` };
      chart('distChart', {
        type: 'bar',
        data: { labels: c.ageBuckets.map((b) => b[0]), datasets: [{ data: c.ages, backgroundColor: ramp, borderRadius: { topLeft: 4, topRight: 4 }, borderSkipped: 'bottom', categoryPercentage: 0.8, barPercentage: 0.9 }] },
        options: o,
      });
    } else {
      $('#distTitle').textContent = 'Open issues by label';
      o.indexAxis = 'y';
      o.scales.x = { ...o.scales.y, grid: { color: css('--grid') } };
      o.scales.y = { grid: { display: false }, border: { color: css('--axis') }, ticks: { color: css('--text-2'), font: { size: 11 }, autoSkip: false, callback(v) { const l = this.getLabelForValue(v); return l.length > 16 ? l.slice(0, 15) + '…' : l; } } };
      o.plugins.tooltip.callbacks = { label: (it) => ` ${it.raw} open` };
      chart('distChart', {
        type: 'bar',
        data: { labels: c.labels.map((l) => l[0]), datasets: [{ data: c.labels.map((l) => l[1]), backgroundColor: css('--s-progress'), borderRadius: { topRight: 4, bottomRight: 4 }, borderSkipped: 'left', categoryPercentage: 0.8, barPercentage: 0.85 }] },
        options: o,
      });
    }
  }

  function renderLoad(c) {
    const order = ['blocked', 'progress', 'review', 'todo'];
    const team = c.team.filter((m) => m.open).sort((a, b) => b.open - a.open).slice(0, 10);
    $('#loadLegend').innerHTML = legendHTML(order.map((s) => [STATUS[s].label, css(STATUS[s].color)]));
    const o = baseOpts();
    o.indexAxis = 'y';
    o.interaction = { mode: 'index', axis: 'y', intersect: false };
    o.scales.x = { ...o.scales.y, stacked: true, grid: { color: css('--grid') } };
    o.scales.y = { stacked: true, grid: { display: false }, border: { color: css('--axis') }, ticks: { color: css('--text-2'), font: { size: 11 }, autoSkip: false } };
    o.plugins.tooltip.callbacks = { footer: (it) => `Total open: ${team[it[0].dataIndex].open}` };
    o.plugins.tooltip.filter = (it) => it.raw > 0;
    const surface = css('--surface');
    chart('loadChart', {
      type: 'bar',
      data: {
        labels: team.map((m) => m.login),
        datasets: order.map((s, idx) => ({
          label: STATUS[s].label,
          data: team.map((m) => m[s] || 0),
          backgroundColor: css(STATUS[s].color),
          borderColor: surface, borderWidth: { left: idx ? 2 : 0, right: 0, top: 0, bottom: 0 }, borderSkipped: false,
          borderRadius: idx === order.length - 1 ? { topRight: 4, bottomRight: 4 } : 0,
          categoryPercentage: 0.78, barPercentage: 0.9,
        })),
      },
      options: o,
    });
    state.charts.loadChart.canvas.onclick = (e) => {
      const p = state.charts.loadChart.getElementsAtEventForMode(e, 'index', { intersect: false, axis: 'y' }, false);
      if (p.length) setFocus(team[p[0].index].login);
    };
  }

  function renderFeed(c) {
    const cols = { done: css('--good'), opened: css('--s-opened'), dropped: css('--muted') };
    const verb = { done: 'completed', opened: 'opened', dropped: 'closed (not planned)' };
    const since = Date.now() - 7 * DAY;
    const wk = c.events.filter((e) => e.t >= since);
    $('#feedHint').textContent = `${wk.filter((e) => e.kind === 'done').length} done · ${wk.filter((e) => e.kind === 'opened').length} opened this week`;
    $('#feedList').innerHTML = c.events.length ? c.events.map((e) => `
      <li>
        <span class="f-ico" title="${esc(verb[e.kind])}">${(e.kind === 'done' ? ICONS.done : e.kind === 'opened' ? ICONS.opened : ICONS.todo)(cols[e.kind])}</span>
        <a class="f-text" href="${esc(e.i.url)}" target="_blank" rel="noopener" title="${esc(e.i.title)}"><b>${esc(e.who || 'someone')}</b> ${verb[e.kind]} <span class="n">#${e.i.number}</span> ${esc(e.i.title)}</a>
        <span class="f-when" title="${new Date(e.t).toLocaleString()}">${ago(e.t)}</span>
      </li>`).join('') : '<li class="empty">No activity yet.</li>';
  }

  function hexA(hex, a) {
    const h = hex.replace('#', '');
    const n = parseInt(h.length === 3 ? h.split('').map((x) => x + x).join('') : h, 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
  }

  function renderFocusSelect(c) {
    const sel = $('#focusSel');
    const me = state.data.me;
    const opts = [];
    if (me) opts.push(`<option value="${esc(me)}">Me (@${esc(me)})</option>`);
    for (const m of [...c.team].sort((a, b) => a.login.localeCompare(b.login))) if (m.login !== me) opts.push(`<option value="${esc(m.login)}">@${esc(m.login)}</option>`);
    if (!opts.length) opts.push('<option value="">—</option>');
    sel.innerHTML = opts.join('');
    sel.value = c.who || '';
  }

  function render() {
    if (!state.data) return;
    if (typeof Chart === 'undefined') { toast('Chart library failed to load (check network access to cdn.jsdelivr.net).', true, 8000); }
    const c = compute(state.data, state.weeks, state.focus);
    const d = state.data;
    $('#repoLabel').textContent = d.repos.join(' · ') + ` · ${d.issues.length} issues`;
    $('#demoBadge').hidden = !d.demo;
    $('#settingsLabel').textContent = d.demo ? 'Connect GitHub' : 'Settings';
    $('#updated').textContent = 'Updated ' + new Date(d.fetchedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    $$('#rangeSeg button').forEach((b) => b.setAttribute('aria-pressed', String(+b.dataset.w === state.weeks)));
    $$('[data-tabs]').forEach((g) => $$('button', g).forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.tab === state.tabs[g.dataset.tabs]))));
    renderFocusSelect(c);
    renderKPIs(c);
    renderTeam(c);
    renderMine(c);
    renderMilestones(c);
    renderFeed(c);
    if (typeof Chart !== 'undefined') {
      Chart.defaults.font.family = getComputedStyle(document.body).fontFamily;
      renderFlow(c); renderDist(c); renderLoad(c);
    }
  }

  // ───────────────────────── Data loading ─────────────────────────
  async function refresh(quiet) {
    const cfg = state.cfg;
    if (!cfg.repos) { state.data = window.makeDemoData(); render(); return; }
    $('#refreshBtn').classList.add('spin');
    if (!quiet) loading(true, 'Loading issues…');
    try {
      state.data = await loadGitHub(cfg);
      render();
      if (!quiet) toast(`Loaded ${state.data.issues.length} issues from ${state.data.repos.join(', ')}`);
    } catch (e) {
      toast(e.message || String(e), true, 8000);
      if (!state.data) { state.data = window.makeDemoData(); render(); }
    } finally {
      loading(false);
      $('#refreshBtn').classList.remove('spin');
    }
  }

  function setFocus(login) { state.focus = login === state.data?.me ? null : login; render(); }

  // ───────────────────────── Settings dialog ─────────────────────────
  function openSettings() {
    const f = $('#settingsForm');
    for (const k of Object.keys(DEFAULTS)) if (f.elements[k]) f.elements[k].value = state.cfg[k] ?? DEFAULTS[k];
    $('#settings').showModal();
  }
  function bindSettings() {
    const dlg = $('#settings'), f = $('#settingsForm');
    f.addEventListener('submit', (e) => {
      e.preventDefault();
      const next = { ...state.cfg };
      for (const k of Object.keys(DEFAULTS)) if (f.elements[k]) next[k] = String(f.elements[k].value).trim();
      next.staleDays = Math.max(1, +next.staleDays || 14);
      for (const k of ['reProgress', 'reReview', 'reBlocked']) if (!next[k]) next[k] = DEFAULTS[k];
      state.cfg = next; store.set('cfg', next);
      state.focus = null; state.data = null;
      dlg.close();
      refresh();
      schedule();
    });
    $('#cancelBtn').onclick = () => dlg.close();
    $('#demoBtn').onclick = () => {
      state.cfg = { ...state.cfg, repos: '' }; store.set('cfg', state.cfg);
      state.focus = null; state.data = window.makeDemoData(); dlg.close(); render(); schedule();
    };
    $('#forgetBtn').onclick = () => {
      state.cfg = { ...state.cfg, token: '' }; store.set('cfg', state.cfg);
      f.elements.token.value = ''; toast('Token removed from this browser.');
    };
  }

  function schedule() {
    clearInterval(state.timer);
    if (state.cfg.repos) state.timer = setInterval(() => { if (!document.hidden) refresh(true); }, AUTO_REFRESH_MS);
  }

  // ───────────────────────── Theme ─────────────────────────
  function applyTheme(t) {
    if (t) document.documentElement.setAttribute('data-theme', t); else document.documentElement.removeAttribute('data-theme');
  }
  function toggleTheme() {
    const dark = document.documentElement.getAttribute('data-theme') === 'dark' ||
      (!document.documentElement.getAttribute('data-theme') && matchMedia('(prefers-color-scheme: dark)').matches);
    const t = dark ? 'light' : 'dark';
    store.set('theme', t); applyTheme(t); render();
  }

  // ───────────────────────── Boot ─────────────────────────
  function init() {
    applyTheme(store.get('theme', null));
    // Allow ?repo=owner/name to prefill (never a token in the URL).
    const qp = new URLSearchParams(location.search);
    if (qp.get('repo') && !state.cfg.repos) { state.cfg.repos = qp.get('repo'); }

    $('#rangeSeg').addEventListener('click', (e) => {
      const b = e.target.closest('button'); if (!b) return;
      state.weeks = +b.dataset.w; store.set('weeks', state.weeks); render();
    });
    $$('[data-tabs]').forEach((g) => g.addEventListener('click', (e) => {
      const b = e.target.closest('button'); if (!b) return;
      state.tabs[g.dataset.tabs] = b.dataset.tab; store.set('tabs', state.tabs); render();
    }));
    $('#focusSel').addEventListener('change', (e) => setFocus(e.target.value));
    $('#teamTable').addEventListener('click', (e) => { const tr = e.target.closest('tr[data-login]'); if (tr) setFocus(tr.dataset.login); });
    $('#refreshBtn').onclick = () => refresh();
    $('#themeBtn').onclick = toggleTheme;
    $('#settingsBtn').onclick = openSettings;
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => render());
    document.addEventListener('keydown', (e) => {
      if (e.target.closest('input, select, textarea, dialog')) return;
      if (e.key === 'r' && !e.metaKey && !e.ctrlKey) refresh();
    });
    bindSettings();

    refresh();
    schedule();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
