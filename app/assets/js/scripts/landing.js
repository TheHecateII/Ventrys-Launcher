/**
 * Script for landing.ejs
 */
// Requirements
const {
    MojangRestAPI,
    getServerStatus
}                             = require('helios-core/mojang')
const {
    RestResponseStatus
}                             = require('helios-core/common')
const {
    MojangIndexProcessor,
    downloadQueue,
    getExpectedDownloadSize
}                             = require('helios-core/dl')

// Internal Requirements
const fs                      = require('fs-extra')
const ProcessBuilder          = require('./assets/js/processbuilder')
const { ensureDefaultServerList } = require('./assets/js/serverlistutil')
const ventrysSync              = require('./assets/js/ventrysSync')
const { VENTRYS_SYNC_URL }    = require('./assets/js/ventrysSyncConfig')

// Launch Elements
const launch_content          = document.getElementById('launch_content')
const launch_button           = document.getElementById('launch_button')
const launch_details          = document.getElementById('launch_details')
const launch_progress         = document.getElementById('launch_progress')
const launch_progress_label   = document.getElementById('launch_progress_label')
const launch_details_text     = document.getElementById('launch_details_text')
const server_selection_button = document.getElementById('server_selection_button')
const user_text               = document.getElementById('user_text')

const loggerLanding = LoggerUtil.getLogger('Landing')

/* Launch Progress Wrapper Functions */

// Holds the server name label while it's swapped out for the "downloading"
// text below, so toggleLaunchArea(false) can put it back without re-running
// updateSelectedServer()'s other side effects (config save, tab refresh).
let preDownloadServerLabel = null

/**
 * Show/hide the loading area.
 *
 * @param {boolean} loading True if the loading area should be shown, otherwise false.
 */
function toggleLaunchArea(loading){
    if(loading){
        launch_button.disabled = true
        server_selection_button.disabled = true
        preDownloadServerLabel = server_selection_button.innerHTML
        server_selection_button.innerHTML = Lang.queryJS('landing.launchButtonDownloading')
        launch_details.style.display = 'flex'
    } else {
        launch_details.style.display = 'none'
        server_selection_button.disabled = false
        if(preDownloadServerLabel !== null){
            server_selection_button.innerHTML = preDownloadServerLabel
            preDownloadServerLabel = null
        }
        setLaunchEnabled(ConfigManager.getSelectedServer() != null)
    }
}

/**
 * Set the details text of the loading area.
 * 
 * @param {string} details The new text for the loading details.
 */
function setLaunchDetails(details){
    launch_details_text.innerHTML = details
}

/**
 * Set the value of the loading progress bar and display that value.
 * 
 * @param {number} percent Percentage (0-100)
 */
function setLaunchPercentage(percent){
    launch_progress.setAttribute('max', 100)
    launch_progress.setAttribute('value', percent)
    launch_progress_label.innerHTML = percent + '%'
}

/**
 * Set the value of the OS progress bar and display that on the UI.
 * 
 * @param {number} percent Percentage (0-100)
 */
function setDownloadPercentage(percent){
    remote.getCurrentWindow().setProgressBar(percent/100)
    setLaunchPercentage(percent)
}

/**
 * Enable or disable the launch button.
 * 
 * @param {boolean} val True to enable, false to disable.
 */
function setLaunchEnabled(val){
    launch_button.disabled = !val
}

// Bind launch button
launch_button.addEventListener('click', async e => {
    loggerLanding.info('Launching game..')
    try {
        // Java is no longer a player-facing choice: dlAsync() acquires and
        // wires up the exact Java ventrysSync.ensureJava() manages, so there's
        // nothing left to scan/download here first.
        await dlAsync()
    } catch(err) {
        loggerLanding.error('Unhandled error in during launch process.', err)
        showLaunchFailure(Lang.queryJS('landing.launch.failureTitle'), Lang.queryJS('landing.launch.failureText'))
    }
})

// Bind settings button
document.getElementById('settingsMediaButton').onclick = async e => {
    await prepareSettings()
    switchView(getCurrentView(), VIEWS.settings)
}

// Bind DevTools button - quick access without needing to remember the shortcut.
document.getElementById('devToolsMediaButton').onclick = () => {
    remote.getCurrentWindow().toggleDevTools()
}

// Bind selected account
function updateSelectedAccount(authUser){
    let username = Lang.queryJS('landing.selectedAccount.noAccountSelected')
    if(authUser != null){
        if(authUser.displayName != null){
            username = authUser.displayName
        }
    }
    user_text.innerHTML = username
}
updateSelectedAccount(ConfigManager.getSelectedAccount())

// Bind selected server
function updateSelectedServer(serv){
    if(getCurrentView() === VIEWS.settings){
        fullSettingsSave()
    }
    ConfigManager.setSelectedServer(serv != null ? serv.rawServer.id : null)
    ConfigManager.save()
    server_selection_button.innerHTML = '&#8226; ' + (serv != null ? serv.rawServer.name : Lang.queryJS('landing.noSelection'))
    if(getCurrentView() === VIEWS.settings){
        animateSettingsTabRefresh()
    }
    setLaunchEnabled(serv != null)
}
// Real text is set in uibinder.js on distributionIndexDone.
server_selection_button.innerHTML = '&#8226; ' + Lang.queryJS('landing.selectedServer.loading')
server_selection_button.onclick = async e => {
    e.target.blur()
    await toggleServerSelection(true)
}

// Update Mojang Status Color
const refreshMojangStatuses = async function(){
    loggerLanding.info('Refreshing Mojang Statuses..')

    let status = 'grey'
    let tooltipEssentialHTML = ''
    let tooltipNonEssentialHTML = ''

    const response = await MojangRestAPI.status()
    let statuses
    if(response.responseStatus === RestResponseStatus.SUCCESS) {
        statuses = response.data
    } else {
        loggerLanding.warn('Unable to refresh Mojang service status.')
        statuses = MojangRestAPI.getDefaultStatuses()
    }
    
    greenCount = 0
    greyCount = 0

    for(let i=0; i<statuses.length; i++){
        const service = statuses[i]

        const tooltipHTML = `<div class="mojangStatusContainer">
            <span class="mojangStatusIcon" style="color: ${MojangRestAPI.statusToHex(service.status)};">&#8226;</span>
            <span class="mojangStatusName">${service.name}</span>
        </div>`
        if(service.essential){
            tooltipEssentialHTML += tooltipHTML
        } else {
            tooltipNonEssentialHTML += tooltipHTML
        }

        if(service.status === 'yellow' && status !== 'red'){
            status = 'yellow'
        } else if(service.status === 'red'){
            status = 'red'
        } else {
            if(service.status === 'grey'){
                ++greyCount
            }
            ++greenCount
        }

    }

    if(greenCount === statuses.length){
        if(greyCount === statuses.length){
            status = 'grey'
        } else {
            status = 'green'
        }
    }
    
    document.getElementById('mojangStatusEssentialContainer').innerHTML = tooltipEssentialHTML
    document.getElementById('mojangStatusNonEssentialContainer').innerHTML = tooltipNonEssentialHTML
    document.getElementById('mojang_status_icon').style.color = MojangRestAPI.statusToHex(status)
}

const refreshServerStatus = async (fade = false) => {
    loggerLanding.info('Refreshing Server Status')
    const serv = (await DistroAPI.getDistribution()).getServerById(ConfigManager.getSelectedServer())

    let pLabel = Lang.queryJS('landing.serverStatus.server')
    let pVal = Lang.queryJS('landing.serverStatus.offline')

    try {

        const servStat = await getServerStatus(47, serv.hostname, serv.port)
        console.log(servStat)
        pLabel = Lang.queryJS('landing.serverStatus.players')
        pVal = servStat.players.online + '/' + servStat.players.max

    } catch (err) {
        loggerLanding.warn('Unable to refresh server status, assuming offline.')
        loggerLanding.debug(err)
    }
    if(fade){
        $('#server_status_wrapper').fadeOut(250, () => {
            document.getElementById('landingPlayerLabel').innerHTML = pLabel
            document.getElementById('player_count').innerHTML = pVal
            $('#server_status_wrapper').fadeIn(500)
        })
    } else {
        document.getElementById('landingPlayerLabel').innerHTML = pLabel
        document.getElementById('player_count').innerHTML = pVal
    }
    
}

refreshMojangStatuses()
// Server Status is refreshed in uibinder.js on distributionIndexDone.

// Refresh statuses every hour. The status page itself refreshes every day so...
let mojangStatusListener = setInterval(() => refreshMojangStatuses(true), 60*60*1000)
// Set refresh rate to once every 5 minutes.
let serverStatusListener = setInterval(() => refreshServerStatus(true), 300000)

/**
 * Shows an error overlay, toggles off the launch area.
 * 
 * @param {string} title The overlay title.
 * @param {string} desc The overlay description.
 */
function showLaunchFailure(title, desc){
    setOverlayContent(
        title,
        desc,
        Lang.queryJS('landing.launch.okay')
    )
    setOverlayHandler(null)
    toggleOverlay(true)
    toggleLaunchArea(false)
}

// Keep reference to Minecraft Process
let proc
const GAME_LAUNCH_REGEX = /^\[.+\]: (?:MinecraftForge .+ Initialized|ModLauncher(?: .+)? (?:starting|running): .+|Loading Minecraft .+ with Fabric Loader .+)$/
const MIN_LINGER = 2000
const LAUNCH_UI_FALLBACK_MS = 120000

function forEachGameLogLine(data, handler){
    data.toString().split(/\r?\n/).forEach(line => {
        const trimmed = line.trim()
        if(trimmed.length > 0){
            handler(trimmed)
        }
    })
}

async function dlAsync(login = true) {

    // Login parameter is temporary for debug purposes. Allows testing the validation/downloads without
    // launching the game.

    const loggerLaunchSuite = LoggerUtil.getLogger('LaunchSuite')

    setLaunchDetails(Lang.queryJS('landing.dlAsync.loadingServerInfo'))

    let distro

    try {
        distro = await DistroAPI.refreshDistributionOrFallback()
        onDistroRefresh(distro)
    } catch(err) {
        loggerLaunchSuite.error('Unable to refresh distribution index.', err)
        showLaunchFailure(Lang.queryJS('landing.dlAsync.fatalError'), Lang.queryJS('landing.dlAsync.unableToLoadDistributionIndex'))
        return
    }

    const serv = distro.getServerById(ConfigManager.getSelectedServer())
    if(serv == null){
        loggerLaunchSuite.error('Selected server is missing from the distribution index.')
        showLaunchFailure(Lang.queryJS('landing.dlAsync.fatalError'), Lang.queryJS('landing.launch.failureText'))
        return
    }

    if(login && ConfigManager.getSelectedAccount() == null){
        loggerLaunchSuite.error('You must be logged into an account.')
        showLaunchFailure(Lang.queryJS('landing.launch.failureTitle'), Lang.queryJS('landing.selectedAccount.noAccountSelected'))
        return
    }

    setLaunchDetails(Lang.queryJS('landing.dlAsync.pleaseWait'))
    toggleLaunchArea(true)
    setLaunchPercentage(0, 100)

    // Vanilla Minecraft assets only (mods/config/Forge/Java are entirely
    // handled by ventrysSync below) - no more FullRepair/DistributionIndexProcessor,
    // which required a distribution.json-backed modules list to avoid throwing
    // 'No mod loader found!'. Runs in-process; no fork needed for this part.
    const repairMojangProcessor = new MojangIndexProcessor(
        ConfigManager.getCommonDirectory(),
        serv.rawServer.minecraftVersion)

    loggerLaunchSuite.info('Validating files.')
    setLaunchDetails(Lang.queryJS('landing.dlAsync.validatingFileIntegrity'))
    let invalidAssets
    try {
        await repairMojangProcessor.init()
        const numStages = repairMojangProcessor.totalStages()
        let completedStages = 0
        const validated = await repairMojangProcessor.validate(async () => {
            completedStages++
            setLaunchPercentage(Math.trunc((completedStages / numStages) * 100))
        })
        invalidAssets = [...validated.assets, ...validated.libraries, ...validated.client, ...validated.misc]
        setLaunchPercentage(100)
    } catch (err) {
        loggerLaunchSuite.error('Error during file validation.')
        showLaunchFailure(Lang.queryJS('landing.dlAsync.errorDuringFileVerificationTitle'), err.displayable || Lang.queryJS('landing.dlAsync.seeConsoleForDetails'))
        return
    }

    if(invalidAssets.length > 0) {
        loggerLaunchSuite.info('Downloading files.')
        setLaunchDetails(Lang.queryJS('landing.dlAsync.downloadingFiles'))
        setLaunchPercentage(0)
        try {
            const expectedTotalSize = getExpectedDownloadSize(invalidAssets)
            let currentPercent = 0
            await downloadQueue(invalidAssets, received => {
                const nextPercent = expectedTotalSize > 0 ? Math.trunc((received / expectedTotalSize) * 100) : 100
                if(currentPercent !== nextPercent) {
                    currentPercent = nextPercent
                    setDownloadPercentage(currentPercent)
                }
            })
            setDownloadPercentage(100)
        } catch(err) {
            loggerLaunchSuite.error('Error during file download.')
            showLaunchFailure(Lang.queryJS('landing.dlAsync.errorDuringFileDownloadTitle'), err.displayable || Lang.queryJS('landing.dlAsync.seeConsoleForDetails'))
            return
        }
    } else {
        loggerLaunchSuite.info('No invalid vanilla files.')
    }

    // Remove download bar.
    remote.getCurrentWindow().setProgressBar(-1)

    setLaunchDetails(Lang.queryJS('landing.dlAsync.preparingToLaunch'))

    let modLoaderData
    let versionData
    let realServ
    try {
        // Vanilla Minecraft assets only - unrelated to distribution.json,
        // untouched by the Ventrys sync switch below.
        const mojangIndexProcessor = new MojangIndexProcessor(
            ConfigManager.getCommonDirectory(),
            serv.rawServer.minecraftVersion)
        versionData = await mojangIndexProcessor.getVersionJson()

        // Ventrys sync: Java, Forge (installed for real, locally), and
        // mods/config/resourcepacks via forced/download/ignore rules -
        // replaces what DistributionIndexProcessor/Nebula used to do.
        setLaunchDetails(Lang.queryJS('landing.dlAsync.pleaseWait'))
        const commonDir = ConfigManager.getCommonDirectory()
        const instancesRoot = ConfigManager.getInstanceDirectory()
        const instanceDir = ConfigManager.getServerInstanceDirectory(serv.rawServer.id)

        const onDlProgress = ({ file, percent }) => {
            setLaunchDetails(Lang.queryJS('landing.dlAsync.downloadingFile', { file }))
            setDownloadPercentage(percent)
        }

        const syncConfig = await ventrysSync.fetchConfig(VENTRYS_SYNC_URL)
        setDownloadPercentage(0)
        const javaPath = await ventrysSync.ensureJava(syncConfig.java, commonDir, onDlProgress)
        // ProcessBuilder spawns whatever ConfigManager.getJavaExecutable()
        // holds for this server - it knows nothing about ventrysSync. Without
        // this, the actual launch would silently fall back to a stale or
        // nonexistent value instead of the Java we just ensured is present.
        ConfigManager.setJavaExecutable(serv.rawServer.id, javaPath)
        ConfigManager.save()
        setDownloadPercentage(0)
        const forgeVersionJsonPath = await ventrysSync.ensureForge(
            syncConfig.forge, javaPath, instanceDir, commonDir, onDlProgress)
        const enabledAddons = ConfigManager.getAddonConfiguration(serv.rawServer.id)?.enabled || []
        setLaunchDetails(Lang.queryJS('landing.dlAsync.downloadingFiles'))
        setDownloadPercentage(0)
        await ventrysSync.syncFiles(syncConfig, instanceDir, enabledAddons, onDlProgress)

        modLoaderData = await fs.readJson(forgeVersionJsonPath)
        realServ = ventrysSync.buildDistribution({
            id: serv.rawServer.id,
            name: serv.rawServer.name,
            description: serv.rawServer.description,
            icon: serv.rawServer.icon,
            address: serv.rawServer.address,
            minecraftVersion: serv.rawServer.minecraftVersion,
            forgeVersion: syncConfig.forge.forgeVersion,
            discord: serv.rawServer.discord,
            autoconnect: serv.rawServer.autoconnect
        }, modLoaderData, commonDir, instancesRoot)
    } catch (err) {
        loggerLaunchSuite.error('Error while preparing launch metadata.', err)
        showLaunchFailure(Lang.queryJS('landing.dlAsync.errorDuringLaunchTitle'), err.message || Lang.queryJS('landing.dlAsync.checkConsoleForDetails'))
        return
    }

    if(login) {
        const authUser = ConfigManager.getSelectedAccount()
        loggerLaunchSuite.info(`Sending selected account (${authUser.displayName}) to ProcessBuilder.`)
        let pb = new ProcessBuilder(realServ, versionData, modLoaderData, authUser, remote.app.getVersion())
        setLaunchDetails(Lang.queryJS('landing.dlAsync.launchingGame'))

        const onLoadComplete = () => {
            if(loadCompleteHandled){
                return
            }
            loadCompleteHandled = true
            if(launchUiFallbackTimer != null){
                clearTimeout(launchUiFallbackTimer)
                launchUiFallbackTimer = null
            }
            toggleLaunchArea(false)
            if(proc.stdout != null){
                proc.stdout.removeListener('data', tempListener)
            }
            if(proc.stderr != null){
                proc.stderr.removeListener('data', tempListener)
                proc.stderr.removeListener('data', gameErrorListener)
            }
        }
        let loadCompleteHandled = false
        let launchUiFallbackTimer = null
        let spawnGracePeriod = true
        const start = Date.now()

        const handleLaunchProgressLine = (line) => {
            if(loadCompleteHandled){
                return
            }
            if(GAME_LAUNCH_REGEX.test(line)){
                const diff = Date.now()-start
                if(diff < MIN_LINGER) {
                    setTimeout(onLoadComplete, MIN_LINGER-diff)
                } else {
                    onLoadComplete()
                }
            }
        }

        const seedServerListIfNeeded = () => {
            const serverAddress = serv.hostname && serv.port
                ? `${serv.hostname}:${serv.port}`
                : (serv.rawServer.address || '')
            try {
                ensureDefaultServerList(
                    ConfigManager.getServerInstanceDirectory(serv.rawServer.id),
                    serv.rawServer.name,
                    serverAddress
                )
            } catch (err) {
                loggerLaunchSuite.warn('Unable to prepare servers.dat before launch.', err)
            }
        }

        // Attach a temporary listener to the client output.
        // Will wait for a certain bit of text meaning that
        // the client application has started, and we can hide
        // the progress bar stuff.
        const tempListener = function(data){
            forEachGameLogLine(data, handleLaunchProgressLine)
        }

        const gameErrorListener = function(data){
            forEachGameLogLine(data, line => {
                if(line.indexOf('Could not find or load main class net.minecraft.launchwrapper.Launch') > -1){
                    loggerLaunchSuite.error('Game launch failed, LaunchWrapper was not downloaded properly.')
                    showLaunchFailure(Lang.queryJS('landing.dlAsync.errorDuringLaunchTitle'), Lang.queryJS('landing.dlAsync.launchWrapperNotDownloaded'))
                }
            })
        }

        try {
            // Seed multiplayer list before Java starts so Minecraft reads a stable file.
            seedServerListIfNeeded()

            // Build Minecraft process.
            proc = pb.build()

            if(proc == null || proc.pid == null){
                throw new Error('Minecraft process failed to start.')
            }

            loggerLaunchSuite.info(`Minecraft process started (pid ${proc.pid}).`)

            // Bind listeners to stdout/stderr for launch-progress and error detection.
            proc.stdout.on('data', tempListener)
            proc.stderr.on('data', tempListener)
            proc.stderr.on('data', gameErrorListener)

            // Hide the launcher overlay as soon as Java starts; mod loading can take several minutes.
            setTimeout(onLoadComplete, MIN_LINGER)

            launchUiFallbackTimer = setTimeout(() => {
                if(!loadCompleteHandled){
                    loggerLaunchSuite.warn('Launch UI fallback triggered; hiding progress bar after timeout.')
                    onLoadComplete()
                }
            }, LAUNCH_UI_FALLBACK_MS)

            setTimeout(() => {
                spawnGracePeriod = false
            }, 15000)

            proc.on('close', (code, signal) => {
                if(spawnGracePeriod && code !== 0 && code != null){
                    loggerLaunchSuite.error(`Minecraft exited early with code ${code}${signal ? ` (${signal})` : ''}.`)
                    showLaunchFailure(
                        Lang.queryJS('landing.dlAsync.errorDuringLaunchTitle'),
                        Lang.queryJS('landing.dlAsync.checkConsoleForDetails')
                    )
                }
                proc = null
            })

            setLaunchDetails(Lang.queryJS('landing.dlAsync.doneEnjoyServer'))

        } catch(err) {

            loggerLaunchSuite.error('Error during launch', err)
            showLaunchFailure(Lang.queryJS('landing.dlAsync.errorDuringLaunchTitle'), Lang.queryJS('landing.dlAsync.checkConsoleForDetails'))

        }
    }

}

