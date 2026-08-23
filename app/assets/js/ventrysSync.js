/**
 * Replaces Nebula/distribution.json for everything except vanilla Minecraft
 * assets (still handled by helios-core's MojangIndexProcessor, untouched).
 *
 * Talks to the ventrys-sync Python backend (see Documents/Repo/ventrys-sync)
 * to acquire Java, install Forge locally, and sync mod/config/resourcepack
 * files per forced/download/ignore rules.
 *
 * Mods do NOT go through helios-core's maven modstore mechanism - Forge
 * 1.13+'s ModLauncher scans <instanceDir>/mods/ on its own regardless of
 * what any launcher tells it, and helios-core's own constructModList()
 * is a no-op when given an empty mod list (confirmed by reading
 * processbuilder.js). So mod jars are just forced-mode files like any
 * other, synced straight into mods/ - no per-jar maven id needed.
 */
const crypto = require('crypto')
const fs = require('fs-extra')
const got = require('got')
const path = require('path')
const { spawn } = require('child_process')
const { HeliosDistribution, extractZip, extractTarGz } = require('helios-core/common')
const { LoggerUtil } = require('helios-core')

const logger = LoggerUtil.getLogger('VentrysSync')

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms))
}

// Broader than helios-core's own retryableError (which only covers
// ECONNRESET/no-response and misses TimeoutError): a flaky connection
// (4G/ADSL) doesn't always reset cleanly, it often just stalls until
// something gives up and raises TimeoutError instead. got.RequestError
// covers every network-level failure (connection refused/reset, stalled/
// timed out, etc.); a real HTTP error response (404, ...) is a separate
// got.HTTPError class and won't match here, so we still don't retry those.
function isRetryableError(error) {
    return error instanceof got.RequestError
}

// ---------- config fetch ----------

// `uuid` (the selected account's Minecraft/Microsoft uuid) lets the backend
// decide whether to include "admin" mode addons (staff-only, see
// ventrys-sync's app/rules.py + app/access.py) in `entries` at all - omitted
// entirely for everyone else, not just hidden client-side.
async function fetchConfig(baseUrl, uuid) {
    const url = uuid ? `${baseUrl}/config.json?uuid=${encodeURIComponent(uuid)}` : `${baseUrl}/config.json`
    const res = await got(url, { responseType: 'json', timeout: { request: 30000 } })
    return res.body
}

// ---------- downloads ----------

const MAX_DOWNLOAD_RETRIES = 10

async function downloadTo(url, destPath, onProgress) {
    await fs.ensureDir(path.dirname(destPath))
    const tmp = `${destPath}.download`

    let retryCount = 0
    for (;;) {
        try {
            await new Promise((resolve, reject) => {
                const stream = got.stream(url, { timeout: { request: 120000 } })
                const out = fs.createWriteStream(tmp)
                if (onProgress) {
                    // Raw byte counts, not a 0-100 percent: callers downloading
                    // several files (syncFiles) need transferred/total to weigh
                    // this file into an overall percentage, not just this file's.
                    stream.on('downloadProgress', p => onProgress(p.transferred, p.total))
                }
                stream.on('error', reject)
                out.on('error', reject)
                out.on('finish', resolve)
                stream.pipe(out)
            })
            break
        } catch (err) {
            retryCount++
            if (retryCount > MAX_DOWNLOAD_RETRIES || !isRetryableError(err)) {
                throw err
            }
            logger.warn(`Download of ${url} failed (${err.code || err.name}), retry ${retryCount}/${MAX_DOWNLOAD_RETRIES}...`)
            if (onProgress) onProgress(0, 0)
            await sleep(1000)
        }
    }

    await fs.move(tmp, destPath, { overwrite: true })
}

// Adapts downloadTo's raw (transferred, total) callback into the
// { file, percent } shape landing.js uses to show what's downloading -
// for single-file callers (ensureJava/ensureForge) where "total" is just
// that one file's size.
function singleFileProgress(fileName, onProgress) {
    if (!onProgress) return undefined
    return (transferred, total) => {
        onProgress({ file: fileName, percent: total > 0 ? Math.round((transferred / total) * 100) : 0 })
    }
}

function sha256File(filePath) {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash('sha256')
        const stream = fs.createReadStream(filePath)
        stream.on('data', c => hash.update(c))
        stream.on('end', () => resolve(hash.digest('hex')))
        stream.on('error', reject)
    })
}

// ---------- Java ----------

function platformKey() {
    if (process.platform === 'win32') return 'windows'
    if (process.platform === 'darwin') return 'mac'
    return 'linux'
}

function javaExecutableIn(javaHome) {
    return path.join(javaHome, 'bin', process.platform === 'win32' ? 'java.exe' : 'java')
}

/**
 * Downloads + extracts the Java build for this OS into
 * commonDir/java/<version>/ if not already present, and returns the java
 * executable path. Our zips are expected to be flat (bin/, lib/, etc. at
 * the zip root, no nested jdk-x.y.z/ folder) - we package them ourselves,
 * so there's no ambiguity to handle here.
 */
async function ensureJava(javaCfg, commonDir, onProgress) {
    const entry = javaCfg[platformKey()]
    if (entry == null) {
        throw new Error(`No Java build published for platform '${platformKey()}'`)
    }

    const javaHome = path.join(commonDir, 'java', entry.version)
    const markerPath = path.join(javaHome, '.ventrys-java-version')
    const exePath = javaExecutableIn(javaHome)

    if (await fs.pathExists(markerPath) && await fs.pathExists(exePath)) {
        const marked = (await fs.readFile(markerPath, 'utf8')).trim()
        if (marked === entry.version) {
            logger.info(`Java ${entry.version} already present, skipping download.`)
            return exePath
        }
    }

    logger.info(`Acquiring Java ${entry.version} for ${platformKey()}...`)
    await fs.ensureDir(javaHome)
    const isZip = entry.url.endsWith('.zip')
    const archivePath = path.join(javaHome, isZip ? 'java.zip' : 'java.tar.gz')
    await downloadTo(entry.url, archivePath, singleFileProgress(path.basename(archivePath), onProgress))

    if (entry.sha256) {
        const digest = await sha256File(archivePath)
        if (digest !== entry.sha256) {
            await fs.remove(archivePath)
            throw new Error(`Java archive checksum mismatch (expected ${entry.sha256}, got ${digest})`)
        }
    }

    if (isZip) {
        await extractZip(archivePath)
    } else {
        await extractTarGz(archivePath)
    }

    if (!await fs.pathExists(exePath)) {
        throw new Error(`Java extraction didn't produce ${exePath} - archive layout unexpected.`)
    }
    if (process.platform !== 'win32') {
        await fs.chmod(exePath, 0o755)
    }

    await fs.writeFile(markerPath, entry.version, 'utf8')
    logger.info(`Java ${entry.version} ready at ${exePath}`)
    return exePath
}

// ---------- Forge ----------

/**
 * The Forge installer refuses to run against a directory unless it looks
 * like a real .minecraft folder (checks for launcher_profiles.json).
 * A minimal stub satisfies it - confirmed by actually running the real
 * installer against one.
 */
async function ensureLauncherProfileStub(instanceDir) {
    const profilePath = path.join(instanceDir, 'launcher_profiles.json')
    if (await fs.pathExists(profilePath)) return
    await fs.ensureDir(instanceDir)
    await fs.writeJson(profilePath, { profiles: {}, settings: {}, version: 3 })
}

function versionJsonPath(commonDir, minecraftVersion, forgeVersion) {
    const id = `${minecraftVersion}-forge-${forgeVersion}`
    return path.join(commonDir, 'versions', id, `${id}.json`)
}

/**
 * Runs the real Forge installer headlessly if it hasn't already been
 * installed for this exact version. Installed into commonDir, not
 * instanceDir - HeliosModule.getPath() for Library-type modules always
 * resolves under commonDir/libraries/, so that's where the installer's
 * output has to land for the classpath adapter (buildDistribution) to
 * find it. This also means libraries are shared across servers instead of
 * duplicated per instance, matching Helios's own convention. Returns the
 * path to the version.json Forge's own installer generates.
 */
async function ensureForge(forgeCfg, javaPath, instanceDir, commonDir, onProgress) {
    const { minecraftVersion, forgeVersion } = forgeCfg
    const outJson = versionJsonPath(commonDir, minecraftVersion, forgeVersion)
    const markerPath = path.join(commonDir, `.forge-installed-${minecraftVersion}-${forgeVersion}`)

    if (await fs.pathExists(markerPath) && await fs.pathExists(outJson)) {
        logger.info(`Forge ${forgeVersion} already installed, skipping.`)
        return outJson
    }

    // Installer jars are small and version-specific - cache alongside so
    // relaunching (or a second server on the same version) doesn't refetch.
    const installerPath = path.join(commonDir, 'forge-installers', `forge-${minecraftVersion}-${forgeVersion}-installer.jar`)
    if (!await fs.pathExists(installerPath)) {
        logger.info(`Downloading Forge ${forgeVersion} installer...`)
        await downloadTo(forgeCfg.installer.url, installerPath, singleFileProgress(path.basename(installerPath), onProgress))
        if (forgeCfg.installer.sha256) {
            const digest = await sha256File(installerPath)
            if (digest !== forgeCfg.installer.sha256) {
                await fs.remove(installerPath)
                throw new Error('Forge installer checksum mismatch.')
            }
        }
    }

    await ensureLauncherProfileStub(commonDir)

    logger.info(`Running Forge installer (--installClient) into ${commonDir}...`)
    await new Promise((resolve, reject) => {
        const proc = spawn(javaPath, ['-jar', installerPath, '--installClient', commonDir], {
            cwd: commonDir
        })
        let out = ''
        proc.stdout.on('data', d => { out += d })
        proc.stderr.on('data', d => { out += d })
        proc.on('error', reject)
        proc.on('close', code => {
            if (code === 0) {
                resolve()
            } else {
                logger.error('Forge installer output:\n' + out)
                reject(new Error(`Forge installer exited with code ${code}`))
            }
        })
    })

    if (!await fs.pathExists(outJson)) {
        throw new Error(`Forge installer reported success but ${outJson} is missing.`)
    }

    await fs.writeFile(markerPath, new Date().toISOString(), 'utf8')
    logger.info(`Forge ${forgeVersion} installed.`)
    return outJson
}

// ---------- forced/download/ignore file sync ----------

const ADDONS_PREFIX = 'addons/'

/**
 * Applies the resolved entries from config.json:
 *  - forced: download if missing or hash mismatch.
 *  - download: download only if completely absent - never touched again,
 *    intentionally (lets admins seed a default without ever overwriting a
 *    player's own edits).
 *  - optional/admin (addons/<realPath>): never auto-downloaded. Synced to its
 *    real target (addons/mods/Cool.jar -> mods/Cool.jar) only if `realPath`
 *    is in `enabledAddons`, and actively removed from that real target
 *    otherwise - e.g. a mod the player just disabled. Its real path is also
 *    added to `expected` so the forced-content prune pass below (which
 *    shares the same real folders, like mods/) never mistakes an enabled
 *    addon for an orphan. "admin" behaves identically here - the backend has
 *    already stripped these entries out of `filesCfg.entries` entirely for
 *    a non-staff account, so by the time syncFiles sees one, whoever is
 *    running this launcher was already allowed to have it.
 * Then, for every folder listed in forcedDirectories, deletes any local
 * file that isn't in `expected` - the generalized version of the old
 * pruneOrphans patch, minus the whitelist limitation.
 */
async function syncFiles(filesCfg, instanceDir, enabledAddons, onProgress) {
    const entries = filesCfg.entries
    const enabled = new Set(enabledAddons || [])
    const expected = new Set()

    // Pass 1: decide what actually needs downloading (same forced/download/
    // optional rules as before) without downloading anything yet, so the
    // total byte count below covers this whole sync - not just one file at
    // a time. Without this, a run of 74 small mods each flashed 0->100%
    // independently instead of contributing to one overall percentage.
    const toDownload = []
    for (const entry of entries) {
        let localPath
        if (entry.mode === 'optional' || entry.mode === 'admin') {
            const realPath = entry.path.startsWith(ADDONS_PREFIX)
                ? entry.path.slice(ADDONS_PREFIX.length)
                : entry.path
            localPath = path.join(instanceDir, ...realPath.split('/'))

            if (!enabled.has(realPath)) {
                if (await fs.pathExists(localPath)) {
                    await fs.remove(localPath)
                    logger.info(`Removed disabled addon: ${localPath}`)
                }
                continue
            }
        } else {
            localPath = path.join(instanceDir, ...entry.path.split('/'))
        }
        expected.add(localPath)

        if (entry.mode === 'download') {
            if (await fs.pathExists(localPath)) continue
            toDownload.push({ entry, localPath })
            continue
        }

        // forced, or an enabled optional addon: download if missing or hash mismatch.
        let needsDownload = true
        if (await fs.pathExists(localPath)) {
            const digest = await sha256File(localPath)
            needsDownload = digest !== entry.sha256
        }
        if (needsDownload) {
            toDownload.push({ entry, localPath })
        }
    }

    // Pass 2: download, reporting one percentage across the whole batch
    // (byte-weighted via each entry's known size) instead of per file.
    const totalBytes = toDownload.reduce((sum, { entry }) => sum + (entry.size || 0), 0)
    let bytesDone = 0
    for (const { entry, localPath } of toDownload) {
        const fileName = entry.path.split('/').pop()
        await downloadTo(entry.url, localPath, onProgress ? (transferred) => {
            const percent = totalBytes > 0 ? Math.round(((bytesDone + transferred) / totalBytes) * 100) : 0
            onProgress({ file: fileName, percent })
        } : undefined)
        bytesDone += entry.size || 0
    }

    for (const dir of filesCfg.forcedDirectories || []) {
        await pruneDirectory(path.join(instanceDir, ...dir.split('/')), expected)
    }
}

async function pruneDirectory(dir, expected) {
    let names
    try {
        names = await fs.readdir(dir)
    } catch {
        return
    }
    for (const name of names) {
        const full = path.join(dir, name)
        const st = await fs.lstat(full)
        if (st.isDirectory()) {
            await pruneDirectory(full, expected)
            // Remove folders left empty by pruning (e.g. after a reorg) -
            // otherwise stale directory husks (like an old
            // config/openloader/resources/ nobody uses anymore) stick
            // around forever even once every file inside is gone.
            try {
                if ((await fs.readdir(full)).length === 0) {
                    await fs.rmdir(full)
                    logger.info(`Pruned empty directory: ${full}`)
                }
            } catch (err) {
                logger.warn(`Failed to prune empty dir ${full}: ${err}`)
            }
        } else if (!expected.has(full)) {
            try {
                await fs.remove(full)
                logger.info(`Pruned orphaned file: ${full}`)
            } catch (err) {
                logger.warn(`Failed to prune ${full}: ${err}`)
            }
        }
    }
}

// ---------- ProcessBuilder bridge ----------

/**
 * Builds a HeliosDistribution containing exactly one server, whose only
 * module is the ForgeHosted loader (with the libraries from the locally
 * generated version.json as subModules) - the minimum ProcessBuilder needs
 * for classpath resolution. No ForgeMod entries: mods are plain files in
 * mods/, Forge finds them on its own (see file header).
 */
function buildForgeHostedModule(modManifest, minecraftVersion, forgeVersion) {
    const subModules = (modManifest.libraries || []).map(lib => ({
        id: `${lib.name}@jar`,
        name: lib.name,
        type: 'Library',
        classpath: true,
        artifact: {
            size: lib.downloads?.artifact?.size ?? 0,
            MD5: '',
            url: lib.downloads?.artifact?.url ?? '',
            path: lib.downloads?.artifact?.path
        }
    }))

    return {
        id: `net.minecraftforge:forge:${minecraftVersion}-${forgeVersion}`,
        name: 'Minecraft Forge',
        type: 'ForgeHosted',
        classpath: true,
        artifact: { size: 0, MD5: '', url: '' },
        subModules
    }
}

function buildDistribution(serverMeta, modManifest, commonDir, instanceDir) {
    const { id, minecraftVersion, forgeVersion } = serverMeta
    const raw = {
        version: '1.0.0',
        rss: '',
        discord: {},
        servers: [{
            id,
            name: serverMeta.name,
            description: serverMeta.description || '',
            icon: serverMeta.icon || null,
            version: '1.0.0',
            address: serverMeta.address,
            minecraftVersion,
            discord: serverMeta.discord || {},
            mainServer: true,
            autoconnect: serverMeta.autoconnect ?? false,
            modules: [buildForgeHostedModule(modManifest, minecraftVersion, forgeVersion)]
        }]
    }
    const distribution = new HeliosDistribution(raw, commonDir, instanceDir)
    return distribution.getServerById(id)
}

module.exports = {
    fetchConfig,
    ensureJava,
    ensureForge,
    syncFiles,
    buildDistribution,
    versionJsonPath
}
