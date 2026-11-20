/* Oxfam Merkentool / Outil de Marques – web version
   Order: 1 shop · 2 item · 3 brand (optional) + stars · 4 price (Onlinefact ref) + range
   Data: data/brands.json  [[name, stars(0-4), note?], ...]
         data/prices.json  {built, categories:[{id, fr, nl, levels, sections:[{fr, nl, items:[{fr, nl, p, r, img}]}]}]}
         data/shops.json   ["shop name", ...]  (used when no shared database is configured)
   Rebuild the data with tools/build_data.py (see README). */
(function () {
  "use strict";

  const NO_BRAND = "*"; // brand key for a price saved without brand

  const T = {
    nl: {
      title: "Merkentool", shop: "Winkel", brand: "Merk", optional: "(optioneel)", stars: "Sterren", item: "Artikel",
      searchBrand: "Zoek een merk…", searchItem: "Zoek een artikel…",
      chooseShop: "— Kies je winkel —",
      noBrand: "Geen merk gevonden. Kies eventueel de sterren zelf.",
      unrated: "Dit merk heeft nog geen sterren. Kies de sterren zelf.",
      capped: (s) => `Deze categorie heeft maximaal ${s} sterren: prijs voor ${s}.`,
      noItem: "Geen artikel gevonden in deze categorie.",
      info: (b, i) => `${b} merken · ${i} artikels`,
      loadError: "De gegevens konden niet geladen worden.",
      code: "Winkelcode", loginBtn: "OK", badCode: "Verkeerde code.", netError: "Geen verbinding met de databank.",
      changeShop: "Andere winkel", needShop: "Kies eerst je winkel (stap 1) om een prijs te onthouden.",
      choosePrice: "Kies je prijs", yourPrice: "Je prijs (eerder gekozen)",
      range: "Prijsvork", chooseStarsHint: "Kies een merk of het aantal sterren om de prijsvork te zien.",
      refLabel: "Referentie Onlinefact", copy: "Kopiëren", copied: "Gekopieerd ✓",
      save: (p, b) => `Onthoud ${p} voor ${b}`, thisItem: "dit artikel", saved: "Onthouden ✓", forget: "Vergeten",
      prefOther: "eerder gekozen, andere sterren",
      localNote: "prijzen enkel op dit toestel onthouden (testmodus)",
      tooMany: "Te veel foute codes. Probeer opnieuw over 15 minuten.",
      locked: "Kies je winkel en geef de winkelcode in om het hulpmiddel te gebruiken.",
      noData: "Er zijn nog geen merken en prijzen geladen in de databank.",
    },
    fr: {
      title: "Outil de Marques", shop: "Magasin", brand: "Marque", optional: "(facultatif)", stars: "Étoiles", item: "Article",
      searchBrand: "Chercher une marque…", searchItem: "Chercher un article…",
      chooseShop: "— Choisissez votre magasin —",
      noBrand: "Aucune marque trouvée. Choisissez éventuellement les étoiles vous-même.",
      unrated: "Cette marque n'a pas encore d'étoiles. Choisissez-les vous-même.",
      capped: (s) => `Cette catégorie a ${s} étoiles maximum : prix pour ${s}.`,
      noItem: "Aucun article trouvé dans cette catégorie.",
      info: (b, i) => `${b} marques · ${i} articles`,
      loadError: "Les données n'ont pas pu être chargées.",
      code: "Code magasin", loginBtn: "OK", badCode: "Code incorrect.", netError: "Pas de connexion à la base de données.",
      changeShop: "Changer de magasin", needShop: "Choisissez d'abord votre magasin (étape 1) pour mémoriser un prix.",
      choosePrice: "Choisissez votre prix", yourPrice: "Votre prix (déjà choisi précédemment)",
      range: "Fourchette de prix", chooseStarsHint: "Choisissez une marque ou le nombre d'étoiles pour voir la fourchette.",
      refLabel: "Référence Onlinefact", copy: "Copier", copied: "Copié ✓",
      save: (p, b) => `Mémoriser ${p} pour ${b}`, thisItem: "cet article", saved: "Mémorisé ✓", forget: "Oublier",
      prefOther: "choisi précédemment, autres étoiles",
      localNote: "prix mémorisés sur cet appareil uniquement (mode test)",
      tooMany: "Trop de codes erronés. Réessayez dans 15 minutes.",
      locked: "Choisissez votre magasin et entrez le code du magasin pour utiliser l'outil.",
      noData: "Les marques et les prix n'ont pas encore été chargés dans la base de données.",
    },
  };

  const $ = (id) => document.getElementById(id);
  const S = { lang: "nl", brands: [], cats: [], cat: 0, stars: 0, brand: null, item: null, sel: null, shops: [] };
  const CFG = window.MERKENTOOL_CONFIG || {};
  const REMOTE = !!(CFG.supabaseUrl && CFG.supabaseKey);

  /* ---------- helpers ---------- */
  const normChar = (c) => c.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  const norm = (s) => Array.from(String(s)).map(normChar).join("");
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const starStr = (n) => (n ? "*".repeat(n) : "–");

  function highlight(label, q) {
    if (!q) return esc(label);
    const chars = Array.from(label);
    const n = chars.map(normChar);
    if (n.some((x) => x.length !== 1)) return esc(label);
    const i = n.join("").indexOf(q);
    if (i < 0) return esc(label);
    return esc(chars.slice(0, i).join("")) + "<b>" + esc(chars.slice(i, i + q.length).join("")) + "</b>" + esc(chars.slice(i + q.length).join(""));
  }
  const fmtNum = (v) => v.toLocaleString("fr-BE", { minimumFractionDigits: v % 1 ? 2 : 0, maximumFractionDigits: 2 });
  function fmtRange(r) {
    if (!r) return "–";
    return r[0] === r[1] ? `${fmtNum(r[0])} €` : `${fmtNum(r[0])} – ${fmtNum(r[1])} €`;
  }
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* ignore */ } },
  };

  /* ---------- shop preferences (Supabase or this device) ---------- */
  const P = {
    shop: null,          // {id, name, code?}
    map: new Map(),      // "brand|item" -> {price, ref, stars}
    key: (brand, item) => brand.toLowerCase() + "|" + item,

    async rpc(fn, args) {
      const r = await fetch(CFG.supabaseUrl.replace(/\/$/, "") + "/rest/v1/rpc/" + fn, {
        method: "POST",
        // legacy "anon" keys are JWTs (eyJ…) and also go in Authorization; new "sb_publishable_…" keys only in apikey
        headers: Object.assign({ apikey: CFG.supabaseKey, "Content-Type": "application/json" },
          /^eyJ/.test(CFG.supabaseKey) ? { Authorization: "Bearer " + CFG.supabaseKey } : {}),
        body: JSON.stringify(args || {}),
      });
      if (!r.ok) {
        let msg = "";
        try { msg = (await r.json()).message || ""; } catch (e) { /* ignore */ }
        const err = new Error(msg || "HTTP " + r.status);
        err.badCode = /bad shop code/.test(msg);
        err.tooMany = /too many attempts/.test(msg);
        throw err;
      }
      const txt = await r.text();
      return txt ? JSON.parse(txt) : null;
    },
    localKey() { return "merkentool-prefs:" + (this.shop ? this.shop.name : ""); },

    async load() {
      this.map.clear();
      if (!this.shop) return;
      if (!REMOTE) {
        try { for (const [k, v] of Object.entries(JSON.parse(store.get(this.localKey()) || "{}"))) this.map.set(k, v); } catch (e) { /* ignore */ }
        return;
      }
      const rows = await this.rpc("get_prefs", { p_shop: this.shop.id, p_code: this.shop.code });
      for (const r of rows) this.map.set(this.key(r.brand, r.item), { price: +r.price, ref: r.ref, stars: r.stars });
    },
    saveLocal() { store.set(this.localKey(), JSON.stringify(Object.fromEntries(this.map))); },
    get(brand, item) { return this.map.get(this.key(brand, item)); },
    async set(brand, item, label, stars, price, ref) {
      if (REMOTE && !(await this.rpc("set_pref", { p_shop: this.shop.id, p_code: this.shop.code, p_brand: brand, p_item: item, p_label: label, p_stars: stars, p_price: price, p_ref: ref }))) throw Object.assign(new Error("bad shop code"), { badCode: true });
      this.map.set(this.key(brand, item), { price, ref, stars });
      if (!REMOTE) this.saveLocal();
    },
    async del(brand, item) {
      if (REMOTE && !(await this.rpc("del_pref", { p_shop: this.shop.id, p_code: this.shop.code, p_brand: brand, p_item: item }))) throw Object.assign(new Error("bad shop code"), { badCode: true });
      this.map.delete(this.key(brand, item));
      if (!REMOTE) this.saveLocal();
    },
  };

  const itemKey = (it) => S.cats[S.cat].id + ":" + it.nl;
  const itemLabel = (it) => S.cats[S.cat].fr + " – " + it.fr;
  const brandKey = () => (S.brand ? S.brand.name : NO_BRAND);

  /* ---------- generic suggestion list ---------- */
  function makeSuggest(input, list, getRows, onPick) {
    let rows = [], active = -1;
    function render() {
      rows = getRows(input.value);
      active = -1;
      if (!rows.length) { list.hidden = true; list.innerHTML = ""; return; }
      list.innerHTML = rows.map((r, i) =>
        r.group ? `<li class="group">${esc(r.group)}</li>`
                : `<li data-i="${i}"><span>${r.html}</span>${r.right ? `<span class="s">${esc(r.right)}</span>` : ""}</li>`
      ).join("");
      list.hidden = false;
      list.scrollTop = 0;
    }
    function move(d) {
      const idx = rows.map((r, i) => (r.group ? -1 : i)).filter((i) => i >= 0);
      if (!idx.length) return;
      let p = idx.indexOf(active) + d;
      p = Math.max(0, Math.min(idx.length - 1, p));
      active = idx[p];
      list.querySelectorAll("li").forEach((li) => li.classList.toggle("active", +li.dataset.i === active));
      const el = list.querySelector("li.active");
      if (el) el.scrollIntoView({ block: "nearest" });
    }
    function pick(i) {
      const r = rows[i];
      if (!r || r.group) return;
      list.hidden = true;
      onPick(r.value);
    }
    input.addEventListener("input", render);
    input.addEventListener("focus", render);
    input.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown") { e.preventDefault(); if (list.hidden) render(); move(1); }
      else if (e.key === "ArrowUp") { e.preventDefault(); move(-1); }
      else if (e.key === "Enter") {
        e.preventDefault();
        if (active < 0) { const first = rows.findIndex((r) => !r.group); if (first >= 0) pick(first); }
        else pick(active);
      } else if (e.key === "Escape") { list.hidden = true; }
    });
    list.addEventListener("mousedown", (e) => {
      const li = e.target.closest("li[data-i]");
      if (li) { e.preventDefault(); pick(+li.dataset.i); }
    });
    document.addEventListener("mousedown", (e) => {
      if (!input.parentElement.contains(e.target)) list.hidden = true;
    });
    return { render };
  }

  /* ---------- 1. shop ---------- */
  function renderShopSelect() {
    const t = T[S.lang], sel = $("shop-select");
    const cur = sel.value;
    sel.innerHTML = `<option value="">${esc(t.chooseShop)}</option>` +
      S.shops.map((s) => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join("");
    sel.value = cur || store.get("merkentool-last-shop") || "";
    if (!S.shops.some((s) => String(s.id) === sel.value)) sel.value = "";
  }

  function showShop() {
    const logged = !!P.shop;
    $("shop-form").hidden = logged;
    $("shop-current").hidden = !logged;
    if (logged) $("shop-name").textContent = "🏬 " + P.shop.name;
    $("shop-code").hidden = !REMOTE;
    $("shop-ok").hidden = !REMOTE;
    $("shop-card").classList.toggle("todo", !logged);
  }

  function shopMsg(txt) {
    $("shop-msg").textContent = txt || "";
    $("shop-msg").hidden = !txt;
  }

  async function chooseShop() {
    const t = T[S.lang], sel = $("shop-select");
    const id = sel.value;
    if (!id) return;
    const name = sel.options[sel.selectedIndex].text;
    if (!REMOTE) {
      P.shop = { id, name };
    } else {
      const code = $("shop-code").value.trim();
      if (!code) { $("shop-code").focus(); return; }
      $("shop-ok").disabled = true;
      try {
        const ok = await P.rpc("shop_login", { p_shop: +id, p_code: code });
        if (!ok) { shopMsg(t.badCode); return; }
        P.shop = { id: +id, name, code };
      } catch (e) {
        console.error(e); shopMsg(e.tooMany ? t.tooMany : t.netError); return;
      } finally {
        $("shop-ok").disabled = false;
      }
    }
    store.set("merkentool-shop", JSON.stringify(P.shop));
    store.set("merkentool-last-shop", String(id));
    shopMsg("");
    $("shop-code").value = "";
    if (REMOTE && !(await loadRemoteData())) return;
    try { await P.load(); } catch (e) { console.error(e); shopMsg(t.netError); }
    showShop();
    renderResult();
  }

  /* ---------- data ---------- */
  function applyData(b, p) {
    S.brands = (b || []).map(([name, stars, note]) => {
      const n = norm(name);
      return { name, stars, note, n, ns: n.replace(/\s+/g, "") };
    });
    S.cats = (p && p.categories) || [];
    S.built = (p && p.built) || "";
    for (const c of S.cats) for (const s of c.sections) for (const it of s.items) { it.nn = norm(it.nl); it.nf = norm(it.fr); }
    S.cat = Math.min(S.cat, Math.max(0, S.cats.length - 1));
    renderCats();
    updateInfo();
  }

  // shared database: brands and prices are only sent after a valid shop code
  async function loadRemoteData() {
    const t = T[S.lang];
    try {
      const d = await P.rpc("get_app_data", { p_shop: P.shop.id, p_code: P.shop.code });
      if (!d) { logout(); shopMsg(t.badCode); return false; }
      if (!d.brands || !d.prices) { shopMsg(t.noData); }
      applyData(d.brands, d.prices);
      setLocked(false);
      return true;
    } catch (e) {
      console.error(e);
      shopMsg(e.tooMany ? t.tooMany : t.netError);
      return false;
    }
  }

  // steps 2-4 stay hidden until a shop has logged in (shared database only)
  function setLocked(on) {
    document.querySelectorAll("main > .card:not(#shop-card)").forEach((c) => c.classList.toggle("is-locked", on));
    $("locked-msg").hidden = !on;
  }

  function logout() {
    P.shop = null;
    P.map.clear();
    store.set("merkentool-shop", "");
    if (REMOTE) {
      clearItem(); clearBrand();
      applyData([], { categories: [] });
      setLocked(true);
    }
    showShop();
    S.sel = null;
    renderResult();
    renderShopSelect();
    $("shop-select").focus();
  }

  /* ---------- 2. categories & items ---------- */
  function renderCats() {
    $("cats").innerHTML = S.cats.map((c, i) => `<button type="button" data-cat="${i}" class="${i === S.cat ? "on" : ""}">${esc(c[S.lang])}</button>`).join("");
  }

  function itemRows(text) {
    const q = norm(text.trim());
    const cat = S.cats[S.cat];
    const other = S.lang === "nl" ? "fr" : "nl";
    const rows = [];
    for (const sec of cat.sections) {
      const its = sec.items.filter((it) => !q || it.nn.includes(q) || it.nf.includes(q));
      if (!its.length) continue;
      rows.push({ group: sec[S.lang] });
      for (const it of its) {
        const own = norm(it[S.lang]).includes(q);
        rows.push({ html: highlight(it[S.lang], own ? q : "") + (!own && q ? ` <small>(${highlight(it[other], q)})</small>` : ""), value: it });
      }
    }
    if (!rows.length) rows.push({ group: T[S.lang].noItem });
    return rows;
  }

  function pickItem(it) {
    S.item = it; S.sel = null;
    $("item-input").value = it[S.lang];
    $("item-input").blur();
    renderResult();
  }
  function clearItem() {
    S.item = null; S.sel = null;
    $("item-input").value = "";
    renderResult();
  }

  /* ---------- 3. brand & stars ---------- */
  function brandRows(text) {
    const q = norm(text.trim());
    S.brandNoMatch = false;
    if (!q) { showBrandMsg(); return []; }
    const qs = q.replace(/\s+/g, "");
    const alt = q[0] === "k" ? "c" + q.slice(1) : q[0] === "c" ? "k" + q.slice(1) : null; // like the original tool
    const altS = alt && alt.replace(/\s+/g, "");
    const hits = [];
    for (const b of S.brands) {
      let rank = -1;
      if (b.n === q) rank = 0;
      else if (b.n.startsWith(q)) rank = 1;
      else if (b.n.includes(" " + q)) rank = 2;
      else if (b.n.includes(q) || b.ns.includes(qs)) rank = 3;
      else if (alt && b.n[0] === alt[0] && (b.n.includes(alt) || b.ns.includes(altS))) rank = 4;
      if (rank >= 0) hits.push([rank, b]);
    }
    hits.sort((a, b) => a[0] - b[0] || a[1].n.localeCompare(b[1].n));
    S.brandNoMatch = hits.length === 0;
    showBrandMsg();
    return hits.slice(0, 80).map(([, b]) => ({ html: highlight(b.name, q), right: starStr(b.stars), value: b }));
  }

  function pickBrand(b) {
    S.brand = b; S.sel = null;
    $("brand-input").value = b.name;
    setStars(b.stars);
    showBrandMsg();
    $("brand-input").blur();
  }

  function showBrandMsg() {
    const m = $("brand-msg"), t = T[S.lang];
    let txt = "", warn = false;
    if (S.brand) {
      if (!S.brand.stars) { txt = t.unrated; warn = true; }
      if (S.brand.note) txt = (txt ? txt + " " : "") + "ℹ︎ " + S.brand.note;
    } else if (S.brandNoMatch && $("brand-input").value.trim()) {
      txt = t.noBrand; warn = true;
    }
    m.textContent = txt;
    m.classList.toggle("warn", warn);
    m.hidden = !txt;
  }

  function clearBrand() {
    S.brand = null; S.brandNoMatch = false; S.sel = null;
    $("brand-input").value = "";
    setStars(0);
    showBrandMsg();
  }

  function setStars(n) {
    S.stars = n; S.sel = null;
    document.querySelectorAll("#star-picker button").forEach((b) => b.classList.toggle("on", +b.dataset.stars === n));
    renderResult();
  }

  /* ---------- 4. price ---------- */
  function currentPref(it, lv) {
    if (!P.shop) return null;
    const key = itemKey(it);
    if (S.brand) {
      const p = P.get(S.brand.name, key);
      if (p) return { ...p, brand: S.brand.name };
    }
    // fall back to the price saved for the item without brand (same star level only, when a brand is chosen)
    const p = P.get(NO_BRAND, key);
    if (p && (!S.brand || !lv || p.stars === lv)) return { ...p, brand: NO_BRAND };
    return null;
  }

  function renderResult() {
    const box = $("result");
    const it = S.item;
    if (!it) { box.hidden = true; return; }
    const t = T[S.lang], cat = S.cats[S.cat];
    const other = S.lang === "nl" ? "fr" : "nl";
    box.hidden = false;
    $("item-name").innerHTML = `${esc(it[S.lang])}<small>${esc(it[other])} · ${esc(cat[S.lang])}${S.brand ? " · " + esc(S.brand.name) : ""}</small>`;

    const lv = S.stars ? Math.min(S.stars, cat.levels) : 0;
    const pref = currentPref(it, lv);
    if (!S.sel && pref) S.sel = { price: pref.price, ref: pref.ref, lv: pref.stars || lv };
    $("price-title").textContent = pref ? t.yourPrice : t.choosePrice;

    // price buttons: only the chosen star level, or every level when no stars are known
    const levels = lv ? [lv] : Array.from({ length: cat.levels }, (_, i) => i + 1);
    let html = "";
    let prefShown = false;
    for (const l of levels) {
      const opts = (it.r && it.r[l - 1]) || [];
      if (!opts.length) continue;
      html += `<div class="chip-level">${levels.length > 1 ? `<span class="chip-stars lv${l}">${starStr(l)}</span>` : ""}<div class="chips">` +
        opts.map(([p, ref]) => {
          const isPref = pref && pref.ref === ref;
          if (isPref) prefShown = true;
          return `<button type="button" data-ref="${esc(ref)}" data-price="${p}" data-lv="${l}" class="${S.sel && S.sel.ref === ref ? "on" : ""} ${isPref ? "pref" : ""}">${esc(fmtNum(p))} €</button>`;
        }).join("") + `</div></div>`;
    }
    if (pref && !prefShown) {
      html = `<div class="chip-level"><span class="chip-stars">${esc(t.prefOther)}</span><div class="chips"><button type="button" data-ref="${esc(pref.ref)}" data-price="${pref.price}" data-lv="${pref.stars || 0}" class="${S.sel && S.sel.ref === pref.ref ? "on" : ""} pref">${esc(fmtNum(pref.price))} €</button></div></div>` + html;
    }
    $("price-chips").innerHTML = html;

    renderRef(pref);

    // range
    const main = $("price-main");
    main.className = "price-main";
    if (lv) {
      main.classList.add("lv" + lv);
      main.innerHTML = `${esc(fmtRange(it.p[lv - 1]))}<small>${starStr(lv)}</small>`;
    } else {
      main.classList.add("empty");
      main.textContent = t.chooseStarsHint;
    }
    const note = $("price-note");
    note.hidden = !(S.stars > cat.levels);
    note.textContent = S.stars > cat.levels ? t.capped(starStr(cat.levels)) : "";
    let head = "", body = "";
    for (let i = 0; i < cat.levels; i++) {
      const on = i + 1 === lv;
      head += `<th>${starStr(i + 1)}</th>`;
      body += `<td class="${on ? "on lv" + lv : ""}">${esc(fmtRange(it.p[i]))}</td>`;
    }
    $("price-table").innerHTML = `<tr>${head}</tr><tr>${body}</tr>`;

    $("photos").innerHTML = (it.img || []).map((f) => `<img src="photos/${esc(f)}" alt="" loading="lazy" onerror="this.remove()">`).join("");
  }

  function renderRef(pref) {
    const t = T[S.lang];
    const box = $("ref-box");
    box.hidden = !S.sel;
    if (!S.sel) return;
    $("ref-value").textContent = S.sel.ref;
    $("ref-copy").textContent = t.copy;
    const save = $("save-pref"), del = $("del-pref"), msg = $("save-msg");
    msg.textContent = ""; msg.className = "msg";
    if (!P.shop) {
      save.hidden = true; del.hidden = true;
      msg.textContent = t.needShop;
      return;
    }
    const exact = pref && pref.brand === brandKey();
    const isSaved = exact && pref.ref === S.sel.ref;
    save.hidden = false;
    save.disabled = isSaved;
    save.textContent = isSaved ? t.saved : t.save(fmtRange([S.sel.price, S.sel.price]), S.brand ? S.brand.name : t.thisItem);
    del.hidden = !exact;
  }

  async function savePref() {
    const it = S.item;
    if (!it || !S.sel || !P.shop) return;
    const btn = $("save-pref");
    btn.disabled = true;
    try {
      await P.set(brandKey(), itemKey(it), itemLabel(it), S.sel.lv || null, S.sel.price, S.sel.ref);
      renderResult();
    } catch (e) {
      handleRemoteError(e);
      btn.disabled = false;
    }
  }

  async function delPref() {
    const it = S.item;
    if (!it || !P.shop) return;
    try {
      await P.del(brandKey(), itemKey(it));
      S.sel = null;
      renderResult();
    } catch (e) { handleRemoteError(e); }
  }

  function handleRemoteError(e) {
    console.error(e);
    if (e.badCode) { logout(); shopMsg(T[S.lang].badCode); return; }
    if (e.tooMany) { logout(); shopMsg(T[S.lang].tooMany); return; }
    $("save-msg").textContent = T[S.lang].netError;
    $("save-msg").className = "msg warn";
  }

  /* ---------- language ---------- */
  function setLang(lang) {
    S.lang = lang;
    store.set("merkentool-lang", lang);
    document.documentElement.lang = lang;
    const t = T[lang];
    document.querySelectorAll("[data-i18n]").forEach((el) => { if (typeof t[el.dataset.i18n] === "string") el.textContent = t[el.dataset.i18n]; });
    document.querySelectorAll("[data-i18n-ph]").forEach((el) => (el.placeholder = t[el.dataset.i18nPh]));
    document.querySelectorAll(".lang button").forEach((b) => b.classList.toggle("on", b.dataset.lang === lang));
    document.title = lang === "nl" ? "Oxfam Merkentool" : "Oxfam Outil de Marques";
    renderCats();
    renderShopSelect();
    if (S.item) $("item-input").value = S.item[lang];
    showBrandMsg();
    renderResult();
    updateInfo();
  }

  function updateInfo() {
    if (!S.cats.length) { $("data-info").textContent = ""; return; }
    const n = S.cats.reduce((a, c) => a + c.sections.reduce((x, s) => x + s.items.length, 0), 0);
    const fmt = (v) => v.toLocaleString(S.lang === "nl" ? "nl-BE" : "fr-BE");
    $("data-info").textContent = T[S.lang].info(fmt(S.brands.length), fmt(n)) + (S.built ? ` · ${S.built}` : "") +
      (REMOTE ? "" : ` · ${T[S.lang].localNote}`);
  }

  /* ---------- init ---------- */
  async function init() {
    const saved = store.get("merkentool-lang");
    setLang(saved || ((navigator.language || "").toLowerCase().startsWith("fr") ? "fr" : "nl"));

    try {
      if (REMOTE) {
        // shared database: only the shop names are public; data comes after login
        setLocked(true);
        const shops = await P.rpc("list_shops").catch((e) => { console.error(e); return null; });
        if (shops === null) shopMsg(T[S.lang].netError);
        S.shops = shops || [];
      } else {
        // test mode: local files
        const [b, p, shops] = await Promise.all([
          fetch("data/brands.json").then((r) => { if (!r.ok) throw r; return r.json(); }),
          fetch("data/prices.json").then((r) => { if (!r.ok) throw r; return r.json(); }),
          fetch("data/shops.json").then((r) => (r.ok ? r.json() : [])).then((l) => l.map((n) => ({ id: n, name: n }))).catch(() => []),
        ]);
        applyData(b, p);
        S.shops = shops || [];
      }
    } catch (e) {
      $("data-info").textContent = T[S.lang].loadError;
      console.error(e);
      return;
    }

    makeSuggest($("brand-input"), $("brand-list"), brandRows, pickBrand);
    const itemSug = makeSuggest($("item-input"), $("item-list"), itemRows, pickItem);

    $("brand-input").addEventListener("input", () => {
      if (S.brand && $("brand-input").value !== S.brand.name) { S.brand = null; S.sel = null; showBrandMsg(); renderResult(); }
      if (!$("brand-input").value) clearBrand();
    });
    $("item-input").addEventListener("input", () => { if (!$("item-input").value && S.item) clearItem(); });
    document.querySelectorAll(".clear").forEach((b) => b.addEventListener("click", () => {
      if (b.dataset.clear === "brand") { clearBrand(); $("brand-input").focus(); }
      else { clearItem(); $("item-input").focus(); }
    }));
    $("star-picker").addEventListener("click", (e) => {
      const b = e.target.closest("button");
      if (b) setStars(+b.dataset.stars === S.stars ? 0 : +b.dataset.stars);
    });
    $("cats").addEventListener("click", (e) => {
      const b = e.target.closest("button");
      if (!b) return;
      S.cat = +b.dataset.cat;
      renderCats();
      clearItem();
      $("item-input").focus();
      itemSug.render();
    });
    document.querySelectorAll(".lang button").forEach((b) => b.addEventListener("click", () => setLang(b.dataset.lang)));

    $("price-chips").addEventListener("click", (e) => {
      const b = e.target.closest("button");
      if (!b) return;
      S.sel = { price: +b.dataset.price, ref: b.dataset.ref, lv: +b.dataset.lv || 0 };
      renderResult();
    });
    $("ref-copy").addEventListener("click", async () => {
      try { await navigator.clipboard.writeText($("ref-value").textContent); $("ref-copy").textContent = T[S.lang].copied; }
      catch (e) { /* clipboard not available */ }
    });
    $("save-pref").addEventListener("click", savePref);
    $("del-pref").addEventListener("click", delPref);

    $("shop-select").addEventListener("change", () => { shopMsg(""); if (!REMOTE) chooseShop(); else $("shop-code").focus(); });
    $("shop-ok").addEventListener("click", chooseShop);
    $("shop-code").addEventListener("keydown", (e) => { if (e.key === "Enter") chooseShop(); });
    $("shop-change").addEventListener("click", logout);

    $("photos").addEventListener("click", (e) => {
      if (e.target.tagName !== "IMG") return;
      const lb = $("lightbox");
      lb.querySelector("img").src = e.target.src;
      lb.hidden = false;
    });
    $("lightbox").addEventListener("click", () => ($("lightbox").hidden = true));
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") $("lightbox").hidden = true; });

    renderCats();
    renderShopSelect();
    updateInfo();

    // restore the shop chosen earlier on this device
    try { P.shop = JSON.parse(store.get("merkentool-shop") || "null"); } catch (e) { P.shop = null; }
    if (P.shop && !S.shops.some((s) => String(s.id) === String(P.shop.id) && s.name === P.shop.name)) P.shop = null;
    if (P.shop && REMOTE && !P.shop.code) P.shop = null;
    if (P.shop && REMOTE && !(await loadRemoteData())) { if (P.shop && !S.cats.length) P.shop = null; }
    if (P.shop) {
      try { await P.load(); }
      catch (e) { console.error(e); if (e.badCode) { logout(); } else shopMsg(T[S.lang].netError); }
    }
    showShop();
    renderResult();

    if (REMOTE) {
      // pick up prices saved by colleagues when coming back to the tab
      window.addEventListener("focus", () => { if (P.shop) P.load().then(renderResult).catch(() => {}); });
    }
  }

  document.addEventListener("DOMContentLoaded", init);
})();
