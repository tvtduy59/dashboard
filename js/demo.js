/* Synthetic, deterministic sample data so the dashboard is useful before a
   GitHub token is configured. Produces the same normalized shape as app.js. */
(function () {
  const DAY = 864e5;

  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  window.makeDemoData = function () {
    const rnd = mulberry32(20260927);
    const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
    const now = Date.now();
    const repo = 'acme/product-tasks';

    // weight = relative share of work picked up
    const members = [
      ['you', 1.2], ['alice-ng', 1.4], ['bao-tran', 1.1], ['carlos-m', 0.9],
      ['diana-k', 1.0], ['eitan-r', 0.7], ['fatima-z', 0.8], ['gwen-o', 0.5],
    ];
    const totalW = members.reduce((s, m) => s + m[1], 0);
    const pickMember = () => {
      let r = rnd() * totalW;
      for (const [m, w] of members) { if ((r -= w) <= 0) return m; }
      return members[0][0];
    };

    const typeLabels = [
      { name: 'bug', color: 'd73a4a' }, { name: 'feature', color: '0e8a16' },
      { name: 'enhancement', color: 'a2eeef' }, { name: 'docs', color: '0075ca' },
      { name: 'tech-debt', color: 'fbca04' },
    ];
    const areaLabels = [
      { name: 'frontend', color: '5319e7' }, { name: 'backend', color: '1d76db' },
      { name: 'infra', color: 'c2e0c6' }, { name: 'mobile', color: 'f9d0c4' },
    ];
    const prioHigh = { name: 'priority: high', color: 'b60205' };
    const lblProgress = { name: 'in progress', color: 'fbca04' };
    const lblReview = { name: 'in review', color: 'c5def5' };
    const lblBlocked = { name: 'blocked', color: '000000' };

    const verbs = ['Add', 'Fix', 'Refactor', 'Improve', 'Migrate', 'Investigate', 'Implement', 'Remove', 'Optimize', 'Document', 'Update', 'Support'];
    const things = ['login flow', 'invoice export', 'dark mode toggle', 'search indexing', 'webhook retries', 'CSV importer',
      'billing page', 'rate limiter', 'onboarding checklist', 'user avatar upload', 'audit log', 'notification settings',
      'report builder', 'SSO with Okta', 'API pagination', 'mobile nav drawer', 'error boundary', 'cache invalidation',
      'feature flags', 'admin dashboard', 'email templates', 'timezone handling', 'permissions matrix', 'data retention job',
      'payment webhooks', 'team invites', 'usage metering', 'PDF generation', 'session timeout', 'accessibility audit'];

    const milestones = [
      { title: 'v1.4 — Onboarding', due: now - 18 * DAY, from: 180, to: 30 },
      { title: 'v1.5 — Billing', due: now + 5 * DAY, from: 75, to: 5 },
      { title: 'v1.6 — Reporting', due: now + 33 * DAY, from: 40, to: 0 },
      { title: 'Q4 Hardening', due: now + 80 * DAY, from: 25, to: 0 },
    ];

    const issues = [];
    const N = 290;
    for (let n = 1; n <= N; n++) {
      // skew toward recent creation, steady inflow
      const ageDays = Math.pow(rnd(), 1.15) * 190;
      const created = now - ageDays * DAY - rnd() * DAY;
      const labels = [pick(typeLabels)];
      if (rnd() < 0.7) labels.push(pick(areaLabels));
      if (rnd() < 0.14) labels.push(prioHigh);

      let assignees = [];
      const r = rnd();
      if (r < 0.84) assignees = [pickMember()];
      else if (r < 0.92) assignees = [pickMember(), pickMember()].filter((v, i, a) => a.indexOf(v) === i);

      // completion likelihood grows with age
      const pClose = Math.min(0.93, 0.08 + ageDays / 34);
      let closed = null, reason = null;
      if (assignees.length && rnd() < pClose) {
        const cycle = (0.4 + -Math.log(1 - rnd()) * (labels[0].name === 'bug' ? 3.5 : 7)) * DAY;
        if (created + cycle < now) { closed = created + cycle; reason = rnd() < 0.04 ? 'not_planned' : 'completed'; }
      } else if (!assignees.length && ageDays > 20 && rnd() < 0.25) {
        closed = created + rnd() * (now - created); reason = 'not_planned';
      }

      if (!closed && assignees.length) {
        const s = rnd();
        if (s < 0.09) labels.push(lblBlocked);
        else if (s < 0.38) labels.push(lblProgress);
        else if (s < 0.50) labels.push(lblReview);
      }

      const ms = milestones.find((m) => ageDays <= m.from && ageDays >= m.to && rnd() < 0.7);
      const updated = closed || Math.min(now, created + rnd() * (now - created) * (rnd() < 0.8 ? 1 : 0.3));

      issues.push({
        repo, number: n,
        title: `${pick(verbs)} ${pick(things)}`,
        url: '#',
        state: closed ? 'closed' : 'open',
        created, closed, updated, reason,
        labels, assignees,
        author: pickMember(),
        milestone: ms ? ms.title : null,
        comments: Math.floor(rnd() * 9),
      });
    }

    // Make "v1.4" nearly done, the others realistic
    const msOut = milestones.map((m) => {
      const its = issues.filter((i) => i.milestone === m.title && i.reason !== 'not_planned');
      return {
        repo, title: m.title, url: '#', due: m.due,
        open: its.filter((i) => i.state === 'open').length,
        closed: its.filter((i) => i.state === 'closed').length,
        state: 'open',
      };
    });

    return { issues, milestones: msOut, avatars: {}, me: 'you', repos: [repo], fetchedAt: now, demo: true };
  };
})();
