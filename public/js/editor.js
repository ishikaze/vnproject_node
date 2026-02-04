function setTrayZoom(val) {
    document.documentElement.style.setProperty('--tray-scale', val);
    saveToLocal(); // Save the new zoom level
}


// --- DATA & STATE ---
let runUID = 0;

let scenes = {
    'scene_start': { id: 'scene_start', name: 'Start', blocks: [] }
};
let activeSceneId = 'scene_start';

Object.defineProperty(window, 'timelineData', {
    get: function () { return scenes[activeSceneId].blocks; },
    set: function (val) { scenes[activeSceneId].blocks = val; }
});

let paletteItems = [];
let selectedBlockId = null;

let dragSrc = null;
let isRunning = false;
let zoom = 1;
let isGridView = false;
let clipboardBlock = null;

let selectedKeyframeIndex = null;

// Constants
let CELL_W = 120;
const CELL_H = 50;

let activeMediaSources = { audio: null, video: null };

let customCSS = `/* Customize Dialogue Box */
#dialogue-box {
background: rgba(20, 20, 20, 0.95);
border: 1px solid #444;
}
.game-choice-btn {
background: #2c3e50;
color: white;
border-radius: 5px;
border: 1px solid #444;
}
.game-choice-btn:hover { background: #007acc; }`;

// --- UNDO / REDO ---
let undoStack = [];
let redoStack = [];
const MAX_HISTORY = 50;

function saveToLocal() {
    const data = {
        scenes: scenes,
        activeSceneId: activeSceneId,
        palette: paletteItems,
        css: customCSS,
        ui: {
            leftW: document.documentElement.style.getPropertyValue('--w-left'),
            rightW: document.documentElement.style.getPropertyValue('--w-right'),
            botH: document.documentElement.style.getPropertyValue('--h-bot'),
            grid: isGridView,
            trayZoom: document.getElementById('tray-zoom-slider').value
        }
    };
    localStorage.setItem('vn_v16_data', JSON.stringify(data));
}

function saveState() {
    const state = {
        scenes: JSON.parse(JSON.stringify(scenes)),
        activeSceneId: activeSceneId,
        palette: JSON.parse(JSON.stringify(paletteItems)), // <--- Save Palette State
        css: customCSS
    };
    undoStack.push(state);
    if (undoStack.length > MAX_HISTORY) undoStack.shift();
    redoStack = [];
    updateUndoUI();
    saveToLocal();
}

function restoreState(state) {
    scenes = JSON.parse(JSON.stringify(state.scenes));
    activeSceneId = state.activeSceneId || Object.keys(scenes)[0];

    // Restore Palette
    if (state.palette) {
        paletteItems = JSON.parse(JSON.stringify(state.palette));
        renderPalette();
    }

    customCSS = state.css;
    applyCustomCSS(customCSS);
    selectedBlockId = null;

    renderSceneList();
    renderTimeline();
    renderInspector();
    saveToLocal();
}

function doUndo() {
    if (undoStack.length === 0) return;
    redoStack.push({ timeline: JSON.parse(JSON.stringify(timelineData)), css: customCSS });
    restoreState(undoStack.pop());
    updateUndoUI();
}

function doRedo() {
    if (redoStack.length === 0) return;
    undoStack.push({ timeline: JSON.parse(JSON.stringify(timelineData)), css: customCSS });
    restoreState(redoStack.pop());
    updateUndoUI();
}

function updateUndoUI() {
    document.getElementById('btn-undo').disabled = undoStack.length === 0;
    document.getElementById('btn-redo').disabled = redoStack.length === 0;
}

// --- RESIZABLE PANELS ---
function startResize(e, dir) {
    e.preventDefault();
    const startX = e.clientX, startY = e.clientY;
    const root = document.documentElement;
    const sLeft = parseInt(getComputedStyle(root).getPropertyValue('--w-left'));
    const sRight = parseInt(getComputedStyle(root).getPropertyValue('--w-right'));
    const sBot = parseInt(getComputedStyle(root).getPropertyValue('--h-bot'));

    const onMove = (mv) => {
        if (dir === 'left') {
            let nw = sLeft + (mv.clientX - startX);
            if (nw < 150) nw = 150; if (nw > 500) nw = 500;
            root.style.setProperty('--w-left', nw + 'px');
        } else if (dir === 'right') {
            let nw = sRight - (mv.clientX - startX);
            if (nw < 200) nw = 200; if (nw > 600) nw = 600;
            root.style.setProperty('--w-right', nw + 'px');
        } else if (dir === 'bottom') {
            let nh = sBot - (mv.clientY - startY);
            if (nh < 100) nh = 100; if (nh > 800) nh = 800;
            root.style.setProperty('--h-bot', nh + 'px');
        }
        resizeStage();
    };
    const onUp = () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); saveToLocal(); };
    window.addEventListener('mousemove', onMove); window.addEventListener('mouseup', onUp);
}

// --- ENGINE HELPERS ---
function runWait(durationSec) {
    return new Promise(resolve => {
        let elapsed = 0;
        const check = setInterval(() => {
            if (!isRunning) { clearInterval(check); resolve(); return; }
            elapsed += 0.1;
            if (elapsed >= durationSec) { clearInterval(check); resolve(); }
        }, 100);
    });
}

function applyVisualAnimation(block, animData, baseState = null) {
    const p = block.params;
    let el, layer;

    if (block.type === 'bg') {
        layer = document.getElementById('bg-layer');
        el = layer;
        const currentBg = el.style.backgroundImage;
        if (!currentBg || currentBg === 'none' || !currentBg.includes(p.url)) {
            el.style.backgroundImage = `url('${p.url}')`;
        }
    } else {
        layer = document.getElementById('sprite-layer');
        el = document.getElementById('s-' + p.id);
        if (!el) {
            el = document.createElement('img');
            el.id = 's-' + p.id;
            el.className = 'sprite';
            el.onclick = (e) => { e.stopPropagation(); selectBlock(block.id); }; // Ensure click handling
            layer.appendChild(el);
        }
        el.src = p.url;
    }

    const combinedParams = { ...p, keyframes: animData.keyframes || [] };

    // Cancel old animations
    const oldAnims = el.getAnimations();
    if (oldAnims.length > 0) {
        oldAnims.forEach(anim => {
            try { anim.commitStyles(); } catch (e) { }
            anim.cancel();
        });
    }

    // Pass baseState here
    const keyframes = generateWAAPIKeyframes(combinedParams, el, baseState);

    if (animData.duration === 0 || keyframes.length === 0) {
        if (keyframes.length > 0) Object.assign(el.style, keyframes[0]);
        return;
    }

    const opts = {
        duration: animData.duration * 1000,
        iterations: animData.loop ? Infinity : 1,
        fill: 'forwards',
        easing: animData.easing || 'linear'
    };

    el.animate(keyframes, opts);
}

// Helper to interpolate missing values so CSS transforms don't break
function generateWAAPIKeyframes(params, element, baseStateOverride = null) {
    // 1. Get Base State (Use Override if provided, else fallback to params)
    const base = baseStateOverride || {
        x: params.x !== undefined ? params.x : 50,
        y: params.y !== undefined ? params.y : (params.type === 'bg' ? 50 : 100),
        scale: params.scale ?? (params.zoom ?? 1),
        rotate: params.rotate || 0,
        opacity: params.opacity !== undefined ? params.opacity : 1
    };

    // 2. Normalize Keyframes
    let frames = (params.keyframes || []).map(k => {
        // Backwards compatibility check
        if (k.p) {
            const obj = { t: k.t, ...base };
            obj[k.p] = k.v;
            return obj;
        }
        return { ...base, ...k };
    });

    // Ensure t=0 exists matches the Base State
    if (!frames.find(f => f.t === 0)) {
        frames.push({ t: 0, ...base });
    }

    frames.sort((a, b) => a.t - b.t);

    // 3. Convert to CSS Keyframes
    return frames.map(f => {
        const css = styleFromState(f, element.id === 'bg-layer');
        css.offset = f.t / 100;
        return css;
    });
}

function lerp(start, end, t) { return start * (1 - t) + end * t; }

// --- KEYBINDINGS ---
document.addEventListener('keydown', (e) => {
    const tag = e.target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    if (e.code === 'Space') { e.preventDefault(); toggleRun(); return; }
    if (e.ctrlKey || e.metaKey) {
        if (e.key === 'z') { e.preventDefault(); if (e.shiftKey) doRedo(); else doUndo(); }
        else if (e.key === 'y') { e.preventDefault(); doRedo(); }
        else if (e.key === 'c') {
            if (selectedBlockId) {
                e.preventDefault();
                const b = timelineData.find(x => x.id === selectedBlockId);
                if (b) { clipboardBlock = JSON.parse(JSON.stringify(b)); clipboardBlock.id = Date.now(); }
            }
        }
        else if (e.key === 'v') {
            if (clipboardBlock) {
                e.preventDefault(); saveState();
                const newItem = JSON.parse(JSON.stringify(clipboardBlock));
                newItem.id = Date.now();
                newItem.start += 1;
                timelineData.push(newItem);
                selectBlock(newItem.id);
            }
        }
    }
    if (e.key === 'Delete' || e.key === 'Backspace') {
        if (selectedBlockId) deleteSelected();
    }
});

// --- DEFAULTS ---
const defaults = {
    dialogue: { _id: '', name: '', text: '', speed: 30 },
    bg: { _id: '', url: '', x: 50, y: 50, zoom: 1, steps: {} },
    sprite: { _id: '', id: '', url: 'https://dummyimage.com/300x500/0984e3/fff&text=Char', x: 50, y: 100, scale: 1, rotate: 0, opacity: 1, steps: {} },
    wait: { _id: '', duration: 1 },
    // Choice now targets scenes, not labels
    choice: { _id: '', options: [{ text: 'Option 1', target: '' }] },
    audio: { _id: '', url: '', vol: 0.5, loop: true },
    video: { _id: '', url: '', vol: 0, loop: true },
    overlay: { _id: '', target: 'scene', targetId: '', filter: 'brightness', steps: {} },
    start: { _id: '' },
    hide: { _id: '' },
    // NEW: Transition Block
    transition: { _id: '', target: '' }
};

// --- GIZMO SYSTEM ---
let gizmoState = null;

window.startGizmoDrag = function (e, mode) {
    e.stopPropagation(); e.preventDefault();

    // FIX 1: Save history BEFORE modifying anything (for Undo)
    saveState();

    const b = timelineData.find(x => x.id === selectedBlockId);
    if (!b) return;

    let targetObj = b.params;
    let isKeyframe = false;

    if (['bg', 'sprite'].includes(b.type)) {
        if (window.selectedKeyframeIndex !== null) {
            const stepIdx = window.inspectorStepOffset || 0;
            if (b.params.steps && b.params.steps[stepIdx] && b.params.steps[stepIdx].keyframes[window.selectedKeyframeIndex]) {
                targetObj = b.params.steps[stepIdx].keyframes[window.selectedKeyframeIndex];
                isKeyframe = true;
            }
        }
    }

    // FIX 2: Force parseFloat to avoid string concatenation errors
    const startVals = {
        x: parseFloat(targetObj.x !== undefined ? targetObj.x : 50),
        y: parseFloat(targetObj.y !== undefined ? targetObj.y : (b.type === 'bg' ? 50 : 100)),
        scale: parseFloat(targetObj.scale !== undefined ? targetObj.scale : 1),
        rotate: parseFloat(targetObj.rotate || 0)
    };

    gizmoState = {
        mode: mode,
        startX: e.clientX,
        startY: e.clientY,
        initial: startVals,
        target: targetObj,
        isKeyframe: isKeyframe,
        blockId: b.id,
        rect: document.getElementById('gizmo-box').getBoundingClientRect()
    };

    window.addEventListener('mousemove', handleGizmoMove);
    window.addEventListener('mouseup', endGizmoDrag);
};

function handleGizmoMove(e) {
    if (!gizmoState) return;
    const s = gizmoState;

    const dx = e.clientX - s.startX;
    const dy = e.clientY - s.startY;

    const stage = document.getElementById('game-stage');
    const matrix = new DOMMatrix(getComputedStyle(stage).transform);
    const stageScale = matrix.a || 1;

    const stageW = (960 * stageScale) || 1;
    const stageH = (540 * stageScale) || 1;

    let dirty = false;

    if (s.mode === 'move') {
        const dXPer = (dx / stageW) * 100;
        const dYPer = (dy / stageH) * 100;

        const initX = isNaN(s.initial.x) ? 50 : s.initial.x;
        const initY = isNaN(s.initial.y) ? 50 : s.initial.y;

        s.target.x = parseFloat((initX + dXPer).toFixed(1));
        s.target.y = parseFloat((initY + dYPer).toFixed(1));
        dirty = true;
    }
    else if (s.mode === 'scale') {
        const scaleDelta = (dx - dy) / 200;
        const initScale = isNaN(s.initial.scale) ? 1 : s.initial.scale;

        let newScale = initScale + scaleDelta;
        if (newScale < 0.1) newScale = 0.1;
        s.target.scale = parseFloat(newScale.toFixed(2));
        dirty = true;
    }
    else if (s.mode === 'rotate') {
        const cx = s.rect.left + s.rect.width / 2;
        const cy = s.rect.top + s.rect.height / 2;
        const radians = Math.atan2(e.clientY - cy, e.clientX - cx);
        const deg = radians * (180 / Math.PI);
        s.target.rotate = Math.round(deg + 90);
        dirty = true;
    }

    if (dirty) {
        // FIX 3: Real-time update logic
        if (s.isKeyframe) {
            // If editing a keyframe, apply THAT keyframe's style directly
            const b = timelineData.find(x => x.id === s.blockId);
            const elId = b.type === 'bg' ? 'bg-layer' : 's-' + b.params.id;
            const el = document.getElementById(elId);

            if (el) {
                const style = styleFromState(s.target, b.type === 'bg');
                Object.assign(el.style, style);
                updateGizmo(b);
            }
        } else {
            previewInstant();
        }
        renderInspector();
    }
}

function endGizmoDrag() {
    window.removeEventListener('mousemove', handleGizmoMove);
    window.removeEventListener('mouseup', endGizmoDrag);
    gizmoState = null;

    // FIX 1b: Save to local storage only (Undo point was made at start)
    saveToLocal();
}

// --- VISUAL KEYFRAME LOGIC ---
window.clickTrack = function (e, trackEl) {
    if (e.target.classList.contains('kf-dot')) return;

    const rect = trackEl.getBoundingClientRect();
    const percent = Math.max(0, Math.min(100, Math.round(((e.clientX - rect.left) / rect.width) * 100)));

    saveState();
    const b = ensureStepData();
    const stepIdx = window.inspectorStepOffset;

    // RESOLVE STATE
    const baseState = getStepBaseState(b, stepIdx);

    const stepData = b.params.steps[stepIdx];

    // Pass baseState instead of b.params
    const snapshot = getInterpolatedState(baseState, stepData.keyframes, percent);

    // Add Snapshot
    stepData.keyframes.push(snapshot);

    window.selectedKeyframeIndex = stepData.keyframes.length - 1;
    renderInspector();
    renderTimeline();
};

window.updateKeyframeVal = function (idx, key, val) {
    saveState();
    const b = ensureStepData();
    let numVal = parseFloat(val);
    if (isNaN(numVal)) numVal = 0;

    b.params.steps[window.inspectorStepOffset].keyframes[idx][key] = numVal;

    if (key === 't') renderInspector();

    previewInstant();
};

window.selectKeyframeIndex = function (idx, e) {
    e.stopPropagation();
    if (window.selectedKeyframeIndex === idx) window.selectedKeyframeIndex = null;
    else window.selectedKeyframeIndex = idx;

    renderInspector();
    previewInstant(); // FIX 4: Snap preview to selected dot
};

window.previewScrub = function (e, trackEl) {
    const rect = trackEl.getBoundingClientRect();
    const percent = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));

    const line = document.getElementById('kf-scrubber-line');
    if (line) {
        line.style.display = 'block';
        line.style.left = (percent * 100) + '%';
    }

    const b = timelineData.find(x => x.id === selectedBlockId);
    if (!b) return;

    const stepIdx = window.inspectorStepOffset || 0;
    if (!b.params.steps) b.params.steps = {};
    if (!b.params.steps[stepIdx]) b.params.steps[stepIdx] = { duration: 0, keyframes: [] };
    const stepData = b.params.steps[stepIdx];

    const elId = b.type === 'bg' ? 'bg-layer' : ('s-' + b.params.id);
    const el = document.getElementById(elId);
    if (!el) return;

    const keyframes = generateWAAPIKeyframes({ ...b.params, keyframes: stepData.keyframes }, el);
    if (keyframes.length === 0) return;

    el.getAnimations().forEach(a => a.cancel());

    const easing = stepData.easing || 'linear';
    const anim = el.animate(keyframes, { duration: 1000, fill: 'forwards', easing: easing });
    anim.pause();
    anim.currentTime = 1000 * percent;
};

window.endScrub = function () {
    const line = document.getElementById('kf-scrubber-line');
    if (line) line.style.display = 'none';
    previewInstant(); // FIX 4: Reset state on mouse out
};

// --- INIT ---
window.onload = () => {
    // ---------------------------------------------------------
    // 1. LOAD CONTENT FROM SERVER (Database)
    // ---------------------------------------------------------
    
    // Check if SERVER_DATA exists (injected via EJS)
    if (typeof SERVER_DATA !== 'undefined' && SERVER_DATA) {
        console.log("Loading project from Server...");
        if (SERVER_DATA.scenes) {
            scenes = SERVER_DATA.scenes;
            activeSceneId = SERVER_DATA.activeSceneId || Object.keys(scenes)[0];
        }
        if (SERVER_DATA.css) customCSS = SERVER_DATA.css;
    } else {
        // Fallback: Create new empty project structure if DB is empty
        console.log("No Server Data found. Initializing new project.");
        scenes = { 'scene_start': { id: 'scene_start', name: 'Start', blocks: [] } };
        activeSceneId = 'scene_start';
        timelineData.push({ id: Date.now(), type: 'start', params: { _id: 'Init' }, start: 0, track: 0, duration: 1 });
    }

    // ---------------------------------------------------------
    // 2. LOAD UI SETTINGS FROM LOCAL STORAGE (Preferences)
    // ---------------------------------------------------------
    const savedLocal = localStorage.getItem('vn_v16_data');
    if (savedLocal) {
        try {
            const parsed = JSON.parse(savedLocal);
            // We ONLY restore UI settings, not scenes/palette
            if (parsed.ui) {
                const root = document.documentElement;
                if (parsed.ui.leftW) root.style.setProperty('--w-left', parsed.ui.leftW);
                if (parsed.ui.rightW) root.style.setProperty('--w-right', parsed.ui.rightW);
                if (parsed.ui.botH) root.style.setProperty('--h-bot', parsed.ui.botH);
                isGridView = !!parsed.ui.grid;
                
                if (parsed.ui.trayZoom) {
                    root.style.setProperty('--tray-scale', parsed.ui.trayZoom);
                    setTimeout(() => {
                        const slider = document.getElementById('tray-zoom-slider');
                        if (slider) slider.value = parsed.ui.trayZoom;
                    }, 0);
                }
            }
        } catch (e) { console.warn("Error loading UI preferences", e); }
    }

    // ---------------------------------------------------------
    // 3. INITIALIZE ASSETS & RENDER
    // ---------------------------------------------------------
    
    // Ensure SERVER_ASSETS is defined (prevents crash if empty)
    window.SERVER_ASSETS = (typeof SERVER_ASSETS !== 'undefined') ? SERVER_ASSETS : [];

    // Initialize logic (resetPalette will now read from SERVER_ASSETS)
    resetPalette(); 
    updateTrayView();
    renderSceneList();
    renderTimeline();
    resizeStage();
    applyCustomCSS(customCSS);
    updateUndoUI();
    
    window.onresize = resizeStage;
};

function resizeStage() {
    const el = document.getElementById('game-stage');
    const cont = document.getElementById('center-panel');
    const w = cont.clientWidth > 40 ? cont.clientWidth - 40 : 100;
    const h = cont.clientHeight > 40 ? cont.clientHeight - 40 : 100;
    const scale = Math.min(w / 960, h / 540);
    el.style.transform = `scale(${scale})`;
}

// --- PALETTE & UI ---
function toggleTrayView() { isGridView = !isGridView; updateTrayView(); saveToLocal(); }
function updateTrayView() {
    const list = document.getElementById('tray-list');
    const icon = document.getElementById('tray-toggle-icon');
    if (isGridView) { list.classList.add('grid-view'); icon.className = 'fa-solid fa-list'; }
    else { list.classList.remove('grid-view'); icon.className = 'fa-solid fa-table-cells'; }
}

function initPalette() { if (paletteItems.length === 0) resetPalette(); else renderPalette(); }
function resetPalette() {
    paletteItems = [];

    // 1. ADD LOGIC BLOCKS (Fixed)
    paletteItems.push(
        { type:'dialogue', name:'Dialogue', params:defaults.dialogue, isDefault: true, icon: 'fa-comment' },
        { type:'wait', name:'Wait', params:defaults.wait, isDefault: true, icon: 'fa-clock' },
        { type:'choice', name:'Choice', params:defaults.choice, isDefault: true, icon: 'fa-list-ul' },
        { type:'transition', name:'Change Scene', params:defaults.transition, isDefault: true, icon: 'fa-share' },
        { type:'hide', name:'Hide UI', params:defaults.hide, isDefault: true, icon: 'fa-eye-slash' },
        { type:'overlay', name:'Filter', params:defaults.overlay, isDefault: true, icon: 'fa-wand-magic' }
    );

    // 2. GENERATE ASSET BLOCKS FROM DB ASSETS
    if (typeof SERVER_ASSETS !== 'undefined') {
        SERVER_ASSETS.forEach(asset => {
            let block = null;
            
            if (asset.type === 'bg') {
                // Create a BG block pre-filled with this asset
                let params = JSON.parse(JSON.stringify(defaults.bg));
                params.url = asset.url; // Use Discord URL
                block = { type: 'bg', name: asset.name, params: params, isDefault: false, icon: 'fa-image' };
            } 
            else if (asset.type === 'sprite') {
                let params = JSON.parse(JSON.stringify(defaults.sprite));
                params.url = asset.url;
                params.id = asset.name.replace(/\s+/g, '_').toLowerCase(); // ID for sprite
                block = { type: 'sprite', name: asset.name, params: params, isDefault: false, icon: 'fa-user' };
            }
            else if (asset.type === 'audio') {
                let params = JSON.parse(JSON.stringify(defaults.audio));
                params.url = asset.url;
                block = { type: 'audio', name: asset.name, params: params, isDefault: false, icon: 'fa-music' };
            }
            else if (asset.type === 'video') {
                let params = JSON.parse(JSON.stringify(defaults.video));
                params.url = asset.url;
                block = { type: 'video', name: asset.name, params: params, isDefault: false, icon: 'fa-video' };
            }

            if (block) paletteItems.push(block);
        });
    }

    renderPalette();
}

// UPDATE SAVE FUNCTION TO USE NEW ENDPOINT
async function saveToServer() {
    const data = { 
        scenes: scenes, 
        activeSceneId: activeSceneId, 
        // We don't save palette anymore as it is generated dynamically from assets
        css: customCSS,
        ui: { grid: isGridView }
    };

    try {
        await fetch(`/api/save/${SERVER_EPISODE_ID}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data)
        });
        alert("Saved!");
    } catch (err) {
        console.error(err);
        alert("Save failed");
    }
}

// UPDATE ONLOAD TO USE INJECTED DATA
window.onload = () => {
    // Load data injected by EJS
    if(SERVER_DATA) {
        if (SERVER_DATA.scenes) {
            scenes = SERVER_DATA.scenes;
            activeSceneId = SERVER_DATA.activeSceneId;
        }
        customCSS = SERVER_DATA.css || '';
    }

    // Initialize Logic
    resetPalette(); // This now reads SERVER_ASSETS
    updateTrayView();
    renderSceneList();
    renderTimeline();
    resizeStage();
    applyCustomCSS(customCSS); 
    window.onresize = resizeStage;
};

function renderPalette() {
    const list = document.getElementById('tray-list'); list.innerHTML = '';
    paletteItems.forEach((item, idx) => {
        const el = document.createElement('div');

        let bgStyle = '';
        let extraClass = '';
        let hasPreview = false;

        if (item.params.url) {
            if (item.type === 'bg' || item.type === 'sprite') {
                bgStyle = `background-image: url('${item.params.url}');`;
                extraClass = ' with-img-bg';
                hasPreview = true;
            } else if (item.type === 'video') {
                extraClass = ' with-media-bg';
                hasPreview = true;
            }
        }

        el.className = `tray-item type-${item.type}${extraClass}`;
        el.style = bgStyle;
        el.draggable = true; el.title = item.name;
        const iconClass = item.icon || 'fa-cube';
        const delBtn = !item.isDefault ? `<div class="tray-del" onclick="deletePaletteItem(${idx}, event)"><i class="fa-solid fa-xmark"></i></div>` : '';
        const iconHTML = hasPreview ? '' : `<i class="fa-solid ${iconClass}"></i>`;

        el.innerHTML = `${iconHTML} <span class="name">${item.name}</span>${delBtn}`;

        if (item.type === 'video' && item.params.url) {
            const vid = document.createElement('video');
            vid.src = item.params.url;
            vid.className = 'block-video-preview';
            vid.muted = true;
            vid.preload = 'metadata';
            vid.style.borderRadius = '4px';
            vid.onloadeddata = () => { vid.currentTime = 0.1; };
            el.insertBefore(vid, el.firstChild);
        }

        el.dataset.idx = idx;
        list.appendChild(el);
    });
}

function deletePaletteItem(idx, e) {
    e.stopPropagation();
    paletteItems.splice(idx, 1);
    renderPalette();
    saveToLocal(); // <--- ADD THIS
}
function handlePaletteDragStart(e) {
    const el = e.target.closest('.tray-item');
    if (!el) return;
    const item = paletteItems[el.dataset.idx];
    dragSrc = { source: 'palette', itemData: JSON.parse(JSON.stringify(item)) };
    e.dataTransfer.effectAllowed = 'copy';
    e.dataTransfer.setData('text/plain', JSON.stringify(item));
}

// --- TIMELINE RENDERING ---
function renderTimeline() {
    const grid = document.getElementById('timeline-grid');
    grid.innerHTML = '<div id="tl-playhead"></div>';
    const actualCellW = CELL_W * zoom;

    let maxStep = 10;
    let maxTrack = 5;
    timelineData.forEach(b => {
        const end = b.start + b.duration;
        if (end > maxStep) maxStep = end;
        if (b.track > maxTrack) maxTrack = b.track;
    });
    maxStep += 5; maxTrack += 3;

    grid.style.width = (maxStep * actualCellW) + 'px';
    grid.style.height = (maxTrack * CELL_H) + 'px';

    const cx = actualCellW / 2;
    const cy = CELL_H / 2;
    const size = 10;
    const svg = `<svg width="${actualCellW}" height="${CELL_H}" xmlns="http://www.w3.org/2000/svg"><path d="M ${cx - size / 2} ${cy} h ${size} M ${cx} ${cy - size / 2} v ${size}" stroke="#333" stroke-width="1" fill="none" /></svg>`;
    const url = "data:image/svg+xml;base64," + btoa(svg);
    grid.style.backgroundImage = `url('${url}')`;
    grid.style.backgroundPosition = `-${cx}px -${cy}px`;
    grid.style.backgroundSize = `${actualCellW}px ${CELL_H}px`;

    timelineData.forEach(block => {
        const el = document.createElement('div');

        let highlightHTML = '';
        if (block.id === selectedBlockId && ['bg', 'sprite'].includes(block.type)) {
            const stepIdx = window.inspectorStepOffset || 0;
            if (stepIdx < block.duration) {
                const hLeft = stepIdx * actualCellW;
                highlightHTML = `<div class="tl-step-highlight" style="left:${hLeft}px; width:${actualCellW}px;"></div>`;
            }
        }

        let bgStyle = '';
        let extraClass = '';

        if (block.params.url) {
            if (block.type === 'bg' || block.type === 'sprite') {
                bgStyle = `background-image: url('${block.params.url}');`;
                extraClass = ' with-img-bg';
            } else if (block.type === 'video') {
                extraClass = ' with-media-bg';
            }
        }

        el.className = `tl-block b-${block.type} ${block.id === selectedBlockId ? 'selected' : ''}${extraClass}`;

        el.style.cssText = `
                left: ${block.start * actualCellW}px;
                top: ${block.track * CELL_H}px;
                width: ${block.duration * actualCellW}px;
                height: ${CELL_H - 4}px;
                margin-top: 2px;
                ${bgStyle} 
            `;

        let displayType = block.name || block.type;
        if (block.type === 'sprite') displayType = 'Character';
        const idTag = block.params._id ? `<div style="font-size:0.8em; opacity:0.7">#${block.params._id}</div>` : '';

        let indicatorsHTML = '';
        if (['bg', 'sprite'].includes(block.type) && block.params.steps) {
            for (let i = 0; i < block.duration; i++) {
                const s = block.params.steps[i];
                if (s && s.keyframes && s.keyframes.length > 0) {
                    const leftPos = (i * actualCellW) + (actualCellW - 18);
                    indicatorsHTML += `<i class="fa-solid fa-bezier-curve" 
                            style="position:absolute; top:4px; left:${leftPos}px; font-size:0.75em; color:#00a8ff; z-index:5; pointer-events:none; filter: drop-shadow(0 0 2px black);" 
                            title="Anim at Step ${i}"></i>`;
                }
            }
        }

        el.innerHTML = `${highlightHTML}${indicatorsHTML}<div class="block-id-tag">${displayType}</div>${idTag}<div class="block-summary" style="font-size:0.8em;opacity:0.8;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${getSummary(block)}</div>`;

        if (block.type === 'video' && block.params.url) {
            const vid = document.createElement('video');
            vid.src = block.params.url;
            vid.className = 'block-video-preview';
            vid.muted = true;
            vid.preload = 'metadata';
            vid.onloadeddata = () => { vid.currentTime = 0.1; };
            el.insertBefore(vid, el.firstChild);
        }

        const resizableTypes = ['bg', 'sprite', 'overlay', 'video', 'audio'];
        if (resizableTypes.includes(block.type)) {
            const handle = document.createElement('div');
            handle.className = 'block-handle';
            handle.onmousedown = (e) => startBlockResize(e, block);
            el.appendChild(handle);
        }

        el.onclick = (e) => { e.stopPropagation(); selectBlock(block.id); };
        el.draggable = true;
        el.ondragstart = (e) => {
            e.stopPropagation();
            dragSrc = { source: 'timeline', id: block.id, offsetX: e.offsetX, offsetY: e.offsetY };
            e.dataTransfer.effectAllowed = 'move';
        };
        el.oncontextmenu = (e) => {
            e.preventDefault(); e.stopPropagation();
            selectBlock(block.id);
            showContextMenu(e.pageX, e.pageY);
        };

        grid.appendChild(el);
    });
}

function getSummary(b) {
    const p = b.params;
    if (b.type === 'dialogue') return p.text;
    if (b.type === 'transition') {
        const s = scenes[p.target];
        return s ? `Go to: ${s.name}` : 'No Target';
    }
    if (b.type === 'wait') return p.duration + 's';
    if (b.type === 'audio' || b.type === 'video') return p.url.split('/').pop().split('?')[0] || 'Media';
    if (b.type === 'overlay') return `${p.effect} (${p.val})`;
    if (b.type === 'hide') return 'Hide Dialogue Box';
    return '';
}

function allowDrop(e) { e.preventDefault(); }
function handleTimelineDrop(e) {
    e.preventDefault();
    const rect = document.getElementById('timeline-grid').getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    const actualCellW = CELL_W * zoom;
    const step = Math.floor(x / actualCellW);
    const track = Math.floor(y / CELL_H);

    if (step < 0 || track < 0) return;

    saveState();

    if (dragSrc.source === 'palette') {
        const newItem = JSON.parse(JSON.stringify(dragSrc.itemData));
        delete newItem.isDefault; delete newItem.icon;

        const block = {
            id: Date.now(),
            type: newItem.type,
            name: newItem.name,
            params: newItem.params,
            start: step,
            track: track,
            duration: 1
        };
        timelineData.push(block);
        selectBlock(block.id);
    } else if (dragSrc.source === 'timeline') {
        const block = timelineData.find(b => b.id === dragSrc.id);
        if (block) {
            block.start = step;
            block.track = track;
            selectBlock(block.id);
        }
    }
    renderTimeline();
}

function startBlockResize(e, block) {
    e.stopPropagation(); e.preventDefault();
    const startX = e.clientX;
    const startDur = block.duration;
    const actualCellW = CELL_W * zoom;

    const onMove = (mv) => {
        const delta = mv.clientX - startX;
        const stepsAdded = Math.round(delta / actualCellW);
        let newDur = startDur + stepsAdded;
        if (newDur < 1) newDur = 1;
        if (block.duration !== newDur) {
            block.duration = newDur;
            renderTimeline();
        }
    };
    const onUp = () => {
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
        saveState();
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
}

function handleTimelineWheel(e) {
    e.preventDefault();
    if (e.ctrlKey) {
        zoom -= e.deltaY * 0.001;
        if (zoom < 0.2) zoom = 0.2; if (zoom > 3) zoom = 3;
        renderTimeline();
    } else if (e.altKey) {
        document.getElementById('timeline-scroll-area').scrollTop += e.deltaY;
    } else {
        document.getElementById('timeline-scroll-area').scrollLeft += e.deltaY;
    }
}

function showContextMenu(x, y) {
    const menu = document.getElementById('context-menu');
    const btnPaste = document.getElementById('ctx-paste');
    if (clipboardBlock) btnPaste.classList.remove('disabled'); else btnPaste.classList.add('disabled');
    menu.style.display = 'flex';
    if (y + 150 > window.innerHeight) y -= 150;
    if (x + 180 > window.innerWidth) x -= 180;
    menu.style.left = x + 'px'; menu.style.top = y + 'px';
}
function hideContextMenu() { document.getElementById('context-menu').style.display = 'none'; }
function ctxAction(act) {
    hideContextMenu();
    if (act === 'delete') deleteSelected();
    else if (act === 'copy') {
        const b = timelineData.find(x => x.id === selectedBlockId);
        if (b) { clipboardBlock = JSON.parse(JSON.stringify(b)); clipboardBlock.id = Date.now(); }
    } else if (act === 'paste') {
        if (clipboardBlock) {
            saveState();
            const n = JSON.parse(JSON.stringify(clipboardBlock));
            n.id = Date.now(); n.start += 1;
            timelineData.push(n);
            selectBlock(n.id);
        }
    }
}

function selectBlock(id) {
    selectedBlockId = id;
    renderTimeline();
    renderInspector();
    previewInstant();
}
function deleteSelected() {
    if (!selectedBlockId) return;
    saveState();
    timelineData = timelineData.filter(b => b.id !== selectedBlockId);
    selectedBlockId = null;
    renderTimeline();
    renderInspector();
}

function openGlobalSettings() {
    selectedBlockId = null;
    renderTimeline();
    const div = document.getElementById('inspector-content');
    div.innerHTML = `
            <div style="padding-bottom:10px; border-bottom:1px solid #333; margin-bottom:10px; font-weight:bold; color:var(--accent)">GLOBAL STYLES</div>
            <textarea class="code-editor" spellcheck="false" onfocus="saveState()" oninput="updateGlobalCSS(this.value)">${customCSS}</textarea>
        `;
}
function updateGlobalCSS(val) { customCSS = val; applyCustomCSS(val); }
function applyCustomCSS(css) { document.getElementById('custom-css-layer').innerHTML = css; }

window.inspectorStepOffset = 0;

// --- RENDER INSPECTOR ---
window.renderInspector = function () {
    const div = document.getElementById('inspector-content');
    const b = timelineData.find(x => x.id === selectedBlockId);
    if (!b) {
        if (!div.innerHTML.includes("GLOBAL STYLES")) div.innerHTML = '<div style="padding:20px;color:#666">Select a block</div>';
        return;
    }

    if (window.inspectorStepOffset >= b.duration) window.inspectorStepOffset = 0;

    const p = b.params;
    if ((b.type === 'sprite' || b.type === 'bg') && !p.steps) p.steps = {};

    let html = `<div style="padding-bottom:10px; border-bottom:1px solid #333; margin-bottom:10px; display:flex; justify-content:space-between; align-items:center;">
            <span class="type-${b.type}" style="border-top:3px solid; padding-top:2px; font-weight:bold;">${b.type.toUpperCase()}</span>
            <div>
                <button onclick="copyToPalette()" title="Copy to Palette" style="margin-right:5px;"><i class="fa-solid fa-copy"></i></button>
                <button class="danger" onclick="deleteSelected()"><i class="fa-solid fa-trash"></i></button>
            </div>
        </div>`;

    html += `<div class="inp-group"><label>Display Name</label><input type="text" onfocus="saveState()" value="${b.name || b.type}" oninput="updateBlockName(this.value)"></div>`;
    html += `<div class="inp-group"><label style="color:var(--accent)">Ref ID</label><input type="text" onfocus="saveState()" value="${p._id || ''}" oninput="updateParam('_id', this.value)"></div>`;
    html += `<div class="inp-group"><label>Start Step</label><input type="number" class="drag-input" onfocus="saveState()" value="${b.start}" oninput="updateMeta('start', this.value)"></div>`;
    html += `<div class="inp-group"><label>Duration (Steps)</label><input type="number" class="drag-input" onfocus="saveState()" value="${b.duration}" oninput="updateMeta('duration', this.value)"></div>`;

    const field = (lbl, k, type = 'text', step = 1) => `
            <div class="inp-group"><label>${lbl}</label><input type="${type}" step="${step}" onfocus="saveState()" value="${p[k] !== undefined ? p[k] : ''}" oninput="updateParam('${k}', this.value)" class="${type === 'number' ? 'drag-input' : ''}"></div>`;

    if (b.type === 'dialogue') {
        html += field('Speaker', 'name');
        html += `<div class="inp-group"><label>Text</label><textarea onfocus="saveState()" oninput="updateParam('text', this.value)">${p.text}</textarea></div>`;
        html += field('Speed', 'speed', 'number');
    }
    else if (b.type === 'bg' || b.type === 'sprite') {
        html += `<div style="font-size:0.8em; font-weight:bold; color:#888; margin-top:10px; border-bottom:1px solid #333">INITIAL STATE</div>`;
        html += field('URL', 'url');
        if (b.type === 'sprite') html += field('Character ID', 'id');
        html += `<div style="display:grid; grid-template-columns:1fr 1fr; gap:5px">
                ${field('X (%)', 'x', 'number')}
                ${field('Y (%)', 'y', 'number')}
                ${field(b.type === 'bg' ? 'Zoom' : 'Scale', b.type === 'bg' ? 'zoom' : 'scale', 'number', 0.1)}
                ${field('Rotate', 'rotate', 'number')}
            </div>`;
        html += field('Opacity', 'opacity', 'number', 0.1);

        html += `<div style="font-size:0.8em; font-weight:bold; color:var(--accent); margin-top:15px; border-bottom:1px solid #333; display:flex; justify-content:space-between; align-items:center;">
                        <span>ANIMATION</span>
                    </div>`;

        html += `<div style="margin-top:8px; display:flex; gap:10px; align-items:center; background:#222; padding:5px;">
                        <label style="font-size:0.8em; color:#ccc;">Edit Step:</label>
                        <select id="anim-step-sel" onchange="setInspectorStep(this.value)" style="flex:1; background:#111; color:white; border:1px solid #444;">`;
        for (let i = 0; i < b.duration; i++) {
            const hasData = p.steps && p.steps[i] ? '*' : '';
            html += `<option value="${i}" ${i == window.inspectorStepOffset ? 'selected' : ''}>Step ${b.start + i} (Offset ${i}) ${hasData}</option>`;
        }
        html += `</select></div>`;

        const stepData = (p.steps && p.steps[window.inspectorStepOffset]) || { duration: 0, loop: false, keyframes: [] };

        const easings = ['linear', 'ease', 'ease-in', 'ease-out', 'ease-in-out', 'step-start', 'step-end'];

        html += `<div style="display:grid; grid-template-columns: 1fr 1fr auto; gap:10px; margin-top:5px; background:#222; padding:8px; border-radius:4px;">
                        <div class="inp-group">
                            <label>Duration (s)</label>
                            <input type="number" step="0.1" value="${stepData.duration}" onchange="updateStepParam('duration', parseFloat(this.value))" style="width:100%">
                        </div>
                        <div class="inp-group">
                            <label>Easing</label>
                            <select onchange="updateStepParam('easing', this.value)" style="width:100%">
                                ${easings.map(e => `<option value="${e}" ${stepData.easing === e ? 'selected' : ''}>${e}</option>`).join('')}
                            </select>
                        </div>
                        <div class="inp-group" style="text-align:center">
                            <label>Loop</label>
                            <input type="checkbox" ${stepData.loop ? 'checked' : ''} onchange="updateStepParam('loop', this.checked)">
                        </div>
                    </div>`;


        html += `<div class="kf-container">
                <div class="kf-labels">
                    <span>0%</span><span>50%</span><span>100%</span>
                </div>
                <div class="kf-track" onmousemove="previewScrub(event, this)" onmouseleave="endScrub()" onclick="clickTrack(event, this)">
                    <div class="kf-scrubber" id="kf-scrubber-line"></div>`;

        if (stepData.keyframes) {
            stepData.keyframes.forEach((kf, idx) => {
                const isActive = window.selectedKeyframeIndex === idx ? 'active' : '';
                html += `<div class="kf-dot ${isActive}" style="left:${kf.t}%" 
                              title="${kf.p}: ${kf.v}" 
                              onclick="selectKeyframeIndex(${idx}, event)"></div>`;
            });
        }

        html += `</div>`;

        if (window.selectedKeyframeIndex !== null && stepData.keyframes[window.selectedKeyframeIndex]) {
            const kf = stepData.keyframes[window.selectedKeyframeIndex];

            const inp = (lbl, k, step = 1) => `
                    <div class="inp-group">
                        <label>${lbl}</label>
                        <input type="number" step="${step}" value="${kf[k] !== undefined ? kf[k] : ''}" 
                               oninput="updateKeyframeVal(${window.selectedKeyframeIndex}, '${k}', this.value)">
                    </div>`;

            html += `<div class="kf-edit-panel">
                            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:10px;">
                                <strong style="color:var(--accent); font-size:0.85em;">Editing Keyframe @ ${kf.t}%</strong>
                                <button class="danger" style="font-size:0.8em" onclick="removeKeyframe(${window.selectedKeyframeIndex})"><i class="fa-solid fa-trash"></i> Remove</button>
                            </div>
                            <div style="display:grid; grid-template-columns: 1fr 1fr 1fr; gap:8px;">
                                <div class="inp-group"><label>Time %</label><input type="number" value="${kf.t}" min="0" max="100" onchange="updateKeyframeVal(${window.selectedKeyframeIndex}, 't', this.value)"></div>
                                ${inp('X (%)', 'x')}
                                ${inp('Y (%)', 'y')}
                                ${inp('Scale', 'scale', 0.1)}
                                ${inp('Rotate', 'rotate', 1)}
                                ${inp('Opacity', 'opacity', 0.1)}
                            </div>
                         </div>`;
        } else {
            html += `<div style="text-align:center; padding:5px; font-size:0.75em; color:#555;">
                            Click track to add Keyframe<br>Click dot to edit
                         </div>`;
        }
        html += `</div>`;

    } else if (b.type === 'wait') {
        html += field('Duration (s)', 'duration', 'number');
    } else if (b.type === 'choice') {
        // CHOICE BUILDER WITH SCENE TARGETS
        p.options.forEach((o, i) => {
            // Generate scene options for this specific choice
            let scOpts = `<option value="">-- Next Block --</option>`;
            Object.values(scenes).forEach(sc => {
                scOpts += `<option value="${sc.id}" ${o.target === sc.id ? 'selected' : ''}>${sc.name}</option>`;
            });

            html += `<div style="background:#222; padding:8px; margin-bottom:5px; border:1px solid #444;">
                    <label style="font-size:0.7em; color:#888;">Button Text</label>
                    <input value="${o.text}" style="width:100%; margin-bottom:5px;" 
                           oninput="timelineData.find(x=>x.id===${b.id}).params.options[${i}].text=this.value;">
                    
                    <label style="font-size:0.7em; color:#888;">Target Scene</label>
                    <select style="width:100%; background:#111; color:white; border:1px solid #444; padding:4px;"
                            onchange="timelineData.find(x=>x.id===${b.id}).params.options[${i}].target=this.value; saveToLocal();">
                        ${scOpts}
                    </select>
                    
                    <button onclick="removeOption(${i})" style="margin-top:5px; width:100%; color:#ff6b6b; border:1px solid #ff6b6b; background:transparent; cursor:pointer;">
                        <i class="fa-solid fa-trash"></i> Remove
                    </button>
                </div>`;
        });
        html += `<button style="width:100%" onclick="addOption()"><i class="fa-solid fa-plus"></i> Add Option</button>`;
    } else if (b.type === 'transition') {
        // SCENE SELECTOR
        let opts = `<option value="">-- Select Scene --</option>`;
        Object.values(scenes).forEach(sc => {
            // Don't allow jumping to self (optional, but prevents infinite instant loops easily)
            // if(sc.id !== activeSceneId) 
            opts += `<option value="${sc.id}" ${p.target === sc.id ? 'selected' : ''}>${sc.name}</option>`;
        });
        html += `<div class="inp-group"><label>Target Scene</label>
                     <select onchange="updateParam('target', this.value)">${opts}</select>
                     </div>`;
    } else if (b.type === 'audio' || b.type === 'video') {
        html += field('URL', 'url'); html += field('Volume', 'vol', 'number', 0.1);
        html += `<div class="inp-group"><label>Loop</label><input type="checkbox" ${p.loop ? 'checked' : ''} onchange="updateParam('loop', this.checked)"></div>`;
    } else if (b.type === 'hide') {
        html += `<div style="padding:15px; color:#888; font-style:italic; text-align:center;">
                This block hides the dialogue box immediately.<br>It does not pause execution.
            </div>`;
    } else if (b.type === 'overlay') {
        // --- TARGET SELECTION ---
        html += `<div class="inp-group"><label>Target Scope</label>
                    <select onchange="updateParam('target', this.value); renderInspector();">
                        <option value="scene" ${p.target === 'scene' ? 'selected' : ''}>Scene (BG + Chars)</option>
                        <option value="stage" ${p.target === 'stage' ? 'selected' : ''}>Entire Stage (UI inc)</option>
                        <option value="bg" ${p.target === 'bg' ? 'selected' : ''}>Background Only</option>
                        <option value="char" ${p.target === 'char' ? 'selected' : ''}>Specific Character</option>
                    </select>
                </div>`;

        if (p.target === 'char') {
            html += field('Character ID', 'targetId');
        }

        // --- FILTER TYPE ---
        const filters = ['brightness', 'contrast', 'blur', 'grayscale', 'sepia', 'saturate', 'hue-rotate', 'invert', 'opacity'];
        html += `<div class="inp-group"><label>Filter Type</label>
                    <select onchange="updateParam('filter', this.value); previewInstant();">
                        ${filters.map(f => `<option value="${f}" ${p.filter === f ? 'selected' : ''}>${f}</option>`).join('')}
                    </select>
                </div>`;

        // --- KEYFRAME EDITOR INJECTION ---
        // We reuse the existing structure but customize the "Initial State" and "Keyframe Inputs"

        // 1. Initial State Placeholder (We don't use X/Y/Scale for filters, so we skip to animation)
        html += `<div style="font-size:0.8em; font-weight:bold; color:var(--accent); margin-top:15px; border-bottom:1px solid #333;">ANIMATION</div>`;

        // 2. Step Selector
        html += `<div style="margin-top:8px; display:flex; gap:10px; align-items:center; background:#222; padding:5px;">
                    <label style="font-size:0.8em; color:#ccc;">Edit Step:</label>
                    <select id="anim-step-sel" onchange="setInspectorStep(this.value)" style="flex:1; background:#111; color:white; border:1px solid #444;">`;
        for (let i = 0; i < b.duration; i++) {
            const hasData = p.steps && p.steps[i] ? '*' : '';
            html += `<option value="${i}" ${i == window.inspectorStepOffset ? 'selected' : ''}>Step ${b.start + i} ${hasData}</option>`;
        }
        html += `</select></div>`;

        const stepData = (p.steps && p.steps[window.inspectorStepOffset]) || { duration: 0, loop: false, keyframes: [] };

        // 3. Duration/Easing Controls
        const easings = ['linear', 'ease', 'ease-in', 'ease-out', 'ease-in-out', 'step-start', 'step-end'];
        html += `<div style="display:grid; grid-template-columns: 1fr 1fr auto; gap:10px; margin-top:5px; background:#222; padding:8px; border-radius:4px;">
                    <div class="inp-group"><label>Duration (s)</label><input type="number" step="0.1" value="${stepData.duration}" onchange="updateStepParam('duration', parseFloat(this.value))" style="width:100%"></div>
                    <div class="inp-group"><label>Easing</label><select onchange="updateStepParam('easing', this.value)" style="width:100%">${easings.map(e => `<option value="${e}" ${stepData.easing === e ? 'selected' : ''}>${e}</option>`).join('')}</select></div>
                    <div class="inp-group" style="text-align:center"><label>Loop</label><input type="checkbox" ${stepData.loop ? 'checked' : ''} onchange="updateStepParam('loop', this.checked)"></div>
                </div>`;

        // 4. Visual Track
        html += `<div class="kf-container">
                    <div class="kf-labels"><span>0%</span><span>50%</span><span>100%</span></div>
                    <div class="kf-track" onmousemove="previewScrub(event, this)" onmouseleave="endScrub()" onclick="clickTrack(event, this)">
                        <div class="kf-scrubber" id="kf-scrubber-line"></div>`;
        if (stepData.keyframes) {
            stepData.keyframes.forEach((kf, idx) => {
                const isActive = window.selectedKeyframeIndex === idx ? 'active' : '';
                html += `<div class="kf-dot ${isActive}" style="left:${kf.t}%" title="Val: ${kf.v}" onclick="selectKeyframeIndex(${idx}, event)"></div>`;
            });
        }
        html += `</div>`;

        // 5. Keyframe Inputs (CUSTOM FOR FILTER)
        if (window.selectedKeyframeIndex !== null && stepData.keyframes[window.selectedKeyframeIndex]) {
            const kf = stepData.keyframes[window.selectedKeyframeIndex];
            const unit = getFilterUnit(p.filter);
            html += `<div class="kf-edit-panel">
                        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:10px;">
                            <strong style="color:var(--accent); font-size:0.85em;">Keyframe @ ${kf.t}%</strong>
                            <button class="danger" style="font-size:0.8em" onclick="removeKeyframe(${window.selectedKeyframeIndex})"><i class="fa-solid fa-trash"></i> Remove</button>
                        </div>
                        <div style="display:grid; grid-template-columns: 1fr 1fr; gap:8px;">
                            <div class="inp-group"><label>Time %</label><input type="number" value="${kf.t}" min="0" max="100" onchange="updateKeyframeVal(${window.selectedKeyframeIndex}, 't', this.value)"></div>
                            
                            <!-- THE VALUE INPUT -->
                            <div class="inp-group">
                                <label>Intensity (${unit})</label>
                                <input type="number" step="any" value="${kf.v !== undefined ? kf.v : (p.filter === 'blur' ? 0 : 100)}" 
                                    oninput="updateKeyframeVal(${window.selectedKeyframeIndex}, 'v', this.value)">
                            </div>
                        </div>
                    </div>`;
        } else {
            html += `<div style="text-align:center; padding:5px; font-size:0.75em; color:#555;">Click track to add Keyframe</div></div>`;
        }
    }
    div.innerHTML = html;
};

function updateGizmo(block) {
    // FIX 5: Hide Gizmo in Play Mode
    if (isRunning) {
        document.getElementById('gizmo-box').style.display = 'none';
        return;
    }

    const gizmo = document.getElementById('gizmo-box');

    if (!block || (block.type !== 'sprite' && block.type !== 'bg')) {
        gizmo.style.display = 'none';
        return;
    }

    const targetId = block.type === 'bg' ? 'bg-layer' : 's-' + block.params.id;
    const el = document.getElementById(targetId);

    if (!el) { gizmo.style.display = 'none'; return; }

    gizmo.style.display = 'block';

    if (block.type === 'bg') {
        gizmo.style.width = '100%';
        gizmo.style.height = '100%';
        gizmo.style.left = '0';
        gizmo.style.top = '0';
        gizmo.style.transform = el.style.transform;
        gizmo.style.transformOrigin = 'center center';
    }
    else {
        const st = el.style;
        gizmo.style.left = st.left || '0';
        gizmo.style.top = st.top || '0';
        gizmo.style.transform = st.transform;
        gizmo.style.transformOrigin = 'bottom center';

        if (el.naturalWidth) {
            gizmo.style.width = el.naturalWidth + 'px';
            gizmo.style.height = el.naturalHeight + 'px';
        } else {
            gizmo.style.width = '100px';
            gizmo.style.height = '200px';
        }
    }
}

function resetPreview() {
    document.getAnimations().forEach(a => a.cancel());

    const bg = document.getElementById('bg-layer');
    bg.style = '';
    bg.style.backgroundImage = 'none';

    document.getElementById('sprite-layer').innerHTML = '';
    document.getElementById('dialogue-box').style.display = 'none';
    document.getElementById('choice-menu').style.display = 'none';

    const ac = document.getElementById('audio-container');
    const mc = document.getElementById('media-layer');
    ac.innerHTML = '';
    mc.innerHTML = '';

    activeMediaSources = { audio: null, video: null };
    document.getElementById('gizmo-box').style.display = 'none';
}

function playMedia(b) {
    const type = b.type;
    const container = type === 'audio' ? document.getElementById('audio-container') : document.getElementById('media-layer');

    if (activeMediaSources[type]) {
        try {
            activeMediaSources[type].pause();
            activeMediaSources[type].remove();
        } catch (e) { console.log("Error stopping media", e); }
    }

    let el = document.createElement(type);
    el.src = b.params.url;
    el.volume = b.params.vol !== undefined ? b.params.vol : 0.5;

    if (b.params.loop) el.loop = true;

    el.autoplay = true;

    if (type === 'video') {
        el.className = 'game-video';
        el.muted = (b.params.vol === 0);
    }

    activeMediaSources[type] = el;
    container.appendChild(el);

    el.play().catch(e => console.log("Autoplay blocked or failed", e));
}

function applyOverlay(b) {
    const p = b.params;
    const el = p.target === 'scene' ? document.getElementById('scene-wrapper') :
        p.target === 'bg' ? document.getElementById('bg-layer') : document.getElementById('game-stage');
    if (el) el.style.filter = p.effect === 'none' ? 'none' : `${p.effect}(${p.val})`;
}

function previewInstant() {
    if (isRunning) return;
    resetAllFilters();

    const b = timelineData.find(x => x.id === selectedBlockId);
    if (!b) return;

    const p = b.params;
    const dlgBox = document.getElementById('dialogue-box');
    const choiceMenu = document.getElementById('choice-menu');

    if (b.type === 'hide') {
        document.getElementById('dialogue-box').style.display = 'none';
        document.getElementById('choice-menu').style.display = 'none';
    }

    // 1. Handle Dialogue & Choice Preview
    if (b.type === 'dialogue') {
        dlgBox.style.display = 'block';
        choiceMenu.style.display = 'none'; // Ensure choice is hidden
        document.getElementById('speaker-name').innerText = p.name;
        document.getElementById('dialogue-text').innerText = p.text;
    }
    else if (b.type === 'choice') {
        // Basic preview for choice (optional, but good for context)
        dlgBox.style.display = 'none';
        choiceMenu.style.display = 'flex';
        choiceMenu.innerHTML = '';
        p.options.forEach(o => {
            const btn = document.createElement('div');
            btn.className = 'game-choice-btn';
            btn.innerText = o.text;
            choiceMenu.appendChild(btn);
        });
    }
    else {
        // Hide text boxes when editing Visuals (BG/Sprites) so they don't block the view
        dlgBox.style.display = 'none';
        choiceMenu.style.display = 'none';
    }

    // 2. Handle Visuals (BG/Sprite)
    if (b.type === 'bg' || b.type === 'sprite') {
        let el, layer;

        if (b.type === 'bg') {
            layer = document.getElementById('bg-layer');
            el = layer;
            if (!el.style.backgroundImage.includes(p.url)) {
                el.style.backgroundImage = `url('${p.url}')`;
            }
        } else {
            layer = document.getElementById('sprite-layer');
            el = document.getElementById('s-' + p.id);
            if (!el) {
                el = document.createElement('img');
                el.id = 's-' + p.id;
                el.className = 'sprite';
                el.style.pointerEvents = 'auto';
                el.onclick = (e) => { e.stopPropagation(); selectBlock(b.id); };
                layer.appendChild(el);
            }
            el.src = p.url;
        }

        // Render specific Keyframe state if selected
        let stateToRender = null;
        const isBg = b.type === 'bg';

        const stepIdx = window.inspectorStepOffset || 0;

        // GET BASE STATE
        const baseState = getStepBaseState(b, stepIdx);

        if (window.selectedKeyframeIndex !== null) {
            const stepIdx = window.inspectorStepOffset || 0;
            if (p.steps && p.steps[stepIdx] && p.steps[stepIdx].keyframes) {
                stateToRender = p.steps[stepIdx].keyframes[window.selectedKeyframeIndex];
            }
        }

        if (stateToRender) {
            const style = styleFromState(stateToRender, isBg);
            el.getAnimations().forEach(a => a.cancel());
            Object.assign(el.style, style);
        }
        else {
            const stepData = (p.steps && p.steps[stepIdx]) ? p.steps[stepIdx] : { keyframes: [] };
            const combinedParams = { ...p, keyframes: stepData.keyframes };

            // PASS BASE STATE
            const frames = generateWAAPIKeyframes(combinedParams, el, baseState);
            if (frames.length > 0) {
                el.getAnimations().forEach(a => a.cancel());
                Object.assign(el.style, frames[0]);
            }
        }
    }

    if (b.type === 'overlay') {
        const stepIdx = window.inspectorStepOffset || 0;
        // Mock a step object to reuse applyFilterAnimation logic
        const p = b.params;
        let stepData = { duration: 0, keyframes: [] };

        if (p.steps && p.steps[stepIdx]) {
            stepData = p.steps[stepIdx];
        }

        // If a specific keyframe is selected, snap to it
        if (window.selectedKeyframeIndex !== null && stepData.keyframes && stepData.keyframes[window.selectedKeyframeIndex]) {
            const kf = stepData.keyframes[window.selectedKeyframeIndex];
            // Create a temporary single-frame animation
            applyFilterAnimation(b, { duration: 0, keyframes: [{ t: 0, v: kf.v }] });
        } else {
            // Show the start of the current step
            applyFilterAnimation(b, { duration: 0, keyframes: stepData.keyframes });
        }
    }

    updateGizmo(b);
}
async function toggleRun() {
    const btn = document.getElementById('btn-play');
    const head = document.getElementById('tl-playhead');
    const scrollArea = document.getElementById('timeline-scroll-area');

    if (isRunning) { isRunning = false; return; }

    isRunning = true;
    runUID++;
    const myRunID = runUID;

    btn.innerHTML = '<i class="fa-solid fa-stop"></i>';
    btn.classList.add('running');
    document.getElementById('status-indicator').innerText = "PLAYING";

    let runtimeSceneId = activeSceneId;
    let step = 0;

    while (isRunning && runUID === myRunID && scenes[runtimeSceneId]) {

        // Cleanup previous scene assets
        resetPreview();

        const currentBlocks = scenes[runtimeSceneId].blocks;
        let maxStep = 0;
        currentBlocks.forEach(b => { if (b.start + b.duration > maxStep) maxStep = b.start + b.duration; });

        while (step < maxStep + 1 && isRunning && runUID === myRunID) {

            if (runtimeSceneId === activeSceneId) {
                head.style.display = 'block';
                const actualCellW = CELL_W * zoom;
                head.style.left = (step * actualCellW) + 'px';
                if (step * actualCellW > scrollArea.scrollLeft + scrollArea.clientWidth) {
                    scrollArea.scrollLeft = (step * actualCellW) - 100;
                }
            } else {
                head.style.display = 'none';
            }

            resetAllFilters();

            const activeBlocks = currentBlocks.filter(b => step >= b.start && step < b.start + b.duration);
            let stepMaxDuration = 0; // Tracks the longest animation in this step

            activeBlocks.forEach(b => {
                const relStep = step - b.start;
                const stepBaseState = getStepBaseState(b, relStep);

                // 1. Initial State Application
                if (b.type === 'bg' || b.type === 'sprite') {
                    const stepData = (b.params.steps && b.params.steps[relStep]) ? b.params.steps[relStep] : { duration: 0, keyframes: [] };
                    applyVisualAnimation(b, stepData, stepBaseState);
                }
                else if (b.type === 'overlay') {
                    const stepData = (b.params.steps && b.params.steps[relStep]) ? b.params.steps[relStep] : { duration: 0, keyframes: [] };
                    applyFilterAnimation(b, stepData, stepBaseState);
                }

                // 2. Play Animations & Calculate Durations
                if (b.type === 'bg' || b.type === 'sprite') {
                    if (b.params.steps && b.params.steps[relStep]) {
                        const stepAnim = b.params.steps[relStep];
                        if (stepAnim.duration > stepMaxDuration) stepMaxDuration = stepAnim.duration;
                        if (stepAnim.keyframes && stepAnim.keyframes.length > 0) applyVisualAnimation(b, stepAnim);
                    }
                    else if (relStep === 0) applyVisualAnimation(b, { duration: 0, loop: false, keyframes: [] });
                }
                else if (b.type === 'overlay') {
                    if (b.params.steps && b.params.steps[relStep]) {
                        const stepAnim = b.params.steps[relStep];

                        // FIX: Now checking Overlay duration too!
                        if (stepAnim.duration > stepMaxDuration) stepMaxDuration = stepAnim.duration;

                        applyFilterAnimation(b, b.params.steps[relStep]);
                    }
                    else if (relStep === 0) applyFilterAnimation(b, { duration: 0, loop: false, keyframes: [] });
                }
                else if (b.start === step && (b.type === 'audio' || b.type === 'video')) playMedia(b);
                else if (b.start === step && b.type === 'overlay') applyOverlay(b);
                else if (b.start === step && b.type === 'hide') document.getElementById('dialogue-box').style.display = 'none';
            });

            const triggers = currentBlocks.filter(b => b.start === step);

            // Transition Check
            const transBlock = triggers.find(b => b.type === 'transition');
            if (transBlock && transBlock.params.target) {
                runtimeSceneId = transBlock.params.target;
                step = 0;
                break;
            }

            const blockers = triggers.filter(b => ['dialogue', 'choice', 'wait'].includes(b.type));
            const tasks = [];

            if (blockers.length > 0) {
                // If there is dialogue, we wait for the User (Dialogue/Choice)
                // The animations (Filter/Sprite) will play in the background concurrently.
                for (let b of blockers) {
                    const p = b.params;
                    if (b.type === 'wait') tasks.push(runWait(p.duration));
                    else if (b.type === 'dialogue') tasks.push(runDialogue(p));
                    else if (b.type === 'choice') tasks.push(runChoice(p));
                }
            } else {
                // If NO dialogue, we wait for the longest animation (Filter or Sprite)
                tasks.push(runWait(stepMaxDuration > 0 ? stepMaxDuration : 0.1));
            }

            if (tasks.length > 0) {
                const res = await Promise.all(tasks);
                if (!isRunning || runUID !== myRunID) break;

                const choiceRes = res.find(r => r && r.target);
                if (choiceRes && choiceRes.target) {
                    runtimeSceneId = choiceRes.target;
                    step = 0;
                    break;
                }
            }
            step++;
        }

        if (step > maxStep) { isRunning = false; }
    }

    if (runUID === myRunID) {
        isRunning = false;
        btn.innerHTML = '<i class="fa-solid fa-play"></i>';
        btn.classList.remove('running');
        document.getElementById('status-indicator').innerText = "";
        head.style.display = 'none';
        resetPreview();
        if (selectedBlockId) previewInstant();
    }
}

function runDialogue(p) {
    return new Promise(resolve => {
        const box = document.getElementById('dialogue-box');
        box.style.display = 'block';
        document.getElementById('speaker-name').innerText = p.name;
        const txt = document.getElementById('dialogue-text');
        txt.innerText = '';

        let typeInterval = null;
        let stopWatcher = null;

        const end = () => {
            if (typeInterval) clearInterval(typeInterval);
            if (stopWatcher) clearInterval(stopWatcher);
            box.onclick = null;
            resolve();
        };

        stopWatcher = setInterval(() => {
            if (!isRunning) end();
        }, 100);

        let i = 0;
        typeInterval = setInterval(() => {
            txt.innerText += p.text.charAt(i++);
            if (i >= p.text.length) {
                clearInterval(typeInterval);
                box.onclick = () => end();
            }
        }, p.speed);

        box.onclick = () => {
            clearInterval(typeInterval);
            txt.innerText = p.text;
            box.onclick = () => end();
        };
    });
}

function runChoice(p) {
    return new Promise(resolve => {
        const m = document.getElementById('choice-menu');
        document.getElementById('dialogue-box').style.display = 'none';
        m.style.display = 'flex';
        m.innerHTML = '';

        const check = setInterval(() => {
            if (!isRunning) {
                clearInterval(check);
                resolve(null);
            }
        }, 100);

        p.options.forEach(o => {
            const b = document.createElement('div');
            b.className = 'game-choice-btn';
            b.innerText = o.text;
            b.onclick = (e) => {
                e.stopPropagation();
                clearInterval(check);
                m.style.display = 'none';
                // Return the scene target ID
                resolve({ target: o.target });
            };
            m.appendChild(b);
        });
    });
}

function exportData() {
    // Now saves the SCENES object instead of just the active timeline
    const data = {
        scenes: scenes,
        activeSceneId: activeSceneId,
        palette: paletteItems, // Include custom palette items
        css: customCSS,
        ui: { grid: isGridView }
    };

    const a = document.createElement('a');
    a.href = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(data));
    a.download = "vn_project_scenes.json";
    document.body.appendChild(a);
    a.click();
    a.remove();
}
function importData(el) {
    const r = new FileReader();
    r.onload = e => {
        try {
            const d = JSON.parse(e.target.result);

            // 1. Handle Scenes (New Format vs Old Format)
            if (d.scenes) {
                scenes = d.scenes;
                activeSceneId = d.activeSceneId || Object.keys(scenes)[0];
            }
            else if (d.timeline) {
                // Legacy file support: Convert old timeline to Scene 1
                let oldBlocks = [];
                // Handle really old array-of-arrays format just in case
                if (d.timeline.length && Array.isArray(d.timeline[0])) {
                    d.timeline.forEach((col, cIdx) => col.forEach((blk, rIdx) => {
                        oldBlocks.push({ id: Date.now() + Math.random(), type: blk.type, params: blk.params, start: cIdx, track: rIdx, duration: 1 });
                    }));
                } else {
                    oldBlocks = d.timeline;
                }

                scenes = { 'scene_start': { id: 'scene_start', name: 'Start', blocks: oldBlocks } };
                activeSceneId = 'scene_start';
            }

            // 2. Handle Palette
            if (d.palette) {
                paletteItems = d.palette;
            }

            // 3. Handle CSS & UI
            customCSS = d.css || '';
            applyCustomCSS(customCSS);
            if (d.ui) isGridView = !!d.ui.grid;

            // 4. Refresh Everything
            renderSceneList();
            renderPalette();
            updateTrayView();
            renderTimeline();
            saveToLocal();

        } catch (err) {
            console.error("Import Error", err);
            alert("Error loading file. Check console for details.");
        }
    };
    if (el.files[0]) r.readAsText(el.files[0]);
    el.value = ''; // Reset input to allow reloading same file
}
function resetTimeline() { timelineData = []; renderTimeline(); saveToLocal(); }

function styleFromState(s, isBg) {
    if (isBg) {
        return {
            transform: `translate(${s.x - 50}%, ${s.y - 50}%) scale(${s.scale}) rotate(${s.rotate}deg)`,
            opacity: s.opacity,
            backgroundPosition: 'center'
        };
    } else {
        return {
            left: s.x + '%',
            top: s.y + '%',
            transform: `translateX(-50%) translateY(-100%) scale(${s.scale}) rotate(${s.rotate}deg)`,
            opacity: s.opacity
        };
    }
}

function getInterpolatedState(baseParams, keyframes, t) {
    const base = baseParams;

    let frames = keyframes.map(k => ({ ...k }));
    if (!frames.find(f => f.t === 0)) frames.push({ t: 0, ...base });
    frames.sort((a, b) => a.t - b.t);

    let prev = frames[0];
    let next = frames[frames.length - 1];

    for (let i = 0; i < frames.length; i++) {
        if (frames[i].t <= t) prev = frames[i];
        if (frames[i].t >= t) { next = frames[i]; break; }
    }

    if (prev === next || prev.t === next.t) return { ...prev, t: t };

    const ratio = (t - prev.t) / (next.t - prev.t);
    const lerp = (a, b, r) => a + (b - a) * r;

    const val = (obj, k) => obj[k] !== undefined ? obj[k] : base[k];

    return {
        t: t,
        x: parseFloat(lerp(val(prev, 'x'), val(next, 'x'), ratio).toFixed(1)),
        y: parseFloat(lerp(val(prev, 'y'), val(next, 'y'), ratio).toFixed(1)),
        scale: parseFloat(lerp(val(prev, 'scale'), val(next, 'scale'), ratio).toFixed(2)),
        rotate: Math.round(lerp(val(prev, 'rotate'), val(next, 'rotate'), ratio)),
        opacity: parseFloat(lerp(val(prev, 'opacity'), val(next, 'opacity'), ratio).toFixed(2)),
        v: parseFloat(lerp(val(prev, 'v'), val(next, 'v'), ratio).toFixed(1))
    };
}

function updateBlockName(v) { timelineData.find(x => x.id === selectedBlockId).name = v; renderTimeline(); }
function updateMeta(k, v) {
    const b = timelineData.find(x => x.id === selectedBlockId);
    b[k] = parseInt(v);
    renderTimeline(); previewInstant();
}
function updateParam(k, v) {
    // FIX 7: parseFloat for inputs
    if (['x', 'y', 'scale', 'rotate', 'opacity', 'vol', 'speed'].includes(k)) {
        v = parseFloat(v);
    }
    timelineData.find(x => x.id === selectedBlockId).params[k] = v;
    previewInstant(); saveToLocal();
}
function addOption() { saveState(); timelineData.find(x => x.id === selectedBlockId).params.options.push({ text: 'New', target: '' }); renderInspector(); }
function removeOption(i) { saveState(); timelineData.find(x => x.id === selectedBlockId).params.options.splice(i, 1); renderInspector(); }

function copyToPalette() {
    const b = timelineData.find(x => x.id === selectedBlockId);
    if (!b) return;
    paletteItems.push({
        type: b.type,
        name: b.name || b.type,
        params: JSON.parse(JSON.stringify(b.params)),
        isDefault: false
    });
    renderPalette();
    saveToLocal(); // <--- ADD THIS
}

// --- MISSING UI HELPERS ---

window.setInspectorStep = function (val) {
    window.inspectorStepOffset = parseInt(val);
    renderInspector();
    renderTimeline(); // Move the highlight
};

window.ensureStepData = function () {
    const b = timelineData.find(x => x.id === selectedBlockId);
    if (!b.params.steps) b.params.steps = {};
    if (!b.params.steps[window.inspectorStepOffset]) {
        // Initialize with default values if not exists
        b.params.steps[window.inspectorStepOffset] = { duration: 3, loop: false, keyframes: [] };
    }
    return b;
};

window.updateStepParam = function (key, val) {
    saveState();
    const b = window.ensureStepData();
    b.params.steps[window.inspectorStepOffset][key] = val;
};

window.removeKeyframe = function (idx) {
    saveState();
    const b = timelineData.find(x => x.id === selectedBlockId);
    if (b && b.params.steps && b.params.steps[window.inspectorStepOffset]) {
        b.params.steps[window.inspectorStepOffset].keyframes.splice(idx, 1);
    }
    window.selectedKeyframeIndex = null; // Deselect to avoid errors
    window.renderInspector();
    previewInstant();
};

// --- FILTER HELPERS ---
function getFilterUnit(type) {
    if (type === 'blur') return 'px';
    if (type === 'hue-rotate') return 'deg';
    return '%';
}

function resetAllFilters() {
    // 1. Reset Global Containers
    ['game-stage', 'scene-wrapper', 'bg-layer'].forEach(id => {
        const el = document.getElementById(id);
        if (el) {
            el.style.filter = 'none';
            el.getAnimations().forEach(a => { if (a.id === 'vn-filter') a.cancel(); });
        }
    });

    // 2. Reset All Sprites
    const sprites = document.querySelectorAll('.sprite');
    sprites.forEach(el => {
        el.style.filter = 'none';
        el.getAnimations().forEach(a => { if (a.id === 'vn-filter') a.cancel(); });
    });
}

function applyFilterAnimation(block, animData, baseState = null) {
    const p = block.params;
    let el;

    // Resolve Target
    if (p.target === 'stage') el = document.getElementById('game-stage');
    else if (p.target === 'scene') el = document.getElementById('scene-wrapper');
    else if (p.target === 'bg') el = document.getElementById('bg-layer');
    else if (p.target === 'char') el = document.getElementById('s-' + p.targetId);

    if (!el) return;

    // Default Value logic
    const unit = getFilterUnit(p.filter);
    // Use baseState if available, otherwise default logic
    const defVal = (baseState && baseState.v !== undefined) ? baseState.v :
        (p.filter === 'blur' || p.filter === 'hue-rotate' || p.filter === 'invert' || p.filter === 'grayscale' || p.filter === 'sepia') ? 0 : 100;

    // Generate Keyframes
    let frames = (animData.keyframes || []).map(k => {
        const val = k.v !== undefined ? k.v : defVal;
        return {
            offset: k.t / 100,
            filter: `${p.filter}(${val}${unit})`
        };
    });

    if (!frames.find(f => f.offset === 0)) frames.unshift({ offset: 0, filter: `${p.filter}(${defVal}${unit})` });
    if (!frames.find(f => f.offset === 1)) frames.push({ offset: 1, filter: frames[frames.length - 1].filter });

    frames.sort((a, b) => a.offset - b.offset);

    if (animData.duration === 0) {
        el.style.filter = frames[0].filter;
    } else {
        const opts = {
            id: 'vn-filter',
            duration: animData.duration * 1000,
            iterations: animData.loop ? Infinity : 1,
            fill: 'forwards',
            easing: animData.easing || 'linear'
        };
        el.animate(frames, opts);
    }
}

function getStepBaseState(block, targetStepIdx) {
    // 1. Define Defaults based on Block Type
    let state = {
        x: block.params.x !== undefined ? parseFloat(block.params.x) : 50,
        y: block.params.y !== undefined ? parseFloat(block.params.y) : (block.type === 'bg' ? 50 : 100),
        scale: parseFloat(block.params.scale ?? (block.params.zoom ?? 1)),
        rotate: parseFloat(block.params.rotate || 0),
        opacity: parseFloat(block.params.opacity !== undefined ? block.params.opacity : 1),
    };

    // Filter Default Handling
    if (block.type === 'overlay') {
        const f = block.params.filter;
        const zeroDefault = ['blur', 'hue-rotate', 'invert', 'grayscale', 'sepia'];
        state.v = zeroDefault.includes(f) ? 0 : 100;
    }

    // 2. Accumulate changes from previous steps (0 to target-1)
    if (block.params.steps) {
        for (let i = 0; i < targetStepIdx; i++) {
            const s = block.params.steps[i];
            if (s && s.keyframes && s.keyframes.length > 0) {
                // Get the last keyframe (assuming sorted by t, which the editor enforces)
                const last = s.keyframes[s.keyframes.length - 1];

                // Update state with defined props
                ['x', 'y', 'scale', 'rotate', 'opacity', 'v'].forEach(prop => {
                    if (last[prop] !== undefined && last[prop] !== null && last[prop] !== '') {
                        state[prop] = parseFloat(last[prop]);
                    }
                });
            }
        }
    }
    return state;
}

// --- SCENE MANAGEMENT ---
function renderSceneList() {
    const list = document.getElementById('scene-list');
    list.innerHTML = '';

    Object.values(scenes).forEach(sc => {
        const el = document.createElement('div');
        el.className = `scene-item ${sc.id === activeSceneId ? 'active' : ''}`;
        el.onclick = () => switchScene(sc.id);

        // Name Display
        const span = document.createElement('span');
        span.innerText = sc.name;
        span.ondblclick = (e) => {
            e.stopPropagation();
            const newName = prompt("Rename Scene:", sc.name);
            if (newName) { sc.name = newName; renderSceneList(); saveToLocal(); }
        };

        const delBtn = document.createElement('button');
        delBtn.className = 'scene-btn';
        delBtn.innerHTML = '<i class="fa-solid fa-trash"></i>';
        delBtn.onclick = (e) => {
            e.stopPropagation();
            deleteScene(sc.id);
        };

        el.appendChild(span);
        if (Object.keys(scenes).length > 1) el.appendChild(delBtn);
        list.appendChild(el);
    });
}

function addScene() {
    saveState();
    const id = 'scene_' + Date.now();
    scenes[id] = { id: id, name: 'New Scene', blocks: [] };
    switchScene(id);
}

function switchScene(id) {
    if (!scenes[id]) return;
    activeSceneId = id;
    selectedBlockId = null;
    renderSceneList();
    renderTimeline();
    renderInspector();
    saveToLocal();
}

function deleteScene(id) {
    if (Object.keys(scenes).length <= 1) return;
    if (!confirm("Delete this scene?")) return;

    saveState();
    delete scenes[id];

    if (id === activeSceneId) {
        activeSceneId = Object.keys(scenes)[0];
    }

    switchScene(activeSceneId);
}
