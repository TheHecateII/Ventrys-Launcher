<p align="center"><img src="./app/assets/images/ventryslogo.png" width="150px" height="150px" alt="Ventrys"></p>

<h1 align="center">Ventrys Launcher</h1>

<p align="center">Electron-based modded Minecraft launcher that automatically installs and synchronizes Java, Forge, mods, and optional content from a custom backend - the player just logs in and clicks Play.</p>

## Project status

This is a proof of concept, built on top of [HeliosLauncher][helios] (dscalzi): the UI, Microsoft authentication, and the launcher's own self-update mechanism come from there and work as-is. Everything related to content distribution (mods/Java/Forge, originally driven by a hand-generated `distribution.json`) has been replaced with a custom Python backend, [`ventrys-sync`][ventrys-sync].

**Why the rewrite**: HeliosLauncher + [Nebula][nebula] is a more mature and generally more robust solution than this project. The actual problem was the distribution pipeline itself - regenerating `distribution.json` with Nebula on every modpack change, re-uploading it by hand, and managing optional mods through a nested module tree - too much overhead for a project this size. `ventrys-sync` replaces that entire pipeline with a synced directory (SFTP) and a backend that scans and serves its own content.

**Looking for a turnkey launcher solution instead?** [launch-it.app](https://launch-it.app/) is a maintained, professional product. This repository is not.

## Current scope and roadmap

- The launcher is currently **hardcoded to a single server** (one `ventrys-sync` backend URL, `app/assets/js/ventrysSyncConfig.js`).
- **Planned**: make the project genuinely reusable and open source, so anyone can self-host their own `ventrys-sync` backend and only needs to change that one endpoint URL to point their own launcher build at it - no other code changes required.
- **Other mod loaders** (Fabric, NeoForge, ...): also planned. The current Forge-specific behavior is really just "fetch a client setup (installer/Java) from the backend and execute it locally" - there's no Forge-specific logic hardcoded elsewhere in the sync/launch pipeline, so extending to another loader shouldn't require deep rework.

## What the launcher does

- **Microsoft account authentication** (OAuth 2.0) - multi-account support, credentials never stored or sent anywhere but Microsoft.
- **Automatic Java, Forge, mod, and config sync** from `ventrys-sync` on every launch - nothing to install or choose manually.
- **Optional addons**: mods/shaders the server makes available but doesn't enforce, toggled per-player from Settings.
- **Orphan file cleanup**: a file removed server-side is removed client-side on the next launch (scoped to explicitly-managed folders only - never touches saves/screenshots/logs).
- **Self-updating launcher** (`electron-updater`, GitHub releases of this repo).
- RAM / JVM options, Mojang service status, and a built-in debug console (dedicated button on the main screen).

Removed relative to upstream HeliosLauncher: `distribution.json`/Nebula, multi-server selection (planned to come back as multiple backend URLs), RSS news feed, Discord Rich Presence, Mojang (Yggdrasil) account login (deprecated by Mojang), Java auto-detection/download via Adoptium.

## Architecture

```
player <-> Ventrys Launcher (this repo) <-> ventrys-sync (Python backend, separate repo)
```

The launcher itself holds no content logic: it queries `ventrys-sync` (`/config.json`) for what to install/sync, downloads it, installs Forge via the real official installer (headless), and launches the game. See [`ventrys-sync`][ventrys-sync] for backend details (forced/download/ignore/optional rules, admin panel, file browser).

## Development

**Requirements**: [Node.js][nodejs] v22

```console
git clone https://github.com/TheHecateII/Ventrys-Launcher.git
cd Ventrys-Launcher
npm install
npm start
```

Point the launcher at a `ventrys-sync` backend: edit `app/assets/js/ventrysSyncConfig.js`.

**Build installers**

```console
npm run dist        # current platform
npm run dist:win
npm run dist:mac
npm run dist:linux
```

**Debug console**: `Ctrl+Shift+I`, or the dedicated button on the main screen (next to Settings).

## Contributing

If you're an actual developer and interested in helping maintain this, reach out on Discord: **thehecateii**.

## Attribution

Based on [HeliosLauncher][helios] by Daniel Scalzi (dscalzi), MIT licensed - see `LICENSE.txt`.

[helios]: https://github.com/dscalzi/HeliosLauncher 'HeliosLauncher'
[nebula]: https://github.com/dscalzi/Nebula 'dscalzi/Nebula'
[ventrys-sync]: https://github.com/TheHecateII/ventrys-sync 'ventrys-sync'
[nodejs]: https://nodejs.org/en/ 'Node.js'
