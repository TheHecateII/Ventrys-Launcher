/**
 * Drop-in replacement for the old Nebula/distribution.json-backed DistroAPI.
 * Keeps the exact same export name and method surface
 * (getDistribution/getDistributionLocalLoadOnly/refreshDistributionOrFallback/
 * toggleDevMode/isDevMode, plus assignable .commonDir/.instanceDir) so every
 * other file that reads the shared `DistroAPI` global (uicore.js loads first,
 * classic scripts share one lexical scope - same mechanism as the @electron/
 * remote shim) keeps working unmodified. Only what's inside changes.
 *
 * Sources server metadata from the ventrys-sync backend instead of a
 * distribution.json fetch/cache-to-disk cycle - nothing is ever written to
 * disk here, just kept in memory and refetched on demand. `modules` is
 * always empty: this object is only used for display (name/icon/status) and
 * server selection, never for the real launch, which uses
 * ventrysSync.buildDistribution() with the actually-installed Forge's local
 * version.json instead.
 */
const { HeliosDistribution } = require('helios-core/common')

const ventrysSync = require('./ventrysSync')
const { VENTRYS_SYNC_URL } = require('./ventrysSyncConfig')

class VentrysDistroAdapter {
    constructor() {
        this.commonDir = null // assigned externally by uibinder.js
        this.instanceDir = null // assigned externally by uibinder.js
        this.distribution = null
        this._devMode = false
    }

    async _load() {
        const config = await ventrysSync.fetchConfig(VENTRYS_SYNC_URL)
        const meta = config.server || {}
        const raw = {
            version: '1.0.0',
            rss: '',
            discord: {},
            servers: [{
                id: meta.id,
                name: meta.name,
                description: meta.description || '',
                icon: meta.icon || null,
                version: '1.0.0',
                address: meta.address,
                minecraftVersion: meta.minecraftVersion,
                discord: {},
                mainServer: true,
                autoconnect: meta.autoconnect ?? false,
                modules: []
            }]
        }
        this.distribution = new HeliosDistribution(raw, this.commonDir, this.instanceDir)
        return this.distribution
    }

    async getDistribution() {
        if (this.distribution == null) {
            return this._load()
        }
        return this.distribution
    }

    // No on-disk cache anymore (nothing written for a "local-only" load to
    // read back) - same in-memory result as getDistribution().
    async getDistributionLocalLoadOnly() {
        return this.getDistribution()
    }

    async refreshDistributionOrFallback() {
        try {
            return await this._load()
        } catch (err) {
            if (this.distribution != null) {
                return this.distribution
            }
            throw err
        }
    }

    toggleDevMode(dev) {
        this._devMode = dev
    }

    isDevMode() {
        return this._devMode
    }
}

exports.DistroAPI = new VentrysDistroAdapter()
