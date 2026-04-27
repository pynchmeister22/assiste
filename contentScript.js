// Content script to inject the assistant UI into web pages

console.log('[CONTENTSCRIPT] Script loaded');

let assistantUI = null;
let aiService = null;
let captionServiceRef = null; // Reference to CaptionService for Whisper triggering
let isAssistantActive = false;
let chatHistorySaveInterval = null;
let isSavingChatHistory = false;
// Use constants if available, otherwise use defaults
const CHAT_HISTORY_SAVE_INTERVAL_MS = CONSTANTS?.CHAT_HISTORY_SAVE_INTERVAL_MS || 10000;
const MAX_TRANSCRIPTS_TO_SAVE = CONSTANTS?.MAX_TRANSCRIPTS_TO_SAVE || 200;

// Listen for messages from content.js (speech recognition) and background/popup
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  console.log('[CONTENTSCRIPT] Received message:', request.action, request);
  
  if (request.action === 'checkReady') {
    // Check if AIService is available
    const ready = typeof AIService !== 'undefined';
    sendResponse({ ready: ready });
    return true;
  } else if (request.action === 'startAssistant') {
    startAssistant(request.session).then(() => {
      sendResponse({ success: true });
    }).catch((error) => {
      console.error('[CONTENTSCRIPT] Error in startAssistant:', error);
      sendResponse({ success: false, error: error.message });
    });
    return true; // Keep channel open for async response
  } else if (request.action === 'stopAssistant') {
    stopAssistant();
    sendResponse({ success: true });
  } else if (request.action === 'transcript') {
    handleTranscript(request.transcript, request.type, request.speaker);
    sendResponse({ success: true });
  } else if (request.action === 'syncTranscripts') {
    syncTranscripts(request.transcripts);
    sendResponse({ success: true });
  } else if (request.action === 'speechStarted') {
    console.log('[CONTENTSCRIPT] Speech recognition started');
    updateStatus('Listening...');
  } else if (request.action === 'triggerWhisperTranscription') {
    // Manually trigger Whisper transcription (for external requests)
    triggerWhisperTranscriptionIfActive().then((transcription) => {
      sendResponse({ success: true, transcription: transcription });
    }).catch((error) => {
      console.error('[CONTENTSCRIPT] Error triggering Whisper transcription:', error);
      sendResponse({ success: false, error: error.message });
    });
    return true; // Keep channel open for async response
  } else if (request.action === 'getWhisperStatus') {
    // Get Whisper status (is recording, is transcribing, audio level)
    const captionService = window.__captionService;
    const whisperService = captionService?.whisperService;
    sendResponse({
      isActive: captionService?.isWhisperActive?.() || false,
      isRecording: whisperService?.getIsRecording?.() || false,
      isTranscribing: whisperService?.getIsTranscribing?.() || false,
      audioLevel: whisperService?.getCurrentAudioLevel?.() || 0
    });
    return true;
  }
  return true;
});

async function startAssistant(session) {
  if (isAssistantActive) {
    console.log('[CONTENTSCRIPT] Assistant already active');
    return;
  }

  try {
    console.log('[CONTENTSCRIPT] Starting assistant with session:', session);

    let ensuredSession = await ensureSessionHasId(session);
    ensuredSession = await ensureSessionHasTitle(ensuredSession);
    ensuredSession = await hydrateResumeFromBackendIfNeeded(ensuredSession);

    // Check if AI service is available (it should be loaded via manifest)
    if (typeof AIService === 'undefined') {
      console.error('[CONTENTSCRIPT] AIService class not found');
      throw new Error('AIService class not found. Please reload the extension.');
    }
    
    console.log('[CONTENTSCRIPT] AIService class is available');

    // Inject UI first for instant feedback - don't wait for anything
    injectAssistantUI();
    isAssistantActive = true;
    console.log('[CONTENTSCRIPT] Assistant UI injected');

    // Initialize AI service and handle summarizations after initialization
    aiService = new AIService();
    // Initialize and then run summarizations in background
    aiService.initialize(ensuredSession).then(() => {
      console.log('[CONTENTSCRIPT] AI service initialized');
      
      // Initialize technical interview toggle from session
      if (ensuredSession.isTechnicalInterview !== undefined) {
        settings.isTechnicalInterview = ensuredSession.isTechnicalInterview;
        const technicalInterviewToggle = document.getElementById('technicalInterviewToggle');
        if (technicalInterviewToggle) {
          technicalInterviewToggle.checked = ensuredSession.isTechnicalInterview;
        }
        chrome.storage.local.set({ isTechnicalInterview: ensuredSession.isTechnicalInterview });
      }
      
      // Summarize resume and job description in parallel if summaries don't already exist
      // Run these in background - UI is already shown
      const summarizationPromises = [];
      
      if (!aiService.session.resumeSummary && aiService.summarizeResume) {
        console.log('[CONTENTSCRIPT] Summarizing resume...');
        summarizationPromises.push(
          aiService.summarizeResume().then(() => {
            // Reload session from storage to get updated summaries
            return chrome.storage.local.get(['currentSession']).then(updatedSession => {
              if (updatedSession.currentSession) {
                aiService.session = updatedSession.currentSession;
              }
            });
          }).catch(error => {
            console.error('[CONTENTSCRIPT] Error summarizing resume:', error);
          })
        );
      }
      
      if (!aiService.session.jobDescriptionSummary && aiService.summarizeJobDescription) {
        console.log('[CONTENTSCRIPT] Summarizing job description...');
        summarizationPromises.push(
          aiService.summarizeJobDescription().then(() => {
            // Reload session from storage to get updated summaries
            return chrome.storage.local.get(['currentSession']).then(updatedSession => {
              if (updatedSession.currentSession) {
                aiService.session = updatedSession.currentSession;
              }
            });
          }).catch(error => {
            console.error('[CONTENTSCRIPT] Error summarizing job description:', error);
          })
        );
      }

      // Run summarizations in parallel (don't await - let them run in background)
      if (summarizationPromises.length > 0) {
        Promise.all(summarizationPromises).then(() => {
          console.log('[CONTENTSCRIPT] All summarizations completed');
        });
      }
    }).catch(error => {
      console.error('[CONTENTSCRIPT] Error initializing AI service:', error);
    });

    startChatHistoryAutosave();

    // Start caption monitoring via content.js
    console.log('[CONTENTSCRIPT] Requesting caption monitoring start...');
    chrome.runtime.sendMessage({ action: 'startCaptionMonitoring' }, (response) => {
      if (chrome.runtime.lastError) {
        console.error('[CONTENTSCRIPT] Error starting caption monitoring:', chrome.runtime.lastError);
      } else {
        console.log('[CONTENTSCRIPT] Caption monitoring request sent, response:', response);
      }
    });

    // Update listening toggle state after a short delay to allow captionService to initialize
    setTimeout(() => {
      updateListeningToggleState();
    }, 1000);
  } catch (error) {
    console.error('[CONTENTSCRIPT] Error in startAssistant:', error);
    throw error;
  }
}

function stopAssistant() {
  if (!isAssistantActive) {
    return;
  }

  console.log('[CONTENTSCRIPT] Stopping assistant');

  stopChatHistoryAutosave();

  if (assistantUI) {
    assistantUI.remove();
    assistantUI = null;
  }

  isAssistantActive = false;

  chrome.runtime.sendMessage({ action: 'stopCaptionMonitoring' }, (response) => {
    if (chrome.runtime.lastError) {
      console.error('[CONTENTSCRIPT] Error stopping caption monitoring:', chrome.runtime.lastError);
    }
  });
}

const generateSessionId = () => `interview-${Date.now()}-${Math.floor(Math.random() * 100000)}`;

async function ensureSessionHasId(session = {}) {
  if (session.sessionId) {
    return session;
  }
  const sessionId = generateSessionId();
  const updatedSession = { ...session, sessionId };
  await chrome.storage.local.set({ currentSession: updatedSession });
  return updatedSession;
}

const extractCompanyName = (jobDescription) => {
  if (!jobDescription) return '';
  const text = jobDescription.trim();
  const companyLabelMatch = text.match(/(?:company name|company)\s*[:\-]\s*([^\n\r,.]+)/i);
  if (companyLabelMatch && companyLabelMatch[1]) {
    return companyLabelMatch[1].trim();
  }
  const atMatch = text.match(/\bat\s+([A-Z][A-Za-z0-9&.\- ]{2,60})/);
  if (atMatch && atMatch[1]) {
    return atMatch[1].trim();
  }
  const firstLine = text.split(/\r?\n/).find((line) => line.trim().length > 0);
  if (firstLine) {
    return firstLine.substring(0, 60).trim();
  }
  return '';
};

async function ensureSessionHasTitle(session = {}) {
  if (session.interviewTitle) {
    return session;
  }
  const derivedTitle = extractCompanyName(session.jobDescription) || 'Interview';
  const updatedSession = { ...session, interviewTitle: derivedTitle };
  await chrome.storage.local.set({ currentSession: updatedSession });
  return updatedSession;
}

/** If the session has resumeId but no usable body (e.g. restored tab), load GET /api/resumes/:id. */
async function hydrateResumeFromBackendIfNeeded(session) {
  if (!session?.resumeId || typeof AuthService === 'undefined') {
    return session;
  }
  const svc = new AuthService();
  if (svc.resumeBodyLooksUsable(session.resumeContent)) {
    return session;
  }
  const full = await svc.fetchResumeById(session.resumeId);
  if (!full) {
    console.warn('[CONTENTSCRIPT] Could not hydrate resume from server:', session.resumeId);
    return session;
  }
  const resumeContent = svc.normalizeResumeContent(full);
  const next = { ...session, resumeContent };
  await chrome.storage.local.set({ currentSession: next });
  return next;
}

const trimTranscripts = (transcripts = {}) => {
  const normalize = (items = [], fallbackSpeaker) =>
    (items || [])
      .slice(-MAX_TRANSCRIPTS_TO_SAVE)
      .map(item => ({
        text: item?.text || '',
        timestamp: item?.timestamp || Date.now(),
        speaker: item?.speaker || fallbackSpeaker,
        speakerName: item?.speakerName || null,
        order: item?.order ?? null
      }));

  return {
    interviewer: normalize(transcripts.interviewer, 'interviewer'),
    user: normalize(transcripts.user, 'user')
  };
};

// Sync all transcripts from aiService.captionHistory into session.transcripts
async function syncAllTranscriptsToSession() {
  if (!aiService || !aiService.captionHistory || aiService.captionHistory.length === 0) {
    return;
  }

  try {
    const result = await chrome.storage.local.get(['currentSession']);
    if (!result.currentSession) {
      return;
    }

    const session = result.currentSession;
    
    // Initialize transcript arrays if they don't exist
    if (!session.transcripts) {
      session.transcripts = {
        interviewer: [],
        user: []
      };
    }

    // Create a set of existing transcript texts to avoid duplicates
    const existingTexts = new Set();
    session.transcripts.interviewer.forEach(t => existingTexts.add(t.text));
    session.transcripts.user.forEach(t => existingTexts.add(t.text));

    // Add all captions from aiService that aren't already in session
    // Check if it's a user prompt (starts with [You]) or interviewer caption
    aiService.captionHistory.forEach(caption => {
      const captionText = caption.text || '';
      
      // Skip if already exists
      if (existingTexts.has(captionText)) {
        return;
      }

      // Check if it's a user prompt (added via addUserPrompt)
      if (captionText.startsWith('[You]')) {
        // Remove the [You] prefix and save as user transcript
        const userText = captionText.replace(/^\[You\]\s*/, '').trim();
        if (userText) {
          session.transcripts.user.push({
            text: userText,
            timestamp: caption.timestamp || Date.now()
          });
          existingTexts.add(captionText); // Track with prefix to avoid duplicates
        }
      } else {
        // Treat as interviewer transcript (most captions are interviewer questions)
        session.transcripts.interviewer.push({
          text: captionText,
          timestamp: caption.timestamp || Date.now()
        });
        existingTexts.add(captionText);
      }
    });

    // Save updated session
    await chrome.storage.local.set({ currentSession: session });
    console.log('[CONTENTSCRIPT] Synced all transcripts from aiService to session');
  } catch (error) {
    console.error('[CONTENTSCRIPT] Error syncing transcripts to session:', error);
  }
}

async function saveChatHistoryToBackend() {
  if (!isAssistantActive || isSavingChatHistory) {
    return;
  }

  isSavingChatHistory = true;
  try {
    // First, sync all transcripts from aiService.captionHistory into session
    await syncAllTranscriptsToSession();

    const { currentSession } = await chrome.storage.local.get(['currentSession']);

    if (!currentSession) {
      console.warn('[CONTENTSCRIPT] No current session found, skipping chat history save');
      return;
    }

    const sessionWithId = await ensureSessionHasTitle(await ensureSessionHasId(currentSession));

    const apiBaseUrl = await config.getApiBaseUrl();
    const payload = {
      interviewId: sessionWithId.sessionId,
      transcripts: trimTranscripts(sessionWithId.transcripts),
      resumeId: sessionWithId.resumeId,
      jobDescription: sessionWithId.jobDescription,
      additionalInfo: sessionWithId.additionalInfo,
      startedAt: sessionWithId.createdAt || Date.now(),
      title: sessionWithId.interviewTitle
    };

    const response = await fetch(`${apiBaseUrl}/api/chat-history`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('[CONTENTSCRIPT] Failed to save chat history:', response.status, errorText);
    } else {
      console.debug('[CONTENTSCRIPT] Chat history saved');
    }
  } catch (error) {
    console.error('[CONTENTSCRIPT] Error saving chat history:', error);
  } finally {
    isSavingChatHistory = false;
  }
}

async function startChatHistoryAutosave() {
  await saveChatHistoryToBackend();
  if (chatHistorySaveInterval) {
    clearInterval(chatHistorySaveInterval);
  }
  chatHistorySaveInterval = setInterval(() => {
    saveChatHistoryToBackend();
  }, CHAT_HISTORY_SAVE_INTERVAL_MS);
}

function stopChatHistoryAutosave() {
  if (chatHistorySaveInterval) {
    clearInterval(chatHistorySaveInterval);
    chatHistorySaveInterval = null;
  }
}

function injectAssistantUI() {
  try {
    console.log('[CONTENTSCRIPT] Injecting assistant UI...');
    
    // Remove existing UI if any
    const existing = document.getElementById('ntro-assistant-root');
    if (existing) {
      console.log('[CONTENTSCRIPT] Removing existing UI');
      existing.remove();
    }

    // Create container
    assistantUI = document.createElement('div');
    assistantUI.id = 'ntro-assistant-root';
    assistantUI.className = 'show';

    // Inject styles
    const existingStyle = document.querySelector('link[href*="assistantUIStyle.css"]');
    if (!existingStyle) {
      const styleLink = document.createElement('link');
      styleLink.rel = 'stylesheet';
      styleLink.href = chrome.runtime.getURL('assistantUIStyle.css');
      styleLink.onerror = () => {
        console.error('[CONTENTSCRIPT] Failed to load assistant UI styles');
      };
      document.head.appendChild(styleLink);
      console.log('[CONTENTSCRIPT] Styles injected');
    }

    // Create UI structure
    const minFontSize = CONSTANTS?.MIN_FONT_SIZE || 12;
    const maxFontSize = CONSTANTS?.MAX_FONT_SIZE || 24;
    const defaultFontSize = CONSTANTS?.DEFAULT_FONT_SIZE || 16;
    const minOpacity = CONSTANTS?.MIN_OPACITY || 0.3;
    const maxOpacity = CONSTANTS?.MAX_OPACITY || 1.0;
    const defaultOpacity = CONSTANTS?.DEFAULT_OPACITY || 0.7;
    
    assistantUI.innerHTML = `
      <div class="ntro-overlay">
        <div class="ntro-container">
          <!-- Left Sidebar - Settings -->
          <div class="ntro-sidebar">
            <div class="ntro-sidebar-header">
              <div class="ntro-logo">
                <div class="ntro-logo-icon">M</div>
                <span class="ntro-logo-text">Mongtro</span>
              </div>
              <div class="ntro-sidebar-controls">
                <button class="ntro-control-btn" id="closeBtn" title="Close">×</button>
              </div>
            </div>
            <div class="ntro-sidebar-content">
              <div class="ntro-sidebar-item" id="fontSizeItem">
                <div class="ntro-sidebar-icon" title="Font Size">
                  <span class="font-icon">Aa</span>
                </div>
                <div class="ntro-sidebar-control">
                  <input type="range" class="ntro-font-slider" id="fontSizeSlider" min="${minFontSize}" max="${maxFontSize}" step="1" value="${defaultFontSize}" title="Font Size">
                  <span class="ntro-font-size-value" id="fontSizeValue">${defaultFontSize}px</span>
                </div>
              </div>
              <div class="ntro-sidebar-item" id="listeningItem">
                <div class="ntro-sidebar-icon" title="Listening">
                  <svg width="20" height="20" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <path d="M10 3 C8.34 3 7 4.34 7 6 L7 10 C7 11.66 8.34 13 10 13 C11.66 13 13 11.66 13 10 L13 6 C13 4.34 11.66 3 10 3 Z" stroke="currentColor" stroke-width="2" fill="none"/>
                    <path d="M10 13 L10 16" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
                    <path d="M6 16 L14 16" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
                  </svg>
                </div>
                <div class="ntro-sidebar-label">Listening</div>
                <div class="ntro-sidebar-toggle-switch">
                  <input type="checkbox" id="listeningToggle" title="Toggle Listening">
                  <label for="listeningToggle" class="toggle-label"></label>
                </div>
              </div>
              <div class="ntro-sidebar-item">
                <div class="ntro-sidebar-icon" title="Opacity">
                  <svg width="20" height="20" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <circle cx="10" cy="10" r="8" stroke="currentColor" stroke-width="2" fill="none"/>
                    <path d="M10 2 L10 18 M2 10 L18 10" stroke="currentColor" stroke-width="2"/>
                  </svg>
                </div>
                <div class="ntro-sidebar-control">
                  <input type="range" class="ntro-opacity-slider" id="opacitySlider" min="${minOpacity}" max="${maxOpacity}" step="0.05" value="${defaultOpacity}" title="Opacity">
                </div>
              </div>
              <div class="ntro-sidebar-item" id="technicalInterviewItem">
                <div class="ntro-sidebar-icon" title="Technical Interview">
                  <svg width="20" height="20" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <rect x="3" y="3" width="14" height="14" rx="2" stroke="currentColor" stroke-width="2" fill="none"/>
                    <path d="M7 7 L13 7 M7 10 L13 10 M7 13 L11 13" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
                    <circle cx="15" cy="5" r="2" fill="currentColor"/>
                  </svg>
                </div>
                <div class="ntro-sidebar-label">Technical</div>
                <div class="ntro-sidebar-toggle-switch">
                  <input type="checkbox" id="technicalInterviewToggle" title="Toggle Technical Interview Mode">
                  <label for="technicalInterviewToggle" class="toggle-label"></label>
                </div>
              </div>
            </div>
          </div>

          <!-- Left Panel - AI Answers -->
          <div class="ntro-left-panel">
            <div class="ntro-header">
              <div class="ntro-controls">
                <button class="ntro-sidebar-toggle" id="sidebarToggleMain" title="Toggle Sidebar">☰</button>
              </div>
            </div>
            
            <div class="ntro-content">
              <div class="ntro-question-section" id="questionSectionLeft" style="display: none;">
                <div class="ntro-question-header">
                  <div class="ntro-question-label">Question:</div>
                  <button class="ntro-question-toggle" id="questionToggleBtn" title="Hide Question">▼</button>
                </div>
                <div class="ntro-question-content" id="questionContent">
                  <div class="ntro-question-text" id="extractedQuestion">Extracting question...</div>
                </div>
              </div>
              <div class="ntro-answer-section" id="answerSection">
                <div class="ntro-answer-label">Answer:</div>
                <div class="ntro-answer-text" id="aiAnswer">The answer will appear here...</div>
              </div>
            </div>

            <!-- Bottom Input Bar -->
            <div class="ntro-input-bar">
              <input type="text" class="ntro-input" id="quickPrompt" placeholder="Type or OCR quick prompt">
              <button class="ntro-help-btn" id="helpBtn">
                Help
              </button>
              <label class="ntro-checkbox-label">
                <input type="checkbox" id="hideConversation">
                Hide
              </label>
            </div>
            
            <!-- Bottom Toggle Bar - Interview Settings -->
            <div class="ntro-bottom-toggles">
              <div class="ntro-toggle-item" id="longerContextItem">
                <div class="ntro-toggle-icon" title="Longer Context">
                  <svg width="18" height="18" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <rect x="3" y="3" width="14" height="14" rx="2" stroke="currentColor" stroke-width="2" fill="none"/>
                    <path d="M7 7 L13 7 M7 10 L13 10 M7 13 L11 13" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
                  </svg>
                </div>
                <div class="ntro-toggle-label">Context <span class="ntro-hotkey">A</span></div>
                <div class="ntro-toggle-switch">
                  <input type="checkbox" id="longerContextToggle" title="Toggle Longer Context (A)">
                  <label for="longerContextToggle" class="toggle-label"></label>
                </div>
              </div>
              <div class="ntro-toggle-item" id="bulletModeItem">
                <div class="ntro-toggle-icon" title="Bullet Mode">
                  <svg width="18" height="18" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <line x1="4" y1="6" x2="16" y2="6" stroke="currentColor" stroke-width="2"/>
                    <circle cx="2" cy="6" r="1.5" fill="currentColor"/>
                    <line x1="4" y1="10" x2="16" y2="10" stroke="currentColor" stroke-width="2"/>
                    <circle cx="2" cy="10" r="1.5" fill="currentColor"/>
                    <line x1="4" y1="14" x2="16" y2="14" stroke="currentColor" stroke-width="2"/>
                    <circle cx="2" cy="14" r="1.5" fill="currentColor"/>
                  </svg>
                </div>
                <div class="ntro-toggle-label">Bullet <span class="ntro-hotkey">S</span></div>
                <div class="ntro-toggle-switch">
                  <input type="checkbox" id="bulletModeToggle" title="Toggle Bullet Mode (S)">
                  <label for="bulletModeToggle" class="toggle-label"></label>
                </div>
              </div>
              <div class="ntro-toggle-item" id="detailModeItem">
                <div class="ntro-toggle-icon" title="Detail Mode">
                  <svg width="18" height="18" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <rect x="3" y="3" width="14" height="14" rx="2" stroke="currentColor" stroke-width="2" fill="none"/>
                    <path d="M7 7 L13 7 M7 10 L13 10 M7 13 L11 13" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
                    <circle cx="15" cy="5" r="3" fill="#ff6b35"/>
                  </svg>
                </div>
                <div class="ntro-toggle-label">Detail <span class="ntro-hotkey">D</span></div>
                <div class="ntro-toggle-switch">
                  <input type="checkbox" id="detailModeToggle" title="Toggle Detail Mode (D)">
                  <label for="detailModeToggle" class="toggle-label"></label>
                </div>
              </div>
              <div class="ntro-toggle-item" id="webSearchItem">
                <div class="ntro-toggle-icon" title="Web Search">
                  <svg width="18" height="18" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <circle cx="9" cy="9" r="6" stroke="currentColor" stroke-width="2" fill="none"/>
                    <path d="M13 13 L17 17" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
                    <circle cx="9" cy="9" r="2" fill="currentColor"/>
                  </svg>
                </div>
                <div class="ntro-toggle-label">Search <span class="ntro-hotkey">F</span></div>
                <div class="ntro-toggle-switch">
                  <input type="checkbox" id="webSearchToggle" title="Toggle Web Search (F)">
                  <label for="webSearchToggle" class="toggle-label"></label>
                </div>
              </div>
            </div>
          </div>

          <!-- Right Panel - Chat History -->
          <div class="ntro-right-panel" id="rightPanel">
            <div class="ntro-content">
              <div class="ntro-question-section" id="questionSection">
                <div class="ntro-question-label">Chat History:</div>
                <div class="ntro-question-text" id="chatHistory">Waiting for conversation...</div>
              </div>
            </div>
          </div>
          <div class="ntro-resize-handle"></div>
        </div>
      </div>
      <button class="ntro-maximize-btn" id="maximizeBtn" title="Maximize"></button>
    `;

    document.body.appendChild(assistantUI);
    console.log('[CONTENTSCRIPT] UI injected into DOM');

    // Make question and answer sections selectable but read-only
    const chatHistoryElement = document.getElementById('chatHistory');
    const answerElement = document.getElementById('aiAnswer');
    
    const makeReadOnly = (element) => {
      if (element) {
        element.setAttribute('contenteditable', 'false');
        element.setAttribute('spellcheck', 'false');
        // Prevent any input/editing while allowing selection
        element.addEventListener('input', (e) => {
          e.preventDefault();
        });
        // Prevent paste
        element.addEventListener('paste', (e) => {
          e.preventDefault();
        });
        // Prevent drag and drop editing
        element.addEventListener('drop', (e) => {
          e.preventDefault();
        });
        element.addEventListener('dragover', (e) => {
          e.preventDefault();
        });
      }
    };
    
    makeReadOnly(chatHistoryElement);
    makeReadOnly(answerElement);

    // Setup event listeners
    setupEventListeners();
    
    // Setup drag and resize functionality
    setupDragAndResize();

    // Periodically update listening toggle state to reflect actual Whisper status
    setInterval(() => {
      updateListeningToggleState();
    }, 2000); // Check every 2 seconds
  } catch (error) {
    console.error('[CONTENTSCRIPT] Error injecting assistant UI:', error);
    throw error;
  }
}

// Settings state - use constants for defaults
let settings = {
  fontSize: CONSTANTS?.DEFAULT_FONT_SIZE || 16,
  bulletMode: false,
  detailMode: false,
  sidebarVisible: true,
  webSearchEnabled: false,
  longerContext: false,
  isTechnicalInterview: false
};

function setupEventListeners() {
  console.log('[CONTENTSCRIPT] Setting up event listeners');
  
  const closeBtn = document.getElementById('closeBtn');
  const maximizeBtn = document.getElementById('maximizeBtn');
  const helpBtn = document.getElementById('helpBtn');
  const quickPrompt = document.getElementById('quickPrompt');
  const hideCheckbox = document.getElementById('hideConversation');
  const opacitySlider = document.getElementById('opacitySlider');
  const fontSizeSlider = document.getElementById('fontSizeSlider');
  const fontSizeValue = document.getElementById('fontSizeValue');
  const bulletModeToggle = document.getElementById('bulletModeToggle');
  const detailModeToggle = document.getElementById('detailModeToggle');
  const webSearchToggle = document.getElementById('webSearchToggle');
  const longerContextToggle = document.getElementById('longerContextToggle');
  const technicalInterviewToggle = document.getElementById('technicalInterviewToggle');
  const sidebarToggleMain = document.getElementById('sidebarToggleMain');
  const questionToggleBtn = document.getElementById('questionToggleBtn');

  // Question section toggle
  questionToggleBtn?.addEventListener('click', () => {
    const questionContent = document.getElementById('questionContent');
    if (questionContent) {
      const isHidden = questionContent.style.display === 'none';
      questionContent.style.display = isHidden ? 'flex' : 'none';
      questionToggleBtn.textContent = isHidden ? '▼' : '▲';
      questionToggleBtn.title = isHidden ? 'Hide Question' : 'Show Question';
    }
  });

  closeBtn?.addEventListener('click', () => {
    console.log('[CONTENTSCRIPT] Close button clicked');
    stopAssistant();
  });

  // Sidebar toggle with icon change
  const toggleSidebar = () => {
    const sidebar = document.querySelector('.ntro-sidebar');
    const root = document.getElementById('ntro-assistant-root');
    if (sidebar && root) {
      settings.sidebarVisible = !settings.sidebarVisible;
      sidebar.classList.toggle('collapsed', !settings.sidebarVisible);
      // Update toggle button icon based on state (☰ when closed, ✕ when open)
      if (sidebarToggleMain) {
        sidebarToggleMain.textContent = settings.sidebarVisible ? '☰' : '>';
        sidebarToggleMain.title = settings.sidebarVisible ? 'Close Sidebar' : 'Open Sidebar';
      }
      chrome.storage.local.set({ sidebarVisible: settings.sidebarVisible });
    }
  };

  sidebarToggleMain?.addEventListener('click', toggleSidebar);

  // Font size slider
  fontSizeSlider?.addEventListener('input', (e) => {
    const size = parseInt(e.target.value);
    settings.fontSize = size;
    if (fontSizeValue) {
      fontSizeValue.textContent = `${size}px`;
    }
    applyFontSize(size);
    chrome.storage.local.set({ fontSize: size });
  });

  // Bullet mode toggle
  bulletModeToggle?.addEventListener('change', (e) => {
    settings.bulletMode = e.target.checked;
    applyBulletMode(e.target.checked);
    chrome.storage.local.set({ bulletMode: e.target.checked });
  });

  // Detail mode toggle
  detailModeToggle?.addEventListener('change', (e) => {
    settings.detailMode = e.target.checked;
    chrome.storage.local.set({ detailMode: e.target.checked });
    // Re-apply current answer with new detail mode if there's content
    const answerElement = document.getElementById('aiAnswer');
    if (answerElement && answerElement.textContent && answerElement.textContent !== 'The answer will appear here...') {
      // Note: This won't regenerate, but will apply formatting
      applyAnswerFormatting(answerElement.textContent);
    }
  });

  // Web search toggle
  webSearchToggle?.addEventListener('change', (e) => {
    settings.webSearchEnabled = e.target.checked;
    chrome.storage.local.set({ webSearchEnabled: e.target.checked });
    console.log('[CONTENTSCRIPT] Web search', e.target.checked ? 'enabled' : 'disabled');
  });

  // Longer context toggle
  longerContextToggle?.addEventListener('change', (e) => {
    settings.longerContext = e.target.checked;
    chrome.storage.local.set({ longerContext: e.target.checked });
    console.log('[CONTENTSCRIPT] Longer context', e.target.checked ? 'enabled' : 'disabled');
  });

  // Technical interview toggle
  technicalInterviewToggle?.addEventListener('change', async (e) => {
    const isTechnical = e.target.checked;
    console.log('[CONTENTSCRIPT] Technical interview mode', isTechnical ? 'enabled' : 'disabled');
    
    // Update session
    if (aiService && aiService.session) {
      aiService.session.isTechnicalInterview = isTechnical;
      await aiService.saveSession();
    }
    
    // Also store in chrome.storage.local for persistence
    chrome.storage.local.set({ isTechnicalInterview: isTechnical });
  });

  // Listening toggle
  const listeningToggle = document.getElementById('listeningToggle');
  listeningToggle?.addEventListener('change', async (e) => {
    const isEnabled = e.target.checked;
    console.log('[CONTENTSCRIPT] Listening toggle changed:', isEnabled);
    
    if (isEnabled) {
      await startWhisperListening();
    } else {
      await stopWhisperListening();
    }
  });

  // Click handlers for icon elements (one-time help with mode enabled)
  const bulletModeItem = document.getElementById('bulletModeItem');
  const detailModeItem = document.getElementById('detailModeItem');
  const webSearchItem = document.getElementById('webSearchItem');
  const longerContextItem = document.getElementById('longerContextItem');
  
  // Bullet mode icon click - trigger help with bullet mode temporarily enabled
  const bulletIcon = bulletModeItem?.querySelector('.ntro-toggle-icon');
  bulletIcon?.addEventListener('click', async (e) => {
    // Don't trigger if clicking on the toggle switch or its children
    if (e.target.closest('.ntro-toggle-switch') || bulletModeItem?.querySelector('.ntro-toggle-switch')?.contains(e.target)) {
      return;
    }
    e.stopPropagation();
    console.log('[CONTENTSCRIPT] Bullet mode icon clicked - triggering help with bullet mode');
    // Check if there's content in the OCR/tip textbox and add it to conversation history first
    await addQuickPromptToHistoryIfExists();
    // Temporarily enable bullet mode for this request only
    const originalBulletMode = settings.bulletMode;
    settings.bulletMode = true;
    await handleHelpRequest(false, false, null, false);
    // Restore original bullet mode setting (don't change the toggle)
    settings.bulletMode = originalBulletMode;
  });

  // Detail mode icon click - trigger help with detail mode temporarily enabled
  const detailIcon = detailModeItem?.querySelector('.ntro-toggle-icon');
  detailIcon?.addEventListener('click', async (e) => {
    // Don't trigger if clicking on the toggle switch or its children
    if (e.target.closest('.ntro-toggle-switch') || detailModeItem?.querySelector('.ntro-toggle-switch')?.contains(e.target)) {
      return;
    }
    e.stopPropagation();
    console.log('[CONTENTSCRIPT] Detail mode icon clicked - triggering help with detail mode');
    // Check if there's content in the OCR/tip textbox and add it to conversation history first
    await addQuickPromptToHistoryIfExists();
    // Temporarily enable detail mode for this request only
    const originalDetailMode = settings.detailMode;
    settings.detailMode = true;
    await handleHelpRequest(true, false, null, false);
    // Restore original detail mode setting (don't change the toggle)
    settings.detailMode = originalDetailMode;
  });

  // Web search icon click - trigger help with web search temporarily enabled
  const webSearchIcon = webSearchItem?.querySelector('.ntro-toggle-icon');
  webSearchIcon?.addEventListener('click', async (e) => {
    // Don't trigger if clicking on the toggle switch or its children
    if (e.target.closest('.ntro-toggle-switch') || webSearchItem?.querySelector('.ntro-toggle-switch')?.contains(e.target)) {
      return;
    }
    e.stopPropagation();
    console.log('[CONTENTSCRIPT] Web search icon clicked - triggering help with web search');
    // Check if there's content in the OCR/tip textbox and add it to conversation history first
    await addQuickPromptToHistoryIfExists();
    // Temporarily enable web search for this request only
    const originalWebSearch = settings.webSearchEnabled;
    settings.webSearchEnabled = true;
    await handleHelpRequest(false, true, null, true);
    // Restore original web search setting (don't change the toggle)
    settings.webSearchEnabled = originalWebSearch;
  });

  // Longer context icon click - trigger help with longer context temporarily enabled
  const longerContextIcon = longerContextItem?.querySelector('.ntro-toggle-icon');
  longerContextIcon?.addEventListener('click', async (e) => {
    // Don't trigger if clicking on the toggle switch or its children
    if (e.target.closest('.ntro-toggle-switch') || longerContextItem?.querySelector('.ntro-toggle-switch')?.contains(e.target)) {
      return;
    }
    e.stopPropagation();
    console.log('[CONTENTSCRIPT] Longer context icon clicked - triggering help with longer context');
    // Check if there's content in the OCR/tip textbox and add it to conversation history first
    await addQuickPromptToHistoryIfExists();
    // Temporarily enable longer context for this request only
    const originalLongerContext = settings.longerContext;
    settings.longerContext = true;
    await handleHelpRequest(false, false, null, false);
    // Restore original longer context setting (don't change the toggle)
    settings.longerContext = originalLongerContext;
  });

  // Opacity slider control
  opacitySlider?.addEventListener('input', (e) => {
    const root = document.getElementById('ntro-assistant-root');
    if (root) {
      const opacity = parseFloat(e.target.value);
      root.style.opacity = opacity;
      // Store opacity preference
      chrome.storage.local.set({ windowOpacity: opacity });
    }
  });

  // Load saved preferences
  chrome.storage.local.get(['windowOpacity', 'fontSize', 'bulletMode', 'detailMode', 'sidebarVisible', 'webSearchEnabled', 'longerContext'], (result) => {
    const root = document.getElementById('ntro-assistant-root');
    
    if (result.windowOpacity !== undefined) {
      const slider = document.getElementById('opacitySlider');
      if (root && slider) {
        root.style.opacity = result.windowOpacity;
        slider.value = result.windowOpacity;
      }
    }

    if (result.fontSize !== undefined) {
      settings.fontSize = result.fontSize;
      if (fontSizeSlider) fontSizeSlider.value = result.fontSize;
      if (fontSizeValue) fontSizeValue.textContent = `${result.fontSize}px`;
      applyFontSize(result.fontSize);
    } else {
      // Apply default font size
      applyFontSize(settings.fontSize);
    }

    if (result.bulletMode !== undefined) {
      settings.bulletMode = result.bulletMode;
      if (bulletModeToggle) bulletModeToggle.checked = result.bulletMode;
      applyBulletMode(result.bulletMode);
    }

    if (result.detailMode !== undefined) {
      settings.detailMode = result.detailMode;
      if (detailModeToggle) detailModeToggle.checked = result.detailMode;
    }

    if (result.sidebarVisible !== undefined) {
      settings.sidebarVisible = result.sidebarVisible;
      const sidebar = document.querySelector('.ntro-sidebar');
      const sidebarBtn = document.getElementById('sidebarToggleMain');
      if (sidebar) {
        sidebar.classList.toggle('collapsed', !result.sidebarVisible);
      }
      // Update toggle button icon based on loaded state
      if (sidebarBtn) {
        sidebarBtn.textContent = result.sidebarVisible ? '✕' : '☰';
        sidebarBtn.title = result.sidebarVisible ? 'Close Sidebar' : 'Open Sidebar';
      }
    }
    
    // Load web search setting
    if (result.webSearchEnabled !== undefined) {
      settings.webSearchEnabled = result.webSearchEnabled;
      if (webSearchToggle) {
        webSearchToggle.checked = settings.webSearchEnabled;
      }
    }

    // Load longer context setting
    if (result.longerContext !== undefined) {
      settings.longerContext = result.longerContext;
      if (longerContextToggle) {
        longerContextToggle.checked = settings.longerContext;
      }
    }

    // Load technical interview setting
    if (result.isTechnicalInterview !== undefined) {
      settings.isTechnicalInterview = result.isTechnicalInterview;
      if (technicalInterviewToggle) {
        technicalInterviewToggle.checked = settings.isTechnicalInterview;
      }
      // Also update session if available
      if (aiService && aiService.session) {
        aiService.session.isTechnicalInterview = settings.isTechnicalInterview;
      }
    } else {
      // Try to load from session
      chrome.storage.local.get(['currentSession'], (sessionResult) => {
        if (sessionResult.currentSession && sessionResult.currentSession.isTechnicalInterview !== undefined) {
          settings.isTechnicalInterview = sessionResult.currentSession.isTechnicalInterview;
          if (technicalInterviewToggle) {
            technicalInterviewToggle.checked = settings.isTechnicalInterview;
          }
        }
      });
    }

    // Update listening toggle state based on current Whisper status
    updateListeningToggleState();
  });

  // Right-click to hide the window
  const root = document.getElementById('ntro-assistant-root');
  if (root) {
    root.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      console.log('[CONTENTSCRIPT] Right-click detected, hiding window');
      root.classList.add('minimized');
    });
  }

  maximizeBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    console.log('[CONTENTSCRIPT] Maximize button clicked');
    const root = document.getElementById('ntro-assistant-root');
    if (root) {
      root.classList.remove('minimized');
      console.log('[CONTENTSCRIPT] Restored from minimized state');
    }
  });

  // Allow clicking on minimized container to restore
  const container = document.querySelector('.ntro-container');
  if (container) {
    container.addEventListener('click', (e) => {
      const root = document.getElementById('ntro-assistant-root');
      if (root && root.classList.contains('minimized')) {
        // Don't restore if clicking on buttons
        if (!e.target.closest('.ntro-control-btn')) {
          console.log('[CONTENTSCRIPT] Clicked minimized container, restoring');
          root.classList.remove('minimized');
        }
      }
    });
  }

  helpBtn?.addEventListener('click', async () => {
    console.log('[CONTENTSCRIPT] Help button clicked');
    // Check if there's content in the OCR/tip textbox and add it to conversation history first
    await addQuickPromptToHistoryIfExists();
    await handleHelpRequest(false); // Simple help by default
  });

  quickPrompt?.addEventListener('keydown', async (e) => {
    // Ctrl+Space or Cmd+Space handler - simple help with search model (recent context only)
    if (e.key === ' ' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      console.log('[CONTENTSCRIPT] Ctrl+Space pressed in quick prompt - triggering help with search model');
      await handleHelpRequest(false, true); // isDetailed=false, useSearchModel=true
      return;
    }
    
    if (e.key === 'Enter') {
      const prompt = quickPrompt.value.trim();
      if (e.ctrlKey || e.metaKey) {
        // Ctrl+Enter or Cmd+Enter - detailed help with search model (recent context only)
        e.preventDefault();
        if (prompt) {
          // Ensure the typed prompt is added to chat history for context
          aiService.addUserPrompt(prompt);
          // Save user prompt to session transcripts immediately
          await saveTranscript(prompt, 'user');
          appendChatHistoryEntry(`[You] ${prompt}`);
        }
        quickPrompt.value = ''; // Clear immediately
        console.log('[CONTENTSCRIPT] Ctrl+Enter pressed, triggering detailed help with search model');
        await handleHelpRequest(true, true, prompt || null, true); // isDetailed=true, useSearchModel=true, forceWebSearch=true
      } else {
        // Regular Enter
        quickPrompt.value = ''; // Clear immediately
        if (prompt) {
          console.log('[CONTENTSCRIPT] User prompt:', prompt);
          await handleUserPrompt(prompt);
        } else {
          // If input is empty, treat Enter as simple help request
          console.log('[CONTENTSCRIPT] Enter pressed with empty input, triggering simple help');
          await handleHelpRequest(false);
        }
      }
    }
  });

  // Hide conversation checkbox handler
  hideCheckbox?.addEventListener('change', (e) => {
    const rightPanel = document.getElementById('rightPanel');
    const root = document.getElementById('ntro-assistant-root');
    if (rightPanel && root) {
      const panelWidth = CONSTANTS?.PANEL_WIDTH || 300;
      const minWidth = CONSTANTS?.MIN_WINDOW_WIDTH || 400;
      const currentWidth = root.offsetWidth;
      
      if (e.target.checked) {
        // Collapse panel and reduce window width
        rightPanel.classList.add('collapsed');
        const newWidth = Math.max(minWidth, currentWidth - panelWidth);
        root.style.width = `${newWidth}px`;
      } else {
        // Expand panel and increase window width
        rightPanel.classList.remove('collapsed');
        root.style.width = `${currentWidth + panelWidth}px`;
      }
    }
  });

  // Hotkey handlers for toggles (A, S, D, F)
  document.addEventListener('keydown', (e) => {
    // Don't trigger if typing in input fields or textareas (unless quickPrompt is empty)
    const isInput = e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA';
    if (isInput) {
      // Only allow hotkeys in quickPrompt if it's empty and focused
      if (e.target.id !== 'quickPrompt' || (e.target.value && e.target.value.length > 0)) {
        return;
      }
    }
    
    // Don't trigger if modifier keys are pressed
    if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) {
      return;
    }
    
    // Hotkey: A - Toggle Longer Context
    if (e.key === 'a' || e.key === 'A') {
      e.preventDefault();
      e.stopPropagation();
      if (longerContextToggle) {
        longerContextToggle.checked = !longerContextToggle.checked;
        longerContextToggle.dispatchEvent(new Event('change'));
      }
      return;
    }
    
    // Hotkey: S - Toggle Bullet Mode
    if (e.key === 's' || e.key === 'S') {
      e.preventDefault();
      e.stopPropagation();
      if (bulletModeToggle) {
        bulletModeToggle.checked = !bulletModeToggle.checked;
        bulletModeToggle.dispatchEvent(new Event('change'));
      }
      return;
    }
    
    // Hotkey: D - Toggle Detail Mode
    if (e.key === 'd' || e.key === 'D') {
      e.preventDefault();
      e.stopPropagation();
      if (detailModeToggle) {
        detailModeToggle.checked = !detailModeToggle.checked;
        detailModeToggle.dispatchEvent(new Event('change'));
      }
      return;
    }
    
    // Hotkey: F - Toggle Web Search
    if (e.key === 'f' || e.key === 'F') {
      e.preventDefault();
      e.stopPropagation();
      if (webSearchToggle) {
        webSearchToggle.checked = !webSearchToggle.checked;
        webSearchToggle.dispatchEvent(new Event('change'));
      }
      return;
    }
  }, true); // Use capture phase to catch keys early
  
  // Space key for help (only when not typing in input fields)
  // Ctrl+Space or Cmd+Space for help with web search (same recent context, but uses search model)
  document.addEventListener('keydown', async (e) => {
    // Don't trigger if typing in input fields (except quickPrompt which is handled above)
    if (e.target.tagName === 'INPUT' && e.target.id !== 'quickPrompt') {
      return;
    }
    if (e.target.tagName === 'TEXTAREA') {
      return;
    }
    
    if (e.key === ' ' && e.target.tagName !== 'INPUT' && e.target.tagName !== 'TEXTAREA') {
      if (e.ctrlKey || e.metaKey) {
        // Ctrl+Space or Cmd+Space - simple help with search model (recent context only)
        e.preventDefault();
        console.log('[CONTENTSCRIPT] Ctrl+Space pressed, triggering help with search model');
        await triggerWhisperTranscriptionIfActive(false); // use same 30s audio as regular Space
        await handleHelpRequest(false, true); // isDetailed=false, useSearchModel=true
      } else {
        // Regular Space - simple help
        e.preventDefault();
        console.log('[CONTENTSCRIPT] Space key pressed, triggering simple help');
        await triggerWhisperTranscriptionIfActive(false); // cut to last 30s
        await handleHelpRequest(false);
      }
    }
  });
}

function handleTranscript(transcript, type, speaker) {
  if (!isAssistantActive) {
    console.log('[CONTENTSCRIPT] Ignoring transcript, assistant not active');
    return;
  }

  const speakerLabel = speaker === 'interviewer' ? '[Interviewer]' : speaker === 'user' ? '[You]' : '';
  const displayText = speakerLabel ? `${speakerLabel} ${transcript}` : transcript;
  
  console.log(`[CONTENTSCRIPT] Handling ${type} transcript from ${speaker || 'unknown'}:`, transcript);

  if (type !== 'interim') {
    appendChatHistoryEntry(displayText);
  }

  // Save transcript separately based on speaker
  saveTranscript(transcript, speaker);
  
  // Add to AI service for context (for help button)
  // Only add interviewer questions to context (user speech is their own answers)
  if (aiService && speaker === 'interviewer') {
    aiService.addCaption(transcript);
    console.log('[CONTENTSCRIPT] Added interviewer transcript to AI service context');
  }

  // Don't auto-generate answer - user must click Help Me! or press Enter/Space
  console.log('[CONTENTSCRIPT] Transcript saved, waiting for user to request help');
}

// Sync transcripts - replace entire history with current state from Google Meet
async function syncTranscripts(transcripts) {
  try {
    // Get current session
    const result = await chrome.storage.local.get(['currentSession']);
    if (!result.currentSession) {
      console.warn('[CONTENTSCRIPT] No current session found for syncing transcripts');
      return;
    }

    const session = result.currentSession;
    
    // Replace entire transcript history with current state
    session.transcripts = {
      interviewer: [...transcripts.interviewer],
      user: [...transcripts.user]
    };

    // Save updated session
    await chrome.storage.local.set({ currentSession: session });
    
    // Update AI service caption history
    if (aiService && aiService.syncCaptions) {
      // Sync captions, preserving first-seen timestamps
      aiService.syncCaptions(transcripts);
    }
    
    // Update the chat history UI with all current transcripts
    const chatHistoryElement = document.getElementById('chatHistory');
    if (chatHistoryElement) {
      chatHistoryElement.innerHTML = '';
      // Use the 'all' array if available (preserves order), otherwise combine and sort
      let allTranscripts;
      if (transcripts.all && Array.isArray(transcripts.all)) {
        // Use the pre-ordered array from captionService
        allTranscripts = transcripts.all;
      } else {
        // Fallback: combine and sort by timestamp
        allTranscripts = [
          ...transcripts.interviewer.map(t => ({ ...t, speaker: 'interviewer' })),
          ...transcripts.user.map(t => ({ ...t, speaker: 'user' }))
        ].sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
      }
      
      // Build display text with speaker labels
      const displayLines = allTranscripts.map(item => {
        const speaker = item.speaker || 'interviewer'; // Default to interviewer if not specified
        const speakerLabel = speaker === 'interviewer' ? '[Interviewer]' : speaker === 'user' ? '[You]' : '';
        return speakerLabel ? `${speakerLabel} ${item.text}` : item.text;
      });
      
      // Append to chat history
      if (displayLines.length > 0) {
        displayLines.forEach(line => appendChatHistoryEntry(line));
      } else {
        appendChatHistoryEntry('Waiting for conversation...', true);
      }
    }
    
    console.log(`[CONTENTSCRIPT] Synced transcripts: ${transcripts.interviewer.length} interviewer, ${transcripts.user.length} user`);
  } catch (error) {
    console.error('[CONTENTSCRIPT] Error syncing transcripts:', error);
  }
}

// Save transcripts separately by speaker
async function saveTranscript(transcript, speaker) {
  try {
    // Get current session
    const result = await chrome.storage.local.get(['currentSession']);
    if (!result.currentSession) {
      console.warn('[CONTENTSCRIPT] No current session found for saving transcript');
      return;
    }

    const session = result.currentSession;
    
    // Initialize transcript arrays if they don't exist
    if (!session.transcripts) {
      session.transcripts = {
        interviewer: [],
        user: []
      };
    }

    // Save transcript with timestamp
    const transcriptEntry = {
      text: transcript,
      timestamp: Date.now()
    };

    if (speaker === 'interviewer') {
      session.transcripts.interviewer.push(transcriptEntry);
    } else if (speaker === 'user') {
      session.transcripts.user.push(transcriptEntry);
    } else {
      // Unknown speaker - save to both or a general array
      console.warn('[CONTENTSCRIPT] Unknown speaker, saving to both arrays');
      session.transcripts.interviewer.push(transcriptEntry);
      session.transcripts.user.push(transcriptEntry);
    }

    // Save updated session
    await chrome.storage.local.set({ currentSession: session });
    console.log(`[CONTENTSCRIPT] Saved ${speaker || 'unknown'} transcript:`, transcript.substring(0, 50));
  } catch (error) {
    console.error('[CONTENTSCRIPT] Error saving transcript:', error);
  }
}

function appendChatHistoryEntry(text, isStatus = false) {
  const chatHistoryElement = document.getElementById('chatHistory');
  if (!chatHistoryElement) return;

  const entry = document.createElement('div');
  entry.className = 'ntro-chat-entry';
  if (isStatus) {
    entry.classList.add('ntro-chat-status');
  }
  entry.textContent = text;
  chatHistoryElement.appendChild(entry);
  chatHistoryElement.scrollTop = chatHistoryElement.scrollHeight;
}

function updateStatus(message) {
  appendChatHistoryEntry(message, true);
}

function cancelOngoingAnswer() {
  // Abort any in-flight AI response and clear the current answer display
  if (aiService && aiService.cancelOngoingResponse) {
    aiService.cancelOngoingResponse();
  }
  const answerElement = document.getElementById('aiAnswer');
  if (answerElement) {
    answerElement.innerHTML = '';
  }
  // Hide the question section when canceling
  const questionSection = document.getElementById('questionSectionLeft');
  if (questionSection) {
    questionSection.style.display = 'none';
  }
  const questionElement = document.getElementById('extractedQuestion');
  if (questionElement) {
    questionElement.textContent = '';
  }
}

// Helper function to add quickPrompt content to conversation history if it exists
async function addQuickPromptToHistoryIfExists() {
  const quickPrompt = document.getElementById('quickPrompt');
  if (!quickPrompt || !aiService) {
    return;
  }
  
  const prompt = quickPrompt.value.trim();
  if (prompt) {
    console.log('[CONTENTSCRIPT] Adding quickPrompt content to conversation history:', prompt);
    // Add the user prompt to conversation history
    aiService.addUserPrompt(prompt);
    
    // Save user prompt to session transcripts immediately
    await saveTranscript(prompt, 'user');
    
    // Append to chat history display
    appendChatHistoryEntry(`[You] ${prompt}`);
    
    // Clear the input
    quickPrompt.value = '';
  }
}

async function handleHelpRequest(isDetailed = false, useSearchModel = false, manualQuestion = null, forceWebSearch = false) {
  if (!aiService) {
    console.warn('[CONTENTSCRIPT] AI service not available for help request');
    return;
  }

  // If another answer is streaming, cancel it and clear the UI before starting
  cancelOngoingAnswer();

  // Use detail mode from settings if not explicitly set
  const useDetailMode = isDetailed || settings.detailMode;

  console.log('[CONTENTSCRIPT] Handling help request', useDetailMode ? '(detailed mode)' : '(simple mode)', useSearchModel ? 'with search model' : '');
  const answerElement = document.getElementById('aiAnswer');
  
  // Check if Whisper is active and trigger transcription before getting context
  await triggerWhisperTranscriptionIfActive();
  
  // Get the question from captions - always use recent context (last N seconds since last help)
  const seconds = CONSTANTS?.RECENT_CONTEXT_SECONDS || 30;
  const minutes = CONSTANTS?.RECENT_CONTEXT_MINUTES || (seconds / 60);
  console.log(`[CONTENTSCRIPT] Getting context - ${seconds} seconds since last help`);
  const recentContext = aiService.getRecentContext(minutes, true);
  let lastQuestion = recentContext.lastQuestion;
  let context = recentContext.context;
  
  // If user manually provided a question (e.g., via Ctrl+Enter), prefer it
  if (manualQuestion && manualQuestion.trim()) {
    lastQuestion = manualQuestion.trim();
  }

  // Use the last question as the prompt, context is used for understanding
  const prompt = lastQuestion && lastQuestion !== 'No new conversation since last help request.' && lastQuestion !== 'No recent conversation in the last few minutes.' && lastQuestion !== 'No conversation history available.'
    ? lastQuestion
    : 'Help me with the recent conversation context';
  
  console.log('[CONTENTSCRIPT] Last question:', prompt);
  console.log('[CONTENTSCRIPT] Context length:', context ? context.length : 0);
  
  // Show loading message
  answerElement.innerHTML = formatAnswerWithBullets('Analyzing context and generating answer...');
  applyFontSize(settings.fontSize);

  // Get question section elements and show "Extracting question..." initially
  const questionSection = document.getElementById('questionSectionLeft');
  const questionElement = document.getElementById('extractedQuestion');
  const questionContent = document.getElementById('questionContent');
  if (questionSection && questionElement) {
    questionElement.textContent = 'Extracting question...';
    questionSection.style.display = 'flex';
    if (questionContent) {
      questionContent.style.display = 'flex';
    }
  }

  try {
    let fullAnswer = '';
    
    // Determine if web search should be used
    const useWebSearch = forceWebSearch || useSearchModel || settings.webSearchEnabled;
    
    // Single GPT call - stream the answer
    const answer = await aiService.getContextAwareResponse(
      prompt, 
      context,
      useDetailMode, // detailed mode uses full resume/job description
      (chunk) => {
        // Stream chunks as they arrive
        fullAnswer += chunk;
        answerElement.innerHTML = formatAnswerWithBullets(fullAnswer);
        applyFontSize(settings.fontSize);
      },
      useWebSearch, // use search model if enabled or Ctrl+Space/Ctrl+Enter
      settings.bulletMode, // pass bullet mode to LLM
      settings.longerContext, // pass longer context setting
      (extractedQuestion) => {
        // Display the extracted question when it's available
        if (questionElement && extractedQuestion) {
          questionElement.textContent = extractedQuestion;
          if (questionSection) {
            questionSection.style.display = 'flex';
          }
          const questionContent = document.getElementById('questionContent');
          if (questionContent) {
            questionContent.style.display = 'flex';
          }
        }
      }
    );
    
    // Ensure final answer is displayed (in case streaming missed anything)
    if (fullAnswer.trim() !== answer.trim()) {
      answerElement.innerHTML = formatAnswerWithBullets(answer);
      applyFontSize(settings.fontSize);
    }
    console.log('[CONTENTSCRIPT] Help response received');
  } catch (error) {
    console.error('[CONTENTSCRIPT] Error getting help response:', error);
    answerElement.innerHTML = formatAnswerWithBullets(`Error: ${error.message}`);
    applyFontSize(settings.fontSize);
  }
}

async function handleUserPrompt(prompt) {
  if (!aiService) {
    console.warn('[CONTENTSCRIPT] AI service not available for user prompt');
    return;
  }

  // If another answer is streaming, cancel it and clear the UI before starting
  cancelOngoingAnswer();

  console.log('[CONTENTSCRIPT] Handling user prompt:', prompt);
  
  // Add the user prompt to conversation history
  aiService.addUserPrompt(prompt);
  
  // Save user prompt to session transcripts immediately
  await saveTranscript(prompt, 'user');
  
  const answerElement = document.getElementById('aiAnswer');
  const questionSection = document.getElementById('questionSectionLeft');
  const questionElement = document.getElementById('extractedQuestion');

  appendChatHistoryEntry(`[You] ${prompt}`);
  answerElement.innerHTML = formatAnswerWithBullets('Thinking...');
  applyFontSize(settings.fontSize);

  // Show "Extracting question..." initially
  const questionContent = document.getElementById('questionContent');
  if (questionSection && questionElement) {
    questionElement.textContent = 'Extracting question...';
    questionSection.style.display = 'flex';
    if (questionContent) {
      questionContent.style.display = 'flex';
    }
  }

  try {
    let fullAnswer = '';
    
    // Use streaming with chunk callback
    const answer = await aiService.getContextAwareResponse(
      prompt, 
      '', // no context for user prompts
      settings.detailMode, // use detail mode from settings
      (chunk) => {
        // Stream chunks as they arrive
        fullAnswer += chunk;
        answerElement.innerHTML = formatAnswerWithBullets(fullAnswer);
        applyFontSize(settings.fontSize);
      },
      settings.webSearchEnabled, // use web search if enabled
      settings.bulletMode, // pass bullet mode to LLM
      settings.longerContext, // pass longer context setting
      (extractedQuestion) => {
        // Display the extracted question when it's available
        if (questionElement && extractedQuestion) {
          questionElement.textContent = extractedQuestion;
          if (questionSection) {
            questionSection.style.display = 'flex';
          }
          const questionContent = document.getElementById('questionContent');
          if (questionContent) {
            questionContent.style.display = 'flex';
          }
        }
      }
    );
    
    // Ensure final answer is displayed
    if (fullAnswer.trim() !== answer.trim()) {
      answerElement.innerHTML = formatAnswerWithBullets(answer);
      applyFontSize(settings.fontSize);
    }
    console.log('[CONTENTSCRIPT] User prompt response received');
  } catch (error) {
    console.error('[CONTENTSCRIPT] Error getting user prompt response:', error);
    answerElement.innerHTML = formatAnswerWithBullets(`Error: ${error.message}`);
    applyFontSize(settings.fontSize);
  }
}

// Removed handleQuestion - answers are now only generated on user request (Help Me! button or Enter/Space)
// Kept isQuestion for potential future use, but it's not currently called
function isQuestion(text) {
  const questionWords = ['what', 'when', 'where', 'who', 'why', 'how', 'tell me', 'explain', 'describe'];
  const lowerText = text.toLowerCase();
  const isQ = questionWords.some(word => lowerText.includes(word)) || text.includes('?');
  console.log('[CONTENTSCRIPT] Is question?', isQ, 'for text:', text);
  return isQ;
}

// Start Whisper listening
async function startWhisperListening() {
  try {
    const captionService = window.__captionService;
    
    if (!captionService) {
      console.error('[CONTENTSCRIPT] CaptionService not available');
      updateListeningToggleState(false);
      return;
    }

    // Check if already active
    if (captionService.isWhisperActive && captionService.isWhisperActive()) {
      console.log('[CONTENTSCRIPT] Whisper already listening');
      updateListeningToggleState(true);
      return;
    }

    console.log('[CONTENTSCRIPT] Starting Whisper listening...');
    
    // Start Whisper fallback (this will request permissions)
    await captionService.startWhisperFallback();
    
    console.log('[CONTENTSCRIPT] Whisper listening started');
    updateListeningToggleState(true);
  } catch (error) {
    console.error('[CONTENTSCRIPT] Error starting Whisper listening:', error);
    updateListeningToggleState(false);
    
    // Show error to user
    const answerElement = document.getElementById('aiAnswer');
    if (answerElement) {
      answerElement.innerHTML = formatAnswerWithBullets(`Error starting listening: ${error.message}`);
      applyFontSize(settings.fontSize);
    }
  }
}

// Stop Whisper listening
async function stopWhisperListening() {
  try {
    const captionService = window.__captionService;
    
    if (!captionService) {
      console.log('[CONTENTSCRIPT] CaptionService not available');
      updateListeningToggleState(false);
      return;
    }

    // Check if already stopped
    if (!captionService.isWhisperActive || !captionService.isWhisperActive()) {
      console.log('[CONTENTSCRIPT] Whisper already stopped');
      updateListeningToggleState(false);
      return;
    }

    console.log('[CONTENTSCRIPT] Stopping Whisper listening...');
    
    // Stop Whisper recording
    if (captionService.whisperService) {
      await captionService.whisperService.stopRecording();
    }
    
    // Reset the flag
    if (captionService.useWhisperFallback !== undefined) {
      captionService.useWhisperFallback = false;
    }
    
    console.log('[CONTENTSCRIPT] Whisper listening stopped');
    updateListeningToggleState(false);
  } catch (error) {
    console.error('[CONTENTSCRIPT] Error stopping Whisper listening:', error);
    updateListeningToggleState(false);
  }
}

// Update listening toggle state based on current Whisper status
function updateListeningToggleState(forceState = null) {
  const listeningToggle = document.getElementById('listeningToggle');
  if (!listeningToggle) return;

  if (forceState !== null) {
    listeningToggle.checked = forceState;
    return;
  }

  // Check actual Whisper status
  const captionService = window.__captionService;
  const isActive = captionService?.isWhisperActive?.() || false;
  listeningToggle.checked = isActive;
}

// Trigger Whisper transcription if active (for platforms that don't have native captions)
async function triggerWhisperTranscriptionIfActive(useFullAudio = false) {
  try {
    // Get the captionService from the global window object (set by content.js)
    const captionService = window.__captionService;
    
    if (!captionService) {
      console.log('[CONTENTSCRIPT] No captionService available');
      return null;
    }
    
    // Check if Whisper is active
    if (!captionService.isWhisperActive || !captionService.isWhisperActive()) {
      console.log('[CONTENTSCRIPT] Whisper not active, using existing caption context');
      return null;
    }
    
    console.log('[CONTENTSCRIPT] Whisper is active, triggering transcription...');
    
    // Update UI to show transcription is in progress
    const answerElement = document.getElementById('aiAnswer');
    if (answerElement) {
      answerElement.innerHTML = formatAnswerWithBullets('Transcribing audio...');
    }
    
    // Trigger transcription
    const transcription = await captionService.triggerWhisperTranscription(useFullAudio);
    
    if (transcription && transcription.trim()) {
      console.log('[CONTENTSCRIPT] Whisper transcription received:', transcription.substring(0, 100) + '...');
      
      // Update the chat history with the transcription
      appendChatHistoryEntry(`[Transcription] ${transcription}`);
      
      // Save Whisper transcription to session transcripts (treat as interviewer speech by default)
      // Whisper transcribes tab audio which is primarily interviewer speech
      await saveTranscript(transcription, 'interviewer');
      
      // DIRECTLY add transcription to AI service's caption history
      // This ensures it's available immediately for getRecentContext()
      if (aiService) {
        aiService.addCaption(transcription);
        console.log('[CONTENTSCRIPT] Added transcription directly to AI service caption history');
      }
      
      return transcription;
    }
    
    console.log('[CONTENTSCRIPT] No new transcription from Whisper');
    return null;
  } catch (error) {
    console.error('[CONTENTSCRIPT] Error triggering Whisper transcription:', error);
    return null;
  }
}

// Get Whisper audio level for UI feedback (optional)
function getWhisperAudioLevel() {
  try {
    const captionService = window.__captionService;
    if (captionService && captionService.whisperService) {
      return captionService.whisperService.getCurrentAudioLevel();
    }
    return 0;
  } catch (error) {
    return 0;
  }
}

// Helper function to format bold text (**text** to <strong>text</strong>)
function formatBoldText(text) {
  if (!text) return '';
  // Escape HTML first, then convert **text** to <strong>text</strong>
  const escaped = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  return escaped.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
}

// Apply font size to answer text
function applyFontSize(size) {
  const answerElement = document.getElementById('aiAnswer');
  if (answerElement) {
    answerElement.style.fontSize = `${size}px`;
  }
}

// Apply bullet mode formatting
function applyBulletMode(enabled) {
  const answerElement = document.getElementById('aiAnswer');
  if (answerElement) {
    if (enabled) {
      answerElement.classList.add('bullet-mode');
    } else {
      answerElement.classList.remove('bullet-mode');
    }
  }
}

// Format answer with bullets if bullet mode is enabled
function formatAnswerWithBullets(text) {
  // Just format bold text - bullet formatting is done by LLM
  return formatBoldText(text);
}

// Apply answer formatting (font size, bullets, etc.)
function applyAnswerFormatting(text) {
  const answerElement = document.getElementById('aiAnswer');
  if (answerElement) {
    answerElement.innerHTML = formatAnswerWithBullets(text);
    applyFontSize(settings.fontSize);
  }
}

// Setup drag and resize functionality
function setupDragAndResize() {
  const root = document.getElementById('ntro-assistant-root');
  const header = document.querySelector('.ntro-header');
  const container = document.querySelector('.ntro-container');
  const resizeHandle = document.querySelector('.ntro-resize-handle');
  
  if (!root || !header || !container || !resizeHandle) {
    console.warn('[CONTENTSCRIPT] Could not find elements for drag/resize');
    return;
  }

  // Drag functionality
  let isDragging = false;
  let dragStartX = 0;
  let dragStartY = 0;
  let initialLeft = 0;
  let initialTop = 0;

  header.addEventListener('mousedown', (e) => {
    // Don't start drag if clicking on buttons or slider
    // Allow dragging on logo area (M icon and Mongtro text)
    if (e.target.closest('.ntro-control-btn') || e.target.closest('.ntro-opacity-slider')) {
      return;
    }
    
    isDragging = true;
    dragStartX = e.clientX;
    dragStartY = e.clientY;
    
    const rect = root.getBoundingClientRect();
    initialLeft = rect.left;
    initialTop = rect.top;
    
    e.preventDefault();
  });

  document.addEventListener('mousemove', (e) => {
    if (!isDragging) return;
    
    const deltaX = e.clientX - dragStartX;
    const deltaY = e.clientY - dragStartY;
    
    const newLeft = initialLeft + deltaX;
    const newTop = initialTop + deltaY;
    
    // Keep window within viewport bounds
    const maxLeft = window.innerWidth - root.offsetWidth;
    const maxTop = window.innerHeight - root.offsetHeight;
    
    root.style.left = `${Math.max(0, Math.min(newLeft, maxLeft))}px`;
    root.style.top = `${Math.max(0, Math.min(newTop, maxTop))}px`;
    root.style.right = 'auto';
    root.style.bottom = 'auto';
  });

  document.addEventListener('mouseup', () => {
    isDragging = false;
  });

  // Resize functionality
  let isResizing = false;
  let resizeStartX = 0;
  let resizeStartY = 0;
  let initialWidth = 0;
  let initialHeight = 0;

  resizeHandle.addEventListener('mousedown', (e) => {
    isResizing = true;
    resizeStartX = e.clientX;
    resizeStartY = e.clientY;
    
    const rect = root.getBoundingClientRect();
    initialWidth = rect.width;
    initialHeight = rect.height;
    
    e.preventDefault();
    e.stopPropagation();
  });

  document.addEventListener('mousemove', (e) => {
    if (!isResizing) return;
    
    const deltaX = e.clientX - resizeStartX;
    const deltaY = e.clientY - resizeStartY;
    
    const newWidth = initialWidth + deltaX;
    const newHeight = initialHeight + deltaY;
    
    // Minimum size constraints
    const minWidth = CONSTANTS?.MIN_WINDOW_WIDTH || 400;
    const minHeight = CONSTANTS?.MIN_WINDOW_HEIGHT || 300;
    
    root.style.width = `${Math.max(minWidth, newWidth)}px`;
    root.style.height = `${Math.max(minHeight, newHeight)}px`;
  });

  document.addEventListener('mouseup', () => {
    isResizing = false;
  });
}

console.log('[CONTENTSCRIPT] Script initialization complete');
