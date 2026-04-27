// Import shared utilities (will be available via script tag in manifest)
// Constants are loaded via script tag before this file

class AIService {
  constructor() {
    this.apiBaseUrl = null;
    this.openaiApiKey = null;
    this.session = null;
    this.chatHistory = [];
    this.captionHistory = [];
    this.lastHelpTimestamp = null; // Track when help was last requested
    this.captionFirstSeen = new Map(); // Track when each caption text was first seen
    this.currentAbortController = null; // Track in-flight response for cancellation
  }

  async getApiBaseUrl() {
    if (!this.apiBaseUrl) {
      this.apiBaseUrl = await config.getApiBaseUrl();
    }
    return this.apiBaseUrl;
  }

  async initialize(session) {
    this.session = session;
    this.chatHistory = session.chatHistory || [];
    this.captionHistory = [];
    this.lastHelpTimestamp = session.lastHelpTimestamp || null;
    
    // Get API keys from storage and decrypt them
    return new Promise(async (resolve) => {
      const storageKeys = CONSTANTS?.STORAGE_KEYS || {};
      chrome.storage.local.get(
        [
          storageKeys.CUSTOM_OPENAI_API_KEY || 'customOpenaiApiKey',
          storageKeys.OPENAI_API_KEY || 'openaiApiKey',
          storageKeys.TOKEN || 'token'
        ],
        async (result) => {
          const extKey =
            typeof getExtensionStorageKeyMaterial === 'function'
              ? getExtensionStorageKeyMaterial()
              : 'mongtro-ext-local-storage-v1'.padEnd(32, '0').substring(0, 32);

          // Priority 1: Check for custom API key first
          if (result.customOpenaiApiKey) {
            this.openaiApiKey = result.customOpenaiApiKey;
            console.log('[AISERVICE] Using custom OpenAI API key');
          }
          // Priority 2: Use backend-provided encrypted key
          else if (result.openaiApiKey) {
            try {
              if (typeof decrypt === 'function') {
                try {
                  this.openaiApiKey = await decrypt(result.openaiApiKey, extKey);
                } catch (e1) {
                  if (result.token) {
                    this.openaiApiKey = await decrypt(result.openaiApiKey, result.token);
                  } else {
                    throw e1;
                  }
                }
              } else {
                try {
                  this.openaiApiKey = await this.decrypt(result.openaiApiKey, extKey);
                } catch (e2) {
                  if (result.token) {
                    this.openaiApiKey = await this.decrypt(result.openaiApiKey, result.token);
                  } else {
                    throw e2;
                  }
                }
              }
              console.log('[AISERVICE] Using backend-provided OpenAI API key');
            } catch (error) {
              this.openaiApiKey = result.openaiApiKey;
            }
          }

          resolve();
        }
      );
    });
  }

  // Legacy decrypt method for backward compatibility (uses shared utility if available)
  async decrypt(encryptedText, token) {
    // Try to use shared utility first
    if (typeof decrypt === 'function') {
      return await decrypt(encryptedText, token);
    }
    
    // Fallback to local implementation (same as shared utility)
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
      console.error('[AISERVICE] Decryption error:', error);
      try {
        return decodeURIComponent(escape(atob(encryptedText)));
      } catch (e) {
        return encryptedText;
      }
    }
  }

  async extractQuestionFromConversation(conversationHistory) {
    try {
      if (!this.openaiApiKey) {
        throw new Error('OpenAI API key not set');
      }
      // Cut the conversationHistory to the last 300 words for extraction
      const words = conversationHistory.trim().split(/\s+/);
      const last300Words = words.slice(-300).join(' ');

      console.log('\n========== QUESTION EXTRACTION START ==========');
      console.log('[CONVERSATION HISTORY]:\n', conversationHistory);

      const extractionPrompt = `You are a question extractor. Look at the conversation history and extract the question(s) found in the last 4-5 sentences of the interviewer.

RULES:
- Focus only on the last 4-5 sentences; ignore earlier parts.
- Extract the most recent question(s) within that window (one or two max).
- If there is only one question, return it with no numbering.
- Keep each question concise and complete.
- Determine if answering this question requires:
  1. The company's job description (e.g., questions about the role, company culture, specific requirements mentioned in the job posting)
  2. The candidate's resume (e.g., questions about past experience, skills, education, projects)
- Identify the question type. Currently supported types:
  - "project_explanation": Questions asking about a project, last project, recent project, or specific project work (e.g., "Tell me about your last project", "Explain your recent project", "What did you do in project X?")
  - "general": All other questions

Return your response in the following JSON format:
{
  "question": "the extracted question(s)",
  "requiresJobDescription": true or false,
  "requiresResume": true or false,
  "questionType": "project_explanation" or "general"
}

Be accurate in determining these requirements. For example:
- "Why do you want to work here?" likely requires job description, type: general
- "Tell me about your experience with React" likely requires resume, type: general
- "What's your name?" requires neither, type: general
- "How does your experience align with this role?" requires both, type: general
- "Tell me about your last project" requires resume, type: project_explanation
- "Explain your recent project" requires resume, type: project_explanation`;

      const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.openaiApiKey}`
        },
        body: JSON.stringify({
          model: CONSTANTS?.DEFAULT_MODEL || 'gpt-4o-mini',
          messages: [
            { role: 'system', content: extractionPrompt },
            { role: 'user', content: `Extract ALL questions from this conversation:\n\n${last300Words}` }
          ],
          temperature: 0.3,
          response_format: { type: 'json_object' }
        })
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error('[AISERVICE] Error extracting question:', response.status, errorText);
        // Fallback to using the last part of conversation as question
        return {
          question: conversationHistory,
          requiresJobDescription: false,
          requiresResume: false,
          questionType: 'general'
        };
      }

      const data = await response.json();
      const responseContent = data.choices[0].message.content.trim();
      
      // Parse JSON response
      let extractedData;
      try {
        extractedData = JSON.parse(responseContent);
      } catch (parseError) {
        console.warn('[AISERVICE] Failed to parse JSON response, trying to extract question manually');
        // Fallback: treat the entire response as the question
        extractedData = {
          question: responseContent,
          requiresJobDescription: false,
          requiresResume: false,
          questionType: 'general'
        };
      }
      
      const extractedQuestions = extractedData.question || responseContent;
      const requiresJobDescription = extractedData.requiresJobDescription || false;
      const requiresResume = extractedData.requiresResume || false;
      const questionType = extractedData.questionType || 'general';
      
      console.log('[EXTRACTED QUESTIONS]:', extractedQuestions);
      console.log('[REQUIRES JOB DESCRIPTION]:', requiresJobDescription);
      console.log('[REQUIRES RESUME]:', requiresResume);
      console.log('[QUESTION TYPE]:', questionType);
      console.log('========== QUESTION EXTRACTION END ==========\n');
      
      // Return object with question and metadata
      return {
        question: extractedQuestions,
        requiresJobDescription,
        requiresResume,
        questionType
      };
    } catch (error) {
      console.error('[AISERVICE] Error in extractQuestionFromConversation:', error);
      // Fallback to using the original conversation as question
      return {
        question: conversationHistory,
        requiresJobDescription: false,
        requiresResume: false,
        questionType: 'general'
      };
    }
  }

  async getContextAwareResponse(question, context = '', isDetailed = false, onChunk = null, useSearchModel = false, bulletMode = false, useLongerContext = false, onQuestionExtracted = null) {
    try {
      if (!this.openaiApiKey) {
        throw new Error('OpenAI API key not set');
      }
      
      // Cancel any in-flight request before starting a new one
      if (this.currentAbortController) {
        this.currentAbortController.abort();
      }
      this.currentAbortController = new AbortController();

      // Step 1.5: If longer context is enabled, get last 1000 words for context
      // Otherwise, use the provided context (which is recent context from getRecentContext)
      let conversationHistory = context || question;
      if (useLongerContext) {
        // Get last 1000 words from full conversation history
        const lastNWords = this.getLastNWords(1000);
        conversationHistory = lastNWords.context || conversationHistory;
      }
      
      // Step 1: Extract the final question from the conversation history
      // Use context (conversation history) to extract the specific question to answer
      // For question extraction, always use last 300 words
      let conversationHistoryForExtraction = conversationHistory || question;
      if (conversationHistoryForExtraction) {
        const words = conversationHistoryForExtraction.trim().split(/\s+/);
        conversationHistoryForExtraction = words.slice(-300).join(' ');
      }
      const extractionResult = await this.extractQuestionFromConversation(conversationHistoryForExtraction);
      
      // Handle both old format (string) and new format (object) for backward compatibility
      const extractedQuestion = typeof extractionResult === 'string' 
        ? extractionResult 
        : extractionResult.question;
      const requiresJobDescription = typeof extractionResult === 'object' 
        ? extractionResult.requiresJobDescription 
        : false;
      const requiresResume = typeof extractionResult === 'object' 
        ? extractionResult.requiresResume 
        : false;
      const questionType = typeof extractionResult === 'object' 
        ? extractionResult.questionType 
        : 'general';
      
      // Call the callback with the extracted question if provided
      if (onQuestionExtracted && typeof onQuestionExtracted === 'function') {
        onQuestionExtracted(extractedQuestion);
      }
      
      console.log('[AISERVICE] Original context:', context ? context.substring(0, 200) + '...' : 'none');
      console.log('[AISERVICE] Extracted question:', extractedQuestion);
      console.log('[AISERVICE] Question type:', questionType);
      console.log('[AISERVICE] Requires resume:', requiresResume);
      console.log('[AISERVICE] Requires job description:', requiresJobDescription);

      // Build context from resume and job description ONLY if required
      // For space key (isDetailed=false): use summaries
      // For detailed mode (isDetailed=true): use full context
      let resumeContext = '';
      let jobContext = '';
      
      // Only include resume if required
      if (requiresResume) {
        if (isDetailed) {
          // Detailed mode: use full context
          resumeContext = this.buildResumeContext();
        } else {
          // Space key mode: use summaries if available
          if (this.session && this.session.resumeSummary) {
            resumeContext = `RESUME SUMMARY:\n${this.session.resumeSummary}`;
          }
        }
      }
      
      // Only include job description if required
      if (requiresJobDescription) {
        if (isDetailed) {
          // Detailed mode: use full context
          jobContext = this.buildJobContext();
        } else {
          // Space key mode: use summaries if available
          if (this.session && this.session.jobDescriptionSummary) {
            jobContext = `JOB DESCRIPTION SUMMARY:\n${this.session.jobDescriptionSummary}`;
          }
        }
      }
      
      // Get additional info context (interview type, preferences, etc.)
      const additionalInfoContext = this.buildAdditionalInfoContext();
      
      console.log('[AISERVICE] isDetailed:', isDetailed);
      console.log('[AISERVICE] resumeContext length:', resumeContext ? resumeContext.length : 0);
      console.log('[AISERVICE] jobContext length:', jobContext ? jobContext.length : 0);
      console.log('[AISERVICE] additionalInfoContext length:', additionalInfoContext ? additionalInfoContext.length : 0);
      console.log('[AISERVICE] useSearchModel:', useSearchModel);

      // Get interview type from session
      const isTechnicalInterview = this.session && this.session.isTechnicalInterview ? true : false;
      
      // Step 2: Build system prompt with conversation history as context and extracted question as the question to answer
      // Pass the conversation history (either simple mode or last 1000 words if longer context enabled) as context
      const systemPrompt = this.buildSystemPrompt(
        resumeContext, 
        jobContext, 
        conversationHistory, 
        isDetailed, 
        extractedQuestion, 
        additionalInfoContext, 
        bulletMode,
        questionType,
        isTechnicalInterview
      );

      // Prepare messages - use "Answer the following question" as the user message
      const messages = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `Answer this question: ${extractedQuestion}` }
      ];
      
      // Determine model - fixed selection (search variant if needed)
      const defaultModel = CONSTANTS?.DEFAULT_MODEL || 'gpt-4o-mini';
      const searchModel = CONSTANTS?.DEFAULT_SEARCH_MODEL || 'gpt-4o-mini-search-preview-2025-03-11';
      const model = useSearchModel ? searchModel : defaultModel;

      // Log the full prompt being sent to the LLM
      console.log('\n========== LLM PROMPT START ==========');
      console.log('[SYSTEM PROMPT]:\n', systemPrompt);
      console.log('\n[USER MESSAGE]:\n', `Answer this question: ${extractedQuestion}`);
      console.log('\n[REQUEST DETAILS]:', {
        model: model,
        systemPromptLength: systemPrompt.length,
        extractedQuestion: extractedQuestion,
        isDetailed: isDetailed,
        useSearchModel: useSearchModel,
        hasResume: !!resumeContext,
        hasJobDesc: !!jobContext,
        hasAdditionalInfo: !!additionalInfoContext,
        hasConversationHistory: !!conversationHistory
      });
      console.log('========== LLM PROMPT END ==========\n');
      const requestBody = {
        model: model,
        messages: messages,
        // temperature: 1,
        stream: true // Enable streaming
      };
      
      // Add tools for search model (Ctrl+Space uses this - simple single call with native web search)
      // Call OpenAI API with streaming
      const apiBase = CONSTANTS?.OPENAI_API_BASE || 'https://api.openai.com/v1';
      const endpoint = CONSTANTS?.OPENAI_CHAT_ENDPOINT || '/chat/completions';
      const response = await fetch(`${apiBase}${endpoint}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.openaiApiKey}`
        },
        body: JSON.stringify(requestBody),
        signal: this.currentAbortController.signal
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`OpenAI API error: ${response.status} ${errorText}`);
      }

      // Handle streaming response
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let fullAnswer = '';
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (line.startsWith('data: ') && line !== 'data: [DONE]') {
            try {
              const data = JSON.parse(line.slice(6));
              const chunk = data.choices[0]?.delta?.content || '';
              if (chunk) {
                fullAnswer += chunk;
                // Call the chunk callback if provided
                if (onChunk) {
                  onChunk(chunk);
                }
              }
            } catch (e) {
              // Ignore parse errors
            }
          }
        }
      }

      // Process remaining buffer
      if (buffer.startsWith('data: ') && buffer !== 'data: [DONE]') {
        try {
          const data = JSON.parse(buffer.slice(6));
          const chunk = data.choices[0]?.delta?.content || '';
          if (chunk) {
            fullAnswer += chunk;
            if (onChunk) {
              onChunk(chunk);
            }
          }
        } catch (e) {
          // Ignore parse errors
        }
      }

      const answer = fullAnswer.trim();

      // Don't update chatHistory - we're using captions directly
      // Just update last help timestamp
      this.lastHelpTimestamp = Date.now();
      if (this.session) {
        this.session.lastHelpTimestamp = this.lastHelpTimestamp;
      }

      // Save updated session
      await this.saveSession();

      return answer;
    } catch (error) {
      if (error.name === 'AbortError') {
        console.warn('[AISERVICE] Request was cancelled');
        throw new Error('Request cancelled');
      }
      console.error('[AISERVICE] Error getting AI response:', error);
      throw error;
    } finally {
      // Clear the controller reference if this was the active request
      if (this.currentAbortController && this.currentAbortController.signal.aborted) {
        this.currentAbortController = null;
      } else if (this.currentAbortController) {
        this.currentAbortController = null;
      }
    }
  }

  cancelOngoingResponse() {
    if (this.currentAbortController) {
      this.currentAbortController.abort();
      this.currentAbortController = null;
    }
  }

  buildResumeContext() {
    console.log('[AISERVICE] buildResumeContext - session exists:', !!this.session);
    console.log('[AISERVICE] buildResumeContext - resumeContent exists:', !!(this.session && this.session.resumeContent));
    if (!this.session || !this.session.resumeContent) {
      console.warn('[AISERVICE] No resume information available in session');
      return 'No resume information available.';
    }

    const resume = this.session.resumeContent;
    let context = 'Resume Information:\n';

    // Extract name from various possible locations
    let candidateName = null;
    if (resume.name) {
      candidateName = resume.name;
    } else if (resume.personal_info && resume.personal_info.name) {
      candidateName = resume.personal_info.name;
    }
    
    if (candidateName) {
      context += `CANDIDATE NAME: ${candidateName}\n`;
      context += `IMPORTANT: When introducing yourself or mentioning your name, use "${candidateName}" - NEVER use placeholders like "[your name]" or "[name]"\n`;
    }
    
    if (resume.email) context += `Email: ${resume.email}\n`;
    if (resume.phone) context += `Phone: ${resume.phone}\n`;

    if (resume.experience && Array.isArray(resume.experience)) {
      context += '\nExperience:\n';
      resume.experience.forEach((exp, idx) => {
        context += `${idx + 1}. ${exp.position || 'Position'} at ${exp.company || 'Company'}\n`;
        if (exp.duration) context += `   Duration: ${exp.duration}\n`;
        if (exp.description) context += `   Description: ${exp.description}\n`;
      });
    }

    if (resume.education && Array.isArray(resume.education)) {
      context += '\nEducation:\n';
      resume.education.forEach((edu, idx) => {
        context += `${idx + 1}. ${edu.degree || 'Degree'} from ${edu.institution || 'Institution'}\n`;
        if (edu.year) context += `   Year: ${edu.year}\n`;
      });
    }

    if (resume.skillset && Array.isArray(resume.skillset)) {
      context += '\nSkills:\n';
      resume.skillset.forEach((skill, idx) => {
        context += `${idx + 1}. ${skill.category || 'Category'}: ${Array.isArray(skill.skills) ? skill.skills.join(', ') : skill.skills}\n`;
      });
    }

    return context;
  }

  buildJobContext() {
    console.log('[AISERVICE] buildJobContext - session exists:', !!this.session);
    console.log('[AISERVICE] buildJobContext - jobDescription exists:', !!(this.session && this.session.jobDescription));
    if (!this.session || !this.session.jobDescription) {
      console.warn('[AISERVICE] No job description available in session');
      return 'No job description available.';
    }

    return `Job Description:\n${this.session.jobDescription}`;
  }

  buildAdditionalInfoContext() {
    console.log('[AISERVICE] buildAdditionalInfoContext - session exists:', !!this.session);
    console.log('[AISERVICE] buildAdditionalInfoContext - additionalInfo exists:', !!(this.session && this.session.additionalInfo));
    if (!this.session || !this.session.additionalInfo) {
      return null;
    }

    return `Additional Context from User:\n${this.session.additionalInfo}`;
  }

  async summarizeResume() {
    if (!this.session || !this.session.resumeContent) {
      console.warn('[AISERVICE] No resume content available for summarization');
      return null;
    }

    if (!this.openaiApiKey) {
      console.warn('[AISERVICE] OpenAI API key not available for summarization');
      return null;
    }

    try {
      const resume = this.session.resumeContent;
      
      // Build a prompt for summarization
      const prompt = `Summarize this resume with the following format:

RESUME SUMMARY:
- Tech Stacks (list exactly 10 main technologies/skills): [list 10 main tech stacks]
- Work Experience:
  For each company, provide:
  - Company Name: [name]
  - Dates: [start date - end date or current]
  - Work Summary: [one sentence describing what the candidate did at this company]
- Education: [degree, institution, year if available]
- Personal Information: [name, exact location, contact info if available]

Resume Data:
${JSON.stringify(resume, null, 2)}

Provide ONLY the summary in the format above, no additional commentary.`;

      const apiBase = CONSTANTS?.OPENAI_API_BASE || 'https://api.openai.com/v1';
      const endpoint = CONSTANTS?.OPENAI_CHAT_ENDPOINT || '/chat/completions';
      const model = CONSTANTS?.DEFAULT_MODEL || 'gpt-4o-mini';
      
      const response = await fetch(`${apiBase}${endpoint}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.openaiApiKey}`
        },
        body: JSON.stringify({
          model: model,
          messages: [
            { role: 'system', content: 'You are a resume summarizer. Extract key information in a structured format.' },
            { role: 'user', content: prompt }
          ],
          temperature: 0.3,
        })
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error('[AISERVICE] Error summarizing resume:', response.status, errorText);
        return null;
      }

      const data = await response.json();
      const summary = data.choices[0].message.content.trim();
      
      // Store summary in session
      if (this.session) {
        this.session.resumeSummary = summary;
        await this.saveSession();
      }
      
      console.log('[AISERVICE] Resume summarized successfully');
      return summary;
    } catch (error) {
      console.error('[AISERVICE] Error summarizing resume:', error);
      return null;
    }
  }

  async summarizeJobDescription() {
    if (!this.session || !this.session.jobDescription) {
      console.warn('[AISERVICE] No job description available for summarization');
      return null;
    }

    if (!this.openaiApiKey) {
      console.warn('[AISERVICE] OpenAI API key not available for summarization');
      return null;
    }

    try {
      const jobDescription = this.session.jobDescription;
      
      // Build a prompt for summarization
      const prompt = `Summarize this job description with the following format:

JOB DESCRIPTION SUMMARY:
- Company Name: [company name]
- What the Company Does: [brief description of what the company does]
- Main Tech Stacks: [list main technologies/stack mentioned]
- Who They're Looking For: [brief description of the ideal candidate]

Job Description:
${jobDescription}

Provide ONLY the summary in the format above, no additional commentary.`;

      const apiBase = CONSTANTS?.OPENAI_API_BASE || 'https://api.openai.com/v1';
      const endpoint = CONSTANTS?.OPENAI_CHAT_ENDPOINT || '/chat/completions';
      const model = CONSTANTS?.DEFAULT_MODEL || 'gpt-4o-mini';
      
      const response = await fetch(`${apiBase}${endpoint}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.openaiApiKey}`
        },
        body: JSON.stringify({
          model: model,
          messages: [
            { role: 'system', content: 'You are a job description summarizer. Extract key information in a structured format.' },
            { role: 'user', content: prompt }
          ],
          temperature: 0.3,
        })
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error('[AISERVICE] Error summarizing job description:', response.status, errorText);
        return null;
      }

      const data = await response.json();
      const summary = data.choices[0].message.content.trim();
      
      // Store summary in session
      if (this.session) {
        this.session.jobDescriptionSummary = summary;
        await this.saveSession();
      }
      
      console.log('[AISERVICE] Job description summarized successfully');
      return summary;
    } catch (error) {
      console.error('[AISERVICE] Error summarizing job description:', error);
      return null;
    }
  }

  getRecentContext(minutes, sinceLastHelp = false) {
    const now = Date.now();
    let cutoff = now - (minutes * 60 * 1000);
    
    // If sinceLastHelp is true and we have a lastHelpTimestamp, calculate time since last help
    if (sinceLastHelp && this.lastHelpTimestamp) {
      const timeSinceLastHelp = now - this.lastHelpTimestamp;
      const maxMinutes = minutes; // Maximum minutes to look back (e.g., 1 minute)
      const maxTimeMs = maxMinutes * 60 * 1000;
      
      // Use the time since last help, but cap it at maxMinutes
      // If last help was 3 seconds ago, use 3 seconds; if more than 1 min, use 1 min
      const actualTimeMs = Math.min(timeSinceLastHelp, maxTimeMs);
      cutoff = now - actualTimeMs;
      
      console.log('[AISERVICE] Getting context since last help request');
      console.log('[AISERVICE] Time since last help:', Math.round(timeSinceLastHelp / 1000), 'seconds');
      console.log('[AISERVICE] Using context window:', Math.round(actualTimeMs / 1000), 'seconds');
    }
    
    let recentCaptions = this.captionHistory
      .filter(caption => caption.timestamp >= cutoff)
      .sort((a, b) => a.timestamp - b.timestamp); // Sort by timestamp

    // If sinceLastHelp is true but no new captions found, fall back to regular time window
    if ((!recentCaptions || recentCaptions.length === 0) && sinceLastHelp && this.lastHelpTimestamp) {
      console.log('[AISERVICE] No new captions since last help, falling back to regular context window');
      // Use regular time window (e.g., last 1 minute) instead
      const fallbackCutoff = now - (minutes * 60 * 1000);
      recentCaptions = this.captionHistory
        .filter(caption => caption.timestamp >= fallbackCutoff)
        .sort((a, b) => a.timestamp - b.timestamp);
    }

    if (!recentCaptions || recentCaptions.length === 0) {
      return { lastQuestion: 'No recent conversation in the last few minutes.', context: '' };
    }

    // Get the last caption as the question
    const lastQuestion = recentCaptions[recentCaptions.length - 1].text;
    
    // Get all recent captions as context
    const context = recentCaptions.map(caption => caption.text).join(' ');

    return { lastQuestion, context };
  }

  getFullChatHistory() {
    // Get all captions as full chat history
    const allCaptions = this.captionHistory
      .sort((a, b) => a.timestamp - b.timestamp); // Sort by timestamp

    if (!allCaptions || allCaptions.length === 0) {
      return { lastQuestion: 'No conversation history available.', context: '' };
    }

    // Get the last caption as the question
    const lastQuestion = allCaptions[allCaptions.length - 1].text;
    
    // Get all captions as context
    const context = allCaptions.map(caption => caption.text).join(' ');

    return { lastQuestion, context };
  }

  getLastNWords(n = 1000) {
    // Get all captions sorted by timestamp
    const allCaptions = this.captionHistory
      .sort((a, b) => a.timestamp - b.timestamp);

    if (!allCaptions || allCaptions.length === 0) {
      return { lastQuestion: 'No conversation history available.', context: '' };
    }

    // Get all captions as context
    const fullContext = allCaptions.map(caption => caption.text).join(' ');
    
    // Get last N words
    const words = fullContext.trim().split(/\s+/);
    const lastNWords = words.slice(-n).join(' ');
    
    // Get the last caption as the question
    const lastQuestion = allCaptions[allCaptions.length - 1].text;

    return { lastQuestion, context: lastNWords };
  }

  buildSystemPrompt(resumeContext, jobContext, recentContext, isDetailed = false, lastQuestion = '', additionalInfoContext = null, bulletMode = false, questionType = 'general', isTechnicalInterview = false) {
    // Build base prompt with interview type awareness
    const interviewTypeContext = isTechnicalInterview 
      ? 'This is a TECHNICAL interview (with CEO, CTO, co-founder, or technical interviewer). Provide HIGHLY TECHNICAL answers with deep technical details, architecture discussions, implementation specifics, and advanced concepts.'
      : 'This is a NON-TECHNICAL interview (with recruiter, HR, or non-technical interviewer). Provide answers that are EASY TO UNDERSTAND, avoid heavy technical jargon, explain concepts simply, and focus on business value and outcomes.';
    
    // Build question-type-specific instructions
    let questionTypeInstructions = '';
    if (questionType === 'project_explanation') {
      if (isTechnicalInterview) {
        questionTypeInstructions = `
PROJECT EXPLANATION - TECHNICAL INTERVIEW:
- If web search is available, research DEEPLY about the project to gather real facts, context, and historical information
- Use web search to find actual details about the project: company information, technology stack at the time, industry context, market situation, challenges the industry faced, and any public information about the project
- Explain the project as if you ACTUALLY PARTICIPATED in it at that time - speak from first-hand experience
- Include real facts and context: what the industry/market situation was like at that time, what technologies were popular or emerging, what challenges existed, and how the project addressed them
- Provide a HIGHLY TECHNICAL explanation with detailed architecture, design patterns, technical stack, algorithms, data structures
- Discuss technical challenges you faced, solutions you implemented, optimizations you made, and trade-offs you considered
- Mention specific technologies, frameworks, libraries, and their versions that were relevant at that time
- Explain technical decisions you made, scalability considerations, performance optimizations you implemented
- Use technical terminology and industry-standard concepts
- Include code-level details, system design, and technical implementation specifics
- Don't just read from the resume - bring in real-world context, facts, and your actual experience working on the project
- Reference the actual situation at the time: what was happening in the industry, what problems needed solving, what constraints you worked under`;
      } else {
        questionTypeInstructions = `
PROJECT EXPLANATION - NON-TECHNICAL INTERVIEW:
- If web search is available, research DEEPLY about the project to gather real facts, context, and historical information
- Use web search to find actual details about the project: company information, what was happening in the industry at that time, market context, and any public information about the project
- Explain the project as if you ACTUALLY PARTICIPATED in it at that time - speak from first-hand experience
- Include real facts and context: what the industry/market situation was like at that time, what challenges existed, and how the project addressed them
- Describe what the project does in plain terms (e.g., "It's a tool that helps improve interviews").

- Focus on why it matters and what problem it solves (e.g., "It makes hiring faster and helps companies pick the right people").

- Talk about the impact and business value (e.g., "This project helps teams work better and companies save time").

- Use simple analogies if possible (e.g., "It’s like a GPS for interviews—guiding you to the right person").

- Keep it about what it does and why it's helpful, not too much on the how.

- Be a little bit technical.

- Don't just read from the resume - bring in real-world context, facts, and your actual experience working on the project

- Reference the actual situation at the time: what was happening in the industry, what problems needed solving, what constraints you worked under."`;
      }
    }
    
    let prompt = `You are helping a candidate during a job interview. ${interviewTypeContext}

Provide ${isDetailed ? 'a VERY DETAILED and COMPREHENSIVE' : 'a detailed, natural'} answer that the candidate can say verbatim to the interviewer.
${questionTypeInstructions}

CRITICAL REQUIREMENTS - ANSWER LIKE A REAL PERSON IN AN INTERVIEW:
- Answer the questions like a real person would in an interview. Keep it conversational and natural, with a friendly, confident tone.
- Use simple language, avoid sounding too formal or robotic, and share real-world examples when possible.
- Make your responses engaging, showing both enthusiasm and humility, just like you would when speaking to a recruiter or hiring manager.
- Sound natural and human - avoid AI-like patterns, overly structured responses, or perfect grammar that sounds scripted.
- Use casual transitions like "So...", "Well...", "I mean...", "Actually..." to make it flow naturally.
- Show personality and authenticity - it's okay to be slightly imperfect, just like real human speech.
- Answer ALL questions asked by the interviewer ${isDetailed ? 'in EXTREME DETAIL with comprehensive explanations, examples, and context' : 'in detail'}
- If multiple questions were asked (e.g., "Tell me about yourself and what's your experience with React?"), address EACH question in your response
- Structure your answer to flow naturally while covering all questions
- Use the conversation context to understand the flow
- Don't use awesome words like appreciate or diverse, instead use simple and commonly used words in the life like thank you or many.
- Answer AS THE CANDIDATE would naturally speak - use first person ("I", "my", "me")
- When explaining any technology or concept, include a concrete real-world example to make it clearer
    ${isDetailed ? `- DETAIL MODE: Provide VERY DETAILED answers with:
  * Comprehensive explanations with multiple examples
  * Specific technical details, methodologies, and processes
  * Real-world scenarios and use cases from the resume
  * Step-by-step breakdowns when explaining concepts
  * Detailed context and background information
  * Multiple perspectives or approaches when relevant
  * Use REAL information from the resume: actual name, company names, project names, technologies, and experiences
  * NEVER use placeholders like "[your name]", "[Company Name]", "[Project Name]", or "[Technology]" - ALWAYS use the actual names from the resume
  * If the resume shows a name, use that exact name when introducing yourself (e.g., "Hello, I'm [ACTUAL NAME FROM RESUME]")
  * Be EXTREMELY thorough - provide 3-5x more detail than a normal answer` : ''}
${bulletMode ? `- BULLET MODE: Present the answer using clear and concise bullet points. Structure the response as a list.
  * First, list the bullet titles (e.g., "A, B, C") before expanding them.
  * Then provide the detailed bullet items for each title.` : ''}
- NO tips, instructions, or meta-commentary like "Remember to mention..." or "You should say..."
${isDetailed ? `- NO phrases like "Based on your resume" or "According to your experience" - just answer naturally with extensive detail` : ''}
- Answer as if you ARE the candidate speaking directly to the interviewer
- Be professional and ${isDetailed ? 'EXTREMELY detailed and comprehensive' : 'detailed'}, and make everything to help me pass this interview
- When using web search (via built-in tool), use results to provide current, accurate information when relevant, but still answer in first person as the candidate
- NEVER include URLs, website links, or hyperlinks in your response - the candidate will be speaking aloud and cannot say URLs
- If you need to reference a website or online resource, summarize its content or key information instead of providing the link
- Replace any website references with a brief summary of what can be found there (e.g., instead of "check example.com", say "there are resources available online about this topic")

CRITICAL: Handle transcription errors and mispronunciations intelligently:
- The user's input (question and conversation history) may contain mispronounced or mistranscribed words due to accents or speech recognition errors.
- Use context clues from the RESUME INFORMATION, JOB DESCRIPTION, and CONVERSATION HISTORY to guess the correct words.
- Examples: "a punjab plane" might mean "OpenZeppelin" (if OpenZeppelin is in the resume), "perpetual text" might mean "perpetual DEX" (in a blockchain interview context).
- Match phonetically similar words to known terms from the provided contexts.
- If a word doesn't make sense in context, try to find the closest matching relevant term from the provided information.`;

    // Add additional info context if provided (interview type, preferences, etc.)
    if (additionalInfoContext) {
      prompt += `\n\nUSER'S ADDITIONAL INSTRUCTIONS:\n${additionalInfoContext}\n- Follow these additional instructions provided by the user when answering questions.`;
    }

    // Build the prompt with all context sections
    let contextSections = [];
    
    if (resumeContext) {
      contextSections.push(`RESUME INFORMATION:\n${resumeContext}`);
    }
    
    if (jobContext) {
      contextSections.push(`JOB DESCRIPTION:\n${jobContext}`);
    }
    
    if (recentContext && recentContext.trim()) {
      contextSections.push(`CONVERSATION HISTORY (for context):\n${recentContext}`);
    }
    
    if (lastQuestion && lastQuestion.trim()) {
      contextSections.push(`QUESTION(S) TO ANSWER:\n${lastQuestion}`);
    }
    
    const fullContext = contextSections.length > 0 
      ? `\n\n${contextSections.join('\n\n---\n\n')}\n\n`
      : '\n\n';
    
    prompt += `${fullContext}INSTRUCTIONS:
- MOST IMPORTANT: Answer like a real person would in an interview - conversational, natural, friendly, and confident. Show enthusiasm and humility. Avoid sounding like an AI or reading from a script.
- Use ALL the information provided above (Resume, Job Description, Conversation History) to answer the question(s)
- If web search is available via built-in tool, use it to get current information when relevant
- Combine information from your resume with web search results when relevant
- Answer ALL questions asked - if there are multiple questions, address each one
- Answer in first person as the candidate would naturally speak - use casual, conversational language
- Make it sound like you're having a real conversation, not delivering a prepared speech
${isDetailed ? `- DETAIL MODE ACTIVE: Provide an EXTREMELY DETAILED and COMPREHENSIVE answer:
  * Include extensive explanations, examples, and real-world scenarios
  * Provide step-by-step breakdowns and multiple perspectives
  * Use specific technical details and methodologies
  * Reference concrete examples from the resume
  * Be thorough - aim for 3-5x more detail than a standard answer
  * Cover all aspects of the question comprehensively
  * But still keep it conversational and natural - don't sound like you're reading from a textbook` : ''}
${isTechnicalInterview ? `- TECHNICAL INTERVIEW MODE: Provide HIGHLY TECHNICAL answers with deep technical details, architecture, implementation specifics, and advanced concepts - but explain them in a conversational, engaging way` : `- NON-TECHNICAL INTERVIEW MODE: Keep answers EASY TO UNDERSTAND, avoid heavy technical jargon, explain concepts simply, focus on business value`}

Provide ${isDetailed ? 'an EXTREMELY DETAILED and COMPREHENSIVE' : 'a natural, conversational'} answer that the candidate can say immediately to the interviewer. Answer in first person as the candidate, sounding like a real person having a genuine conversation.`;
    
    console.log('[AISERVICE] System prompt context sections:');
    console.log('[AISERVICE] - Resume:', resumeContext ? `YES (${resumeContext.length} chars)` : 'NO');
    console.log('[AISERVICE] - Job Description:', jobContext ? `YES (${jobContext.length} chars)` : 'NO');
    console.log('[AISERVICE] - Additional Info:', additionalInfoContext ? `YES (${additionalInfoContext.length} chars)` : 'NO');
    console.log('[AISERVICE] - Conversation History:', recentContext && recentContext.trim() ? `YES (${recentContext.length} chars)` : 'NO');
    console.log('[AISERVICE] - Last Question:', lastQuestion ? `YES (${lastQuestion.length} chars)` : 'NO');
    console.log('[AISERVICE] - Total context sections:', contextSections.length);

    return prompt;
  }

  addCaption(text, timestamp = null) {
    const now = timestamp || Date.now();
    
    // Track when this caption text was first seen
    if (!this.captionFirstSeen.has(text)) {
      this.captionFirstSeen.set(text, now);
    }
    
    // Use the first-seen timestamp for this caption
    const captionTimestamp = this.captionFirstSeen.get(text);
    
    this.captionHistory.push({
      text,
      timestamp: captionTimestamp
    });

    // Keep only last N captions
    const maxCaptions = CONSTANTS?.MAX_CAPTIONS || 100;
    if (this.captionHistory.length > maxCaptions) {
      this.captionHistory = this.captionHistory.slice(-maxCaptions);
    }
  }

  addUserPrompt(prompt) {
    // Add user prompt to conversation history as if it were a caption
    // This ensures it's included in the conversation context for future help requests
    const now = Date.now();
    const promptText = `[You] ${prompt}`;
    
    this.captionHistory.push({
      text: promptText,
      timestamp: now
    });

    // Keep only last N items
    const maxCaptions = CONSTANTS?.MAX_CAPTIONS || 100;
    if (this.captionHistory.length > maxCaptions) {
      this.captionHistory = this.captionHistory.slice(-maxCaptions);
    }
    
    console.log('[AISERVICE] User prompt added to conversation history:', promptText);
  }
  
  syncCaptions(transcripts) {
    // Sync captions from transcript sync, preserving first-seen timestamps
    const now = Date.now();
    
    // Get all transcripts in order (using 'all' array if available)
    let allCaptions;
    if (transcripts.all && Array.isArray(transcripts.all)) {
      allCaptions = transcripts.all;
    } else {
      // Fallback: combine and sort by order if available
      allCaptions = [
        ...transcripts.interviewer.map(t => ({ ...t, speaker: 'interviewer' })),
        ...transcripts.user.map(t => ({ ...t, speaker: 'user' }))
      ];
      if (allCaptions[0] && allCaptions[0].order !== undefined) {
        allCaptions.sort((a, b) => (a.order || 0) - (b.order || 0));
      }
    }
    
    // Clear and rebuild caption history
    this.captionHistory = [];
    
    // Assign timestamps based on order (earlier items get earlier timestamps)
    // Use 1 second spacing between items to maintain order
    const spacing = 1000; // 1 second
    const totalItems = allCaptions.length;
    
    allCaptions.forEach((item, index) => {
      const text = item.text;
      
      // Calculate timestamp: earlier items get earlier timestamps
      // Most recent item gets current time, older items get progressively earlier
      const positionFromEnd = totalItems - index - 1;
      let calculatedTimestamp = now - (positionFromEnd * spacing);
      
      // If we've seen this exact caption text before, use its first-seen timestamp
      if (this.captionFirstSeen.has(text)) {
        // Use the first-seen timestamp (preserves when we first saw this exact text)
        this.captionHistory.push({
          text: text,
          timestamp: this.captionFirstSeen.get(text)
        });
      } else {
        // First time seeing this exact caption text
        // If we have a lastHelpTimestamp, ensure new captions come after it
        if (this.lastHelpTimestamp && calculatedTimestamp <= this.lastHelpTimestamp) {
          // This is a new caption that appeared after help was requested
          // Assign it a timestamp after the last help request
          calculatedTimestamp = this.lastHelpTimestamp + (index * spacing) + spacing;
        }
        
        this.captionFirstSeen.set(text, calculatedTimestamp);
        this.captionHistory.push({
          text: text,
          timestamp: calculatedTimestamp
        });
      }
    });
    
    // Sort by timestamp to maintain chronological order
    this.captionHistory.sort((a, b) => a.timestamp - b.timestamp);
  }

  async saveSession() {
    if (this.session) {
      this.session.chatHistory = this.chatHistory;
      await chrome.storage.local.set({ currentSession: this.session });
    }
  }

  async setOpenAIApiKey(apiKey) {
    this.openaiApiKey = apiKey;
    await chrome.storage.local.set({ openaiApiKey: apiKey });
  }
}

