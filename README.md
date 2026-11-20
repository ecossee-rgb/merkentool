# Oxfam Merkentool / Outil de Marques (version web)

Version web de l'outil « Oxfam Textile Tool » (application Windows). Dans l'ordre : on choisit **1. le magasin**, **2. l'article**, puis **3. la marque** (facultatif ; l'outil donne ses étoiles), et enfin **4. le prix**. La fourchette de prix et des photos d'exemple sont affichées en dessous. L'outil est disponible en NL et en FR, et fonctionne sur PC, tablette et smartphone.

Le vendeur choisit ensuite **son prix** dans la fourchette, et l'outil affiche la **référence Onlinefact** du produit à scanner ou à taper à la caisse. Il peut **mémoriser ce prix**, pour une marque ou pour l'article sans marque : la prochaine fois, dans ce magasin, la même marque et le même article afficheront directement ce prix et sa référence. Les prix mémorisés sont partagés par tous les appareils du magasin, grâce à une petite base de données gratuite (Supabase). L'outil ne s'ouvre qu'avec un code magasin.

Il n'y a rien à installer : c'est un site statique, hébergé gratuitement sur **GitHub Pages**.

## Mise en ligne (une seule fois)

1. Sur GitHub, créez un dépôt (bouton **New repository**), par exemple `merkentool`.
2. Choisissez **Public**. GitHub Pages gratuit exige un dépôt public, sauf avec un compte payant.
3. Cliquez sur **uploading an existing file**, puis glissez-y **tout le contenu** de ce dossier : `index.html`, `app.js`, `style.css`, et les dossiers `data`, `photos`, `assets` et `tools`. Validez avec **Commit changes**.
4. Allez dans **Settings → Pages**. Sous *Build and deployment*, choisissez **Source : Deploy from a branch**, puis la branche **main** et le dossier **/ (root)**. Cliquez sur **Save**.
5. Après une à deux minutes, le site est en ligne à l'adresse `https://<votre-compte>.github.io/merkentool/`. Envoyez ce lien aux magasins. Ils peuvent l'ajouter à l'écran d'accueil du téléphone ou en favori sur le PC de caisse.

> Le site est public : toute personne qui a le lien peut le voir. Il ne contient que les marques, les étoiles et les fourchettes de prix, aucune donnée personnelle.

## Activer les prix mémorisés par magasin (Supabase, une seule fois)

Tant que `config.js` est vide, l'outil fonctionne en **mode test** : les prix sont mémorisés uniquement sur l'appareil.

1. Créez un compte gratuit sur **https://supabase.com**, de préférence avec une adresse Oxfam partagée, puis cliquez sur **New project**. Donnez-lui le nom `merkentool`, choisissez un mot de passe (à garder) et la région **Europe (Frankfurt ou Paris)**.
2. Dans le projet, allez dans **SQL Editor → New query**. Collez tout le contenu de `supabase/setup.sql` et cliquez sur **Run**.
3. Toujours dans le SQL Editor, créez vos magasins, un code par magasin, puis cliquez sur **Run** :
   ```sql
   select add_shop('Namur', '4821');
   select add_shop('Gent', '7310');
   ```
   La même commande change le code d'un magasin existant. `select disable_shop('Namur');` retire un magasin de la liste.
4. Allez dans **Project Settings → API** et copiez la **Project URL** et la clé **anon / public** (parfois appelée *publishable*). N'utilisez **jamais** la clé *service_role / secret*.
5. Sur GitHub, ouvrez `config.js`, cliquez sur le crayon ✏️ et collez les deux valeurs :
   ```js
   window.MERKENTOOL_CONFIG = {
     supabaseUrl: "https://xxxxxxxx.supabase.co",
     supabaseKey: "eyJhbGciOi..."
   };
   ```
   Cliquez sur **Commit changes**. Une à deux minutes plus tard, l'outil demande le magasin et son code au premier lancement sur chaque appareil.

La clé *anon* peut être visible publiquement : elle donne seulement accès aux fonctions de l'outil, et chaque lecture ou écriture vérifie le code du magasin.

**Voir les prix de tous les magasins** : dans Supabase, ouvrez **Table Editor → pref_report**, ou lancez `select * from pref_report;` dans le SQL Editor. Vous pouvez ensuite exporter le résultat en CSV.

**Bon à savoir** : sur le plan gratuit, Supabase met le projet en pause après 7 jours sans aucune utilisation. Cela ne devrait pas arriver si les magasins utilisent l'outil. S'il est en pause, un clic sur *Restore* dans Supabase suffit, et rien n'est perdu.

## Données protégées (marques, listes de prix)

Les marques, les listes de prix et les références Onlinefact ne sont **plus sur GitHub** : elles sont dans la base Supabase, et l'outil ne les reçoit qu'après la saisie d'un **code magasin** valide. Le dépôt GitHub ne contient que le code de l'application et les photos d'exemple.

- **Code administrateur** : à définir une fois dans Supabase (SQL Editor), au moins 10 caractères, à garder secret :
  ```sql
  select set_admin_code('un-long-mot-de-passe');
  ```
- **Page d'administration** : `https://<votre-compte>.github.io/merkentool/admin.html`. Elle permet de charger `brands.json` et `prices.json` dans la base et affiche la date de la dernière mise à jour.
- **Anti-devinette** : après 10 codes erronés en 15 minutes, le magasin (ou l'admin) est bloqué 15 minutes. Les essais simultanés sont comptés un par un. Pour débloquer plus tôt : `select unblock_shop('Shop Brugge');`
- **Prix mémorisés vérifiés** : en mémorisant un prix, le serveur vérifie que le couple prix + référence Onlinefact existe bien pour cet article dans la liste de prix actuelle, et que la marque existe. Les anciens choix ne sont jamais effacés : s'ils n'existent plus dans le catalogue, l'outil l'indique au magasin, et la colonne **statut** de `pref_report` affiche « plus dans le catalogue ».
- **Chargements vérifiés** : chaque marque, prix, référence et nom de photo est contrôlé avant d'être accepté. Si une seule entrée est refusée, rien n'est remplacé et la page admin indique laquelle. Pour contrôler les données déjà en base : `select check_app_data();`
- **Retour arrière de la base** : `supabase/rollback.sql` remet les fonctions de la base dans leur état d'avant la mise à jour de sécurité (version 0cfe1a5), sans toucher aux magasins, aux codes, aux prix mémorisés ni aux données. Remettre les anciennes pages sur GitHub ne suffit pas : il faut aussi exécuter ce script.

## Mettre à jour les marques ou les prix

1. Installez Python 3, une seule fois, puis :
   ```
   pip install openpyxl python-docx pillow
   ```
2. Placez le fichier Excel des marques et les 6 fichiers Word `Liste_de_prix_*.docx` dans un dossier. Préparez aussi le fichier d'import des produits Onlinefact (CSV), puis lancez depuis ce dossier-ci :
   ```
   python tools/build_data.py --brands "chemin/vers/Merkentool.xlsx" --prices "chemin/vers/dossier_word" --onlinefact "chemin/vers/Import_produits.csv"
   ```
3. Ouvrez **admin.html**, entrez le code administrateur et envoyez les nouveaux `data/brands.json` et `data/prices.json`. **Ne mettez pas le dossier `data` sur GitHub.**
4. Si des photos ont changé, téléversez le dossier `photos` sur GitHub.

**Formats attendus**

- **Excel des marques** : 1re feuille, colonne A = marque, colonne B = étoiles (`*` à `****`), colonne D = remarque (facultatif). La 1re ligne est un en-tête.
- **Word des prix** : un fichier par catégorie, dont le nom contient `Femmes`, `Hommes`, `Enfants`, `Bebes`/`Bébés`, `Accessoires` ou `Linge`. On y trouve d'abord le titre, puis, pour chaque section, un titre suivi d'un tableau : `Article / Artikel | * | ** | *** | **** | Photos`. Chaque article s'écrit `nom FR`, retour à la ligne, `nom NL`. Les prix se notent `3-5€`, `2,5-4€` ou `30€`. Les photos sont collées dans la dernière colonne.

- **CSV Onlinefact** (séparateur `;`) : colonnes `Reference`, `Description`, `Price`. La description s'écrit `<Vrouw|Man|Kind|Baby|Accessoires|Huishoudtextiel> - <nom NL de l'article> <étoiles>`, par exemple `Vrouw - Jeans ***`. Il faut un produit par article, par niveau d'étoiles et par prix.

À chaque génération, le script écrit **`data/report.txt`**. Ce fichier liste les points à corriger dans la source : étoiles mal saisies, marques en double avec des notes différentes, produits Onlinefact sans article correspondant, et articles sans référence.

**Attention aux noms d'articles** : un prix mémorisé est lié au nom NL de l'article. Si un article est renommé dans les listes de prix, les prix déjà mémorisés pour cet article ne s'affichent plus.

## Règles appliquées

- Recherche de marque : sans tenir compte des majuscules, des accents ni des espaces. Une recherche commençant par « k » trouve aussi les marques en « c », et inversement (comme l'ancien outil).
- Marque sans étoiles : un message s'affiche et les étoiles se choisissent à la main.
- 5 étoiles (`*****`) dans le fichier Excel : compté comme `****`.
- Linge de maison : 3 niveaux seulement. Une marque `****` reçoit le prix `***`, avec un message.
- Choix du prix : seuls les prix qui existent comme produit dans Onlinefact sont proposés, donc chaque prix a une référence valide.
- Sans marque ni étoiles, tous les prix de l'article sont proposés, classés par étoiles.
- Un prix mémorisé sans marque sert aussi de proposition quand on choisit une marque avec le même nombre d'étoiles, tant que cette marque n'a pas son propre prix.
- Prix mémorisé : il est lié au magasin, à la marque (ou « toutes marques ») et à l'article, quelles que soient les étoiles. S'il appartient à un autre niveau d'étoiles que celui affiché, il est quand même rappelé, avec la mention « autres étoiles ».
- Marque en double dans l'Excel : la note est gardée. Si une seule ligne a des étoiles, c'est elle qui compte. Si les deux en ont, c'est la première qui compte (voir `report.txt`).

## Contenu

```
index.html, app.js, style.css   l'application
config.js                        connexion à Supabase (vide = mode test)
supabase/setup.sql               script de la base de données
supabase/rollback.sql            retour arrière de la mise à jour de sécurité
admin.html, admin.js             page d'administration (chargement des données)
photos/                          photos d'exemple (réduites)
assets/oxfam-logo.png
tools/build_data.py              générateur des données
```
