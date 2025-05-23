// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

document.addEventListener("DOMContentLoaded", () => {
    const chatBox = document.getElementById("chatBox");
    const chatInput = document.getElementById("chatInput");
    const sendButton = document.getElementById("sendButton");
    const recordButton = document.getElementById("recordButton");
    const clearChatButton = document.getElementById("clearChatButton");
    const statusMessage = document.getElementById("statusMessage");
    const themeToggleButton = document.getElementById("themeToggleButton");

    // These values are now passed from the template
     const SHOULD_STREAM_AUDIO_FROM_CHAT_COMPLETION_BROWSER = window.SHOULD_STREAM_AUDIO_FROM_CHAT_COMPLETION_BROWSER;
     const AZURE_SPEECH_REGION_BROWSER = window.AZURE_SPEECH_REGION_BROWSER;

    let speechRecognizer;
    let audioContext;
    let audioQueue = [];
    let isPlaying = false;
    let conversationHistory = []; // Stores the history of the conversation

    // Initialize Speech Recognizer if keys are available
    if (AZURE_SPEECH_REGION_BROWSER) {
        initializeSpeechRecognizer();
    } else {
        console.warn("Azure Speech region not provided. Speech-to-text will be disabled.");
        if (recordButton) recordButton.disabled = true;
        updateStatus("Speech-to-text disabled (config missing).", "warning");
    }

    function initializeSpeechRecognizer() {
        // Fetch token from backend - this example uses key directly for simplicity in some SDK versions
        // but a token endpoint is better practice. The python sample uses /sts_token
        fetch('/sts_token')
            .then(response => {
                if (!response.ok) {
                    throw new Error(`Failed to fetch STS token: ${response.statusText}`);
                }
                return response.json();
            })
            .then(data => {
                if (data.error) {
                    console.error("Error fetching STS token:", data.error);
                    updateStatus(`STT Error: ${data.error}`, "error");
                    if (recordButton) recordButton.disabled = true;
                    return;
                }

                const speechConfig = SpeechSDK.SpeechConfig.fromSubscription(data.token, data.region);
                speechConfig.speechRecognitionLanguage = "en-US"; // Or make configurable
                const audioConfig = SpeechSDK.AudioConfig.fromDefaultMicrophoneInput();
                speechRecognizer = new SpeechSDK.SpeechRecognizer(speechConfig, audioConfig);

                speechRecognizer.recognizing = (s, e) => {
                    // console.log(`RECOGNIZING: Text=${e.result.text}`);
                    // chatInput.value = e.result.text; // Update input field as user speaks
                };

                speechRecognizer.recognized = (s, e) => {
                    if (e.result.reason === SpeechSDK.ResultReason.RecognizedSpeech) {
                        console.log(`RECOGNIZED: Text=${e.result.text}`);
                        chatInput.value = e.result.text;
                        sendMessage(e.result.text); // Send message once recognized
                    } else if (e.result.reason === SpeechSDK.ResultReason.NoMatch) {
                        console.log("NOMATCH: Speech could not be recognized.");
                        updateStatus("Speech not recognized.", "warning");
                    }
                    if (recordButton) recordButton.textContent = "🎤 Record";
                    chatInput.disabled = false;
                    sendButton.disabled = false;
                };

                speechRecognizer.canceled = (s, e) => {
                    console.log(`CANCELED: Reason=${e.reason}`);
                    if (e.reason === SpeechSDK.CancellationReason.Error) {
                        console.error(`CANCELED: ErrorCode=${e.errorCode}`);
                        console.error(`CANCELED: ErrorDetails=${e.errorDetails}`);
                        updateStatus("Speech recognition error.", "error");
                    }
                    if (speechRecognizer) speechRecognizer.stopContinuousRecognitionAsync();
                    if (recordButton) recordButton.textContent = "🎤 Record";
                    chatInput.disabled = false;
                    sendButton.disabled = false;
                };

                speechRecognizer.sessionStarted = (s, e) => {
                    console.log("Speech session started.");
                    updateStatus("Listening...", "info");
                    if (recordButton) recordButton.textContent = "🛑 Stop";
                    chatInput.disabled = true;
                    sendButton.disabled = true;
                };

                speechRecognizer.sessionStopped = (s, e) => {
                    console.log("Speech session stopped.");
                    updateStatus("Processing speech...", "info"); // Or clear status
                    if (speechRecognizer) speechRecognizer.stopContinuousRecognitionAsync();
                    if (recordButton) recordButton.textContent = "🎤 Record";
                    chatInput.disabled = false;
                    sendButton.disabled = false;
                };

                if (recordButton) recordButton.disabled = false;
                console.log("Speech recognizer initialized.");
                updateStatus("Ready for speech input.", "info");

            })
            .catch(error => {
                console.error("Failed to initialize speech recognizer:", error);
                updateStatus("STT init failed.", "error");
                if (recordButton) recordButton.disabled = true;
            });
    }


    function addMessageToChatbox(message, fromUser) {
        const messageElement = document.createElement("div");
        messageElement.classList.add("mb-2", "p-3", "rounded-lg", "max-w-3/4", "break-words");
        messageElement.textContent = message;

        if (fromUser) {
            messageElement.classList.add("bg-blue-500", "text-white", "self-end", "ml-auto");
            // Add to conversation history
            conversationHistory.push({ role: "user", content: message });
        } else {
            messageElement.classList.add("bg-gray-200", "dark:bg-gray-700", "text-gray-800", "dark:text-gray-200", "self-start", "mr-auto");
            // Add to conversation history
            conversationHistory.push({ role: "assistant", content: message });
        }
        chatBox.appendChild(messageElement);
        chatBox.scrollTop = chatBox.scrollHeight; // Scroll to bottom
    }

    function sendMessage(messageText) {
        const message = messageText || chatInput.value.trim();
        if (!message) return;

        addMessageToChatbox(message, true);
        chatInput.value = "";
        updateStatus("Sending message...", "info");
        sendButton.disabled = true;
        chatInput.disabled = true;

        fetch("/chat", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ message: message, conversation_history: conversationHistory.slice(0, -1) }) // Send history *before* current user message
        })
        .then(response => {
            if (!response.ok) {
                // Try to parse error from server, otherwise use status text
                return response.json().then(errData => {
                    throw new Error(errData.error || `HTTP error ${response.status}`);
                }).catch(() => { // Catch if errData parsing fails
                    throw new Error(`HTTP error ${response.status} - ${response.statusText}`);
                });
            }
            return response.json();
        })
        .then(data => {
            handleMessage(data);
            updateStatus("Message received.", "info");
        })
        .catch(error => {
            console.error("Error sending message:", error);
            addMessageToChatbox(`Error: ${error.message}`, false);
            updateStatus(`Error: ${error.message}`, "error");
        })
        .finally(() => {
            sendButton.disabled = false;
            chatInput.disabled = false;
            chatInput.focus();
        });
    }

    function handleMessage(message) {
        if (message.error) {
            console.error("Received error from server:", message.error);
            addMessageToChatbox(message.text || message.error, false); // Display error text if available
            updateStatus(`Server error: ${message.error}`, "error");
            return;
        }

        addMessageToChatbox(message.text, false);

        if (message.conversation_history) {
            // Update local conversation history if server sends it back
            // This is useful if the server modifies or truncates history
            conversationHistory = message.conversation_history;
        }


        // Play audio if SHOULD_STREAM_AUDIO_FROM_CHAT_COMPLETION_BROWSER is true and audio data is present
        if (SHOULD_STREAM_AUDIO_FROM_CHAT_COMPLETION_BROWSER && message.audio) {
            try {
                const audioData = base64ToArrayBuffer(message.audio);
                playAudioQueue(audioData);
            } catch (e) {
                console.error("Error processing audio data:", e);
                updateStatus("Error playing audio.", "error");
            }
        }
    }

    function base64ToArrayBuffer(base64) {
        const binaryString = window.atob(base64);
        const len = binaryString.length;
        const bytes = new Uint8Array(len);
        for (let i = 0; i < len; i++) {
            bytes[i] = binaryString.charCodeAt(i);
        }
        return bytes.buffer;
    }

    function playAudioQueue(arrayBuffer) {
        if (!audioContext) {
            audioContext = new (window.AudioContext || window.webkitAudioContext)();
        }
        audioQueue.push(arrayBuffer);
        if (!isPlaying) {
            playNextInQueue();
        }
    }

    function playNextInQueue() {
        if (audioQueue.length === 0) {
            isPlaying = false;
            return;
        }
        isPlaying = true;
        const arrayBuffer = audioQueue.shift();

        audioContext.decodeAudioData(arrayBuffer, (buffer) => {
            const source = audioContext.createBufferSource();
            source.buffer = buffer;
            source.connect(audioContext.destination);
            source.start(0);
            source.onended = () => {
                playNextInQueue();
            };
        }, (error) => {
            console.error("Error decoding audio data:", error);
            updateStatus("Error playing audio.", "error");
            isPlaying = false; // Ensure we can try playing next if this one fails
            playNextInQueue(); // Try next item
        });
    }
    
    function updateStatus(message, type = "info") {
        if (!statusMessage) return;
        statusMessage.textContent = message;
        statusMessage.className = 'status-message text-sm p-2 my-2 rounded-md'; // Reset classes
        if (type === "error") {
            statusMessage.classList.add('bg-red-100', 'text-red-700', 'dark:bg-red-700', 'dark:text-red-100');
        } else if (type === "warning") {
            statusMessage.classList.add('bg-yellow-100', 'text-yellow-700', 'dark:bg-yellow-700', 'dark:text-yellow-100');
        } else { // info
            statusMessage.classList.add('bg-blue-100', 'text-blue-700', 'dark:bg-blue-700', 'dark:text-blue-100');
        }
    }

    // Event Listeners
    if (sendButton) {
        sendButton.addEventListener("click", () => sendMessage());
    }

    if (chatInput) {
        chatInput.addEventListener("keypress", (event) => {
            if (event.key === "Enter") {
                sendMessage();
            }
        });
    }

    if (recordButton) {
        recordButton.addEventListener("click", () => {
            if (!speechRecognizer) {
                updateStatus("Speech recognizer not initialized.", "error");
                return;
            }
            if (recordButton.textContent === "🎤 Record") {
                try {
                    speechRecognizer.startContinuousRecognitionAsync(
                        () => { console.log("Recognition started."); },
                        err => {
                            console.error(`ERROR starting recognition: ${err}`);
                            updateStatus("Could not start mic.", "error");
                            speechRecognizer.stopContinuousRecognitionAsync();
                        }
                    );
                } catch (err) {
                     console.error(`ERROR during startContinuousRecognitionAsync call: ${err}`);
                     updateStatus("Mic access error.", "error");
                }
            } else {
                speechRecognizer.stopContinuousRecognitionAsync(
                    () => { console.log("Recognition stopped."); },
                    err => { console.error(`ERROR stopping recognition: ${err}`); }
                );
            }
        });
    }
    
    if (clearChatButton) {
        clearChatButton.addEventListener("click", () => {
            chatBox.innerHTML = "";
            conversationHistory = [];
            audioQueue = []; // Clear any pending audio
            if (isPlaying && audioContext) {
                // This is a bit tricky, ideally, you'd stop the current sound
                // For simplicity, we're just clearing the queue.
                // A more robust solution might involve stopping the current AudioBufferSourceNode.
            }
            updateStatus("Chat cleared.", "info");
        });
    }

    // Theme Toggle
    if (themeToggleButton) {
        themeToggleButton.addEventListener('click', () => {
            document.documentElement.classList.toggle('dark');
            localStorage.setItem('theme', document.documentElement.classList.contains('dark') ? 'dark' : 'light');
            updateThemeIcon();
        });
    }

    function updateThemeIcon() {
        if (!themeToggleButton) return;
        const isDarkMode = document.documentElement.classList.contains('dark');
        themeToggleButton.innerHTML = isDarkMode 
            ? `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-sun"><circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/></svg>` // Sun icon
            : `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-moon"><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/></svg>`; // Moon icon
    }
    
    // Load theme from local storage
    if (localStorage.getItem('theme') === 'dark' || (!localStorage.getItem('theme') && window.matchMedia('(prefers-color-scheme: dark)').matches)) {
        document.documentElement.classList.add('dark');
    } else {
        document.documentElement.classList.remove('dark');
    }
    updateThemeIcon();

    // Initial status
    updateStatus("Ready. Type a message or use the microphone.", "info");
});