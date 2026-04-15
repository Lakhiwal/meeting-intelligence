let currentSessionId = null;
let pendingFile = null;
let animationId;
let audioContext;
let analyser;
let mediaRecorder;
let audioChunks = [];
let currentTranscripts = { original: "", translated: "" };

const startBtn = document.getElementById("startBtn");
const stopBtn = document.getElementById("stopBtn");
const statusText = document.getElementById("statusText");
const transcriptDiv = document.getElementById("transcript");
const summaryDiv = document.getElementById("summary");
const resultsGrid = document.getElementById("resultsGrid");
const tracker = document.getElementById("processingTracker");
const cancelBtn = document.getElementById("cancelBtn");

let pollInterval;

// Session Recovery: Re-attach to ongoing process on page load
window.addEventListener("DOMContentLoaded", () => {
    const savedSessionId = localStorage.getItem("activeMeetingSession");
    if (savedSessionId) {
        console.log("Resuming active session:", savedSessionId);
        currentSessionId = savedSessionId;

        // Hide recorder, show tracker
        const recorderCard = document.getElementById("recorderCard");
        if (recorderCard) recorderCard.classList.add("hidden");

        tracker.style.display = "block";
        cancelBtn.style.display = "block";

        startPolling(savedSessionId);

        // Show status toast
        showToast("Re-attaching to your last session...", "ph ph-plugs-connected");
    }
});

// Helper to show modern toasts
function showToast(msg, icon = "ph ph-info", type = "info") {
    const toast = document.getElementById("toast");
    if (!toast) return;

    toast.innerHTML = `<i class="${icon}"></i> ${msg}`;

    // Type specific styling
    if (type === "success") toast.style.borderColor = "#10b981";
    else if (type === "info") toast.style.borderColor = "var(--primary)";
    else if (type === "error") toast.style.borderColor = "#ef4444";

    toast.classList.add("show");
    setTimeout(() => toast.classList.remove("show"), 3000);
}

// On load: if mic is unavailable (non-secure context), adapt the UI
window.addEventListener("DOMContentLoaded", () => {
    if (!window.isSecureContext || !navigator.mediaDevices) {
        startBtn.disabled = true;
        startBtn.innerHTML = `<i class="ph ph-microphone-slash"></i> Mic Unavailable`;
        startBtn.title = "Microphone requires HTTPS. Use file upload or visit via https://";
        // Make the upload button more prominent
        const uploadBtn = document.getElementById("uploadBtn");
        if (uploadBtn) {
            uploadBtn.style.background = "var(--primary)";
            uploadBtn.style.border = "none";
            uploadBtn.style.color = "#fff";
            uploadBtn.innerHTML = `<i class="ph-bold ph-upload-simple"></i> Upload Recording`;
        }
    }
});

// Start Recording
startBtn.onclick = async () => {
    // Check for Secure Origin (Required for getUserMedia)
    if (!window.isSecureContext) {
        showToast("Microphone requires HTTPS. Use file upload or visit via https://", "ph ph-warning", "error");
        return;
    }

    try {
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
            throw new Error("MediaDevices API not supported");
        }

        const stream = await navigator.mediaDevices.getUserMedia({
            audio: {
                autoGainControl: true,
                echoCancellation: true,
                noiseSuppression: true
            }
        });

        mediaRecorder = new MediaRecorder(stream);
        audioChunks = [];

        mediaRecorder.ondataavailable = (event) => {
            audioChunks.push(event.data);
        };

        mediaRecorder.onstop = uploadAudio;

        mediaRecorder.start();
        document.body.classList.add("recording");
        document.getElementById("visualizerContainer").style.display = "block";
        startBtn.disabled = true;
        stopBtn.disabled = false;
        statusText.innerHTML = `<span class="status-dot"></span> Recording meeting...`;

        // Start Visualization
        visualize(stream);

        // Reset UI for new meeting
        resultsGrid.classList.remove("visible");
        tracker.style.display = "none";
    } catch (err) {
        console.error("Microphone access failed:", err);
        showToast("Mic access failed. Check permissions or use 'Select File'.", "ph ph-microphone-slash", "error");
    }
};

// Stop Recording
stopBtn.onclick = () => {
    mediaRecorder.stop();
    document.body.classList.remove("recording");
    document.getElementById("visualizerContainer").style.display = "none";
    startBtn.disabled = false;
    stopBtn.disabled = true;
    statusText.innerText = "Processing meeting Intelligence...";

    // Stop Visualization
    if (animationId) cancelAnimationFrame(animationId);
    if (audioContext) audioContext.close();
};

// Cancel Processing
if (cancelBtn) {
    cancelBtn.onclick = async () => {
        if (!currentSessionId) return;

        const originalText = cancelBtn.innerHTML;
        cancelBtn.innerHTML = `<i class="ph ph-circle-notch-bold ph-spin"></i> Cancelling...`;
        cancelBtn.disabled = true;

        try {
            await fetch(`/cancel/${currentSessionId}`, { method: "POST" });
            localStorage.removeItem("activeMeetingSession");

            clearInterval(pollInterval);
            tracker.style.display = "none";
            cancelBtn.style.display = "none";
            statusText.innerText = "Process cancelled.";

            // Clean up UI
            const steps = ["stepExtract", "stepDenoise", "stepWhisper", "stepDiarize", "stepAI"];
            steps.forEach(id => updateStep(id, ""));

        } catch (err) {
            console.error("Cancel failed:", err);
        } finally {
            cancelBtn.innerHTML = originalText;
            cancelBtn.disabled = false;
        }
    };
}

function renderTranscriptHtml(rawTranscript) {
    if (!rawTranscript) return "";
    const transcriptLines = rawTranscript.split("\n");
    let groupedHTML = "";
    let lastSpeaker = null;

    transcriptLines.forEach(line => {
        if (!line.trim()) return;
        const parts = line.match(/\[(.*?)\] (.*?): (.*)/);
        if (parts) {
            const [_, time, speaker, text] = parts;
            if (speaker === lastSpeaker) {
                groupedHTML += `<div class="transcript-bubble"><span class="bubble-time">${time}</span><p>${text}</p></div>`;
            } else {
                groupedHTML += `<div class="transcript-bubble"><span class="speaker-label">${speaker}</span><span class="bubble-time">${time}</span><p>${text}</p></div>`;
            }
            lastSpeaker = speaker;
        } else {
            groupedHTML += `<div class="transcript-bubble"><p>${line}</p></div>`;
            lastSpeaker = null;
        }
    });
    return groupedHTML;
}

function toggleTranslation() {
    const isChecked = document.getElementById("translateToggle").checked;
    transcriptDiv.innerHTML = renderTranscriptHtml(isChecked ? currentTranscripts.translated : currentTranscripts.original);
}

async function handleFileUpload(event) {
    const file = event.target.files[0];
    if (!file) return;

    pendingFile = file;

    // Suggest title from filename if empty
    const titleInput = document.getElementById("meetingTitle");
    if (!titleInput.value.trim()) {
        titleInput.value = file.name.split('.').slice(0, -1).join('.') || file.name;
    }

    // Show Preview
    const preview = document.getElementById("selectionPreview");
    const nameSpan = document.getElementById("selectedFileName");
    if (preview && nameSpan) {
        nameSpan.innerText = file.name;
        preview.style.display = "block";
    }
}

// Initializing the confirm button event listener
document.addEventListener("DOMContentLoaded", () => {
    const confirmBtn = document.getElementById("confirmProcessBtn");
    if (confirmBtn) {
        confirmBtn.onclick = () => {
            if (pendingFile) {
                sendToProcess(pendingFile, false);
                document.getElementById("selectionPreview").style.display = "none";
                pendingFile = null;
            }
        };
    }
});

async function uploadAudio() {
    const audioBlob = new Blob(audioChunks, { type: "audio/webm" });
    sendToProcess(audioBlob, true);
}

async function sendToProcess(blob, isRecording = true) {
    const formData = new FormData();
    formData.append("audio", blob, isRecording ? "recording.webm" : "upload.media");
    formData.append("title", document.getElementById("meetingTitle").value);
    const sessionId = "session_" + Date.now();
    currentSessionId = sessionId;
    localStorage.setItem("activeMeetingSession", sessionId);
    formData.append("session_id", sessionId);

    const modelQ = document.getElementById("modelQuality")?.value || "small";
    formData.append("model_quality", modelQ);

    tracker.style.display = "block";
    if (cancelBtn) cancelBtn.style.display = "flex";

    const steps = ["stepExtract", "stepDenoise", "stepWhisper", "stepDiarize", "stepAI"];
    steps.forEach(id => updateStep(id, ""));

    const progressBar = document.getElementById("actualProgressBar");
    const progressPercent = document.getElementById("progressPercent");
    const currentPhase = document.getElementById("currentPhase");

    // Use XHR for upload progress
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/process", true);

    xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) {
            const percent = Math.round((e.loaded / e.total) * 100);
            // We scale upload to 0-10% of total visual progress or just show upload khusus
            if (percent < 100) {
                if (progressBar) progressBar.style.width = `${percent}%`;
                if (progressPercent) progressPercent.innerText = `${percent}%`;
                if (currentPhase) currentPhase.innerText = `Uploading ${percent}%...`;
            }
        }
    };

    xhr.onload = () => {
        if (xhr.status === 200) {
            const data = JSON.parse(xhr.responseText);
            clearInterval(pollInterval);
            steps.forEach(id => updateStep(id, "completed"));
            if (cancelBtn) cancelBtn.style.display = "none";
            displayResults(data);
            loadHistory();
            statusText.innerText = "Meeting Intelligence Ready.";
            if (data.id) loadSession(data.id);
        } else {
            console.error("Server error:", xhr.statusText);
            handleError();
        }
    };

    xhr.onerror = () => handleError();

    function handleError() {
        clearInterval(pollInterval);
        statusText.innerText = "Processing failed.";
        updateStep("stepExtract", "failed");
        if (cancelBtn) cancelBtn.style.display = "none";
        if (progressBar) progressBar.style.background = "var(--danger)";
    }

    xhr.send(formData);

    // Start Polling for backend progress
    const startPolling = (id) => {
        pollInterval = setInterval(async () => {
            try {
                const res = await fetch(`/progress/${id}`);
                if (!res.ok) return;
                const statusData = await res.json();

                const percent = statusData.percent || 0;
                if (progressBar) progressBar.style.width = `${percent}%`;
                if (progressPercent) progressPercent.innerText = `${percent}%`;
                if (currentPhase) {
                    let phaseText = statusData.status || "Processing...";
                    phaseText = phaseText.charAt(0).toUpperCase() + phaseText.slice(1);
                    if (phaseText.endsWith("ing")) phaseText += "...";
                    currentPhase.innerText = phaseText;
                }

                if (statusData.status === "extracting") updateStep("stepExtract", "active");
                if (statusData.status === "denoising") {
                    updateStep("stepExtract", "completed");
                    updateStep("stepDenoise", "active");
                }
                if (statusData.status === "transcribing") {
                    updateStep("stepExtract", "completed");
                    updateStep("stepDenoise", "completed");
                    updateStep("stepWhisper", "active");
                }
                if (statusData.status === "diarizing") {
                    updateStep("stepExtract", "completed");
                    updateStep("stepDenoise", "completed");
                    updateStep("stepWhisper", "completed");
                    updateStep("stepDiarize", "active");
                }
                if (statusData.status === "summarizing") {
                    updateStep("stepDiarize", "completed");
                    updateStep("stepAI", "active");
                }
                if (statusData.status === "completed") {
                    clearInterval(pollInterval);
                } else if (statusData.status === "failed") {
                    clearInterval(pollInterval);
                    handleError();
                }
            } catch (e) {
                console.error("Polling error:", e);
            }
        }, 1000);
    };

    startPolling(sessionId);
}

function visualize(stream) {
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
    const source = audioContext.createMediaStreamSource(stream);
    analyser = audioContext.createAnalyser();
    analyser.fftSize = 256;
    source.connect(analyser);

    const canvas = document.getElementById("audioVisualizer");
    const ctx = canvas.getContext("2d");

    // Set internal resolution to match display size
    canvas.width = canvas.offsetWidth || 400;
    canvas.height = canvas.offsetHeight || 40;

    const bufferLength = analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);

    function draw() {
        animationId = requestAnimationFrame(draw);
        analyser.getByteFrequencyData(dataArray);

        ctx.clearRect(0, 0, canvas.width, canvas.height);

        const barWidth = (canvas.width / bufferLength) * 2.5;
        let x = 0;

        for (let i = 0; i < bufferLength; i++) {
            const barHeight = (dataArray[i] / 255) * canvas.height;

            // Premium Gradient
            const gradient = ctx.createLinearGradient(0, canvas.height, 0, 0);
            gradient.addColorStop(0, "#8b5cf6");
            gradient.addColorStop(1, "#3b82f6");

            ctx.fillStyle = gradient;
            ctx.roundRect(x, canvas.height - barHeight, barWidth - 2, barHeight, 4);
            ctx.fill();

            x += barWidth;
        }
    }
    draw();
}

function updateStep(id, state) {
    const el = document.getElementById(id);
    if (!el) return;
    el.classList.remove("active", "completed", "failed");
    if (state) el.classList.add(state);
}

function jumpToTime(timestamp, seconds) {
    const player = document.getElementById("audioPlayer");
    if (player && player.src) {
        player.currentTime = seconds;
        player.play();
    }

    const bubbles = document.querySelectorAll('.bubble-time');
    for (let b of bubbles) {
        if (b.innerText === timestamp) {
            // Remove previous highlights
            document.querySelectorAll('.transcript-bubble').forEach(p => p.classList.remove('active-highlight'));

            b.parentElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
            b.parentElement.classList.add('active-highlight');
            break;
        }
    }
}

function formatTime(seconds) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    return [h, m, s]
        .map(v => v < 10 ? "0" + v : v)
        .filter((v, i) => v !== "00" || i > 0)
        .join(":");
}

function displayResults(data) {
    if (!data) return;
    currentSessionId = data.id;

    // UI Setup
    resultsGrid.classList.add("visible");
    const transControl = document.getElementById("translationControl");
    const engBadge = document.getElementById("englishBadge");
    const toggle = document.getElementById("translateToggle");

    // Clear Previous State
    transControl.style.display = "none";
    engBadge.style.display = "none";
    toggle.checked = false;

    // Language logic
    if (data.language === "en") {
        engBadge.style.display = "flex";
    } else if (data.transcript_en) {
        transControl.style.display = "flex";
    }

    // Store versions
    currentTranscripts.original = data.transcript || "";
    currentTranscripts.translated = data.transcript_en || data.transcript || "";

    // 1. Render Transcript
    transcriptDiv.innerHTML = renderTranscriptHtml(currentTranscripts.original);

    // 2. Render Chapters HUD
    const chaptersHUD = document.getElementById("chaptersHUD");
    if (data.chapters && data.chapters.length > 0) {
        chaptersHUD.innerHTML = data.chapters.map(ch => {
            const timeStr = formatTime(ch.start);
            return `
            <div class="chapter-item" onclick="jumpToTime('${timeStr}', ${ch.start})">
                <span class="chapter-time">${timeStr}</span>
                <span class="chapter-title">${ch.title}</span>
            </div>
            `;
        }).join("");
    } else {
        chaptersHUD.innerHTML = `<p class="placeholder-text-sm">No chapters generated.</p>`;
    }

    // 3. Render Speaker Roles
    const rolesHUD = document.getElementById("speakerRolesHUD");
    if (data.speaker_roles && Object.keys(data.speaker_roles).length > 0) {
        rolesHUD.innerHTML = Object.entries(data.speaker_roles).map(([name, role]) => `
            <div class="role-badge">
                <span class="role-name">${name}</span>
                <span class="role-title">${role}</span>
            </div>
        `).join("");
    } else {
        rolesHUD.innerHTML = `<p class="placeholder-text-sm">Speaker ID required for role profiling.</p>`;
    }

    // 4. Render Summary
    summaryDiv.innerHTML = `<div class="summary-content">${(data.summary || "").replace(/\n/g, '<br>')}</div>`;

    // 5. Render Action HUD
    const actionsDiv = document.getElementById("actions");
    if (data.action_items && data.action_items.length > 0) {
        actionsDiv.innerHTML = data.action_items.map((item, i) => `
            <div class="action-item" style="animation: slideIn 0.3s ease forwards; animation-delay: ${i * 0.1}s">
                <input type="checkbox" id="action-${i}">
                <label for="action-${i}">${item}</label>
            </div>
        `).join("");
    } else {
        actionsDiv.innerHTML = `<p class="placeholder-text-sm">No action items detected.</p>`;
    }

    // Add success haptics for completion
    setTimeout(() => {
        resultsGrid.classList.add("visible");
        showToast("Meeting Intelligence Ready! ✨", "ph ph-sparkle", "success");
    }, 100);
}

function startNewMeeting() {
    // Completely clear current processing state
    currentSessionId = null;
    pendingFile = null;
    localStorage.removeItem("activeMeetingSession");
    clearInterval(pollInterval);

    document.getElementById("recorderCard").classList.remove("hidden");
    document.getElementById("resultsGrid").classList.remove("visible");
    document.getElementById("processingTracker").style.display = "none";
    document.getElementById("confirmProcessBtn").parentElement.style.display = "none";
    statusText.innerHTML = `<span class="status-dot"></span> Ready to record your next meeting.`;

    // Clear the confirmation area if any (class-based)
    const previewEl = document.querySelector(".selection-preview");
    if (previewEl) previewEl.style.display = "none";

    // Clear Previous Content
    transcriptDiv.innerHTML = "";
    summaryDiv.innerHTML = "";
    const actionsCont = document.getElementById("actions");
    if (actionsCont) actionsCont.innerHTML = "";

    // Reset UI for selection (ID-based)
    const fileInput = document.getElementById("fileInput");
    if (fileInput) fileInput.value = "";
    const previewContainer = document.getElementById("selectionPreview");
    if (previewContainer) previewContainer.style.display = "none";

    // Reset Title/Subtitle
    document.getElementById("mainTitle").innerHTML = `Meeting <span style="color: var(--primary)">Intelligence</span>`;
    document.getElementById("mainSubtitle").innerText = "High-fidelity transcriptions & AI insights";
    document.getElementById("meetingTitle").value = "";
    statusText.innerText = "Ready to record";

    // Refresh Sidebar to clear active state
    loadHistory();
}

// Mobile Sidebar Control
function toggleSidebar() {
    document.body.classList.toggle('sidebar-open');
}

// Global Modal Control
function toggleSettings() {
    const modal = document.getElementById("settingsModal");
    const isOpen = modal.style.display === "flex";
    modal.style.display = isOpen ? "none" : "flex";

    // Check storage status when opening
    if (!isOpen) checkCleanupStatus();
}

async function checkCleanupStatus() {
    const statusEl = document.getElementById("cleanupStatus");
    const cleanupBtn = document.getElementById("cleanupBtn");
    try {
        const res = await fetch("/admin/cleanup");
        const data = await res.json();
        if (data.count > 0) {
            statusEl.innerText = `${data.count} old media files found (${data.size_mb} MB).`;
            cleanupBtn.disabled = false;
            cleanupBtn.style.opacity = "1";
        } else {
            statusEl.innerText = "No old media files to clean.";
            cleanupBtn.disabled = true;
            cleanupBtn.style.opacity = "0.5";
        }
    } catch (err) {
        statusEl.innerText = "Could not check storage.";
    }
}

async function performCleanup() {
    if (!confirm("Are you sure you want to delete original audio/video files older than 7 days? Transcripts and summaries will be kept.")) return;

    const cleanupBtn = document.getElementById("cleanupBtn");
    const statusEl = document.getElementById("cleanupStatus");
    cleanupBtn.disabled = true;
    statusEl.innerText = "Cleaning up...";

    try {
        const res = await fetch("/admin/cleanup", { method: "POST" });
        const data = await res.json();
        if (data.success) {
            showToast(data.message);
            checkCleanupStatus();
        }
    } catch (err) {
        showToast("Cleanup failed.");
        checkCleanupStatus();
    }
}

// Close modal on Escape key
window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
        const modal = document.getElementById("settingsModal");
        if (modal.style.display === "flex") toggleSettings();
    }
});

// Settings Persistence & UI Logic
const modelSelect = document.getElementById("modelQuality");
const vramWarning = document.getElementById("vramWarning");

modelSelect.addEventListener("change", (e) => {
    localStorage.setItem("qualitySetting", e.target.value);
    vramWarning.style.display = (e.target.value === "medium") ? "block" : "none";
});

// Load Preferences on Start
window.addEventListener("DOMContentLoaded", () => {
    const savedQuality = localStorage.getItem("qualitySetting");
    if (savedQuality !== null) {
        modelSelect.value = savedQuality;
    }

    // Show warning if medium is active (either from save or as default)
    vramWarning.style.display = (modelSelect.value === "medium") ? "block" : "none";
});

async function copyToClipboard(type) {
    let text = "";
    if (type === 'transcript') text = document.getElementById("transcript").innerText;
    else if (type === 'summary') text = document.getElementById("summary").innerText;
    else if (type === 'actions') text = document.getElementById("actions").innerText;

    try {
        await navigator.clipboard.writeText(text);
        showToast("Copied to clipboard!");
    } catch (err) {
        console.error("Copy failed:", err);
    }
}

// Toast function is now consolidated at the top

function downloadFile(format, type) {
    if (!currentSessionId) return;
    window.open(`/download/${format}/${type}/${currentSessionId}`);
}

// History Management
async function loadHistory() {
    const response = await fetch("/history");
    const meetings = await response.json();
    renderHistory(meetings);
}

function renderHistory(meetings) {
    const historyList = document.getElementById("meetingHistory");
    historyList.innerHTML = meetings.map(m => `
        <div class="history-item ${m.id === currentSessionId ? 'active' : ''}" onclick="loadSession('${m.id}')">
            <h4>${m.title}</h4>
            <p>${m.timestamp || 'No date'}</p>
            <div class="history-actions">
                <button class="action-btn" onclick="renameSession('${m.id}', event)"><i class="ph ph-pencil-simple"></i></button>
                <button class="action-btn delete-btn-item" onclick="deleteSession('${m.id}', event)"><i class="ph ph-trash"></i></button>
            </div>
        </div>
    `).join("");
}

async function loadSession(id) {
    const response = await fetch(`/history/${id}`);
    const data = await response.json();

    if (data.error) {
        showToast("Meeting not found.");
        return;
    }

    // Switch View State
    document.getElementById("recorderCard").classList.add("hidden");
    const histHeader = document.getElementById("historicalHeader");
    histHeader.style.display = "block";

    // Load Player
    const player = document.getElementById("audioPlayer");
    player.src = `/recordings/audio/${id}`;

    document.getElementById("viewTitle").innerText = data.title || "Meeting Recording";
    document.getElementById("viewDate").innerText = data.timestamp || "Historical Recording";

    // Populate Results
    displayResults(data);

    // Sync Histroy Sidebar Active State
    loadHistory();

    // Auto-close sidebar on mobile
    if (window.innerWidth <= 768) {
        document.body.classList.remove('sidebar-open');
    }
}

async function renameSession(id, event) {
    event.stopPropagation();
    const newTitle = prompt("Enter new title:");
    if (!newTitle) return;

    await fetch(`/history/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: newTitle })
    });
    loadHistory();
}

async function deleteSession(id, event) {
    event.stopPropagation();
    if (!confirm("Are you sure you want to delete this meeting?")) return;

    await fetch(`/history/${id}`, { method: "DELETE" });
    if (id === currentSessionId) {
        resultsGrid.classList.remove("visible");
        transcriptDiv.innerText = "";
        summaryDiv.innerText = "";
    }
    loadHistory();
}

// Advanced History Search
async function filterHistory() {
    const query = document.getElementById("historySearch").value.toLowerCase();
    if (query.length > 0 && query.length < 2) return;

    try {
        const res = await fetch(`/search?q=${encodeURIComponent(query)}`);
        const results = await res.json();
        renderHistory(results);
    } catch (err) {
        console.error("Search failed:", err);
    }
}

// Optimization: Debounce helper to prevent expensive DOM mutations on every keystroke
function debounce(func, timeout = 300) {
    let timer;
    return (...args) => {
        clearTimeout(timer);
        timer = setTimeout(() => { func.apply(this, args); }, timeout);
    };
}

const debouncedFilter = debounce(() => {
    const input = document.getElementById("meetingSearch");
    if (!input) return;
    const filter = input.value.toUpperCase();
    const items = document.getElementsByClassName("history-item");

    for (let i = 0; i < items.length; i++) {
        const titleNodes = items[i].getElementsByTagName("h4");
        if (titleNodes.length === 0) continue;
        const title = titleNodes[0].innerText;
        items[i].style.display = title.toUpperCase().indexOf(filter) > -1 ? "" : "none";
    }
});

// Attach debounced filter
document.getElementById("meetingSearch")?.addEventListener("input", debouncedFilter);

// Initialize
loadHistory();