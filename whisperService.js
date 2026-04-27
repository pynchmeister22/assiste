// Whisper Service for on-demand transcription
// Records audio continuously and transcribes when user presses Space or clicks Help

class WhisperService {
  constructor() {
    this.tabAudioStream = null;
    this.tabAudioContext = null;
    this.tabMediaRecorder = null;
    this.analyserNode = null;
    this.isRecording = false;
    this.openaiApiKey = null;
    
    // Audio chunk management
    this.audioChunks = [];
    
    // Callback when transcription is received
    this.onTranscription = null;
    
    // Prevent multiple simultaneous transcriptions
    this.isTranscribing = false;
    
    // ========== GLOBAL AUDIO THRESHOLDS ==========
    // Core settings (all processing derives from these)
    // Use constants if available, otherwise use defaults
    this.silenceThreshold = CONSTANTS?.SILENCE_THRESHOLD || 0.05;   // Silence threshold (0-0.5 scale)
    this.silenceDuration = CONSTANTS?.SILENCE_DURATION || 0.3;     // Silence duration to trigger actions (seconds)
    this.minChunkDuration = CONSTANTS?.MIN_CHUNK_DURATION || 10;     // Minimum audio before auto-transcribing (seconds)
    this.compressionRatio = CONSTANTS?.COMPRESSION_RATIO || 9;      // Compression ratio (higher = more compression)
    // ========== END GLOBAL THRESHOLDS ==========
    
    // Silence detection state tracking
    this.chunkStartTime = null; // When the current chunk started recording
    this.lastAudioTime = null; // Last time audio was detected above threshold
    this.silenceCheckInterval = null; // Interval for checking silence
    this.isSilent = false; // Current silence state
  }

  async initialize() {
    // Get OpenAI API key from storage
    return new Promise((resolve) => {
      chrome.storage.local.get(['openaiApiKey', 'token'], async (result) => {
        if (result.openaiApiKey) {
          try {
            this.openaiApiKey = await this.decrypt(result.openaiApiKey, result.token);
          } catch (error) {
            this.openaiApiKey = result.openaiApiKey;
          }
        }
        resolve();
      });
    });
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
      console.error('[WHISPERSERVICE] Decryption error:', error);
      try {
        return decodeURIComponent(escape(atob(encryptedText)));
      } catch (e) {
        return encryptedText;
      }
    }
  }

  getSupportedAudioMimeType() {
    // Prioritize audio-only formats that OpenAI Whisper accepts
    // IMPORTANT: Must be audio/* not video/* for Whisper to accept
    const mimeTypes = [
      'audio/webm;codecs=opus',
      'audio/webm',
      'audio/ogg;codecs=opus', 
      'audio/ogg',
      'audio/mp4;codecs=mp4a.40.2',
      'audio/mp4',
      'audio/mpeg',
      ''
    ];

    for (const mimeType of mimeTypes) {
      if (!mimeType || MediaRecorder.isTypeSupported(mimeType)) {
        console.log(`[WHISPERSERVICE] Using MIME type: ${mimeType || 'browser default'}`);
        return mimeType;
      }
    }
    
    console.warn('[WHISPERSERVICE] No audio MIME types supported, checking video/webm as fallback...');
    // Some browsers only support video/webm even for audio-only recording
    if (MediaRecorder.isTypeSupported('video/webm;codecs=opus')) {
      return 'video/webm;codecs=opus';
    }
    return '';
  }

  async startRecording() {
    if (this.isRecording) {
      console.log('[WHISPERSERVICE] Already recording');
      return;
    }

    console.log('[WHISPERSERVICE] Starting combined audio recording (mic + tab)...');
    
    try {
      // Step 1: Get MICROPHONE audio
      console.log('[WHISPERSERVICE] Requesting microphone permission...');
      const micStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: true
        }
      });
      console.log('[WHISPERSERVICE] Microphone permission granted');

      // Step 2: Get TAB audio via screen share
      // Use preferCurrentTab to auto-select the current tab (the Zoom/Meet tab)
      console.log('[WHISPERSERVICE] Requesting tab audio permission (preferring current tab)...');
      const tabStream = await navigator.mediaDevices.getDisplayMedia({
        audio: true,
        video: true, // Required by browsers, will be stopped immediately
        preferCurrentTab: true, // Auto-select current tab instead of showing picker
        selfBrowserSurface: 'include', // Include current tab in picker if preferCurrentTab fails
        systemAudio: 'include' // Also try to include system audio
      });
      
      // Stop video track immediately (not needed, we only want audio)
      tabStream.getVideoTracks().forEach(track => track.stop());
      
      const hasTabAudio = tabStream.getAudioTracks().length > 0;
      console.log('[WHISPERSERVICE] Tab audio available:', hasTabAudio);

      // Step 3: Mix both audio streams using AudioContext
      const audioContext = new AudioContext();
      const destination = audioContext.createMediaStreamDestination();
      
      // Add microphone to mix
      const micSource = audioContext.createMediaStreamSource(micStream);
      micSource.connect(destination);
      console.log('[WHISPERSERVICE] Microphone connected to mix');
      
      // Add tab audio to mix (if available)
      if (hasTabAudio) {
        const tabSource = audioContext.createMediaStreamSource(tabStream);
        tabSource.connect(destination);
        console.log('[WHISPERSERVICE] Tab audio connected to mix');
      }

      // The mixed stream
      const mixedStream = destination.stream;
      
      // Store references for cleanup
      this.micStream = micStream;
      this.tabAudioStream = tabStream;
      this.audioContext = audioContext;
      this.mixedStream = mixedStream;
      this.isRecording = true;
      
      // Setup MediaRecorder with the MIXED stream
      await this.setupMediaRecorder(mixedStream);
      
      // Handle stream ending
      tabStream.getAudioTracks()[0]?.addEventListener('ended', () => {
        console.log('[WHISPERSERVICE] Tab audio stream ended');
        this.stopRecording();
      });

      console.log('[WHISPERSERVICE] Recording started - mic + tab audio combined!');
      console.log('[WHISPERSERVICE] Microphone: ✓, Tab Audio:', hasTabAudio ? '✓' : '✗');
      
      // R key listener removed per user request
      
      // Setup audio analysis for level monitoring
      this.setupAudioAnalysis(this.mixedStream);
      
    } catch (error) {
      console.error('[WHISPERSERVICE] Error starting recording:', error);
      this.isRecording = false;
      throw error;
    }
  }

  setupAudioAnalysis(stream) {
    try {
      if (!stream) {
        console.error('[WHISPERSERVICE] No stream provided for audio analysis');
        return;
      }
      
      const audioTracks = stream.getAudioTracks();
      console.log('[WHISPERSERVICE] Setting up audio analysis with', audioTracks.length, 'audio tracks');
      
      if (audioTracks.length === 0) {
        console.error('[WHISPERSERVICE] Stream has no audio tracks for analysis');
        return;
      }
      
      // Use a separate AudioContext for analysis (different from mixing context)
      this.analysisAudioContext = new (window.AudioContext || window.webkitAudioContext)();
      const source = this.analysisAudioContext.createMediaStreamSource(stream);
      
      // Create analyser node for volume detection
      this.analyserNode = this.analysisAudioContext.createAnalyser();
      this.analyserNode.fftSize = 256;
      this.analyserNode.smoothingTimeConstant = 0.3; // Lower smoothing for faster response
      
      source.connect(this.analyserNode);
      // Don't connect to destination - we don't want to hear it twice
      
      console.log('[WHISPERSERVICE] Audio analysis setup complete - analyser ready');
      
      // Start silence detection for auto-chunking
      this.startSilenceDetection();
    } catch (error) {
      console.error('[WHISPERSERVICE] Error setting up audio analysis:', error);
    }
  }

  startSilenceDetection() {
    // Initialize timing
    this.chunkStartTime = Date.now();
    this.lastAudioTime = Date.now();
    this.isSilent = false;
    
    // Clear any existing interval
    if (this.silenceCheckInterval) {
      clearInterval(this.silenceCheckInterval);
    }
    
    // Convert thresholds: silenceThreshold is 0-1, getAudioLevel returns 0-100
    const silenceThreshold100 = this.silenceThreshold * 100;
    const silenceDurationMs = this.silenceDuration * 1000;
    const minChunkDurationMs = this.minChunkDuration * 1000;
    
    console.log(`[WHISPERSERVICE] Starting silence detection (threshold: ${silenceThreshold100}, duration: ${this.silenceDuration}s, min chunk: ${this.minChunkDuration}s)`);
    
    // Check audio level every 200ms
    this.silenceCheckInterval = setInterval(() => {
      if (!this.isRecording || this.isTranscribing) {
        return;
      }
      
      const audioLevel = this.getAudioLevel();
      const now = Date.now();
      // After minChunkDuration is reached, require stricter silence: threshold x2
      const currentSilenceThreshold = (now - this.chunkStartTime) >= minChunkDurationMs
        ? silenceThreshold100 * 3
        : silenceThreshold100;
      
      if (audioLevel > currentSilenceThreshold) {
        // Audio detected - reset silence tracking
        this.lastAudioTime = now;
        if (this.isSilent) {
          this.isSilent = false;
        }
      } else {
        // Silence detected
        if (!this.isSilent) {
          this.isSilent = true;
        }
        
        const silenceDuration = now - this.lastAudioTime;
        const chunkDuration = now - this.chunkStartTime;
        
        // Auto-transcribe if:
        // 1. Silence has lasted long enough
        // 2. We have enough audio accumulated
        // 3. We have audio chunks to process
        if (silenceDuration >= silenceDurationMs && 
            chunkDuration >= minChunkDurationMs && 
            this.audioChunks.length > 0) {
          
          console.log(`[WHISPERSERVICE] Auto-chunking triggered: ${(chunkDuration / 1000).toFixed(1)}s of audio, ${(silenceDuration / 1000).toFixed(1)}s silence`);
          this.autoTranscribeChunk();
        }
      }
    }, 200);
  }

  async autoTranscribeChunk() {
    // Prevent concurrent transcription
    if (this.isTranscribing) {
      console.log('[WHISPERSERVICE] Already transcribing, skipping auto-chunk');
      return;
    }
    
    if (this.audioChunks.length === 0) {
      console.log('[WHISPERSERVICE] No audio chunks to auto-transcribe');
      return;
    }

    // Check for API key
    if (!this.openaiApiKey) {
      await this.initialize();
      if (!this.openaiApiKey) {
        console.error('[WHISPERSERVICE] OpenAI API key not configured, skipping auto-transcription');
        return;
      }
    }

    // Mark as transcribing
    this.isTranscribing = true;
    console.log('[WHISPERSERVICE] Auto-transcription started (background chunking)');

    // Stop MediaRecorder to finalize current chunks
    if (this.tabMediaRecorder && this.tabMediaRecorder.state === 'recording') {
      this.tabMediaRecorder.stop();
    }
    await new Promise(resolve => setTimeout(resolve, 100));

    // Get accumulated chunks
    const chunksToTranscribe = [...this.audioChunks];
    this.audioChunks = [];
    
    // IMMEDIATELY restart recording so we don't miss any audio during processing!
    // This way recording continues while we process and send to API
    this.restartMediaRecorder();
    
    // Reset chunk timing for next chunk
    this.chunkStartTime = Date.now();
    this.lastAudioTime = Date.now();
    
    // Create audio blob from the chunks we grabbed
    const mimeType = 'audio/webm'; // Use default since recorder was restarted
    const audioBlob = new Blob(chunksToTranscribe, { type: mimeType });
    
    console.log('[WHISPERSERVICE] Auto-chunk blob - size:', audioBlob.size, 'bytes, chunks:', chunksToTranscribe.length);
    
    if (audioBlob.size < 1000) {
      console.log('[WHISPERSERVICE] Auto-chunk too short, skipping');
      this.isTranscribing = false;
      return;
    }

    // Process audio: remove silence, compress, convert to WAV
    // Recording continues in background while we process!
    const processedBlob = await this.processAudioForWhisper(audioBlob);
    
    if (!processedBlob || processedBlob.size < 1000) {
      console.log('[WHISPERSERVICE] Processed auto-chunk too short (mostly silence), skipping');
      this.isTranscribing = false;
      return;
    }

    console.log('[WHISPERSERVICE] Sending auto-chunk to Whisper API... (', processedBlob.size, 'bytes)');
    
    // Send to Whisper API (recording continues in background!)
    const transcription = await this.sendToWhisperAPI(processedBlob, 'wav', 'audio/wav');
    
    // Reset transcribing flag (recorder was already restarted at the beginning)
    this.isTranscribing = false;
    
    if (transcription && transcription.trim()) {
      console.log('[WHISPERSERVICE] Auto-chunk transcription:', transcription.substring(0, 100));
      
      // Call callback if set (this sends to caption service)
      if (this.onTranscription) {
        this.onTranscription(transcription);
      }
    } else {
      console.log('[WHISPERSERVICE] Auto-chunk produced no transcription');
    }
  }

  async setupMediaRecorder(stream) {
    // CRITICAL: Create an audio-only stream from the display media stream
    // This prevents the MediaRecorder from using video codecs
    const audioTracks = stream.getAudioTracks();
    if (audioTracks.length === 0) {
      throw new Error('No audio tracks available in the stream');
    }
    
    // Create a new MediaStream with ONLY the audio track
    const audioOnlyStream = new MediaStream(audioTracks);
    console.log('[WHISPERSERVICE] Created audio-only stream with', audioTracks.length, 'audio track(s)');
    
    const mimeType = this.getSupportedAudioMimeType();
    console.log('[WHISPERSERVICE] Attempting to create MediaRecorder with MIME type:', mimeType);
    
    try {
      const audioBitsPerSecond = CONSTANTS?.AUDIO_BITS_PER_SECOND || 128000;
      this.tabMediaRecorder = new MediaRecorder(audioOnlyStream, {
        mimeType: mimeType || undefined,
        audioBitsPerSecond: audioBitsPerSecond
      });
      console.log('[WHISPERSERVICE] MediaRecorder created successfully with MIME type:', this.tabMediaRecorder.mimeType);
    } catch (error) {
      console.warn('[WHISPERSERVICE] Failed with specified MIME type:', error.message);
      console.warn('[WHISPERSERVICE] Trying without MIME type specification...');
      try {
        this.tabMediaRecorder = new MediaRecorder(audioOnlyStream, {
          audioBitsPerSecond: 128000
        });
        console.log('[WHISPERSERVICE] MediaRecorder created with default MIME type:', this.tabMediaRecorder.mimeType);
      } catch (error2) {
        console.warn('[WHISPERSERVICE] Trying basic MediaRecorder...');
        this.tabMediaRecorder = new MediaRecorder(audioOnlyStream);
        console.log('[WHISPERSERVICE] MediaRecorder created (basic) with MIME type:', this.tabMediaRecorder.mimeType);
      }
    }

    this.audioChunks = [];
    
    this.tabMediaRecorder.ondataavailable = (event) => {
      if (event.data.size > 0) {
        this.audioChunks.push(event.data);

      } else {
        console.warn('[WHISPERSERVICE] Empty audio chunk received (size: 0)');
      }
    };
    
    this.tabMediaRecorder.onerror = (event) => {
      console.error('[WHISPERSERVICE] MediaRecorder error:', event.error);
    };

    // Start recording with small timeslice for smooth accumulation
    this.tabMediaRecorder.start(500);
    console.log('[WHISPERSERVICE] MediaRecorder started - recording audio');
  }

  getAudioLevel() {
    if (!this.analyserNode) {
      console.warn('[WHISPERSERVICE] No analyser node available');
      return 0;
    }
    
    const dataArray = new Uint8Array(this.analyserNode.frequencyBinCount);
    this.analyserNode.getByteFrequencyData(dataArray);
    
    // Calculate average audio level (0-255)
    let sum = 0;
    let max = 0;
    for (let i = 0; i < dataArray.length; i++) {
      sum += dataArray[i];
      if (dataArray[i] > max) max = dataArray[i];
    }
    const average = sum / dataArray.length;
    
    // Convert to 0-100 scale
    return Math.round((average / 255) * 100);
  }

  async transcribeNow(useFullAudio = false) {
    console.log('[WHISPERSERVICE] transcribeNow called - isRecording:', this.isRecording, ', chunks:', this.audioChunks.length);
    
    if (!this.isRecording) {
      console.log('[WHISPERSERVICE] Not recording!');
      return null;
    }
    
    // Prevent concurrent transcription
    if (this.isTranscribing) {
      console.log('[WHISPERSERVICE] Already transcribing, skipping request');
      return null;
    }
    
    if (this.audioChunks.length === 0) {
      console.log('[WHISPERSERVICE] No audio chunks collected yet');
      return null;
    }

    // Mark as transcribing
    this.isTranscribing = true;
    console.log('[WHISPERSERVICE] Transcription started');

    // Check for API key
    if (!this.openaiApiKey) {
      await this.initialize();
      if (!this.openaiApiKey) {
        console.error('[WHISPERSERVICE] OpenAI API key not configured');
        this.isTranscribing = false;
        return null;
      }
    }

    // Stop MediaRecorder to finalize current chunks
    if (this.tabMediaRecorder && this.tabMediaRecorder.state === 'recording') {
      this.tabMediaRecorder.stop();
    }
    await new Promise(resolve => setTimeout(resolve, 100));

    // Get accumulated chunks
    const chunksToTranscribe = [...this.audioChunks];
    this.audioChunks = [];
    
    // IMMEDIATELY restart recording so we don't miss any audio during processing!
    this.restartMediaRecorder();
    
    // Create audio blob from the chunks we grabbed
    let audioBlob = new Blob(chunksToTranscribe, { type: 'audio/webm' });
    
    // For Space key (useFullAudio=false), trim to last 30s to avoid huge uploads
    if (!useFullAudio) {
      audioBlob = await this.trimAudioBlob(audioBlob, 30);
    }
    
    console.log('[WHISPERSERVICE] Audio blob - size:', audioBlob.size, 'bytes, chunks:', chunksToTranscribe.length);
    
    if (audioBlob.size < 1000) {
      console.log('[WHISPERSERVICE] Audio too short, skipping');
      this.isTranscribing = false;
      return null;
    }

    // Process audio: remove silence, compress, convert to WAV
    // Recording continues in background while we process!
    console.log('[WHISPERSERVICE] Processing audio for Whisper API...');
    const processedBlob = await this.processAudioForWhisper(audioBlob);
    
    if (!processedBlob) {
      console.error('[WHISPERSERVICE] Failed to process audio');
      this.isTranscribing = false;
      return null;
    }

    // Check if processed audio is too short (all silence?)
    if (processedBlob.size < 1000) {
      console.log('[WHISPERSERVICE] Processed audio too short (mostly silence), skipping');
      this.isTranscribing = false;
      return null;
    }

    console.log('[WHISPERSERVICE] Sending to Whisper API... (', processedBlob.size, 'bytes)');
    
    // Send to Whisper API (recording continues in background!)
    const transcription = await this.sendToWhisperAPI(processedBlob, 'wav', 'audio/wav');
    
    // Reset transcribing flag (recorder was already restarted at the beginning)
    this.isTranscribing = false;
    
    if (transcription && transcription.trim()) {
      console.log('[WHISPERSERVICE] Transcription:', transcription);
      
      // Call callback if set (this sends to caption service)
      if (this.onTranscription) {
        this.onTranscription(transcription);
      }
      
      return transcription;
    }
    
    return null;
  }

  async transcribeWithWhisper(audioBlob) {
    try {
      const blobType = (audioBlob.type || '').toLowerCase();
      console.log('[WHISPERSERVICE] Original blob type:', blobType, 'size:', audioBlob.size);
      
      // Determine the best format to send to Whisper
      // Whisper accepts: flac, m4a, mp3, mp4, mpeg, mpga, oga, ogg, wav, webm
      let fileExtension = 'webm';
      let targetMimeType = 'audio/webm';
      
      if (blobType.includes('ogg')) {
        fileExtension = 'ogg';
        targetMimeType = 'audio/ogg';
      } else if (blobType.includes('mp4') || blobType.includes('m4a')) {
        fileExtension = 'm4a';
        targetMimeType = 'audio/mp4';
      } else if (blobType.includes('mp3') || blobType.includes('mpeg')) {
        fileExtension = 'mp3';
        targetMimeType = 'audio/mpeg';
      } else if (blobType.includes('wav')) {
        fileExtension = 'wav';
        targetMimeType = 'audio/wav';
      } else if (blobType.includes('webm')) {
        fileExtension = 'webm';
        targetMimeType = 'audio/webm';
      }

      // If the blob type contains 'video', we need to convert to audio
      // This happens when MediaRecorder uses video/webm even for audio-only streams
      const isVideoFormat = blobType.includes('video');
      
      if (isVideoFormat) {
        console.log('[WHISPERSERVICE] Detected video format, will convert to audio WAV');
        // Convert to WAV first since video/webm is not accepted
        const wavBlob = await this.convertToWavViaAudioContext(audioBlob);
        if (wavBlob) {
          return await this.sendToWhisperAPI(wavBlob, 'wav', 'audio/wav');
        }
        console.warn('[WHISPERSERVICE] WAV conversion failed, trying raw upload anyway...');
      }

      // Create a properly typed blob
      const finalBlob = new Blob([audioBlob], { type: targetMimeType });
      const fileName = `audio_${Date.now()}.${fileExtension}`;
      
      console.log('[WHISPERSERVICE] Sending to Whisper - filename:', fileName, 'type:', targetMimeType, 'size:', finalBlob.size);
      
      const result = await this.sendToWhisperAPI(finalBlob, fileExtension, targetMimeType);
      
      if (result === null) {
        // First attempt failed, try WAV conversion
        console.log('[WHISPERSERVICE] Direct upload failed, converting to WAV...');
        const wavBlob = await this.convertToWavViaAudioContext(audioBlob);
        if (wavBlob) {
          return await this.sendToWhisperAPI(wavBlob, 'wav', 'audio/wav');
        }
      }
      
      return result || '';
    } catch (error) {
      console.error('[WHISPERSERVICE] Error in transcribeWithWhisper:', error);
      return '';
    }
  }

  async sendToWhisperAPI(blob, fileExtension, mimeType) {
    const fileName = `audio_${Date.now()}.${fileExtension}`;
    
    const formData = new FormData();
    formData.append('file', blob, fileName);
    const whisperModel = CONSTANTS?.WHISPER_MODEL || 'whisper-1';
    formData.append('model', whisperModel);
    formData.append('language', 'en');
    formData.append('response_format', 'json');
    // Note: Don't use prompt - Whisper may output it as transcription when audio is unclear

    console.log('[WHISPERSERVICE] Sending to Whisper API:', fileName, 'size:', blob.size, 'type:', mimeType);

    try {
      const apiBase = CONSTANTS?.OPENAI_API_BASE || 'https://api.openai.com/v1';
      const endpoint = CONSTANTS?.OPENAI_TRANSCRIPTION_ENDPOINT || '/audio/transcriptions';
      const whisperModel = CONSTANTS?.WHISPER_MODEL || 'whisper-1';
      
      formData.set('model', whisperModel);
      
      const response = await fetch(`${apiBase}${endpoint}`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.openaiApiKey}`
        },
        body: formData
      });

      const responseText = await response.text();
      
      if (!response.ok) {
        console.error('[WHISPERSERVICE] Whisper API error:', response.status, responseText);
        return null;
      }

      const data = JSON.parse(responseText);
      console.log('[WHISPERSERVICE] Whisper API success:', data.text?.substring(0, 100));
      return data.text || '';
    } catch (error) {
      console.error('[WHISPERSERVICE] Error sending to Whisper API:', error);
      return null;
    }
  }

  async convertToWavViaAudioContext(audioBlob) {
    try {
      console.log('[WHISPERSERVICE] Converting to WAV via AudioContext...');
      
      const audioContext = new (window.AudioContext || window.webkitAudioContext)();
      const arrayBuffer = await audioBlob.arrayBuffer();
      
      console.log('[WHISPERSERVICE] Decoding audio data, buffer size:', arrayBuffer.byteLength);
      
      const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
      
      console.log('[WHISPERSERVICE] Audio decoded - duration:', audioBuffer.duration, 's, channels:', audioBuffer.numberOfChannels, 'sample rate:', audioBuffer.sampleRate);
      
      // Remove silent parts from the audio
      const processedBuffer = this.removeSilenceFromBuffer(audioBuffer, audioContext);
      
      console.log('[WHISPERSERVICE] After silence removal - duration:', processedBuffer.duration, 's');
      
      const wavBuffer = this.audioBufferToWav(processedBuffer);
      const wavBlob = new Blob([wavBuffer], { type: 'audio/wav' });
      
      await audioContext.close();
      
      console.log('[WHISPERSERVICE] WAV conversion successful, size:', wavBlob.size);
      return wavBlob;
    } catch (error) {
      console.error('[WHISPERSERVICE] Error converting to WAV:', error.message);
      return null;
    }
  }

  // Remove silent parts from audio buffer
  removeSilenceFromBuffer(audioBuffer, audioContext) {
    const sampleRate = audioBuffer.sampleRate;
    const numChannels = audioBuffer.numberOfChannels;
    
    // Get audio data from first channel for analysis
    const channelData = audioBuffer.getChannelData(0);
    
    // Use global thresholds for silence detection (silenceThreshold is 0-1, silenceDuration in seconds)
    const minSilenceSamples = Math.floor(this.silenceDuration * sampleRate);
    
    // Find non-silent regions
    const nonSilentRegions = [];
    let regionStart = null;
    let silenceStart = null;
    
    for (let i = 0; i < channelData.length; i++) {
      const amplitude = Math.abs(channelData[i]);
      
      if (amplitude > this.silenceThreshold) {
        // Audio detected
        if (regionStart === null) {
          regionStart = i;
        }
        silenceStart = null;
      } else {
        // Silence detected
        if (regionStart !== null && silenceStart === null) {
          silenceStart = i;
        }
        
        // Check if silence is long enough to split region
        if (silenceStart !== null && (i - silenceStart) >= minSilenceSamples) {
          // End current region
          nonSilentRegions.push({ start: regionStart, end: silenceStart });
          regionStart = null;
          silenceStart = null;
        }
      }
    }
    
    // Don't forget the last region
    if (regionStart !== null) {
      nonSilentRegions.push({ start: regionStart, end: channelData.length });
    }
    
    console.log('[WHISPERSERVICE] Found', nonSilentRegions.length, 'non-silent regions');
    
    // If no regions found or only silence, return original
    if (nonSilentRegions.length === 0) {
      console.log('[WHISPERSERVICE] No non-silent regions found, returning original');
      return audioBuffer;
    }
    
    // Calculate total length needed
    let totalSamples = 0;
    const gapSamples = Math.floor(0.1 * sampleRate); // 100ms gap between regions
    
    for (const region of nonSilentRegions) {
      totalSamples += (region.end - region.start);
    }
    totalSamples += gapSamples * (nonSilentRegions.length - 1); // Add gaps
    
    // Create new buffer
    const newBuffer = audioContext.createBuffer(numChannels, totalSamples, sampleRate);
    
    // Copy non-silent regions to new buffer
    let writePosition = 0;
    for (let regionIdx = 0; regionIdx < nonSilentRegions.length; regionIdx++) {
      const region = nonSilentRegions[regionIdx];
      const regionLength = region.end - region.start;
      
      for (let channel = 0; channel < numChannels; channel++) {
        const sourceData = audioBuffer.getChannelData(channel);
        const destData = newBuffer.getChannelData(channel);
        
        for (let i = 0; i < regionLength; i++) {
          destData[writePosition + i] = sourceData[region.start + i];
        }
      }
      
      writePosition += regionLength;
      
      // Add small gap between regions (except after last)
      if (regionIdx < nonSilentRegions.length - 1) {
        writePosition += gapSamples;
      }
    }
    
    console.log('[WHISPERSERVICE] Silence removed: original', audioBuffer.duration.toFixed(1), 's -> new', newBuffer.duration.toFixed(1), 's');
    
    return newBuffer;
  }


  audioBufferToWav(buffer) {
    // Downsample to target sample rate mono for faster Whisper processing
    const targetSampleRate = CONSTANTS?.TARGET_SAMPLE_RATE || 16000;
    const targetChannels = CONSTANTS?.TARGET_CHANNELS || 1; // Mono
    
    const originalSampleRate = buffer.sampleRate;
    const originalLength = buffer.length;
    
    // Calculate new length after resampling
    const resampleRatio = targetSampleRate / originalSampleRate;
    const newLength = Math.floor(originalLength * resampleRatio);
    
    // Mix down to mono and resample
    const monoData = new Float32Array(newLength);
    const numChannels = buffer.numberOfChannels;
    
    for (let i = 0; i < newLength; i++) {
      const originalIndex = i / resampleRatio;
      const index0 = Math.floor(originalIndex);
      const index1 = Math.min(index0 + 1, originalLength - 1);
      const fraction = originalIndex - index0;
      
      // Linear interpolation + channel mixing
      let sample = 0;
      for (let channel = 0; channel < numChannels; channel++) {
        const channelData = buffer.getChannelData(channel);
        const s0 = channelData[index0] || 0;
        const s1 = channelData[index1] || 0;
        sample += s0 + (s1 - s0) * fraction;
      }
      monoData[i] = sample / numChannels; // Average channels
    }
    
    // Create WAV buffer
    const bytesPerSample = 2;
    const dataSize = newLength * bytesPerSample;
    const bufferSize = 44 + dataSize;
    
    const arrayBuffer = new ArrayBuffer(bufferSize);
    const view = new DataView(arrayBuffer);
    
    const writeString = (offset, string) => {
      for (let i = 0; i < string.length; i++) {
        view.setUint8(offset + i, string.charCodeAt(i));
      }
    };
    
    // WAV header
    writeString(0, 'RIFF');
    view.setUint32(4, bufferSize - 8, true);
    writeString(8, 'WAVE');
    writeString(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true); // PCM
    view.setUint16(22, targetChannels, true); // Mono
    view.setUint32(24, targetSampleRate, true); // 16kHz
    view.setUint32(28, targetSampleRate * bytesPerSample, true); // Byte rate
    view.setUint16(32, bytesPerSample, true); // Block align
    view.setUint16(34, 16, true); // Bits per sample
    writeString(36, 'data');
    view.setUint32(40, dataSize, true);
    
    // Write audio data
    let offset = 44;
    for (let i = 0; i < newLength; i++) {
      const sample = Math.max(-1, Math.min(1, monoData[i]));
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7FFF, true);
      offset += 2;
    }
    
    console.log('[WHISPERSERVICE] WAV created: ' + targetSampleRate + 'Hz mono, ' + (bufferSize / 1024).toFixed(1) + 'KB');
    
    return arrayBuffer;
  }

  async stopRecording() {
    if (!this.isRecording) return;

    console.log('[WHISPERSERVICE] Stopping recording...');
    this.isRecording = false;

    // Stop silence detection interval
    if (this.silenceCheckInterval) {
      clearInterval(this.silenceCheckInterval);
      this.silenceCheckInterval = null;
    }

    // Remove replay key listener
    if (this.replayKeyListener) {
      document.removeEventListener('keydown', this.replayKeyListener);
      this.replayKeyListener = null;
    }

    // Close analysis audio context
    if (this.analysisAudioContext) {
      try {
        this.analysisAudioContext.close();
      } catch (e) {}
      this.analysisAudioContext = null;
    }
    this.analyserNode = null;

    // Stop MediaRecorder
    if (this.tabMediaRecorder && this.tabMediaRecorder.state !== 'inactive') {
      this.tabMediaRecorder.stop();
    }

    // Close audio context (for mixing)
    if (this.audioContext) {
      try {
        await this.audioContext.close();
      } catch (e) {
        // Ignore
      }
      this.audioContext = null;
    }

    // Stop microphone stream
    if (this.micStream) {
      this.micStream.getTracks().forEach(track => track.stop());
      this.micStream = null;
    }

    // Stop tab audio stream
    if (this.tabAudioStream) {
      this.tabAudioStream.getTracks().forEach(track => track.stop());
      this.tabAudioStream = null;
    }

    // Stop mixed stream
    if (this.mixedStream) {
      this.mixedStream.getTracks().forEach(track => track.stop());
      this.mixedStream = null;
    }

    this.tabMediaRecorder = null;
    this.analyserNode = null;
    this.audioChunks = [];

    console.log('[WHISPERSERVICE] Recording stopped');
  }

  // Set callback for transcription results
  setOnTranscription(callback) {
    this.onTranscription = callback;
  }

  // No-op for backward compatibility with captionService
  setOnSilenceDetected(callback) {
    // Silence detection removed - this is kept for backward compatibility
  }

  // DEBUG: Play audio blob to verify recording works
  async playAudioBlob(audioBlob) {
    console.log('[WHISPERSERVICE] Attempting to play blob, size:', audioBlob.size, 'type:', audioBlob.type);
    
    // Try AudioContext first (most compatible)
    try {
      const arrayBuffer = await audioBlob.arrayBuffer();
      const audioContext = new (window.AudioContext || window.webkitAudioContext)();
      
      console.log('[WHISPERSERVICE] Decoding audio with AudioContext...');
      const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
      
      console.log('[WHISPERSERVICE] Audio decoded! Duration:', audioBuffer.duration, 's, Channels:', audioBuffer.numberOfChannels);
      alert(`[Debug] Playing audio...\n\nDuration: ${audioBuffer.duration.toFixed(1)}s\nChannels: ${audioBuffer.numberOfChannels}\nSample Rate: ${audioBuffer.sampleRate}`);
      
      const source = audioContext.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(audioContext.destination);
      
      return new Promise((resolve) => {
        source.onended = () => {
          console.log('[WHISPERSERVICE] Playback finished');
          audioContext.close();
          resolve();
        };
        source.start(0);
      });
      
    } catch (decodeError) {
      console.error('[WHISPERSERVICE] AudioContext decode failed:', decodeError.message);
      
      // Fallback: download file
      alert(`[Debug] Cannot decode audio in browser.\n\nError: ${decodeError.message}\n\nDownloading file - try opening with VLC...`);
      this.downloadBlob(audioBlob, `debug_audio_${Date.now()}.webm`);
      return;
    }
  }

  // Download blob for debugging
  downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    console.log('[WHISPERSERVICE] Downloaded debug audio file:', filename);
  }

  // Setup 'R' key listener for replay
  setupReplayKeyListener() {
    // Remove existing listener if any
    if (this.replayKeyListener) {
      document.removeEventListener('keydown', this.replayKeyListener);
    }
    
    this.replayKeyListener = (e) => {
      // Only trigger on 'r' or 'R' key, not in input fields
      if ((e.key === 'r' || e.key === 'R') && 
          e.target.tagName !== 'INPUT' && 
          e.target.tagName !== 'TEXTAREA') {
        e.preventDefault();
        this.replayRecordedAudio();
      }
    };
    
    document.addEventListener('keydown', this.replayKeyListener);
    console.log('[WHISPERSERVICE] Replay key listener set up - press R to replay');
  }

  // Replay recorded audio and clear buffer - plays PROCESSED audio (what would be sent to Whisper)
  async replayRecordedAudio() {
    console.log('[WHISPERSERVICE] Replay requested - chunks:', this.audioChunks.length);
    
    if (!this.isRecording) {
      alert('[Debug] Not recording!');
      return;
    }
    
    if (this.audioChunks.length === 0) {
      alert('[Debug] No audio chunks yet!\n\nWait a few seconds for audio to accumulate.');
      return;
    }

    // Stop the MediaRecorder to finalize the current recording
    if (this.tabMediaRecorder && this.tabMediaRecorder.state === 'recording') {
      this.tabMediaRecorder.stop();
    }
    
    // Wait a bit for final chunks
    await new Promise(resolve => setTimeout(resolve, 100));

    // Take all current chunks
    const chunksToPlay = [...this.audioChunks];
    
    // Clear the buffer
    this.audioChunks = [];
    
    // Create blob from chunks
    const mimeType = this.tabMediaRecorder?.mimeType || 'audio/webm';
    const audioBlob = new Blob(chunksToPlay, { type: mimeType });
    
    console.log('[WHISPERSERVICE] Original audio - size:', audioBlob.size, 'bytes');
    
    // Process the audio exactly as we would for Whisper (remove silence, compress)
    const processedBlob = await this.processAudioForWhisper(audioBlob);
    
    if (processedBlob) {
      console.log('[WHISPERSERVICE] Processed audio - size:', processedBlob.size, 'bytes');
      // Play the processed audio
      await this.playAudioBlob(processedBlob);
    } else {
      console.log('[WHISPERSERVICE] Processing failed, playing original');
      await this.playAudioBlob(audioBlob);
    }
    
    // Restart MediaRecorder for next recording
    console.log('[WHISPERSERVICE] Restarting MediaRecorder...');
    this.restartMediaRecorder();
  }

  // Process audio for Whisper: remove silence, compress, normalize
  async processAudioForWhisper(audioBlob) {
    try {
      const audioContext = new (window.AudioContext || window.webkitAudioContext)();
      const arrayBuffer = await audioBlob.arrayBuffer();
      const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
      
      console.log('[WHISPERSERVICE] Original duration:', audioBuffer.duration.toFixed(1), 's');
      
      // Step 1: Remove silence
      let processedBuffer = this.removeSilenceFromBuffer(audioBuffer, audioContext);
      
      // Step 2: Compress and normalize (boost speech, reduce noise)
      processedBuffer = this.compressAndNormalize(processedBuffer, audioContext);
      
      console.log('[WHISPERSERVICE] Processed duration:', processedBuffer.duration.toFixed(1), 's');
      
      // Convert to WAV
      const wavBuffer = this.audioBufferToWav(processedBuffer);
      const wavBlob = new Blob([wavBuffer], { type: 'audio/wav' });
      
      await audioContext.close();
      
      return wavBlob;
    } catch (error) {
      console.error('[WHISPERSERVICE] Error processing audio:', error);
      return null;
    }
  }

  // Trim an audio blob to the last N seconds using AudioContext
  async trimAudioBlob(audioBlob, seconds) {
    try {
      const audioContext = new (window.AudioContext || window.webkitAudioContext)();
      const arrayBuffer = await audioBlob.arrayBuffer();
      const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
      
      const duration = audioBuffer.duration;
      if (duration <= seconds) {
        await audioContext.close();
        return audioBlob; // nothing to trim
      }

      // Calculate start position to keep only the last N seconds
      const start = duration - seconds;
      const startSample = Math.floor(start * audioBuffer.sampleRate);
      const frameCount = Math.floor(seconds * audioBuffer.sampleRate);

      const trimmedBuffer = audioContext.createBuffer(
        audioBuffer.numberOfChannels,
        frameCount,
        audioBuffer.sampleRate
      );

      for (let channel = 0; channel < audioBuffer.numberOfChannels; channel++) {
        const sourceData = audioBuffer.getChannelData(channel);
        const targetData = trimmedBuffer.getChannelData(channel);
        for (let i = 0; i < frameCount; i++) {
          targetData[i] = sourceData[startSample + i] || 0;
        }
      }

      // Convert trimmed buffer to WAV blob
      const wavBuffer = this.audioBufferToWav(trimmedBuffer);
      await audioContext.close();
      return new Blob([wavBuffer], { type: 'audio/wav' });
    } catch (error) {
      console.error('[WHISPERSERVICE] Error trimming audio blob:', error);
      return audioBlob; // fallback to original if trimming fails
    }
  }

  // Compress and normalize audio to focus on human speech
  compressAndNormalize(audioBuffer, audioContext) {
    const numChannels = audioBuffer.numberOfChannels;
    const sampleRate = audioBuffer.sampleRate;
    const length = audioBuffer.length;
    
    // Create new buffer
    const newBuffer = audioContext.createBuffer(numChannels, length, sampleRate);
    
    for (let channel = 0; channel < numChannels; channel++) {
      const inputData = audioBuffer.getChannelData(channel);
      const outputData = newBuffer.getChannelData(channel);
      
      // Find peak amplitude for normalization
      let peak = 0;
      for (let i = 0; i < inputData.length; i++) {
        const abs = Math.abs(inputData[i]);
        if (abs > peak) peak = abs;
      }
      
      // Normalization factor (target peak at 0.9)
      const normFactor = peak > 0 ? 0.9 / peak : 1;
      
      // Use silenceThreshold for both noise gate and compression threshold
      // Noise gate: remove sounds below silenceThreshold
      // Compression: compress sounds above silenceThreshold (using compressionRatio)
      const noiseGate = this.silenceThreshold * 0.5; // Noise gate at half the silence threshold
      const compThreshold = this.silenceThreshold; // Compression kicks in at silence threshold
      
      // Apply compression and normalization using global settings
      for (let i = 0; i < inputData.length; i++) {
        let sample = inputData[i] * normFactor;
        
        // Noise gate - remove very quiet sounds
        if (Math.abs(sample) < noiseGate) {
          sample = 0;
        } else {
          // Soft compression for louder sounds
          const abs = Math.abs(sample);
          if (abs > compThreshold) {
            const excess = abs - compThreshold;
            const compressed = compThreshold + excess / this.compressionRatio;
            sample = sample > 0 ? compressed : -compressed;
          }
        }
        
        outputData[i] = sample;
      }
    }
    
    return newBuffer;
  }

  // Restart MediaRecorder (to get fresh header for new recording)
  restartMediaRecorder() {
    if (!this.mixedStream && !this.tabAudioStream) {
      console.error('[WHISPERSERVICE] No stream to restart with');
      return;
    }
    
    const stream = this.mixedStream || this.tabAudioStream;
    const mimeType = this.tabMediaRecorder?.mimeType || 'audio/webm';
    
    try {
        const audioBitsPerSecond = CONSTANTS?.AUDIO_BITS_PER_SECOND || 128000;
        this.tabMediaRecorder = new MediaRecorder(stream, {
          mimeType: mimeType,
          audioBitsPerSecond: audioBitsPerSecond
        });
    } catch (e) {
      this.tabMediaRecorder = new MediaRecorder(stream);
    }
    
    this.audioChunks = [];
    
    // Reset chunk timing for silence detection
    this.chunkStartTime = Date.now();
    this.lastAudioTime = Date.now();
    
    this.tabMediaRecorder.ondataavailable = (event) => {
      if (event.data.size > 0) {
        this.audioChunks.push(event.data);
      }
    };
    
    this.tabMediaRecorder.start(500);
    console.log('[WHISPERSERVICE] MediaRecorder restarted');
  }

  // Get current audio level (for UI feedback)
  getCurrentAudioLevel() {
    return this.getAudioLevel();
  }

  // Check if currently recording
  getIsRecording() {
    return this.isRecording;
  }

  // Check if currently transcribing
  getIsTranscribing() {
    return this.isTranscribing;
  }

}
