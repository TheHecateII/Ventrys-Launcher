/**
 * Talks to the ventrys-sync backend's /news.json - raw admin-written
 * markdown plus a content hash, so the caller can tell whether this is
 * the same news the player already saw without comparing full text.
 */
const got = require('got')

async function fetchNews(baseUrl) {
    const res = await got(`${baseUrl}/news.json`, { responseType: 'json', timeout: { request: 15000 } })
    return res.body // { content, hash }
}

module.exports = {
    fetchNews
}
