/* Talkomatic durable device identity.
 *
 * A random per-browser id, mirrored across localStorage + cookie + IndexedDB
 * so a casual "clear my localStorage" self-heals from a backup layer. This is
 * NOT a login and is never trusted for anything privileged on the server - it
 * only powers "active vs new" and invite credit. Loaded BEFORE the lobby/room
 * clients so window.TalkomaticIdentity.deviceId is ready for the socket auth.
 */
(function () {
  "use strict";
  var LS_KEY = "talkomatic_did";
  var CK_KEY = "tk_did";
  var DB_NAME = "talkomatic";
  var STORE = "kv";
  var DB_KEY = "did";

  function uuid() {
    try {
      if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    } catch (e) {}
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function (c) {
      var r = (Math.random() * 16) | 0;
      var v = c === "x" ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }

  function valid(id) {
    return typeof id === "string" && /^[a-f0-9-]{8,64}$/i.test(id);
  }

  function readCookie(name) {
    try {
      var m = document.cookie.match(new RegExp("(?:^|; )" + name + "=([^;]*)"));
      return m ? decodeURIComponent(m[1]) : null;
    } catch (e) {
      return null;
    }
  }
  function writeCookie(name, val) {
    try {
      document.cookie =
        name +
        "=" +
        encodeURIComponent(val) +
        "; max-age=31536000; path=/; SameSite=Lax";
    } catch (e) {}
  }
  function lsGet() {
    try {
      return localStorage.getItem(LS_KEY);
    } catch (e) {
      return null;
    }
  }
  function lsSet(v) {
    try {
      localStorage.setItem(LS_KEY, v);
    } catch (e) {}
  }

  // ── Resolve synchronously from the two fast layers so the socket can send
  //    the id immediately on connect. ──
  var lsId = lsGet();
  var ckId = readCookie(CK_KEY);
  if (!valid(lsId)) lsId = null;
  if (!valid(ckId)) ckId = null;

  var freshly = false;
  var id = lsId || ckId;
  if (!id) {
    id = uuid();
    freshly = true;
  }
  lsSet(id);
  writeCookie(CK_KEY, id);

  // localStorage was empty but the cookie still had the id → it was cleared,
  // and the backup saved us. Flag a gentle one-time warning.
  var restored = !lsId && !!ckId;

  window.TalkomaticIdentity = {
    deviceId: id,
    restored: restored,
    activity: null,
    ready: null,
  };

  // ── IndexedDB: deepest backup, reconciled in the background. ──
  function idbOpen() {
    return new Promise(function (res, rej) {
      try {
        var req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = function () {
          try {
            req.result.createObjectStore(STORE);
          } catch (e) {}
        };
        req.onsuccess = function () {
          res(req.result);
        };
        req.onerror = function () {
          rej(req.error);
        };
      } catch (e) {
        rej(e);
      }
    });
  }
  function idbGet(db) {
    return new Promise(function (res) {
      try {
        var r = db.transaction(STORE, "readonly").objectStore(STORE).get(DB_KEY);
        r.onsuccess = function () {
          res(r.result || null);
        };
        r.onerror = function () {
          res(null);
        };
      } catch (e) {
        res(null);
      }
    });
  }
  function idbPut(db, val) {
    return new Promise(function (res) {
      try {
        var tx = db.transaction(STORE, "readwrite");
        tx.objectStore(STORE).put(val, DB_KEY);
        tx.oncomplete = function () {
          res(true);
        };
        tx.onerror = function () {
          res(false);
        };
      } catch (e) {
        res(false);
      }
    });
  }

  window.TalkomaticIdentity.ready = (function () {
    if (!("indexedDB" in window)) return Promise.resolve(id);
    return idbOpen()
      .then(function (db) {
        return idbGet(db).then(function (dbId) {
          if (valid(dbId)) {
            if (freshly && dbId !== id) {
              // Both fast layers were empty but IndexedDB still had us. Recover
              // it so future loads are stable, and flag the wipe. (This session
              // keeps the id it already connected with.)
              id = dbId;
              lsSet(dbId);
              writeCookie(CK_KEY, dbId);
              window.TalkomaticIdentity.deviceId = dbId;
              window.TalkomaticIdentity.restored = true;
            } else if (!freshly && dbId !== id) {
              return idbPut(db, id); // fast layers win; refresh the backup
            }
          } else {
            return idbPut(db, id); // first time on this browser
          }
        });
      })
      .catch(function () {})
      .then(function () {
        return window.TalkomaticIdentity.deviceId;
      });
  })();
})();
