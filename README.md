<p align="center"><img src="./app/assets/images/ventryslogo.png" width="150px" height="150px" alt="Ventrys"></p>

<h1 align="center">Ventrys Launcher</h1>

<p align="center">Launcher Minecraft modded (Electron) qui installe et synchronise automatiquement Java, Forge, les mods et le contenu optionnel depuis un backend maison - le joueur n'a rien à faire à part se connecter et cliquer sur Jouer.</p>

## Qu'est-ce que c'est vraiment

C'est un **POC vibe-codé**, construit par-dessus la base d'[HeliosLauncher][helios] (dscalzi) : l'interface, l'authentification Microsoft et le système de mise à jour du launcher lui-même viennent de là et fonctionnent très bien. Tout ce qui concernait la distribution du contenu (mods/Java/Forge, anciennement piloté par `distribution.json` généré via [Nebula][nebula]) a en revanche été entièrement remplacé par un backend Python maison ([`ventrys-sync`][ventrys-sync]).

**Pourquoi ce choix, honnêtement** : HeliosLauncher + Nebula reste une solution largement plus solide et professionnelle que ce projet. Le vrai problème, c'était la pipeline de distribution elle-même - régénérer `distribution.json` avec Nebula à chaque changement de modpack, le réuploader à la main, gérer les mods optionnels via un arbre de modules complexe... beaucoup trop fastidieux pour la taille de ce projet. `ventrys-sync` remplace tout ça par un dossier qu'on synchronise (SFTP) et un backend qui scanne et sert son contenu tout seul.

**Si tu cherches une solution de launcher clé en main**, sérieuse et déjà maintenue par des pros, regarde plutôt **[launch-it.app](https://launch-it.app/)**. Ce repo est un projet perso, pas un produit.

## État actuel et roadmap

- Aujourd'hui, ce launcher est **codé en dur pour le serveur Ventrys** (une seule URL de backend `ventrys-sync`).
- **Prévu** : rendre le projet réellement générique et open source, pour que n'importe qui puisse héberger son propre backend `ventrys-sync` et n'ait qu'à changer l'URL de l'endpoint (`ventrysSyncConfig.js`) pour pointer son propre launcher dessus - sans toucher au reste du code.
- **Support d'autres mod loaders** (Fabric, NeoForge...) : prévu aussi. Le workflow actuel avec Forge est en réalité générique - le launcher se contente de récupérer un setup client (installeur/Java) depuis le backend et de l'exécuter localement, sans logique propre à Forge codée en dur. Étendre à un autre loader ne devrait pas être compliqué au vu de ce qui marche déjà.

## Ce que fait le launcher

- **Compte Microsoft** (OAuth 2.0) - gestion multi-comptes, credentials jamais stockés/transmis ailleurs qu'à Microsoft.
- **Java, Forge, mods et fichiers de config synchronisés automatiquement** depuis `ventrys-sync` à chaque lancement - rien à installer à la main, rien à choisir.
- **Addons optionnels** : mods/shaders proposés par le serveur mais non imposés, activables/désactivables depuis Settings.
- **Nettoyage des fichiers orphelins** : un fichier retiré côté serveur est supprimé côté joueur au lancement suivant (scopé aux dossiers explicitement gérés, jamais aux saves/screenshots/logs).
- **Mise à jour automatique du launcher** lui-même (`electron-updater`, releases GitHub de ce repo).
- Réglages RAM / options JVM, statut des services Mojang, console de debug intégrée (icône dédiée sur l'écran principal).

Ce qui a été retiré par rapport à HeliosLauncher d'origine : `distribution.json`/Nebula, sélection multi-serveurs (prévu de revenir sous forme de plusieurs URLs de backends), flux d'actus RSS, Discord Rich Presence, comptes Mojang (Yggdrasil, déprécié par Mojang), auto-détection/téléchargement Java via Adoptium.

## Architecture

```
joueur <-> Ventrys Launcher (ce repo) <-> ventrys-sync (backend Python, repo séparé)
```

Le launcher ne contient aucune logique de contenu : il interroge `ventrys-sync` (`/config.json`) pour savoir quoi installer/synchroniser, télécharge, installe Forge via son vrai installeur officiel (headless), et lance le jeu. Voir [`ventrys-sync`][ventrys-sync] pour le détail du backend (règles forced/download/ignore/optional, panel admin, explorateur de fichiers).

## Développement

**Prérequis** : [Node.js][nodejs] v22

```console
git clone https://github.com/TheHecateII/Ventrys-Launcher.git
cd Ventrys-Launcher
npm install
npm start
```

Pointer le launcher vers un backend `ventrys-sync` : éditer `app/assets/js/ventrysSyncConfig.js`.

**Build des installeurs**

```console
npm run dist        # plateforme courante
npm run dist:win
npm run dist:mac
npm run dist:linux
```

**Console de debug** : `Ctrl+Shift+I`, ou le bouton dédié sur l'écran principal (icône à côté des Paramètres).

## Attribution

Basé sur [HeliosLauncher][helios] par Daniel Scalzi (dscalzi), sous licence MIT - voir `LICENSE.txt`.

[helios]: https://github.com/dscalzi/HeliosLauncher 'HeliosLauncher'
[nebula]: https://github.com/dscalzi/Nebula 'dscalzi/Nebula'
[ventrys-sync]: https://github.com/TheHecateII/ventrys-sync 'ventrys-sync'
[nodejs]: https://nodejs.org/en/ 'Node.js'
