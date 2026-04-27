// Caption service for extracting transcripts from video conferencing platforms
// Supports:
// - Google Meet: Extracts captions from DOM
// - Microsoft Teams: Extracts captions from DOM  
// - Whisper AI: Fallback for other platforms - captures tab audio and transcribes with OpenAI Whisper
//   - Transcription triggered on Space/Ctrl+Space or silence detection

class CaptionService {
  constructor() {
    this.isMonitoring = false;
    this.monitoringInterval = null;
    this.lastFullTranscript = ''; // Track the last full transcript to detect changes
    this.transcriptHistory = {
      interviewer: [],
      user: []
    };
    this.audioService = null; // AudioService instance for Whisper fallback (legacy)
    this.whisperService = null; // WhisperService instance for on-demand transcription
    this.useWhisperFallback = false; // Flag to indicate if using Whisper
  }

  async initialize() {
    console.log('[CAPTIONSERVICE] Initialized');
    
    // Try to initialize WhisperService for on-demand transcription
    await this.ensureWhisperService();
  }

  async ensureWhisperService() {
    // If WhisperService is already initialized, return
    if (this.whisperService) {
      return true;
    }

    // Retry loading WhisperService with exponential backoff
    const maxRetries = CONSTANTS?.WHISPER_SERVICE_MAX_RETRIES || 20;
    const initialDelay = CONSTANTS?.WHISPER_SERVICE_INITIAL_DELAY || 100;
    const maxDelay = CONSTANTS?.WHISPER_SERVICE_MAX_DELAY || 2000;
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      // Check if WhisperService class is available
      if (typeof WhisperService !== 'undefined') {
        console.log(`[CAPTIONSERVICE] WhisperService class found on attempt ${attempt}`);
        break;
      }
      
      // Calculate delay with exponential backoff (100ms, 200ms, 400ms, ... capped at 2000ms)
      const delay = Math.min(initialDelay * Math.pow(1.5, attempt - 1), maxDelay);
      console.warn(`[CAPTIONSERVICE] WhisperService class not found. Attempt ${attempt}/${maxRetries}. Retrying in ${Math.round(delay)}ms...`);
      
      await new Promise(resolve => setTimeout(resolve, delay));
      
      if (attempt === maxRetries && typeof WhisperService === 'undefined') {
        console.error('[CAPTIONSERVICE] WhisperService class not found after all retries.');
        console.error('[CAPTIONSERVICE] Make sure whisperService.js is loaded in manifest.json');
        return false;
      }
    }

    try {
      this.whisperService = new WhisperService();
      await this.whisperService.initialize();
      
      // Check if API key is configured
      if (!this.whisperService.openaiApiKey) {
        console.warn('[CAPTIONSERVICE] WhisperService initialized but OpenAI API key is not configured.');
        console.warn('[CAPTIONSERVICE] Please configure OpenAI API key in extension settings to use Whisper.');
      }
      
      // Set up transcription callback
      this.whisperService.setOnTranscription((transcript) => {
        this.processWhisperTranscript(transcript, 'interviewer');
      });
      
      // Set up silence detection callback
      this.whisperService.setOnSilenceDetected(() => {
        console.log('[CAPTIONSERVICE] Silence detected, transcription will be triggered');
      });
      
      console.log('[CAPTIONSERVICE] WhisperService initialized for on-demand transcription');
      return true;
    } catch (error) {
      console.warn('[CAPTIONSERVICE] Failed to initialize WhisperService:', error);
      this.whisperService = null;
      return false;
    }
  }

  // Legacy method for backward compatibility
  async ensureAudioService() {
    return this.ensureWhisperService();
  }

  async startMonitoring() {
    if (this.isMonitoring) {
      console.log('[CAPTIONSERVICE] Already monitoring');
      return;
    }

    console.log('[CAPTIONSERVICE] Starting caption monitoring...');
    console.log('[CAPTIONSERVICE] Current URL:', window.location.href);
    console.log('[CAPTIONSERVICE] Hostname:', window.location.hostname);
    this.isMonitoring = true;
    this.lastFullTranscript = '';

    // Check which platform we're on
    const isGM = this.isGoogleMeet();
    const isT = this.isTeams();
    
    console.log('[CAPTIONSERVICE] Platform detection - Google Meet:', isGM, ', Teams:', isT);
    
    if (isGM) {
      console.log('[CAPTIONSERVICE] Detected: Google Meet - using caption extraction');
      this.startGoogleMeetMonitoring();
    } else if (isT) {
      console.log('[CAPTIONSERVICE] Detected: Microsoft Teams - using caption extraction');
      this.startTeamsMonitoring();
    } else {
      // Fallback to Whisper AI for other platforms (Zoom, Webex, etc.)
      console.log('[CAPTIONSERVICE] Detected: Other platform (Zoom, Webex, etc.) - using Whisper AI');
      await this.startWhisperFallback();
    }
  }

  isGoogleMeet() {
    // Check if we're on Google Meet
    const isGM = window.location.hostname.includes('meet.google.com');
    return isGM;
  }

  isTeams() {
    // Check if we're on Microsoft Teams
    // Be more specific to avoid matching other URLs with "teams" in them
    const hostname = window.location.hostname.toLowerCase();
    const isTeams = hostname.includes('teams.microsoft.com') || 
                    hostname.includes('teams.live.com') ||
                    (hostname.includes('microsoft') && window.location.href.includes('/teams'));
    return isTeams;
  }

  startGoogleMeetMonitoring() {
    console.log('[CAPTIONSERVICE] Starting Google Meet caption monitoring');
    
    // Monitor captions at configured interval for real-time updates
    const interval = CONSTANTS?.CAPTION_MONITORING_INTERVAL || 300;
    this.monitoringInterval = setInterval(() => {
      this.extractGoogleMeetCaptions();
    }, interval);
  }

  startTeamsMonitoring() {
    console.log('[CAPTIONSERVICE] Starting Microsoft Teams caption monitoring');
    
    // Monitor captions at configured interval for real-time updates
    const interval = CONSTANTS?.CAPTION_MONITORING_INTERVAL || 300;
    this.monitoringInterval = setInterval(() => {
      this.extractTeamsCaptions();
    }, interval);
  }

  extractTeamsCaptions() {
    try {
      // Find the captions container with data-tid="closed-caption-v2-virtual-list-content"
      const captionsContainer = document.querySelector('[data-tid="closed-caption-v2-virtual-list-content"]');
      
      if (!captionsContainer) {
        // Captions might not be enabled or visible yet
        return;
      }

      // Find all message containers - each .fui-ChatMessageCompact contains one caption message
      const messageContainers = captionsContainer.querySelectorAll('.fui-ChatMessageCompact');
      
      if (messageContainers.length === 0) {
        return;
      }

      // Build the full transcript from all captions
      let fullTranscript = '';
      const allTranscripts = []; // Keep all transcripts in order
      const seenMessages = new Set(); // Track seen messages to avoid duplicates

      // Process each message container and build full transcript
      messageContainers.forEach((messageContainer, index) => {
        try {
          // Get the caption text element
          const textElement = messageContainer.querySelector('[data-tid="closed-caption-text"]');
          if (!textElement) {
            return;
          }

          const text = textElement.textContent.trim();
          
          if (!text) {
            return;
          }

          // Get the speaker name from the author element
          let speakerName = 'Unknown';
          const authorElement = messageContainer.querySelector('[data-tid="author"]');
          if (authorElement) {
            speakerName = authorElement.textContent.trim();
          }

          // Create a unique key for this message to avoid duplicates
          // Use speaker name + text + index to handle cases where same text appears multiple times
          const messageKey = `${speakerName}:${text}:${index}`;
          if (seenMessages.has(messageKey)) {
            return; // Skip duplicate
          }
          seenMessages.add(messageKey);

          // Determine if it's the user or interviewer
          // In Teams, we can't easily determine the current user, so we'll use a heuristic
          const speakerNameLower = speakerName.toLowerCase();
          const isUser = speakerNameLower === 'you' || 
                        speakerNameLower.includes('you') ||
                        this.isCurrentUserTeams(messageContainer);

          const speaker = isUser ? 'user' : 'interviewer';
          
          // Store transcript with speaker info and order
          allTranscripts.push({
            speaker: speaker,
            speakerName: speakerName,
            text: text,
            order: index // Preserve DOM order
          });

          // Build full transcript string for comparison
          fullTranscript += `${speakerName}: ${text}\n`;
        } catch (entryError) {
          console.error('[CAPTIONSERVICE] Error processing Teams caption entry:', entryError);
        }
      });

      // If transcript hasn't changed, skip
      if (fullTranscript === this.lastFullTranscript) {
        return;
      }

      // Update last full transcript
      this.lastFullTranscript = fullTranscript;

      // Build the current state of all transcripts by speaker, preserving order
      const currentTranscripts = {
        interviewer: [],
        user: [],
        all: [] // Keep all in order for UI display
      };

      allTranscripts.forEach((item) => {
        const transcriptEntry = {
          text: item.text,
          timestamp: Date.now(),
          speakerName: item.speakerName,
          order: item.order
        };
        
        currentTranscripts[item.speaker].push(transcriptEntry);
        currentTranscripts.all.push({
          ...transcriptEntry,
          speaker: item.speaker
        });
      });

      // Sort all transcripts by order to preserve DOM order
      currentTranscripts.all.sort((a, b) => a.order - b.order);

      // Update local history (for getTranscriptHistory)
      this.transcriptHistory = {
        interviewer: [...currentTranscripts.interviewer],
        user: [...currentTranscripts.user]
      };

      // Send full current state to sync (not individual updates)
      chrome.runtime.sendMessage({
        action: 'syncTranscripts',
        transcripts: currentTranscripts
      }, (response) => {
        if (chrome.runtime.lastError) {
          console.error('[CAPTIONSERVICE] Error sending sync message:', chrome.runtime.lastError);
        }
      });

      console.log(`[CAPTIONSERVICE] Synced ${allTranscripts.length} Teams caption(s)`);

    } catch (error) {
      console.error('[CAPTIONSERVICE] Error extracting Teams captions:', error);
    }
  }

  isCurrentUserTeams(messageContainer) {
    // Try to determine if this is the current user in Teams
    // This is a heuristic - might need adjustment based on actual Teams structure
    // For now, we'll rely primarily on the "You" text check
    return false;
  }

  extractGoogleMeetCaptions() {
    try {
      // Find the captions container with aria-label="Captions"
      const captionsContainer = document.querySelector('[aria-label="Captions"]');
      
      if (!captionsContainer) {
        // Captions might not be enabled or visible yet
        return;
      }

      // Find all caption entries
      // Each entry is in a div with class "nMcdL" containing speaker info and text
      const captionEntries = captionsContainer.querySelectorAll('.nMcdL.bj4p3b');
      
      if (captionEntries.length === 0) {
        return;
      }

      // Build the full transcript from all captions
      let fullTranscript = '';
      const allTranscripts = []; // Keep all transcripts in order

      // Process each caption entry and build full transcript
      captionEntries.forEach((entry, index) => {
        try {
          // Get speaker name from .NWpY1d span
          const speakerElement = entry.querySelector('.NWpY1d');
          // Get caption text from .ygicle.VbkSUe div
          const textElement = entry.querySelector('.ygicle.VbkSUe');
          
          if (!speakerElement || !textElement) {
            return;
          }

          const speakerName = speakerElement.textContent.trim();
          const text = textElement.textContent.trim();
          
          if (!text) {
            return;
          }

          // Determine if it's the user or interviewer
          // In Google Meet, "You" typically refers to the current user
          const speakerNameLower = speakerName.toLowerCase();
          const isUser = speakerNameLower === 'you' || 
                        speakerNameLower.includes('you') ||
                        this.isCurrentUser(entry);

          const speaker = isUser ? 'user' : 'interviewer';
          
          // Store transcript with speaker info and order
          allTranscripts.push({
            speaker: speaker,
            speakerName: speakerName,
            text: text,
            order: index // Preserve DOM order
          });

          // Build full transcript string for comparison
          fullTranscript += `${speakerName}: ${text}\n`;
        } catch (entryError) {
          console.error('[CAPTIONSERVICE] Error processing caption entry:', entryError);
        }
      });

      // If transcript hasn't changed, skip
      if (fullTranscript === this.lastFullTranscript) {
        return;
      }

      // Update last full transcript
      this.lastFullTranscript = fullTranscript;

      // Build the current state of all transcripts by speaker, preserving order
      const currentTranscripts = {
        interviewer: [],
        user: [],
        all: [] // Keep all in order for UI display
      };

      allTranscripts.forEach((item) => {
        const transcriptEntry = {
          text: item.text,
          timestamp: Date.now(),
          speakerName: item.speakerName,
          order: item.order
        };
        
        currentTranscripts[item.speaker].push(transcriptEntry);
        currentTranscripts.all.push({
          ...transcriptEntry,
          speaker: item.speaker
        });
      });

      // Sort all transcripts by order to preserve DOM order
      currentTranscripts.all.sort((a, b) => a.order - b.order);

      // Update local history (for getTranscriptHistory)
      this.transcriptHistory = {
        interviewer: [...currentTranscripts.interviewer],
        user: [...currentTranscripts.user]
      };

      // Send full current state to sync (not individual updates)
      chrome.runtime.sendMessage({
        action: 'syncTranscripts',
        transcripts: currentTranscripts
      }, (response) => {
        if (chrome.runtime.lastError) {
          console.error('[CAPTIONSERVICE] Error sending sync message:', chrome.runtime.lastError);
        }
      });

      console.log(`[CAPTIONSERVICE] Synced ${allTranscripts.length} caption(s)`);

    } catch (error) {
      console.error('[CAPTIONSERVICE] Error extracting captions:', error);
    }
  }

  isCurrentUser(entryElement) {
    // Try to determine if this is the current user
    // In Google Meet, the user's own name might be displayed differently
    // We can check if the element has specific classes or attributes
    
    // Check if there's an image with the user's profile
    const img = entryElement?.querySelector('img');
    if (img) {
      // The current user's image might have specific attributes
      // This is a heuristic - might need adjustment based on actual Google Meet structure
      // For now, we rely primarily on the "You" text check
      return false; // Default to false, let the "You" check handle it
    }
    
    return false;
  }

  async startWhisperFallback() {
    console.log('[CAPTIONSERVICE] ===== Starting Whisper Fallback =====');
    
    // Try to ensure WhisperService is initialized (lazy initialization)
    const whisperServiceAvailable = await this.ensureWhisperService();
    
    console.log('[CAPTIONSERVICE] WhisperService available:', whisperServiceAvailable);
    console.log('[CAPTIONSERVICE] WhisperService instance:', !!this.whisperService);
    console.log('[CAPTIONSERVICE] API key configured:', !!this.whisperService?.openaiApiKey);
    
    if (!whisperServiceAvailable || !this.whisperService) {
      console.error('[CAPTIONSERVICE] WhisperService not available. Cannot use Whisper fallback.');
      console.warn('[CAPTIONSERVICE] Possible reasons:');
      console.warn('[CAPTIONSERVICE] 1. whisperService.js not loaded (check manifest.json)');
      console.warn('[CAPTIONSERVICE] 2. WhisperService initialization failed');
      this.isMonitoring = false;
      return;
    }

    try {
      // If already recording, stop first to reset and request permission again
      if (this.whisperService.getIsRecording()) {
        console.log('[CAPTIONSERVICE] WhisperService was already recording, stopping first...');
        await this.whisperService.stopRecording();
      }
      
      console.log('[CAPTIONSERVICE] Starting Whisper AI audio transcription (on-demand mode)...');
      console.log('[CAPTIONSERVICE] A permission dialog should appear to select screen/tab to share...');
      this.useWhisperFallback = true;
      
      // Start continuous recording with WhisperService
      // Transcription will be triggered by:
      // 1. User pressing Space or Ctrl+Space (via triggerWhisperTranscription)
      // 2. Silence detection (automatic)
      await this.whisperService.startRecording();
      
      console.log('[CAPTIONSERVICE] ===== Whisper Recording Started Successfully =====');
      console.log('[CAPTIONSERVICE] Audio is being captured. Press Space or Ctrl+Space to transcribe.');
    } catch (error) {
      console.error('[CAPTIONSERVICE] ===== Error starting Whisper fallback =====');
      console.error('[CAPTIONSERVICE] Error:', error.message);
      
      if (error.message && error.message.includes('permission')) {
        console.warn('[CAPTIONSERVICE] User may have cancelled the permission dialog or permission was blocked');
      }
      
      this.isMonitoring = false;
      this.useWhisperFallback = false;
      throw error;
    }
  }

  // Trigger transcription on demand (called from contentScript when Space/Ctrl+Space is pressed)
  async triggerWhisperTranscription(useFullAudio = false) {
    if (!this.useWhisperFallback || !this.whisperService) {
      console.log('[CAPTIONSERVICE] Whisper not active, skipping transcription trigger');
      return null;
    }

    console.log('[CAPTIONSERVICE] Triggering on-demand Whisper transcription...');
    
    try {
      const transcription = await this.whisperService.transcribeNow(useFullAudio);
      
      if (transcription && transcription.trim()) {
        console.log('[CAPTIONSERVICE] On-demand transcription received:', transcription.substring(0, 100));
        // processWhisperTranscript will be called via the callback set in ensureWhisperService
        return transcription;
      }
      
      return null;
    } catch (error) {
      console.error('[CAPTIONSERVICE] Error triggering Whisper transcription:', error);
      return null;
    }
  }

  // Get WhisperService instance (for external access if needed)
  getWhisperService() {
    return this.whisperService;
  }

  // Check if Whisper is active
  isWhisperActive() {
    return this.useWhisperFallback && this.whisperService && this.whisperService.getIsRecording();
  }

  setupWhisperTranscriptListener() {
    // Legacy method - transcriptions are now handled via callbacks set in ensureWhisperService
    console.log('[CAPTIONSERVICE] Whisper transcript listener set up (using callback mode)');
  }

  processWhisperTranscript(transcript, speaker) {
    if (!transcript || !transcript.trim()) {
      return;
    }

    // Process Whisper transcriptions similar to caption extraction
    // Since Whisper transcribes all audio from the tab, we treat it as interviewer speech
    // (the tab audio contains both interviewer and user, but we can't easily separate them)
    // For now, we'll treat all tab audio as interviewer speech
    const speakerType = speaker === 'user' ? 'user' : 'interviewer';
    
    // Build transcript entry
    const transcriptEntry = {
      text: transcript.trim(),
      timestamp: Date.now(),
      speakerName: speakerType === 'user' ? 'You' : 'Speaker',
      order: this.transcriptHistory[speakerType].length
    };

    // Update local history
    this.transcriptHistory[speakerType].push(transcriptEntry);

    // Build current transcripts state
    const currentTranscripts = {
      interviewer: [...this.transcriptHistory.interviewer],
      user: [...this.transcriptHistory.user],
      all: []
    };

    // Combine all transcripts in order
    const allTranscripts = [
      ...this.transcriptHistory.interviewer.map(t => ({ ...t, speaker: 'interviewer' })),
      ...this.transcriptHistory.user.map(t => ({ ...t, speaker: 'user' }))
    ].sort((a, b) => a.timestamp - b.timestamp);

    currentTranscripts.all = allTranscripts;

    // Send sync message
    chrome.runtime.sendMessage({
      action: 'syncTranscripts',
      transcripts: currentTranscripts
    }, (response) => {
      if (chrome.runtime.lastError) {
        console.error('[CAPTIONSERVICE] Error sending sync message:', chrome.runtime.lastError);
      }
    });

    console.log(`[CAPTIONSERVICE] Processed Whisper transcript (${speakerType}):`, transcript.substring(0, 50));
  }

  async stopMonitoring() {
    if (!this.isMonitoring) {
      return;
    }

    console.log('[CAPTIONSERVICE] Stopping caption monitoring...');
    this.isMonitoring = false;

    if (this.monitoringInterval) {
      clearInterval(this.monitoringInterval);
      this.monitoringInterval = null;
    }

    // Stop Whisper if it was being used
    if (this.useWhisperFallback && this.whisperService) {
      try {
        await this.whisperService.stopRecording();
        console.log('[CAPTIONSERVICE] Whisper recording stopped');
      } catch (error) {
        console.error('[CAPTIONSERVICE] Error stopping Whisper recording:', error);
      }
      this.useWhisperFallback = false;
    }

    this.lastFullTranscript = '';
    console.log('[CAPTIONSERVICE] Monitoring stopped');
  }

  getTranscriptHistory() {
    return {
      interviewer: [...this.transcriptHistory.interviewer],
      user: [...this.transcriptHistory.user]
    };
  }
}

