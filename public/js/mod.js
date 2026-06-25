// public/js/mod.js
// Talkomatic moderation dashboard. Connects with the dev/mod key from
// localStorage (the server validates by hash), then drives a tabbed UI:
//   Activity  live, permanent audit feed of staff actions + identity events
//   Ban list  active IP blocks with a live countdown and one-tap unban (dev)
//   Moderators active mod keys with instant revoke + grant (dev)
// Everything rendered with textContent, so it is XSS-safe. The feed batches
// live entries and caps how many cards live in the DOM, so a sudden spike in
// sign-ins cannot thrash the page.

(function () {
  const socket = io({
    auth: {
      devKey: localStorage.getItem("talkomatic_devKey") || undefined,
      modKey: localStorage.getItem("talkomatic_modKey") || undefined,
      // The dashboard is a separate read-only board, exempt from the
      // one-active-tab rule so it can stay open beside a room.
      app: "modlog",
    },
  });

  const $ = (id) => document.getElementById(id);
  const loadingEl = $("loading");
  const deniedEl = $("denied");
  const appEl = $("app");
  const listEl = $("list");
  const searchEl = $("search");
  const meEl = $("meInfo");
  const rosterEl = $("roster");
  const focusBar = $("focusBar");
  const feedNote = $("feedNote");

  // ── State ──
  let entries = []; // oldest first (actions + identity + comments)
  const commentsByRef = new Map(); // parentId -> [comment]
  let me = null;
  let authorized = false;
  let tab = "activity";
  let feedFilter = "all";
  let query = "";
  let focusUid = null;
  let unreadNotifs = 0;
  let applicationsList = [];
  let reportsList = [];
  let invitesList = []; // flagged inviters (Invites tab)
  let invitesPage = 0;
  const INV_PAGE = 12;
  const inviteDetails = new Map(); // deviceId -> last forensic detail

  const DOM_CAP = 250; // max activity cards kept in the DOM at once
  let pendingNew = []; // live entries waiting for the next batched flush
  let flushTimer = null;

  // ── Categories ──
  const CAT = {
    security: {
      color: "#ff5468",
      icon: "fa-user-secret",
      label:
        "Security: a staff key used from a new IP, or from several IPs at once",
    },
    destructive: {
      color: "#ff5468",
      icon: "fa-triangle-exclamation",
      label: "Destructive: kick, ban, IP block, close, nuke, freeze, wipe",
    },
    moderation: {
      color: "#ffb454",
      icon: "fa-gavel",
      label: "Moderation: warn, rename, lock, slow, clear board",
    },
    broadcast: {
      color: "#5aa9ff",
      icon: "fa-bullhorn",
      label: "Broadcast: megaphone, ticker, spotlight, party",
    },
    config: {
      color: "#c08bff",
      icon: "fa-sliders",
      label: "Config and roles: flags, room size, maintenance, grant or revoke",
    },
    signin: {
      color: "#57d9a3",
      icon: "fa-right-to-bracket",
      label: "Identity: a user signed in",
    },
    namechange: {
      color: "#ffb454",
      icon: "fa-user-pen",
      label: "Identity: a name changed or was reset",
    },
    notification: {
      color: "#ff9800",
      icon: "fa-bell",
      label:
        "Inbox: reports, applications, and possible mod-abuse flags (full mods + devs)",
    },
    other: {
      color: "#6b7080",
      icon: "fa-circle-info",
      label: "Other: spectate, staff login",
    },
  };

  function categorize(e) {
    if (e.type === "security") return "security";
    if (e.type === "notification") return "notification";
    if (e.type === "identity")
      return e.event === "signin" ? "signin" : "namechange";
    const a = (e.action || "").toLowerCase();
    if (/kick|ban|ip block|close room|nuke|freeze|wipe/.test(a))
      return "destructive";
    if (/warn|rename|lock|slow mode|clear board/.test(a)) return "moderation";
    if (/megaphone|ticker|spotlight|party/.test(a)) return "broadcast";
    if (
      /flag|maintenance|grant mod|revoke mod|blacklist|unblock|room size|make mod/.test(
        a,
      )
    )
      return "config";
    return "other";
  }

  // ── Small helpers ──
  const fmtTime = (ts) => {
    try {
      return new Date(ts).toLocaleString();
    } catch (_) {
      return String(ts);
    }
  };
  function span(cls, text) {
    const s = document.createElement("span");
    if (cls) s.className = cls;
    if (text != null) s.textContent = text;
    return s;
  }
  function icon(faClass, cls) {
    const i = document.createElement("i");
    i.className = "fas " + faClass + (cls ? " " + cls : "");
    return i;
  }
  function initialOf(name) {
    return (
      String(name || "?")
        .trim()
        .charAt(0) || "?"
    ).toUpperCase();
  }
  function parseTarget(target) {
    const m = /^user:(.*)\(([^)]*)\)$/.exec(target || "");
    return m ? { name: m[1], uid: m[2] } : null;
  }
  function uref(name, uid) {
    const s = span("uref", name);
    if (uid) {
      s.dataset.uid = uid;
      s.title = "Trace this user";
      s.addEventListener("click", () => {
        setFocus(uid);
        switchTab("activity");
      });
    }
    return s;
  }
  function metaBit(parent, k, v, vClass, uid) {
    if (v == null || v === "") return;
    parent.appendChild(span("k", k + " "));
    parent.appendChild(
      uid ? uref(String(v), uid) : span(vClass || null, String(v)),
    );
    parent.appendChild(document.createTextNode("   "));
  }
  function searchable(e) {
    const base = [
      e.role,
      e.label,
      e.action,
      e.event,
      e.target,
      e.room,
      e.ip,
      e.details,
      e.username,
      e.prevUsername,
      e.userId,
      e.by,
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    const cmts = (commentsByRef.get(e.id) || [])
      .map((c) => c.text)
      .join(" ")
      .toLowerCase();
    return base + " " + cmts;
  }
  function matchesFocus(e, uid) {
    if (e.type === "identity") return e.userId === uid;
    if (e.type === "action") {
      const t = parseTarget(e.target);
      return t && t.uid === uid;
    }
    return false;
  }
  function passes(e) {
    if (feedFilter !== "all" && e.type !== feedFilter) return false;
    if (focusUid && !matchesFocus(e, focusUid)) return false;
    if (query && !searchable(e).includes(query)) return false;
    return true;
  }

  // ── Activity cards ──
  function buildCard(e) {
    const cat = categorize(e);
    const card = document.createElement("div");
    card.className = "entry cat-" + cat;
    card.dataset.id = e.id;

    const row1 = document.createElement("div");
    row1.className = "row1";
    row1.appendChild(icon(CAT[cat].icon, "cat-ic"));
    if (e.type === "security") {
      row1.appendChild(span("chip dev", "ALERT"));
      row1.appendChild(
        span("who " + (e.role === "dev" ? "dev" : "mod"), e.label || "?"),
      );
      row1.appendChild(
        span(
          "act",
          e.kind === "concurrent"
            ? "key in use from multiple IPs"
            : "key used from a new IP",
        ),
      );
    } else if (e.type === "action") {
      row1.appendChild(
        span(
          "chip " + (e.role === "dev" ? "dev" : "mod"),
          (e.role || "?").toUpperCase(),
        ),
      );
      row1.appendChild(
        span("who " + (e.role === "dev" ? "dev" : "mod"), e.label || "?"),
      );
      row1.appendChild(span("act", e.action || "?"));
    } else if (e.type === "notification") {
      row1.appendChild(span("chip mod", (e.kind || "notice").toUpperCase()));
      if (e.by || e.label) row1.appendChild(span("who", e.by || e.label));
      row1.appendChild(
        span(
          "act",
          e.kind === "abuse"
            ? "possible mod abuse"
            : e.kind === "application"
              ? "mod application"
              : e.kind === "invite"
                ? "invite milestone"
                : "user report",
        ),
      );
    } else {
      row1.appendChild(uref(e.username || "?", e.userId));
      const evt =
        e.event === "rename"
          ? "changed name"
          : e.event === "forced-rename"
            ? "force-renamed by staff"
            : "signed in";
      row1.appendChild(span("act", evt));
    }
    row1.appendChild(span("when", fmtTime(e.ts)));
    card.appendChild(row1);

    const meta = document.createElement("div");
    meta.className = "meta";
    if (e.type === "security") {
      metaBit(meta, "key:", e.label);
      metaBit(meta, "role:", e.role);
      metaBit(meta, "IP:", e.ip, "ip");
    } else if (e.type === "action") {
      const t = parseTarget(e.target);
      if (t) {
        meta.appendChild(span("k", "target: "));
        meta.appendChild(uref(t.name, t.uid));
        meta.appendChild(document.createTextNode("   "));
      } else {
        metaBit(meta, "target:", e.target);
      }
      metaBit(meta, "room:", e.room);
      metaBit(meta, "by IP:", e.ip, "ip");
    } else if (e.type === "notification") {
      const tn = parseTarget(e.target);
      if (tn) {
        meta.appendChild(span("k", "target: "));
        meta.appendChild(uref(tn.name, tn.uid));
        meta.appendChild(document.createTextNode("   "));
      } else {
        metaBit(meta, "target:", e.target);
      }
      metaBit(meta, "room:", e.room);
    } else {
      metaBit(meta, "was:", e.prevUsername);
      metaBit(meta, "location:", e.location);
      metaBit(meta, "IP:", e.ip, "ip");
      metaBit(meta, "user:", e.userId, null, e.userId);
      metaBit(meta, "by:", e.by);
    }
    if (meta.childNodes.length) card.appendChild(meta);

    const detailText =
      e.details || e.detail || (e.type === "notification" ? e.text : null);
    if (detailText) {
      const d = document.createElement("div");
      d.className = "detail";
      d.textContent = detailText;
      card.appendChild(d);
    }

    const thread = document.createElement("div");
    thread.className = "comments";
    thread.style.display = "none";
    card.appendChild(thread);
    (commentsByRef.get(e.id) || []).forEach((c) => appendComment(card, c));

    const box = document.createElement("div");
    box.className = "cmtbox";
    const input = document.createElement("input");
    input.placeholder = "Add a note or ask a question";
    input.maxLength = 500;
    const send = document.createElement("button");
    send.className = "btn sm";
    send.appendChild(icon("fa-paper-plane"));
    const submit = () => {
      const text = input.value.trim();
      if (!text) return;
      socket.emit("audit comment", { entryId: e.id, text });
      input.value = "";
    };
    send.addEventListener("click", submit);
    input.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") submit();
    });
    box.appendChild(input);
    box.appendChild(send);
    card.appendChild(box);

    return card;
  }

  function appendComment(card, c) {
    const thread = card.querySelector(".comments");
    if (!thread) return;
    thread.style.display = "block";
    const row = document.createElement("div");
    row.className = "cmt";
    row.appendChild(
      span(
        "cwho " + (c.role === "dev" ? "dev" : "mod"),
        (c.label || "?") + ":",
      ),
    );
    row.appendChild(span("ctext", c.text));
    row.appendChild(span("cwhen", fmtTime(c.ts)));
    thread.appendChild(row);
  }

  // Full rebuild of the feed, capped to the most recent DOM_CAP matches and
  // rendered in animation-frame chunks so a long feed never blocks the page.
  let activityToken = 0;
  function renderActivity() {
    pendingNew = [];
    listEl.textContent = "";
    const token = ++activityToken;
    const matches = entries.filter((e) => e.type !== "comment" && passes(e));
    if (matches.length === 0) {
      feedNote.classList.add("hidden");
      const empty = document.createElement("div");
      empty.className = "empty";
      empty.appendChild(icon("fa-inbox"));
      empty.appendChild(document.createTextNode("No matching entries."));
      listEl.appendChild(empty);
      return;
    }
    const shown = matches.slice(-DOM_CAP);
    updateFeedNote(matches.length);
    // Newest first; live inserts still arrive at the top via flushPending.
    let i = shown.length - 1;
    (function chunk() {
      if (token !== activityToken) return; // a newer render superseded this one
      for (let n = 0; i >= 0 && n < 40; i--, n++)
        listEl.appendChild(buildCard(shown[i]));
      if (i >= 0) requestAnimationFrame(chunk);
    })();
  }

  function updateFeedNote(total) {
    if (total > DOM_CAP) {
      feedNote.classList.remove("hidden");
      feedNote.textContent =
        "Showing the latest " +
        DOM_CAP +
        " of " +
        total +
        " matching entries. Use search to narrow down.";
    } else {
      feedNote.classList.add("hidden");
    }
  }

  // Batched insert of new live entries (keeps existing cards, their comments and
  // scroll intact) plus a DOM trim, so a flood of sign-ins can't thrash the page.
  function scheduleFlush() {
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      flushPending();
    }, 450);
  }
  function flushPending() {
    if (tab !== "activity") {
      pendingNew = [];
      return;
    }
    const toShow = pendingNew.filter(passes);
    pendingNew = [];
    if (toShow.length === 0) return;
    const empty = listEl.querySelector(".empty");
    if (empty) empty.remove();
    // Newest at the top
    for (let i = 0; i < toShow.length; i++) {
      listEl.insertBefore(buildCard(toShow[i]), listEl.firstChild);
    }
    // Trim oldest cards beyond the cap
    let cards = listEl.querySelectorAll(".entry");
    for (let i = cards.length - 1; i >= DOM_CAP; i--) cards[i].remove();
    const totalMatches = entries.filter(
      (e) => e.type !== "comment" && passes(e),
    ).length;
    updateFeedNote(totalMatches);
  }

  // ── Focus (trace a user) ──
  function setFocus(uid) {
    focusUid = uid || null;
    if (!focusUid) {
      focusBar.classList.add("hidden");
      focusBar.textContent = "";
      renderActivity();
      return;
    }
    const s = userSummary(focusUid);
    focusBar.classList.remove("hidden");
    focusBar.textContent = "";
    focusBar.appendChild(icon("fa-crosshairs"));
    focusBar.appendChild(span(null, " Tracing "));
    focusBar.appendChild(span("mono", focusUid));
    const sum = span("sum");
    sum.appendChild(document.createTextNode("   names: "));
    sum.appendChild(boldList(s.names));
    sum.appendChild(document.createTextNode("   IPs: "));
    sum.appendChild(boldList(s.ips));
    sum.appendChild(document.createTextNode("   actions against them: "));
    const b = document.createElement("b");
    b.textContent = String(s.actionsAgainst);
    sum.appendChild(b);
    focusBar.appendChild(sum);
    const clear = document.createElement("button");
    clear.className = "btn sm";
    clear.appendChild(icon("fa-xmark"));
    clear.appendChild(document.createTextNode(" Clear"));
    clear.addEventListener("click", () => setFocus(null));
    focusBar.appendChild(clear);
    renderActivity();
  }
  function boldList(arr) {
    const b = document.createElement("b");
    b.textContent = arr.length ? arr.join(", ") : "none";
    return b;
  }
  function userSummary(uid) {
    const names = new Set(),
      ips = new Set();
    let actionsAgainst = 0;
    for (const e of entries) {
      if (e.type === "identity" && e.userId === uid) {
        if (e.username) names.add(e.username);
        if (e.prevUsername) names.add(e.prevUsername);
        if (e.ip) ips.add(e.ip);
      } else if (e.type === "action") {
        const t = parseTarget(e.target);
        if (t && t.uid === uid) actionsAgainst++;
      }
    }
    return { names: [...names], ips: [...ips], actionsAgainst };
  }

  function renderRoster(roster) {
    rosterEl.textContent = "";
    if (!roster) return;
    const d = document.createElement("b");
    d.textContent = "Devs: ";
    d.style.color = "var(--red)";
    rosterEl.appendChild(d);
    rosterEl.appendChild(
      document.createTextNode((roster.devs || []).join(", ") || "none"),
    );
    const m = document.createElement("b");
    m.textContent = "      Mods: ";
    m.style.color = "var(--orange)";
    rosterEl.appendChild(m);
    rosterEl.appendChild(
      document.createTextNode((roster.mods || []).join(", ") || "none"),
    );
  }

  function renderLegend() {
    const legendEl = $("legend");
    legendEl.textContent = "";
    Object.keys(CAT).forEach((cat) => {
      const row = document.createElement("div");
      row.className = "leg";
      const ic = icon(CAT[cat].icon, "leg-ic");
      ic.style.color = CAT[cat].color;
      row.appendChild(ic);
      const b = document.createElement("b");
      b.textContent = CAT[cat].label;
      row.appendChild(b);
      legendEl.appendChild(row);
    });
  }

  // ── Ban list tab (dev only) ──
  let bans = [];
  let bansTimer = null;
  function fmtRemaining(b) {
    if (b.permanent) return null;
    const ms = (b.expiry || 0) - Date.now();
    if (ms <= 0) return "expiring";
    let s = Math.floor(ms / 1000);
    const d = Math.floor(s / 86400);
    s -= d * 86400;
    const h = Math.floor(s / 3600);
    s -= h * 3600;
    const m = Math.floor(s / 60);
    s -= m * 60;
    const pad = (n) => String(n).padStart(2, "0");
    if (d > 0) return d + "d " + pad(h) + ":" + pad(m) + ":" + pad(s) + " left";
    return pad(h) + ":" + pad(m) + ":" + pad(s) + " left";
  }
  function renderBans() {
    const wrap = $("bansList");
    const isDev = me && me.role === "dev";
    wrap.textContent = "";
    $("bansBadge").textContent = String(bans.length);
    $("bansSub").textContent = bans.length
      ? bans.length + " active block" + (bans.length === 1 ? "" : "s")
      : "No active blocks";
    if (bans.length === 0) {
      const empty = document.createElement("div");
      empty.className = "empty";
      empty.appendChild(icon("fa-circle-check"));
      empty.appendChild(
        document.createTextNode("Nobody is currently blocked."),
      );
      wrap.appendChild(empty);
      return;
    }
    bans.forEach((b) => {
      const row = document.createElement("div");
      row.className = "rowcard";
      row.dataset.ip = b.ip;

      const av = document.createElement("div");
      av.className = "avatar";
      av.style.background = b.permanent ? "var(--red)" : "var(--amber)";
      av.textContent = initialOf(b.label || b.ip);
      row.appendChild(av);

      const main = document.createElement("div");
      main.className = "rc-main";
      const title = span("rc-title", "");
      title.textContent = b.label || "Unknown user";
      main.appendChild(title);
      const sub = document.createElement("div");
      sub.className = "rc-sub";
      if (isDev) {
        sub.appendChild(span("ip", b.ip));
        sub.appendChild(document.createTextNode("   "));
      }
      if (b.by) sub.appendChild(document.createTextNode("blocked by " + b.by));
      main.appendChild(sub);
      const rsn = document.createElement("div");
      rsn.className = "rc-sub rc-reason" + (b.reason ? "" : " none");
      rsn.appendChild(icon("fa-quote-left"));
      rsn.appendChild(
        document.createTextNode(" " + (b.reason || "No reason given")),
      );
      main.appendChild(rsn);
      row.appendChild(main);

      const actions = document.createElement("div");
      actions.className = "rc-actions";
      const pill = document.createElement("span");
      pill.className = "pill " + (b.permanent ? "perm" : "live");
      pill.dataset.ttl = "1";
      pill.textContent = b.permanent
        ? "Permanent"
        : fmtRemaining(b) || "expiring";
      actions.appendChild(pill);
      const unban = document.createElement("button");
      unban.className = "btn sm danger";
      unban.appendChild(icon("fa-unlock"));
      unban.appendChild(document.createTextNode(" Unban"));
      unban.addEventListener("click", async () => {
        if (!window.StaffUI) {
          socket.emit("dev unblock ip", { ip: b.ip });
          return;
        }
        const ok = await StaffUI.confirm({
          title: "Unban",
          message:
            "Unblock " + (b.label ? b.label + " (" + b.ip + ")" : b.ip) + "?",
          confirmText: "Unban",
        });
        if (ok) socket.emit("dev unblock ip", { ip: b.ip });
      });
      actions.appendChild(unban);
      row.appendChild(actions);

      wrap.appendChild(row);
    });
    startBanTimer();
  }
  function startBanTimer() {
    if (bansTimer) return;
    bansTimer = setInterval(() => {
      if (tab !== "bans") return;
      let anyLive = false;
      document.querySelectorAll("#bansList .pill[data-ttl]").forEach((pill) => {
        const ip = pill.closest(".rowcard")?.dataset.ip;
        const b = bans.find((x) => x.ip === ip);
        if (!b || b.permanent) return;
        anyLive = true;
        pill.textContent = fmtRemaining(b) || "expiring";
      });
      if (!anyLive) {
        clearInterval(bansTimer);
        bansTimer = null;
      }
    }, 1000);
  }

  // ── Moderators tab (dev only) ──
  let modKeys = [];
  function renderMods() {
    const wrap = $("modsList");
    wrap.textContent = "";
    $("modsBadge").textContent = String(modKeys.length);
    $("modsSub").textContent = modKeys.length
      ? modKeys.length + " active mod key" + (modKeys.length === 1 ? "" : "s")
      : "No mod keys yet";
    if (modKeys.length === 0) {
      const empty = document.createElement("div");
      empty.className = "empty";
      empty.appendChild(icon("fa-user-shield"));
      empty.appendChild(
        document.createTextNode("No moderators yet. Grant one above."),
      );
      wrap.appendChild(empty);
      return;
    }
    modKeys.forEach((k) => {
      const row = document.createElement("div");
      row.className = "rowcard";

      const av = document.createElement("div");
      av.className = "avatar";
      av.style.background = "var(--orange)";
      av.textContent = initialOf(k.label);
      row.appendChild(av);

      const main = document.createElement("div");
      main.className = "rc-main";
      const title = span("rc-title", "");
      title.appendChild(document.createTextNode(k.label || "mod"));
      title.appendChild(span("chip mod", k.level === 1 ? "MOD L1" : "MOD L2"));
      main.appendChild(title);
      const sub = span(
        "rc-sub mono",
        "key " + (k.hash ? k.hash.slice(0, 12) : "?"),
      );
      main.appendChild(sub);
      row.appendChild(main);

      const actions = document.createElement("div");
      actions.className = "rc-actions";

      // Promote (L1 -> L2) / demote (L2 -> L1). Dev only; the tab is dev-gated.
      const toLevel = k.level === 1 ? 2 : 1;
      const levelBtn = document.createElement("button");
      levelBtn.className = "btn sm";
      levelBtn.appendChild(
        icon(toLevel === 2 ? "fa-arrow-up" : "fa-arrow-down"),
      );
      levelBtn.appendChild(
        document.createTextNode(
          toLevel === 2 ? " Promote to L2" : " Demote to L1",
        ),
      );
      levelBtn.addEventListener("click", async () => {
        if (window.StaffUI) {
          const ok = await StaffUI.confirm({
            title: toLevel === 2 ? "Promote to L2" : "Demote to L1",
            message:
              toLevel === 2
                ? 'Give "' +
                  (k.label || "mod") +
                  '" full (level 2) powers, including ban and IP block?'
                : 'Limit "' +
                  (k.label || "mod") +
                  '" to junior (level 1) powers?',
            confirmText: toLevel === 2 ? "Promote" : "Demote",
          });
          if (!ok) return;
        }
        socket.emit("dev set mod level", { hash: k.hash, level: toLevel });
      });
      actions.appendChild(levelBtn);

      const revoke = document.createElement("button");
      revoke.className = "btn sm danger";
      revoke.appendChild(icon("fa-user-xmark"));
      revoke.appendChild(document.createTextNode(" Revoke"));
      revoke.addEventListener("click", async () => {
        if (!window.StaffUI) {
          socket.emit("dev revoke mod", { hash: k.hash });
          return;
        }
        const ok = await StaffUI.confirm({
          title: "Revoke mod",
          message:
            'Revoke "' +
            (k.label || "mod") +
            '" immediately? Their access is removed at once.',
          danger: true,
          confirmText: "Revoke",
        });
        if (ok) socket.emit("dev revoke mod", { hash: k.hash });
      });
      actions.appendChild(revoke);
      row.appendChild(actions);

      wrap.appendChild(row);
    });
  }
  async function grantMod() {
    if (!window.StaffUI) return;
    const r = await StaffUI.prompt({
      title: "Grant a mod key",
      icon: '<i class="fas fa-user-shield"></i>',
      message:
        "Pick a label so this key can be told apart in the log and list. Junior (L1) mods can kick and warn but cannot ban or IP-block - promote them later once they've proven themselves.",
      fields: [
        {
          name: "value",
          label: "Label (a name or handle)",
          type: "text",
          placeholder: "e.g. Zacki",
          required: true,
          maxLength: 40,
        },
        {
          name: "level",
          label: "Level",
          type: "select",
          value: "1",
          options: [
            { value: "1", label: "Junior mod (L1) - limited" },
            { value: "2", label: "Full mod (L2) - all powers" },
          ],
        },
      ],
      confirmText: "Generate key",
    });
    if (r && r.value)
      socket.emit("dev grant mod", { label: r.value, level: Number(r.level) });
  }

  // ── Reports tab (full mods + devs): reported users with quick actions ──
  // Report reason categories, each with a color and icon for the board.
  const REPORT_CATS = {
    spam: { label: "Spam", color: "var(--blue)", icon: "fa-inbox" },
    harassment: {
      label: "Harassment",
      color: "var(--amber)",
      icon: "fa-hand-back-fist",
    },
    hate: { label: "Hate speech", color: "var(--red)", icon: "fa-skull" },
    nsfw: { label: "NSFW", color: "var(--purple)", icon: "fa-image" },
    impersonation: {
      label: "Impersonation",
      color: "var(--blue)",
      icon: "fa-mask",
    },
    threats: {
      label: "Threats",
      color: "var(--red)",
      icon: "fa-triangle-exclamation",
    },
    modabuse: {
      label: "Mod abuse",
      color: "var(--orange)",
      icon: "fa-user-shield",
    },
    other: { label: "Other", color: "var(--dim)", icon: "fa-circle-info" },
  };
  const reportCat = (k) => REPORT_CATS[k] || REPORT_CATS.other;
  const durationLabel = (d) =>
    d === "1h"
      ? "1 hour"
      : d === "24h"
        ? "24 hours"
        : d === "7d"
          ? "7 days"
          : d === "permanent"
            ? "permanently"
            : d;
  function relTime(ts) {
    if (!ts) return "";
    const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
    if (s < 60) return "just now";
    const m = Math.floor(s / 60);
    if (m < 60) return m + "m ago";
    const h = Math.floor(m / 60);
    if (h < 24) return h + "h ago";
    return Math.floor(h / 24) + "d ago";
  }

  function banReported(r, duration) {
    const go = (reason) =>
      socket.emit("staff ip block", {
        targetUserId: r.targetUserId,
        duration,
        reason: reason || "",
      });
    if (!window.StaffUI) return go("");
    StaffUI.prompt({
      title: "IP block " + (r.name || "user"),
      icon: '<i class="fas fa-ban"></i>',
      message:
        "Block this user's IP " +
        durationLabel(duration) +
        (r.online
          ? ". They are disconnected immediately."
          : ". They are offline; the block uses their last known address."),
      fields: [
        {
          name: "value",
          label: "Reason (optional, saved to the ban list)",
          type: "textarea",
          placeholder: "e.g. Repeated harassment after warnings.",
          maxLength: 500,
        },
      ],
      danger: true,
      confirmText: "Block " + durationLabel(duration),
    }).then((reason) => {
      if (reason != null) go(reason);
    });
  }
  // Discard a report: tell the server to clear it, then drop it locally right
  // away so the card disappears without waiting for the round trip.
  function dismissReport(r) {
    socket.emit("staff dismiss report", { targetUserId: r.targetUserId });
    reportsList = reportsList.filter((x) => x.targetUserId !== r.targetUserId);
    renderReports();
  }
  // One "IP block" button opens a duration picker, so the card stays uncluttered.
  function openReportBanMenu(r) {
    if (!window.StaffUI) return banReported(r, "24h");
    const durs = [
      { label: "1 hour", value: "1h", icon: '<i class="fas fa-clock"></i>' },
      { label: "24 hours", value: "24h", icon: '<i class="fas fa-clock"></i>' },
      {
        label: "7 days",
        value: "7d",
        icon: '<i class="fas fa-calendar-week"></i>',
      },
    ];
    if (me && me.role === "dev")
      durs.push({
        label: "Permanent",
        value: "permanent",
        icon: '<i class="fas fa-ban"></i>',
      });
    StaffUI.menu({
      title: "IP block " + (r.name || "user"),
      icon: '<i class="fas fa-ban"></i>',
      subtitle: r.online
        ? "Pick a duration"
        : "Offline; uses their last known address",
      groups: [
        {
          items: durs.map((d) => ({
            icon: d.icon,
            label: d.label,
            danger: true,
            onClick: () => banReported(r, d.value),
          })),
        },
      ],
    });
  }

  // Warn a reported user (works whether they are online or offline; the server
  // delivers now or queues it for their next connect).
  async function warnReported(r) {
    if (!window.StaffUI)
      return socket.emit("staff warn user", { targetUserId: r.targetUserId });
    const msg = await StaffUI.prompt({
      title: "Warn " + (r.name || "user"),
      icon: '<i class="fas fa-triangle-exclamation"></i>',
      subtitle: r.online
        ? "They will see it right away"
        : "Saved until they next come online",
      confirmText: "Send warning",
      fields: [
        {
          name: "value",
          label: "Message (optional)",
          placeholder: "Please follow the Talkomatic rules.",
          maxLength: 1000,
        },
      ],
    });
    if (msg == null) return; // cancelled
    socket.emit("staff warn user", {
      targetUserId: r.targetUserId,
      message: String(msg).trim(),
    });
  }

  function renderReports() {
    const wrap = $("reportsList");
    if (!wrap) return;
    wrap.textContent = "";
    const badge = $("reportsBadge");
    if (badge) badge.textContent = String(reportsList.length);
    const sub = $("reportsSub");
    if (sub)
      sub.textContent = reportsList.length
        ? reportsList.length +
          " reported user" +
          (reportsList.length === 1 ? "" : "s")
        : "No reports yet";
    if (!reportsList.length) {
      const empty = document.createElement("div");
      empty.className = "empty";
      empty.appendChild(icon("fa-flag"));
      empty.appendChild(document.createTextNode("No reports right now."));
      wrap.appendChild(empty);
      return;
    }

    reportsList.forEach((r) => {
      const hot = r.distinct >= 3;
      const card = document.createElement("div");
      card.className = "report-card" + (hot ? " hot" : "");

      // Header: avatar, name, reporter count, status, last-report time
      const head = document.createElement("div");
      head.className = "rc-head";
      const av = document.createElement("div");
      av.className = "avatar";
      av.style.background = hot ? "var(--red)" : "var(--orange)";
      av.textContent = initialOf(r.name);
      head.appendChild(av);

      const idCol = document.createElement("div");
      idCol.className = "rc-id";
      idCol.appendChild(span("rc-kicker", "Reported user"));
      idCol.appendChild(span("nm", r.name || "user"));
      const meta = document.createElement("div");
      meta.className = "rc-meta";
      const cnt = span("rbadge " + (hot ? "count" : "warm"));
      cnt.appendChild(icon("fa-user-group"));
      cnt.appendChild(
        document.createTextNode(
          " " + r.distinct + (r.distinct === 1 ? " reporter" : " reporters"),
        ),
      );
      meta.appendChild(cnt);
      const st = span("rbadge " + (r.online ? "on" : "off"));
      st.appendChild(icon(r.online ? "fa-circle" : "fa-moon"));
      st.appendChild(
        document.createTextNode(
          " " +
            (r.online
              ? r.roomName
                ? "in " + r.roomName
                : "online"
              : "offline"),
        ),
      );
      meta.appendChild(st);
      if (r.last) meta.appendChild(span(null, "last report " + relTime(r.last)));
      idCol.appendChild(meta);
      head.appendChild(idCol);
      card.appendChild(head);

      // Category summary tags, most-used first
      const catEntries = Object.entries(r.categories || {}).sort(
        (a, b) => b[1] - a[1],
      );
      if (catEntries.length) {
        const cats = document.createElement("div");
        cats.className = "rc-cats";
        cats.appendChild(span("lead", "Reported for"));
        catEntries.forEach(([k, v]) => {
          const c = reportCat(k);
          const tag = document.createElement("span");
          tag.className = "ctag";
          tag.style.color = c.color;
          tag.appendChild(icon(c.icon));
          tag.appendChild(document.createTextNode(" " + c.label));
          tag.appendChild(span("n", " x" + v));
          cats.appendChild(tag);
        });
        card.appendChild(cats);
      }

      // "Who reported" header + one row per reporter, so it is unmistakable
      // that the people listed here are the reporters, not the user above.
      const reasons = r.reasons || [];
      const logHead = document.createElement("div");
      logHead.className = "report-log-head";
      logHead.textContent = "Who reported (" + reasons.length + ")";
      card.appendChild(logHead);
      const log = document.createElement("div");
      log.className = "report-log";
      reasons.forEach((rr) => {
        const c = reportCat(rr.category);
        const item = document.createElement("div");
        item.className = "rlog";
        item.appendChild(span("rl-av", initialOf(rr.by || "?")));
        const m = document.createElement("div");
        m.className = "rl-main";
        const top = document.createElement("div");
        top.className = "rl-top";
        top.appendChild(span("rl-by", rr.by || "Someone"));
        top.appendChild(span("rl-said", "reported for"));
        const cat = span("rl-cat", c.label);
        cat.style.color = c.color;
        cat.style.borderColor = c.color;
        top.appendChild(cat);
        if (rr.at) top.appendChild(span("rl-when", relTime(rr.at)));
        m.appendChild(top);
        m.appendChild(
          span(
            "rl-reason" + (rr.reason ? "" : " none"),
            rr.reason || "No note left",
          ),
        );
        item.appendChild(m);
        log.appendChild(item);
      });
      card.appendChild(log);

      // Footer actions
      const foot = document.createElement("div");
      foot.className = "rc-foot";
      const mkBtn = (label, faIcon, danger, fn) => {
        const b = document.createElement("button");
        b.className = "btn sm" + (danger ? " danger" : "");
        if (faIcon) b.appendChild(icon(faIcon));
        b.appendChild(document.createTextNode((faIcon ? " " : "") + label));
        b.addEventListener("click", fn);
        return b;
      };
      foot.appendChild(
        mkBtn("Warn", "fa-triangle-exclamation", false, () => warnReported(r)),
      );
      if (r.online)
        foot.appendChild(
          mkBtn("Kick", "fa-door-open", false, () =>
            socket.emit("staff kick", { targetUserId: r.targetUserId }),
          ),
        );
      if (r.online || r.canBanOffline)
        foot.appendChild(
          mkBtn("IP block", "fa-ban", true, () => openReportBanMenu(r)),
        );
      else
        foot.appendChild(
          span("note", "Offline with no address on file, cannot block."),
        );
      foot.appendChild(span("spacer"));
      const discard = mkBtn("Discard", "fa-xmark", false, () =>
        dismissReport(r),
      );
      discard.classList.add("rc-discard");
      discard.title = "Clear this report as false or already handled";
      foot.appendChild(discard);
      card.appendChild(foot);

      wrap.appendChild(card);
    });
  }

  // ── Invites tab (full mods + devs): flag and clean farmed invites ──
  function verdictMeta(level) {
    if (level === "likely_farmed")
      return { cls: "farmed", label: "Likely farmed", icon: "fa-robot" };
    if (level === "suspicious")
      return {
        cls: "suspicious",
        label: "Suspicious",
        icon: "fa-circle-question",
      };
    return { cls: "clean", label: "Looks clean", icon: "fa-circle-check" };
  }

  // Confirm, then ask the server to soft-delete a flagged cluster (or all
  // flagged invites) for one inviter. The server re-checks the flag and logs it.
  async function confirmPurge(it, cohort, count) {
    if (!window.StaffUI) return;
    const go = await StaffUI.confirm({
      title: "Remove farmed invites",
      danger: true,
      confirmText: "Remove " + count,
      message:
        "Remove " +
        count +
        " pending invite" +
        (count === 1 ? "" : "s") +
        " from " +
        (it.name || "this inviter") +
        "? Active invites are never touched. This is logged, and a developer can undo it.",
    });
    if (!go) return;
    socket.emit("staff purge invites", { deviceId: it.deviceId, cohort });
  }

  // The expanded forensic detail for one inviter: a cadence + conversion
  // summary, each same-address cluster with its own Remove button, and (for
  // devs) an undo of the last removal.
  function buildInviteDetail(it, d, isDev) {
    const box = document.createElement("div");
    box.className = "inv-detail";

    const sum = document.createElement("div");
    sum.className = "sumline";
    const parts = [];
    if (d.medianGapMs != null)
      parts.push("~" + (d.medianGapMs / 1000).toFixed(1) + "s between invites");
    parts.push((d.activePct || 0) + "% became active");
    parts.push((d.namedPct || 0) + "% ever named");
    sum.textContent = parts.join("   ·   ");
    box.appendChild(sum);

    if (!d.cohorts || !d.cohorts.length) {
      const none = document.createElement("div");
      none.className = "inv-none";
      none.textContent =
        "No same-address cluster large enough to remove as a group.";
      box.appendChild(none);
    } else {
      const head = document.createElement("div");
      head.className = "report-log-head";
      head.style.padding = "0 0 6px";
      head.textContent = "Same-address clusters";
      box.appendChild(head);
      d.cohorts.forEach((c) => {
        const row = document.createElement("div");
        row.className = "cohort-row";
        const info = span("cinfo");
        const b = document.createElement("b");
        b.textContent = c.count + " invite" + (c.count === 1 ? "" : "s");
        info.appendChild(b);
        info.appendChild(document.createTextNode(" from one address"));
        if (isDev && c.ip) {
          info.appendChild(document.createTextNode(" "));
          info.appendChild(span("ip", c.ip));
        }
        row.appendChild(info);
        const rm = document.createElement("button");
        rm.className = "btn sm danger";
        rm.appendChild(icon("fa-trash"));
        rm.appendChild(document.createTextNode(" Remove " + c.count));
        rm.addEventListener("click", () => confirmPurge(it, c.index, c.count));
        row.appendChild(rm);
        box.appendChild(row);
      });
    }

    if (isDev && d.lastBatch) {
      const undo = document.createElement("button");
      undo.className = "btn sm";
      undo.style.marginTop = "10px";
      undo.appendChild(icon("fa-rotate-left"));
      undo.appendChild(document.createTextNode(" Undo last removal"));
      undo.addEventListener("click", () =>
        socket.emit("staff undo invite purge", {
          deviceId: it.deviceId,
          batch: d.lastBatch,
        }),
      );
      box.appendChild(undo);
    }
    return box;
  }

  function renderInvites() {
    const wrap = $("invitesList");
    if (!wrap) return;
    wrap.textContent = "";
    const badge = $("invitesBadge");
    if (badge) badge.textContent = String(invitesList.length);
    const sub = $("invitesSub");
    if (sub)
      sub.textContent = invitesList.length
        ? invitesList.length +
          " flagged inviter" +
          (invitesList.length === 1 ? "" : "s")
        : "No flagged inviters";
    if (!invitesList.length) {
      const empty = document.createElement("div");
      empty.className = "empty";
      empty.appendChild(icon("fa-trophy"));
      empty.appendChild(
        document.createTextNode(
          "No farmed invites detected. The board is clean.",
        ),
      );
      wrap.appendChild(empty);
      return;
    }
    const isDev = me && me.role === "dev";
    const pages = Math.max(1, Math.ceil(invitesList.length / INV_PAGE));
    if (invitesPage >= pages) invitesPage = pages - 1;
    if (invitesPage < 0) invitesPage = 0;
    const start = invitesPage * INV_PAGE;
    invitesList.slice(start, start + INV_PAGE).forEach((it) => {
      const vm = verdictMeta(it.verdict && it.verdict.level);
      const card = document.createElement("div");
      card.className = "report-card" + (vm.cls === "farmed" ? " hot" : "");

      const head = document.createElement("div");
      head.className = "rc-head";
      const av = document.createElement("div");
      av.className = "avatar";
      av.style.background =
        vm.cls === "farmed" ? "var(--red)" : "var(--orange)";
      av.textContent = initialOf(it.name);
      head.appendChild(av);
      const idCol = document.createElement("div");
      idCol.className = "rc-id";
      idCol.appendChild(span("rc-kicker", "Inviter"));
      idCol.appendChild(span("nm", it.name || "Anonymous"));
      const meta = document.createElement("div");
      meta.className = "rc-meta";
      const v = span("verdict " + vm.cls);
      v.appendChild(icon(vm.icon));
      v.appendChild(document.createTextNode(" " + vm.label));
      meta.appendChild(v);
      if (it.location) meta.appendChild(span(null, it.location));
      idCol.appendChild(meta);
      head.appendChild(idCol);
      card.appendChild(head);

      const stats = document.createElement("div");
      stats.className = "inv-stats";
      const chip = (label, val) => {
        const s = span("st");
        s.appendChild(document.createTextNode(label + " "));
        const b = document.createElement("b");
        b.textContent = String(val);
        s.appendChild(b);
        return s;
      };
      stats.appendChild(chip("pending", it.pending));
      stats.appendChild(chip("active", it.active));
      stats.appendChild(chip("distinct IPs", it.distinctIps));
      stats.appendChild(chip("top address", (it.topIpPct || 0) + "%"));
      stats.appendChild(chip("named", (it.namedPct || 0) + "%"));
      card.appendChild(stats);

      if (it.verdict && it.verdict.reasons && it.verdict.reasons.length) {
        const ul = document.createElement("ul");
        ul.className = "inv-reasons";
        it.verdict.reasons.forEach((r) => {
          const li = document.createElement("li");
          li.textContent = r;
          ul.appendChild(li);
        });
        card.appendChild(ul);
      }

      const detail = inviteDetails.get(it.deviceId);
      const foot = document.createElement("div");
      foot.className = "rc-foot";
      if (!detail) {
        const investigate = document.createElement("button");
        investigate.className = "btn sm";
        investigate.appendChild(icon("fa-magnifying-glass"));
        investigate.appendChild(document.createTextNode(" Investigate"));
        investigate.addEventListener("click", () =>
          socket.emit("staff get invite report", { deviceId: it.deviceId }),
        );
        foot.appendChild(investigate);
      }
      if (it.pending > 0) {
        const purgeAll = document.createElement("button");
        purgeAll.className = "btn sm danger";
        purgeAll.appendChild(icon("fa-broom"));
        purgeAll.appendChild(
          document.createTextNode(" Remove all flagged (" + it.pending + ")"),
        );
        purgeAll.addEventListener("click", () =>
          confirmPurge(it, "all", it.pending),
        );
        foot.appendChild(purgeAll);
      }
      card.appendChild(foot);

      if (detail) card.appendChild(buildInviteDetail(it, detail, isDev));

      wrap.appendChild(card);
    });

    if (pages > 1) {
      const pager = document.createElement("div");
      pager.className = "inv-pager";
      const nav = (label, faIcon, atEnd, disabled, delta) => {
        const b = document.createElement("button");
        b.className = "btn sm";
        b.disabled = disabled;
        if (!atEnd) b.appendChild(icon(faIcon));
        b.appendChild(document.createTextNode(label));
        if (atEnd) b.appendChild(icon(faIcon));
        if (!disabled)
          b.addEventListener("click", () => {
            invitesPage += delta;
            renderInvites();
          });
        return b;
      };
      pager.appendChild(
        nav(" Prev", "fa-chevron-left", false, invitesPage === 0, -1),
      );
      pager.appendChild(
        span(null, "Page " + (invitesPage + 1) + " of " + pages),
      );
      pager.appendChild(
        nav("Next ", "fa-chevron-right", true, invitesPage >= pages - 1, 1),
      );
      wrap.appendChild(pager);
    }
  }

  // ── Applications tab (full mods + devs) ──
  function renderApps() {
    const wrap = $("appsList");
    if (!wrap) return;
    wrap.textContent = "";
    const pending = applicationsList.filter((a) => a.status === "pending");
    const badge = $("appsBadge");
    if (badge) badge.textContent = String(pending.length);
    const sub = $("appsSub");
    if (sub)
      sub.textContent = pending.length
        ? pending.length + " awaiting review"
        : "No applications awaiting review";
    if (applicationsList.length === 0) {
      const empty = document.createElement("div");
      empty.className = "empty";
      empty.appendChild(icon("fa-user-pen"));
      empty.appendChild(document.createTextNode("No applications yet."));
      wrap.appendChild(empty);
      return;
    }
    applicationsList.forEach((a) => {
      const row = document.createElement("div");
      row.className = "rowcard";
      const av = document.createElement("div");
      av.className = "avatar";
      av.style.background =
        a.status === "pending" ? "var(--orange)" : "#3a3f4a";
      av.textContent = initialOf(a.username);
      row.appendChild(av);

      const main = document.createElement("div");
      main.className = "rc-main";
      const title = span("rc-title", "");
      title.appendChild(document.createTextNode(a.username || "Anonymous"));
      const chipCls =
        a.status === "pending"
          ? "chip mod"
          : a.status === "approved"
            ? "chip dev"
            : "chip";
      title.appendChild(span(chipCls, (a.status || "").toUpperCase()));
      main.appendChild(title);
      const why = (a.answers && a.answers.why) || "(no reason given)";
      const avail = (a.answers && a.answers.availability) || "";
      main.appendChild(
        span("rc-sub", why + (avail ? "  ·  avail: " + avail : "")),
      );
      main.appendChild(
        span(
          "rc-sub mono",
          new Date(a.submittedAt).toLocaleString() +
            (a.reviewedBy ? "  ·  by " + a.reviewedBy : "") +
            (a.reason ? "  ·  " + a.reason : ""),
        ),
      );
      // Identity line, consistent with the audit feed and reports board: the
      // device id shows for all staff; the IP is only present for devs (the
      // server omits it for mods).
      const idBits = [];
      if (a.deviceId) idBits.push("id: " + a.deviceId);
      if (a.ip) idBits.push("IP: " + a.ip);
      if (idBits.length) main.appendChild(span("rc-sub mono", idBits.join("  ·  ")));
      row.appendChild(main);

      if (a.status === "pending") {
        const actions = document.createElement("div");
        actions.className = "rc-actions";
        const approve = document.createElement("button");
        approve.className = "btn sm primary";
        approve.appendChild(icon("fa-check"));
        approve.appendChild(document.createTextNode(" Approve (L1)"));
        approve.addEventListener("click", async () => {
          if (window.StaffUI) {
            const ok = await StaffUI.confirm({
              title: "Approve application",
              message:
                "Approve " +
                (a.username || "this user") +
                " as a junior (L1) moderator? They get a mod key right away.",
              confirmText: "Approve",
            });
            if (!ok) return;
          }
          socket.emit("mod application review", {
            id: a.id,
            decision: "approve",
          });
        });
        const reject = document.createElement("button");
        reject.className = "btn sm danger";
        reject.appendChild(icon("fa-xmark"));
        reject.appendChild(document.createTextNode(" Reject"));
        reject.addEventListener("click", async () => {
          let reason = "";
          if (window.StaffUI) {
            reason = await StaffUI.prompt({
              title: "Reject application",
              icon: '<i class="fas fa-xmark"></i>',
              fields: [
                {
                  name: "value",
                  label: "Reason (optional, kept private)",
                  type: "text",
                  maxLength: 300,
                },
              ],
              confirmText: "Reject",
            });
            if (reason === null) return;
          }
          socket.emit("mod application review", {
            id: a.id,
            decision: "reject",
            reason: reason || "",
          });
        });
        actions.appendChild(approve);
        actions.appendChild(reject);
        row.appendChild(actions);
      }
      wrap.appendChild(row);
    });
  }

  // ── Sessions tab (dev only): who is connected on which staff key ──
  let sessionData = { sessions: [], history: [] };
  function keyRow(label, role, ipsText, pillClass, pillText, sub2) {
    const row = document.createElement("div");
    row.className = "rowcard";
    const av = document.createElement("div");
    av.className = "avatar";
    av.style.background = role === "dev" ? "var(--red)" : "var(--orange)";
    av.textContent = initialOf(label);
    row.appendChild(av);
    const main = document.createElement("div");
    main.className = "rc-main";
    const title = span("rc-title", "");
    title.appendChild(document.createTextNode(label || "?"));
    title.appendChild(
      span(
        "chip " + (role === "dev" ? "dev" : "mod"),
        (role || "?").toUpperCase(),
      ),
    );
    main.appendChild(title);
    const sub = span("rc-sub", "");
    if (sub2) sub.appendChild(document.createTextNode(sub2 + " "));
    sub.appendChild(span("ip", ipsText || "none"));
    main.appendChild(sub);
    row.appendChild(main);
    const actions = document.createElement("div");
    actions.className = "rc-actions";
    const pill = document.createElement("span");
    pill.className = "pill " + pillClass;
    pill.textContent = pillText;
    actions.appendChild(pill);
    row.appendChild(actions);
    return row;
  }
  function emptyCard(wrap, ic, text) {
    const e = document.createElement("div");
    e.className = "empty";
    e.appendChild(icon(ic));
    e.appendChild(document.createTextNode(text));
    wrap.appendChild(e);
  }
  function renderSessions() {
    const active = $("sessionsActive");
    const hist = $("sessionsHistory");
    const sessions = sessionData.sessions || [];
    const history = sessionData.history || [];
    const flagged = sessions.filter((s) => s.multiIp).length;
    $("sessionsBadge").textContent = String(sessions.length);
    $("sessionsSub").textContent = sessions.length
      ? sessions.length +
        " key" +
        (sessions.length === 1 ? "" : "s") +
        " connected" +
        (flagged ? ", " + flagged + " from multiple IPs" : "")
      : "No staff connected right now";

    active.textContent = "";
    if (sessions.length === 0) {
      emptyCard(
        active,
        "fa-plug-circle-xmark",
        "No staff are connected right now.",
      );
    } else {
      sessions.forEach((s) => {
        const tabs =
          (s.sessionCount || 1) +
          " tab" +
          ((s.sessionCount || 1) === 1 ? "" : "s") +
          " from";
        active.appendChild(
          keyRow(
            s.label,
            s.role,
            (s.ips || []).join(", "),
            s.multiIp ? "perm" : "live",
            s.multiIp ? "Multiple IPs" : "OK",
            tabs,
          ),
        );
      });
    }

    hist.textContent = "";
    if (history.length === 0) {
      emptyCard(hist, "fa-clock-rotate-left", "No key history yet.");
    } else {
      history.forEach((h) => {
        const ips = h.ips || [];
        hist.appendChild(
          keyRow(
            h.label,
            h.role,
            ips.map((x) => x.ip).join(", "),
            ips.length > 1 ? "perm" : "live",
            ips.length + " IP" + (ips.length === 1 ? "" : "s"),
            "seen from",
          ),
        );
      });
    }
  }

  // ── Tabs + sidebar ──
  function switchTab(name) {
    tab = name;
    document
      .querySelectorAll(".nav-item")
      .forEach((n) => n.classList.toggle("active", n.dataset.tab === name));
    document
      .querySelectorAll(".panel")
      .forEach((p) => p.classList.remove("active"));
    const panel = $("tab-" + name);
    if (panel) panel.classList.add("active");
    if (name === "activity") flushPending();
    if (name === "bans") {
      socket.emit("dev list blocks");
      startBanTimer();
    }
    if (name === "mods") socket.emit("dev list mod keys");
    if (name === "sessions") socket.emit("dev get sessions");
    if (name === "applications") socket.emit("mod applications list");
    if (name === "reports") socket.emit("staff get reports");
    if (name === "invites") socket.emit("staff get invite report");
    if (window.innerWidth <= 860) document.body.classList.add("nav-closed");
  }
  function updateNotifBadge() {
    const b = document.getElementById("notifCount");
    if (!b) return;
    b.textContent = unreadNotifs > 0 ? String(unreadNotifs) : "";
    b.style.display = unreadNotifs > 0 ? "" : "none";
  }

  function applyRoleGating() {
    const isDev = me && me.role === "dev";
    const fullMod = isDev || (me && (me.modLevel || 2) >= 2);
    document.querySelectorAll(".nav-item[data-dev]").forEach((n) => {
      n.style.display = isDev ? "" : "none";
    });
    // Notifications (reports + mod-abuse flags) are for full mods + devs only.
    document.querySelectorAll("[data-min2]").forEach((n) => {
      n.style.display = fullMod ? "" : "none";
    });
    if (!isDev && (tab === "bans" || tab === "mods" || tab === "sessions"))
      switchTab("activity");
    if (!fullMod && tab === "applications") switchTab("activity");
    if (!fullMod && tab === "reports") switchTab("activity");
    if (!fullMod && tab === "invites") switchTab("activity");
    if (!fullMod && feedFilter === "notification") {
      feedFilter = "all";
      document
        .querySelectorAll("#filterSeg button")
        .forEach((b) => b.classList.toggle("active", b.dataset.f === "all"));
    }
  }

  // ── Socket wiring ──
  socket.on("connect", () => socket.emit("staff get audit", { limit: 1500 }));

  socket.on("audit snapshot", (data) => {
    authorized = true;
    loadingEl.classList.add("hidden");
    deniedEl.classList.add("hidden");
    appEl.classList.remove("hidden");
    entries = Array.isArray(data && data.entries) ? data.entries : [];
    commentsByRef.clear();
    for (const e of entries)
      if (e.type === "comment" && e.refId) {
        if (!commentsByRef.has(e.refId)) commentsByRef.set(e.refId, []);
        commentsByRef.get(e.refId).push(e);
      }
    me = data && data.me;
    if (me) {
      meEl.textContent = "";
      meEl.appendChild(
        span(
          "chip " + (me.role === "dev" ? "dev" : "mod"),
          (me.role || "staff").toUpperCase(),
        ),
      );
      meEl.appendChild(document.createTextNode(" " + (me.label || "")));
    }
    applyRoleGating();
    renderRoster(data && data.roster);
    renderLegend();
    renderActivity();

    // Populate the left-panel counts immediately, not only when a tab is opened.
    const fullMod = me && (me.role === "dev" || (me.modLevel || 0) >= 2);
    if (me && me.role === "dev") {
      socket.emit("dev list blocks");
      socket.emit("dev list mod keys");
      socket.emit("dev get sessions");
    }
    if (fullMod) {
      socket.emit("mod applications list");
      socket.emit("staff get reports");
      socket.emit("staff get invite report");
    }
  });

  socket.on("audit entry", (e) => {
    if (!e) return;
    entries.push(e);
    if (entries.length > 5000) entries = entries.slice(-3000);
    if (
      e.type === "notification" &&
      !(tab === "activity" && feedFilter === "notification")
    ) {
      unreadNotifs++;
      updateNotifBadge();
    }
    if (e.type === "comment" && e.refId) {
      if (!commentsByRef.has(e.refId)) commentsByRef.set(e.refId, []);
      commentsByRef.get(e.refId).push(e);
      const card = listEl.querySelector('.entry[data-id="' + e.refId + '"]');
      if (card) appendComment(card, e);
      return;
    }
    // Buffer and flush on a timer so a flood of events can't thrash the DOM.
    pendingNew.push(e);
    scheduleFlush();
  });

  socket.on("dev blocks", (list) => {
    bans = (Array.isArray(list) ? list : []).slice().sort((a, b) => {
      if (a.permanent !== b.permanent) return a.permanent ? -1 : 1;
      return (a.expiry || 0) - (b.expiry || 0);
    });
    renderBans();
  });

  socket.on("dev mod keys", (list) => {
    modKeys = Array.isArray(list) ? list : [];
    renderMods();
  });

  socket.on("mod applications", (list) => {
    applicationsList = Array.isArray(list) ? list : [];
    renderApps();
  });

  socket.on("staff reports", (list) => {
    reportsList = Array.isArray(list) ? list : [];
    renderReports();
  });

  socket.on("staff invite report", (list) => {
    invitesList = Array.isArray(list) ? list : [];
    invitesPage = 0;
    renderInvites();
  });

  socket.on("staff invite detail", (d) => {
    if (!d || !d.deviceId) return;
    inviteDetails.set(d.deviceId, d);
    // Reflect the post-action state on the list card (counts + verdict change
    // after a purge or undo) without waiting for a full list refresh.
    const idx = invitesList.findIndex((x) => x.deviceId === d.deviceId);
    if (idx >= 0) {
      const c = d.counts || {};
      invitesList[idx] = Object.assign({}, invitesList[idx], {
        pending: c.pending != null ? c.pending : invitesList[idx].pending,
        active: c.active != null ? c.active : invitesList[idx].active,
        distinctIps: d.distinctIps,
        topIpPct: d.topIpPct,
        namedPct: d.namedPct,
        verdict: d.verdict || invitesList[idx].verdict,
      });
    }
    renderInvites();
  });

  socket.on("dev sessions", (data) => {
    sessionData = data || { sessions: [], history: [] };
    renderSessions();
  });

  socket.on("dev mod granted", (d) => {
    if (!d || !d.key || !window.StaffUI) return;
    const w = document.createElement("div");
    const p1 = document.createElement("p");
    p1.textContent =
      "New " +
      (d.level === 1 ? "junior (L1)" : "full (L2)") +
      ' mod key for "' +
      (d.label || "mod") +
      '". Copy it now: it is shown once and never stored.';
    const code = document.createElement("div");
    code.className = "mono";
    code.style.cssText =
      "background:#000;border:1px solid #333;padding:10px;margin:10px 0;word-break:break-all;border-radius:6px;color:#ff9800;";
    code.textContent = d.key;
    w.appendChild(p1);
    w.appendChild(code);
    StaffUI.modal({
      title: "Mod key created",
      icon: '<i class="fas fa-key"></i>',
      body: w,
      actions: [
        {
          label: "Copy key",
          kind: "primary",
          onClick: () => {
            try {
              navigator.clipboard.writeText(d.key);
            } catch (_) {}
          },
        },
        { label: "Done", onClick: () => {} },
      ],
    });
  });

  socket.on("staff action result", (d) => {
    if (d && window.StaffUI)
      StaffUI.toast((d.ok ? "Done: " : "Failed: ") + (d.action || ""), {
        type: d.ok ? "success" : "error",
      });
  });

  const showDenied = () => {
    if (authorized) return;
    loadingEl.classList.add("hidden");
    appEl.classList.add("hidden");
    deniedEl.classList.remove("hidden");
  };
  socket.on("error", showDenied);
  socket.on("connect_error", showDenied);
  setTimeout(showDenied, 4500);

  // ── Key entry (no console) ──
  let pendingStaffKey = null;
  async function openStaffKeyEntry() {
    if (!window.StaffUI) return;
    const key = await StaffUI.prompt({
      title: "Staff access",
      icon: '<i class="fas fa-key"></i>',
      subtitle: "Enter your dev or mod key",
      message: "Verified on the server, then saved to this browser.",
      fields: [
        {
          name: "value",
          label: "Staff key",
          type: "password",
          placeholder: "paste your key",
          required: true,
        },
      ],
      confirmText: "Unlock",
    });
    if (key) {
      pendingStaffKey = key;
      socket.emit("staff validate key", { key });
    }
  }
  socket.on("staff key result", (d) => {
    if (!d || !d.role) {
      if (window.StaffUI)
        StaffUI.toast(
          d && d.throttled
            ? "Too many attempts. Wait a few minutes."
            : "That key was not recognized.",
          { type: "error" },
        );
      pendingStaffKey = null;
      return;
    }
    if (d.role === "dev")
      localStorage.setItem("talkomatic_devKey", pendingStaffKey);
    else localStorage.setItem("talkomatic_modKey", pendingStaffKey);
    pendingStaffKey = null;
    if (window.StaffUI)
      StaffUI.toast("Key accepted. Reloading.", { type: "success" });
    setTimeout(() => window.location.reload(), 1000);
  });

  // ── Controls ──
  $("enterKeyBtn") &&
    $("enterKeyBtn").addEventListener("click", openStaffKeyEntry);
  $("navToggle").addEventListener("click", () =>
    document.body.classList.toggle("nav-closed"),
  );
  $("navBackdrop").addEventListener("click", () =>
    document.body.classList.add("nav-closed"),
  );
  document
    .querySelectorAll(".nav-item")
    .forEach((n) =>
      n.addEventListener("click", () => switchTab(n.dataset.tab)),
    );
  $("bansRefresh").addEventListener("click", () =>
    socket.emit("dev list blocks"),
  );
  $("modsRefresh").addEventListener("click", () =>
    socket.emit("dev list mod keys"),
  );
  $("sessionsRefresh") &&
    $("sessionsRefresh").addEventListener("click", () =>
      socket.emit("dev get sessions"),
    );
  $("grantMod").addEventListener("click", grantMod);
  $("appsRefresh") &&
    $("appsRefresh").addEventListener("click", () =>
      socket.emit("mod applications list"),
    );
  $("reportsRefresh") &&
    $("reportsRefresh").addEventListener("click", () =>
      socket.emit("staff get reports"),
    );
  $("invitesRefresh") &&
    $("invitesRefresh").addEventListener("click", () => {
      inviteDetails.clear();
      socket.emit("staff get invite report");
    });

  let searchDebounce = null;
  searchEl.addEventListener("input", () => {
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => {
      query = searchEl.value.trim().toLowerCase();
      renderActivity();
    }, 200);
  });
  document.querySelectorAll("#filterSeg button").forEach((btn) => {
    btn.addEventListener("click", () => {
      document
        .querySelectorAll("#filterSeg button")
        .forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      feedFilter = btn.dataset.f;
      if (feedFilter === "notification") {
        unreadNotifs = 0;
        updateNotifBadge();
      }
      renderActivity();
    });
  });

  // Open the sidebar by default on wider screens.
  if (window.innerWidth > 860) document.body.classList.remove("nav-closed");

  window.addEventListener("beforeunload", () => {
    try {
      socket.emit("staff stop audit");
    } catch (_) {}
  });
})();
