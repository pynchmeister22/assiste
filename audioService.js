// Audio service for capturing and transcribing tab audio using OpenAI Whisper API

class AudioService {
  constructor() {
    this.tabAudioStream = null;
    this.microphoneStream = null;
    this.tabAudioContext = null;
    this.microphoneAudioContext = null;
    this.tabMediaRecorder = null;
    this.microphoneMediaRecorder = null;
    this.isRecording = false;
    this.openaiApiKey = null;
    this.recordingInterval = null;
    this.audioChunkDuration = CONSTANTS?.AUDIO_CHUNK_DURATION || 8000; // 8 seconds chunks for better transcription quality
    this.transcriptionInterval = null;
    this.lastTranscriptionTime = 0;
    this.tabAudioChunks = [];
    this.microphoneAudioChunks = [];
    this.accumulatedTabChunks = []; // Accumulate chunks for longer segments
    this.accumulatedMicrophoneChunks = [];
    this.transcriptHistory = {
      interviewer: [],
      user: []
    };
  }

  async initialize() {
    // Get OpenAI API key from storage
    return new Promise((resolve) => {
      chrome.storage.local.get(['openaiApiKey', 'token'], async (result) => {
        if (result.openaiApiKey) {
          try {
            // Try to decrypt if encrypted
            this.openaiApiKey = await this.decrypt(result.openaiApiKey, result.token);
          } catch (error) {
            // Use as plain text if decryption fails
            this.openaiApiKey = result.openaiApiKey;
          }
        }
        resolve();
      });
    });
  }

  // Helper function to get a supported audio-only MIME type
  getSupportedAudioMimeType() {
    // Try different audio MIME types in order of preference
    const mimeTypes = [
      'audio/webm;codecs=opus',
      'audio/webm',
      'audio/ogg;codecs=opus',
      'audio/ogg',
      'audio/mp4',
      'audio/mpeg',
      '' // Empty string means browser default
    ];

    for (const mimeType of mimeTypes) {
      if (!mimeType || MediaRecorder.isTypeSupported(mimeType)) {
        console.log(`[AUDIOSERVICE] Using MIME type: ${mimeType || 'browser default'}`);
        return mimeType;
      }
    }

    // Fallback to empty string (browser default)
    console.warn('[AUDIOSERVICE] No specific audio MIME type supported, using browser default');
    return '';
  }

  // Use shared decrypt utility if available, otherwise fallback to local implementation
  async decrypt(encryptedText, token) {
    if (typeof decrypt === 'function') {
      return await decrypt(encryptedText, token);
    }
    
    // Fallback to local implementation
    try {
      const decoder = new TextDecoder();
      const encoder = new TextEncoder();
      
      const combined = new Uint8Array(
        atob(encryptedText)
          .split('')
          .map(c => c.charCodeAt(0))
      );
      
      const iv = combined.slice(0, 12);
      const encrypted = combined.slice(12);
      
      if (!token) {
        return decodeURIComponent(escape(atob(encryptedText)));
      }
      
      const keyMaterial = await crypto.subtle.importKey(
        'raw',
        encoder.encode(token.substring(0, 32).padEnd(32, '0')),
        { name: 'PBKDF2' },
        false,
        ['deriveBits', 'deriveKey']
      );
      
      const salt = encoder.encode('autobidder-salt-2024');
      const key = await crypto.subtle.deriveKey(
        {
          name: 'PBKDF2',
          salt: salt,
          iterations: 100000,
          hash: 'SHA-256'
        },
        keyMaterial,
        { name: 'AES-GCM', length: 256 },
        false,
        ['decrypt']
      );
      
      const decrypted = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: iv },
        key,
        encrypted
      );
      
      return decoder.decode(decrypted);
    } catch (error) {
      console.error('[AUDIOSERVICE] Decryption error:', error);
      try {
        return decodeURIComponent(escape(atob(encryptedText)));
      } catch (e) {
        return encryptedText;
      }
    }
  }

  async startRecording(tabId) {
    if (this.isRecording) {
      console.log('[AUDIOSERVICE] Already recording');
      return;
    }

    if (!this.openaiApiKey) {
      throw new Error('OpenAI API key not set');
    }

    console.log('[AUDIOSERVICE] Starting audio recording...');
    this.isRecording = true;

    try {
      // Capture tab audio
      await this.captureTabAudio(tabId);
      
      // Capture microphone audio (user's speech)
      await this.captureMicrophoneAudio();

      // Start periodic transcription
      this.startPeriodicTranscription();
    } catch (error) {
      console.error('[AUDIOSERVICE] Error starting recording:', error);
      this.isRecording = false;
      throw error;
    }
  }

  async startRecordingTabOnly(tabId) {
    // Start recording with only tab audio (no microphone)
    // This is used as a fallback when captions are not available
    if (this.isRecording) {
      console.log('[AUDIOSERVICE] Already recording');
      return;
    }

    if (!this.openaiApiKey) {
      throw new Error('OpenAI API key not set');
    }

    console.log('[AUDIOSERVICE] Starting tab-only audio recording for Whisper fallback...');
    this.isRecording = true;

    try {
      // Capture tab audio only
      await this.captureTabAudio(tabId);
      
      // Don't capture microphone - we only want tab audio
      // Start periodic transcription
      this.startPeriodicTranscription();
    } catch (error) {
      console.error('[AUDIOSERVICE] Error starting tab-only recording:', error);
      this.isRecording = false;
      throw error;
    }
  }

  async captureTabAudio(tabId) {
    try {
      console.log('[AUDIOSERVICE] Requesting display media for tab audio capture');
      
      // Use getDisplayMedia API - this will prompt user to select tab/window to share
      // This works directly in content script and doesn't require background script or offscreen document
      // Note: Some browsers require video: true even if we only need audio
      const stream = await navigator.mediaDevices.getDisplayMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          suppressLocalAudioPlayback: false
        },
        video: true // Required by some browsers, but we'll only use audio tracks
      });

      // Check if user actually selected something and didn't cancel
      if (!stream || stream.getAudioTracks().length === 0) {
        throw new Error('No audio track selected. Please select a tab or window to share.');
      }

      // Stop video tracks since we only need audio (saves resources)
      stream.getVideoTracks().forEach(track => {
        track.stop();
        console.log('[AUDIOSERVICE] Stopped video track (only need audio)');
      });

      this.tabAudioStream = stream;
      console.log('[AUDIOSERVICE] Tab audio captured via getDisplayMedia');

      // Determine supported audio-only MIME type
      const mimeType = this.getSupportedAudioMimeType();

      // Create MediaRecorder for tab audio with better quality settings
      // Wrap in try-catch to handle unsupported MIME types
      try {
        const audioBitsPerSecond = CONSTANTS?.AUDIO_BITS_PER_SECOND || 128000;
        this.tabMediaRecorder = new MediaRecorder(stream, {
          mimeType: mimeType || undefined, // Use undefined instead of empty string
          audioBitsPerSecond: audioBitsPerSecond
        });
      } catch (error) {
        console.warn('[AUDIOSERVICE] Failed to create MediaRecorder with specified MIME type, trying browser default:', error);
        // Try without specifying MIME type (browser default)
        try {
          this.tabMediaRecorder = new MediaRecorder(stream, {
            audioBitsPerSecond: 128000
          });
        } catch (error2) {
          // Final fallback - browser default with no options
          this.tabMediaRecorder = new MediaRecorder(stream);
        }
      }

      this.tabAudioChunks = [];
      this.accumulatedTabChunks = [];
      this.tabMediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          this.tabAudioChunks.push(event.data);
          this.accumulatedTabChunks.push(event.data);
        }
      };

      // Handle stream ending (user stops sharing)
      stream.getAudioTracks()[0].addEventListener('ended', () => {
        console.log('[AUDIOSERVICE] Tab audio stream ended (user stopped sharing)');
        if (this.tabMediaRecorder && this.tabMediaRecorder.state !== 'inactive') {
          this.tabMediaRecorder.stop();
        }
      });

      // Start recording with smaller timeslice for smoother accumulation
      // We'll accumulate chunks and transcribe longer segments
      this.tabMediaRecorder.start(500); // Collect data every 500ms for smoother accumulation
      console.log('[AUDIOSERVICE] Tab audio MediaRecorder started with MIME type:', this.tabMediaRecorder.mimeType || 'browser default');
    } catch (error) {
      console.error('[AUDIOSERVICE] Error capturing tab audio with getDisplayMedia:', error);
      throw error;
    }
  }

  async captureMicrophoneAudio() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        }
      });

      this.microphoneStream = stream;
      console.log('[AUDIOSERVICE] Microphone audio captured');

      // Determine supported audio-only MIME type
      const mimeType = this.getSupportedAudioMimeType();

      // Create MediaRecorder for microphone
      // Wrap in try-catch to handle unsupported MIME types
      try {
        this.microphoneMediaRecorder = new MediaRecorder(stream, {
          mimeType: mimeType || undefined // Use undefined instead of empty string
        });
      } catch (error) {
        console.warn('[AUDIOSERVICE] Failed to create MediaRecorder with specified MIME type, trying browser default:', error);
        // Try without specifying MIME type (browser default)
        this.microphoneMediaRecorder = new MediaRecorder(stream);
      }

      this.microphoneAudioChunks = [];
      this.accumulatedMicrophoneChunks = [];
      this.microphoneMediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          this.microphoneAudioChunks.push(event.data);
          this.accumulatedMicrophoneChunks.push(event.data);
        }
      };

      this.microphoneMediaRecorder.start(500); // Collect data every 500ms for smoother accumulation
      console.log('[AUDIOSERVICE] Microphone MediaRecorder started with MIME type:', this.microphoneMediaRecorder.mimeType || 'browser default');
    } catch (error) {
      console.error('[AUDIOSERVICE] Error capturing microphone:', error);
      // Don't throw - allow tab audio to continue even if microphone fails
      // This way we can still capture interviewer speech
      console.warn('[AUDIOSERVICE] Continuing with tab audio only (microphone unavailable)');
    }
  }

  startPeriodicTranscription() {
    // Transcribe audio chunks every 8 seconds for better quality
    // Longer chunks provide more context and better accuracy
    this.lastTranscriptionTime = Date.now();
    
    this.transcriptionInterval = setInterval(async () => {
      if (!this.isRecording) return;

      try {
        await this.transcribeAudioChunks();
        this.lastTranscriptionTime = Date.now();
      } catch (error) {
        console.error('[AUDIOSERVICE] Error in periodic transcription:', error);
      }
    }, this.audioChunkDuration);
  }

  async transcribeAudioChunks() {
    console.log('[AUDIOSERVICE] Transcribing audio chunks...');

    // Use accumulated chunks approach - don't stop/restart recorder
    // This avoids gaps and provides better quality
    let tabAudioBlob = null;
    let microphoneAudioBlob = null;
    const minChunkSize = CONSTANTS?.MIN_CHUNK_SIZE || 5000; // Minimum 5KB to avoid sending empty/silent audio

    // Get tab audio blob from accumulated chunks
    if (this.tabMediaRecorder && this.tabMediaRecorder.state === 'recording') {
      try {
        // Use accumulated chunks (sliding window approach)
        // Keep some overlap to avoid cutting words
        const chunksToUse = [...this.accumulatedTabChunks];
        
        if (chunksToUse.length === 0) {
          console.log('[AUDIOSERVICE] No accumulated tab audio chunks yet');
        } else {
          // Get MIME type from MediaRecorder
          let savedMimeType = this.tabMediaRecorder.mimeType || 'audio/webm';
          
          // Clean up MIME type - remove video codecs if present
          if (savedMimeType.includes('vp8') || savedMimeType.includes('vp9') || savedMimeType.includes('h264')) {
            if (savedMimeType.includes('opus')) {
              savedMimeType = 'audio/webm;codecs=opus';
            } else {
              savedMimeType = 'audio/webm';
            }
          }
          
          // Create blob from accumulated chunks
          tabAudioBlob = new Blob(chunksToUse, { type: savedMimeType });
          
          if (tabAudioBlob.size < minChunkSize) {
            console.log('[AUDIOSERVICE] Tab audio blob too small (' + tabAudioBlob.size + ' bytes), skipping transcription');
            tabAudioBlob = null;
          } else {
            console.log('[AUDIOSERVICE] Tab audio blob size:', tabAudioBlob.size, 'bytes, MIME type:', savedMimeType);
            
            // Keep last 25% of chunks for overlap (prevents word cutting)
            // This creates a sliding window effect
            const keepCount = Math.max(1, Math.floor(this.accumulatedTabChunks.length * 0.25));
            this.accumulatedTabChunks = this.accumulatedTabChunks.slice(-keepCount);
          }
        }
      } catch (error) {
        console.error('[AUDIOSERVICE] Error processing tab audio chunks:', error);
      }
    }

    // Get microphone audio blob from accumulated chunks (if microphone is being used)
    if (this.microphoneMediaRecorder && this.microphoneMediaRecorder.state === 'recording') {
      try {
        // Use accumulated chunks (sliding window approach)
        const chunksToUse = [...this.accumulatedMicrophoneChunks];
        
        if (chunksToUse.length === 0) {
          // No microphone chunks yet
        } else {
          // Get MIME type from MediaRecorder
          let savedMimeType = this.microphoneMediaRecorder.mimeType || 'audio/webm';
          
          // Create blob from accumulated chunks
          microphoneAudioBlob = new Blob(chunksToUse, { type: savedMimeType });
          
          if (microphoneAudioBlob.size < minChunkSize) {
            console.log('[AUDIOSERVICE] Microphone audio blob too small (' + microphoneAudioBlob.size + ' bytes), skipping transcription');
            microphoneAudioBlob = null;
          } else {
            console.log('[AUDIOSERVICE] Microphone audio blob size:', microphoneAudioBlob.size, 'bytes');
            
            // Keep last 25% of chunks for overlap
            const keepCount = Math.max(1, Math.floor(this.accumulatedMicrophoneChunks.length * 0.25));
            this.accumulatedMicrophoneChunks = this.accumulatedMicrophoneChunks.slice(-keepCount);
          }
        }
      } catch (error) {
        console.error('[AUDIOSERVICE] Error processing microphone audio chunks:', error);
      }
    }

    // If both blobs are null, nothing to transcribe
    if (!tabAudioBlob && !microphoneAudioBlob) {
      return;
    }

    // Transcribe both audio sources
    const transcriptionPromises = [];

    if (tabAudioBlob) {
      transcriptionPromises.push(
        this.transcribeWithWhisper(tabAudioBlob, 'tab')
      );
    }

    if (microphoneAudioBlob) {
      transcriptionPromises.push(
        this.transcribeWithWhisper(microphoneAudioBlob, 'microphone')
      );
    }

    try {
      const results = await Promise.all(transcriptionPromises);
      
      // Process results
      let tabTranscript = '';
      let microphoneTranscript = '';

      for (const result of results) {
        if (result.source === 'tab' && result.text) {
          tabTranscript = result.text;
        } else if (result.source === 'microphone' && result.text) {
          microphoneTranscript = result.text;
        }
      }

      // Separate interviewer and user speech
      await this.processTranscripts(tabTranscript, microphoneTranscript);
    } catch (error) {
      console.error('[AUDIOSERVICE] Error processing transcriptions:', error);
    }
  }

  async transcribeWithWhisper(audioBlob, source) {
    try {
      // Determine file extension and MIME type from blob
      const blobType = audioBlob.type.toLowerCase();
      let fileExtension = 'webm';
      let mimeType = 'audio/webm';
      
      if (blobType.includes('webm')) {
        fileExtension = 'webm';
        mimeType = 'audio/webm';
      } else if (blobType.includes('wav')) {
        fileExtension = 'wav';
        mimeType = 'audio/wav';
      } else if (blobType.includes('mp3')) {
        fileExtension = 'mp3';
        mimeType = 'audio/mp3';
      }

      // Try to send webm directly first (Whisper supports it)
      // Only convert to WAV if webm fails
      let finalBlob = audioBlob;
      
      // Ensure blob has correct MIME type
      if (finalBlob.type !== mimeType) {
        finalBlob = new Blob([finalBlob], { type: mimeType });
      }
      
      const fileName = `audio_${source}_${Date.now()}.${fileExtension}`;
      
      const formData = new FormData();
      formData.append('file', finalBlob, fileName);
      const whisperModel = CONSTANTS?.WHISPER_MODEL || 'whisper-1';
      formData.append('model', whisperModel);
      formData.append('language', 'en');
      formData.append('response_format', 'json');
      // Add prompt to help with context (improves accuracy for interview scenarios)
      formData.append('prompt', 'This is a job interview conversation. The speaker is discussing their experience, skills, and answering questions.');

      const apiBase = CONSTANTS?.OPENAI_API_BASE || 'https://api.openai.com/v1';
      const endpoint = CONSTANTS?.OPENAI_TRANSCRIPTION_ENDPOINT || '/audio/transcriptions';
      
      formData.set('model', whisperModel);
      
      const response = await fetch(`${apiBase}${endpoint}`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.openaiApiKey}`
        },
        body: formData
      });

      if (!response.ok) {
        const errorText = await response.text();
        
        // If webm fails, try converting to WAV as fallback
        if (fileExtension === 'webm' && response.status === 400) {
          console.log(`[AUDIOSERVICE] WebM failed for ${source}, trying WAV conversion...`);
          try {
            const wavBlob = await this.convertBlobToWav(audioBlob);
            const wavFileName = `audio_${source}_${Date.now()}.wav`;
            
            const wavFormData = new FormData();
            wavFormData.append('file', wavBlob, wavFileName);
            wavFormData.append('model', 'whisper-1');
            wavFormData.append('language', 'en');
            wavFormData.append('response_format', 'json');
            wavFormData.append('prompt', 'This is a job interview conversation. The speaker is discussing their experience, skills, and answering questions.');

            const apiBase = CONSTANTS?.OPENAI_API_BASE || 'https://api.openai.com/v1';
            const endpoint = CONSTANTS?.OPENAI_TRANSCRIPTION_ENDPOINT || '/audio/transcriptions';
            const wavResponse = await fetch(`${apiBase}${endpoint}`, {
              method: 'POST',
              headers: {
                'Authorization': `Bearer ${this.openaiApiKey}`
              },
              body: wavFormData
            });

            if (wavResponse.ok) {
              const wavData = await wavResponse.json();
              const transcript = wavData.text || '';
              console.log(`[AUDIOSERVICE] Transcription (${source}, WAV fallback):`, transcript);
              return { source, text: transcript };
            }
          } catch (wavError) {
            console.error(`[AUDIOSERVICE] WAV conversion also failed for ${source}:`, wavError);
          }
        }
        
        console.error(`[AUDIOSERVICE] Whisper API error (${source}):`, response.status, errorText);
        return { source, text: '', error: errorText };
      }

      const data = await response.json();
      const transcript = data.text || '';

      console.log(`[AUDIOSERVICE] Transcription (${source}):`, transcript);
      return { source, text: transcript };
    } catch (error) {
      console.error(`[AUDIOSERVICE] Error transcribing ${source}:`, error);
      return { source, text: '', error: error.message };
    }
  }

  async convertBlobToWav(audioBlob) {
    try {
      // Create audio context
      const audioContext = new (window.AudioContext || window.webkitAudioContext)();
      
      // Decode audio data
      const arrayBuffer = await audioBlob.arrayBuffer();
      const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
      
      // Convert to WAV format
      const wavBuffer = this.audioBufferToWav(audioBuffer);
      const wavBlob = new Blob([wavBuffer], { type: 'audio/wav' });
      
      // Close audio context to free resources
      await audioContext.close();
      
      return wavBlob;
    } catch (error) {
      console.error('[AUDIOSERVICE] Error converting to WAV:', error);
      // If conversion fails, try to send original blob with proper extension
      // This is a fallback - ideally conversion should always work
      const blobType = audioBlob.type.toLowerCase();
      let extension = 'webm';
      if (blobType.includes('wav')) extension = 'wav';
      else if (blobType.includes('mp3')) extension = 'mp3';
      
      return new Blob([audioBlob], { type: `audio/${extension}` });
    }
  }

  audioBufferToWav(buffer) {
    const length = buffer.length;
    const numberOfChannels = buffer.numberOfChannels;
    const sampleRate = buffer.sampleRate;
    const bytesPerSample = 2;
    const blockAlign = numberOfChannels * bytesPerSample;
    const byteRate = sampleRate * blockAlign;
    const dataSize = length * blockAlign;
    const bufferSize = 44 + dataSize;
    
    const arrayBuffer = new ArrayBuffer(bufferSize);
    const view = new DataView(arrayBuffer);
    
    // WAV header
    const writeString = (offset, string) => {
      for (let i = 0; i < string.length; i++) {
        view.setUint8(offset + i, string.charCodeAt(i));
      }
    };
    
    writeString(0, 'RIFF');
    view.setUint32(4, bufferSize - 8, true);
    writeString(8, 'WAVE');
    writeString(12, 'fmt ');
    view.setUint32(16, 16, true); // fmt chunk size
    view.setUint16(20, 1, true); // audio format (PCM)
    view.setUint16(22, numberOfChannels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, byteRate, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, 16, true); // bits per sample
    writeString(36, 'data');
    view.setUint32(40, dataSize, true);
    
    // Convert audio data
    let offset = 44;
    for (let i = 0; i < length; i++) {
      for (let channel = 0; channel < numberOfChannels; channel++) {
        const sample = Math.max(-1, Math.min(1, buffer.getChannelData(channel)[i]));
        view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7FFF, true);
        offset += 2;
      }
    }
    
    return arrayBuffer;
  }

  async processTranscripts(tabTranscript, microphoneTranscript) {
    // Tab audio contains both interviewer and user speech
    // Microphone contains only user speech
    // Interviewer speech = tab transcript - user speech (approximate)

    if (!tabTranscript && !microphoneTranscript) {
      return;
    }

    // If we have microphone transcript, that's definitely user speech
    if (microphoneTranscript && microphoneTranscript.trim()) {
      const userText = microphoneTranscript.trim();
      this.transcriptHistory.user.push({
        text: userText,
        timestamp: Date.now()
      });

      // Send user transcript
      chrome.runtime.sendMessage({
        action: 'transcript',
        transcript: userText,
        type: 'final',
        speaker: 'user'
      });
    }

    // For tab-only mode (no microphone), treat all tab audio as interviewer speech
    // This is used when Whisper is the fallback for caption extraction
    if (tabTranscript && tabTranscript.trim() && !microphoneTranscript) {
      // Tab-only mode: treat all as interviewer speech
      const interviewerText = tabTranscript.trim();
      
      if (interviewerText && interviewerText.length > 0) {
        this.transcriptHistory.interviewer.push({
          text: interviewerText,
          timestamp: Date.now()
        });

        // Send interviewer transcript
        chrome.runtime.sendMessage({
          action: 'transcript',
          transcript: interviewerText,
          type: 'final',
          speaker: 'interviewer'
        });
      }
      return;
    }

    // For interviewer speech, we need to extract what's not in user speech
    // This is a simplified approach - in reality, speaker diarization would be better
    if (tabTranscript && tabTranscript.trim()) {
      let interviewerText = tabTranscript.trim();

      // If we have user transcript, try to remove it from tab transcript
      if (microphoneTranscript && microphoneTranscript.trim()) {
        // Simple approach: if tab transcript contains user transcript, remove it
        const userWords = microphoneTranscript.trim().toLowerCase().split(/\s+/);
        const tabWords = tabTranscript.trim().split(/\s+/);
        
        // Remove user words from tab transcript (approximate)
        const filteredWords = tabWords.filter(word => {
          const wordLower = word.toLowerCase().replace(/[.,!?;:]/g, '');
          return !userWords.includes(wordLower);
        });

        interviewerText = filteredWords.join(' ').trim();
      }

      // Only add if there's meaningful content left
      if (interviewerText && interviewerText.length > 5) {
        this.transcriptHistory.interviewer.push({
          text: interviewerText,
          timestamp: Date.now()
        });

        // Send interviewer transcript
        chrome.runtime.sendMessage({
          action: 'transcript',
          transcript: interviewerText,
          type: 'final',
          speaker: 'interviewer'
        });
      }
    }
  }

  async stopRecording() {
    if (!this.isRecording) {
      return;
    }

    console.log('[AUDIOSERVICE] Stopping recording...');
    this.isRecording = false;

    // Clear intervals
    if (this.recordingInterval) {
      clearInterval(this.recordingInterval);
      this.recordingInterval = null;
    }
    if (this.transcriptionInterval) {
      clearInterval(this.transcriptionInterval);
      this.transcriptionInterval = null;
    }

    // Stop MediaRecorders
    if (this.tabMediaRecorder && this.tabMediaRecorder.state !== 'inactive') {
      this.tabMediaRecorder.stop();
    }

    if (this.microphoneMediaRecorder && this.microphoneMediaRecorder.state !== 'inactive') {
      this.microphoneMediaRecorder.stop();
    }

    // Transcribe any remaining chunks
    await this.transcribeAudioChunks();

    // Stop tracks
    if (this.tabAudioStream) {
      this.tabAudioStream.getTracks().forEach(track => track.stop());
      this.tabAudioStream = null;
    }

    if (this.microphoneStream) {
      this.microphoneStream.getTracks().forEach(track => track.stop());
      this.microphoneStream = null;
    }

    this.tabMediaRecorder = null;
    this.microphoneMediaRecorder = null;
    this.tabAudioChunks = [];
    this.microphoneAudioChunks = [];
    this.accumulatedTabChunks = [];
    this.accumulatedMicrophoneChunks = [];

    console.log('[AUDIOSERVICE] Recording stopped');
  }

  getTranscriptHistory() {
    return {
      interviewer: [...this.transcriptHistory.interviewer],
      user: [...this.transcriptHistory.user]
    };
  }
}

