# Oxfam Merkentool / Outil de Marques (version web)

Version web de l'outil « Oxfam Textile Tool » (application Windows). On cherche une marque, l'outil donne ses étoiles. On choisit ensuite un article, et l'outil affiche la fourchette de prix pour ces étoiles, avec des photos d'exemple. L'outil est disponible en NL et en FR, et fonctionne sur PC, tablette et smartphone.

Il n'y a rien à installer : c'est un site statique, hébergé gratuitement sur **GitHub Pages**.

## Mise en ligne (une seule fois)

1. Sur GitHub, créez un dépôt (bouton **New repository**), par exemple `merkentool`.
2. Choisissez **Public**. GitHub Pages gratuit exige un dépôt public, sauf avec un compte payant.
3. Cliquez sur **uploading an existing file**, puis glissez-y **tout le contenu** de ce dossier : `index.html`, `app.js`, `style.css`, et les dossiers `data`, `photos`, `assets` et `tools`. Validez avec **Commit changes**.
4. Allez dans **Settings → Pages**. Sous *Build and deployment*, choisissez **Source : Deploy from a branch**, puis la branche **main** et le dossier **/ (root)**. Cliquez sur **Save**.
5. Après une à deux minutes, le site est en ligne à l'adresse `https://<votre-compte>.github.io/merkentool/`. Envoyez ce lien aux magasins. Ils peuvent l'ajouter à l'écran d'accueil du téléphone ou en favori sur le PC de caisse.

> Le site est public : toute personne qui a le lien peut le voir. Il ne contient que les marques, les étoiles et les fourchettes de prix, aucune donnée personnelle.

## Mettre à jour les marques ou les prix

Les données se trouvent dans `data/brands.json`, `data/prices.json` et `photos/`. Elles sont générées depuis les fichiers Excel et Word habituels. Ne modifiez pas ces fichiers à la main.

1. Installez Python 3, une seule fois, puis :
   ```
   pip install openpyxl python-docx pillow
   ```
2. Placez le fichier Excel des marques et les 6 fichiers Word `Liste_de_prix_*.docx` dans un dossier, puis lancez depuis ce dossier-ci :
   ```
   python tools/build_data.py --brands "chemin/vers/Merkentool.xlsx" --prices "chemin/vers/dossier_word"
   ```
3. Sur GitHub, téléversez les nouveaux dossiers `data` et `photos`, qui remplacent les anciens. Le site se met à jour en une à deux minutes.

**Formats attendus**

- **Excel des marques** : 1re feuille, colonne A = marque, colonne B = étoiles (`*` à `****`), colonne D = remarque (facultatif). La 1re ligne est un en-tête.
- **Word des prix** : un fichier par catégorie, dont le nom contient `Femmes`, `Hommes`, `Enfants`, `Bebes`/`Bébés`, `Accessoires` ou `Linge`. On y trouve d'abord le titre, puis, pour chaque section, un titre suivi d'un tableau : `Article / Artikel | * | ** | *** | **** | Photos`. Chaque article s'écrit `nom FR`, retour à la ligne, `nom NL`. Les prix se notent `3-5€`, `2,5-4€` ou `30€`. Les photos sont collées dans la dernière colonne.

À chaque génération, le script écrit **`data/report.txt`**. Ce fichier liste les points à corriger dans la source : étoiles mal saisies et marques en double avec des notes différentes.

## Règles appliquées

- Recherche de marque : sans tenir compte des majuscules, des accents ni des espaces. Une recherche commençant par « k » trouve aussi les marques en « c », et inversement (comme l'ancien outil).
- Marque sans étoiles : un message s'affiche et les étoiles se choisissent à la main.
- 5 étoiles (`*****`) dans le fichier Excel : compté comme `****`.
- Linge de maison : 3 niveaux seulement. Une marque `****` reçoit le prix `***`, avec un message.
- Marque en double dans l'Excel : la note est gardée. Si une seule ligne a des étoiles, c'est elle qui compte. Si les deux en ont, c'est la première qui compte (voir `report.txt`).

## Contenu

```
index.html, app.js, style.css   l'application
data/brands.json                 marques + étoiles
data/prices.json                 catégories, sections, articles, prix, photos
data/report.txt                  rapport de la dernière génération
photos/                          photos d'exemple (réduites)
assets/oxfam-logo.png
tools/build_data.py              générateur des données
```
