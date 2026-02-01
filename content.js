/**
 * UX HeatGrid - Content Script
 * Tracks attention on elements and mouse behavior
 * Generates Real-time UX Analytics & Heatmap Visualization
 */

(function () {
    'use strict';

    const DEBUG = false;
    const debug = (...args) => DEBUG && console.log(...args);

    if (window.__domHeatmapCleanup) {
        try { window.__domHeatmapCleanup(); } catch (e) { }
    }

    window.__domHeatmapCleanup = () => {
        if (updateIntervalId) clearInterval(updateIntervalId);
        if (rafRenderId) cancelAnimationFrame(rafRenderId);
        if (scrollHandler) window.removeEventListener('scroll', scrollHandler);
        if (mouseMoveHandler) document.removeEventListener('mousemove', mouseMoveHandler);
        if (resizeHandler) window.removeEventListener('resize', resizeHandler);
        if (activeTimeTrackerId) clearInterval(activeTimeTrackerId);
        if (mutationObserver) mutationObserver.disconnect();
        window.__domHeatmapInitialized = false;
    };

    window.__domHeatmapInitialized = true;

    // ============================================
    // CONFIGURATION
    // ============================================
    const CONFIG = {
        cellSize: 15,
        updateInterval: 500,
        mouseInfluenceRadius: 150,
        colorStops: [
            { pos: 0.0, color: [100, 150, 255, 0.0] },
            { pos: 0.1, color: [120, 180, 255, 0.20] },
            { pos: 0.25, color: [150, 200, 255, 0.30] },
            { pos: 0.4, color: [180, 220, 255, 0.38] },
            { pos: 0.55, color: [200, 240, 200, 0.45] },
            { pos: 0.7, color: [255, 240, 180, 0.50] },
            { pos: 0.85, color: [255, 200, 150, 0.55] },
            { pos: 1.0, color: [255, 160, 160, 0.60] }
        ],
        textSelectors: 'h1, h2, h3, h4, h5, h6, p, a, li, button, input, textarea, select, label, span, strong, em, b, i, blockquote, article, code, pre, td, th, figcaption, caption, legend, summary, details, mark, time, small',
        elementPriority: {
            'BUTTON': 2.0, 'A': 1.8, 'INPUT': 1.7, 'TEXTAREA': 1.7, 'SELECT': 1.6, 'SUMMARY': 1.5, 'DETAILS': 1.5,
            'H1': 1.4, 'H2': 1.3, 'H3': 1.2, 'H4': 1.1, 'H5': 1.1, 'H6': 1.1,
            'P': 1.0, 'ARTICLE': 1.0, 'BLOCKQUOTE': 1.0, 'LI': 0.9, 'TD': 0.9, 'TH': 0.9,
            'STRONG': 0.8, 'EM': 0.8, 'B': 0.8, 'I': 0.7, 'CODE': 0.8, 'PRE': 0.8, 'MARK': 0.9,
            'LABEL': 0.7, 'FIGCAPTION': 0.6, 'CAPTION': 0.6, 'LEGEND': 0.6, 'TIME': 0.5, 'SMALL': 0.5,
            'SPAN': 0.4
        },
        dwellIncrement: 0.8,
        maxDwellScore: 5.0,
        mouseHeatStrength: 5.0,
        clickBoost: 2.5,
        minScoreToRender: 0.01
    };

    // ============================================
    // STATE
    // ============================================
    let isTracking = false;
    let isVisible = false;
    let heatmapCanvas = null;
    let ctx = null;
    let grid = [];
    let gridCols = 0;
    let gridRows = 0;

    let mouseX = -1000;
    let mouseY = -1000;
    let mouseHeatMap = new Map();
    let lastMouseMoveTime = 0;

    let trackedElements = [];

    let analytics = {
        activeTimeMs: 0,
        lastInteractionTime: 0,
        scrollVelocity: 0,
        scrollVelocities: []
    };

    let scrollHandler = null;
    let mouseMoveHandler = null;
    let resizeHandler = null;
    let updateIntervalId = null;
    let rafRenderId = null;
    let activeTimeTrackerId = null;
    let mutationObserver = null;
    let mutationTimeout = null;

    // ============================================
    // CORE LOGIC
    // ============================================
    function initGrid() {
        const docWidth = Math.max(document.body.scrollWidth, document.documentElement.scrollWidth);
        const docHeight = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight);
        gridCols = Math.ceil(docWidth / CONFIG.cellSize);
        gridRows = Math.ceil(docHeight / CONFIG.cellSize);
        grid = Array.from({ length: gridRows }, () => new Float32Array(gridCols));
    }

    function analyzeElements() {
        try {
            const elements = document.querySelectorAll(CONFIG.textSelectors);
            const newTracked = [];
            const existingMap = new Map(trackedElements.map(item => [item.element, item]));

            elements.forEach(el => {
                if (el.offsetParent === null) return;
                const rect = el.getBoundingClientRect();
                const text = (el.innerText || el.textContent || '').trim();
                if (rect.width < 10 || rect.height < 10) return;

                const tagName = el.tagName.toUpperCase();
                const isInteractive = ['A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'SUMMARY'].includes(tagName);
                if (!isInteractive && (text.length < 6 || text.replace(/\s/g, '').length < 4)) return;
                if (isInteractive && text.length === 0 && !['INPUT', 'SELECT'].includes(tagName)) return;

                const priorityWeight = CONFIG.elementPriority[tagName] || 0.5;
                const existing = existingMap.get(el);

                if (existing) {
                    existing.rect = { top: rect.top + window.scrollY, left: rect.left + window.scrollX, width: rect.width, height: rect.height };
                    existing.priorityWeight = priorityWeight;
                    newTracked.push(existing);
                } else {
                    newTracked.push({
                        element: el,
                        rect: { top: rect.top + window.scrollY, left: rect.left + window.scrollX, width: rect.width, height: rect.height },
                        dwellScore: 0, lastVisible: false, priorityWeight
                    });
                }
            });
            trackedElements = newTracked;
            checkAndResizeGrid();
        } catch (err) { console.error('[UX HeatGrid] analyzeElements error:', err); }
    }

    function checkAndResizeGrid() {
        const docWidth = Math.max(document.body.scrollWidth, document.documentElement.scrollWidth);
        const docHeight = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight);
        const newCols = Math.ceil(docWidth / CONFIG.cellSize);
        const newRows = Math.ceil(docHeight / CONFIG.cellSize);

        if (newCols !== gridCols || newRows !== gridRows) {
            const oldGrid = grid;
            const oldRows = gridRows;
            const oldCols = gridCols;
            gridCols = newCols;
            gridRows = newRows;
            grid = Array.from({ length: gridRows }, () => new Float32Array(gridCols));

            for (let row = 0; row < Math.min(oldRows, gridRows); row++) {
                for (let col = 0; col < Math.min(oldCols, gridCols); col++) {
                    grid[row][col] = oldGrid[row][col];
                }
            }
        }
    }

    // ============================================
    // TRACKING & REBUILD
    // ============================================
    function setupListeners() {
        if (!mouseMoveHandler) {
            mouseMoveHandler = (e) => {
                mouseX = e.pageX; mouseY = e.pageY;
                lastMouseMoveTime = Date.now();
                registerInteraction();
            };
            document.addEventListener('mousemove', mouseMoveHandler, { passive: true });
            document.addEventListener('click', (e) => {
                registerInteraction();
                addMouseHeat(e.pageX, e.pageY, CONFIG.clickBoost);
            }, { passive: true });
        }
        if (!scrollHandler) {
            let lastScrollY = window.scrollY;
            let lastScrollTime = Date.now();
            scrollHandler = () => {
                const now = Date.now();
                const currentScrollY = window.scrollY;
                const delta = Math.abs(currentScrollY - lastScrollY);
                const timeDelta = now - lastScrollTime;
                if (timeDelta > 0) {
                    const velocity = (delta / timeDelta) * 1000;
                    analytics.scrollVelocity = velocity;
                    analytics.scrollVelocities.push(velocity);
                    if (analytics.scrollVelocities.length > 10) analytics.scrollVelocities.shift();
                }
                lastScrollY = currentScrollY;
                lastScrollTime = now;
                registerInteraction();
                updateElementVisibility();
            };
            window.addEventListener('scroll', scrollHandler, { passive: true });
        }
    }

    function updateElementVisibility() {
        const viewportTop = window.scrollY;
        const viewportBottom = viewportTop + window.innerHeight;
        trackedElements.forEach(item => {
            item.lastVisible = (item.rect.top + item.rect.height > viewportTop && item.rect.top < viewportBottom);
        });
    }

    function addMouseHeat(x, y, strength = 1.0) {
        const key = `${Math.floor(x / CONFIG.cellSize)}_${Math.floor(y / CONFIG.cellSize)}`;
        const current = mouseHeatMap.get(key) || 0;
        mouseHeatMap.set(key, Math.min(current + strength, CONFIG.maxDwellScore));
    }

    function updateTracking() {
        if (!isTracking) return;
        const now = Date.now();
        const currentScrollVelocity = Math.abs(analytics.scrollVelocity || 0);
        const scrollFactor = Math.max(0.1, Math.min(1.0, 1 - (currentScrollVelocity / 1500)));

        trackedElements.forEach(item => {
            if (item.lastVisible) {
                const baseInc = CONFIG.dwellIncrement * item.priorityWeight;
                const mouseIn = (mouseX >= item.rect.left && mouseX <= item.rect.left + item.rect.width &&
                    mouseY >= item.rect.top && mouseY <= item.rect.top + item.rect.height);
                const finalInc = mouseIn && (now - lastMouseMoveTime < 3000) ? baseInc * 2.0 * scrollFactor : baseInc * 0.3 * scrollFactor;
                item.dwellScore = Math.min(item.dwellScore + finalInc, CONFIG.maxDwellScore);
            }
        });

        if (now - lastMouseMoveTime < 2000) addMouseHeat(mouseX, mouseY, CONFIG.mouseHeatStrength * 0.25);
        for (const [key, value] of mouseHeatMap.entries()) {
            const newVal = value * 0.96;
            if (newVal < 0.1) mouseHeatMap.delete(key); else mouseHeatMap.set(key, newVal);
        }
        rebuildGrid();
    }

    function rebuildGrid() {
        grid.forEach(row => row.fill(0));
        const rowIndex = new Map();
        trackedElements.forEach(item => {
            const startRow = Math.floor(item.rect.top / CONFIG.cellSize);
            const endRow = Math.ceil((item.rect.top + item.rect.height) / CONFIG.cellSize);
            for (let r = startRow; r <= endRow; r++) {
                if (!rowIndex.has(r)) rowIndex.set(r, []);
                rowIndex.get(r).push(item);
            }
        });

        const isPointInElement = (x, y) => {
            const candidates = rowIndex.get(Math.floor(y / CONFIG.cellSize)) || [];
            return candidates.some(item => x >= item.rect.left && x <= item.rect.left + item.rect.width && y >= item.rect.top && y <= item.rect.top + item.rect.height);
        };

        for (const [key, heat] of mouseHeatMap.entries()) {
            const [x, y] = key.split('_').map(Number);
            const centerX = x * CONFIG.cellSize + CONFIG.cellSize / 2;
            const centerY = y * CONFIG.cellSize + CONFIG.cellSize / 2;
            const radius = Math.ceil(CONFIG.mouseInfluenceRadius / CONFIG.cellSize);

            for (let r = Math.max(0, y - radius); r < Math.min(gridRows, y + radius); r++) {
                for (let c = Math.max(0, x - radius); c < Math.min(gridCols, x + radius); c++) {
                    const cellX = c * CONFIG.cellSize + CONFIG.cellSize / 2;
                    const cellY = r * CONFIG.cellSize + CONFIG.cellSize / 2;
                    if (!isPointInElement(cellX, cellY)) continue;
                    const dist = Math.sqrt((c * CONFIG.cellSize - centerX) ** 2 + (r * CONFIG.cellSize - centerY) ** 2);
                    if (dist < CONFIG.mouseInfluenceRadius) {
                        const falloff = (1 - (dist / CONFIG.mouseInfluenceRadius)) ** 2;
                        grid[r][c] = Math.max(grid[r][c], heat * falloff);
                    }
                }
            }
        }

        trackedElements.forEach(item => {
            if (item.dwellScore < 0.1) return;
            const startCol = Math.max(0, Math.floor(item.rect.left / CONFIG.cellSize));
            const endCol = Math.min(gridCols, Math.ceil((item.rect.left + item.rect.width) / CONFIG.cellSize));
            const startRow = Math.max(0, Math.floor(item.rect.top / CONFIG.cellSize));
            const endRow = Math.min(gridRows, Math.ceil((item.rect.top + item.rect.height) / CONFIG.cellSize));
            for (let r = startRow; r < endRow; r++) {
                for (let c = startCol; c < endCol; c++) {
                    grid[r][c] = Math.max(grid[r][c], item.dwellScore * 0.8);
                }
            }
        });
    }

    // ============================================
    // RENDERING
    // ============================================
    function createCanvas() {
        if (heatmapCanvas) return;
        heatmapCanvas = document.createElement('canvas');
        heatmapCanvas.id = 'dom-heatmap-canvas';
        heatmapCanvas.style.cssText = 'position:absolute;top:0;left:0;pointer-events:none;z-index:9999;image-rendering:auto;';
        updateCanvasDimensions();
        document.body.appendChild(heatmapCanvas);
        ctx = heatmapCanvas.getContext('2d', { willReadFrequently: true });
    }

    function updateCanvasDimensions() {
        if (!heatmapCanvas) return;
        const w = Math.max(document.body.scrollWidth, document.documentElement.scrollWidth);
        const h = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight);
        heatmapCanvas.width = gridCols; heatmapCanvas.height = gridRows;
        heatmapCanvas.style.width = w + 'px'; heatmapCanvas.style.height = h + 'px';
    }

    function render() {
        if (!isVisible || !ctx) return;
        const imgData = ctx.createImageData(gridCols, gridRows);
        const data = imgData.data;

        for (let r = 0; r < gridRows; r++) {
            for (let c = 0; c < gridCols; c++) {
                const score = grid[r][c];
                const idx = (r * gridCols + c) * 4;
                if (score < CONFIG.minScoreToRender) {
                    data[idx] = data[idx + 1] = data[idx + 2] = data[idx + 3] = 0;
                    continue;
                }
                const t = Math.min(1, score / CONFIG.maxDwellScore);
                let lower = CONFIG.colorStops[0], upper = CONFIG.colorStops[CONFIG.colorStops.length - 1];
                for (let i = 0; i < CONFIG.colorStops.length - 1; i++) {
                    if (t >= CONFIG.colorStops[i].pos && t <= CONFIG.colorStops[i + 1].pos) {
                        lower = CONFIG.colorStops[i]; upper = CONFIG.colorStops[i + 1]; break;
                    }
                }
                const localT = (upper.pos - lower.pos) > 0 ? (t - lower.pos) / (upper.pos - lower.pos) : 0;
                data[idx] = Math.round(lower.color[0] + (upper.color[0] - lower.color[0]) * localT);
                data[idx + 1] = Math.round(lower.color[1] + (upper.color[1] - lower.color[1]) * localT);
                data[idx + 2] = Math.round(lower.color[2] + (upper.color[2] - lower.color[2]) * localT);
                data[idx + 3] = (lower.color[3] + (upper.color[3] - lower.color[3]) * localT) * 255;
            }
        }
        ctx.putImageData(imgData, 0, 0);
    }

    // ============================================
    // ANALYTICS & MESSAGING
    // ============================================
    function calculateUXDensity(w, h, vh) {
        let totalTextArea = 0, totalChars = 0, hCount = 0, iCount = 0, pCount = 0;
        trackedElements.forEach(item => {
            totalTextArea += item.rect.width * item.rect.height;
            const text = (item.element.innerText || '').trim();
            totalChars += text.length;
            const tag = item.element.tagName.toUpperCase();
            if (tag.startsWith('H')) hCount++;
            if (['BUTTON', 'A', 'INPUT', 'TEXTAREA', 'SELECT'].includes(tag)) iCount++;
            if (['P', 'LI', 'ARTICLE'].includes(tag)) pCount++;
        });

        const density = Math.min((totalTextArea / (w * h)) * 100, 100);
        const wsRatio = Math.max(0, 100 - density);
        const eps = trackedElements.length / Math.max(h / vh, 1);
        const cps = totalChars / Math.max(h / vh, 1);

        let uxScore = 100, issues = [], positives = [];
        if (density > 50) { uxScore -= 15; issues.push({ category: 'Content', message: 'Dense content' }); }
        else if (density > 15) positives.push({ category: 'Content', message: 'Clean design' });

        if (wsRatio < 30) { uxScore -= 20; issues.push({ category: 'Layout', message: 'Insufficient white space' }); }
        else if (wsRatio >= 50 && wsRatio <= 70) positives.push({ category: 'Layout', message: 'Ideal white space' });

        if (eps > 20) { uxScore -= 10; issues.push({ category: 'Layout', message: 'Dense layout' }); }
        else if (eps >= 8 && eps <= 15) positives.push({ category: 'Layout', message: 'Optimal element count' });

        if (hCount >= 1 && pCount >= 3) positives.push({ category: 'Structure', message: 'Well structured' });

        uxScore = Math.max(0, Math.min(100, uxScore));
        const label = uxScore >= 85 ? 'Excellent' : uxScore >= 70 ? 'Good' : uxScore >= 55 ? 'Average' : uxScore >= 40 ? 'Dense' : 'Fatiguing';

        return { score: Math.round(uxScore), label, textDensity: Math.round(density), whiteSpaceRatio: Math.round(wsRatio), elementsPerScreen: Math.round(eps * 10) / 10, issues, positives };
    }

    function getAnalytics() {
        const activeSeconds = Math.floor(analytics.activeTimeMs / 1000);
        const viewed = trackedElements.filter(item => item.dwellScore > 1.0).length;
        const ux = calculateUXDensity(Math.max(document.body.scrollWidth, document.documentElement.scrollWidth), Math.max(document.body.scrollHeight, document.documentElement.scrollHeight), window.innerHeight);
        return {
            activeTime: activeSeconds < 60 ? activeSeconds + 's' : Math.floor(activeSeconds / 60) + 'm ' + (activeSeconds % 60) + 's',
            activeTimeSec: activeSeconds, isTracking, hasData: viewed >= 2 && activeSeconds >= 15, uxEvaluation: ux
        };
    }

    function registerInteraction() { if (isTracking) analytics.lastInteractionTime = Date.now(); }

    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
        if (msg.action === 'startTracking') {
            if (!isTracking) {
                isTracking = true; if (!grid.length) initGrid(); analyzeElements(); updateElementVisibility(); setupListeners();
                updateIntervalId = setInterval(updateTracking, CONFIG.updateInterval);
                activeTimeTrackerId = setInterval(() => {
                    if (isTracking && Date.now() - analytics.lastInteractionTime < 5000) analytics.activeTimeMs += 1000;
                }, 1000);
            }
            sendResponse({ success: true, isPaused: false });
        } else if (msg.action === 'pauseTracking') {
            isTracking = false; clearInterval(updateIntervalId); clearInterval(activeTimeTrackerId); updateIntervalId = activeTimeTrackerId = null;
            sendResponse({ success: true, isPaused: true });
        } else if (msg.action === 'stopTracking') {
            isTracking = false; clearInterval(updateIntervalId); clearInterval(activeTimeTrackerId); updateIntervalId = activeTimeTrackerId = null;
            grid = []; trackedElements = []; mouseHeatMap.clear(); if (isVisible) { isVisible = false; cancelAnimationFrame(rafRenderId); rafRenderId = null; if (heatmapCanvas) heatmapCanvas.remove(); heatmapCanvas = null; }
            analytics = { activeTimeMs: 0, lastInteractionTime: Date.now(), scrollVelocity: 0, scrollVelocities: [] };
            sendResponse({ success: true });
        } else if (msg.action === 'showHeatmap') {
            if (!isVisible) { isVisible = true; if (!grid.length) initGrid(); createCanvas(); const loop = () => { if (!isVisible) { rafRenderId = null; return; } render(); rafRenderId = requestAnimationFrame(loop); }; loop(); }
            sendResponse({ success: true });
        } else if (msg.action === 'hideHeatmap') {
            if (isVisible) { isVisible = false; cancelAnimationFrame(rafRenderId); rafRenderId = null; if (heatmapCanvas) heatmapCanvas.remove(); heatmapCanvas = null; }
            sendResponse({ success: true });
        } else if (msg.action === 'clear') {
            grid = []; trackedElements = []; mouseHeatMap.clear(); if (isVisible) { isVisible = false; cancelAnimationFrame(rafRenderId); rafRenderId = null; if (heatmapCanvas) heatmapCanvas.remove(); heatmapCanvas = null; }
            analytics = { activeTimeMs: 0, lastInteractionTime: Date.now(), scrollVelocity: 0, scrollVelocities: [] };
            sendResponse({ success: true });
        } else if (msg.action === 'getStatus') {
            sendResponse({ isTracking, isVisible, isPaused: !isTracking });
        } else if (msg.action === 'getAnalytics') {
            sendResponse(getAnalytics());
        }
        return true;
    });

    window.addEventListener('resize', () => { if (isVisible || isTracking) { initGrid(); if (isVisible) updateCanvasDimensions(); analyzeElements(); } });
    mutationObserver = new MutationObserver(() => {
        if (!isTracking) return;
        if (mutationTimeout) clearTimeout(mutationTimeout);
        mutationTimeout = setTimeout(() => { analyzeElements(); mutationTimeout = null; }, 2000);
    });
    mutationObserver.observe(document.body, { childList: true, subtree: true });

})();
