// Offscreen document script for tab capture
// This runs in a window context and can access chrome.tabCapture API

console.log('[OFFSCREEN] Offscreen document loaded');

let pendingRequestId = null;

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  console.log('[OFFSCREEN] Received message:', request.action);
  
  if (request.action === 'captureTabAudioStream') {
    captureTabAudioStream(request.tabId, request.requestId, sendResponse);
    return true; // Keep channel open for async response
  }
  
  return true;
});

async function captureTabAudioStream(tabId, requestId, sendResponse) {
  try {
    console.log('[OFFSCREEN] Capturing tab audio stream for tab:', tabId);
    
    // Capture tab audio - this API works in offscreen document context
    chrome.tabCapture.capture({
      audio: true,
      video: false
    }, (streamId) => {
      if (chrome.runtime.lastError) {
        console.error('[OFFSCREEN] Error capturing tab audio:', chrome.runtime.lastError);
        const response = { success: false, error: chrome.runtime.lastError.message, requestId: requestId };
        sendResponse(response);
        // Also send via runtime message as backup
        chrome.runtime.sendMessage(response);
        return;
      }

      if (!streamId) {
        console.error('[OFFSCREEN] No streamId returned from tabCapture');
        const response = { success: false, error: 'No streamId returned', requestId: requestId };
        sendResponse(response);
        chrome.runtime.sendMessage(response);
        return;
      }

      console.log('[OFFSCREEN] Tab audio captured, streamId:', streamId);
      const response = { success: true, streamId: streamId, requestId: requestId };
      sendResponse(response);
      // Also send via runtime message as backup
      chrome.runtime.sendMessage(response);
    });
  } catch (error) {
    console.error('[OFFSCREEN] Error in captureTabAudioStream:', error);
    const response = { success: false, error: error.message, requestId: requestId };
    sendResponse(response);
    chrome.runtime.sendMessage(response);
  }
}

