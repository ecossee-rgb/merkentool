/* Oxfam Merkentool / Outil de Marques – web version
   Data: data/brands.json  [[name, stars(0-4), note?], ...]
         data/prices.json  {built, categories:[{id, fr, nl, levels, sections:[{fr, nl, items:[{fr, nl, p:[[min,max],...], img:[...]}]}]}]}
   Rebuild the data with tools/build_data.py (see README). */
(function () {
  "use strict";

  const T = {
    nl: {
      title: "Merkentool", brand: "Merk", stars: "Sterren", item: "Artikel", price: "Prijs",
      searchBrand: "Zoek een merk…", searchItem: "Zoek een artikel…",
      noBrand: "Geen merk gevonden. Kies de sterren zelf.",
      unrated: "Dit merk heeft nog geen sterren. Kies de sterren zelf.",
      chooseStars: "Kies eerst een merk of het aantal sterren",
      capped: (s) => `Deze categorie heeft maximaal ${s} sterren: prijs voor ${s}.`,
      noItem: "Geen artikel gevonden in deze categorie.",
      info: (b, i) => `${b} merken · ${i} artikels`,
      loadError: "De gegevens konden niet geladen worden.",
    },
    fr: {
      title: "Outil de Marques", brand: "Marque", stars: "Étoiles", item: "Article", price: "Prix",
      searchBrand: "Chercher une marque…", searchItem: "Chercher un article…",
      noBrand: "Aucune marque trouvée. Choisissez les étoiles vous-même.",
      unrated: "Cette marque n'a pas encore d'étoiles. Choisissez-les vous-même.",
      chooseStars: "Choisissez d'abord une marque ou le nombre d'étoiles",
      capped: (s) => `Cette catégorie a ${s} étoiles maximum : prix pour ${s}.`,
      noItem: "Aucun article trouvé dans cette catégorie.",
      info: (b, i) => `${b} marques · ${i} articles`,
      loadError: "Les données n'ont pas pu être chargées.",
    },
  };

  const $ = (id) => document.getElementById(id);
  const S = { lang: "nl", brands: [], cats: [], cat: 0, stars: 0, brand: null, item: null };

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

  function fmtNum(v) {
    return v.toLocaleString("fr-BE", { minimumFractionDigits: v % 1 ? 2 : 0, maximumFractionDigits: 2 });
  }
  function fmtRange(r) {
    if (!r) return "–";
    return r[0] === r[1] ? `${fmtNum(r[0])} €` : `${fmtNum(r[0])} – ${fmtNum(r[1])} €`;
  }

  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* ignore */ } },
  };

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
    return { render, hide: () => (list.hidden = true) };
  }

  /* ---------- brand search ---------- */
  function brandRows(text) {
    const q = norm(text.trim());
    S.brandNoMatch = false;
    if (!q) return [];
    const qs = q.replace(/\s+/g, "");
    // like the original tool: k <-> c at the start
    const alt = q[0] === "k" ? "c" + q.slice(1) : q[0] === "c" ? "k" + q.slice(1) : null;
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
    S.brand = b;
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
    S.brand = null; S.brandNoMatch = false;
    $("brand-input").value = "";
    setStars(0);
    showBrandMsg();
  }

  /* ---------- stars ---------- */
  function setStars(n) {
    S.stars = n;
    document.querySelectorAll("#star-picker button").forEach((b) => b.classList.toggle("on", +b.dataset.stars === n));
    renderResult();
  }

  /* ---------- categories & items ---------- */
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
    S.item = it;
    $("item-input").value = it[S.lang];
    $("item-input").blur();
    renderResult();
  }

  function clearItem() {
    S.item = null;
    $("item-input").value = "";
    renderResult();
  }

  /* ---------- result ---------- */
  function renderResult() {
    const box = $("result");
    const it = S.item;
    if (!it) { box.hidden = true; return; }
    const t = T[S.lang], cat = S.cats[S.cat];
    const other = S.lang === "nl" ? "fr" : "nl";
    box.hidden = false;
    $("item-name").innerHTML = `${esc(it[S.lang])}<small>${esc(it[other])} · ${esc(cat[S.lang])}</small>`;

    const lv = S.stars ? Math.min(S.stars, cat.levels) : 0;
    const main = $("price-main");
    main.className = "price-main";
    if (lv) {
      main.classList.add("lv" + lv);
      main.innerHTML = `${esc(fmtRange(it.p[lv - 1]))}<small>${starStr(lv)}</small>`;
    } else {
      main.classList.add("empty");
      main.textContent = t.chooseStars;
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

    $("photos").innerHTML = (it.img || []).map((f) => `<img src="photos/${esc(f)}" alt="" loading="lazy">`).join("");
  }

  /* ---------- language ---------- */
  function setLang(lang) {
    S.lang = lang;
    store.set("merkentool-lang", lang);
    document.documentElement.lang = lang;
    const t = T[lang];
    document.querySelectorAll("[data-i18n]").forEach((el) => (el.textContent = t[el.dataset.i18n]));
    document.querySelectorAll("[data-i18n-ph]").forEach((el) => (el.placeholder = t[el.dataset.i18nPh]));
    document.querySelectorAll(".lang button").forEach((b) => b.classList.toggle("on", b.dataset.lang === lang));
    document.title = lang === "nl" ? "Oxfam Merkentool" : "Oxfam Outil de Marques";
    renderCats();
    if (S.item) $("item-input").value = S.item[lang];
    showBrandMsg();
    renderResult();
    updateInfo();
  }

  function updateInfo() {
    if (!S.cats.length) return;
    const n = S.cats.reduce((a, c) => a + c.sections.reduce((x, s) => x + s.items.length, 0), 0);
    const fmt = (v) => v.toLocaleString(S.lang === "nl" ? "nl-BE" : "fr-BE");
    $("data-info").textContent = T[S.lang].info(fmt(S.brands.length), fmt(n)) + (S.built ? ` · ${S.built}` : "");
  }

  /* ---------- init ---------- */
  async function init() {
    const saved = store.get("merkentool-lang");
    setLang(saved || ((navigator.language || "").toLowerCase().startsWith("fr") ? "fr" : "nl"));

    try {
      const [b, p] = await Promise.all([
        fetch("data/brands.json").then((r) => { if (!r.ok) throw r; return r.json(); }),
        fetch("data/prices.json").then((r) => { if (!r.ok) throw r; return r.json(); }),
      ]);
      S.brands = b.map(([name, stars, note]) => {
        const n = norm(name);
        return { name, stars, note, n, ns: n.replace(/\s+/g, "") };
      });
      S.cats = p.categories;
      S.built = p.built || "";
      for (const c of S.cats) for (const s of c.sections) for (const it of s.items) { it.nn = norm(it.nl); it.nf = norm(it.fr); }
    } catch (e) {
      $("data-info").textContent = T[S.lang].loadError;
      console.error(e);
      return;
    }

    makeSuggest($("brand-input"), $("brand-list"), brandRows, pickBrand);
    const itemSug = makeSuggest($("item-input"), $("item-list"), itemRows, pickItem);

    $("brand-input").addEventListener("input", () => {
      if (S.brand && $("brand-input").value !== S.brand.name) { S.brand = null; showBrandMsg(); }
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

    $("photos").addEventListener("click", (e) => {
      if (e.target.tagName !== "IMG") return;
      const lb = $("lightbox");
      lb.querySelector("img").src = e.target.src;
      lb.hidden = false;
    });
    $("lightbox").addEventListener("click", () => ($("lightbox").hidden = true));
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") $("lightbox").hidden = true; });

    renderCats();
    updateInfo();
  }

  document.addEventListener("DOMContentLoaded", init);
})();
