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

// ---------- config fetch ----------

async function fetchConfig(baseUrl) {
    const res = await got(`${baseUrl}/config.json`, { responseType: 'json', timeout: { request: 30000 } })
    return res.body
}

// ---------- downloads ----------

async function downloadTo(url, destPath, onProgress) {
    await fs.ensureDir(path.dirname(destPath))
    const tmp = `${destPath}.download`
    await new Promise((resolve, reject) => {
        const stream = got.stream(url, { timeout: { request: 120000 } })
        const out = fs.createWriteStream(tmp)
        if (onProgress) {
            stream.on('downloadProgress', p => onProgress(p.percent))
        }
        stream.on('error', reject)
        out.on('error', reject)
        out.on('finish', resolve)
        stream.pipe(out)
    })
    await fs.move(tmp, destPath, { overwrite: true })
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
async function ensureJava(javaCfg, commonDir) {
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
    await downloadTo(entry.url, archivePath)

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
async function ensureForge(forgeCfg, javaPath, instanceDir, commonDir) {
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
        await downloadTo(forgeCfg.installer.url, installerPath)
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

/**
 * Applies the resolved entries from config.json:
 *  - forced: download if missing or hash mismatch.
 *  - download: download only if completely absent - never touched again,
 *    intentionally (lets admins seed a default without ever overwriting a
 *    player's own edits).
 * Then, for every folder listed in forcedDirectories, deletes any local
 * file that isn't in `entries` - the generalized version of the old
 * pruneOrphans patch, minus the whitelist limitation.
 */
async function syncFiles(filesCfg, instanceDir, onProgress) {
    const entries = filesCfg.entries
    const expected = new Set()

    for (const entry of entries) {
        const localPath = path.join(instanceDir, ...entry.path.split('/'))
        expected.add(localPath)

        if (entry.mode === 'download') {
            if (await fs.pathExists(localPath)) continue
            await downloadTo(entry.url, localPath, onProgress)
            continue
        }

        // forced
        let needsDownload = true
        if (await fs.pathExists(localPath)) {
            const digest = await sha256File(localPath)
            needsDownload = digest !== entry.sha256
        }
        if (needsDownload) {
            await downloadTo(entry.url, localPath, onProgress)
        }
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
