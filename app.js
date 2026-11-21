(() => {
  "use strict";
  const CFG = window.EXKURSION_CONFIG;
  const $ = (id) => document.getElementById(id);
  const h = (tag, props = {}, ...kids) => {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === "class") el.className = v;
      else if (k === "text") el.textContent = v;
      else if (k === "style") el.style.cssText = v;
      else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? "" : v);
    }
    for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : String(kid));
    return el;
  };
  const SWATCHES = ["#d7263d", "#f46036", "#e9b44c", "#3bb273", "#1b998b", "#2e86de", "#5b4bd5", "#b53fbf", "#8d6e63", "#4a5560"];
  const SUGGEST = ["Sehenswürdigkeit", "Kirche", "Brunnen", "Geschäft", "Gastronomie", "Grünfläche", "Haltestelle", "Baustelle"];
  const NOCAT = { id: "", name: "Ohne Kategorie", farbe: "#8a9599" };
  const POLL_MS = 15000;

  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch {} },
    del(k) { try { localStorage.removeItem(k); } catch {} },
  };
  function uuid() {
    if (crypto.randomUUID) return crypto.randomUUID();
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
      const r = (crypto.getRandomValues(new Uint8Array(1))[0] & 15);
      return (c === "x" ? r : (r & 3) | 8).toString(16);
    });
  }
  let device = store.get("geraet");
  if (!device) { device = uuid(); store.set("geraet", device); }

  const sb = window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseKey, { auth: { persistSession: false } });

  const st = {
    code: store.get("code") || "", rolle: null, group: store.get("gruppe") || "",
    places: [], cats: [], task: "", hidden: new Set(),
    tab: store.get("tab") === "places" ? "places" : "legend",
    addMode: false, sheet: null, selected: null, moving: null,
    showLabels: store.get("labels") !== "0", newColor: SWATCHES[0],
    me: null, follow: false,
  };
  const isTeacher = () => st.rolle === "lehrer";
  const canModify = (p) => isTeacher() || p.geraet === device;

  // ---------- helpers ----------
  let toastT;
  function toast(msg, err) {
    const t = $("toast"); t.textContent = msg; t.className = "toast" + (err ? " err" : ""); t.hidden = false;
    clearTimeout(toastT); toastT = setTimeout(() => (t.hidden = true), err ? 5000 : 2600);
  }
  function errText(e) {
    const m = (e && (e.message || e.error_description || e.error)) || "";
    if (/Klassencode/.test(m)) return "Der Klassencode stimmt nicht mehr. Bitte neu anmelden.";
    if (/Nur die/.test(m)) return m + ".";
    if (/duplicate key|eindeutig/.test(m)) return "Diese Kategorie gibt es schon.";
    if (/Payload too large|exceeded the maximum/.test(m)) return "Das Foto ist zu groß.";
    if (/mime type/i.test(m)) return "Dieses Bildformat wird nicht unterstützt. Bitte JPG oder PNG verwenden.";
    if (/Failed to fetch|NetworkError|network/i.test(m)) return "Keine Internetverbindung. Bitte gleich noch einmal versuchen.";
    return "Das hat nicht geklappt. Bitte erneut versuchen.";
  }
  async function rpc(fn, args) {
    const { data, error } = await sb.rpc(fn, args);
    if (error) throw error;
    return data;
  }
  const catById = (id) => st.cats.find((c) => c.id === id) || NOCAT;
  const fotoUrl = (path) => sb.storage.from("fotos").getPublicUrl(path).data.publicUrl;
  const fmtTime = (iso) => iso ? new Date(iso).toLocaleString("de-DE", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "";
  function distM(a, b) {
    const R = 6371000, toR = Math.PI / 180;
    const dLat = (b.lat - a.lat) * toR, dLng = (b.lng - a.lng) * toR;
    const s = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * toR) * Math.cos(b.lat * toR) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(s));
  }
  const fmtDist = (m) => m < 1000 ? Math.round(m / 5) * 5 + " m" : (m / 1000).toFixed(1).replace(".", ",") + " km";

  async function resizeImage(file, maxSide, quality) {
    const url = URL.createObjectURL(file);
    try {
      const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
      const w = img.naturalWidth, hh = img.naturalHeight;
      const s = Math.min(1, maxSide / Math.max(w, hh));
      const cw = Math.round(w * s), ch = Math.round(hh * s);
      const c = document.createElement("canvas"); c.width = cw; c.height = ch;
      const ctx = c.getContext("2d"); ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, cw, ch); ctx.drawImage(img, 0, 0, cw, ch);
      return await new Promise((r, rej) => c.toBlob((b) => (b ? r(b) : rej(new Error("toBlob"))), "image/jpeg", quality));
    } finally { URL.revokeObjectURL(url); }
  }
  function pinSvg(color) {
    return `<svg viewBox="0 0 28 36" aria-hidden="true"><path d="M14 1C6.8 1 1 6.6 1 13.6 1 23 14 35 14 35s13-12 13-21.4C27 6.6 21.2 1 14 1z" fill="${color}" stroke="#fff" stroke-width="2"/><circle cx="14" cy="13.5" r="4.6" fill="#fff"/></svg>`;
  }
  const safeColor = (c) => (/^#[0-9a-f]{6}$/i.test(c) ? c : NOCAT.farbe);

  // ---------- map ----------
  const map = L.map("map", { zoomControl: true, attributionControl: true }).setView([CFG.start.lat, CFG.start.lng], CFG.start.zoom);
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>-Mitwirkende',
  }).addTo(map);
  map.zoomControl.setPosition("topleft");
  const pinLayer = L.layerGroup().addTo(map);
  const mapEl = $("map");
  mapEl.classList.toggle("hide-labels", !st.showLabels);

  function renderPins() {
    pinLayer.clearLayers();
    for (const p of st.places) {
      if (st.hidden.has(p.kategorie_id || "")) continue;
      const cat = catById(p.kategorie_id);
      const icon = L.divIcon({
        className: "pin-icon", iconSize: [28, 36], iconAnchor: [14, 36],
        html: `<div class="pin${st.selected === p.id ? " sel" : ""}">${pinSvg(safeColor(cat.farbe))}<span class="lbl"></span></div>`,
      });
      const m = L.marker([p.lat, p.lng], { icon, title: p.name, keyboard: true, zIndexOffset: st.selected === p.id ? 1000 : 0 });
      m.on("add", () => { const l = m.getElement() && m.getElement().querySelector(".lbl"); if (l) l.textContent = p.name; });
      m.on("click", () => { if (!st.addMode) openDetail(p.id); });
      m.addTo(pinLayer);
    }
    if (st.sheet && st.sheet.kind === "form" && st.sheet.pos) {
      const cat = catById(st.sheet.draft.kategorie_id);
      L.marker([st.sheet.pos.lat, st.sheet.pos.lng], {
        interactive: false, zIndexOffset: 2000,
        icon: L.divIcon({ className: "pin-icon", iconSize: [28, 36], iconAnchor: [14, 36], html: `<div class="pin sel">${pinSvg(safeColor(cat.farbe))}</div>` }),
      }).addTo(pinLayer);
    }
  }

  map.on("click", (e) => {
    if (st.addMode) placeAt({ lat: e.latlng.lat, lng: e.latlng.lng });
    else if (st.sheet && st.sheet.kind === "detail") closeSheet();
  });

  // ---------- GPS ----------
  let meDot = null, meCircle = null, watchId = null;
  function startLocate(center) {
    if (!navigator.geolocation) { toast("Dieses Gerät kann den Standort nicht bestimmen.", true); return; }
    st.follow = !!center;
    if (watchId != null) { if (st.me && center) map.setView([st.me.lat, st.me.lng], Math.max(map.getZoom(), 17)); return; }
    $("locBtn").classList.add("on");
    watchId = navigator.geolocation.watchPosition((pos) => {
      const first = !st.me;
      st.me = { lat: pos.coords.latitude, lng: pos.coords.longitude, acc: pos.coords.accuracy };
      const ll = [st.me.lat, st.me.lng];
      if (!meDot) {
        meCircle = L.circle(ll, { radius: st.me.acc, color: "#1a73e8", weight: 1, fillOpacity: .12, interactive: false }).addTo(map);
        meDot = L.circleMarker(ll, { radius: 8, color: "#fff", weight: 3, fillColor: "#1a73e8", fillOpacity: 1, interactive: false }).addTo(map);
      } else { meDot.setLatLng(ll); meCircle.setLatLng(ll).setRadius(st.me.acc); }
      if (first && st.follow) map.setView(ll, Math.max(map.getZoom(), 17));
      $("hereBtn").hidden = !st.addMode;
      if (st.tab === "places") renderPanel();
    }, (err) => {
      $("locBtn").classList.remove("on"); watchId = null;
      toast(err.code === 1 ? "Standort nicht erlaubt. Bitte in den Browser-Einstellungen freigeben." : "Standort konnte nicht bestimmt werden.", true);
    }, { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 });
  }
  $("locBtn").onclick = () => startLocate(true);
  $("fitBtn").onclick = () => {
    const pts = st.places.filter((p) => !st.hidden.has(p.kategorie_id || "")).map((p) => [p.lat, p.lng]);
    if (st.me) pts.push([st.me.lat, st.me.lng]);
    if (pts.length) map.fitBounds(L.latLngBounds(pts).pad(0.15), { maxZoom: 17 });
    else map.setView([CFG.start.lat, CFG.start.lng], CFG.start.zoom);
  };
  $("lblBtn").onclick = () => { st.showLabels = !st.showLabels; store.set("labels", st.showLabels ? "1" : "0"); mapEl.classList.toggle("hide-labels", !st.showLabels); };

  // ---------- add mode ----------
  function setAddMode(on, text) {
    st.addMode = on; mapEl.classList.toggle("adding", on); $("hint").hidden = !on;
    $("hintText").textContent = text || "Tippe auf die Karte, wo der Ort liegt";
    $("hereBtn").hidden = !on || !st.me;
    $("addBtn").textContent = on ? "Abbrechen" : "+ Ort eintragen";
    $("addBtn").classList.toggle("primary", !on);
  }
  $("addBtn").onclick = () => {
    if (st.addMode) {
      setAddMode(false); st.moving = null;
      if (st.sheet && st.sheet.repick) { st.sheet.repick = false; $("sheet").hidden = false; }
    } else { closeSheet(); setAddMode(true); if (watchId == null) startLocate(false); }
  };
  $("hereBtn").onclick = (e) => { e.stopPropagation(); if (st.me) placeAt({ lat: st.me.lat, lng: st.me.lng }); };

  async function placeAt(pos) {
    setAddMode(false);
    if (st.moving) {
      const p = st.moving; st.moving = null;
      try {
        await rpc("ort_speichern", { p_code: st.code, p_ort: { ...p, lat: pos.lat, lng: pos.lng, geraet: device } });
        toast("Neue Position gespeichert"); await load(); openDetail(p.id);
      } catch (e) { toast(errText(e), true); }
      return;
    }
    if (st.sheet && st.sheet.kind === "form" && st.sheet.repick) {
      st.sheet.pos = pos; st.sheet.repick = false; renderForm(); renderPins(); return;
    }
    openForm(pos);
  }

  // ---------- panel ----------
  const tabLegend = $("tabLegend"), tabPlaces = $("tabPlaces"), panel = $("panel");
  function setTab(t) {
    if (st.tab === t && matchMedia("(max-width: 760px)").matches) panel.classList.toggle("collapsed");
    else panel.classList.remove("collapsed");
    st.tab = t; store.set("tab", t);
    renderPanel();
    setTimeout(() => map.invalidateSize(), 50);
  }
  tabLegend.onclick = () => setTab("legend");
  tabPlaces.onclick = () => setTab("places");
  const countFor = (id) => st.places.filter((p) => (p.kategorie_id || "") === id).length;

  function renderPanel() {
    tabLegend.setAttribute("aria-selected", String(st.tab === "legend")); tabPlaces.setAttribute("aria-selected", String(st.tab === "places"));
    $("cntCats").textContent = st.cats.length; $("cntPlaces").textContent = st.places.length;
    const body = $("panelBody");
    const active = document.activeElement;
    if (st.tab === "places" && active && body.contains(active) && (active.id === "placeSearch" || active.id === "placeCat")) { fillPlaces && fillPlaces(); return; }
    if (st.tab === "legend" && active && body.contains(active) && active.tagName === "INPUT") return;
    body.replaceChildren(...(st.tab === "legend" ? legendView() : placesView()));
  }
  function legendView() {
    const out = [h("div", { class: "section-title", text: "Legende" })];
    const list = h("div", { class: "legend" });
    const rows = [...st.cats];
    if (countFor("")) rows.push(NOCAT);
    if (!rows.length) out.push(h("p", { class: "note", text: "Noch keine Kategorien. Legt fest, welche Farbe was bedeutet, zum Beispiel Rot für historische Gebäude." }));
    for (const c of rows) {
      const off = st.hidden.has(c.id);
      list.append(h("div", { class: "legend-row" + (off ? " off" : "") },
        h("span", { class: "swatch", style: `background:${safeColor(c.farbe)}` }),
        h("span", { class: "name", text: c.name }),
        h("span", { class: "n", text: String(countFor(c.id)) }),
        h("button", { class: "eye", "aria-pressed": String(!off), text: off ? "einblenden" : "ausblenden",
          onclick: () => { off ? st.hidden.delete(c.id) : st.hidden.add(c.id); renderPins(); body().replaceChildren(...legendView()); } })));
    }
    out.push(list, newCatForm());
    if (isTeacher() && st.cats.length) {
      out.push(h("div", { class: "section-title", text: "Kategorien verwalten" }),
        h("p", { class: "note", text: "Nur für die Lehrkraft. Orte einer gelöschten Kategorie landen unter „Ohne Kategorie“." }));
      for (const c of st.cats) out.push(manageCatRow(c));
    }
    return out;
  }
  const body = () => $("panelBody");
  function newCatForm(onCreated) {
    const nameIn = h("input", { type: "text", id: onCreated ? "f-newcat" : "newcat", placeholder: "Bedeutung, z. B. Brunnen", maxlength: "40" });
    const sw = h("div", { class: "swatches", role: "group", "aria-label": "Farbe wählen" });
    const custom = h("input", { type: "color", value: st.newColor, "aria-label": "Eigene Farbe" });
    const paint = () => sw.querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.c === st.newColor)));
    for (const c of SWATCHES) sw.append(h("button", { type: "button", "data-c": c, style: `background:${c}`, "aria-label": "Farbe " + c,
      onclick: () => { st.newColor = c; custom.value = c; paint(); } }));
    custom.addEventListener("input", () => { st.newColor = custom.value; paint(); });
    sw.append(custom); paint();
    const add = async (name) => {
      name = (name || nameIn.value).trim();
      if (!name) { nameIn.focus(); toast("Gib der Kategorie einen Namen."); return; }
      if (st.cats.some((c) => c.name.toLowerCase() === name.toLowerCase())) { toast("Diese Kategorie gibt es schon."); return; }
      try {
        const id = await rpc("kategorie_speichern", { p_code: st.code, p_id: null, p_name: name, p_farbe: st.newColor });
        nameIn.value = "";
        const used = new Set(st.cats.map((c) => c.farbe).concat(st.newColor));
        st.newColor = SWATCHES.find((c) => !used.has(c)) || st.newColor;
        toast("Kategorie „" + name + "“ angelegt");
        nameIn.blur();
        await load();
        if (onCreated) onCreated(id);
      } catch (e) { toast(errText(e), true); }
    };
    nameIn.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); add(); } });
    const unused = SUGGEST.filter((s) => !st.cats.some((c) => c.name.toLowerCase() === s.toLowerCase())).slice(0, 5);
    return h("div", { class: "newcat" },
      h("label", { class: "field" }, h("span", { text: "Neue Kategorie" }), nameIn),
      sw,
      unused.length ? h("div", { class: "suggest" }, ...unused.map((s) => h("button", { type: "button", text: "+ " + s, onclick: () => add(s) }))) : null,
      h("div", { class: "row" }, h("button", { type: "button", class: "btn small primary", text: "Kategorie anlegen", onclick: () => add() })));
  }
  function manageCatRow(c) {
    const nameIn = h("input", { type: "text", value: c.name, maxlength: "40", "aria-label": "Name der Kategorie" });
    const color = h("input", { type: "color", value: safeColor(c.farbe), "aria-label": "Farbe" });
    let confirmDel = false;
    const del = h("button", { type: "button", class: "btn small danger", text: "Löschen", onclick: async () => {
      if (!confirmDel) { confirmDel = true; del.textContent = "Wirklich?"; return; }
      try { await rpc("kategorie_loeschen", { p_code: st.code, p_id: c.id }); toast("Kategorie gelöscht"); await load(); } catch (e) { toast(errText(e), true); }
    } });
    const save = async () => {
      const name = nameIn.value.trim(); if (!name || (name === c.name && color.value === c.farbe)) return;
      try { await rpc("kategorie_speichern", { p_code: st.code, p_id: c.id, p_name: name, p_farbe: color.value }); toast("Gespeichert"); nameIn.blur(); await load(); }
      catch (e) { toast(errText(e), true); }
    };
    nameIn.addEventListener("change", save); color.addEventListener("change", save);
    return h("div", { class: "row", style: "margin-bottom:8px" }, color, h("div", { style: "flex:1;min-width:8em" }, nameIn), del);
  }
  const placeFilter = { q: "", cat: "*" };
  let fillPlaces = null;
  function placesView() {
    const q = h("input", { type: "search", id: "placeSearch", placeholder: "Suchen …", value: placeFilter.q, "aria-label": "Orte durchsuchen" });
    const sel = h("select", { id: "placeCat", "aria-label": "Nach Kategorie filtern" },
      h("option", { value: "*", text: "Alle Kategorien" }), ...st.cats.map((c) => h("option", { value: c.id, text: c.name })), h("option", { value: "", text: NOCAT.name }));
    sel.value = placeFilter.cat;
    const list = h("div", { class: "places" });
    fillPlaces = () => {
      list.replaceChildren();
      const needle = placeFilter.q.toLowerCase();
      let items = st.places.filter((p) => (placeFilter.cat === "*" || (p.kategorie_id || "") === placeFilter.cat) &&
        (!needle || (p.name + " " + p.notiz + " " + p.gruppe).toLowerCase().includes(needle)));
      items = st.me ? items.sort((a, b) => distM(st.me, a) - distM(st.me, b)) : items.sort((a, b) => (b.erstellt > a.erstellt ? 1 : -1));
      if (!items.length) list.append(h("p", { class: "note", text: st.places.length ? "Keine Treffer." : "Noch keine Orte eingetragen. Tippe auf „+ Ort eintragen“ und dann auf die Karte." }));
      for (const p of items) {
        const cat = catById(p.kategorie_id), n = p.fotos.length;
        list.append(h("button", { class: "place-row", onclick: () => { map.setView([p.lat, p.lng], Math.max(map.getZoom(), 17)); openDetail(p.id); } },
          h("span", { class: "swatch", style: `background:${safeColor(cat.farbe)}` }),
          h("span", { class: "t" }, h("b", { text: p.name }), h("span", { text: [p.gruppe, n ? n + (n === 1 ? " Foto" : " Fotos") : ""].filter(Boolean).join(" · ") || cat.name })),
          h("span", { class: "dist", text: st.me ? fmtDist(distM(st.me, p)) : "" })));
      }
    };
    q.addEventListener("input", () => { placeFilter.q = q.value; fillPlaces(); });
    sel.addEventListener("change", () => { placeFilter.cat = sel.value; fillPlaces(); });
    fillPlaces();
    return [h("div", { class: "filter" }, q, sel), list];
  }

  // ---------- sheet ----------
  const sheet = $("sheet");
  function closeSheet() { st.sheet = null; st.selected = null; sheet.hidden = true; sheet.replaceChildren(); renderPins(); }
  function openDetail(id) { st.sheet = { kind: "detail", id }; st.selected = id; renderSheet(); renderPins(); }
  function photoFig(path, onRemove) {
    const img = h("img", { src: fotoUrl(path), alt: "Foto", loading: "lazy" });
    const fig = h("figure", {}, onRemove ? img : h("button", { class: "open", "aria-label": "Foto groß anzeigen", onclick: () => openLightbox(path) }, img));
    img.onerror = () => fig.replaceChildren(h("div", { class: "photo-missing", text: "Foto nicht verfügbar" }));
    if (onRemove) fig.append(h("button", { type: "button", class: "rm", "aria-label": "Foto entfernen", text: "✕", onclick: onRemove }));
    return fig;
  }
  function renderSheet() {
    if (!st.sheet) return closeSheet();
    if (st.sheet.kind === "form") return renderForm();
    if (st.sheet.kind !== "detail") return;
    const p = st.places.find((x) => x.id === st.sheet.id);
    if (!p) return closeSheet();
    const cat = catById(p.kategorie_id);
    const kids = [
      h("div", { class: "sheet-head" }, h("h2", { text: p.name }), h("button", { class: "close", "aria-label": "Schließen", text: "✕", onclick: closeSheet })),
      h("div", { class: "meta" },
        h("span", { class: "cat-pill" }, h("span", { class: "swatch", style: `background:${safeColor(cat.farbe)}` }), cat.name),
        p.gruppe ? h("span", { text: p.gruppe }) : null,
        h("span", { text: fmtTime(p.erstellt) }),
        st.me ? h("span", { class: "dist", text: fmtDist(distM(st.me, p)) + " entfernt" }) : null),
    ];
    if (p.notiz) kids.push(h("p", { class: "desc", text: p.notiz }));
    if (p.fotos.length) kids.push(h("div", { class: "photos" }, ...p.fotos.map((f) => photoFig(f))));
    if (canModify(p)) {
      let confirmDel = false;
      const del = h("button", { class: "btn small danger", text: "Löschen", onclick: async () => {
        if (!confirmDel) { confirmDel = true; del.textContent = "Wirklich löschen?"; return; }
        try { await rpc("ort_loeschen", { p_code: st.code, p_id: p.id, p_geraet: device }); closeSheet(); toast("Ort gelöscht"); await load(); }
        catch (e) { toast(errText(e), true); }
      } });
      kids.push(h("div", { class: "row" },
        h("button", { class: "btn small", text: "Bearbeiten", onclick: () => openForm(null, p) }),
        h("button", { class: "btn small", text: "Verschieben", onclick: () => { closeSheet(); st.moving = p; setAddMode(true, "Tippe auf die neue Position von „" + p.name + "“"); } }),
        h("span", { class: "spacer" }), del));
    }
    sheet.replaceChildren(...kids); sheet.hidden = false;
  }

  function openForm(pos, existing) {
    const lastCat = store.get("lastCat");
    st.selected = null;
    st.sheet = {
      kind: "form", pos: existing ? { lat: existing.lat, lng: existing.lng } : pos, editId: existing ? existing.id : null,
      draft: existing
        ? { name: existing.name, notiz: existing.notiz, kategorie_id: existing.kategorie_id || "", fotos: [...existing.fotos] }
        : { name: "", notiz: "", kategorie_id: st.cats.some((c) => c.id === lastCat) ? lastCat : (st.cats[0] ? st.cats[0].id : ""), fotos: [] },
      newFiles: [], busy: false, showNewCat: false,
    };
    renderForm(); renderPins();
    if (!existing) setTimeout(() => { const n = $("f-name"); if (n) n.focus({ preventScroll: true }); }, 30);
  }
  function renderForm() {
    const f = st.sheet, d = f.draft;
    const nameIn = h("input", { type: "text", id: "f-name", value: d.name, maxlength: "80", placeholder: "z. B. Elisenbrunnen", required: true });
    nameIn.addEventListener("input", () => (d.name = nameIn.value));
    const noteIn = h("textarea", { id: "f-note", maxlength: "1500", placeholder: "Was habt ihr beobachtet? Warum gehört der Ort zur Aufgabe?" });
    noteIn.value = d.notiz; noteIn.addEventListener("input", () => (d.notiz = noteIn.value));
    const pick = h("div", { class: "catpick", role: "group", "aria-label": "Kategorie" });
    for (const c of [...st.cats, NOCAT]) {
      pick.append(h("button", { type: "button", "aria-pressed": String(d.kategorie_id === c.id),
        onclick: () => { d.kategorie_id = c.id; renderForm(); renderPins(); } },
        h("span", { class: "swatch", style: `background:${safeColor(c.farbe)}` }), c.name));
    }
    pick.append(h("button", { type: "button", text: f.showNewCat ? "– Neue Kategorie" : "+ Neue Kategorie", onclick: () => { f.showNewCat = !f.showNewCat; renderForm(); } }));
    const photos = h("div", { class: "photos" },
      ...d.fotos.map((path, i) => photoFig(path, () => { d.fotos.splice(i, 1); renderForm(); })),
      ...f.newFiles.map((nf, i) => h("figure", {}, h("img", { src: nf.url, alt: "Neues Foto" }),
        h("button", { type: "button", class: "rm", "aria-label": "Foto entfernen", text: "✕", onclick: () => { URL.revokeObjectURL(nf.url); f.newFiles.splice(i, 1); renderForm(); } }))));
    const inp = h("input", { type: "file", id: "f-photos", accept: "image/*", multiple: true, "aria-label": "Foto aufnehmen oder auswählen" });
    inp.addEventListener("change", () => {
      for (const file of inp.files) if (!file.type || file.type.startsWith("image/")) f.newFiles.push({ file, url: URL.createObjectURL(file) });
      renderForm();
    });
    const form = h("form", { style: "display:grid;gap:14px", onsubmit: (e) => { e.preventDefault(); saveForm(); } },
      h("div", { class: "sheet-head" }, h("h2", { text: f.editId ? "Ort bearbeiten" : "Neuer Ort" }),
        h("button", { type: "button", class: "close", "aria-label": "Abbrechen", text: "✕", onclick: cancelForm })),
      !f.editId ? h("div", { class: "row" },
        h("button", { type: "button", class: "btn small", text: "Position ändern", onclick: () => { f.repick = true; sheet.hidden = true; setAddMode(true); } })) : null,
      h("label", { class: "field" }, h("span", { text: "Name des Ortes" }), nameIn),
      h("div", { class: "field" }, h("span", { text: "Kategorie / Farbe" }), pick),
      f.showNewCat ? newCatForm((id) => { d.kategorie_id = id; f.showNewCat = false; renderForm(); renderPins(); }) : null,
      h("label", { class: "field" }, h("span", { text: "Beschreibung" }), noteIn),
      h("div", { class: "field" }, h("span", { text: "Fotos" }), photos,
        h("div", { class: "row" }, h("span", { class: "btn small file-btn" }, "📷 Foto hinzufügen", inp), h("span", { class: "note", text: "Kamera oder Galerie" }))),
      h("div", { class: "progress", id: "f-status" }),
      h("div", { class: "row" },
        h("button", { type: "submit", class: "btn primary", text: f.editId ? "Änderungen speichern" : "Ort speichern", disabled: f.busy }),
        h("button", { type: "button", class: "btn", text: "Abbrechen", onclick: cancelForm })));
    sheet.replaceChildren(form); sheet.hidden = false;
  }
  function cancelForm() {
    if (st.sheet && st.sheet.newFiles) st.sheet.newFiles.forEach((nf) => URL.revokeObjectURL(nf.url));
    const back = st.sheet && st.sheet.editId; closeSheet(); if (back) openDetail(back);
  }
  async function saveForm() {
    const f = st.sheet, d = f.draft, name = d.name.trim();
    if (!name) { toast("Bitte gib dem Ort einen Namen."); $("f-name").focus(); return; }
    if (f.busy) return;
    f.busy = true; renderForm();
    const status = (t) => { const s = $("f-status"); if (s) s.textContent = t; };
    try {
      const fotos = [...d.fotos];
      for (let i = 0; i < f.newFiles.length; i++) {
        status(`Foto ${i + 1} von ${f.newFiles.length} wird hochgeladen …`);
        let blob = f.newFiles[i].file;
        try { blob = await resizeImage(blob, 1600, 0.82); } catch {}
        const type = blob.type === "image/png" ? "image/png" : blob.type === "image/webp" ? "image/webp" : "image/jpeg";
        const path = uuid() + (type === "image/png" ? ".png" : type === "image/webp" ? ".webp" : ".jpg");
        const { error } = await sb.storage.from("fotos").upload(path, blob, { contentType: type, upsert: false });
        if (error) throw error;
        fotos.push(path);
      }
      status("Wird gespeichert …");
      const ort = { id: f.editId || "", name, notiz: d.notiz.trim(), kategorie_id: d.kategorie_id || "", lat: f.pos.lat, lng: f.pos.lng,
        gruppe: st.group, fotos, geraet: device };
      const id = await rpc("ort_speichern", { p_code: st.code, p_ort: ort });
      store.set("lastCat", d.kategorie_id || "");
      f.newFiles.forEach((nf) => URL.revokeObjectURL(nf.url));
      toast(f.editId ? "Änderungen gespeichert" : "„" + name + "“ eingetragen");
      st.sheet = null;
      await load();
      openDetail(id);
    } catch (e) {
      f.busy = false; renderForm(); toast(errText(e), true);
    }
  }

  function openLightbox(path) { $("lbImg").src = fotoUrl(path); $("lightbox").hidden = false; }
  $("lbClose").onclick = () => { $("lightbox").hidden = true; $("lbImg").removeAttribute("src"); };
  $("lightbox").onclick = (e) => { if (e.target.id === "lightbox") $("lbClose").onclick(); };
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (!$("lightbox").hidden) return $("lbClose").onclick();
    if (st.addMode) return $("addBtn").onclick();
    if (st.sheet) st.sheet.kind === "form" ? cancelForm() : closeSheet();
  });

  // ---------- teacher ----------
  function csvCell(v) { const s = String(v == null ? "" : v); return /[";\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }
  function exportCsv() {
    const rows = [["Name", "Kategorie", "Gruppe", "Beschreibung", "Breitengrad", "Längengrad", "Fotos", "Erstellt"]];
    for (const p of st.places) rows.push([p.name, catById(p.kategorie_id).name, p.gruppe, p.notiz, p.lat.toFixed(6), p.lng.toFixed(6),
      p.fotos.map(fotoUrl).join(" "), fmtTime(p.erstellt)]);
    const csv = "﻿" + rows.map((r) => r.map(csvCell).join(";")).join("\r\n");
    const a = h("a", { href: URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" })), download: "exkursion-aachen-orte.csv" });
    document.body.append(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }
  $("teacherBtn").onclick = () => {
    setAddMode(false);
    st.sheet = { kind: "teacher" };
    const taskIn = h("textarea", { id: "t-task", placeholder: "z. B. Findet fünf Orte, an denen man Spuren der Römerzeit sieht. Fotografiert sie und ordnet sie einer Kategorie zu." });
    taskIn.value = st.task;
    const groups = [...new Set(st.places.map((p) => p.gruppe).filter(Boolean))].sort((a, b) => a.localeCompare(b, "de"));
    sheet.replaceChildren(
      h("div", { class: "sheet-head" }, h("h2", { text: "Lehrkraft" }), h("button", { class: "close", "aria-label": "Schließen", text: "✕", onclick: closeSheet })),
      h("label", { class: "field" }, h("span", { text: "Aufgabenstellung für alle" }), taskIn),
      h("div", { class: "row" }, h("button", { class: "btn small primary", text: "Aufgabe veröffentlichen", onclick: async () => {
        try { await rpc("aufgabe_setzen", { p_code: st.code, p_text: taskIn.value.trim() }); toast(taskIn.value.trim() ? "Aufgabe veröffentlicht" : "Aufgabe entfernt"); await load(); }
        catch (e) { toast(errText(e), true); }
      } })),
      h("div", { class: "field" }, h("span", { text: "Stand" }),
        h("p", { class: "note", text: `${st.places.length} Orte, ${st.places.reduce((n, p) => n + p.fotos.length, 0)} Fotos, ${groups.length} Gruppen${groups.length ? ": " + groups.join(", ") : ""}.` })),
      h("div", { class: "row" }, h("button", { class: "btn small", text: "Liste herunterladen (CSV)", onclick: exportCsv })),
      h("p", { class: "note", text: "Als Lehrkraft kannst du alle Orte bearbeiten und löschen sowie Kategorien umbenennen oder entfernen." }));
    sheet.hidden = false;
  };

  // ---------- data ----------
  let loading = false;
  async function load() {
    if (!st.code || loading) return;
    loading = true;
    try {
      const d = await rpc("daten_laden", { p_code: st.code });
      st.rolle = d.rolle;
      st.cats = (d.kategorien || []).map((c) => ({ id: c.id, name: String(c.name), farbe: safeColor(c.farbe) }));
      st.places = (d.orte || []).map((o) => ({
        id: o.id, name: String(o.name || "Ohne Namen"), notiz: String(o.notiz || ""), gruppe: String(o.gruppe || ""),
        kategorie_id: o.kategorie_id || "", lat: +o.lat, lng: +o.lng, fotos: Array.isArray(o.fotos) ? o.fotos.filter((x) => /^[\w-]+\.(jpg|png|webp)$/.test(x)) : [],
        geraet: o.geraet || "", erstellt: o.erstellt,
      }));
      st.task = d.aufgabe || "";
      renderAll();
    } catch (e) {
      if (/Klassencode/.test((e && e.message) || "")) { logout(); $("loginErr").textContent = "Der Klassencode ist nicht mehr gültig."; $("loginErr").hidden = false; }
      else if (!document.hidden) toast(errText(e), true);
    } finally { loading = false; }
  }
  function renderAll() {
    $("taskBar").hidden = !st.task; $("taskText").textContent = st.task;
    $("teacherBtn").hidden = !isTeacher();
    $("whoami").textContent = (isTeacher() ? "Lehrkraft" : st.group || "Gruppe ohne Namen") + " · " + st.places.length + " Orte";
    renderPins(); renderPanel();
    if (st.sheet && st.sheet.kind === "detail") renderSheet();
    setTimeout(() => map.invalidateSize(), 0);
  }
  setInterval(() => { if (!document.hidden && !(st.sheet && st.sheet.kind === "form")) load(); }, POLL_MS);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) load(); });

  // ---------- login ----------
  function showApp(on) { $("login").hidden = on; $("addBtn").hidden = !on; $("logoutBtn").hidden = !on; }
  function logout() { st.code = ""; st.rolle = null; store.del("code"); showApp(false); $("codeIn").value = ""; $("teacherBtn").hidden = true; }
  $("logoutBtn").onclick = () => { closeSheet(); logout(); };
  $("groupIn").value = st.group;
  $("loginForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const code = $("codeIn").value.trim(), btn = $("loginBtn"), err = $("loginErr");
    err.hidden = true; btn.disabled = true;
    try {
      const rolle = await rpc("pruefe_code", { p_code: code });
      if (!rolle) { err.textContent = "Dieser Klassencode stimmt nicht. Frag deine Lehrkraft."; err.hidden = false; return; }
      st.code = code; st.rolle = rolle; st.group = $("groupIn").value.trim();
      store.set("code", code); store.set("gruppe", st.group);
      showApp(true); await load();
    } catch (ex) { err.textContent = errText(ex); err.hidden = false; }
    finally { btn.disabled = false; }
  });
  const urlCode = new URLSearchParams(location.search).get("code");
  if (urlCode && !st.code) $("codeIn").value = urlCode;

  if (st.code) { showApp(true); load(); } else showApp(false);
  renderPanel();

  if ("serviceWorker" in navigator && location.protocol === "https:") navigator.serviceWorker.register("sw.js").catch(() => {});
})();
