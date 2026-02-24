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
        // Dark mode palette (original - for dark backgrounds)
        colorStopsDark: [
            { pos: 0.0, color: [100, 150, 255, 0.0] },
            { pos: 0.1, color: [120, 180, 255, 0.20] },
            { pos: 0.25, color: [150, 200, 255, 0.30] },
            { pos: 0.4, color: [180, 220, 255, 0.38] },
            { pos: 0.55, color: [200, 240, 200, 0.45] },
            { pos: 0.7, color: [255, 240, 180, 0.50] },
            { pos: 0.85, color: [255, 200, 150, 0.55] },
            { pos: 1.0, color: [255, 160, 130, 0.60] }
        ],
        // Light mode palette (opaque colors for multiply blend mode)
        // In multiply mode: white=invisible, colors darken the background
        colorStopsLight: [
            { pos: 0.0, color: [255, 255, 255, 1.0] },
            { pos: 0.1, color: [200, 220, 255, 1.0] },
            { pos: 0.25, color: [140, 190, 255, 1.0] },
            { pos: 0.4, color: [100, 200, 220, 1.0] },
            { pos: 0.55, color: [140, 220, 130, 1.0] },
            { pos: 0.7, color: [220, 220, 80, 1.0] },
            { pos: 0.85, color: [255, 150, 60, 1.0] },
            { pos: 1.0, color: [255, 80, 40, 1.0] }
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
    let isLightMode = false;
    let activeColorStops = CONFIG.colorStopsDark; // default, updated by detectPageTheme()
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

    // Cached UX evaluation - prevents score from changing on pause/resume
    let cachedUXEvaluation = null;
    let uxEvalDirty = true; // true = needs recomputation

    let scrollHandler = null;
    let mouseMoveHandler = null;
    let resizeHandler = null;
    let updateIntervalId = null;
    let rafRenderId = null;
    let activeTimeTrackerId = null;
    let mutationObserver = null;
    let mutationTimeout = null;

    // ============================================
    // THEME DETECTION
    // ============================================
    function detectPageTheme() {
        try {
            // Parse rgb/rgba string to [r, g, b, a]
            const parse = (str) => {
                const m = str.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+))?\s*\)/);
                return m ? [+m[1], +m[2], +m[3], m[4] !== undefined ? +m[4] : 1] : null;
            };

            // Check if color is transparent
            const isTransparent = (rgba) => !rgba || rgba[3] === 0;

            // Try body, then html
            const bodyBg = parse(window.getComputedStyle(document.body).backgroundColor);
            const htmlBg = parse(window.getComputedStyle(document.documentElement).backgroundColor);

            let rgb = null;
            if (!isTransparent(bodyBg)) {
                rgb = bodyBg;
            } else if (!isTransparent(htmlBg)) {
                rgb = htmlBg;
            }

            // If both are transparent, sample actual pixels from the page
            if (!rgb) {
                // Use elementFromPoint at a few spots to find the actual background
                const samplePoints = [
                    [window.innerWidth / 2, 50],
                    [100, window.innerHeight / 2],
                    [window.innerWidth / 2, window.innerHeight / 2]
                ];
                for (const [x, y] of samplePoints) {
                    const el = document.elementFromPoint(x, y);
                    if (el) {
                        const bg = parse(window.getComputedStyle(el).backgroundColor);
                        if (!isTransparent(bg)) { rgb = bg; break; }
                        // Walk up parents
                        let parent = el.parentElement;
                        while (parent && parent !== document.documentElement) {
                            const pbg = parse(window.getComputedStyle(parent).backgroundColor);
                            if (!isTransparent(pbg)) { rgb = pbg; break; }
                            parent = parent.parentElement;
                        }
                        if (rgb) break;
                    }
                }
            }

            // Default to white (light) if we truly can't determine
            if (!rgb) rgb = [255, 255, 255, 1];

            // Relative luminance (simplified perceptual)
            const lum = (0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2]) / 255;

            activeColorStops = lum > 0.5 ? CONFIG.colorStopsLight : CONFIG.colorStopsDark;
            isLightMode = lum > 0.5;

            // Apply blend mode to canvas if it exists
            if (heatmapCanvas) {
                heatmapCanvas.style.mixBlendMode = isLightMode ? 'multiply' : 'normal';
            }

            debug('[UX HeatGrid] Theme detected:', isLightMode ? 'LIGHT' : 'DARK', 'bg:', rgb.slice(0, 3), 'luminance:', lum.toFixed(2));
        } catch (e) {
            activeColorStops = CONFIG.colorStopsDark;
        }
    }

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
        // Apply blend mode based on detected theme
        if (isLightMode) heatmapCanvas.style.mixBlendMode = 'multiply';
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
                    if (isLightMode) {
                        // Multiply mode: white = invisible (identity color)
                        data[idx] = 255; data[idx + 1] = 255; data[idx + 2] = 255; data[idx + 3] = 255;
                    } else {
                        data[idx] = data[idx + 1] = data[idx + 2] = data[idx + 3] = 0;
                    }
                    continue;
                }
                const t = Math.min(1, score / CONFIG.maxDwellScore);
                const stops = activeColorStops;
                let lower = stops[0], upper = stops[stops.length - 1];
                for (let i = 0; i < stops.length - 1; i++) {
                    if (t >= stops[i].pos && t <= stops[i + 1].pos) {
                        lower = stops[i]; upper = stops[i + 1]; break;
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
        let hCount = 0, pCount = 0;


        // Readability sub-metrics collectors
        let fontSizes = [], lineHeightRatios = [], lineLengths = [], contrastRatios = [];

        // Helper: parse "rgb(r, g, b)" or "rgba(r,g,b,a)" to [r,g,b]
        function parseColor(str) {
            const m = str.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
            return m ? [+m[1], +m[2], +m[3]] : null;
        }

        // Helper: WCAG relative luminance
        function luminance(rgb) {
            const [r, g, b] = rgb.map(c => {
                c = c / 255;
                return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
            });
            return 0.2126 * r + 0.7152 * g + 0.0722 * b;
        }

        const READ_TAGS = ['P', 'LI', 'SPAN', 'A', 'LABEL', 'TD', 'TH', 'BLOCKQUOTE', 'ARTICLE'];
        const BLOCK_TAGS = ['P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LI', 'BLOCKQUOTE', 'ARTICLE'];

        trackedElements.forEach(item => {
            const tag = item.element.tagName.toUpperCase();
            if (['H1', 'H2', 'H3', 'H4', 'H5', 'H6'].includes(tag)) hCount++;
            if (['P', 'LI', 'ARTICLE'].includes(tag)) pCount++;

            // Readability: collect metrics from body-text elements
            if (READ_TAGS.includes(tag)) {
                try {
                    const style = window.getComputedStyle(item.element);
                    const fs = parseFloat(style.fontSize);
                    if (fs > 0) fontSizes.push(fs);

                    // Line height ratio
                    const lh = parseFloat(style.lineHeight);
                    if (lh > 0 && fs > 0) lineHeightRatios.push(lh / fs);

                    // Line length (estimated chars per line)
                    if (fs > 0 && item.rect.width > 0) {
                        lineLengths.push(item.rect.width / (fs * 0.5));
                    }

                    // Contrast ratio
                    const fg = parseColor(style.color);
                    const bg = parseColor(style.backgroundColor);
                    if (fg && bg) {
                        const lFg = luminance(fg), lBg = luminance(bg);
                        const ratio = (Math.max(lFg, lBg) + 0.05) / (Math.min(lFg, lBg) + 0.05);
                        if (ratio > 1) contrastRatios.push(ratio);
                    }
                } catch (e) { }
            }

        });

        // --- TEXT DENSITY (composite: overall + above-the-fold + consistency) ---
        let totalTextArea = 0;
        const sortedByArea = [...trackedElements].sort((a, b) => (b.rect.width * b.rect.height) - (a.rect.width * a.rect.height));
        const counted = [];
        sortedByArea.forEach(item => {
            const r = item.rect;
            const isChild = counted.some(p => r.left >= p.left && r.top >= p.top && (r.left + r.width) <= (p.left + p.width) && (r.top + r.height) <= (p.top + p.height));
            if (!isChild) {
                totalTextArea += r.width * r.height;
                counted.push(r);
            }
        });
        const density = Math.min((totalTextArea / (w * h)) * 100, 100);
        const eps = trackedElements.length / Math.max(h / vh, 1);

        // Above-the-fold density (first viewport only)
        let foldArea = 0;
        counted.forEach(r => {
            if (r.top < vh) {
                const visibleBottom = Math.min(r.top + r.height, vh);
                const visibleTop = Math.max(r.top, 0);
                if (visibleBottom > visibleTop) {
                    foldArea += r.width * (visibleBottom - visibleTop);
                }
            }
        });
        const foldDensity = Math.min((foldArea / (w * vh)) * 100, 100);

        // Density consistency (variance across screen slices)
        const totalScreens = Math.max(1, Math.ceil(h / vh));
        const sliceDensities = [];
        for (let s = 0; s < totalScreens; s++) {
            const sliceTop = s * vh;
            const sliceBottom = sliceTop + vh;
            let sliceArea = 0;
            counted.forEach(r => {
                const visTop = Math.max(r.top, sliceTop);
                const visBot = Math.min(r.top + r.height, sliceBottom);
                if (visBot > visTop) sliceArea += r.width * (visBot - visTop);
            });
            sliceDensities.push(Math.min((sliceArea / (w * vh)) * 100, 100));
        }
        const avgSliceDensity = sliceDensities.reduce((a, b) => a + b, 0) / sliceDensities.length;
        const variance = sliceDensities.reduce((sum, d) => sum + (d - avgSliceDensity) ** 2, 0) / sliceDensities.length;
        // Coefficient of variation: 0 = perfectly consistent, high = inconsistent
        const cv = avgSliceDensity > 0 ? Math.sqrt(variance) / avgSliceDensity : 0;
        // CV of 0 = 100 score, CV of 1+ = 0 score
        const consistencyScore = Math.round(Math.max(0, Math.min(100, (1 - cv) * 100)));

        // --- READABILITY (composite of 4 sub-scores, each 0-100) ---
        const avg = arr => arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : null;

        // 1. Font Size: 8px=0, 16px+=100
        const avgFS = avg(fontSizes) || 16;
        const fontSizeScore = Math.max(0, Math.min(100, ((avgFS - 8) / 8) * 100));

        // 2. Line Height: ideal 1.2–2.0, below 1.0=0, above 2.5=diminishing
        const avgLH = avg(lineHeightRatios) || 1.5;
        let lineHeightScore;
        if (avgLH >= 1.2 && avgLH <= 2.0) lineHeightScore = 100;
        else if (avgLH < 1.2) lineHeightScore = Math.max(0, ((avgLH - 1.0) / 0.2) * 100);
        else lineHeightScore = Math.max(0, 100 - ((avgLH - 2.0) / 0.5) * 50);

        // 3. Line Length: ideal 35–90 chars, <15=0, >140=0
        const avgLL = avg(lineLengths) || 60;
        let lineLengthScore;
        if (avgLL >= 35 && avgLL <= 90) lineLengthScore = 100;
        else if (avgLL < 35) lineLengthScore = Math.max(0, (avgLL / 35) * 100);
        else lineLengthScore = Math.max(0, 100 - ((avgLL - 90) / 50) * 100);

        // 4. Contrast: WCAG AA = 4.5:1, AAA = 7:1
        const avgCR = avg(contrastRatios);
        let contrastScore;
        if (avgCR === null) contrastScore = 80; // no data = assume decent
        else if (avgCR >= 7) contrastScore = 100;
        else if (avgCR >= 4.5) contrastScore = 70 + ((avgCR - 4.5) / 2.5) * 30;
        else contrastScore = Math.max(0, (avgCR / 4.5) * 70);

        const readability = Math.round((fontSizeScore + lineHeightScore + lineLengthScore + contrastScore) / 4);

        // --- WHITE SPACE (real pixel gaps between consecutive elements) ---
        const blockElements = trackedElements.filter(item => BLOCK_TAGS.includes(item.element.tagName.toUpperCase()));
        const sortedByTop = [...blockElements].sort((a, b) => a.rect.top - b.rect.top);
        let gapSum = 0, gapCount = 0;
        for (let i = 1; i < sortedByTop.length; i++) {
            const prevBottom = sortedByTop[i - 1].rect.top + sortedByTop[i - 1].rect.height;
            const currTop = sortedByTop[i].rect.top;
            const gap = currTop - prevBottom;
            if (gap >= 0) { gapSum += gap; gapCount++; }
        }
        const avgGap = gapCount > 0 ? gapSum / gapCount : 0;
        // 0px gap = 0%, 48px+ gap = 100%
        const whiteSpaceRatio = Math.round(Math.max(0, Math.min(100, (avgGap / 48) * 100)));

        // --- SCORING HELPER ---
        function rangeScore(value, idealMin, idealMax, worstLow, worstHigh, maxPts) {
            if (value >= idealMin && value <= idealMax) return maxPts;
            if (value < idealMin) {
                const range = idealMin - worstLow;
                return range > 0 ? Math.max(0, maxPts * (1 - (idealMin - value) / range)) : 0;
            }
            const range = worstHigh - idealMax;
            return range > 0 ? Math.max(0, maxPts * (1 - (value - idealMax) / range)) : 0;
        }

        // --- CATEGORY SCORES (each 0-25, total 0-100) ---
        // Density: composite of overall(40%) + above-fold(35%) + consistency(25%)
        const overallDensityScore = rangeScore(density, 10, 55, 0, 90, 100);
        const foldDensityScore = rangeScore(foldDensity, 10, 60, 0, 95, 100);
        const densityComposite = (overallDensityScore * 0.4) + (foldDensityScore * 0.35) + (consistencyScore * 0.25);
        const densityPts = (densityComposite / 100) * 25;

        const wsPts = rangeScore(whiteSpaceRatio, 25, 85, 0, 100, 25);
        const layoutPts = rangeScore(eps, 5, 25, 0, 60, 25);
        const readPts = Math.min(25, (readability / 100) * 25);

        let uxScore = Math.round(densityPts + wsPts + layoutPts + readPts);

        // --- FEEDBACK (3-tier: strengths ≥20, suggestions 12-19, issues <12) ---
        let issues = [], positives = [], suggestions = [];
        let sugCountBefore; // track if any sub-score triggered

        // Density feedback
        if (densityPts >= 20) {
            positives.push({ category: 'Density', message: `Content density is ideal (${Math.round(density)}%)` });
        } else if (densityPts >= 12) {
            sugCountBefore = suggestions.length;
            if (overallDensityScore < 70) suggestions.push({ category: 'Density', message: `Content density is ${Math.round(density)}% (ideal 15–45%)` });
            if (foldDensityScore < 70) suggestions.push({ category: 'Density', message: `First screen density is ${Math.round(foldDensity)}% (ideal 15–50%)` });
            if (consistencyScore < 70) suggestions.push({ category: 'Density', message: 'Content distribution could be more even' });
            if (suggestions.length === sugCountBefore) suggestions.push({ category: 'Density', message: `Density is okay at ${Math.round(density)}% but could improve` });
        } else {
            if (overallDensityScore < 40) issues.push({ category: 'Density', message: density > 45 ? `Too dense at ${Math.round(density)}% (recommend under 45%)` : `Very sparse at ${Math.round(density)}% (recommend 15%+)` });
            if (foldDensityScore < 40) issues.push({ category: 'Density', message: foldDensity > 50 ? `First screen is crowded (${Math.round(foldDensity)}%)` : `First screen lacks content (${Math.round(foldDensity)}%)` });
            if (consistencyScore < 40) issues.push({ category: 'Density', message: 'Uneven content distribution across page' });
        }

        // White Space feedback
        if (wsPts >= 20) {
            positives.push({ category: 'Spacing', message: `Good spacing (avg ${Math.round(avgGap)}px gap)` });
        } else if (wsPts >= 12) {
            suggestions.push({ category: 'Spacing', message: `Avg gap is ${Math.round(avgGap)}px (recommend 24–48px)` });
        } else {
            issues.push({ category: 'Spacing', message: `Elements too cramped (avg ${Math.round(avgGap)}px gap, recommend 24px+)` });
        }

        // Complexity feedback
        if (layoutPts >= 20) {
            positives.push({ category: 'Complexity', message: `Optimal complexity (${Math.round(eps)} items/screen)` });
        } else if (layoutPts >= 12) {
            suggestions.push({ category: 'Complexity', message: `${Math.round(eps)} items/screen (ideal 8–15)` });
        } else {
            issues.push({ category: 'Complexity', message: eps > 15 ? `Too complex (${Math.round(eps)} items/screen, recommend under 15)` : `Very few elements (${Math.round(eps)} items/screen)` });
        }

        // Readability feedback
        if (readPts >= 20) {
            positives.push({ category: 'Readability', message: `Good readability (${readability}% score)` });
        } else if (readPts >= 12) {
            sugCountBefore = suggestions.length;
            if (fontSizeScore < 70) suggestions.push({ category: 'Readability', message: `Avg font size is ${Math.round(avgFS)}px (recommend 16px)` });
            if (lineHeightScore < 70) suggestions.push({ category: 'Readability', message: `Line height ratio is ${avgLH.toFixed(1)}× (ideal 1.4–1.8×)` });
            if (lineLengthScore < 70) suggestions.push({ category: 'Readability', message: `Avg ${Math.round(avgLL)} chars/line (ideal 45–75)` });
            if (avgCR !== null && contrastScore < 70) suggestions.push({ category: 'Readability', message: `Contrast ratio is ${avgCR.toFixed(1)}:1 (recommend 4.5:1+)` });
            if (suggestions.length === sugCountBefore) suggestions.push({ category: 'Readability', message: `Readability is decent (${readability}%) but has room to improve` });
        } else {
            if (fontSizeScore < 50) issues.push({ category: 'Readability', message: `Font too small (avg ${Math.round(avgFS)}px, recommend 16px)` });
            if (lineHeightScore < 50) issues.push({ category: 'Readability', message: `Line spacing too tight (${avgLH.toFixed(1)}×, recommend 1.4×+)` });
            if (lineLengthScore < 50) issues.push({ category: 'Readability', message: avgLL > 75 ? `Lines too wide (${Math.round(avgLL)} chars, max 75)` : `Lines too narrow (${Math.round(avgLL)} chars, min 45)` });
            if (contrastScore < 50) issues.push({ category: 'Readability', message: avgCR !== null ? `Low contrast (${avgCR.toFixed(1)}:1, need 4.5:1)` : 'Low text-background contrast' });
        }

        // Structure feedback
        if (hCount >= 1 && pCount >= 3) positives.push({ category: 'Structure', message: `Well structured (${hCount} headings, ${pCount} paragraphs)` });
        else if (hCount >= 1) suggestions.push({ category: 'Structure', message: `Only ${pCount} paragraphs found, add more content` });
        else issues.push({ category: 'Structure', message: 'Missing heading hierarchy' });

        const label = uxScore >= 85 ? 'Excellent' : uxScore >= 70 ? 'Good' : uxScore >= 55 ? 'Average' : uxScore >= 40 ? 'Dense' : 'Fatiguing';

        return { score: uxScore, label, textDensity: Math.round(density), whiteSpaceRatio, elementsPerScreen: Math.round(eps * 10) / 10, readability, issues, suggestions, positives };
    }

    function getAnalytics() {
        const activeSeconds = Math.floor(analytics.activeTimeMs / 1000);
        const viewed = trackedElements.filter(item => item.dwellScore > 1.0).length;
        const hasData = viewed >= 2 && activeSeconds >= 10;

        // Only recompute UX evaluation when dirty (DOM/resize changed) or first time with data
        if (hasData && (uxEvalDirty || !cachedUXEvaluation)) {
            cachedUXEvaluation = calculateUXDensity(
                Math.max(document.body.scrollWidth, document.documentElement.scrollWidth),
                Math.max(document.body.scrollHeight, document.documentElement.scrollHeight),
                window.innerHeight
            );
            uxEvalDirty = false;
        }

        // Before hasData is true, still compute live so countdown works
        const ux = hasData && cachedUXEvaluation
            ? cachedUXEvaluation
            : calculateUXDensity(
                Math.max(document.body.scrollWidth, document.documentElement.scrollWidth),
                Math.max(document.body.scrollHeight, document.documentElement.scrollHeight),
                window.innerHeight
            );

        return {
            activeTime: activeSeconds < 60 ? activeSeconds + 's' : Math.floor(activeSeconds / 60) + 'm ' + (activeSeconds % 60) + 's',
            activeTimeSec: activeSeconds, isTracking, hasData, uxEvaluation: ux
        };
    }

    function registerInteraction() { if (isTracking) analytics.lastInteractionTime = Date.now(); }

    // ============================================
    // PINNED FLOATING PANEL
    // ============================================
    let pinnedPanel = null;
    let pinnedUpdateInterval = null;

    function createPinnedPanel() {
        if (pinnedPanel) return; // Already exists

        pinnedPanel = document.createElement('div');
        pinnedPanel.id = '__ux-heatgrid-pin-panel';
        Object.assign(pinnedPanel.style, {
            position: 'fixed',
            bottom: '20px',
            right: '20px',
            width: '240px',
            background: 'rgba(15, 23, 42, 0.92)',
            backdropFilter: 'blur(20px)',
            WebkitBackdropFilter: 'blur(20px)',
            border: '1px solid rgba(255, 255, 255, 0.1)',
            borderRadius: '16px',
            boxShadow: '0 20px 40px rgba(0,0,0,0.5), inset 0 1px 0 rgba(255,255,255,0.05)',
            color: '#f8fafc',
            fontFamily: "'Inter', -apple-system, sans-serif",
            fontSize: '11px',
            zIndex: '2147483647',
            cursor: 'grab',
            userSelect: 'none',
            transition: 'box-shadow 0.2s',
            overflow: 'hidden'
        });

        pinnedPanel.innerHTML = `
            <div id="__ux-pin-header" style="
                padding: 10px 14px;
                display: flex;
                justify-content: space-between;
                align-items: center;
                border-bottom: 1px solid rgba(255,255,255,0.06);
                background: linear-gradient(180deg, rgba(255,255,255,0.04), transparent);
                border-radius: 16px 16px 0 0;
            ">
                <span style="font-weight:700;font-size:12px;letter-spacing:-0.3px;">UX HeatGrid</span>
                <button id="__ux-pin-close" style="
                    background: rgba(255,255,255,0.05);
                    border: 1px solid rgba(255,255,255,0.1);
                    width: 22px; height: 22px;
                    border-radius: 50%;
                    color: #94a3b8;
                    font-size: 14px;
                    cursor: pointer;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    transition: all 0.2s;
                ">&times;</button>
            </div>
            <div style="padding: 12px 14px;">
                <!-- UX Score Section Card -->
                <div id="__ux-pin-score-card" style="
                    background: rgba(30, 41, 59, 0.5);
                    border: 1px solid rgba(255, 255, 255, 0.08);
                    border-radius: 12px;
                    padding: 14px;
                    margin-bottom: 12px;
                    display: flex;
                    flex-direction: column;
                    align-items: center;
                    justify-content: center;
                    gap: 6px;
                    height: 110px;
                    box-sizing: border-box;
                ">
                    <!-- Countdown (Analysing State) -->
                    <div id="__ux-pin-loader-container" style="display: none;">
                        <div id="__ux-pin-countdown" style="font-size: 36px; font-weight: 800; color: #3b82f6; letter-spacing: -1.5px;">10</div>
                    </div>

                    <!-- Score Result State -->
                    <div id="__ux-pin-score-result" style="display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 4px;">
                        <div id="__ux-pin-score-num" style="
                            font-size: 36px;
                            font-weight: 800;
                            letter-spacing: -1.5px;
                            color: #3b82f6;
                            line-height: 1;
                        ">--</div>
                        <div id="__ux-pin-grade" style="
                            font-size: 11px;
                            font-weight: 700;
                            text-transform: uppercase;
                            letter-spacing: 0.5px;
                            color: #94a3b8;
                        ">Analyzing...</div>
                    </div>

                    <div id="__ux-pin-score-label" style="font-size:9px; color:#64748b; font-weight:600; text-transform:uppercase; letter-spacing:0.3px;">Overall UX Score</div>
                </div>
                <div id="__ux-pin-metrics" style="
                    display: grid;
                    grid-template-columns: 1fr 1fr;
                    gap: 8px;
                ">
                    <!-- Readability -->
                    <div style="background:rgba(30, 41, 59, 0.5); border:1px solid rgba(255,255,255,0.08); border-radius:10px; padding:10px 4px; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:2px; min-height:56px;">
                        <div id="__ux-pin-readability-icon" style="color:#3b82f6; display:flex; align-items:center; justify-content:center;">
                            <svg viewBox="0 0 24 24" width="18" height="18" stroke="currentColor" stroke-width="2.5" fill="none" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 7 4 4 20 4 20 7"></polyline><line x1="9" y1="20" x2="15" y2="20"></line><line x1="12" y1="4" x2="12" y2="20"></line></svg>
                        </div>
                        <div id="__ux-pin-readability" style="font-size:16px; font-weight:800; color:#f8fafc; letter-spacing:-0.5px; display:none;">-</div>
                        <div style="font-size:8px; font-weight:700; color:#94a3b8; text-transform:uppercase; letter-spacing:0.3px;">Readability</div>
                    </div>
                    <!-- Complexity -->
                    <div style="background:rgba(30, 41, 59, 0.5); border:1px solid rgba(255,255,255,0.08); border-radius:10px; padding:10px 4px; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:2px; min-height:56px;">
                        <div id="__ux-pin-complexity-icon" style="color:#3b82f6; display:flex; align-items:center; justify-content:center;">
                            <svg viewBox="0 0 24 24" width="18" height="18" stroke="currentColor" stroke-width="2.5" fill="none" stroke-linecap="round" stroke-linejoin="round"><line x1="8" y1="6" x2="21" y2="6"></line><line x1="8" y1="12" x2="21" y2="12"></line><line x1="8" y1="18" x2="21" y2="18"></line><line x1="3" y1="6" x2="3.01" y2="6"></line><line x1="3" y1="12" x2="3.01" y2="12"></line><line x1="3" y1="18" x2="3.01" y2="18"></line></svg>
                        </div>
                        <div id="__ux-pin-complexity" style="font-size:16px; font-weight:800; color:#f8fafc; letter-spacing:-0.5px; display:none;">-</div>
                        <div style="font-size:8px; font-weight:700; color:#94a3b8; text-transform:uppercase; letter-spacing:0.3px;">Complexity</div>
                    </div>
                    <!-- White Space -->
                    <div style="background:rgba(30, 41, 59, 0.5); border:1px solid rgba(255,255,255,0.08); border-radius:10px; padding:10px 4px; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:2px; min-height:56px;">
                        <div id="__ux-pin-spacing-icon" style="color:#3b82f6; display:flex; align-items:center; justify-content:center;">
                            <svg viewBox="0 0 24 24" width="18" height="18" stroke="currentColor" stroke-width="2.5" fill="none" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"></rect></svg>
                        </div>
                        <div id="__ux-pin-spacing" style="font-size:16px; font-weight:800; color:#f8fafc; letter-spacing:-0.5px; display:none;">-</div>
                        <div style="font-size:8px; font-weight:700; color:#94a3b8; text-transform:uppercase; letter-spacing:0.3px;">White Space</div>
                    </div>
                    <!-- Content Density -->
                    <div style="background:rgba(30, 41, 59, 0.5); border:1px solid rgba(255,255,255,0.08); border-radius:10px; padding:10px 4px; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:2px; min-height:56px;">
                        <div id="__ux-pin-density-icon" style="color:#3b82f6; display:flex; align-items:center; justify-content:center;">
                            <svg viewBox="0 0 24 24" width="18" height="18" stroke="currentColor" stroke-width="2.5" fill="none" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><line x1="3" y1="9" x2="21" y2="9"></line><line x1="9" y1="21" x2="9" y2="9"></line></svg>
                        </div>
                        <div id="__ux-pin-density" style="font-size:16px; font-weight:800; color:#f8fafc; letter-spacing:-0.5px; display:none;">-</div>
                        <div style="font-size:8px; font-weight:700; color:#94a3b8; text-transform:uppercase; letter-spacing:0.3px;">Density</div>
                    </div>
                </div>
            </div>
            <div id="__ux-pin-controls" style="
                padding: 12px 14px;
                display: flex;
                gap: 8px;
                background: rgba(255,255,255,0.02);
                border-top: 1px solid rgba(255,255,255,0.06);
            ">
                <button id="__ux-pin-start" style="
                    flex: 1;
                    padding: 8px;
                    border-radius: 8px;
                    background: rgba(30, 41, 59, 0.8);
                    border: 1px solid rgba(255,255,255,0.1);
                    color: white;
                    font-size: 11px;
                    font-weight: 700;
                    cursor: pointer;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    gap: 6px;
                    transition: all 0.2s;
                ">Start Tracking</button>
                <button id="__ux-pin-visibility" style="
                    padding: 8px;
                    width: 36px;
                    border-radius: 8px;
                    background: rgba(255,255,255,0.05);
                    border: 1px solid rgba(255,255,255,0.1);
                    color: white;
                    cursor: pointer;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    transition: all 0.2s;
                ">
                    <svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2.5" fill="none" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>
                    </svg>
                </button>
            </div>
        `;

        document.body.appendChild(pinnedPanel);

        // Control buttons logic
        const startBtn = document.getElementById('__ux-pin-start');
        const visibilityBtn = document.getElementById('__ux-pin-visibility');

        startBtn.onclick = (e) => {
            e.stopPropagation();
            if (!isTracking) {
                // Start Tracking
                detectPageTheme();
                isTracking = true; if (!grid.length) initGrid(); analyzeElements(); updateElementVisibility(); setupListeners();
                updateIntervalId = setInterval(updateTracking, CONFIG.updateInterval);
                activeTimeTrackerId = setInterval(() => {
                    if (isTracking && Date.now() - analytics.lastInteractionTime < 5000) analytics.activeTimeMs += 1000;
                }, 1000);
            } else {
                // Pause Tracking
                isTracking = false; clearInterval(updateIntervalId); clearInterval(activeTimeTrackerId); updateIntervalId = activeTimeTrackerId = null;
            }
            updatePinnedPanel();
        };

        visibilityBtn.onclick = (e) => {
            e.stopPropagation();
            if (!isVisible) {
                // Show Heatmap
                isVisible = true; if (!grid.length) initGrid(); createCanvas(); const loop = () => { if (!isVisible) { rafRenderId = null; return; } render(); rafRenderId = requestAnimationFrame(loop); }; loop();
            } else {
                // Hide Heatmap
                isVisible = false; cancelAnimationFrame(rafRenderId); rafRenderId = null; if (heatmapCanvas) heatmapCanvas.remove(); heatmapCanvas = null;
            }
            updatePinnedPanel();
        };

        // Close button
        document.getElementById('__ux-pin-close').addEventListener('click', (e) => {
            e.stopPropagation();
            removePinnedPanel();
        });

        // Drag logic
        let isDragging = false, offsetX = 0, offsetY = 0;

        pinnedPanel.addEventListener('mousedown', (e) => {
            if (e.target.id === '__ux-pin-close') return;
            isDragging = true;
            offsetX = e.clientX - pinnedPanel.getBoundingClientRect().left;
            offsetY = e.clientY - pinnedPanel.getBoundingClientRect().top;
            pinnedPanel.style.cursor = 'grabbing';
            pinnedPanel.style.transition = 'none';
            e.preventDefault();
        });

        document.addEventListener('mousemove', (e) => {
            if (!isDragging || !pinnedPanel) return;
            const x = e.clientX - offsetX;
            const y = e.clientY - offsetY;
            pinnedPanel.style.left = x + 'px';
            pinnedPanel.style.top = y + 'px';
            pinnedPanel.style.right = 'auto';
            pinnedPanel.style.bottom = 'auto';
        });

        document.addEventListener('mouseup', () => {
            if (!isDragging || !pinnedPanel) return;
            isDragging = false;
            pinnedPanel.style.cursor = 'grab';
            pinnedPanel.style.transition = 'box-shadow 0.2s';
        });

        // Start live updates
        updatePinnedPanel();
        pinnedUpdateInterval = setInterval(updatePinnedPanel, 2000);
    }

    function updatePinnedPanel() {
        if (!pinnedPanel) return;
        const data = getAnalytics();
        const ux = data.uxEvaluation;
        if (!ux) return;

        const scoreEl = document.getElementById('__ux-pin-score-num');
        const gradeEl = document.getElementById('__ux-pin-grade');
        const densityEl = document.getElementById('__ux-pin-density');
        const spacingEl = document.getElementById('__ux-pin-spacing');
        const complexityEl = document.getElementById('__ux-pin-complexity');
        const readabilityEl = document.getElementById('__ux-pin-readability');

        if (!scoreEl) return;

        if (ux) {
            // Always update text content if we have a UX object
            densityEl.textContent = ux.textDensity + '%';
            spacingEl.textContent = ux.whiteSpaceRatio + '%';
            complexityEl.textContent = ux.elementsPerScreen;
            readabilityEl.textContent = ux.readability + '%';
        }

        if (scoreEl) {
            if (data.hasData) {
                // Show Result, Hide Loader
                document.getElementById('__ux-pin-loader-container').style.display = 'none';
                document.getElementById('__ux-pin-score-result').style.display = 'flex';

                scoreEl.textContent = ux.score;
                gradeEl.textContent = ux.label;

                // Color by score — match popup gradient style
                let gradStart, gradEnd, gradeColor, gradeBg, gradeBorder;
                if (ux.score >= 85) {
                    gradStart = '#10b981'; gradEnd = '#059669';
                    gradeColor = '#10b981'; gradeBg = 'rgba(16, 185, 129, 0.15)'; gradeBorder = 'rgba(16, 185, 129, 0.15)';
                } else if (ux.score >= 70) {
                    gradStart = '#3b82f6'; gradEnd = '#2563eb';
                    gradeColor = '#3b82f6'; gradeBg = 'rgba(59, 130, 246, 0.15)'; gradeBorder = 'rgba(59, 130, 246, 0.4)';
                } else if (ux.score >= 55) {
                    gradStart = '#f59e0b'; gradEnd = '#d97706';
                    gradeColor = '#f59e0b'; gradeBg = 'rgba(245, 158, 11, 0.15)'; gradeBorder = 'rgba(245, 158, 11, 0.15)';
                } else if (ux.score >= 40) {
                    gradStart = '#f59e0b'; gradEnd = '#d97706';
                    gradeColor = '#f59e0b'; gradeBg = 'rgba(245, 158, 11, 0.15)'; gradeBorder = 'rgba(245, 158, 11, 0.15)';
                } else {
                    gradStart = '#ef4444'; gradEnd = '#dc2626';
                    gradeColor = '#ef4444'; gradeBg = 'rgba(239, 68, 68, 0.15)'; gradeBorder = 'rgba(239, 68, 68, 0.15)';
                }

                // Score number gradient
                scoreEl.style.background = `linear-gradient(${gradStart}, ${gradEnd})`;
                scoreEl.style.webkitBackgroundClip = 'text';
                scoreEl.style.backgroundClip = 'text';
                scoreEl.style.webkitTextFillColor = 'transparent';
                scoreEl.style.color = gradStart; // fallback

                // Grade label pill
                gradeEl.style.color = gradeColor;
                gradeEl.style.background = gradeBg;
                gradeEl.style.border = `1px solid ${gradeBorder}`;
                gradeEl.style.padding = '3px 10px';
                gradeEl.style.borderRadius = '20px';
            } else if (data.activeTimeSec > 0 && data.activeTimeSec <= 10) {
                // Show Loader Ring, Hide Static Result
                document.getElementById('__ux-pin-loader-container').style.display = 'block';
                document.getElementById('__ux-pin-score-result').style.display = 'none';

                const countdown = Math.max(0, 10 - data.activeTimeSec);
                const countdownEl = document.getElementById('__ux-pin-countdown');
                if (countdownEl) countdownEl.textContent = countdown;
            } else {
                // Initial or Clear state
                document.getElementById('__ux-pin-loader-container').style.display = 'none';
                document.getElementById('__ux-pin-score-result').style.display = 'flex';
                scoreEl.textContent = '--';
                gradeEl.textContent = 'Analysing...';
                // Reset gradient styles
                scoreEl.style.background = 'none';
                scoreEl.style.webkitBackgroundClip = '';
                scoreEl.style.backgroundClip = '';
                scoreEl.style.webkitTextFillColor = '';
                scoreEl.style.color = '#3b82f6';
                // Reset grade pill styles
                gradeEl.style.color = '#94a3b8';
                gradeEl.style.background = 'none';
                gradeEl.style.border = 'none';
                gradeEl.style.padding = '0';
                gradeEl.style.borderRadius = '0';
            }
        }

        if (data.hasData || data.activeTimeSec > 0) {
            // Still show numbers during analysis if tracking is active
            document.getElementById('__ux-pin-density-icon').style.display = 'none';
            densityEl.style.display = 'block';
            document.getElementById('__ux-pin-spacing-icon').style.display = 'none';
            spacingEl.style.display = 'block';
            document.getElementById('__ux-pin-complexity-icon').style.display = 'none';
            complexityEl.style.display = 'block';
            document.getElementById('__ux-pin-readability-icon').style.display = 'none';
            readabilityEl.style.display = 'block';
        } else {
            // Hide values, show icons
            document.getElementById('__ux-pin-density-icon').style.display = 'flex';
            densityEl.style.display = 'none';
            document.getElementById('__ux-pin-spacing-icon').style.display = 'flex';
            spacingEl.style.display = 'none';
            document.getElementById('__ux-pin-complexity-icon').style.display = 'flex';
            complexityEl.style.display = 'none';
            document.getElementById('__ux-pin-readability-icon').style.display = 'flex';
            readabilityEl.style.display = 'none';
        }

        // Update Control Buttons
        const startBtn = document.getElementById('__ux-pin-start');
        const visibilityBtn = document.getElementById('__ux-pin-visibility');

        if (startBtn) {
            startBtn.innerHTML = isTracking ?
                '<svg viewBox="0 0 24 24" width="12" height="12" stroke="currentColor" stroke-width="3" fill="none" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg> Pause' :
                '<svg viewBox="0 0 24 24" width="12" height="12" stroke="currentColor" stroke-width="3" fill="currentColor" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg> Start';
            startBtn.style.background = isTracking ? 'rgba(245, 158, 11, 0.15)' : 'rgba(30, 41, 59, 0.8)';
            startBtn.style.color = isTracking ? '#f59e0b' : '#f8fafc';
            startBtn.style.borderColor = isTracking ? '#f59e0b' : 'rgba(255, 255, 255, 0.1)';
        }

        if (visibilityBtn) {
            visibilityBtn.style.background = isVisible ? 'rgba(245, 158, 11, 0.15)' : 'rgba(255,255,255,0.05)';
            visibilityBtn.style.color = isVisible ? '#f59e0b' : '#f8fafc';
            visibilityBtn.style.borderColor = isVisible ? '#f59e0b' : 'rgba(255,255,255,0.1)';
            visibilityBtn.innerHTML = isVisible ?
                '<svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2.5" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19m-6.72-1.07a3 3 0 11-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>' :
                '<svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2.5" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>';
        }
    }

    function removePinnedPanel() {
        if (pinnedPanel) {
            pinnedPanel.remove();
            pinnedPanel = null;
        }
        if (pinnedUpdateInterval) {
            clearInterval(pinnedUpdateInterval);
            pinnedUpdateInterval = null;
        }
    }

    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
        if (msg.action === 'startTracking') {
            if (!isTracking) {
                detectPageTheme();
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
            cachedUXEvaluation = null; uxEvalDirty = true;
            sendResponse({ success: true });
        } else if (msg.action === 'showHeatmap') {
            if (!isVisible) { detectPageTheme(); isVisible = true; if (!grid.length) initGrid(); createCanvas(); const loop = () => { if (!isVisible) { rafRenderId = null; return; } render(); rafRenderId = requestAnimationFrame(loop); }; loop(); }
            sendResponse({ success: true });
        } else if (msg.action === 'hideHeatmap') {
            if (isVisible) { isVisible = false; cancelAnimationFrame(rafRenderId); rafRenderId = null; if (heatmapCanvas) heatmapCanvas.remove(); heatmapCanvas = null; }
            sendResponse({ success: true });
        } else if (msg.action === 'clear') {
            grid = []; trackedElements = []; mouseHeatMap.clear(); if (isVisible) { isVisible = false; cancelAnimationFrame(rafRenderId); rafRenderId = null; if (heatmapCanvas) heatmapCanvas.remove(); heatmapCanvas = null; }
            analytics = { activeTimeMs: 0, lastInteractionTime: Date.now(), scrollVelocity: 0, scrollVelocities: [] };
            cachedUXEvaluation = null; uxEvalDirty = true;
            updatePinnedPanel();
            sendResponse({ success: true });
        } else if (msg.action === 'getStatus') {
            sendResponse({ isTracking, isVisible, isPaused: !isTracking, isPinned: !!pinnedPanel });
        } else if (msg.action === 'getAnalytics') {
            sendResponse(getAnalytics());
        } else if (msg.action === 'pinPanel') {
            createPinnedPanel();
            sendResponse({ success: true });
        } else if (msg.action === 'unpinPanel') {
            removePinnedPanel();
            sendResponse({ success: true });
        }
        return true;
    });

    window.addEventListener('resize', () => { if (isVisible || isTracking) { initGrid(); if (isVisible) updateCanvasDimensions(); analyzeElements(); uxEvalDirty = true; } });
    mutationObserver = new MutationObserver(() => {
        if (!isTracking) return;
        if (mutationTimeout) clearTimeout(mutationTimeout);
        mutationTimeout = setTimeout(() => { analyzeElements(); uxEvalDirty = true; mutationTimeout = null; }, 2000);
    });
    mutationObserver.observe(document.body, { childList: true, subtree: true });

})();
