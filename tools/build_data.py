#!/usr/bin/env python3
"""
Rebuild the data of the Merkentool / Outil de Marques web app.

Usage (from the repository root):
    pip install openpyxl python-docx pillow
    python tools/build_data.py --brands path/to/Merkentool.xlsx --prices path/to/folder_with_docx

Inputs
  --brands  Excel file: column A = brand, column B = stars (*, **, ***, ****),
            optional column D = note. First row is a header.
  --prices  Folder containing the "Liste_de_prix_*.docx" Word files. Each file:
            first paragraph = category title "FR / NL", then one heading + one
            table per section. Table: Article/Artikel | * | ** | ... | Photos.
            Item cell = French name, line break, Dutch name. Prices "3-5€", "2,5€".

Outputs (overwritten)
  data/brands.json, data/prices.json, photos/*.jpg, data/report.txt
"""
import argparse, datetime, glob, hashlib, io, json, os, re, sys, collections

import openpyxl, docx
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# Category order + names (matched on a keyword of the Word file name)
CATEGORIES = [
    ("femmes", "women", "Femmes", "Dames"),
    ("hommes", "men", "Hommes", "Heren"),
    ("enfants", "kids", "Enfants", "Kinderen"),
    ("bebes", "baby", "Bébés", "Baby"),
    ("accessoires", "accessories", "Accessoires", "Accessoires"),
    ("linge", "household", "Linge de maison", "Huishoudtextiel"),
]

# Dutch names for section headings that only exist in French in the Word files
SECTION_NL = {
    "Manteaux et vestes": "Jassen en vesten",
    "Blazers et vestes": "Blazers en colberts",
    "Chemises, blouses, polos": "Hemden, blouses, polo's",
    "Pulls et sweats": "Truien en sweaters",
    "T-shirts": "T-shirts",
    "Pantalons": "Broeken",
    "Robes et jupes": "Jurken en rokken",
    "Salopettes, combis, kaftans": "Tuinbroeken, jumpsuits, kaftans",
    "Shorts et bermudas": "Shorts en bermuda's",
    "Sport": "Sport",
    "Linge de nuit": "Nachtkleding",
    "Ceintures": "Riemen",
    "Bonnets": "Mutsen",
    "Casquettes et chapeaux": "Petten en hoeden",
    "Cravates et nœuds papillon": "Dassen en vlinderdassen",
    "Gants": "Handschoenen",
    "Foulards et écharpes": "Sjaals",
    "Sacs": "Tassen",
    "Couettes et couvertures": "Dekbedden en dekens",
    "Draps et housses": "Lakens en overtrekken",
    "Oreillers, coussins et taies": "Kussens en slopen",
    "Salle de bain": "Badkamer",
    "Cuisine et table": "Keuken en tafel",
    "Maison": "Huis",
}

PRICE_RX = re.compile(r"^(\d+(?:[,.]\d+)?)(?:-(\d+(?:[,.]\d+)?))?€?$")
PHOTO_MAX = 480  # px, longest side


def num(s):
    return float(s.replace(",", "."))


def build_brands(path, report):
    ws = openpyxl.load_workbook(path, data_only=True, read_only=True).worksheets[0]
    seen = {}
    brands = []
    odd, dupes, unrated = [], [], 0
    for i, row in enumerate(ws.iter_rows(min_row=2, values_only=True), start=2):
        row = list(row) + [None] * 4
        name, raw, note = row[0], row[1], row[3]
        if name is None or str(name).strip() == "":
            continue
        name = str(name).strip()
        if name.startswith("#NAME") or name.startswith("#REF"):
            odd.append(f"  ligne {i}: {name!r} -> erreur Excel, ignorée")
            continue
        raw_s = "" if raw is None else str(raw)
        n = len(raw_s) - len(raw_s.lstrip("*"))
        if raw_s.strip() and raw_s.strip() != "*" * n:
            odd.append(f"  ligne {i}: {name!r} -> {raw_s!r} (lu comme {'*' * min(n, 4)})")
        if n > 4:
            odd.append(f"  ligne {i}: {name!r} -> {raw_s!r} (5 étoiles, compté comme ****)")
        stars = min(n, 4)
        if stars == 0:
            unrated += 1
        key = name.lower()
        if key in seen:
            first_line, first_stars, idx = seen[key]
            if first_stars != stars:
                if first_stars == 0 and stars > 0:
                    brands[idx][1] = stars
                    seen[key] = (first_line, stars, idx)
                    dupes.append(f"  ligne {i}: {name!r} {'*' * stars}  (ligne {first_line}: sans étoiles) -> {'*' * stars} gardé")
                elif stars == 0:
                    pass  # unrated copy of a rated brand: ignore silently
                else:
                    dupes.append(f"  ligne {i}: {name!r} {'*' * stars}  (ligne {first_line}: {'*' * first_stars}) -> {'*' * first_stars} gardé, À VÉRIFIER")
            continue
        seen[key] = (i, stars, len(brands))
        entry = [name, stars]
        if note:
            entry.append(str(note).strip())
        brands.append(entry)
    brands.sort(key=lambda b: b[0].lower())
    unrated = sum(1 for b in brands if b[1] == 0)
    report.append(f"MARQUES: {len(brands)} marques, dont {unrated} sans étoiles")
    report.append(f"\nNotes d'étoiles inhabituelles ({len(odd)}):")
    report += odd
    report.append(f"\nDoublons avec des notes différentes ({len(dupes)}):")
    report += dupes
    return brands


def save_photo(blob, photo_dir):
    h = hashlib.sha1(blob).hexdigest()[:12]
    fn = f"{h}.jpg"
    out = os.path.join(photo_dir, fn)
    if not os.path.exists(out):
        im = Image.open(io.BytesIO(blob))
        if im.mode in ("RGBA", "LA", "P"):
            im = im.convert("RGBA")
            bg = Image.new("RGB", im.size, "white")
            bg.paste(im, mask=im.split()[-1])
            im = bg
        else:
            im = im.convert("RGB")
        im.thumbnail((PHOTO_MAX, PHOTO_MAX))
        im.save(out, "JPEG", quality=78, optimize=True, progressive=True)
    return fn


def build_prices(folder, report, photo_dir):
    files = sorted(glob.glob(os.path.join(folder, "*.docx")))
    cats = []
    problems = []
    for key, cid, fr, nl in CATEGORIES:
        match = [f for f in files if key in os.path.basename(f).lower().replace("é", "e")]
        if not match:
            problems.append(f"  fichier manquant pour '{fr}'")
            continue
        f = match[0]
        d = docx.Document(f)
        heads = [p.text.strip() for p in d.paragraphs if p.text.strip()]
        sections_titles = heads[1:]
        cat = {"id": cid, "fr": fr, "nl": nl, "levels": 0, "sections": []}
        for ti, t in enumerate(d.tables):
            hdr = [c.text.strip() for c in t.rows[0].cells]
            levels = [h for h in hdr if h and set(h) == {"*"}]
            cat["levels"] = max(cat["levels"], len(levels))
            title = sections_titles[ti] if ti < len(sections_titles) else f"Section {ti + 1}"
            if " / " in title:
                s_fr, s_nl = [x.strip() for x in title.split(" / ", 1)]
            else:
                s_fr, s_nl = title, SECTION_NL.get(title, title)
            sec = {"fr": s_fr, "nl": s_nl, "items": []}
            for r in t.rows[1:]:
                cells = r.cells
                names = [x.strip() for x in cells[0].text.strip().split("\n") if x.strip()]
                if not names:
                    continue
                item = {"fr": names[0], "nl": names[-1], "p": []}
                for lv, c in zip(levels, cells[1:1 + len(levels)]):
                    v = c.text.strip().replace(" ", "").replace("–", "-")
                    m = PRICE_RX.match(v)
                    if not m:
                        problems.append(f"  {fr} / {names[0]} {lv}: prix illisible {v!r}")
                        item["p"].append(None)
                        continue
                    lo = num(m.group(1))
                    hi = num(m.group(2)) if m.group(2) else lo
                    item["p"].append([lo, hi])
                photos = []
                for blip in cells[-1]._tc.xpath(".//a:blip"):
                    rid = blip.get("{http://schemas.openxmlformats.org/officeDocument/2006/relationships}embed")
                    try:
                        fn = save_photo(d.part.related_parts[rid].blob, photo_dir)
                    except Exception as e:  # unreadable image: skip it
                        problems.append(f"  {fr} / {names[0]}: photo illisible ({e})")
                        continue
                    if fn not in photos:
                        photos.append(fn)
                item["img"] = photos
                sec["items"].append(item)
            cat["sections"].append(sec)
        n = sum(len(s["items"]) for s in cat["sections"])
        report.append(f"PRIX {fr}: {len(cat['sections'])} sections, {n} articles, {cat['levels']} niveaux d'étoiles ({os.path.basename(f)})")
        cats.append(cat)
    report.append(f"\nProblèmes dans les listes de prix ({len(problems)}):")
    report += problems
    return cats


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--brands", required=True)
    ap.add_argument("--prices", required=True)
    a = ap.parse_args()

    data_dir = os.path.join(ROOT, "data")
    photo_dir = os.path.join(ROOT, "photos")
    os.makedirs(data_dir, exist_ok=True)
    os.makedirs(photo_dir, exist_ok=True)
    for old in glob.glob(os.path.join(photo_dir, "*.jpg")):
        os.remove(old)

    report = []
    brands = build_brands(a.brands, report)
    report.append("")
    cats = build_prices(a.prices, report, photo_dir)

    with open(os.path.join(data_dir, "brands.json"), "w", encoding="utf-8") as fh:
        json.dump(brands, fh, ensure_ascii=False, separators=(",", ":"))
    with open(os.path.join(data_dir, "prices.json"), "w", encoding="utf-8") as fh:
        json.dump({"built": datetime.date.today().strftime("%d/%m/%Y"), "categories": cats}, fh, ensure_ascii=False, separators=(",", ":"))
    with open(os.path.join(data_dir, "report.txt"), "w", encoding="utf-8") as fh:
        fh.write("\n".join(report) + "\n")
    print("\n".join(report[:3]))
    print(f"OK - voir data/report.txt ({len(os.listdir(photo_dir))} photos)")


if __name__ == "__main__":
    sys.exit(main())
