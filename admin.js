(function () {
"use strict";
const CFG = window.MERKENTOOL_CONFIG || {};
const $ = (id) => document.getElementById(id);
let code = "";

async function rpc(fn, args) {
  const r = await fetch(CFG.supabaseUrl.replace(/\/$/, "") + "/rest/v1/rpc/" + fn, {
    method: "POST",
    headers: Object.assign({ apikey: CFG.supabaseKey, "Content-Type": "application/json" },
      /^eyJ/.test(CFG.supabaseKey) ? { Authorization: "Bearer " + CFG.supabaseKey } : {}),
    body: JSON.stringify(args || {}),
  });
  const txt = await r.text();
  if (!r.ok) {
    let msg = txt;
    try { msg = JSON.parse(txt).message || txt; } catch (e) { /* ignore */ }
    throw new Error(msg);
  }
  return txt ? JSON.parse(txt) : null;
}
const log = (m) => { $("log").textContent += m + "\n"; };
const fmtDate = (d) => new Date(d).toLocaleString("fr-BE");

function check(key, data) {
  if (key === "brands") {
    if (!Array.isArray(data) || !data.length || !Array.isArray(data[0])) throw new Error("brands.json n'a pas le bon format");
    return `${data.length} marques`;
  }
  if (!data || !Array.isArray(data.categories) || !data.categories.length) throw new Error("prices.json n'a pas le bon format");
  const n = data.categories.reduce((a, c) => a + c.sections.reduce((x, s) => x + s.items.length, 0), 0);
  const refs = data.categories.reduce((a, c) => a + c.sections.reduce((x, s) => x + s.items.reduce((y, it) => y + (it.r || []).flat().length, 0), 0), 0);
  return `${data.categories.length} catégories, ${n} articles, ${refs} références Onlinefact`;
}

async function upload(key, data) {
  const what = check(key, data);
  log(`→ envoi ${key} (${what})…`);
  const ok = await rpc("upload_app_data", { p_admin: code, p_key: key, p_data: data });
  if (!ok) throw new Error("code administrateur refusé");
  log(`✓ ${key} enregistré`);
}

async function status() {
  const s = await rpc("admin_status", { p_admin: code });
  if (!s) throw new Error("code administrateur refusé");
  const cell = (text, cls) => { const td = document.createElement("td"); td.textContent = text; if (cls) td.className = cls; return td; };
  const row = (k, label, unit) => {
    const tr = document.createElement("tr");
    tr.append(cell(label, "strong"));
    if (s[k]) tr.append(cell(`${Number(s[k].count)} ${unit}`), cell(`mis à jour le ${fmtDate(s[k].updated_at)}`));
    else { const td = cell("pas encore chargé", "warn-text"); td.colSpan = 2; tr.append(td); }
    return tr;
  };
  $("status").replaceChildren(row("brands", "Marques", "marques"), row("prices", "Listes de prix", "catégories"));
}

async function login() {
  code = $("admin-code").value;
  $("login-msg").hidden = true;
  if (!CFG.supabaseUrl || !CFG.supabaseKey) { $("login-msg").textContent = "config.js n'est pas rempli."; $("login-msg").hidden = false; return; }
  try {
    const ok = await rpc("admin_login", { p_admin: code });
    if (!ok) { $("login-msg").textContent = "Code incorrect."; $("login-msg").hidden = false; return; }
    $("login-card").hidden = true;
    $("status-card").hidden = false;
    $("upload-card").hidden = false;
    await status();
  } catch (e) {
    $("login-msg").textContent = /too many/.test(e.message) ? "Trop d'essais. Réessayez dans 15 minutes." : "Erreur : " + e.message;
    $("login-msg").hidden = false;
  }
}

async function run(fn) {
  document.querySelectorAll("#upload-card button").forEach((b) => (b.disabled = true));
  try { await fn(); await status(); log("Terminé."); }
  catch (e) { log("✗ " + e.message); }
  finally { document.querySelectorAll("#upload-card button").forEach((b) => (b.disabled = false)); }
}

$("admin-go").addEventListener("click", login);
$("admin-code").addEventListener("keydown", (e) => { if (e.key === "Enter") login(); });

$("copy-site").addEventListener("click", () => run(async () => {
  for (const key of ["brands", "prices"]) {
    const r = await fetch(`data/${key}.json`, { cache: "no-store" });
    if (!r.ok) throw new Error(`data/${key}.json introuvable sur le site (déjà supprimé ?) – utilisez l'option fichiers`);
    await upload(key, await r.json());
  }
}));

$("upload-files").addEventListener("click", () => run(async () => {
  const files = { brands: $("f-brands").files[0], prices: $("f-prices").files[0] };
  if (!files.brands && !files.prices) throw new Error("aucun fichier choisi");
  for (const key of ["brands", "prices"]) {
    if (!files[key]) continue;
    let data;
    try { data = JSON.parse(await files[key].text()); } catch (e) { throw new Error(`${files[key].name} n'est pas un fichier JSON valide`); }
    await upload(key, data);
  }
}));
  })();
