// Content script for caption extraction
// This script handles caption extraction from video conferencing platforms

console.log('[CONTENT.JS] Script loaded');

let captionService = null;
let isMonitoring = false;

// Expose captionService globally for contentScript.js to access
window.__captionService = null;

// Initialize message listener
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  console.log('[CONTENT.JS] Received message:', request.action);
  
  if (request.action === 'startCaptionMonitoring') {
    console.log('[CONTENT.JS] Starting caption monitoring...');
    startCaptionMonitoring(sendResponse);
    return true; // Keep channel open for async
  } else if (request.action === 'stopCaptionMonitoring') {
    console.log('[CONTENT.JS] Stopping caption monitoring...');
    stopCaptionMonitoring(sendResponse);
    return true;
  } else if (request.action === 'transcript' && captionService && captionService.useWhisperFallback) {
    // Forward transcript messages to captionService when using Whisper fallback
    // This allows captionService to maintain transcript history and send syncTranscripts
    if (captionService.processWhisperTranscript) {
      captionService.processWhisperTranscript(request.transcript, request.speaker);
    }
  }
  return true;
});

async function startCaptionMonitoring(sendResponse) {
  console.log('[CONTENT.JS] startCaptionMonitoring() called');
  
  try {
    // Initialize caption service if not already initialized
    if (!captionService) {
      if (typeof CaptionService === 'undefined') {
        console.error('[CONTENT.JS] CaptionService class not found');
        if (sendResponse) sendResponse({ success: false, error: 'CaptionService not loaded' });
        return;
      }
      captionService = new CaptionService();
      await captionService.initialize();
      console.log('[CONTENT.JS] CaptionService initialized');
    } else if (captionService.isMonitoring) {
      // If already monitoring, stop first to reset and request permission again
      console.log('[CONTENT.JS] CaptionService was already monitoring, stopping first...');
      await captionService.stopMonitoring();
    }

    // Expose captionService globally for contentScript.js to access
    window.__captionService = captionService;

    // Start monitoring
    await captionService.startMonitoring();
    isMonitoring = true;
    
    console.log('[CONTENT.JS] Caption monitoring started successfully');
    
    // Send message that monitoring started (for UI feedback)
    chrome.runtime.sendMessage({
      action: 'captionMonitoringStarted',
      message: 'Caption monitoring started'
    });
    
    if (sendResponse) sendResponse({ success: true });
  } catch (error) {
    console.error('[CONTENT.JS] Error starting caption monitoring:', error);
    isMonitoring = false;
    if (sendResponse) sendResponse({ success: false, error: error.message });
  }
}

async function stopCaptionMonitoring(sendResponse) {
  console.log('[CONTENT.JS] stopCaptionMonitoring() called');
  
  try {
    if (captionService) {
      await captionService.stopMonitoring();
      console.log('[CONTENT.JS] Caption monitoring stopped');
    }
    isMonitoring = false;
    if (sendResponse) sendResponse({ success: true });
  } catch (error) {
    console.error('[CONTENT.JS] Error stopping caption monitoring:', error);
    if (sendResponse) sendResponse({ success: false, error: error.message });
  }
}

console.log('[CONTENT.JS] Script initialization complete');
