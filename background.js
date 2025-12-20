// Mukana to mimoLive Sync Extension Background Service Worker

chrome.runtime.onInstalled.addListener(() => {
    console.log('🔧 Mukana to mimoLive Sync Extension installed');
});

// Listen for messages from content scripts
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    console.log('📨 Message received:', request);
    
    if (request.type === 'SCRAPER_STATUS') {
        // Handle scraper status updates
        console.log('📊 Scraper status:', request.data);
        sendResponse({ received: true });
        return true;
    }
    
    if (request.type === 'SCRAPER_ERROR') {
        // Handle scraper errors
        console.error('❌ Scraper error:', request.data);
        sendResponse({ received: true });
        return true;
    }
    
    // Handle API fetch requests from content script
    if (request.type === 'FETCH_API') {
        handleApiFetch(request)
            .then(result => {
                sendResponse({ success: true, ...result });
            })
            .catch(error => {
                console.error('❌ API fetch error:', error);
                sendResponse({ 
                    success: false, 
                    error: error.message,
                    status: error.status || 0
                });
            });
        return true; // Keep channel open for async response
    }
    
    sendResponse({ received: true });
    return true;
});

// Handle API fetch requests (runs in extension context, no CORS restrictions)
async function handleApiFetch(request) {
    const { url, method = 'GET', headers = {}, body } = request;
    
    try {
        console.log(`🌐 Background: Fetching ${method} ${url}`);
        
        const fetchOptions = {
            method: method,
            headers: {
                'User-Agent': 'MukanaScraper/1.0',
                ...headers
            }
        };
        
        if (body) {
            fetchOptions.body = body;
        }
        
        const response = await fetch(url, fetchOptions);
        const responseText = await response.text();
        
        console.log(`✅ Background: ${method} ${url} - Status: ${response.status}`);
        
        return {
            ok: response.ok,
            status: response.status,
            statusText: response.statusText,
            text: responseText,
            headers: Object.fromEntries(response.headers.entries())
        };
    } catch (error) {
        console.error(`❌ Background: Fetch error for ${url}:`, error);
        throw error;
    }
}

// Handle extension icon click (only when popup is not defined)
chrome.action.onClicked.addListener((tab) => {
    console.log('🖱️ Extension icon clicked on tab:', tab.id);
    
    // Check if we're on a Mukana page
    if ((tab.url.includes('mukana-panelView'))) {
        // Inject the scraper if not already present
        chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: () => {
                if (!window.mukanaScraper) {
                    console.log('🔧 Injecting Mukana to mimoLive Sync...');
                    // The content script will handle the injection
                } else {
                    console.log('✅ Mukana to mimoLive Sync already present');
                }
            }
        });
    }
});
