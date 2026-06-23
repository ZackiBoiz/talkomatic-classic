// public/js/connection-overlay.js
// Full-screen overlay for connection events. On "server restarting" it shows a
// countdown, then sends the user to the lobby (which reconnects to the fresh
// server). On an unexpected disconnect it shows a "reconnecting" notice instead
// of letting the page silently freeze. Attached by the lobby and room clients.
(function () {
  "use strict";
  var restarting = false;
  var reconnectTimer = null;

  function styles() {
    if (document.getElementById("tkConnStyles")) return;
    var st = document.createElement("style");
    st.id = "tkConnStyles";
    st.textContent =
      "#tkConnOverlay{position:fixed;inset:0;z-index:1000003;background:rgba(8,8,8,.92);" +
      "display:none;align-items:center;justify-content:center;padding:20px;font-family:Arial,sans-serif;}" +
      "#tkConnOverlay .tk-conn-box{max-width:440px;width:100%;background:#181818;border:1px solid #616161;" +
      "border-radius:10px;padding:34px 28px;text-align:center;box-shadow:0 12px 40px rgba(0,0,0,.6);}" +
      "#tkConnOverlay .tk-conn-title{color:#ff9800;font-size:23px;font-weight:bold;margin:0 0 8px;}" +
      "#tkConnOverlay .tk-conn-msg{color:#ddd;font-size:15px;line-height:1.5;margin:0;}" +
      "#tkConnOverlay .tk-conn-msg b{color:#fff;font-size:20px;}" +
      "#tkConnOverlay .tk-conn-bar{height:6px;background:#333;border-radius:4px;overflow:hidden;margin-top:16px;}" +
      "#tkConnOverlay .tk-conn-bar span{display:block;height:100%;width:0;background:#ff9800;transition:width 1s linear;}" +
      "#tkConnOverlay .tk-conn-spinner{width:42px;height:42px;border:4px solid #333;border-top-color:#ff9800;" +
      "border-radius:50%;margin:0 auto 16px;animation:tkConnSpin 1s linear infinite;}" +
      "#tkConnOverlay button{margin-top:18px;background:#ff9800;color:#000;border:none;border-radius:5px;" +
      "padding:10px 18px;font-size:14px;font-weight:bold;cursor:pointer;font-family:inherit;}" +
      "@keyframes tkConnSpin{to{transform:rotate(360deg);}}";
    document.head.appendChild(st);
  }

  function overlay() {
    var o = document.getElementById("tkConnOverlay");
    if (!o) {
      o = document.createElement("div");
      o.id = "tkConnOverlay";
      document.body.appendChild(o);
    }
    return o;
  }

  function showRestart(seconds) {
    restarting = true;
    styles();
    var total = seconds || 5;
    var o = overlay();
    o.innerHTML =
      '<div class="tk-conn-box"><div class="tk-conn-title">Talkomatic is updating</div>' +
      '<div class="tk-conn-msg">Returning you to the lobby in <b id="tkConnN">' +
      total +
      "</b> seconds…</div>" +
      '<div class="tk-conn-bar"><span id="tkConnBar"></span></div></div>';
    o.style.display = "flex";
    var n = total;
    (function tick() {
      var nEl = document.getElementById("tkConnN");
      var bar = document.getElementById("tkConnBar");
      if (nEl) nEl.textContent = String(Math.max(0, n));
      if (bar) bar.style.width = 100 * (1 - n / total) + "%";
      if (n <= 0) {
        window.location.href = "/";
        return;
      }
      n--;
      setTimeout(tick, 1000);
    })();
  }

  function showReconnecting() {
    if (restarting) return;
    styles();
    var o = overlay();
    o.innerHTML =
      '<div class="tk-conn-box"><div class="tk-conn-spinner"></div>' +
      '<div class="tk-conn-title">Reconnecting…</div>' +
      '<div class="tk-conn-msg">Lost connection to Talkomatic. Trying to reconnect…</div></div>';
    var btn = document.createElement("button");
    btn.textContent = "Return to lobby";
    btn.addEventListener("click", function () {
      window.location.href = "/";
    });
    o.querySelector(".tk-conn-box").appendChild(btn);
    o.style.display = "flex";
  }

  function hide() {
    if (restarting) return;
    var o = document.getElementById("tkConnOverlay");
    if (o) o.style.display = "none";
  }

  window.TalkomaticConnection = {
    attach: function (socket) {
      if (!socket) return;
      socket.on("server restarting", function (d) {
        showRestart((d && d.seconds) || 5);
      });
      socket.on("disconnect", function (reason) {
        // Ignore intentional disconnects (tab handoff, navigation).
        if (restarting || reason === "io client disconnect") return;
        clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(showReconnecting, 1200); // grace for blips
      });
      socket.on("connect", function () {
        clearTimeout(reconnectTimer);
        hide();
      });
    },
  };
})();
