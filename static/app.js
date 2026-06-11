(function () {
    "use strict";

    // ── State ──────────────────────────────────────────────
    const HISTORY_KEY = "sse-debug-history";
    const HISTORY_MAX = 50;

    const ROLE_COLORS = [
        { bg: "rgba(232,168,56,0.12)", fg: "#e8a838" },
        { bg: "rgba(74,222,128,0.12)", fg: "#4ade80" },
        { bg: "rgba(56,189,248,0.12)", fg: "#38bdf8" },
        { bg: "rgba(251,146,60,0.12)", fg: "#fb923c" },
        { bg: "rgba(248,113,113,0.12)", fg: "#f87171" },
        { bg: "rgba(45,212,191,0.12)", fg: "#2dd4bf" },
        { bg: "rgba(251,191,36,0.12)", fg: "#fbbf24" },
        { bg: "rgba(168,162,158,0.12)", fg: "#a8a29e" },
    ];

    var TYPE_STYLES = {
        reasoning: { label: "Thinking", badgeBg: "rgba(158,158,168,0.12)", badgeFg: "#9e9ea8", collapsed: false },
        thinking:  { label: "Thinking", badgeBg: "rgba(158,158,168,0.12)", badgeFg: "#9e9ea8", collapsed: false },
        text:      { label: "Content",  badgeBg: "rgba(232,168,56,0.12)",  badgeFg: "#e8a838", collapsed: false },
        content:   { label: "Content",  badgeBg: "rgba(232,168,56,0.12)",  badgeFg: "#e8a838", collapsed: false },
        data:      { label: "Data",     badgeBg: "rgba(56,189,248,0.12)",  badgeFg: "#38bdf8", collapsed: false },
        tool:      { label: "Tool",     badgeBg: "rgba(251,146,60,0.12)",  badgeFg: "#fb923c", collapsed: false },
    };

    const state = {
        isStreaming: false,
        abortController: null,
        events: [],
        accumulatedText: "",
        contentText: "",
        reasoningText: "",
        toolCalls: {},        // { index: { id, name, arguments, type } }
        toolCallOrder: [],    // ordered list of tool call indices
        _activeSection: "",   // "content" | "reasoning" | "tool"
        roles: {},
        roleOrder: [],
        _activeRole: "",
        responseHeaders: {},
        responseStatus: null,
        isSSE: false,
        startTime: null,
        totalSize: 0,
        timerInterval: null,
    };

    // ── SSE Parser ─────────────────────────────────────────
    class SSEParser {
        constructor() {
            this.buffer = "";
            this.currentEvent = { event: "", data: "" };
        }

        feed(chunk) {
            this.buffer += chunk;
            const parts = this.buffer.split("\n");
            this.buffer = parts.pop();
            const events = [];
            for (const line of parts) {
                const parsed = this.processLine(line);
                if (parsed) events.push(parsed);
            }
            return events;
        }

        processLine(line) {
            if (line === "") {
                if (this.currentEvent.data || this.currentEvent.event) {
                    const evt = { ...this.currentEvent };
                    this.currentEvent = { event: "", data: "" };
                    return { type: "event", event: evt };
                }
                return null;
            }
            if (line.startsWith(":")) return null;
            const colonIdx = line.indexOf(":");
            if (colonIdx < 0) {
                this.currentEvent[line] = "";
                return null;
            }
            const field = line.substring(0, colonIdx);
            let value = line.substring(colonIdx + 1);
            if (value.startsWith(" ")) value = value.substring(1);
            if (field === "event") {
                this.currentEvent.event = value;
            } else if (field === "data") {
                if (this.currentEvent.data) this.currentEvent.data += "\n";
                this.currentEvent.data += value;
            }
            return null;
        }
    }

    // ── JSON Path accessor ─────────────────────────────────
    function getNestedValue(obj, path) {
        if (!path || !obj) return obj;
        if (typeof obj === "string") {
            try { obj = JSON.parse(obj); } catch { return undefined; }
        }
        const parts = path.split(".");
        let current = obj;
        for (const part of parts) {
            if (current === null || current === undefined) return undefined;
            if (/^\d+$/.test(part)) {
                current = current[parseInt(part, 10)];
            } else {
                current = current[part];
            }
        }
        return current;
    }

    // ── Simple Markdown Renderer ───────────────────────────
    function renderMarkdown(text) {
        let html = escapeHtml(text);
        // Code blocks
        html = html.replace(/```(\w*)\n([\s\S]*?)```/g, function (_, lang, code) {
            return '<pre><code class="lang-' + lang + '">' + code + "</code></pre>";
        });
        // Inline code
        html = html.replace(/`([^`\n]+)`/g, "<code>$1</code>");
        // Bold
        html = html.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
        // Italic
        html = html.replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, "<em>$1</em>");
        // Headers
        html = html.replace(/^#### (.+)$/gm, "<h4>$1</h4>");
        html = html.replace(/^### (.+)$/gm, "<h3>$1</h3>");
        html = html.replace(/^## (.+)$/gm, "<h2>$1</h2>");
        html = html.replace(/^# (.+)$/gm, "<h1>$1</h1>");
        // Unordered lists
        html = html.replace(/^[-*] (.+)$/gm, "<li>$1</li>");
        html = html.replace(/(<li>.*<\/li>\n?)+/g, "<ul>$&</ul>");
        // Blockquotes
        html = html.replace(/^&gt; (.+)$/gm, "<blockquote>$1</blockquote>");
        // Line breaks
        html = html.replace(/\n\n/g, "</p><p>");
        html = html.replace(/\n/g, "<br>");
        html = "<p>" + html + "</p>";
        html = html.replace(/<p><\/p>/g, "");
        html = html.replace(/<p>(<h[1-4]>)/g, "$1");
        html = html.replace(/(<\/h[1-4]>)<\/p>/g, "$1");
        html = html.replace(/<p>(<pre>)/g, "$1");
        html = html.replace(/(<\/pre>)<\/p>/g, "$1");
        html = html.replace(/<p>(<ul>)/g, "$1");
        html = html.replace(/(<\/ul>)<\/p>/g, "$1");
        html = html.replace(/<p>(<blockquote>)/g, "$1");
        html = html.replace(/(<\/blockquote>)<\/p>/g, "$1");
        return html;
    }

    function escapeHtml(text) {
        return text
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;");
    }

    // ── JSON Syntax Highlight ──────────────────────────────
    function highlightJSON(str) {
        try {
            const obj = JSON.parse(str);
            str = JSON.stringify(obj, null, 2);
        } catch { /* not JSON, return as-is */ }
        return str
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"([^"]+)"(?=\s*:)/g, '<span class="json-key">"$1"</span>')
            .replace(/:\s*"([^"]*)"/g, ': <span class="json-string">"$1"</span>')
            .replace(/:\s*(\d+\.?\d*)/g, ': <span class="json-number">$1</span>')
            .replace(/:\s*(true|false)/g, ': <span class="json-bool">$1</span>')
            .replace(/:\s*(null)/g, ": <span class=\"json-null\">$1</span>");
    }

    // ── DOM References ─────────────────────────────────────
    const $ = (sel) => document.querySelector(sel);
    const $$ = (sel) => document.querySelectorAll(sel);

    const methodSelect = $("#method");
    const urlInput = $("#url");
    const sendBtn = $("#sendBtn");
    const abortBtn = $("#abortBtn");
    const skipSSLCheckbox = $("#skipSSL");
    const formatJsonBtn = $("#formatJson");
    const clearBtn = $("#clearBtn");
    const copyBtn = $("#copyBtn");
    const renderedOutput = $("#renderedOutput");
    const rawOutput = $("#rawOutput");
    const headersOutput = $("#headersOutput");
    const statusBar = $("#statusBar");
    const statusIndicator = $("#statusIndicator");
    const statusTime = $("#statusTime");
    const statusSize = $("#statusSize");
    const statusEvents = $("#statusEvents");
    const historyBtn = $("#historyBtn");
    const historyDrawer = $("#historyDrawer");
    const historyOverlay = $("#historyOverlay");
    const historyList = $("#historyList");
    const clearAllHistoryBtn = $("#clearAllHistory");

    // ── Method Color ───────────────────────────────────────
    function updateMethodColor() {
        const method = methodSelect.value;
        methodSelect.className = "method-" + method.toLowerCase();
    }

    // ── Tab Switching ──────────────────────────────────────
    function initTabs() {
        document.addEventListener("click", function (e) {
            const tab = e.target.closest(".tab");
            if (!tab) return;
            const group = tab.dataset.group;
            const tabName = tab.dataset.tab;
            if (!group || !tabName) return;

            // Deactivate siblings
            const tabBar = tab.closest(".tab-bar");
            tabBar.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
            tab.classList.add("active");

            // Show corresponding content
            const container = tabBar.parentElement;
            container.querySelectorAll(".tab-content").forEach((tc) => {
                tc.classList.toggle("active", tc.dataset.tab === tabName && tc.dataset.group === group);
            });
        });
    }

    // ── KV Editor (Headers & Form) ─────────────────────────
    function initKVEditor() {
        document.addEventListener("click", function (e) {
            if (e.target.classList.contains("kv-remove")) {
                const row = e.target.closest(".kv-row");
                const list = row.parentElement;
                if (list.children.length > 1) {
                    row.remove();
                }
            }
        });

        $("#addHeader").addEventListener("click", function () {
            addKVRow($("#headersList"));
        });

        $("#addFormField").addEventListener("click", function () {
            addKVRow($("#formList"));
        });
    }

    function addKVRow(container, key, value) {
        const row = document.createElement("div");
        row.className = "kv-row";
        const keyInput = document.createElement("input");
        keyInput.type = "text";
        keyInput.className = "kv-key";
        keyInput.placeholder = "Key";
        keyInput.value = key || "";
        const valueInput = document.createElement("input");
        valueInput.type = "text";
        valueInput.className = "kv-value";
        valueInput.placeholder = "Value";
        valueInput.value = value || "";
        const removeBtn = document.createElement("button");
        removeBtn.className = "kv-remove";
        removeBtn.title = "Remove";
        removeBtn.textContent = "×";
        row.appendChild(keyInput);
        row.appendChild(valueInput);
        row.appendChild(removeBtn);
        container.appendChild(row);
        keyInput.focus();
    }

    function getKVPairs(containerId) {
        const pairs = {};
        const rows = document.querySelectorAll("#" + containerId + " .kv-row");
        rows.forEach(function (row) {
            const key = row.querySelector(".kv-key").value.trim();
            const value = row.querySelector(".kv-value").value.trim();
            if (key) pairs[key] = value;
        });
        return pairs;
    }

    // ── Body Type Switching ────────────────────────────────
    function initBodyType() {
        const radios = document.querySelectorAll('input[name="bodyType"]');
        radios.forEach(function (radio) {
            radio.addEventListener("change", function () {
                document.querySelectorAll(".body-editor").forEach(function (ed) {
                    ed.style.display = ed.dataset.type === radio.value ? "" : "none";
                });
            });
        });
    }

    function getBodyType() {
        return document.querySelector('input[name="bodyType"]:checked').value;
    }

    // ── Format JSON ────────────────────────────────────────
    function initFormatJson() {
        formatJsonBtn.addEventListener("click", function () {
            const editor = $("#jsonBody");
            try {
                const obj = JSON.parse(editor.value);
                editor.value = JSON.stringify(obj, null, 2);
            } catch (err) {
                showToast("Invalid JSON: " + err.message, "error");
            }
        });
    }

    // ── Parse Rules ────────────────────────────────────────
    function getParseRules() {
        return {
            contentPath: $("#contentPath").value.trim(),
            reasoningPath: $("#reasoningPath").value.trim(),
            toolCallsPath: $("#toolCallsPath").value.trim(),
            rolePath: $("#rolePath").value.trim(),
            eventFilter: $("#eventFilter").value.trim(),
            displayMode: $("#displayMode").value,
            contentFormat: $("#contentFormat").value,
            ignoreDone: $("#ignoreDone").checked,
        };
    }

    // ── Panel Divider Drag ─────────────────────────────────
    function initDivider() {
        const divider = $("#panelDivider");
        const reqPanel = $(".request-panel");
        const resPanel = $(".response-panel");
        let isDragging = false;
        let startY = 0;
        let startReqFlex = 0;
        let startResFlex = 0;

        divider.addEventListener("mousedown", function (e) {
            isDragging = true;
            startY = e.clientY;
            startReqFlex = parseFloat(getComputedStyle(reqPanel).flexGrow) || 2;
            startResFlex = parseFloat(getComputedStyle(resPanel).flexGrow) || 3;
            document.body.style.cursor = "row-resize";
            document.body.style.userSelect = "none";
            e.preventDefault();
        });

        document.addEventListener("mousemove", function (e) {
            if (!isDragging) return;
            const dy = e.clientY - startY;
            const totalHeight = reqPanel.offsetHeight + resPanel.offsetHeight;
            const ratio = dy / totalHeight;
            const total = startReqFlex + startResFlex;
            let newReq = startReqFlex + ratio * total;
            let newRes = startResFlex - ratio * total;
            newReq = Math.max(0.5, Math.min(total - 0.5, newReq));
            newRes = total - newReq;
            reqPanel.style.flex = newReq;
            resPanel.style.flex = newRes;
        });

        document.addEventListener("mouseup", function () {
            if (isDragging) {
                isDragging = false;
                document.body.style.cursor = "";
                document.body.style.userSelect = "";
            }
        });
    }

    // ── Send Request ───────────────────────────────────────
    function initSend() {
        sendBtn.addEventListener("click", sendRequest);
        abortBtn.addEventListener("click", abortRequest);
        urlInput.addEventListener("keydown", function (e) {
            if (e.key === "Enter" && !e.isComposing) sendRequest();
        });
        document.addEventListener("keydown", function (e) {
            if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
                e.preventDefault();
                sendRequest();
            }
        });
    }

    async function sendRequest() {
        const targetUrl = urlInput.value.trim();
        if (!targetUrl) {
            showToast("Please enter a URL", "error");
            return;
        }

        const method = methodSelect.value;
        const headers = getKVPairs("headersList");
        const bodyType = getBodyType();
        let body = "";
        let form = {};

        switch (bodyType) {
            case "json":
                body = $("#jsonBody").value;
                break;
            case "form":
                form = getKVPairs("formList");
                break;
            case "raw":
                body = $("#rawBody").value;
                break;
        }

        // Reset state
        resetResponse();
        state.isStreaming = true;
        state.startTime = Date.now();
        state.abortController = new AbortController();

        // Save to history before sending
        pushHistory(captureCurrentRequest());

        sendBtn.style.display = "none";
        abortBtn.style.display = "";
        updateStatus("streaming", "Streaming...");
        startTimer();

        const payload = {
            url: targetUrl,
            method: method,
            headers: headers,
            body: body,
            bodyType: bodyType,
            form: form,
            skipSSL: skipSSLCheckbox.checked,
        };

        try {
            const resp = await fetch("/api/proxy", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload),
                signal: state.abortController.signal,
            });

            if (!resp.ok) {
                throw new Error("Proxy returned " + resp.status);
            }

            await readStream(resp);
        } catch (err) {
            if (err.name !== "AbortError") {
                showToast("Request failed: " + err.message, "error");
                updateStatus("error", "Error");
            } else {
                updateStatus("idle", "Aborted");
            }
        } finally {
            state.isStreaming = false;
            sendBtn.style.display = "";
            abortBtn.style.display = "none";
            stopTimer();
            removeCursor();
        }
    }

    function abortRequest() {
        if (state.abortController) {
            state.abortController.abort();
        }
    }

    async function readStream(resp) {
        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        const parser = new SSEParser();

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            const chunk = decoder.decode(value, { stream: true });
            state.totalSize += value.byteLength;

            const events = parser.feed(chunk);
            for (const evt of events) {
                if (evt.type === "event") {
                    handleProxyEvent(evt.event);
                }
            }
        }

        // Process any remaining buffer
        const remaining = parser.buffer;
        if (remaining) {
            const tempParser = new SSEParser();
            tempParser.buffer = remaining;
        }
    }

    function handleProxyEvent(proxyEvent) {
        const eventType = proxyEvent.event;
        const data = proxyEvent.data;

        try {
            var parsed = JSON.parse(data);
        } catch {
            parsed = data;
        }

        switch (eventType) {
            case "meta":
                state.responseStatus = parsed.status;
                state.responseHeaders = parsed.headers || {};
                state.isSSE = parsed.isSSE;
                renderResponseHeaders();
                if (parsed.status >= 400) {
                    updateStatus("error", parsed.status + " Error");
                } else {
                    updateStatus("streaming", parsed.status + " Streaming...");
                }
                break;

            case "sse":
                state.events.push(parsed);
                state.totalSize += (parsed.data || "").length;
                handleSSEEvent(parsed);
                break;

            case "chunk":
                state.accumulatedText += parsed.data || "";
                clearEmptyState(renderedOutput);
                clearEmptyState(rawOutput);
                updateRenderedOutput();
                appendRawChunk(parsed.data || "");
                break;

            case "comment":
                appendRawComment(parsed);
                break;

            case "error":
                showToast(parsed.message || "Unknown error", "error");
                updateStatus("error", "Error");
                break;

            case "done":
                finishStream();
                break;
        }
    }

    // ── SSE Event Handling ─────────────────────────────────
    function handleSSEEvent(event) {
        const rules = getParseRules();

        // Apply event filter
        if (rules.eventFilter && event.event !== rules.eventFilter) {
            appendRawSSE(event);
            return;
        }

        // Check [DONE] signal
        if (rules.ignoreDone && event.data === "[DONE]") {
            appendRawSSE(event);
            return;
        }

        appendRawSSE(event);
        clearEmptyState(renderedOutput);

        // Parse JSON data
        var jsonData = null;
        if (event.data) {
            try { jsonData = JSON.parse(event.data); } catch { /* not JSON */ }
        }

        // Extract role
        var roleName = "";
        if (rules.rolePath && jsonData) {
            var roleVal = getNestedValue(jsonData, rules.rolePath);
            if (roleVal != null) roleName = String(roleVal);
        }

        // Track role
        if (roleName && !state.roleOrder.includes(roleName)) {
            state.roleOrder.push(roleName);
        }

        var hadContent = false;

        // 1. Try tool calls path
        if (rules.toolCallsPath && jsonData) {
            var toolCallsData = getNestedValue(jsonData, rules.toolCallsPath);
            if (toolCallsData && Array.isArray(toolCallsData) && toolCallsData.length > 0) {
                processToolCalls(toolCallsData);
                hadContent = true;
            }
        }

        // 2. Try reasoning path
        if (rules.reasoningPath && jsonData) {
            var reasoningVal = getNestedValue(jsonData, rules.reasoningPath);
            if (reasoningVal != null && reasoningVal !== "") {
                state.reasoningText += String(reasoningVal);
                state._activeSection = "reasoning";
                hadContent = true;
            }
        }

        // 3. Try content path
        if (rules.contentPath && jsonData) {
            var contentVal = getNestedValue(jsonData, rules.contentPath);
            if (contentVal != null && contentVal !== "") {
                state.contentText += String(contentVal);
                state._activeSection = "content";
                hadContent = true;
            }
        }

        // 4. No explicit paths set — use raw data
        if (!rules.contentPath && !rules.reasoningPath && !rules.toolCallsPath) {
            if (event.data) {
                state.accumulatedText += event.data;
                hadContent = true;
            }
        }

        if (!hadContent) return;

        // Display based on mode
        if (rules.displayMode === "stream") {
            updateRenderedOutput();
        } else if (rules.displayMode === "events") {
            var eventContent = "";
            var eventTypeName = "";
            // Determine what content to show for this event
            if (rules.toolCallsPath && jsonData) {
                var tc = getNestedValue(jsonData, rules.toolCallsPath);
                if (tc && Array.isArray(tc) && tc.length > 0) {
                    eventContent = JSON.stringify(tc, null, 2);
                    eventTypeName = "tool";
                }
            }
            if (!eventContent && rules.reasoningPath && jsonData) {
                var rv = getNestedValue(jsonData, rules.reasoningPath);
                if (rv != null && rv !== "") {
                    eventContent = String(rv);
                    eventTypeName = "reasoning";
                }
            }
            if (!eventContent && rules.contentPath && jsonData) {
                var cv = getNestedValue(jsonData, rules.contentPath);
                if (cv != null && cv !== "") {
                    eventContent = String(cv);
                    eventTypeName = "content";
                }
            }
            if (!eventContent) eventContent = event.data || "";
            appendEventCard(event, eventContent, roleName, eventTypeName);
        } else if (rules.displayMode === "raw") {
            appendRenderedRawSSE(event, event.data);
        }
    }

    function processToolCalls(toolCallsData) {
        for (var i = 0; i < toolCallsData.length; i++) {
            var tc = toolCallsData[i];
            var idx = tc.index != null ? tc.index : i;

            if (!state.toolCalls[idx]) {
                state.toolCalls[idx] = { id: "", name: "", arguments: "", type: "" };
                state.toolCallOrder.push(idx);
            }

            var existing = state.toolCalls[idx];
            if (tc.id) existing.id = tc.id;
            if (tc.type) existing.type = tc.type;
            if (tc.function) {
                if (tc.function.name) existing.name = tc.function.name;
                if (tc.function.arguments) existing.arguments += tc.function.arguments;
            }
        }
        state._activeSection = "tool";
    }

    function clearEmptyState(el) {
        const empty = el.querySelector(".empty-state");
        if (empty) empty.remove();
    }

    function updateRenderedOutput() {
        const rules = getParseRules();
        clearEmptyState(renderedOutput);

        if (rules.displayMode === "stream") {
            // Check if we have explicit content paths set
            var hasExplicitPaths = rules.contentPath || rules.reasoningPath || rules.toolCallsPath;

            if (hasExplicitPaths && (state.toolCallOrder.length > 0 || state.reasoningText || state.contentText)) {
                renderedOutput.innerHTML = renderStructuredSections(rules);
            } else if (rules.rolePath && state.roleOrder.length > 0) {
                renderedOutput.innerHTML = renderRoleSections(rules);
            } else {
                var html = renderContentBlock(state.accumulatedText, rules);
                if (state.isStreaming) html += '<span class="streaming-cursor"></span>';
                renderedOutput.innerHTML = '<div class="rendered-content">' + html + "</div>";
            }
        }

        renderedOutput.scrollTop = renderedOutput.scrollHeight;
        statusSize.textContent = formatBytes(state.totalSize);
        statusEvents.textContent = state.events.length + " events";
    }

    function renderStructuredSections(rules) {
        var html = "";

        // Tool calls sections
        for (var i = 0; i < state.toolCallOrder.length; i++) {
            var idx = state.toolCallOrder[i];
            var tc = state.toolCalls[idx];
            if (!tc) continue;

            var isActive = state.isStreaming && state._activeSection === "tool" && i === state.toolCallOrder.length - 1;
            html += '<div class="type-section type-tool' + (isActive ? "" : "") + '" data-type="tool">';
            html += '<div class="type-header" onclick="this.parentElement.classList.toggle(\'collapsed\')">';
            html += '<span class="type-badge" style="background:rgba(251,146,60,0.12);color:#fb923c">🔧 Tool Call</span>';
            if (tc.name) {
                html += '<span class="tool-call-name">' + escapeHtml(tc.name) + '</span>';
            }
            html += '<span class="type-collapse-icon">▼</span>';
            html += '</div>';
            html += '<div class="type-content">';
            if (tc.id) {
                html += '<div class="tool-call-meta"><span class="tool-call-meta-label">ID:</span> <span class="tool-call-meta-value">' + escapeHtml(tc.id) + '</span></div>';
            }
            if (tc.type) {
                html += '<div class="tool-call-meta"><span class="tool-call-meta-label">Type:</span> <span class="tool-call-meta-value">' + escapeHtml(tc.type) + '</span></div>';
            }
            if (tc.arguments) {
                try {
                    var argsObj = JSON.parse(tc.arguments);
                    html += '<pre><code>' + highlightJSON(JSON.stringify(argsObj, null, 2)) + '</code></pre>';
                } catch {
                    // Arguments still streaming or incomplete JSON
                    html += '<pre><code>' + escapeHtml(tc.arguments);
                    if (isActive) {
                        html += '<span class="streaming-cursor"></span>';
                    }
                    html += '</code></pre>';
                }
            } else if (isActive) {
                html += '<span class="streaming-cursor"></span>';
            }
            html += '</div></div>';
        }

        // Reasoning section
        if (state.reasoningText) {
            html += '<div class="type-section type-reasoning" data-type="reasoning">';
            html += '<div class="type-header" onclick="this.parentElement.classList.toggle(\'collapsed\')">';
            html += '<span class="type-badge" style="background:rgba(158,158,168,0.12);color:#9e9ea8">💭 Thinking</span>';
            html += '<span class="type-collapse-icon">▼</span>';
            html += '</div>';
            html += '<div class="type-content">';
            html += renderContentBlock(state.reasoningText, rules);
            if (state.isStreaming && state._activeSection === "reasoning") {
                html += '<span class="streaming-cursor"></span>';
            }
            html += '</div></div>';
        }

        // Content section
        if (state.contentText) {
            html += '<div class="type-section type-content" data-type="content">';
            html += '<div class="type-header" onclick="this.parentElement.classList.toggle(\'collapsed\')">';
            html += '<span class="type-badge" style="background:rgba(232,168,56,0.12);color:#e8a838">Content</span>';
            html += '<span class="type-collapse-icon">▼</span>';
            html += '</div>';
            html += '<div class="type-content">';
            html += renderContentBlock(state.contentText, rules);
            if (state.isStreaming && state._activeSection === "content") {
                html += '<span class="streaming-cursor"></span>';
            }
            html += '</div></div>';
        }

        // If streaming but no content yet, show cursor
        if (state.isStreaming && !state.contentText && !state.reasoningText && state.toolCallOrder.length === 0) {
            html += '<span class="streaming-cursor"></span>';
        }

        return html;
    }

    function renderRoleSections(rules) {
        var html = "";
        var allRoles = state.roleOrder.slice();
        for (var r in state.roles) {
            if (!allRoles.includes(r)) allRoles.push(r);
        }
        for (var ri = 0; ri < allRoles.length; ri++) {
            var role = allRoles[ri];
            var text = state.roles[role] || "";
            if (!text && role !== state._activeRole) continue;
            var displayRole = role === "__default__" ? "default" : role;
            var color = ROLE_COLORS[ri % ROLE_COLORS.length];
            html += '<div class="role-section" data-role="' + escapeHtml(displayRole) + '">';
            html += '<div class="role-header">';
            html += '<span class="role-badge" style="background:' + color.bg + ';color:' + color.fg + '">' + escapeHtml(displayRole) + '</span>';
            html += '</div>';
            html += '<div class="role-content">';
            html += renderContentBlock(text, rules);
            if (state.isStreaming && role === state._activeRole) {
                html += '<span class="streaming-cursor"></span>';
            }
            html += '</div></div>';
        }
        return html;
    }

    function renderContentBlock(text, rules) {
        if (!text) return "";
        if (rules.contentFormat === "markdown") {
            return '<div class="rendered-content">' + renderMarkdown(text) + '</div>';
        } else if (rules.contentFormat === "json") {
            return '<pre><code>' + highlightJSON(text) + '</code></pre>';
        } else {
            return '<div class="rendered-content">' + escapeHtml(text) + '</div>';
        }
    }

    function appendEventCard(event, content, roleName, typeName) {
        const index = state.events.length;
        const card = document.createElement("div");
        card.className = "event-card";

        let headerHtml =
            '<span class="event-card-index">#' + index + "</span>";
        if (typeName) {
            var ts = TYPE_STYLES[typeName] || { label: typeName, badgeBg: "rgba(168,162,158,0.12)", badgeFg: "#a8a29e" };
            headerHtml += '<span class="type-badge" style="background:' + ts.badgeBg + ';color:' + ts.badgeFg + ';font-size:10px">' + escapeHtml(ts.label) + '</span>';
        }
        if (roleName) {
            var roleIdx = state.roleOrder.indexOf(roleName);
            if (roleIdx < 0) { roleIdx = state.roleOrder.length; state.roleOrder.push(roleName); }
            var color = ROLE_COLORS[roleIdx % ROLE_COLORS.length];
            headerHtml += '<span class="role-badge" style="background:' + color.bg + ';color:' + color.fg + ';font-size:10px">' + escapeHtml(roleName) + '</span>';
        }
        if (event.event) {
            headerHtml += '<span class="event-card-type">' + escapeHtml(event.event) + "</span>";
        }
        if (event.id) {
            headerHtml += '<span class="event-card-id">id: ' + escapeHtml(event.id) + "</span>";
        }

        let bodyHtml = "";
        const rules = getParseRules();
        if (rules.contentFormat === "json") {
            bodyHtml = highlightJSON(content);
        } else if (rules.contentFormat === "markdown") {
            bodyHtml = renderMarkdown(content);
        } else {
            bodyHtml = escapeHtml(content);
        }

        card.innerHTML =
            '<div class="event-card-header">' + headerHtml + "</div>" +
            '<div class="event-card-body">' + bodyHtml + "</div>";
        renderedOutput.appendChild(card);
        renderedOutput.scrollTop = renderedOutput.scrollHeight;
    }

    function appendRenderedRawSSE(event, content) {
        const div = document.createElement("div");
        div.className = "raw-event" + (event.event ? " event-" + event.event : "");
        let html = "";
        if (event.event) {
            html += '<div class="raw-field"><span class="raw-field-name">event:</span> <span class="raw-field-value">' + escapeHtml(event.event) + "</span></div>";
        }
        html += '<div class="raw-field"><span class="raw-field-name">data:</span> <span class="raw-field-value">';
        try {
            const jsonData = JSON.parse(event.data);
            html += highlightJSON(JSON.stringify(jsonData, null, 2));
        } catch {
            html += escapeHtml(event.data);
        }
        html += "</span></div>";
        div.innerHTML = html;
        if (state.isStreaming) {
            removeCursor();
            const cursor = document.createElement("span");
            cursor.className = "streaming-cursor";
            div.appendChild(cursor);
        }
        renderedOutput.appendChild(div);
        renderedOutput.scrollTop = renderedOutput.scrollHeight;
        statusSize.textContent = formatBytes(state.totalSize);
        statusEvents.textContent = state.events.length + " events";
    }

    // ── Raw Output ─────────────────────────────────────────
    function appendRawSSE(event) {
        const div = document.createElement("div");
        div.className = "raw-event" + (event.event ? " event-" + event.event : "");

        let html = "";
        if (event.event) {
            html += '<div class="raw-field"><span class="raw-field-name">event:</span> <span class="raw-field-value">' + escapeHtml(event.event) + "</span></div>";
        }
        if (event.id) {
            html += '<div class="raw-field"><span class="raw-field-name">id:</span> <span class="raw-field-value">' + escapeHtml(event.id) + "</span></div>";
        }
        html += '<div class="raw-field"><span class="raw-field-name">data:</span> <span class="raw-field-value">';

        // Try to pretty-print JSON data
        try {
            const jsonData = JSON.parse(event.data);
            html += highlightJSON(JSON.stringify(jsonData, null, 2));
        } catch {
            html += escapeHtml(event.data);
        }
        html += "</span></div>";

        div.innerHTML = html;
        rawOutput.appendChild(div);
        rawOutput.scrollTop = rawOutput.scrollHeight;
    }

    function appendRawChunk(data) {
        const div = document.createElement("div");
        div.className = "raw-event";
        div.innerHTML =
            '<div class="raw-field"><span class="raw-field-name">chunk:</span> <span class="raw-field-value">' +
            escapeHtml(data) + "</span></div>";
        rawOutput.appendChild(div);
        rawOutput.scrollTop = rawOutput.scrollHeight;
    }

    function appendRawComment(text) {
        const div = document.createElement("div");
        div.className = "raw-event";
        div.innerHTML =
            '<div class="raw-field"><span class="raw-field-name">:</span> <span class="raw-field-value" style="color:var(--text-muted)">' +
            escapeHtml(text) + "</span></div>";
        rawOutput.appendChild(div);
    }

    // ── Response Headers ───────────────────────────────────
    function renderResponseHeaders() {
        let html = '<table class="headers-table"><thead><tr><th>Header</th><th>Value</th></tr></thead><tbody>';
        for (const [key, value] of Object.entries(state.responseHeaders)) {
            html += "<tr><td>" + escapeHtml(key) + "</td><td>" + escapeHtml(value) + "</td></tr>";
        }
        html += "</tbody></table>";
        headersOutput.innerHTML = html;
    }

    // ── Stream Finish ──────────────────────────────────────
    function finishStream() {
        const elapsed = Date.now() - state.startTime;
        const statusLabel = state.responseStatus
            ? state.responseStatus + " " + getStatusText(state.responseStatus)
            : "Done";
        updateStatus(
            state.responseStatus >= 400 ? "error" : "success",
            statusLabel
        );
        statusTime.textContent = formatDuration(elapsed);
        statusSize.textContent = formatBytes(state.totalSize);
        statusEvents.textContent = state.events.length + " events";
    }

    function removeCursor() {
        renderedOutput.querySelectorAll(".streaming-cursor").forEach(function (c) { c.remove(); });
    }

    // ── Reset ──────────────────────────────────────────────
    function resetResponse() {
        state.events = [];
        state.accumulatedText = "";
        state.contentText = "";
        state.reasoningText = "";
        state.toolCalls = {};
        state.toolCallOrder = [];
        state._activeSection = "";
        state.roles = {};
        state.roleOrder = [];
        state._activeRole = "";
        state.responseHeaders = {};
        state.responseStatus = null;
        state.isSSE = false;
        state.totalSize = 0;
        renderedOutput.innerHTML = '<div class="empty-state">Waiting for response...</div>';
        rawOutput.innerHTML = "";
        headersOutput.innerHTML = "";
        statusTime.textContent = "";
        statusSize.textContent = "";
        statusEvents.textContent = "";
    }

    function initClear() {
        clearBtn.addEventListener("click", function () {
            state.events = [];
            state.accumulatedText = "";
            state.contentText = "";
            state.reasoningText = "";
            state.toolCalls = {};
            state.toolCallOrder = [];
            state._activeSection = "";
            state.roles = {};
            state.roleOrder = [];
            state._activeRole = "";
            state.responseHeaders = {};
            state.responseStatus = null;
            state.totalSize = 0;
            renderedOutput.innerHTML = '<div class="empty-state">Send a request to see the response</div>';
            rawOutput.innerHTML = "";
            headersOutput.innerHTML = "";
            updateStatus("idle", "Ready");
            statusTime.textContent = "";
            statusSize.textContent = "";
            statusEvents.textContent = "";
        });
    }

    function initCopy() {
        copyBtn.addEventListener("click", function () {
            var text = "";
            // Compose copy text from all structured content
            if (state.toolCallOrder.length > 0) {
                for (var i = 0; i < state.toolCallOrder.length; i++) {
                    var tc = state.toolCalls[state.toolCallOrder[i]];
                    if (tc) {
                        text += "[Tool Call: " + tc.name + "]\n";
                        if (tc.id) text += "ID: " + tc.id + "\n";
                        text += tc.arguments + "\n\n";
                    }
                }
            }
            if (state.reasoningText) {
                text += "[Thinking]\n" + state.reasoningText + "\n\n";
            }
            if (state.contentText) {
                text += state.contentText;
            }
            if (!text) text = state.accumulatedText || renderedOutput.textContent || "";
            navigator.clipboard.writeText(text).then(function () {
                showToast("Copied to clipboard", "success");
            }).catch(function () {
                showToast("Failed to copy", "error");
            });
        });
    }

    // ── History ────────────────────────────────────────────
    function loadHistory() {
        try {
            return JSON.parse(localStorage.getItem(HISTORY_KEY)) || [];
        } catch { return []; }
    }

    function saveHistory(list) {
        localStorage.setItem(HISTORY_KEY, JSON.stringify(list));
    }

    function pushHistory(entry) {
        var list = loadHistory();
        list.unshift(entry);
        if (list.length > HISTORY_MAX) list = list.slice(0, HISTORY_MAX);
        saveHistory(list);
        renderHistory();
    }

    function deleteHistory(id) {
        var list = loadHistory().filter(function (h) { return h.id !== id; });
        saveHistory(list);
        renderHistory();
    }

    function clearAllHistory() {
        saveHistory([]);
        renderHistory();
    }

    function captureCurrentRequest() {
        var method = methodSelect.value;
        var url = urlInput.value.trim();
        var headers = getKVPairs("headersList");
        var bodyType = getBodyType();
        var body = "";
        var form = {};
        switch (bodyType) {
            case "json": body = $("#jsonBody").value; break;
            case "form": form = getKVPairs("formList"); break;
            case "raw": body = $("#rawBody").value; break;
        }
        var parseRules = getParseRules();
        return {
            id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
            method: method,
            url: url,
            headers: headers,
            bodyType: bodyType,
            body: body,
            form: form,
            parseRules: parseRules,
            skipSSL: skipSSLCheckbox.checked,
            timestamp: Date.now(),
        };
    }

    function restoreRequest(entry) {
        // Method
        methodSelect.value = entry.method;
        updateMethodColor();

        // URL
        urlInput.value = entry.url || "";

        // Headers
        var headersList = $("#headersList");
        headersList.innerHTML = "";
        if (entry.headers && Object.keys(entry.headers).length > 0) {
            for (var [k, v] of Object.entries(entry.headers)) {
                addKVRow(headersList, k, v);
            }
        } else {
            addKVRow(headersList, "", "");
        }

        // Body type
        var bodyType = entry.bodyType || "none";
        document.querySelectorAll('input[name="bodyType"]').forEach(function (r) {
            r.checked = r.value === bodyType;
        });
        document.querySelectorAll(".body-editor").forEach(function (ed) {
            ed.style.display = ed.dataset.type === bodyType ? "" : "none";
        });

        // Body content
        if (entry.bodyType === "json") {
            $("#jsonBody").value = entry.body || "";
        } else if (entry.bodyType === "raw") {
            $("#rawBody").value = entry.body || "";
        }

        // Form
        if (entry.bodyType === "form") {
            var formList = $("#formList");
            formList.innerHTML = "";
            if (entry.form && Object.keys(entry.form).length > 0) {
                for (var [fk, fv] of Object.entries(entry.form)) {
                    addKVRow(formList, fk, fv);
                }
            } else {
                addKVRow(formList, "", "");
            }
        }

        // Parse rules
        if (entry.parseRules) {
            if (entry.parseRules.contentPath != null) $("#contentPath").value = entry.parseRules.contentPath;
            if (entry.parseRules.reasoningPath != null) $("#reasoningPath").value = entry.parseRules.reasoningPath;
            if (entry.parseRules.toolCallsPath != null) $("#toolCallsPath").value = entry.parseRules.toolCallsPath;
            if (entry.parseRules.rolePath != null) $("#rolePath").value = entry.parseRules.rolePath;
            if (entry.parseRules.eventFilter != null) $("#eventFilter").value = entry.parseRules.eventFilter;
            if (entry.parseRules.displayMode) $("#displayMode").value = entry.parseRules.displayMode;
            if (entry.parseRules.contentFormat) $("#contentFormat").value = entry.parseRules.contentFormat;
            if (entry.parseRules.ignoreDone != null) $("#ignoreDone").checked = entry.parseRules.ignoreDone;
            // Legacy: map old fields for backward compatibility
            if (entry.parseRules.dataPath != null && !entry.parseRules.contentPath) $("#contentPath").value = entry.parseRules.dataPath;
        }

        // SSL
        if (entry.skipSSL != null) skipSSLCheckbox.checked = entry.skipSSL;

        // Close drawer
        closeHistoryDrawer();
        showToast("Request loaded", "success");
    }

    function renderHistory() {
        var list = loadHistory();
        if (list.length === 0) {
            historyList.innerHTML = '<div class="history-empty">No requests yet</div>';
            return;
        }
        historyList.innerHTML = "";
        for (var i = 0; i < list.length; i++) {
            var entry = list[i];
            var item = document.createElement("div");
            item.className = "history-item";
            item.dataset.id = entry.id;

            var topRow = document.createElement("div");
            topRow.className = "history-item-top";

            var methodBadge = document.createElement("span");
            methodBadge.className = "history-method method-" + entry.method;
            methodBadge.textContent = entry.method;

            var urlSpan = document.createElement("span");
            urlSpan.className = "history-url";
            urlSpan.textContent = entry.url;
            urlSpan.title = entry.url;

            var timeSpan = document.createElement("span");
            timeSpan.className = "history-time";
            timeSpan.textContent = formatHistoryTime(entry.timestamp);

            topRow.appendChild(methodBadge);
            topRow.appendChild(urlSpan);
            topRow.appendChild(timeSpan);

            // Body hint line
            var hint = "";
            if (entry.bodyType === "json" && entry.body) {
                try { hint = Object.keys(JSON.parse(entry.body)).join(", "); } catch { hint = entry.body.slice(0, 60); }
            } else if (entry.bodyType === "form" && entry.form) {
                hint = Object.keys(entry.form).join(", ");
            }
            var hintDiv = null;
            if (hint) {
                hintDiv = document.createElement("div");
                hintDiv.className = "history-body-hint";
                hintDiv.textContent = hint;
            }

            var delBtn = document.createElement("button");
            delBtn.className = "history-delete";
            delBtn.title = "Delete";
            delBtn.textContent = "×";

            item.appendChild(topRow);
            if (hintDiv) item.appendChild(hintDiv);
            item.appendChild(delBtn);

            (function (e) {
                item.addEventListener("click", function (ev) {
                    if (ev.target.closest(".history-delete")) return;
                    restoreRequest(e);
                });
                delBtn.addEventListener("click", function (ev) {
                    ev.stopPropagation();
                    deleteHistory(e.id);
                });
            })(entry);

            historyList.appendChild(item);
        }
    }

    function formatHistoryTime(ts) {
        if (!ts) return "";
        var d = new Date(ts);
        var now = new Date();
        var diff = now - d;
        if (diff < 60000) return "just now";
        if (diff < 3600000) return Math.floor(diff / 60000) + "m ago";
        if (diff < 86400000) return Math.floor(diff / 3600000) + "h ago";
        var mm = String(d.getMonth() + 1).padStart(2, "0");
        var dd = String(d.getDate()).padStart(2, "0");
        var hh = String(d.getHours()).padStart(2, "0");
        var mi = String(d.getMinutes()).padStart(2, "0");
        return mm + "/" + dd + " " + hh + ":" + mi;
    }

    function openHistoryDrawer() {
        historyDrawer.classList.add("open");
        historyOverlay.classList.add("open");
        renderHistory();
    }

    function closeHistoryDrawer() {
        historyDrawer.classList.remove("open");
        historyOverlay.classList.remove("open");
    }

    function initHistory() {
        historyBtn.addEventListener("click", function () {
            if (historyDrawer.classList.contains("open")) {
                closeHistoryDrawer();
            } else {
                openHistoryDrawer();
            }
        });
        historyOverlay.addEventListener("click", closeHistoryDrawer);
        clearAllHistoryBtn.addEventListener("click", function () {
            clearAllHistory();
            showToast("History cleared", "success");
        });
        document.addEventListener("keydown", function (e) {
            if (e.key === "Escape") closeHistoryDrawer();
            if ((e.ctrlKey || e.metaKey) && e.key === "h") {
                e.preventDefault();
                if (historyDrawer.classList.contains("open")) {
                    closeHistoryDrawer();
                } else {
                    openHistoryDrawer();
                }
            }
        });
        renderHistory();
    }

    // ── Status Bar ─────────────────────────────────────────
    function updateStatus(type, text) {
        statusIndicator.className = "status-" + type;
        statusIndicator.textContent = text;
    }

    function startTimer() {
        state.timerInterval = setInterval(function () {
            if (state.startTime) {
                const elapsed = Date.now() - state.startTime;
                statusTime.textContent = formatDuration(elapsed);
            }
        }, 100);
    }

    function stopTimer() {
        if (state.timerInterval) {
            clearInterval(state.timerInterval);
            state.timerInterval = null;
        }
    }

    // ── Toast ──────────────────────────────────────────────
    function showToast(message, type) {
        const toast = document.createElement("div");
        toast.className = "toast" + (type ? " toast-" + type : "");
        toast.textContent = message;
        document.body.appendChild(toast);
        setTimeout(function () {
            toast.style.opacity = "0";
            toast.style.transition = "opacity 0.3s";
            setTimeout(function () { toast.remove(); }, 300);
        }, 3000);
    }

    // ── Utility ────────────────────────────────────────────
    function formatBytes(bytes) {
        if (bytes === 0) return "";
        if (bytes < 1024) return bytes + " B";
        if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
        return (bytes / (1024 * 1024)).toFixed(1) + " MB";
    }

    function formatDuration(ms) {
        if (ms < 1000) return ms + " ms";
        return (ms / 1000).toFixed(2) + " s";
    }

    function getStatusText(code) {
        var texts = {
            200: "OK", 201: "Created", 204: "No Content",
            301: "Moved", 302: "Found", 304: "Not Modified",
            400: "Bad Request", 401: "Unauthorized", 403: "Forbidden",
            404: "Not Found", 405: "Method Not Allowed", 408: "Timeout",
            429: "Too Many Requests",
            500: "Server Error", 502: "Bad Gateway", 503: "Unavailable",
        };
        return texts[code] || "";
    }

    // ── Init ───────────────────────────────────────────────
    function init() {
        updateMethodColor();
        methodSelect.addEventListener("change", updateMethodColor);
        initTabs();
        initKVEditor();
        initBodyType();
        initFormatJson();
        initDivider();
        initSend();
        initClear();
        initCopy();
        initHistory();
        updateStatus("idle", "Ready");
    }

    init();
})();
