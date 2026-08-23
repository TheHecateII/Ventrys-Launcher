/**
 * Initialize UI functions which depend on internal modules.
 * Loaded after core UI functions are initialized in uicore.js.
 */
// Requirements
const path          = require('path')
const { Type }      = require('helios-distribution-types')

const AuthManager   = require('./assets/js/authmanager')
const ConfigManager = require('./assets/js/configmanager')
const { DistroAPI } = require('./assets/js/distromanager')
// Named distinctly from landing.js's own `ventrysSync`/`VENTRYS_SYNC_URL` -
// classic <script> tags share one global scope, and redeclaring the same
// const name across two of them is a SyntaxError that breaks every script
// on the page (bit us once already this session).
const ventrysSyncBg = require('./assets/js/ventrysSync')
const { VENTRYS_SYNC_URL: BACKGROUND_SYNC_URL } = require('./assets/js/ventrysSyncConfig')

const loggerUIBinder = LoggerUtil.getLogger('UIBinder')

if(!ConfigManager.isLoaded()){
    ConfigManager.load()
}
DistroAPI.commonDir = ConfigManager.getCommonDirectory()
DistroAPI.instanceDir = ConfigManager.getInstanceDirectory()

let rscShouldLoad = false
let fatalStartupError = false
let startupUiRevealed = false
let startupDistributionStarted = false

// Mapping of each view to their container IDs.
const VIEWS = {
    landing: '#landingContainer',
    loginOptions: '#loginOptionsContainer',
    login: '#loginContainer',
    settings: '#settingsContainer',
    welcome: '#welcomeContainer',
    waiting: '#waitingContainer'
}

// The currently shown view container.
let currentView

/**
 * Switch launcher views.
 * 
 * @param {string} current The ID of the current view container. 
 * @param {*} next The ID of the next view container.
 * @param {*} currentFadeTime Optional. The fade out time for the current view.
 * @param {*} nextFadeTime Optional. The fade in time for the next view.
 * @param {*} onCurrentFade Optional. Callback function to execute when the current
 * view fades out.
 * @param {*} onNextFade Optional. Callback function to execute when the next view
 * fades in.
 */
function switchView(current, next, currentFadeTime = 500, nextFadeTime = 500, onCurrentFade = () => {}, onNextFade = () => {}){
    currentView = next
    $(`${current}`).fadeOut(currentFadeTime, async () => {
        await onCurrentFade()
        $(`${next}`).fadeIn(nextFadeTime, async () => {
            await onNextFade()
        })
    })
}

/**
 * Get the currently shown view container.
 * 
 * @returns {string} The currently shown view container.
 */
function getCurrentView(){
    return currentView
}

const BACKGROUND_ROTATE_MS = 12000

/**
 * Preloads an image before it's used as a background - setting
 * backgroundImage to a URL that hasn't finished downloading yet risks a
 * blank/flash frame while it loads.
 */
function preloadImage(url){
    return new Promise((resolve, reject) => {
        const img = new Image()
        img.onload = () => resolve()
        img.onerror = () => reject(new Error(`Failed to load ${url}`))
        img.src = url
    })
}

/**
 * Rotates the launcher's background through whatever ventrys-sync exposes
 * under backgrounds/ (see /config.json's "backgrounds" list), every
 * BACKGROUND_ROTATE_MS. Entirely optional: if the server is unreachable or
 * hasn't got any backgrounds configured, this just leaves the window's own
 * backgroundColor (see index.js) showing - never blocks startup or shows
 * an error over a purely cosmetic feature.
 */
async function startBackgroundSlideshow(){
    let backgrounds
    try {
        const config = await ventrysSyncBg.fetchConfig(BACKGROUND_SYNC_URL)
        backgrounds = config.backgrounds
    } catch (err) {
        loggerUIBinder.warn('Unable to fetch background list, keeping the default background.', err)
        return
    }

    if(backgrounds == null || backgrounds.length === 0){
        return
    }

    let index = 0
    const showNext = async () => {
        const bg = backgrounds[index % backgrounds.length]
        index++
        try {
            await preloadImage(bg.url)
            document.body.style.backgroundImage = `url('${bg.url}')`
        } catch (err) {
            loggerUIBinder.warn(`Skipping background ${bg.url}:`, err)
        }
    }

    await showNext()
    setInterval(showNext, BACKGROUND_ROTATE_MS)
}

function revealLauncherUI() {
    if(!isDev){
        const { AUTO_UPDATES_ENABLED } = require('./assets/js/ipcconstants')
        if(AUTO_UPDATES_ENABLED){
            loggerAutoUpdater.info('Initializing..')
            ipcRenderer.send('autoUpdateAction', 'initAutoUpdater', ConfigManager.getAllowPrerelease())
        }
    }

    document.getElementById('frameBar').style.backgroundColor = 'rgba(0, 0, 0, 0.5)'
    // No bundled local default anymore - the wolf image moved to
    // ventrys-sync's backgrounds/ folder, served through the same
    // slideshow as everything else. Until it loads, the window's own
    // backgroundColor ('#171614', see index.js) shows through.
    startBackgroundSlideshow()
    $('#main').show()

    const isLoggedIn = Object.keys(ConfigManager.getAuthAccounts()).length > 0

    if(ConfigManager.isFirstLaunch()){
        currentView = VIEWS.welcome
        $(VIEWS.welcome).fadeIn(1000)
    } else if(isLoggedIn){
        currentView = VIEWS.landing
        $(VIEWS.landing).fadeIn(1000)
    } else {
        loginOptionsCancelEnabled(false)
        loginOptionsViewOnLoginSuccess = VIEWS.landing
        loginOptionsViewOnLoginCancel = VIEWS.loginOptions
        currentView = VIEWS.loginOptions
        $(VIEWS.loginOptions).fadeIn(1000)
    }

    setTimeout(() => {
        $('#loadingContainer').fadeOut(500, () => {
            $('#loadSpinnerImage').removeClass('rotating')
        })
    }, 250)

    if(!isDev && isLoggedIn){
        validateSelectedAccount()
    }
}

function beginStartupUI() {
    if(startupUiRevealed){
        return
    }
    startupUiRevealed = true
    revealLauncherUI()
}

function loadStartupDistribution(){
    if(typeof DistroAPI.getDistributionLocalLoadOnly === 'function'){
        return DistroAPI.getDistributionLocalLoadOnly()
    }
    return DistroAPI.getDistribution()
}

/**
 * Resolve the server that should be considered "selected", persisting it if
 * nothing was saved yet. There's no more server-select onboarding step (V0.1
 * is single-server), so without this the launch button stays permanently
 * disabled on a fresh install - ConfigManager.getSelectedServer() defaults to
 * null and getServerById(null) resolves to null.
 */
function resolveSelectedServer(data){
    let serv = data.getServerById(ConfigManager.getSelectedServer())
    if(serv == null){
        serv = data.getMainServer()
        if(serv != null){
            ConfigManager.setSelectedServer(serv.rawServer.id)
            ConfigManager.save()
        }
    }
    return serv
}

function completeStartupUI(data) {
    try {
        if(typeof updateSelectedServer === 'function'){
            updateSelectedServer(resolveSelectedServer(data))
        }
        if(typeof refreshServerStatus === 'function'){
            refreshServerStatus()
        }
    } catch (err) {
        loggerUIBinder.warn('Failed to refresh landing UI during startup.', err)
    }

    setTimeout(() => {
        try {
            syncModConfigurations(data)
            ensureJavaSettings(data)
        } catch (err) {
            loggerUIBinder.warn('Failed to sync mod/java settings during startup.', err)
        }
    }, 0)

    if(typeof prepareSettings === 'function'){
        prepareSettings(true).catch(err => {
            loggerUIBinder.warn('Settings UI preparation failed during startup.', err)
        })
    } else {
        loggerUIBinder.error('prepareSettings is not defined. Settings tab may be unavailable until restart.')
    }
}

function onDistributionReady(){
    beginStartupUI()

    if(startupDistributionStarted){
        return
    }
    startupDistributionStarted = true

    loadStartupDistribution()
        .then(data => completeStartupUI(data))
        .catch(err => {
            loggerUIBinder.warn('Local distribution load failed, trying remote.', err)
            return DistroAPI.getDistribution()
                .then(data => completeStartupUI(data))
                .catch(err2 => {
                    loggerUIBinder.error('Unable to load distribution index in renderer.', err2)
                })
        })
}

function showMainUI(data){
    beginStartupUI()
    if(data != null){
        completeStartupUI(data)
    } else {
        loadStartupDistribution()
            .then(d => completeStartupUI(d))
            .catch(err => loggerUIBinder.error('Unable to complete startup UI setup.', err))
    }
}

function showFatalStartupError(){
    setTimeout(() => {
        $('#loadingContainer').fadeOut(250, () => {
            document.getElementById('overlayContainer').style.background = 'none'
            setOverlayContent(
                Lang.queryJS('uibinder.startup.fatalErrorTitle'),
                Lang.queryJS('uibinder.startup.fatalErrorMessage'),
                Lang.queryJS('uibinder.startup.closeButton')
            )
            setOverlayHandler(() => {
                const window = remote.getCurrentWindow()
                window.close()
            })
            toggleOverlay(true)
        })
    }, 750)
}

/**
 * Common functions to perform after refreshing the distro index.
 * 
 * @param {Object} data The distro index object.
 */
function onDistroRefresh(data){
    updateSelectedServer(resolveSelectedServer(data))
    refreshServerStatus()
    syncModConfigurations(data)
    ensureJavaSettings(data)
}

/**
 * Sync the mod configurations with the distro index.
 * 
 * @param {Object} data The distro index object.
 */
function syncModConfigurations(data){

    const syncedCfgs = []

    for(let serv of data.servers){

        const id = serv.rawServer.id
        const mdls = serv.modules
        const cfg = ConfigManager.getModConfiguration(id)

        if(cfg != null){

            const modsOld = cfg.mods
            const mods = {}

            for(let mdl of mdls){
                const type = mdl.rawModule.type

                if(type === Type.ForgeMod || type === Type.LiteMod || type === Type.LiteLoader || type === Type.FabricMod){
                    if(!mdl.getRequired().value){
                        const mdlID = mdl.getVersionlessMavenIdentifier()
                        if(modsOld[mdlID] == null){
                            mods[mdlID] = scanOptionalSubModules(mdl.subModules, mdl)
                        } else {
                            mods[mdlID] = mergeModConfiguration(modsOld[mdlID], scanOptionalSubModules(mdl.subModules, mdl), false)
                        }
                    } else {
                        if(mdl.subModules.length > 0){
                            const mdlID = mdl.getVersionlessMavenIdentifier()
                            const v = scanOptionalSubModules(mdl.subModules, mdl)
                            if(typeof v === 'object'){
                                if(modsOld[mdlID] == null){
                                    mods[mdlID] = v
                                } else {
                                    mods[mdlID] = mergeModConfiguration(modsOld[mdlID], v, true)
                                }
                            }
                        }
                    }
                }
            }

            syncedCfgs.push({
                id,
                mods
            })

        } else {

            const mods = {}

            for(let mdl of mdls){
                const type = mdl.rawModule.type
                if(type === Type.ForgeMod || type === Type.LiteMod || type === Type.LiteLoader || type === Type.FabricMod){
                    if(!mdl.getRequired().value){
                        mods[mdl.getVersionlessMavenIdentifier()] = scanOptionalSubModules(mdl.subModules, mdl)
                    } else {
                        if(mdl.subModules.length > 0){
                            const v = scanOptionalSubModules(mdl.subModules, mdl)
                            if(typeof v === 'object'){
                                mods[mdl.getVersionlessMavenIdentifier()] = v
                            }
                        }
                    }
                }
            }

            syncedCfgs.push({
                id,
                mods
            })

        }
    }

    ConfigManager.setModConfigurations(syncedCfgs)
    ConfigManager.save()
}

/**
 * Ensure java configurations are present for the available servers.
 * 
 * @param {Object} data The distro index object.
 */
function ensureJavaSettings(data) {

    // Nothing too fancy for now.
    for(const serv of data.servers){
        ConfigManager.ensureJavaConfig(serv.rawServer.id, serv.effectiveJavaOptions, serv.rawServer.javaOptions?.ram)
    }

    ConfigManager.save()
}

/**
 * Recursively scan for optional sub modules. If none are found,
 * this function returns a boolean. If optional sub modules do exist,
 * a recursive configuration object is returned.
 * 
 * @returns {boolean | Object} The resolved mod configuration.
 */
function scanOptionalSubModules(mdls, origin){
    if(mdls != null){
        const mods = {}

        for(let mdl of mdls){
            const type = mdl.rawModule.type
            // Optional types.
            if(type === Type.ForgeMod || type === Type.LiteMod || type === Type.LiteLoader || type === Type.FabricMod){
                // It is optional.
                if(!mdl.getRequired().value){
                    mods[mdl.getVersionlessMavenIdentifier()] = scanOptionalSubModules(mdl.subModules, mdl)
                } else {
                    if(mdl.hasSubModules()){
                        const v = scanOptionalSubModules(mdl.subModules, mdl)
                        if(typeof v === 'object'){
                            mods[mdl.getVersionlessMavenIdentifier()] = v
                        }
                    }
                }
            }
        }

        if(Object.keys(mods).length > 0){
            const ret = {
                mods
            }
            if(!origin.getRequired().value){
                ret.value = origin.getRequired().def
            }
            return ret
        }
    }
    return origin.getRequired().def
}

/**
 * Recursively merge an old configuration into a new configuration.
 * 
 * @param {boolean | Object} o The old configuration value.
 * @param {boolean | Object} n The new configuration value.
 * @param {boolean} nReq If the new value is a required mod.
 * 
 * @returns {boolean | Object} The merged configuration.
 */
function mergeModConfiguration(o, n, nReq = false){
    if(typeof o === 'boolean'){
        if(typeof n === 'boolean') return o
        else if(typeof n === 'object'){
            if(!nReq){
                n.value = o
            }
            return n
        }
    } else if(typeof o === 'object'){
        if(typeof n === 'boolean') return typeof o.value !== 'undefined' ? o.value : true
        else if(typeof n === 'object'){
            if(!nReq){
                n.value = typeof o.value !== 'undefined' ? o.value : true
            }

            const newMods = Object.keys(n.mods)
            for(let i=0; i<newMods.length; i++){

                const mod = newMods[i]
                if(o.mods[mod] != null){
                    n.mods[mod] = mergeModConfiguration(o.mods[mod], n.mods[mod])
                }
            }

            return n
        }
    }
    // If for some reason we haven't been able to merge,
    // wipe the old value and use the new one. Just to be safe
    return n
}

async function validateSelectedAccount(){
    const selectedAcc = ConfigManager.getSelectedAccount()
    if(selectedAcc != null){
        const val = await AuthManager.validateSelected()
        if(!val){
            ConfigManager.removeAuthAccount(selectedAcc.uuid)
            ConfigManager.save()
            const accLen = Object.keys(ConfigManager.getAuthAccounts()).length
            setOverlayContent(
                Lang.queryJS('uibinder.validateAccount.failedMessageTitle'),
                accLen > 0
                    ? Lang.queryJS('uibinder.validateAccount.failedMessage', { 'account': selectedAcc.displayName })
                    : Lang.queryJS('uibinder.validateAccount.failedMessageSelectAnotherAccount', { 'account': selectedAcc.displayName }),
                Lang.queryJS('uibinder.validateAccount.loginButton'),
                Lang.queryJS('uibinder.validateAccount.selectAnotherAccountButton')
            )
            setOverlayHandler(() => {

                const isMicrosoft = selectedAcc.type === 'microsoft'

                if(isMicrosoft) {
                    // Empty for now
                } else {
                    // Mojang
                    // For convenience, pre-populate the username of the account.
                    document.getElementById('loginUsername').value = selectedAcc.username
                    validateEmail(selectedAcc.username)
                }
                
                loginOptionsViewOnLoginSuccess = getCurrentView()
                loginOptionsViewOnLoginCancel = VIEWS.loginOptions

                if(accLen > 0) {
                    loginOptionsViewOnCancel = getCurrentView()
                    loginOptionsViewCancelHandler = () => {
                        if(isMicrosoft) {
                            ConfigManager.addMicrosoftAuthAccount(
                                selectedAcc.uuid,
                                selectedAcc.accessToken,
                                selectedAcc.username,
                                selectedAcc.expiresAt,
                                selectedAcc.microsoft.access_token,
                                selectedAcc.microsoft.refresh_token,
                                selectedAcc.microsoft.expires_at
                            )
                        } else {
                            ConfigManager.addMojangAuthAccount(selectedAcc.uuid, selectedAcc.accessToken, selectedAcc.username, selectedAcc.displayName)
                        }
                        ConfigManager.save()
                        validateSelectedAccount()
                    }
                    loginOptionsCancelEnabled(true)
                } else {
                    loginOptionsCancelEnabled(false)
                }
                toggleOverlay(false)
                switchView(getCurrentView(), VIEWS.loginOptions)
            })
            setDismissHandler(() => {
                if(accLen > 1){
                    prepareAccountSelectionList()
                    $('#overlayContent').fadeOut(250, () => {
                        bindOverlayKeys(true, 'accountSelectContent', true)
                        $('#accountSelectContent').fadeIn(250)
                    })
                } else {
                    const accountsObj = ConfigManager.getAuthAccounts()
                    const accounts = Array.from(Object.keys(accountsObj), v => accountsObj[v])
                    // This function validates the account switch.
                    setSelectedAccount(accounts[0].uuid)
                    toggleOverlay(false)
                }
            })
            toggleOverlay(true, accLen > 0)
        } else {
            return true
        }
    } else {
        return true
    }
}

/**
 * Temporary function to update the selected account along
 * with the relevent UI elements.
 * 
 * @param {string} uuid The UUID of the account.
 */
function setSelectedAccount(uuid){
    const authAcc = ConfigManager.setSelectedAccount(uuid)
    ConfigManager.save()
    updateSelectedAccount(authAcc)
    validateSelectedAccount()
}

// Synchronous Listener
document.addEventListener('readystatechange', () => {

    if (document.readyState === 'interactive' || document.readyState === 'complete'){
        if(rscShouldLoad){
            rscShouldLoad = false
            if(!fatalStartupError){
                onDistributionReady()
            } else {
                showFatalStartupError()
            }
        } 
    }

}, false)

// Actions that must be performed after the distribution index is downloaded.
ipcRenderer.on('distributionIndexDone', (event, res) => {
    if(res) {
        if(document.readyState === 'interactive' || document.readyState === 'complete'){
            onDistributionReady()
        } else {
            rscShouldLoad = true
        }
    } else {
        fatalStartupError = true
        if(document.readyState === 'interactive' || document.readyState === 'complete'){
            showFatalStartupError()
        } else {
            rscShouldLoad = true
        }
    }
})

setTimeout(() => {
    if(!startupUiRevealed){
        loggerUIBinder.warn('Startup watchdog: distribution signal missing or delayed, forcing UI reveal.')
        onDistributionReady()
    }
}, 8000)

// Util for development
async function devModeToggle() {
    DistroAPI.toggleDevMode(true)
    const data = await DistroAPI.refreshDistributionOrFallback()
    ensureJavaSettings(data)
    updateSelectedServer(data.servers[0])
    syncModConfigurations(data)
}
