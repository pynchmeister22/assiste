// Background service worker for Mongtro

console.log('[BACKGROUND] Service worker initialized');

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  console.log('[BACKGROUND] Received message:', request.action, request);
  
  if (request.action === 'startCaptionMonitoring') {
    startCaptionMonitoring(sendResponse);
    return true; // Keep channel open for async response
  } else if (request.action === 'stopCaptionMonitoring') {
    stopCaptionMonitoring(sendResponse);
    return true;
  } else if (request.action === 'setApiKey') {
    chrome.storage.local.set({ openaiApiKey: request.apiKey });
    sendResponse({ success: true });
  } else if (request.action === 'getCurrentTab') {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      sendResponse(tabs);
    });
    return true;
  } else if (request.action === 'transcript' || request.action === 'syncTranscripts' || request.action === 'captionMonitoringStarted') {
    // Forward messages from content.js/captionService to contentScript.js
    forwardToContentScript(request, sender.tab?.id);
    sendResponse({ success: true });
  }
  return true;
});

let currentMonitoringTabId = null; // Track which tab is currently monitoring captions

async function startCaptionMonitoring(sendResponse) {
  console.log('[BACKGROUND] startCaptionMonitoring() called');
  
  try {
    chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
      if (chrome.runtime.lastError) {
        console.error('[BACKGROUND] Error querying tabs:', chrome.runtime.lastError);
        if (sendResponse) sendResponse({ success: false, error: chrome.runtime.lastError.message });
        return;
      }
      if (tabs.length === 0) {
        console.error('[BACKGROUND] No active tab found');
        if (sendResponse) sendResponse({ success: false, error: 'No active tab found' });
        return;
      }
      const activeTabId = tabs[0].id;
      console.log('[BACKGROUND] Active tab ID:', activeTabId);
      
      if (typeof activeTabId === 'undefined') {
        console.error('[BACKGROUND] Active tab ID is undefined');
        if (sendResponse) sendResponse({ success: false, error: 'Active tab ID is undefined' });
        return;
      }
      
      // Store the tab ID for transcript forwarding
      currentMonitoringTabId = activeTabId;
      
      // Send message to content script to start caption monitoring
      chrome.tabs.sendMessage(activeTabId, { action: 'startCaptionMonitoring' }, (response) => {
        if (chrome.runtime.lastError) {
          console.error('[BACKGROUND] Error sending startCaptionMonitoring message:', chrome.runtime.lastError);
          if (sendResponse) sendResponse({ success: false, error: chrome.runtime.lastError.message });
        } else {
          console.log('[BACKGROUND] Caption monitoring start message sent, response:', response);
          if (sendResponse) sendResponse({ success: true, ...response });
        }
      });
    });
  } catch (error) {
    console.error('[BACKGROUND] Error in startCaptionMonitoring:', error);
    if (sendResponse) sendResponse({ success: false, error: error.message });
  }
}

async function stopCaptionMonitoring(sendResponse) {
  console.log('[BACKGROUND] stopCaptionMonitoring() called');
  
  try {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs.length === 0) {
        console.log('[BACKGROUND] No active tab found for stop');
        if (sendResponse) sendResponse({ success: true });
        return;
      }
      
      // Clear the monitoring tab ID
      currentMonitoringTabId = null;
      
      // Send message to content script to stop caption monitoring
      chrome.tabs.sendMessage(tabs[0].id, { action: 'stopCaptionMonitoring' }, (response) => {
        if (chrome.runtime.lastError) {
          console.error('[BACKGROUND] Error stopping caption monitoring:', chrome.runtime.lastError);
        } else {
          console.log('[BACKGROUND] Caption monitoring stop message sent');
        }
        if (sendResponse) sendResponse({ success: true });
      });
    });
  } catch (error) {
    console.error('[BACKGROUND] Error in stopCaptionMonitoring:', error);
    if (sendResponse) sendResponse({ success: false, error: error.message });
  }
}

function forwardToContentScript(message, tabId) {
  // Use provided tabId or fall back to currentMonitoringTabId
  const targetTabId = tabId || currentMonitoringTabId;
  
  if (!targetTabId) {
    console.log('[BACKGROUND] No tab ID for forwarding message');
    return;
  }
  
  console.log('[BACKGROUND] Forwarding message to contentScript:', message.action, 'tab:', targetTabId);
  chrome.tabs.sendMessage(targetTabId, message, (response) => {
    if (chrome.runtime.lastError) {
      console.error('[BACKGROUND] Error forwarding message:', chrome.runtime.lastError);
    } else {
      console.log('[BACKGROUND] Message forwarded successfully');
    }
  });
}

console.log('[BACKGROUND] Service worker ready');
