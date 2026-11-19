// The "Neptun → Órarend" bookmarklet: replaces the F12 / Preserve log / HAR export steps.
//
// The user drags a link onto the bookmarks bar, opens Neptun's course sign-up page and clicks it.
// From then on it watches the page's own network responses (XMLHttpRequest and fetch) and keeps
// every GetSubjectsCourses response — the same data the HAR export used to carry. It sends no
// requests of its own and never reads cookies or tokens. A small panel shows what was captured and
// hands it to the timetable app in a new window (postMessage), or saves it as targyak.json.
//
// neptunCapture() runs inside the Neptun page, so it must be self-contained: no imports, no
// references to anything outside its own body. bookmarkletHref() turns it into a javascript: URL.

function neptunCapture(APP) {
  var KEY = "__orarendCapture";
  if (window[KEY]) {
    window[KEY].show();
    return;
  }
  var MARK = "GetSubjectsCourses";
  var APP_ORIGIN = new URL(APP).origin;
  var subjects = new Map();
  var skipped = new Set(); // ids of captured subjects the user unticked
  var delivered = false;

  /* ---------------------------------------------------------- capture */

  function grab(url, text) {
    var data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      return;
    }
    if (!data || !Array.isArray(data.data)) return;
    var id = url;
    try {
      id = new URL(url, location.href).searchParams.get("subjectId") || url;
    } catch (e) {
      /* keep the raw URL as the key */
    }
    subjects.set(id, { subjectId: id, data: data });
    delivered = false;
    render();
  }

  var origFetch = window.fetch;
  if (origFetch) {
    window.fetch = function (input) {
      var p = origFetch.apply(this, arguments);
      try {
        var url = typeof input === "string" ? input : input && input.url;
        if (url && String(url).indexOf(MARK) !== -1) {
          p.then(function (r) {
            return r.ok ? r.clone().text() : null;
          })
            .then(function (t) {
              if (t) grab(String(url), t);
            })
            .catch(function () {});
        }
      } catch (e) {
        /* never break the page's own request */
      }
      return p;
    };
  }

  var XHR = XMLHttpRequest.prototype;
  var origOpen = XHR.open;
  var origSend = XHR.send;
  XHR.open = function (method, url) {
    this.__orarendUrl = String(url);
    return origOpen.apply(this, arguments);
  };
  XHR.send = function () {
    if (this.__orarendUrl && this.__orarendUrl.indexOf(MARK) !== -1) {
      this.addEventListener("load", function () {
        if (this.status !== 200) return;
        var t = null;
        if (this.responseType === "" || this.responseType === "text") t = this.responseText;
        else if (this.responseType === "json") t = JSON.stringify(this.response);
        if (t) grab(this.__orarendUrl, t);
      });
    }
    return origSend.apply(this, arguments);
  };

  /* ---------------------------------------------------------- panel */

  var host = document.createElement("div");
  host.style.cssText = "position:fixed;right:20px;bottom:20px;z-index:2147483647;";
  var root = host.attachShadow({ mode: "open" });
  root.innerHTML =
    "<style>" +
    ":host{all:initial}" +
    ".p{width:300px;box-sizing:border-box;padding:16px;border-radius:18px;background:#fbfbfd;color:#1d1d1f;" +
    "border:1px solid rgba(0,0,0,.06);box-shadow:0 8px 30px rgba(0,0,0,.12);" +
    "font:14px/1.43 -apple-system,BlinkMacSystemFont,'SF Pro Text','Helvetica Neue',Helvetica,Arial,sans-serif;letter-spacing:-.016em}" +
    "@media (prefers-color-scheme:dark){.p{background:#2c2c2e;color:#f5f5f7;border-color:rgba(255,255,255,.08);box-shadow:0 8px 30px rgba(0,0,0,.5)}" +
    ".s,.n{color:#a1a1a6!important}.b2{background:#3a3a3c!important;color:#2997ff!important}.b1{background:#2997ff!important;color:#000!important}.x{background:#3a3a3c!important}.l input{accent-color:#2997ff!important}}" +
    ".h{display:flex;align-items:center;justify-content:space-between;margin-bottom:6px}" +
    ".t{font-size:17px;font-weight:600}" +
    ".x{width:24px;height:24px;border:0;border-radius:980px;background:#f5f5f7;color:#86868b;cursor:pointer;font-family:inherit;font-size:12px;line-height:24px;padding:0}" +
    ".s{color:#86868b}" +
    ".l{margin:8px 0 0;padding:0;list-style:none;max-height:120px;overflow:auto;font-size:12px}" +
    ".l label{display:flex;align-items:center;gap:8px;padding:1px 0;cursor:pointer}" +
    ".l input{flex:none;width:14px;height:14px;margin:0;accent-color:#0071e3;cursor:pointer}" +
    ".l .off span{opacity:.4}" +
    ".a{display:flex;gap:8px;margin-top:12px}" +
    "button.b1,button.b2{flex:1;border:0;border-radius:980px;padding:8px 12px;font-family:inherit;font-size:14px;font-weight:600;line-height:1.2;cursor:pointer}" +
    ".b1{background:#0071e3;color:#fff}.b2{background:#f5f5f7;color:#0071e3}" +
    "button:disabled{opacity:.4;cursor:not-allowed}" +
    ".n{margin-top:10px;font-size:12px;color:#86868b}" +
    "</style>" +
    "<div class='p' role='dialog' aria-label='Órarend-tervező'>" +
    "<div class='h'><span class='t'>Órarend-tervező</span><button class='x' title='Bezárás' aria-label='Bezárás'>✕</button></div>" +
    "<div class='s' aria-live='polite'></div><ul class='l'></ul>" +
    "<div class='a'><button class='b1'>Megnyitás</button><button class='b2'>Letöltés</button></div>" +
    "<div class='n'>Ha egy tárgyat a gomb előtt már lenyitottál, és nem jelenik meg, frissítsd az oldalt (F5), kattints újra a könyvjelzőre, és nyisd le újra.</div>" +
    "</div>";
  var $ = function (sel) {
    return root.querySelector(sel);
  };
  var note = "";

  function titleOf(s) {
    var first = s.data.data[0];
    return (first && first.title) || s.subjectId;
  }

  function render() {
    var n = subjects.size;
    var picked = payload().length;
    var off = n - picked ? " (" + (n - picked) + " kihagyva)" : "";
    $(".s").textContent =
      note ||
      (n === 0
        ? "Figyelem a Neptunt. Nyisd le egyesével a tárgyakat, amiket fel akarsz venni."
        : picked + " tárgy rögzítve" + off + (delivered ? ", átküldve ✓" : ". Nyisd le a többit is, aztán: Megnyitás."));
    var list = $(".l");
    list.replaceChildren();
    subjects.forEach(function (s, id) {
      var li = document.createElement("li");
      // Unticking leaves out a subject opened by mistake; ticking it again brings it back.
      var label = document.createElement("label");
      if (skipped.has(id)) label.className = "off";
      var box = document.createElement("input");
      box.type = "checkbox";
      box.checked = !skipped.has(id);
      box.addEventListener("change", function () {
        if (box.checked) skipped.delete(id);
        else skipped.add(id);
        delivered = false;
        render();
      });
      var name = document.createElement("span");
      name.textContent = titleOf(s);
      label.append(box, name);
      li.append(label);
      list.append(li);
    });
    list.style.display = n ? "" : "none";
    $(".b1").disabled = picked === 0;
    $(".b2").disabled = picked === 0;
  }

  function payload() {
    return Array.from(subjects.values()).filter(function (s) {
      return !skipped.has(s.subjectId);
    });
  }

  function send() {
    note = "";
    var w = window.open(APP + "#import", "orarend-tervezo");
    if (!w) {
      note = "A böngésző letiltotta az új ablakot. Engedélyezd a felugró ablakokat, vagy használd a Letöltés gombot.";
      render();
      return;
    }
    var waiting = true;
    function onMessage(e) {
      if (e.origin !== APP_ORIGIN || !e.data) return;
      if (e.data.type === "orarend-ready") {
        e.source.postMessage({ type: "orarend-import", subjects: payload() }, APP_ORIGIN);
      } else if (e.data.type === "orarend-received") {
        waiting = false;
        delivered = true;
        note = "";
        window.removeEventListener("message", onMessage);
        render();
      }
    }
    window.addEventListener("message", onMessage);
    setTimeout(function () {
      if (!waiting) return;
      window.removeEventListener("message", onMessage);
      note = "Nem sikerült átadni az adatot az új ablaknak. Kattints a Letöltés gombra, és húzd be a fájlt az oldalra.";
      render();
    }, 10000);
  }

  function download() {
    var blob = new Blob([JSON.stringify(payload())], { type: "application/json" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "targyak.json";
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(function () {
      URL.revokeObjectURL(a.href);
    }, 1000);
  }

  $(".x").addEventListener("click", function () {
    host.remove();
  });
  $(".b1").addEventListener("click", send);
  $(".b2").addEventListener("click", download);

  window[KEY] = {
    show: function () {
      if (!host.isConnected) document.body.append(host);
      render();
    },
  };
  window[KEY].show();
}

/** The bookmarklet as a javascript: URL that sends its capture to `appUrl` (this page's address). */
export function bookmarkletHref(appUrl) {
  return "javascript:" + encodeURIComponent(`(${neptunCapture.toString()})(${JSON.stringify(appUrl)});void 0`);
}
