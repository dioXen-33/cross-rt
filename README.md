# Cross-RT

Outil auto-hébergé pour que certains de vos comptes X retweetent automatiquement
les posts de vos autres comptes — **sans API officielle, sans navigateur, sans clé, sans
abonnement**.

Architecture hybride, chaque étape par le moyen le plus adapté :

- **Détection** — API GraphQL interne de X (`UserByScreenName` puis `UserTweets`),
  authentifiée par les cookies d'une session. Limites rattachées **aux comptes, pas à
  l'adresse IP** ; tous les comptes sources sont lisibles, y compris sans audience.
- **Retweet** — clic dans un **vrai Chromium**. Sur la page, c'est le JavaScript de X
  qui produit lui-même les jetons anti-robot que l'appel API nu ne pouvait pas fournir
  (et qui lui valaient un refus en code 226).
- **Proxy par compte** — lecture et navigateur sortent par la **même IP que le VA** qui
  gère ce compte, ce qui évite les alertes de sécurité liées à un changement de pays.

Aucune dépendance lourde : Express et le SQLite intégré de Node. L'outil pèse quelques
mégaoctets et un retweet prend environ 200 ms.

---

## ⚠️ À lire avant de l'utiliser

Cet outil appelle une **API interne non documentée**, avec des cookies de session, pour
automatiser des retweets croisés entre comptes que vous contrôlez. Cela cumule deux
infractions aux conditions de X : l'accès non autorisé à une interface privée, et le
contenu dupliqué entre comptes liés.

**Le risque concret est la suspension des comptes**, et contrairement à l'API officielle
il n'existe ici ni canal déclaré ni recours. Les garde-fous intégrés — délais aléatoires,
décalage entre comptes, plafond horaire, filtres — réduisent le risque sans l'éliminer.

**Sécurité** : le cookie `auth_token` donne le contrôle total d'un compte, sans mot de
passe et sans 2FA. Il est chiffré en AES-256-GCM dans la base et n'est jamais journalisé
ni renvoyé par l'API de l'interface. Ne le confiez jamais à un service tiers, et mettez
un `UI_PASSWORD` si la machine n'est pas strictement personnelle.

---

## Installation

```bash
npm install
```

```bash
npm start
```

Ouvrez <http://127.0.0.1:3000>. Node 22.5 ou plus est requis. Aucune configuration
n'est nécessaire : le `.env` ne sert qu'à changer le port ou protéger l'interface.

## Utilisation

**Comptes à retweeter** : ajoutez-les par pseudo, rien d'autre. Ils n'ont pas besoin
d'être connectés : ils sont lus avec la session d'un compte amplificateur. Leur audience
n'a aucune importance.

> **Au moins une session est nécessaire pour lire.** Tant qu'aucun compte amplificateur
> n'a ses cookies importés, la détection ne peut pas fonctionner. L'encart en haut de
> l'interface indique le nombre de sessions de lecture disponibles.

**Comptes qui retweetent** : ajoutez-les par pseudo, puis importez leurs cookies.

### Importer une session

1. Connectez-vous à `@lecompte` dans votre navigateur habituel.
2. Sur `x.com` : **F12 → Application → Cookies → `https://x.com`**.
3. Copiez les valeurs de **`auth_token`** et **`ct0`**.
4. Dans Cross-RT, cliquez **Importer une session**, collez les deux valeurs, validez.

L'import stocke les cookies (chiffrés) et tente de les valider auprès de X. Trois issues :

- **cookies confirmés valides** → « Session importée et validée » ;
- **cookies confirmés invalides** (X répond « authentification impossible ») → import refusé ;
- **X ne permet pas de conclure** (voir ci-dessous) → cookies enregistrés quand même, la
  validation est reportée au premier retweet, qui est de toute façon le juge de paix.

> **Pas de contrôle automatique du compte.** X ayant fermé les endpoints qui renvoyaient
> le pseudo connecté, l'outil ne peut plus vérifier tout seul que les cookies correspondent
> au bon compte. **Vérifiez vous-même** que votre navigateur est bien connecté au compte
> voulu avant de copier les cookies : le compte réellement relié est celui de ces cookies.

> La session importée est celle de votre navigateur : si vous vous déconnectez de
> `@lecompte` dans Brave, la session de Cross-RT tombe aussi. Fermer l'onglet ou le
> navigateur ne pose en revanche aucun problème.

---

## Comment ça marche

```
toutes les 10 s
  ├─ détection : UN compte source, à tour de rôle, avec une session de lecture
  │    GET .../graphql/<qid>/UserByScreenName   (une seule fois, mis en cache)
  │    GET .../graphql/<qid>/UserTweets
  │      └─ filtres (réponse, RT, âge, mots-clés)
  │           └─ un job par amplificateur, à T + délai aléatoire + décalage
  │
  ├─ exécution : jobs échus, 3 max par cycle, jamais 2 sur le même compte
  │    Chromium (profil du compte, proxy du compte)
  │      → cookies injectés → x.com/<auteur>/status/<id>
  │      → clic retweet → confirmation → vérification que le bouton a basculé
  │
  └─ contrôle : une session vérifiée par cycle si elle a plus de N heures
       GET api.x.com/2/badge_count/badge_count.json   (best-effort)

appels API   : authorization Bearer (public du site), x-csrf-token: ct0,
               cookie: auth_token + ct0  (déchiffrés à la volée)
```

### Proxy par compte

Les comptes gérés par des VA vivent derrière une IP stable. S'y connecter depuis une
autre adresse déclenche une alerte de sécurité **légitime** chez X. Chaque compte peut
donc porter le proxy de son opérateur :

```
http://utilisateur:motdepasse@hote:port
```

Il s'applique **aux appels API de lecture comme au navigateur** — même compte, même IP.
Les identifiants sont chiffrés en base et jamais renvoyés à l'interface, qui n'affiche
que l'hôte. Seuls les proxys `http://` et `https://` sont pris en charge (pas SOCKS).

C'est du routage réseau, rien d'autre : aucune empreinte n'est falsifiée.

### Sessions de lecture

La détection consomme la session d'un compte amplificateur. L'outil **alterne entre les
sessions disponibles** à chaque lecture, pour répartir la charge plutôt que d'exposer un
seul compte.

Les limites de débit étant rattachées aux comptes et non à l'IP, ajouter des
amplificateurs **augmente la capacité de lecture** au lieu de la diviser.

### Robustesse de la lecture

Deux mécanismes évitent les cassures les plus courantes :

- **Auto-réparation des `features`.** X exige un objet `features` qui change à chaque
  déploiement ; un champ manquant fait échouer la requête. L'outil lit les champs
  réclamés dans le message d'erreur, les ajoute et rejoue une fois.
- **Extraction en profondeur.** Plutôt que de suivre un chemin figé
  (`timeline_v2 → instructions → entries`), l'outil parcourt toute la réponse et ramasse
  les objets de type `Tweet`, filtrés sur l'identifiant de l'auteur. Une réorganisation
  de la structure ne casse donc rien, et les originaux imbriqués dans un retweet sont
  ignorés.

### Garanties

- **Premier passage sans effet** : le curseur est posé sans rien retweeter, l'historique
  n'est jamais relayé rétroactivement.
- **Posts épinglés neutralisés** : la comparaison se fait sur l'identifiant numérique,
  pas sur l'ordre d'affichage.
- **Anti-doublon** : contrainte d'unicité `(tweet_id, amplifier_id)`, résistante aux
  redémarrages. Un post déjà retweeté (code 327 de X) est compté comme réussi.
- **Retweet confirmé** : une réponse 200 sans résultat exploitable est traitée comme un
  échec, pas comme un succès.
- **Rien n'est perdu** : session expirée, compte verrouillé ou limite de débit reportent
  le job (15 à 30 min) au lieu de l'abandonner.

## Réglages

| Réglage | Défaut | Rôle |
|---|---|---|
| Fréquence de détection | 180 s | Intervalle **minimum** par compte ; allongé si le quota l'impose |
| Délai min / max avant RT | 90 / 900 s | Plage du délai aléatoire par retweet |
| Écart entre amplificateurs | 180 s | Empêche les RT simultanés sur un même post |
| RT max par compte / heure | 4 | Plafond de sécurité |
| Vérifier les sessions | 6 h | Repère les sessions expirées ou dérivées |
| Navigateur invisible | Oui | Non = fenêtres Chromium visibles, pour diagnostiquer |
| Âge max du post | 180 min | Ignore les posts trop anciens |
| Ignorer réponses / retweets | Oui | Ne relaie que les posts originaux |
| Mots-clés requis / exclus | — | Filtrage sur le texte du post |

---

## Quand X casse quelque chose

C'est la contrepartie assumée de l'API interne. Deux pannes possibles, toutes deux
réparables sans toucher au code.

### Blocage anti-automatisation (code 226)

```
Authorization: This request looks like it might be automated. To protect our users
from spam and other malicious activity, we can't complete this action right now.
```

**Ce n'est pas une panne réparable.** X a identifié la requête comme automatisée et
refuse l'action. Le `queryId` est bon, la session est valide, la requête est bien formée —
c'est la détection anti-spam de X qui tranche.

Ce que fait l'outil :

- **il s'arrête immédiatement sur ce compte** — une seule tentative, pas de réessai ;
- la session **reste valide** et la lecture des timelines continue (lire n'est pas
  l'action refusée) ;
- le retweet en attente est **conservé**, pas perdu ;
- le compte passe en « verrouillé » dans l'interface jusqu'à votre décision.

**N'insistez pas.** Relancer en boucle après un 226 est le moyen le plus sûr de faire
passer un compte de « signalé » à « verrouillé », puis suspendu. Si vous cliquez
« J'ai réglé » sans avoir rien changé, la tentative suivante sera refusée de la même
façon — et chaque refus renforce le signal.

Les seules issues réelles :

| Option | Ce que ça implique |
|---|---|
| **API officielle payante** | Canal sanctionné, pas de code 226. ~20 $/mois pour un usage courant. La règle sur le contenu dupliqué entre comptes liés s'applique toujours. |
| **Semi-automatique** | L'outil détecte et vous notifie, vous cliquez « retweeter » vous-même. Aucun risque, mais plus d'automatisation. |
| **Abandonner sur ce compte** | Le compte est déjà signalé ; le laisser tranquille est parfois la décision la plus prudente. |

Contourner cette détection (empreinte navigateur, en-têtes de transaction, rotation
d'adresses IP) n'est volontairement pas implémenté : c'est le geste qui transforme une
infraction aux conditions d'utilisation en contournement caractérisé, et il expose
directement les comptes que l'outil est censé servir.

### Un identifiant de requête a changé

X fait tourner les identifiants de ses opérations GraphQL au fil de ses déploiements.
**C'est la panne la plus fréquente de cette architecture**, et elle se répare en 30
secondes sans redémarrer.

Symptôme, explicite dans le journal :

```
Operation CreateRetweet introuvable (404) : l'identifiant de requete est perime.
Mets a jour « ID de requete CreateRetweet » dans les reglages.
```

Le message nomme toujours l'opération et le réglage exact à corriger. Les retweets en
attente sont conservés, pas perdus.

Pour récupérer la bonne valeur :

1. Dans votre navigateur, sur x.com, ouvrez **F12 → Réseau** et filtrez sur le nom de
   l'opération (`CreateRetweet`, `UserTweets` ou `UserByScreenName`).
2. Déclenchez l'action **à la main** :
   - `UserTweets` → ouvrez un profil et faites défiler sa timeline
   - `UserByScreenName` → ouvrez une page de profil
3. Repérez la requête `.../i/api/graphql/XXXXXXXX/NomDeLOperation`.
4. Copiez le segment `XXXXXXXX` dans le réglage correspondant, et enregistrez.

> Ces identifiants ne sont pas publics et ne sont pas extractibles automatiquement :
> X les charge par route dans des bundles réservés aux sessions connectées. Il faut donc
> les relever depuis votre propre navigateur.

### L'endpoint exige une vérification client

X impose sur certains endpoints un en-tête `x-client-transaction-id` généré par du
JavaScript obfusqué, qu'un client externe ne peut pas produire. C'est la raison
principale pour laquelle les bibliothèques non officielles fonctionnent par intermittence.

Symptôme : dans le journal, *« X exige une vérification client sur retweet »*. Les jobs
sont alors reportés de 30 minutes au lieu d'échouer, en attendant votre décision.

Si ce message apparaît durablement, l'approche par API interne ne tient plus pour le
retweet, et les seules options restantes sont l'API officielle payante ou l'automatisation
navigateur. **Au moment de l'écriture, l'endpoint `CreateRetweet` ne réclame pas cet
en-tête** : sondé avec des identifiants invalides, il répond `401 / code 32` — un refus
d'authentification pur, sans plainte sur un en-tête manquant.

### « Aucun post retourné » sur un compte source

L'identifiant de requête `UserTweets` a probablement changé. Récupérez-le comme
ci-dessus, mais en filtrant sur `UserTweets` et en scrollant une timeline de profil.

Même méthode pour `UserByScreenName` : il apparaît au chargement d'une page de profil.

---

## Structure

```
src/config.js    port, mot de passe, clé de chiffrement (tout est optionnel)
src/crypto.js    chiffrement AES-256-GCM des cookies
src/db.js        schéma SQLite et réglages
src/detect.js    détection publique + régulation du quota
src/xapi.js      client de l'API GraphQL interne (retweet, vérification de session)
src/engine.js    filtrage, file d'attente, exécution
src/server.js    API HTTP et service de l'interface
public/          interface web
data/            base SQLite et clé de chiffrement (ne pas versionner)
```

## Dépannage

**« Aucune session »** : importez les cookies du compte.

**« Session invalide ou expirée »** : l'`auth_token` est erroné, tronqué, ou la session a
été révoquée. Reconnectez-vous dans votre navigateur et recopiez les deux cookies.

**« Les cookies enregistrés appartiennent à @autre »** : vous avez copié les cookies du
mauvais compte, ou votre navigateur était connecté à un autre profil.

**« Compte verrouillé par X »** : ouvrez le compte à la main dans un navigateur normal,
traitez la demande de X, puis cliquez **J'ai réglé**.

**« Limite de débit X atteinte »** : normal si les plafonds sont élevés. Les jobs
reprennent automatiquement à la date de réinitialisation renvoyée par X.

**Rien ne se passe après un post** : vérifiez le rôle du compte source, que l'outil n'est
pas en pause, et que le post n'est pas filtré — le journal donne la raison exacte de
chaque rejet.

**Laisser tourner en continu** : la machine doit rester allumée. Sur Windows, utilisez le
Planificateur de tâches avec un déclencheur « au démarrage ».

---

## Héberger l'outil

### Le piège : l'adresse IP du serveur

Un VPS a une **IP de datacenter**, que X surveille bien plus étroitement qu'une IP
résidentielle. C'est le facteur décisif :

- **Tous vos comptes ont un proxy** → l'IP du VPS n'est quasiment jamais utilisée pour
  joindre X (lecture *et* navigateur sortent par le proxy du compte). **Le VPS est un
  bon choix.**
- **Certains comptes n'ont pas de proxy** → leur trafic partirait de l'IP datacenter.
  C'est *pire* que votre PC. Dans ce cas, hébergez à la maison : PC laissé allumé, ou un
  petit serveur type Raspberry Pi, pour conserver une IP résidentielle.

### Dimensionnement

Chromium est le poste dominant : comptez **2 Go de RAM** minimum (1 Go passe tout juste
mais laisse peu de marge). Un seul navigateur tourne à la fois, donc 2 vCPU suffisent
largement. Un VPS d'entrée de gamme à ~4-5 €/mois fait le travail.

Prévoyez ~1 Go de disque : Chromium, les profils et la base restent légers.

> **Guide pas à pas** : voir [DEPLOY.md](DEPLOY.md) pour un déploiement complet sur VPS,
> de la première connexion SSH au service systemd.

### Installation sur Debian/Ubuntu

```bash
sudo apt update && sudo apt install -y nodejs npm git
git clone <votre-depot> cross-rt && cd cross-rt
npm install
npx playwright install --with-deps chromium
```

`--with-deps` installe les bibliothèques système dont Chromium a besoin ; sans elle, le
navigateur échouera à démarrer.

### Accès à l'interface — ne l'exposez pas

Par défaut, l'outil n'écoute que sur `127.0.0.1`. **Gardez ce réglage** : l'interface
donne accès à des sessions X connectées. Pour y accéder depuis votre poste, ouvrez un
tunnel SSH :

```bash
ssh -L 3000:127.0.0.1:3000 utilisateur@votre-serveur
```

Puis <http://127.0.0.1:3000> dans votre navigateur local. Rien n'est publié sur Internet.

Si vous choisissez malgré tout d'exposer le port (`HOST=0.0.0.0`), l'outil vous avertit
au démarrage et **exige** un `UI_PASSWORD` — sans quoi n'importe qui pilote vos comptes.

### Le maintenir en vie

Créez `/etc/systemd/system/cross-rt.service` :

```ini
[Unit]
Description=Cross-RT
After=network.target

[Service]
Type=simple
User=cross
WorkingDirectory=/home/cross/cross-rt
ExecStart=/usr/bin/node src/server.js
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now cross-rt && journalctl -u cross-rt -f
```

Le service redémarre tout seul après un plantage ou un reboot.

### Sauvegarde

`data/` contient la clé de chiffrement, la base et les profils Chromium. Le perdre
signifie reconnecter tous les comptes. Le copier ailleurs signifie exposer vos sessions :
si vous le sauvegardez, chiffrez la sauvegarde.
