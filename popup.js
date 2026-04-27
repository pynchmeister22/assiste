const authService = new AuthService();
const generateSessionId = () => `interview-${Date.now()}-${Math.floor(Math.random() * 100000)}`;

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

document.addEventListener('DOMContentLoaded', async () => {
  const loadingView = document.getElementById('loadingView');
  const loadingStatus = document.getElementById('loadingStatus');
  const sessionView = document.getElementById('sessionView');
  const resumeSelect = document.getElementById('resumeSelect');
  const jobDescriptionTextarea = document.getElementById('jobDescription');
  const additionalInfoTextarea = document.getElementById('additionalInfo');
  const createSessionButton = document.getElementById('createSessionButton');
  const clearSessionButton = document.getElementById('clearSessionButton');

  showLoadingView();
  if (loadingStatus) loadingStatus.textContent = 'Connecting…';

  try {
    await authService.fetchAndStoreApiKeys();
    await authService.getCurrentUser();
    await showSessionView();
  } catch (e) {
    console.error(e);
    if (loadingStatus) {
      loadingStatus.textContent =
        'Could not reach the server. Start the backend and check apiBaseUrl in config.js.';
    }
  }

  clearSessionButton.addEventListener('click', async () => {
    await authService.clearLocalSession();
    showLoadingView();
    if (loadingStatus) loadingStatus.textContent = 'Connecting…';
    try {
      await authService.fetchAndStoreApiKeys();
      await authService.getCurrentUser();
      await showSessionView();
    } catch (e) {
      if (loadingStatus) {
        loadingStatus.textContent = 'Could not reach the server.';
      }
    }
  });

  // Create session handler
  createSessionButton.addEventListener('click', async () => {
    const resumeId = resumeSelect.value;
    const jobDescription = jobDescriptionTextarea.value.trim();
    const additionalInfo = additionalInfoTextarea.value.trim();
    const interviewTitle = extractCompanyName(jobDescription) || 'Interview';

    if (!resumeId) {
      alert('Please select a resume');
      return;
    }

    const fullResume = await authService.fetchResumeById(resumeId);
    if (!fullResume) {
      alert('Could not load resume from the server. Check that the backend is running and apiBaseUrl is correct.');
      return;
    }
    const resumeContent = authService.normalizeResumeContent(fullResume);
    if (!authService.resumeBodyLooksUsable(resumeContent)) {
      alert('Resume loaded from the server but has no usable profile fields.');
      return;
    }

    try {
      createSessionButton.disabled = true;
      createSessionButton.innerHTML = '<span class="loading-spinner"></span> Starting...';
      createSessionButton.classList.add('loading');

      // Create session and store it (resume body from GET /api/resumes/:id)
      const session = {
        sessionId: generateSessionId(),
        resumeId,
        resumeContent,
        jobDescription,
        additionalInfo,
        interviewTitle,
        createdAt: Date.now(),
        chatHistory: []
      };

      await chrome.storage.local.set({ currentSession: session });

      // Send message to content script to show the assistant
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab) {
        throw new Error('No active tab found');
      }

      // Check if content script is ready
      try {
        const response = await chrome.tabs.sendMessage(tab.id, {
          action: 'startAssistant',
          session
        });
        
        if (response && response.success) {
          window.close();
        } else {
          throw new Error('Failed to start assistant: ' + (response?.error || 'Unknown error'));
        }
      } catch (error) {
        // If content script isn't ready, inject all required scripts first
        if (error.message.includes('Could not establish connection') || error.message.includes('AIService class not found')) {
          console.log('Content script not ready, injecting all required scripts...');
          
          // Inject all required scripts in parallel for maximum speed
          const scripts = [
            'config.js',
            'utils/constants.js',
            'utils/crypto.js',
            'authService.js',
            'aiService.js',
            'captionService.js',
            'content.js',
            'contentScript.js'
          ];
          
          // Inject all scripts in parallel - Chrome handles execution order automatically
          const injectionPromises = scripts.map(script => 
            chrome.scripting.executeScript({
              target: { tabId: tab.id },
              files: [script]
            }).then(() => {
              console.log(`Injected ${script}`);
            }).catch(injectError => {
              console.error(`Error injecting ${script}:`, injectError);
              // Continue even if one fails
            })
          );
          
          // Wait for all injections to complete
          await Promise.all(injectionPromises);
          
          // Check immediately first, then poll with minimal delays
          let retries = 5; // Reduced retries since we check immediately
          let ready = false;
          
          // Immediate check before polling
          try {
            const immediateCheck = await chrome.tabs.sendMessage(tab.id, {
              action: 'checkReady'
            });
            if (immediateCheck && immediateCheck.ready) {
              ready = true;
              console.log('Content scripts are ready (immediate check)');
            }
          } catch (e) {
            // Not ready yet, will poll
          }
          
          // Poll with minimal delay if not ready immediately
          while (retries > 0 && !ready) {
            // Minimal delay for faster detection (50ms instead of 100ms)
            await new Promise(resolve => setTimeout(resolve, 50));
            
            try {
              const checkResponse = await chrome.tabs.sendMessage(tab.id, {
                action: 'checkReady'
              });
              
              if (checkResponse && checkResponse.ready) {
                ready = true;
                console.log('Content scripts are ready');
                break;
              }
            } catch (checkError) {
              // Not ready yet, continue waiting
              console.log(`Waiting for scripts to load... (${retries} retries left)`);
            }
            
            retries--;
          }
          
          if (!ready) {
            throw new Error('Content scripts failed to load after injection. Please reload the page and try again.');
          }
          
          // Try starting the assistant
          const response = await chrome.tabs.sendMessage(tab.id, {
            action: 'startAssistant',
            session
          });
          
          if (response && response.success) {
            window.close();
          } else {
            throw new Error('Failed to start assistant after injection: ' + (response?.error || 'Unknown error'));
          }
        } else {
          throw error;
        }
      }
    } catch (error) {
      console.error('Error starting interview:', error);
      alert('Error starting interview: ' + error.message + '\n\nCheck the console for more details.');
      createSessionButton.disabled = false;
      createSessionButton.textContent = 'Start Interview';
      createSessionButton.classList.remove('loading');
    }
  });

  function showLoadingView() {
    loadingView.classList.remove('hidden');
    sessionView.classList.add('hidden');
  }

  async function showSessionView() {
    loadingView.classList.add('hidden');
    sessionView.classList.remove('hidden');

    // Load resumes
    resumeSelect.innerHTML = '<option value="">Loading resumes...</option>';
    const resumes = await authService.fetchResumes();

    if (resumes.length === 0) {
      resumeSelect.innerHTML = '<option value="">No resumes found</option>';
      return;
    }

    resumeSelect.innerHTML = '<option value="">Select a resume...</option>';
    resumes.forEach(resume => {
      const option = document.createElement('option');
      option.value = resume._id;
      // Use nickname if available, otherwise use the person's name from personal_info
      const displayName = resume.nickname || 
        (resume.content?.personal_info?.name) || 
        resume.filename || 
        `Resume ${resume._id}`;
      option.textContent = displayName;
      resumeSelect.appendChild(option);
    });
  }
});
