# Engineering AI Console

[English](README.md) · [简体中文](README_ZH.md) · [Français](README_FR.md) · [Русский](README_RU.md)

**Une console maître locale pour une boucle d'ingénierie en quatre étapes : réfléchir, mandater,
construire, auditer.**
Aucun preset fournisseur, aucune liste de modèles imposée, aucune télémétrie. Les points d'accès
compatibles OpenAI et Anthropic sont traités à égalité ; n'importe quel identifiant de modèle
peut être saisi à la main.

---

## 1. Ce que c'est, et la boucle à laquelle cet outil répond

```
        ┌──────────────────────── console distante ────────────────────────┐
        │  Agent 1 : chef d'état-major d'ingénierie                        │
        │  raisonnement direct · capsules d'action · distillation de bilan │
        └───────────────▲──────────────────────────────────────┬───────────┘
                        │  tampon copier / coller manuel       │
                        │                                      ▼
        ┌───────────────┴──────────────┐        ┌──────────────────────────────┐
        │ Agent 2 : exécutant sans état│        │ Agent 3 : auditeur adverse   │
        │ fenêtre locale neuve, code,  │        │ fenêtre locale neuve, audite │
        │ rapporte changements/erreurs │        │ l'idée, ne modifie jamais    │
        └──────────────────────────────┘        └──────────────────────────────┘
```

La console écoute sur une adresse de bouclage de votre propre machine, mais l'agent 1 reste le
rôle **distant / purement conversationnel** : il ne monte ni votre répertoire de projet ni un
terminal, ce qui garde le contexte de raisonnement de haut niveau propre au lieu de le saturer
de code source et de journaux. Les agents 2 et 3 sont, eux, des agents locaux : ils montent
directement le dossier du projet et appellent la vraie chaîne de compilation et de test de la
machine.

L'agent 1, c'est cette console. Il discute le problème en langage d'ingénieur, refuse les
solutions creuses et transforme le plan en deux invites prêtes à coller :

1. **Générer l'instruction d'exécution (Agent 2)** — une consigne de construction stricte :
   périmètre de fichiers borné, aucune abstraction inventée, liste de modifications et rapport
   d'exception obligatoires.
2. **Générer l'audit critique (Agent 3)** — une invite d'audit non orientée, orientée
   falsification : solidité d'ensemble, hypothèses cachées, modes de défaillance temps réel /
   concurrence / physique, expériences exigées, surconception à retirer.
3. Collez le résultat de construction ou le rapport d'audit, puis cliquez sur **Synthétiser le
   rapport** pour obtenir une « fiche de décision feu tricolore » en trois points, en langage
   courant : peut-on livrer, ce qu'il faut vraiment corriger, quelles pinailles écarter.

Lorsqu'un cycle franchit tous les garde-fous locaux, l'agent 2 l'enregistre sous forme de
**commits de point de contrôle locaux** modulaires : des ancres de retour immédiates pour
l'humain et des diffs incrémentaux propres pour l'agent 3. L'agent 3 reste strictement en
lecture seule ; rien n'est poussé vers un dépôt distant avant validation humaine.

Le copier/coller est volontaire. Ce tampon manuel est un **disjoncteur humain dans la boucle** :
seul l'ingénieur y déplace du texte, de sorte qu'une IA ne peut ni réécrire sa propre piste
d'audit, ni toucher du matériel sans que l'humain le voie.

---

## 2. Démarrage en trente secondes

### Voie A — service Python local (recommandé)

Prérequis : **Python 3.9 ou plus récent, aucune dépendance tierce, pas besoin de Node.js.**

- **Windows :** double-cliquez sur `start.bat`.
- **Linux / macOS :** lancez `./start.sh` (ou `python3 server.py`).
- Sous Windows, le lanceur démarre le service en arrière-plan via `pythonw.exe` — aucune fenêtre
  de console résidente — puis la fenêtre CMD se ferme aussitôt ; `start.sh` exécute
  `server.py --auto-exit` dans le terminal. Les deux ouvrent le navigateur par défaut sur la page
  locale, n'écoutent que sur la boucle locale, et un second lancement réutilise l'instance déjà
  active au lieu d'en démarrer une deuxième.
- Fermer tous les onglets de la console arrête le service d'arrière-plan environ 5 secondes plus
  tard ; un rafraîchissement (F5) dans cet intervalle se reconnecte et n'est jamais pris pour une
  fermeture. Ajoutez des arguments (par exemple `start.bat --port 18770` ou
  `start.bat --foreground`) pour conserver une fenêtre visible et lire la sortie du terminal.
- En l'absence d'interpréteur Python valide, le lanceur ouvre simplement la page statique. Une
  sortie non nulle de `server.py` laisse apparaître la véritable erreur Python.

### Voie B — mode statique direct (zéro installation)

Double-cliquez sur `dist/index.html` : la console s'exécute entièrement dans le navigateur.
La configuration réside dans le stockage local du navigateur et les requêtes partent
directement de la page vers votre point d'accès (sous réserve des règles CORS habituelles).
Ce mode ne s'applique qu'à une page ouverte depuis un fichier local (`file://`) ; une page
servie en http(s) sans le service local reste en mode serveur et affiche un bandeau hors ligne
au lieu de basculer silencieusement.

### Première voie en quatre étapes

Ouvrez **Réglages → Canaux** et choisissez `Primaire` ou `Sauvegarde`, puis :

1. Choisissez le protocole avec le sélecteur segmenté à deux états (**Compatible OpenAI** /
   **Anthropic Messages**).
2. Collez l'URL de base. La ligne **URL finale de la requête** sous le champ se recalcule à
   chaque frappe et à chaque changement de protocole : on voit immédiatement si `/v1` est
   ajouté pour vous, avant la première requête.
3. Collez la clé API **avant** de sonder le point d'accès. Elle est enregistrée automatiquement
   lorsque le champ perd le focus ou que la fenêtre de réglages se ferme ; seuls les quatre
   derniers caractères restent visibles.
4. Saisissez n'importe quel identifiant de modèle — aucune liste n'est imposée et aucun défaut
   n'est caché — ou cliquez sur **Récupérer les modèles (Fetch models)** pour le remplir depuis
   le point d'accès. Cliquez ensuite sur **Tester la connexion (Test connection)**. Tout ce qui
   concerne les passerelles particulières (verrouillage de l'URL brute, champs de raisonnement,
   variable d'environnement de clé, en-têtes personnalisés, délai d'expiration, analyse PDF
   distante) réside dans le panneau **Réglages avancés**, replié par défaut et doté d'un
   compteur des dérogations actives.

La **réflexion approfondie** est un passthrough standard sur un canal compatible OpenAI par
défaut : la requête ne porte que `model`, `messages` et `stream`, si bien qu'une passerelle
inconnue ne peut pas la rejeter en 400 pour un champ propriétaire non demandé. L'interrupteur
ne fait que basculer vers le modèle de réflexion configuré ; choisissez un format de requête
explicite dans les réglages avancés lorsque la passerelle l'exige.

---

## 3. L'usage quotidien, concrètement

- **Bascule à chaud en un clic entre le canal primaire et le canal de sauvegarde.** Les deux
  emplacements partagent le même constructeur de requête, la même chaîne de pièces jointes et
  la même frontière de sécurité : basculer ne change jamais la forme de la requête.
- **Analyse locale et déterministe, sans deviner.** Le code source, les fichiers de
  configuration et les journaux industriels décalés (UTF-8 → GB18030 → windows-1252) sont
  décodés localement ; les `.docx` / `.xlsx` / `.pptx` sont lus depuis leur XML interne sans
  aucun service distant ; les images sont transmises en ligne via des data URLs. Un garde-fou
  de troncature à 200 Ko empêche un journal géant d'envahir le contexte (120 Ko de tête +
  60 Ko de queue).
- **Les erreurs multimodales se dégradent au lieu de faire échouer le cycle.** Si un point
  d'accès refuse les blocs image en HTTP 400/415/422, les images sont retirées, un avis
  d'omission explicite est ajouté et la requête est réessayée une fois en texte. Un message
  composé uniquement d'images s'arrête proprement et restaure son brouillon.
- **Allègement du contexte message par message et retour arrière d'un cran.** Chaque message
  peut être compacté tandis que l'original reste lisible à l'écran ; la conversation peut
  revenir à n'importe quel point pour essayer une branche plus propre.
- **Réinitialisation graduée, pas un bouton nucléaire.** La réinitialisation douce coupe
  immédiatement les flux locaux (la connexion amont est libérée à l'expiration du délai de
  lecture du canal) et conserve discussions, brouillons et clés. La réinitialisation complète
  propose d'abord un export texte de secours, puis vide toutes les sessions IndexedDB dans une
  seule transaction et efface le cache local des brouillons.
- **Solarized clair/sombre, quatre échelles de police sans perte, largeur standard/large et
  mode anti-scintillement.** Interface disponible en anglais, chinois simplifié, français et
  russe.

---

## 4. Limites techniques, protection de la vie privée et référence pour le développement

### 4.1 Confidentialité et liste exhaustive des trafics sortants

Cet outil est conçu pour être auditable, pas pour renvoyer des données.

- Le service local n'écoute que sur **`127.0.0.1`** — jamais `0.0.0.0`, jamais une interface
  du réseau local. Sans `--port`, il balaie la plage `18765..18795` via le `GET /api/health`
  sans jeton ; si l'identité de ce service répond, il ouvre cette instance précise au lieu
  d'en lier une seconde. Sinon il se lie à `18765` (ou au premier port libre jusqu'à `18795`).
- Chaque appel `/api/*` exige le jeton `X-Console-Token` injecté dans le HTML servi, plus une
  vérification d'`Origin` strictement same-origin et d'`Host` en boucle locale. La seule
  exception assumée est `GET /api/health` (détection d'instance unique) : il accepte une
  requête sans jeton, mais les contrôles `Host` et `Origin` same-origin restent appliqués.
- Le seul trafic lié au cycle de vie de la page reste local : `POST /api/lifecycle` sur
  `127.0.0.1` (un battement au montage, puis toutes les 20 secondes, et un `leave` keepalive
  lorsque la page se ferme). Il ne quitte jamais la machine et suit les mêmes contrôles de jeton
  et d'origine. Seul `server.py --auto-exit` en tient compte : fermer tous les onglets de la
  console arrête le service d'arrière-plan environ 5 secondes plus tard, tandis qu'un
  rafraîchissement dans cet intervalle le maintient en vie.
- Les fichiers statiques ne sont lus que dans `dist/`, avec vérification du chemin résolu et
  rejet de la traversée de répertoire comme des octets NUL.
- Les corps de requête sont bornés : 1 Mo pour les points d'accès de configuration, 32 Mo pour
  le chat et le transfert de fichiers. Un `Content-Length` absent ou mensonger est rejeté.
- Les clés API et les valeurs d'en-têtes personnalisés résident dans `secrets.json`, dans le
  répertoire de données (`--data-dir`, par défaut `.console_data/`) ; `settings.json` ne les
  contient jamais. La page ne voit que `hasKey`, les quatre derniers caractères et une
  empreinte unidirectionnelle de 12 caractères hexadécimaux. Sur POSIX, les fichiers secrets
  sont en `0600`. Une variable d'environnement configurée par nom prime sur la clé stockée.
- L'interface ne charge **aucun lien, police, icône ou badge externe** et n'écrit jamais dans
  le presse-papiers d'elle-même ; chaque copie est un clic explicite.
- Les requêtes sortantes sont strictement séparées par étape ; voici la liste complète :
  - **Ajout d'une pièce jointe au brouillon (avant l'envoi).** Sources, journaux, fichiers de
    configuration, documents Office (`.docx` / `.xlsx` / `.pptx`) et images sont décodés,
    décompressés ou encodés entièrement dans le navigateur : **aucune requête réseau** n'est
    émise. Seule exception : un `.pdf` ajouté ou retiré lorsqu'un canal a activé l'**analyse
    documentaire distante (Anthropic Files API)** (champ de configuration `enableRemoteFileApi`) —
    l'ajout envoie `POST .../files`, le retrait d'un PDF de brouillon non envoyé envoie
    `DELETE .../files`.
  - **Envoi du message.** Le texte extrait localement (encadré par `<attached_file>`), les
    données d'image en ligne et le `file_id` éventuel d'un PDF distant font partie du contexte
    de ce tour et partent avec la requête de chat vers le point d'accès du canal actif.
  - **Test de connectivité** et bouton **« Récupérer les modèles »** des réglages d'un canal :
    chacun envoie une requête `GET .../models` portant les identifiants de ce canal.
  - **Récupération Exa**, si elle est activée : les requêtes de recherche vont au point d'accès
    Exa configuré.
  - **Téléversement / suppression de PDF distant**, uniquement avec `enableRemoteFileApi`
    activé, selon les règles ci-dessus.
- Deux détails réseau complètent cette liste. En mode statique direct `file://`, le navigateur
  peut d'abord émettre une requête préalable `OPTIONS` sans identifiants selon les règles CORS
  standard avant une requête métier cross-origin (chat, modèles, Exa ou Files) ; cette requête
  préalable ne porte ni clé d'API ni valeur d'en-tête personnalisée et est générée par le
  navigateur, pas par la console. La récupération Exa (`/api/search/exa`) dispose de son propre
  délai maximal borné de 30 secondes, indépendant du délai de flux personnalisé d'un canal.
- Si vous changez l'URL, le protocole ou la clé d'un canal puis téléversez ou supprimez
  immédiatement un fichier distant, le point d'entrée de l'API fichiers synchronise d'abord
  l'écriture différée de 350 ms vers le service local, puis recalcule l'empreinte
  d'appartenance du fichier à partir de cette configuration synchronisée : un fichier n'est
  jamais téléversé vers la passerelle précédente, et une suppression distante n'est jamais
  envoyée vers un autre point d'accès ou un autre espace d'identifiants.
- Au démarrage, un ancien en-tête personnalisé en clair trouvé dans `settings.json` est migré
  vers `secrets.json` ; le nouveau `secrets.json` est immédiatement recopié dans
  `secrets.json.bak` (et le `settings.json` nettoyé dans son propre `.bak`). Si le remplacement
  d'une sauvegarde échoue, la console conserve un marqueur persistant et signale un stockage
  dégradé jusqu'à ce qu'une resynchronisation exacte réussisse — un plantage ultérieur ne peut
  donc ni ressusciter un ancien texte en clair, ni perdre l'identifiant migré.

### 4.2 Intersection des capacités primaire / sauvegarde

Les deux emplacements passent par le même sérialiseur, la même chaîne de pièces jointes et la
même frontière de sécurité. Les différences sont limitées et explicites :

- **L'historique textuel est neutre vis-à-vis du protocole.** Une conversation peut passer
  d'OpenAI à Anthropic et revenir en cours de fil, car chaque requête est re-sérialisée à
  partir du même historique textuel neutre.
- **Les blocs de raisonnement ne sont jamais rejoués.** Seuls le texte utilisateur et le texte
  de l'assistant entrent dans la requête suivante ; une trace de réflexion affichée dans
  l'interface ne part jamais vers l'autre protocole.
- **L'analyse PDF distante et l'outil de recherche web natif DeepSeek exigent le protocole
  Anthropic.** Les fichiers distants exigent en outre un point d'accès servant l'Anthropic
  Files API ; la recherche native exige une passerelle déclarant explicitement prendre en
  charge `deepseek_web_search`. « Compatible Anthropic » n'est pas une promesse : sans cette
  déclaration, la passerelle peut rejeter la requête ou ignorer l'outil. Les emplacements
  compatibles OpenAI conservent l'analyse locale des pièces jointes et la récupération Exa.
- Les champs de raisonnement sont injectés uniquement selon la stratégie choisie (désactivé,
  raisonnement étendu Anthropic, raisonnement DeepSeek, effort de raisonnement OpenAI,
  enable-thinking) ; aucun champ propriétaire n'est injecté par défaut. Le canal compatible
  OpenAI par défaut reste donc en passthrough, et toute autre stratégie est une dérogation
  explicite listée dans les réglages avancés. Le raisonnement étendu Anthropic et une
  température personnalisée s'excluent mutuellement.

### 4.3 Règles de réinitialisation, de sauvegarde et de données

- La **réinitialisation douce** interrompt immédiatement tous les flux locaux et déverrouille
  l'interface ; discussions, brouillons et clés sont intacts. La connexion amont côté serveur
  est fermée à l'expiration du délai de lecture du canal.
- La **réinitialisation complète** propose d'abord un export texte de secours, puis vide tous
  les enregistrements de session dans une seule transaction IndexedDB en lecture/écriture
  (sans supprimer la base, donc les autres onglets ouverts continuent de fonctionner), efface
  le cache local des brouillons et recharge la page. La configuration revient aux valeurs par
  défaut ; les clés stockées localement peuvent être conservées sur demande.
- Si la phase destructive échoue, la page ne se recharge pas : les messages interrompus sont
  ramenés à l'état `stopped` et les verrous de flux sont libérés, de sorte que la console ne
  reste jamais figée dans un état « génération en cours » sans bouton d'arrêt ni de reprise.
- L'**import de sauvegarde JSON** est strictement validé avant toute écriture : limite de
  32 Mo, nombre de sessions et de messages borné, plage d'horodatages plausible, écriture
  atomique en une transaction. Les discussions existantes sont conservées ; les identifiants
  en collision sont régénérés.
- Les brouillons utilisent deux espaces de noms disjoints : la page d'accueil utilise
  `eac:draft:welcome`, chaque session utilise `eac:draft:session:` + l'identifiant de session.
  Supprimer ou vider une session ne peut donc jamais toucher le brouillon d'une autre session
  ni celui de la page d'accueil.

### 4.4 Construire depuis les sources et structure du dépôt

Prérequis : **Node.js `20.19+` ou `22.12+`**, plus `pnpm` (ou `corepack pnpm` / `npx pnpm`).

```bash
pnpm install
pnpm type     # TypeScript, 0 erreur
pnpm lint     # oxlint, 0 avertissement et 0 erreur
pnpm build    # build rspack + bundle de licences tierces, sans source map
pnpm test     # quatre autotests : logique, navigateur, sécurité serveur, confidentialité
```

`dist/` est versionné volontairement : une machine disposant seulement d'un navigateur peut
exécuter la console hors ligne, et une machine disposant seulement de Python peut lancer le
service local. L'utilisateur final n'a pas besoin d'une chaîne de build. Le bundle
`dist/THIRD_PARTY_LICENSES.txt` reproduit la licence de chaque dépendance d'exécution, y
compris les avis intégrés connus (extension mhchem de KaTeX, implémentation Thenable de
Cytoscape) et le résultat d'un balayage automatique des mentions de copyright embarquées
qu'aucun fichier de licence de paquet ne couvre.

```
src/                    front-end React + TypeScript
  services/api/         normalisation d'URL, sérialisation bi-protocole, parsing SSE, chiens de garde
  services/chat/        sessions, brouillons, compactage, réinitialisation, sauvegarde, export texte
  services/config/      configuration canaux/UI/invites, assainisseurs, persistance serveur/statique
  services/attachments/ décodage local, extraction XML Office, garde-fou de troncature
  components/           barre supérieure, capsules d'action, composeur, messages, réglages, panneau
  i18n/                 en.ts (référence), zh.ts, fr.ts, ru.ts
server.py               micro-service local Python 3.9+ en un seul fichier
start.bat / start.sh    lanceurs (auto-exit sans console au double-clic, premier plan avec arguments ; start.sh exécutable, mode 100755)
scripts/                scripts de build, dont le bundle de licences tierces
tests/                  autotests logique, navigateur, sécurité serveur et confidentialité
dist/                   build de production versionné ; sans source map
```

Le service local est un proxy de commodité au modèle de confiance étroit : il fait confiance au
navigateur local et à l'utilisateur local. Tout processus capable de lire `.console_data/` peut
lire `secrets.json` ; protéger une machine déjà compromise n'est pas dans le périmètre. N'exposez
pas le port du service via un reverse proxy ou une redirection de port.

---

## 5. Remerciements et non-affiliation

Le front-end de chat en streaming, propre et léger, dont cette console est partie, a été publié
en open source par le projet [**deepseek-ai/chat-demo**](https://github.com/deepseek-ai/chat-demo).
Il a fourni à ce projet une base solide et lisible pour la chaîne de rendu
Markdown/KaTeX/Mermaid et les primitives d'interface de conversation. Sur cette base, ce projet
a développé sa propre couche de canaux dé-vendorisée, sa tolérance aux pannes bi-protocole, son
architecture de sécurité locale et le flux d'ingénierie en quatre étapes. Merci aux auteurs et
contributeurs amont.

**Ce projet est un dérivé open source communautaire indépendant. Il n'entretient avec DeepSeek
aucune relation d'affiliation, de partenariat, d'autorisation ou de caution.** L'ensemble du
comportement de la console, de la gestion des canaux, du service local, du système d'invites, du
flux d'audit et de chaque modification de ce dépôt est maintenu par les contributeurs de ce
projet. Le nom DeepSeek n'apparaît que pour créditer le projet amont et décrire la compatibilité
protocolaire.

---

## 6. Avertissement d'ingénierie et de sécurité industrielle

Cet outil sert à soutenir l'exploration technique précoce, à révéler tôt les angles morts et à
empêcher le code prototype de gonfler au-delà de ce qu'un humain peut relire. Il pousse
délibérément vers des implémentations minimales et inspectables.

**Une invite d'audit stricte n'est pas une homologation de sécurité industrielle.** Ce logiciel
n'a été certifié selon aucune norme IEC 61508, ISO 26262, IEC 62304, DO-178C ou autre norme de
sûreté de fonctionnement, médicale, automobile ou aéronautique. Le raisonnement d'une IA ne
remplace pas la vérification physique et peut manquer des interblocages temps réel, des
conditions de concurrence, des conflits d'échantillonnage ou de synchronisation, des
instabilités numériques ou des défaillances aux limites matérielles. Avant que quelque sortie
n'atteigne un automate, un banc d'essai ou une machine industrielle, un ingénieur qualifié doit
la relire ligne par ligne et mener une simulation indépendante, des essais sur banc et une
conception de protection au niveau matériel. Vous restez responsable de chaque décision prise
avec cet outil.

---

## 7. Licence

MIT. Voir [LICENSE](LICENSE).

```
Copyright (c) 2026 Jiawei Li
Portions Copyright (c) 2026 DeepSeek (derived from deepseek-ai/chat-demo)
```

Le projet amont `deepseek-ai/chat-demo` est crédité pour la chaîne de rendu
Markdown/KaTeX/Mermaid/Prism et les primitives d'interface de base adaptées ; tout le
comportement de la console, la gestion des canaux, le service local, le système d'invites et le
flux d'audit font partie de ce dépôt.
