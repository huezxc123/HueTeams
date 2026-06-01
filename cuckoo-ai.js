/* ================================================================
   CUCKOO AI MODULE  — cuckoo-ai.js  (v7 — Direct Groq Edition)
   Multi-tenant SaaS safe: AI only ever sees data for the
   currently logged-in company. No cross-company leakage.

   v7 CHANGES vs v6
   ─────────────────────────────────────────────────────────────
   [FIX-v7-01] "Failed to fetch" — removed Cloud Function proxy.
               Calls Groq API directly from the browser.
               Set GROQ_API_KEY below. For production, deploy
               functions/index.js and switch back to proxy mode.
   [FIX-v7-02] companyId fallback no longer reads currentUser.companyId
               (Firebase User objects don't have that property).
   [FIX-v7-03] Race condition — retry loop waits up to 10 s for
               Firebase auth + data to load before erroring.
   [FIX-v7-04] All app globals (companyUsers, currentCompanyId …)
               are now read from window.* so Firebase listener
               updates are always reflected without a page reload.
   [FIX-v7-05] askAIWithHistory() had no companyId guard at all.

   PREVIOUS BUG FIXES (v6)
   ─────────────────────────────────────────────────────────────
   [BUG-01] cuckoo-ai.css was a copy of the old Gemini JS.
   [BUG-02] INSTALL.md referenced Gemini everywhere.
   [BUG-03] Shift lookup always used current month for future days.
   [BUG-04] Single-day leave counted as 0 days.
   [BUG-05] parseInt("") → NaN for attMonth/attYear selectors.
   [BUG-06] Stale "Gemini format" comment in chat history code.
   [BUG-07] Boot log said "11 features" (there are 12).
   [BUG-08] md2html(esc(text)) double-escaped markdown entities.
   [BUG-09] Team summary rebuilt on every chat message for admins.
   [BUG-10] approveLeave patch fired AI confirm even on errors.
   [BUG-11] Anomaly IP-day map key broke on underscore IPs.

   NEW FEATURES (v6)
   ─────────────────────────────────────────────────────────────
   [NEW-01] Loading + error state on payroll export.
   [NEW-02] Confirmation before bulk shift suggestions.
   [NEW-03] Payslip Explainer falls back to window._payslipPrintContent.
   ================================================================ */

(function () {
  'use strict';

  /* ──────────────────────────────────────────────
     0.  CONFIG
     Paste your Groq API key below for development.
     Get one free at https://console.groq.com/keys
     For production, deploy functions/index.js and
     set AI_MODE = 'proxy' + fill AI_PROXY_URL.
  ────────────────────────────────────────────── */
  const AI_MODE      = 'direct';   // 'direct' | 'proxy'
  const GROQ_API_KEY = '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';   // ← paste your key here
  const GROQ_MODEL   = 'llama-3.3-70b-versatile';
  const GROQ_URL     = 'https://api.groq.com/openai/v1/chat/completions';
  const AI_PROXY_URL = 'https://us-central1-cuckoo-3296c.cloudfunctions.net/aiProxy';

  /* ──────────────────────────────────────────────
     1.  MULTI-TENANT SAFETY LAYER
  ────────────────────────────────────────────── */
  const getCompanyID = () => window.currentCompanyId ?? 'unknown';
  const getUID       = () => window.currentUser?.uid ?? null;
  const getUsers     = () => window.companyUsers      ?? {};
  const getAtt       = () => window.companyAttendance ?? {};
  const getLeave     = () => window.companyLeaves     ?? {};
  const getSet       = () => window.companySettings   ?? {};
  const getHols      = () => window.companyHolidays   ?? {};

  function tenantGuard() {
    const cid = getCompanyID();
    return (
      `IMPORTANT SECURITY RULE: You are operating inside a multi-tenant SaaS HR platform. ` +
      `The ONLY company whose data you may discuss is Company ID "${cid}". ` +
      `All data provided below belongs exclusively to this company. ` +
      `Never reference, reveal, or speculate about data from any other company. ` +
      `If asked about other companies or users outside this session, refuse politely.`
    );
  }

  /* ──────────────────────────────────────────────
     2.  HELPERS
  ────────────────────────────────────────────── */
  const MN  = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const DOW = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];

  const peso = n => '₱' + Number(n).toLocaleString('en-PH', { minimumFractionDigits: 2 });

  const esc = s => {
    const d = document.createElement('div');
    d.textContent = String(s ?? '');
    return d.innerHTML;
  };

  /* [BUG-08 FIX] Escape first, then restore markdown patterns safely */
  const md2html = t => esc(t)
    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.*?)\*/g,     '<em>$1</em>')
    .replace(/\n/g,            '<br>');

  /* Wait for window.currentCompanyId to be set by Firebase auth (up to 10 s) */
  async function waitForCompanyId() {
    if (getCompanyID() !== 'unknown') return;
    await new Promise((resolve, reject) => {
      let elapsed = 0;
      const poll = setInterval(() => {
        if (getCompanyID() !== 'unknown') { clearInterval(poll); resolve(); return; }
        elapsed += 500;
        if (elapsed >= 10000) {
          clearInterval(poll);
          reject(new Error('App took too long to load — please refresh the page.'));
        }
      }, 500);
    });
  }

  /* ──────────────────────────────────────────────
     3.  CORE AI CALL
     In 'direct' mode: calls Groq API from the browser.
     In 'proxy' mode:  routes through Firebase Cloud Function.
  ────────────────────────────────────────────── */
  async function callAI(messages) {
    if (AI_MODE === 'proxy') {
      /* ── Proxy path ──────────────────────────────────── */
      const user = firebase.auth().currentUser;
      if (!user) throw new Error('Not authenticated — please refresh and log in again.');
      const idToken   = await user.getIdToken(false);
      const companyId = getCompanyID();

      const res = await fetch(AI_PROXY_URL, {
        method:  'POST',
        headers: {
          'Content-Type':  'application/json',
          'Authorization': `Bearer ${idToken}`,
        },
        body: JSON.stringify({ companyId, messages }),
      });

      if (res.status === 401) throw new Error('Session expired — please refresh and log in again.');
      if (res.status === 403) throw new Error('Access denied — you do not have permission for this company.');
      if (res.status === 429) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error ?? 'Too many requests — please wait a moment and try again.');
      }
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error ?? `Server error ${res.status}`);
      }
      const data = await res.json();
      return data.reply ?? '(No response)';

    } else {
      /* ── Direct Groq path ────────────────────────────── */
      if (!GROQ_API_KEY || GROQ_API_KEY === 'YOUR_GROQ_API_KEY_HERE') {
        throw new Error('Groq API key not set — open cuckoo-ai.js and paste your key into GROQ_API_KEY.');
      }

      const res = await fetch(GROQ_URL, {
        method:  'POST',
        headers: {
          'Content-Type':  'application/json',
          'Authorization': `Bearer ${GROQ_API_KEY}`,
        },
        body: JSON.stringify({
          model:      GROQ_MODEL,
          messages,
          max_tokens: 1024,
          temperature: 0.7,
        }),
      });

      if (res.status === 401) throw new Error('Invalid Groq API key — check your key in cuckoo-ai.js.');
      if (res.status === 429) throw new Error('Groq rate limit reached — please wait a moment and try again.');
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error?.message ?? `Groq error ${res.status}`);
      }
      const data = await res.json();
      return data.choices?.[0]?.message?.content ?? '(No response)';
    }
  }

  /* ──────────────────────────────────────────────
     3a.  askAI — single-turn helper used by most features
  ────────────────────────────────────────────── */
  async function askAI(systemPrompt, userMessage, history = []) {
    await waitForCompanyId();

    const fullSystem = tenantGuard() + '\n\n' + systemPrompt;
    const messages = [
      { role: 'system', content: fullSystem },
      ...history,
      { role: 'user',   content: userMessage },
    ];

    return callAI(messages);
  }

  /* ──────────────────────────────────────────────
     3b.  askAIWithHistory — multi-turn chatbot helper
  ────────────────────────────────────────────── */
  async function askAIWithHistory(systemPrompt, history) {
    await waitForCompanyId();

    const fullSystem = tenantGuard() + '\n\n' + systemPrompt;
    const messages = [
      { role: 'system', content: fullSystem },
      ...history.slice(-14),   // cap at 14 turns to stay within token budget
    ];

    return callAI(messages);
  }

  /* ──────────────────────────────────────────────
     4.  CONTEXT BUILDERS
  ────────────────────────────────────────────── */
  function buildMyProfile() {
    const uid      = getUID();
    const me       = getUsers()[uid] ?? {};
    const now      = new Date();
    const mon      = now.getMonth();
    const thisYear = now.getFullYear();
    const ANNUAL_SL = parseFloat(getSet().annual_sl ?? 5);
    const ANNUAL_VL = parseFloat(getSet().annual_vl ?? 5);

    /* [BUG-04 FIX] Inclusive day count: same-day leave = 1 day */
    function leaveUsed(type) {
      return Object.values(getLeave())
        .filter(lv => lv.empID === uid && lv.type === type && lv.status === 'Approved')
        .reduce((sum, lv) => {
          const s  = new Date(lv.startDate);
          const e  = new Date(lv.endDate);
          const ys = new Date(thisYear, 0, 1);
          const ye = new Date(thisYear, 11, 31);
          const es = s < ys ? ys : s;
          const ee = e > ye ? ye : e;
          if (es > ee) return sum;
          return sum + Math.floor((ee - es) / 86400000) + 1;
        }, 0);
    }

    const slUsed = leaveUsed('SL');
    const vlUsed = leaveUsed('VL');

    /* [BUG-03 FIX] Use each day's own month for shift lookup */
    const shifts = {};
    for (let i = 0; i < 7; i++) {
      const d = new Date(now);
      d.setDate(d.getDate() + i);
      const dayMon = d.getMonth();
      shifts[DOW[d.getDay()]] = me['shift_' + dayMon] ?? me.defaultShift ?? '(not set)';
    }

    const myDept   = me.dept ?? '';
    const teamLead = Object.values(getUsers()).find(u =>
      u.dept === myDept && ['Admin','HR','Team Lead'].includes(u.role) && u.email !== window.currentUser?.email
    );

    return {
      name:           me.fullName ?? 'Unknown',
      empID:          me.empID ?? uid,
      dept:           me.dept ?? '—',
      role:           me.role ?? 'Employee',
      shift:          me['shift_' + mon] ?? me.defaultShift ?? '—',
      salary:         me.monthlySalary ?? 0,
      teamLead:       teamLead?.fullName ?? 'Not assigned',
      slLeft:         Math.max(0, ANNUAL_SL - slUsed),
      vlLeft:         Math.max(0, ANNUAL_VL - vlUsed),
      slUsed, vlUsed,
      nextWeekShifts: shifts,
    };
  }

  function buildAttSummary(uid, mon, year) {
    uid  = uid  ?? getUID();
    mon  = mon  ?? new Date().getMonth();
    year = year ?? new Date().getFullYear();
    const att = getAtt()[uid] ?? {};
    const dim = new Date(year, mon + 1, 0).getDate();
    let present = 0, absent = 0, sl = 0, vl = 0, late = 0, lateMin = 0;
    for (let d = 1; d <= dim; d++) {
      const k  = `${mon}_${d}`;
      const st = att[k] ?? '';
      if      (st === 'P')  present++;
      else if (st === 'A')  absent++;
      else if (st === 'SL') sl++;
      else if (st === 'VL') vl++;
      const lm = parseInt(att[k + '_late'] ?? 0, 10) || 0;
      lateMin += lm;
      if (lm > 0) late++;
    }
    return { present, absent, sl, vl, late, lateMin };
  }

  /* [BUG-09 FIX] Cache team summary so admin chat doesn't recompute every message */
  let _teamSummaryCache    = null;
  let _teamSummaryCacheKey = '';
  function buildTeamAttSummary(mon, year) {
    mon  = mon  ?? new Date().getMonth();
    year = year ?? new Date().getFullYear();
    const key = `${mon}_${year}`;
    if (_teamSummaryCache && _teamSummaryCacheKey === key) return _teamSummaryCache;
    _teamSummaryCacheKey = key;
    _teamSummaryCache = Object.entries(getUsers())
      .filter(([, u]) => !u.disabled)
      .map(([uid, u]) => ({
        name: u.fullName, empID: u.empID ?? uid, dept: u.dept,
        ...buildAttSummary(uid, mon, year),
      }))
      .sort((a, b) => b.lateMin - a.lateMin);
    return _teamSummaryCache;
  }
  function invalidateTeamCache() { _teamSummaryCache = null; }

  function buildLeaveContext(uid) {
    uid = uid ?? getUID();
    return Object.values(getLeave())
      .filter(lv => lv.empID === uid)
      .map(lv => ({ type: lv.type, start: lv.startDate, end: lv.endDate, status: lv.status, reason: lv.reason }));
  }

  function buildPayrollContext(uid, mon, year, from, to) {
    if (typeof window.calcPayroll === 'function') {
      try {
        return window.calcPayroll(uid, mon, year, from ?? 1, to ?? new Date(year, mon + 1, 0).getDate());
      } catch (_) { /* fall through */ }
    }
    /* [NEW-03] Fallback: use raw payslip content if available */
    if (window._payslipPrintContent) {
      return { _raw: window._payslipPrintContent };
    }
    return null;
  }

  function buildScheduleContext(uid) {
    uid       = uid ?? getUID();
    const me  = getUsers()[uid] ?? {};
    const now = new Date();
    const result = [];
    for (let i = 0; i < 14; i++) {
      const d = new Date(now);
      d.setDate(d.getDate() + i);
      result.push({
        date:  d.toLocaleDateString('en-PH', { weekday: 'long', month: 'short', day: 'numeric' }),
        shift: me['shift_' + d.getMonth()] ?? me.defaultShift ?? '(not set)',
      });
    }
    return result;
  }

  function detectAnomalies() {
    const alerts = [];
    const now    = new Date();
    const mon    = now.getMonth();
    const year   = now.getFullYear();
    const dim    = new Date(year, mon + 1, 0).getDate();

    /* [BUG-11 FIX] Use '|' separator to avoid collision with underscore IPs */
    const ipDayMap = {};
    Object.entries(getAtt()).forEach(([uid, att]) => {
      for (let d = 1; d <= dim; d++) {
        const k    = `${mon}_${d}`;
        const ip   = att[k + '_ip'];
        const time = att[k + '_time'];
        if (!ip || !time) continue;
        const key = `${d}|${ip}`;
        if (!ipDayMap[key]) ipDayMap[key] = [];
        ipDayMap[key].push({ uid, time });
      }
    });

    Object.entries(ipDayMap).forEach(([key, entries]) => {
      const uids = [...new Set(entries.map(e => e.uid))];
      if (uids.length < 2) return;
      const names  = uids.map(u => getUsers()[u]?.fullName ?? u).join(' & ');
      const dayNum = key.split('|')[0];
      alerts.push({
        type: 'buddy_punch', severity: 'high',
        msg:  `⚠️ Possible buddy punch: ${names} clocked in from the same IP on day ${dayNum}.`,
      });
    });

    Object.entries(getAtt()).forEach(([uid, att]) => {
      const u     = getUsers()[uid] ?? {};
      const shift = (u['shift_' + now.getMonth()] ?? u.defaultShift ?? '').toLowerCase();
      if (shift.includes('night') || shift.includes('graveyard')) return;
      for (let d = 1; d <= dim; d++) {
        const time = att[`${mon}_${d}_time`];
        if (!time) continue;
        const h = new Date(time).getHours();
        if (h >= 0 && h < 4) {
          alerts.push({
            type: 'unusual_hours', severity: 'medium',
            msg:  `🌙 ${u.fullName} clocked in at ${new Date(time).toLocaleTimeString()} on day ${d} — unusual for a day-shift employee.`,
          });
        }
      }
    });

    const holDates = new Set(
      Object.values(getHols())
        .filter(h => h?.date)
        .map(h => {
          const d = new Date(h.date + 'T00:00:00');
          return (d.getMonth() === mon && d.getFullYear() === year) ? d.getDate() : null;
        })
        .filter(Boolean)
    );

    holDates.forEach(holDay => {
      const prev = holDay - 1;
      if (prev < 1) return;
      Object.entries(getAtt()).forEach(([uid, att]) => {
        if (att[`${mon}_${prev}`] === 'A') {
          const u = getUsers()[uid] ?? {};
          alerts.push({
            type: 'pre_holiday_absence', severity: 'low',
            msg:  `📅 ${u.fullName} was absent on day ${prev} (day before holiday on day ${holDay}).`,
          });
        }
      });
    });

    return alerts;
  }

  /* ──────────────────────────────────────────────
     5.  SYSTEM PROMPT FOR CHATBOT
  ────────────────────────────────────────────── */
  function buildChatSystemPrompt() {
    const profile  = buildMyProfile();
    const attSumm  = buildAttSummary();
    const leaves   = buildLeaveContext();
    const schedule = buildScheduleContext();
    const policy   = getSet().companyPolicy ?? '';
    const isAdminUser = (getUsers()[getUID()] ?? {}).role === 'Admin';

    let teamSummary = '';
    if (isAdminUser) {
      const team = buildTeamAttSummary();
      teamSummary = `\n\nTEAM ATTENDANCE THIS MONTH:\n${JSON.stringify(team.slice(0, 20), null, 2)}`;
    }

    return `You are Cuckoo AI, the smart HR assistant for a Philippine business.
Talking to: ${profile.name} (${profile.role}, ${profile.dept} dept).

EMPLOYEE PROFILE: ${JSON.stringify(profile, null, 2)}
ATTENDANCE THIS MONTH: ${JSON.stringify(attSumm, null, 2)}
LEAVE HISTORY: ${JSON.stringify(leaves, null, 2)}
SCHEDULE (next 14 days): ${schedule.map(s => `${s.date}: ${s.shift}`).join(', ')}
${teamSummary}
${policy ? 'COMPANY POLICY:\n' + policy : ''}

RULES:
- Answer using the data above ONLY. Do not invent numbers.
- Be concise, warm, and professional.
- Answer in the same language the user writes (Filipino or English).
- Reference DOLE, Labor Code, SSS, PhilHealth, Pag-IBIG for PH law questions.
- NEVER discuss or reveal data about any employee or company outside this session.`;
  }

  /* ──────────────────────────────────────────────
     6.  CHATBOT UI  (FEATURE 1)
  ────────────────────────────────────────────── */
  let aiChatHistory = [];

  function initChatbot() {
    if (document.getElementById('aiChatPanel')) return;

    const panel   = document.createElement('div');
    panel.id      = 'aiChatPanel';
    panel.innerHTML = `
      <div id="aiChatHeader">
        <div style="display:flex;align-items:center;gap:10px;">
          <span style="font-size:1.3rem;">🤖</span>
          <div>
            <div style="font-weight:700;font-size:.95rem;">Cuckoo AI Assistant</div>
            <div style="font-size:.7rem;opacity:.75;">Powered by Groq · HR &amp; Payroll Expert</div>
          </div>
        </div>
        <button onclick="window._aiToggle()" style="background:rgba(255,255,255,.18);border:none;color:#fff;width:28px;height:28px;border-radius:8px;cursor:pointer;font-size:1rem;flex-shrink:0;">✕</button>
      </div>
      <div id="aiChatMessages">
        <div class="ai-msg ai-msg-bot">👋 Hi! I'm your Cuckoo HR Assistant. Ask me anything — shifts, leaves, payslip, labor law, or anything HR-related!</div>
      </div>
      <div id="aiChatInput">
        <input type="text" id="aiUserInput" placeholder="Ask about payroll, leaves, shifts…" />
        <button onclick="window._aiSend()" id="aiSendBtn"><i class="fa-solid fa-paper-plane"></i></button>
      </div>`;

    const fab     = document.createElement('button');
    fab.id        = 'aiFloatBtn';
    fab.innerHTML = '🤖';
    fab.title     = 'Cuckoo AI Assistant';
    fab.onclick   = () => window._aiToggle();

    document.body.appendChild(panel);
    document.body.appendChild(fab);
    document.getElementById('aiUserInput').addEventListener('keydown', e => {
      if (e.key === 'Enter') window._aiSend();
    });
  }

  window._aiToggle = function () {
    const panel = document.getElementById('aiChatPanel');
    if (!panel) return;
    panel.classList.toggle('open');
    if (panel.classList.contains('open')) document.getElementById('aiUserInput')?.focus();
  };

  window._aiSend = async function () {
    const input   = document.getElementById('aiUserInput');
    const sendBtn = document.getElementById('aiSendBtn');
    const msgs    = document.getElementById('aiChatMessages');
    const text    = input.value.trim();
    if (!text) return;

    appendMsg(msgs, text, 'user');
    input.value      = '';
    sendBtn.disabled = true;

    const typer     = document.createElement('div');
    typer.className = 'ai-msg ai-msg-bot ai-msg-typing';
    typer.id        = 'aiTyping';
    typer.textContent = 'Thinking…';
    msgs.appendChild(typer);
    msgs.scrollTop = msgs.scrollHeight;

    aiChatHistory.push({ role: 'user', content: text });

    try {
      const reply = await askAIWithHistory(
        buildChatSystemPrompt(),
        aiChatHistory.slice(-12),
      );
      aiChatHistory.push({ role: 'assistant', content: reply });
      document.getElementById('aiTyping')?.remove();
      appendMsg(msgs, reply, 'bot');
    } catch (err) {
      document.getElementById('aiTyping')?.remove();
      appendMsg(msgs, '⚠️ Error: ' + err.message, 'bot');
    }

    sendBtn.disabled = false;
    msgs.scrollTop   = msgs.scrollHeight;
  };

  function appendMsg(container, text, type) {
    const div     = document.createElement('div');
    div.className = `ai-msg ai-msg-${type}`;
    div.innerHTML = md2html(text);
    container.appendChild(div);
    container.scrollTop = container.scrollHeight;
  }

  /* ──────────────────────────────────────────────
     7.  MODAL HELPERS
  ────────────────────────────────────────────── */
  function createAIModal(title, loadingMsg) {
    const overlay     = document.createElement('div');
    overlay.className = 'ai-modal-overlay';
    overlay.innerHTML = `
      <div class="ai-modal-box">
        <div class="ai-modal-header">
          <span>${esc(title)}</span>
          <button class="ai-modal-close" onclick="this.closest('.ai-modal-overlay').remove()">✕</button>
        </div>
        <div class="ai-modal-body">
          <div class="ai-modal-loading">${esc(loadingMsg)}</div>
        </div>
      </div>`;
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
    document.body.appendChild(overlay);
    return overlay;
  }

  function setAIModalContent(modal, text) {
    const body = modal.querySelector('.ai-modal-body');
    if (!body) return;
    body.innerHTML = `<div class="ai-modal-content">${md2html(text)}</div>`;
  }

  function addModalChat(modal, systemPrompt) {
    const body    = modal.querySelector('.ai-modal-body');
    const history = [];

    const chatArea     = document.createElement('div');
    chatArea.className = 'ai-modal-chat';
    chatArea.innerHTML = `
      <div class="ai-modal-messages"></div>
      <div class="ai-modal-input-row">
        <input type="text" class="ai-modal-input" placeholder="Type your question…" />
        <button class="ai-modal-send-btn">Send</button>
      </div>`;
    body.appendChild(chatArea);

    const input   = chatArea.querySelector('.ai-modal-input');
    const sendBtn = chatArea.querySelector('.ai-modal-send-btn');
    const msgs    = chatArea.querySelector('.ai-modal-messages');

    async function send() {
      const text = input.value.trim();
      if (!text) return;
      appendMsg(msgs, text, 'user');
      input.value      = '';
      sendBtn.disabled = true;

      const typer     = document.createElement('div');
      typer.className = 'ai-msg ai-msg-bot ai-msg-typing';
      typer.id        = 'modalTyping_' + Date.now();
      typer.textContent = 'Thinking…';
      msgs.appendChild(typer);
      msgs.scrollTop  = msgs.scrollHeight;

      history.push({ role: 'user', content: text });
      try {
        const reply = await askAIWithHistory(systemPrompt, history.slice(-8));
        history.push({ role: 'assistant', content: reply });
        typer.remove();
        appendMsg(msgs, reply, 'bot');
      } catch (err) {
        typer.remove();
        appendMsg(msgs, '⚠️ ' + err.message, 'bot');
      }
      sendBtn.disabled = false;
      msgs.scrollTop   = msgs.scrollHeight;
    }

    sendBtn.addEventListener('click', send);
    input.addEventListener('keydown', e => { if (e.key === 'Enter') send(); });
  }

  /* ──────────────────────────────────────────────
     8.  FEATURES 2–12
  ────────────────────────────────────────────── */

  /* FEATURE 2 — Payslip Explainer */
  window.aiExplainPayslip = async function (uid, mon, year, from, to) {
    const u = getUsers()[uid] ?? {};
    const p = buildPayrollContext(uid, mon, year, from, to);

    if (!p) { alert('Payroll data not available for this payslip.'); return; }

    const modal = createAIModal('💡 Payslip Explainer', '📊 Analyzing your payslip…');

    const payslipDetail = p._raw
      ? `RAW PAYSLIP DATA:\n${p._raw}`
      : `Monthly Salary: ${peso(p.monthlySalary)} | Days Present: ${p.present} | Absences: ${p.absent} | Late: ${p.lateMin} min
EARNINGS: ${(p.earningsBreakdown ?? []).map(e => `${e.label}: ${peso(e.amount)}`).join(' | ')}
GROSS: ${peso(p.grossPay)}
DEDUCTIONS: ${(p.deductionsBreakdown ?? []).map(d => `${d.label}: ${peso(d.amount)}`).join(' | ')}
TOTAL DEDUCTIONS: ${peso(p.totalDeductions)}
NET PAY: ${peso(p.netPay)}`;

    const userMsg = `Explain this payslip to the employee in simple, plain Filipino/English. Break down each item clearly. Note what to do if they spot an error.

EMPLOYEE: ${u.fullName} (${u.dept})
PERIOD: ${MN[mon]} ${from}–${to}, ${year}
${payslipDetail}`;

    try {
      const reply = await askAI('You are a friendly Philippine HR payroll assistant.', userMsg);
      setAIModalContent(modal, reply);
    } catch (err) { setAIModalContent(modal, '⚠️ ' + err.message); }
  };

  /* FEATURE 3 — Attendance Summarizer */
  window.aiSummarizeAttendance = async function (mon, year) {
    mon  = mon  ?? new Date().getMonth();
    year = year ?? new Date().getFullYear();
    const modal = createAIModal('📊 Attendance Summary — ' + MN[mon] + ' ' + year, '🔍 Analyzing attendance data…');
    const team  = buildTeamAttSummary(mon, year);
    try {
      const reply = await askAI(
        'You are an HR analytics expert for a Philippine company.',
        `Analyze this attendance data and write a concise report (under 300 words). Highlight most lates, perfect attendance, highest absences, notable trends.\n\nMONTH: ${MN[mon]} ${year}\nDATA:\n${JSON.stringify(team, null, 2)}`
      );
      setAIModalContent(modal, reply);
    } catch (err) { setAIModalContent(modal, '⚠️ ' + err.message); }
  };

  /* FEATURE 4 — Leave Balance */
  window.aiCheckLeaveBalance = async function () {
    const modal   = createAIModal('🏖 Leave Balance', '🔍 Checking your leave balances…');
    const profile = buildMyProfile();
    const leaves  = buildLeaveContext();
    try {
      const reply = await askAI(
        'You are a friendly HR assistant for a Philippine company.',
        `Summarize the leave balance for this employee clearly. Show SL and VL remaining, list approved/pending leaves.\nPROFILE: ${JSON.stringify(profile)}\nLEAVES: ${JSON.stringify(leaves)}`
      );
      setAIModalContent(modal, reply);
    } catch (err) { setAIModalContent(modal, '⚠️ ' + err.message); }
  };

  /* FEATURE 5 — Policy Q&A */
  window.aiPolicyQA = async function (question) {
    if (!question) { question = prompt('What policy question do you have?'); if (!question) return; }
    const modal  = createAIModal('📋 Policy Q&A', '🔍 Looking up your company policy…');
    const policy = getSet().companyPolicy ?? '';
    const sys    = policy
      ? `Answer using ONLY this company policy. If not covered, say so and suggest contacting HR.\n\nPOLICY:\n${policy}`
      : `You are an HR assistant. Answer Philippine labor law and DOLE policy questions. Recommend consulting HR for company-specific matters.`;
    try {
      const reply = await askAI(sys, question);
      setAIModalContent(modal, reply);
    } catch (err) { setAIModalContent(modal, '⚠️ ' + err.message); }
  };

  /* FEATURE 6 — Anomaly Detection */
  window.aiRunAnomalyDetection = async function () {
    const modal  = createAIModal('🚨 Anomaly Detection', '🔍 Scanning attendance for irregularities…');
    const alerts = detectAnomalies();
    if (!alerts.length) {
      setAIModalContent(modal, '✅ No anomalies detected this month. Everything looks normal!');
      return;
    }
    try {
      const reply = await askAI(
        'You are an HR security and compliance analyst.',
        `Review these anomalies and give a professional summary with recommended actions.\n\n${alerts.map(a => `[${a.severity.toUpperCase()}] ${a.msg}`).join('\n')}`
      );
      setAIModalContent(modal, `Found ${alerts.length} issue(s):\n\n` + reply);
    } catch (err) {
      /* Graceful degradation — show raw alerts if AI call fails */
      setAIModalContent(modal, alerts.map(a => a.msg).join('\n\n'));
    }
  };

  /* FEATURE 7 — Smart Shift Suggestions */
  window.aiSuggestShifts = async function (request) {
    if (!request) {
      request = prompt('Describe what you need (e.g. "Balance workload for next week, fill 3 night shifts"):');
      if (!request) return;
    }

    const empCount = Object.values(getUsers()).filter(u => !u.disabled).length;
    const confirmed = confirm(
      `⚠️ Bulk Schedule Operation\n\nThis will generate AI-suggested shifts for ${empCount} active employee(s).\n\nShifts shown are SUGGESTIONS only — no changes will be saved until you apply them manually.\n\nContinue?`
    );
    if (!confirmed) return;

    const modal = createAIModal('🗓 Smart Shift Suggestions', '🤔 Analyzing team for optimal scheduling…');
    const emps  = Object.entries(getUsers())
      .filter(([, u]) => !u.disabled)
      .map(([uid, u]) => ({
        name:         u.fullName,
        dept:         u.dept,
        role:         u.role,
        currentShift: u['shift_' + new Date().getMonth()] ?? u.defaultShift ?? 'Not set',
      }));
    try {
      const reply = await askAI(
        'You are an expert HR scheduling manager for a Philippine company.',
        `Suggest an optimal shift schedule for next week based on this request.\n\nREQUEST: "${request}"\n\nROSTER:\n${JSON.stringify(emps, null, 2)}\n\nATTENDANCE TREND:\n${JSON.stringify(buildTeamAttSummary().slice(0, 15), null, 2)}`
      );
      setAIModalContent(modal, reply);
    } catch (err) { setAIModalContent(modal, '⚠️ ' + err.message); }
  };

  /* FEATURE 8 — Leave Approval Draft */
  window.aiDraftLeaveApproval = async function (leaveId, action) {
    action      = action ?? 'Approved';
    const lv    = getLeave()[leaveId] ?? {};
    const emp   = getUsers()[lv.empID] ?? {};
    const modal = createAIModal('✉️ Draft Leave Message', '✍️ Drafting a personalised response…');
    try {
      const reply = await askAI(
        'You are a friendly HR manager at a Philippine company.',
        `Write a short warm ${action.toLowerCase()} message (under 60 words) from a manager to ${emp.fullName} for their ${lv.type} leave (${lv.startDate} to ${lv.endDate}). Reason: ${lv.reason ?? 'not given'}.`
      );
      setAIModalContent(modal, reply);
    } catch (err) { setAIModalContent(modal, '⚠️ ' + err.message); }
  };

  /* FEATURE 9 — Performance Insights */
  window.aiPerformanceQuery = async function (question) {
    if (!question) {
      question = prompt('Ask a performance question (e.g. "Who has the best attendance this month?"):');
      if (!question) return;
    }
    const modal = createAIModal('📈 Performance Insights', '🔍 Analyzing team performance…');
    const team  = buildTeamAttSummary();
    try {
      const reply = await askAI(
        'You are an HR analytics expert for a Philippine company.',
        `Answer this query using only the data provided. Be specific with names and numbers.\n\nQUERY: "${question}"\n\nDATA:\n${JSON.stringify(team, null, 2)}`
      );
      setAIModalContent(modal, reply);
    } catch (err) { setAIModalContent(modal, '⚠️ ' + err.message); }
  };

  /* FEATURE 10 — Onboarding Buddy */
  window.aiOnboardingBuddy = async function () {
    const profile    = buildMyProfile();
    const onboarding = getSet().onboardingInfo ?? '';
    const modal      = createAIModal('🎉 Onboarding Buddy', '👋 Preparing your welcome guide…');
    const sys        = `You are a friendly onboarding buddy at a Philippine company. Help new employees get started warmly.${
      onboarding
        ? '\n\nCOMPANY ONBOARDING INFO:\n' + onboarding
        : '\nProvide general Philippine employment onboarding guidance (BIR 2316, SSS, PhilHealth, Pag-IBIG registration, etc.)'
    }`;
    setAIModalContent(modal, `Hello ${esc(profile.name)}! 👋 Welcome aboard! What would you like to know — documents to submit, your schedule, company policies, or anything else?`);
    addModalChat(modal, sys);
  };

  /* FEATURE 11 — Payroll Forecast */
  window.aiPayrollForecast = async function () {
    const profile = buildMyProfile();
    const modal   = createAIModal('🔮 Payroll Forecast', '🧮 Ready to simulate your payroll…');
    const sys     = `You are a Philippine HR payroll calculator. Simulate estimated net pay given different scenarios. Show step-by-step calculation.

EMPLOYEE: ${JSON.stringify(profile)}
SETTINGS: Working days=${getSet().pr_workingDays ?? 26}, SSS rate=${getSet().pr_sssEmployeePct ?? '4.5%'}, PhilHealth=${getSet().pr_phPct ?? '2.5%'}, Pag-IBIG=${getSet().pr_pagibigPct ?? '2%'}`;
    setAIModalContent(modal, `Hello ${esc(profile.name)}! Ask me payroll scenarios like:\n• "What if I take 2 SL days next month?"\n• "How much if I'm absent 1 day?"\n• "Estimate my pay with overtime."`);
    addModalChat(modal, sys);
  };

  /* FEATURE 12 — Announcement Generator */
  window.aiGenerateAnnouncement = async function () {
    const keywords = prompt('Enter keywords for your announcement (e.g. "Team lunch Friday, dress casual, Pizza 12pm"):');
    if (!keywords) return;
    const modal   = createAIModal('📢 Announcement Generator', '✍️ Drafting your announcement…');
    const company = getSet().companyName ?? 'the company';
    try {
      const reply = await askAI(
        'You are an HR communications specialist for a Philippine company.',
        `Write a professional, engaging company announcement for ${esc(company)} based on these keywords. Include an emoji-rich subject line and friendly body under 150 words.\n\nKEYWORDS: "${keywords}"`
      );
      setAIModalContent(modal, reply);
    } catch (err) { setAIModalContent(modal, '⚠️ ' + err.message); }
  };

  /* ──────────────────────────────────────────────
     9.  PAGE INJECTORS
  ────────────────────────────────────────────── */
  function injectDashboardAI() {
    const dash = document.getElementById('page-dashboard');
    if (!dash || !dash.classList.contains('active') || dash.querySelector('.ai-dash-panel')) return;
    const isAdminUser = (getUsers()[getUID()] ?? {}).role === 'Admin';
    const panel       = document.createElement('div');
    panel.className   = 'card ai-dash-panel';
    panel.style.marginTop = '16px';
    panel.innerHTML   = `
      <div class="card-header"><div class="card-title">🤖 AI Quick Actions</div></div>
      <div class="ai-quick-actions">
        <button class="btn btn-ghost ai-qa-btn" onclick="window.aiCheckLeaveBalance()">🏖 My Leave Balance</button>
        <button class="btn btn-ghost ai-qa-btn" onclick="window.aiPayrollForecast()">🔮 Payroll Forecast</button>
        <button class="btn btn-ghost ai-qa-btn" onclick="window.aiOnboardingBuddy()">🎉 Onboarding Guide</button>
        <button class="btn btn-ghost ai-qa-btn" onclick="window.aiPolicyQA()">📋 Policy Q&amp;A</button>
        ${isAdminUser ? `
        <button class="btn btn-ghost ai-qa-btn" onclick="window.aiSummarizeAttendance()">📊 Attendance Report</button>
        <button class="btn btn-ghost ai-qa-btn" onclick="window.aiRunAnomalyDetection()">🚨 Anomaly Scan</button>
        <button class="btn btn-ghost ai-qa-btn" onclick="window.aiPerformanceQuery()">📈 Performance Query</button>
        <button class="btn btn-ghost ai-qa-btn" onclick="window.aiSuggestShifts()">🗓 Suggest Shifts</button>
        <button class="btn btn-ghost ai-qa-btn" onclick="window.aiGenerateAnnouncement()">📢 Make Announcement</button>
        ` : ''}
      </div>`;
    dash.appendChild(panel);
  }

  function injectAttendanceAIBtn() {
    const toolbar = document.querySelector('#page-attendance .toolbar');
    if (!toolbar || toolbar.querySelector('.ai-att-btn')) return;

    const btn     = document.createElement('button');
    btn.className = 'btn btn-ghost ai-att-btn';
    btn.innerHTML = '🤖 AI Summary';
    btn.onclick   = () => {
      /* [BUG-05 FIX] parseInt("") → NaN; use explicit fallback */
      const rawMon  = document.getElementById('attMonth')?.value;
      const rawYear = document.getElementById('attYear')?.value;
      const mon  = rawMon  !== '' && rawMon  != null ? parseInt(rawMon,  10) : new Date().getMonth();
      const year = rawYear !== '' && rawYear != null ? parseInt(rawYear, 10) : new Date().getFullYear();
      window.aiSummarizeAttendance(mon, year);
    };
    toolbar.appendChild(btn);

    const anomBtn     = document.createElement('button');
    anomBtn.className = 'btn btn-ghost ai-att-btn';
    anomBtn.innerHTML = '🚨 Anomaly Scan';
    anomBtn.onclick   = () => window.aiRunAnomalyDetection();
    toolbar.appendChild(anomBtn);
  }

  function injectLeavesAIBtn() {
    const headers = document.querySelectorAll('#page-leaves .card-header');
    if (!headers.length || document.querySelector('#page-leaves .ai-leave-btn')) return;
    const btn     = document.createElement('button');
    btn.className = 'btn btn-ghost ai-leave-btn';
    btn.innerHTML = '🤖 My Balance';
    btn.onclick   = () => window.aiCheckLeaveBalance();
    headers[0].appendChild(btn);
  }

  function injectPayslipExplainBtn(uid, mon, year, dateFrom, dateTo) {
    setTimeout(() => {
      const box = document.querySelector('#payslipOverlay .payslip-box > div:last-child');
      if (box && !box.querySelector('.ai-explain-btn')) {
        const btn     = document.createElement('button');
        btn.className = 'btn btn-ghost ai-explain-btn';
        btn.innerHTML = '🤖 Explain';
        btn.onclick   = () => window.aiExplainPayslip(uid, mon, year, dateFrom, dateTo);
        box.appendChild(btn);
      }
    }, 150);
  }

  /* ──────────────────────────────────────────────
     10.  PATCH APP FUNCTIONS
  ────────────────────────────────────────────── */
  setTimeout(() => {
    /* Patch showPayslip → inject Explain button */
    const _origShowPayslip = window.showPayslip;
    if (typeof _origShowPayslip === 'function') {
      window.showPayslip = function (uid, mon, year, dateFrom, dateTo) {
        _origShowPayslip(uid, mon, year, dateFrom, dateTo);
        injectPayslipExplainBtn(uid, mon, year, dateFrom, dateTo);
      };
    }

    /* Patch approveLeave → offer AI draft after approval
       [BUG-10 FIX] Wrapped in try/catch so errors don't surface the confirm */
    const _origApproveLeave = window.approveLeave;
    if (typeof _origApproveLeave === 'function') {
      window.approveLeave = async function (lid) {
        try {
          await _origApproveLeave(lid);
          setTimeout(() => {
            if (confirm('✉️ Would you like AI to draft a personalised approval message?')) {
              window.aiDraftLeaveApproval(lid, 'Approved');
            }
          }, 400);
        } catch (err) {
          console.error('[CuckooAI] approveLeave error:', err);
          throw err;
        }
      };
    }

    /* Patch renderCurrentPage → re-inject AI buttons on every page switch */
    const _origRender = window.renderCurrentPage;
    if (typeof _origRender === 'function') {
      window.renderCurrentPage = function () {
        invalidateTeamCache();
        _origRender();
        setTimeout(() => {
          injectDashboardAI();
          injectAttendanceAIBtn();
          injectLeavesAIBtn();
        }, 250);
      };
    }

    /* [NEW-01] Patch exportPayroll → add loading + error state */
    const _origExportPayroll = window.exportPayroll;
    if (typeof _origExportPayroll === 'function') {
      window.exportPayroll = async function (...args) {
        let indicator = document.getElementById('aiPayrollExportStatus');
        if (!indicator) {
          indicator    = document.createElement('span');
          indicator.id = 'aiPayrollExportStatus';
          indicator.style.cssText = 'margin-left:10px;font-size:.85rem;color:var(--text-muted,#666);';
          const exportBtn = document.querySelector('[onclick*="exportPayroll"], [onclick*="payroll-export"]');
          exportBtn?.after(indicator);
        }
        indicator.textContent = '⏳ Exporting…';
        try {
          await _origExportPayroll(...args);
          indicator.textContent = '✅ Exported!';
          setTimeout(() => { indicator.textContent = ''; }, 3000);
        } catch (err) {
          indicator.textContent = '❌ Export failed — ' + err.message;
          console.error('[CuckooAI] exportPayroll error:', err);
          setTimeout(() => { indicator.textContent = ''; }, 6000);
        }
      };
    }
  }, 0);

  /* ──────────────────────────────────────────────
     11.  BOOT
  ────────────────────────────────────────────── */
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initChatbot);
  } else {
    initChatbot();
  }

  console.log('🤖 Cuckoo AI v7 (Direct Groq) loaded — 12 features active.');
})();