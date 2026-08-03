# Déploiement sur un VPS — guide complet

Pour un VPS Debian 12 ou Ubuntu 22.04/24.04. Comptez 30 minutes.

**Prérequis** : l'adresse IP du VPS et son accès root (mot de passe ou clé SSH), fournis
par l'hébergeur.

---

## ⚠️ À lire d'abord

**L'IP du VPS est une IP de datacenter**, que X surveille beaucoup plus étroitement
qu'une IP résidentielle.

Cet hébergement n'a de sens que si **tous les comptes amplificateurs ont un proxy**
configuré dans l'outil. Le trafic sort alors par le proxy du compte, et l'IP du VPS n'est
pratiquement jamais utilisée pour joindre X.

Si un compte n'a pas de proxy, son trafic partira de l'IP datacenter — c'est pire que
depuis un poste à la maison. Dans ce cas, n'hébergez pas sur un VPS.

**Qui a accès à quoi** : l'administrateur du VPS a les droits root, donc accès au dossier
`data/` — clé de chiffrement et sessions X comprises. Héberger chez quelqu'un revient à
lui donner la capacité technique de contrôler les comptes.

---

## 1. Se connecter au serveur

Depuis votre poste (PowerShell sur Windows, terminal sur Mac/Linux) :

```bash
ssh root@IP_DU_VPS
```

Acceptez l'empreinte à la première connexion, puis saisissez le mot de passe root.

## 2. Créer un utilisateur dédié

Faire tourner l'outil en root est une mauvaise pratique : une faille donnerait la machine
entière.

```bash
adduser cross
```

Choisissez un mot de passe, validez les questions par Entrée. Puis :

```bash
usermod -aG sudo cross
```

Basculez sur ce compte :

```bash
su - cross
```

Toutes les commandes suivantes se font en tant que `cross`.

## 3. Installer Node.js 24

**Ne pas utiliser `apt install nodejs`** : les dépôts Debian/Ubuntu fournissent une
version trop ancienne. L'outil exige Node 22.5 minimum (module SQLite intégré).

```bash
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
```

```bash
sudo apt-get install -y nodejs git
```

Vérifiez :

```bash
node --version
```

Vous devez voir `v24.x.x` ou supérieur. Si la version est inférieure à 22.5, l'outil
refusera de démarrer.

## 4. Ajouter de la mémoire virtuelle

Chromium consomme beaucoup de RAM. Sur un VPS de 2 Go, un fichier d'échange évite les
plantages en pic :

```bash
sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile
```

Pour qu'il survive aux redémarrages :

```bash
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

## 5. Récupérer le code

Le dépôt est privé : il faut s'authentifier. Le plus simple est une clé SSH.

Générez-la sur le VPS :

```bash
ssh-keygen -t ed25519 -C "vps-cross-rt" -N "" -f ~/.ssh/id_ed25519
```

Affichez la clé publique :

```bash
cat ~/.ssh/id_ed25519.pub
```

Copiez la ligne entière, puis sur GitHub : **Settings → SSH and GPG keys → New SSH key**,
collez-la et validez.

Clonez ensuite (remplacez `PROPRIETAIRE` par le pseudo du propriétaire du dépôt) :

```bash
git clone git@github.com:PROPRIETAIRE/cross-rt.git ~/cross-rt
```

```bash
cd ~/cross-rt
```

## 6. Installer les dépendances

```bash
npm install
```

Puis Chromium **et ses bibliothèques système** :

```bash
npx playwright install --with-deps chromium
```

Saisissez votre mot de passe sudo quand il est demandé. Cette étape télécharge ~190 Mo et
installe une trentaine de paquets système.

> Sans `--with-deps`, Chromium s'installe mais refuse de démarrer, faute de
> bibliothèques graphiques. C'est l'erreur la plus fréquente sur un serveur.

## 7. Configurer

```bash
cp .env.example .env && nano .env
```

Renseignez **uniquement** ces deux lignes :

```
HOST=127.0.0.1
UI_PASSWORD=un-mot-de-passe-long-et-unique
```

Enregistrez avec `Ctrl+O`, `Entrée`, puis quittez avec `Ctrl+X`.

`HOST=127.0.0.1` fait que l'interface n'est joignable que depuis le serveur lui-même.
C'est volontaire : elle donne accès à des sessions X connectées et ne doit jamais être
exposée à Internet.

## 8. Vérifier que ça démarre

```bash
npm start
```

Vous devez voir :

```
Cross-RT v5.0 (retweet Chromium + proxy) — interface sur http://127.0.0.1:3000
Moteur demarre.
```

Arrêtez avec `Ctrl+C`. Si un avertissement mentionne une interface exposée, c'est que
`HOST` est mal renseigné : reprenez l'étape 7.

## 9. Le faire tourner en permanence

```bash
sudo nano /etc/systemd/system/cross-rt.service
```

Collez ceci :

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

Activez et démarrez :

```bash
sudo systemctl enable --now cross-rt
```

Vérifiez :

```bash
systemctl status cross-rt
```

Vous devez lire `active (running)`. Le service redémarre désormais tout seul après un
plantage ou un redémarrage du serveur.

Pour suivre le journal en direct :

```bash
journalctl -u cross-rt -f
```

(`Ctrl+C` pour sortir, le service continue.)

## 10. Fermer le pare-feu

```bash
sudo apt install -y ufw && sudo ufw allow OpenSSH && sudo ufw --force enable
```

Seul SSH reste ouvert. Le port 3000 n'est de toute façon pas exposé.

---

## Accéder à l'interface

Depuis **votre poste**, pas depuis le VPS. Ouvrez un tunnel SSH :

```bash
ssh -L 3000:127.0.0.1:3000 cross@IP_DU_VPS
```

Laissez cette fenêtre ouverte, puis allez sur <http://127.0.0.1:3000> dans votre
navigateur habituel. Le mot de passe demandé est celui du `.env`.

Fermer la fenêtre SSH coupe l'accès à l'interface, mais **pas** l'outil : il continue de
tourner sur le serveur.

## Configurer les comptes

À faire par le propriétaire des comptes, à travers le tunnel — les cookies n'ont pas à
transiter par une autre personne.

1. Ajoutez les comptes sources par pseudo.
2. Ajoutez les comptes amplificateurs, puis pour chacun :
   - **Définir un proxy** → le proxy du VA qui gère ce compte (indispensable sur VPS) ;
   - **Importer une session** → les cookies `auth_token` et `ct0`, relevés dans le
     navigateur où ce compte est connecté (voir le README).
3. Réglez les délais et plafonds.

---

## Maintenance

**Mettre à jour le code** :

```bash
cd ~/cross-rt && git pull && npm install && sudo systemctl restart cross-rt
```

**Voir ce qui se passe** :

```bash
journalctl -u cross-rt -n 100 --no-pager
```

**Sauvegarder** : `data/` contient la clé de chiffrement, la base et les profils
Chromium. Le perdre oblige à tout reconnecter ; le copier en clair expose les sessions.
Si vous sauvegardez, chiffrez l'archive.

## Dépannage

**`node: command not found` dans systemd** : vérifiez le chemin avec `which node` et
corrigez `ExecStart` en conséquence.

**Chromium ne démarre pas / `Host system is missing dependencies`** : l'étape 6 a été
faite sans `--with-deps`. Relancez `npx playwright install --with-deps chromium`.

**Le service redémarre en boucle** : `journalctl -u cross-rt -n 50` donne la cause. Le
plus souvent une version de Node trop ancienne, ou un `data/` non accessible en écriture
par l'utilisateur `cross`.

**Manque de mémoire pendant un retweet** : vérifiez que le fichier d'échange est actif
avec `free -h`. Sinon, reprenez l'étape 4.

**Les retweets échouent tous** : passez « Navigateur invisible » sur **Non** dans les
réglages — impossible à observer sur un serveur sans écran, mais les messages d'erreur
du journal deviennent plus précis.
