/**
 * Script for news.ejs - the markdown patch-notes panel. Doesn't fetch
 * anything itself: landing.js owns the /news.json check (it runs at
 * startup regardless of which view is active) and calls into
 * renderNewsContent()/toggleNewsPanel() here once the player opens it.
 */
const marked = require('marked')

const newsPanelContainer = document.getElementById('newsPanelContainer')
const newsPanelContent   = document.getElementById('newsPanelContent')
const newsPanelEmpty     = document.getElementById('newsPanelEmpty')
const newsPanelClose     = document.getElementById('newsPanelClose')

/**
 * Render raw markdown into the panel body. Empty/whitespace-only content
 * shows the "nothing here yet" placeholder instead of a blank panel.
 *
 * @param {string} markdown Raw markdown, as returned by /news.json.
 */
function renderNewsContent(markdown){
    if(markdown && markdown.trim().length > 0){
        newsPanelContent.innerHTML = marked.parse(markdown)
        newsPanelContent.style.display = 'block'
        newsPanelEmpty.style.display = 'none'
    } else {
        newsPanelContent.style.display = 'none'
        newsPanelEmpty.style.display = 'block'
    }
}

/**
 * Show/hide the news panel, blurring #main the same way the confirm
 * overlay (overlay.js) already does while it's open.
 *
 * @param {boolean} show True to open the panel, false to close it.
 */
function toggleNewsPanel(show){
    if(show){
        document.getElementById('main').setAttribute('overlay', true)
        $('#newsPanelContainer').fadeIn(250)
    } else {
        document.getElementById('main').removeAttribute('overlay')
        $('#newsPanelContainer').fadeOut(250)
    }
}

newsPanelClose.addEventListener('click', () => toggleNewsPanel(false))
newsPanelContainer.addEventListener('click', e => {
    if(e.target === newsPanelContainer){
        toggleNewsPanel(false)
    }
})
document.addEventListener('keydown', e => {
    if(e.key === 'Escape' && newsPanelContainer.style.display !== 'none'){
        toggleNewsPanel(false)
    }
})
