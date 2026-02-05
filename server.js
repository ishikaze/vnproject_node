require('dotenv').config();
const express = require('express');
const session = require('express-session');
const passport = require('passport');
const DiscordStrategy = require('passport-discord').Strategy;
const multer = require('multer');
const db = require('./db');
const sharp = require('sharp');
const ffmpeg = require('fluent-ffmpeg');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();

// --- CONFIGURATION ---
const ADMIN_IDS = (process.env.ADMIN_IDS || '').split(',').map(id => id.trim());

// --- 1. SETUP STORAGE FOLDERS ---
const uploadDir = path.join(__dirname, 'public/uploads');
const tempDir = path.join(__dirname, 'temp_uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

// --- 2. CONFIGURE MULTER ---
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, tempDir),
    filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname)
});
const upload = multer({ storage: storage });

// --- 3. PASSPORT AUTH SETUP ---
passport.serializeUser((user, done) => {
    done(null, user.id);
});
passport.deserializeUser((id, done) => {
    try {
        const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
        done(null, user);
    } catch (err) {
        done(err, null);
    }
});

passport.use(new DiscordStrategy({
    clientID: process.env.DISCORD_CLIENT_ID,
    clientSecret: process.env.DISCORD_CLIENT_SECRET,
    callbackURL: process.env.DISCORD_CALLBACK_URL,
    scope: ['identify']
}, (accessToken, refreshToken, profile, done) => {
    
    const stmt = db.prepare(`
        INSERT INTO users (id, username, display_name) 
        VALUES (?, ?, ?) 
        ON CONFLICT(id) DO UPDATE SET username = excluded.username
    `);
    stmt.run(profile.id, profile.username, profile.username);
    
    // Fetch the full user object (including display_name) to store in session
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(profile.id);
    return done(null, user);
}));

// --- 4. MIDDLEWARE ---

// Global Restriction Check (Bans & Whitelist)
const checkGlobalRestrictions = (req, res, next) => {
    if (req.path === '/login' || req.path === '/auth/discord' || req.path === '/auth/discord/callback' || req.path === '/logout') {
        return next();
    }

    // Check Whitelist Mode
    const whitelistSetting = db.prepare("SELECT value FROM settings WHERE key = 'whitelist_mode'").get();
    const isWhitelist = whitelistSetting && whitelistSetting.value === '1';

    if (req.isAuthenticated()) {
        // 1. Check Ban
        const user = db.prepare("SELECT is_banned, is_admin FROM users WHERE id = ?").get(req.user.id);
        
        if (user && user.is_banned) {
            req.logout(() => {
                return res.status(403).send("<h1>Access Denied</h1><p>Your account has been banned.</p>");
            });
            return;
        }

        // 2. Check Whitelist
        if (isWhitelist && !user.is_admin) {
            return res.status(503).send("<h1>Maintenance Mode</h1><p>The site is currently in closed testing. Only Admins can access.</p>");
        }
    } else {
        // Guest Users during Whitelist
        if (isWhitelist) {
            // Allow them to see the landing page? Or block completely?
            // Let's block completely except for login
            return res.status(503).send("<h1>Maintenance Mode</h1><p>The site is currently in closed testing. <a href='/login'>Admin Login</a></p>");
        }
    }

    next();
};

function checkAuth(req, res, next) {
    if (req.isAuthenticated()) return next();
    res.redirect('/login');
}

function checkAdmin(req, res, next) {
    if (req.isAuthenticated() && req.user.is_admin) return next();
    res.status(403).send("Admins only.");
}

// --- 5. CONVERSION LOGIC ---
const processFile = (file) => {
    return new Promise((resolve, reject) => {
        const inputPath = file.path;
        const uniqueName = Date.now() + '-' + Math.round(Math.random() * 1E9);
        
        if (file.mimetype.startsWith('image/')) {
            const outputFilename = uniqueName + '.webp';
            const outputPath = path.join(uploadDir, outputFilename);
            sharp(inputPath).webp({ quality: 80 }).toFile(outputPath)
                .then(() => resolve({ filename: outputFilename, type: 'image' })).catch(reject);
        } else if (file.mimetype.startsWith('video/')) {
            const outputFilename = uniqueName + '.webm';
            const outputPath = path.join(uploadDir, outputFilename);
            ffmpeg(inputPath).output(outputPath).videoCodec('libvpx-vp9').audioCodec('libvorbis').outputOptions('-crf 30')
                .on('end', () => resolve({ filename: outputFilename, type: 'video' }))
                .on('error', (err) => reject(err)).run();
        } else if (file.mimetype.startsWith('audio/')) {
            const ext = path.extname(file.originalname);
            const outputFilename = uniqueName + ext;
            const outputPath = path.join(uploadDir, outputFilename);
            fs.copyFile(inputPath, outputPath, (err) => {
                if (err) reject(err); else resolve({ filename: outputFilename, type: 'audio' });
            });
        } else {
            reject(new Error("Unsupported file type"));
        }
    });
};

// --- 6. EXPRESS CONFIG ---
app.set('view engine', 'ejs');
app.use(express.static('public'));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(session({
    secret: process.env.SESSION_SECRET || 'dev_secret',
    resave: false,
    saveUninitialized: false
}));
app.use(passport.initialize());
app.use(passport.session());

// Apply Global Restrictions
app.use(checkGlobalRestrictions);

// --- 7. ADMIN ROUTES ---

app.get('/admin', checkAdmin, (req, res) => {
    const whitelistSetting = db.prepare("SELECT value FROM settings WHERE key = 'whitelist_mode'").get();
    const whitelistEnabled = whitelistSetting && whitelistSetting.value === '1';

    const users = db.prepare("SELECT * FROM users ORDER BY is_admin DESC").all();
    const projects = db.prepare("SELECT p.*, u.username, u.display_name FROM projects p JOIN users u ON p.user_id = u.id ORDER BY p.created_at DESC").all();
    const assets = db.prepare("SELECT a.*, u.username FROM assets a JOIN users u ON a.user_id = u.id ORDER BY a.id DESC LIMIT 50").all();

    res.render('admin', { whitelistEnabled, users, projects, assets });
});

app.post('/admin/toggle-whitelist', checkAdmin, (req, res) => {
    const current = db.prepare("SELECT value FROM settings WHERE key = 'whitelist_mode'").get();
    const newVal = current.value === '1' ? '0' : '1';
    db.prepare("UPDATE settings SET value = ? WHERE key = 'whitelist_mode'").run(newVal);
    res.redirect('/admin');
});

app.post('/admin/user/:id/toggle-ban', checkAdmin, (req, res) => {
    // Prevent banning self
    if(req.params.id === req.user.id) return res.status(400).send("Cannot ban self.");
    
    const user = db.prepare("SELECT is_banned FROM users WHERE id = ?").get(req.params.id);
    const newVal = user.is_banned ? 0 : 1;
    db.prepare("UPDATE users SET is_banned = ? WHERE id = ?").run(newVal, req.params.id);
    res.redirect('/admin');
});

app.post('/admin/project/:id/delete', checkAdmin, (req, res) => {
    // Cascade delete handles episodes and asset DB entries, but we must delete files manually
    const assets = db.prepare("SELECT url FROM assets WHERE project_id = ?").all(req.params.id);
    
    assets.forEach(a => {
        const filePath = path.join(__dirname, 'public', a.url);
        if(fs.existsSync(filePath)) fs.unlinkSync(filePath);
    });

    db.prepare("DELETE FROM projects WHERE id = ?").run(req.params.id);
    res.redirect('/admin');
});

app.post('/admin/asset/:id/delete', checkAdmin, (req, res) => {
    const asset = db.prepare("SELECT url FROM assets WHERE id = ?").get(req.params.id);
    if(asset) {
        const filePath = path.join(__dirname, 'public', asset.url);
        if(fs.existsSync(filePath)) fs.unlinkSync(filePath);
        db.prepare("DELETE FROM assets WHERE id = ?").run(req.params.id);
    }
    res.redirect('/admin');
});


// --- 8. STANDARD ROUTES ---

app.get('/', (req, res) => {
    // Aggregating all stats in one query
    const projects = db.prepare(`
        SELECT p.*, u.username, u.display_name,
            (SELECT COUNT(*) FROM views v WHERE v.project_id = p.id) as view_count,
            (SELECT COUNT(DISTINCT l.user_id) FROM likes l WHERE l.project_id = p.id) as like_count,
            (SELECT COUNT(*) FROM comments com WHERE com.project_id = p.id) as comment_count,
            (SELECT AVG(user_avg) FROM (
                SELECT AVG(score) as user_avg 
                FROM ratings r 
                WHERE r.project_id = p.id 
                GROUP BY r.user_id
            )) as avg_rating
        FROM projects p 
        JOIN users u ON p.user_id = u.id 
        WHERE p.is_published = 1 
        ORDER BY p.created_at DESC
    `).all();
    
    res.render('landing', { projects, user: req.user });
});

app.get('/login', (req, res) => res.render('login'));
app.get('/auth/discord', passport.authenticate('discord'));
app.get('/auth/discord/callback', passport.authenticate('discord', { failureRedirect: '/login' }), 
    (req, res) => res.redirect('/dashboard'));
app.get('/logout', (req, res) => { req.logout(() => res.redirect('/')); });

app.get('/dashboard', checkAuth, (req, res) => {
    const projects = db.prepare('SELECT * FROM projects WHERE user_id = ? ORDER BY created_at DESC').all(req.user.id);
    res.render('dashboard', { user: req.user, projects });
});

// Admin Button in Dashboard (Optional convenience)
// You can add this to dashboard.ejs later if you want

app.post('/project/create', checkAuth, (req, res) => {
    const stmt = db.prepare('INSERT INTO projects (user_id, title, description) VALUES (?, ?, ?)');
    stmt.run(req.user.id, req.body.title, req.body.description || '');
    res.redirect('/dashboard');
});

app.get('/series/:id', (req, res) => {
    const project = db.prepare('SELECT p.*, u.username, u.display_name FROM projects p JOIN users u ON p.user_id = u.id WHERE p.id = ?').get(req.params.id);
    
    if (!project || (!project.is_published && (!req.user || req.user.id !== project.user_id))) {
        return res.status(404).send("Project not found or private.");
    }

    registerView(project.id, req);

    const viewStats = db.prepare(`
        SELECT COUNT(*) as count FROM views 
        WHERE project_id = ?
    `).get(project.id);
    project.viewCount = viewStats.count;

    const likeStats = db.prepare('SELECT COUNT(DISTINCT user_id) as count FROM likes WHERE project_id = ?').get(project.id);
    project.likeCount = likeStats.count;

    const userAverages = db.prepare(`
        SELECT AVG(score) as avg_score 
        FROM ratings 
        WHERE project_id = ? 
        GROUP BY user_id
    `).all(project.id);

    let rating = 0;
    if (userAverages.length > 0) {
        const sum = userAverages.reduce((a, b) => a + b.avg_score, 0);
        rating = (sum / userAverages.length).toFixed(1); // One decimal place (e.g., 4.5)
    }
    project.rating = rating;

    const episodes = db.prepare('SELECT id, title, episode_number FROM episodes WHERE project_id = ? AND published_data IS NOT NULL ORDER BY episode_number ASC').all(project.id);

    res.render('series_public', { project, episodes, user: req.user });
});

// 3. PUBLIC PLAYER (Play Episode) - UPDATED FOR END SCREEN
app.get('/play/:episodeId', (req, res) => {
    const episode = db.prepare('SELECT * FROM episodes WHERE id = ?').get(req.params.episodeId);
    if (!episode || !episode.published_data) return res.status(404).send("Episode not found or not published.");

    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(episode.project_id);
    const assets = db.prepare('SELECT * FROM assets WHERE project_id = ?').all(project.id);
    
    // 1. User Context (Like & Rating)
    let isLiked = false;
    let userRating = 0;
    
    if(req.user) {
        const likeCheck = db.prepare('SELECT 1 FROM likes WHERE user_id = ? AND episode_id = ?').get(req.user.id, episode.id);
        isLiked = !!likeCheck;
        
        const rateCheck = db.prepare('SELECT score FROM ratings WHERE user_id = ? AND episode_id = ?').get(req.user.id, episode.id);
        if(rateCheck) userRating = rateCheck.score;
    }

    // 2. Navigation (Prev/Next) based on Episode Number
    const prevEp = db.prepare('SELECT id FROM episodes WHERE project_id = ? AND episode_number < ? AND published_data IS NOT NULL ORDER BY episode_number DESC LIMIT 1').get(project.id, episode.episode_number);
    const nextEp = db.prepare('SELECT id FROM episodes WHERE project_id = ? AND episode_number > ? AND published_data IS NOT NULL ORDER BY episode_number ASC LIMIT 1').get(project.id, episode.episode_number);

    res.render('player', {
        episodeJSON: episode.published_data,
        assetsJSON: JSON.stringify(assets),
        title: `${project.title} - ${episode.title}`,
        user: req.user,
        episodeId: episode.id,
        projectId: project.id,
        isLiked: isLiked,
        userRating: userRating,
        nav: {
            prev: prevEp ? prevEp.id : null,
            next: nextEp ? nextEp.id : null
        }
    });
});

app.get('/project/:id/manage', checkAuth, (req, res) => {
    const project = db.prepare('SELECT * FROM projects WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
    if (!project) return res.redirect('/dashboard');
    const episodes = db.prepare('SELECT * FROM episodes WHERE project_id = ? ORDER BY episode_number ASC').all(project.id);
    const assets = db.prepare('SELECT * FROM assets WHERE project_id = ?').all(project.id);
    res.render('project_manage', { project, episodes, assets });
});

app.post('/project/:id/toggle-publish', checkAuth, (req, res) => {
    const project = db.prepare('SELECT is_published FROM projects WHERE id=? AND user_id=?').get(req.params.id, req.user.id);
    db.prepare('UPDATE projects SET is_published = ? WHERE id = ?').run(project.is_published ? 0 : 1, req.params.id);
    res.redirect(`/project/${req.params.id}/manage`);
});

app.post('/project/:id/episode/create', checkAuth, (req, res) => {
    const defaultData = JSON.stringify({ scenes: { 'scene_start': { id: 'scene_start', name: 'Start', blocks: [] } }, activeSceneId: 'scene_start' });
    const stmt = db.prepare('INSERT INTO episodes (project_id, title, episode_number, draft_data) VALUES (?, ?, ?, ?)');
    stmt.run(req.params.id, req.body.title, req.body.episode_number, defaultData);
    res.redirect(`/project/${req.params.id}/manage`);
});

app.post('/api/episode/:id/publish', checkAuth, (req, res) => {
    const episode = db.prepare('SELECT * FROM episodes WHERE id = ?').get(req.params.id);
    const project = db.prepare('SELECT user_id FROM projects WHERE id = ?').get(episode.project_id);
    if (project.user_id !== req.user.id) return res.status(403).send("Unauthorized");
    db.prepare('UPDATE episodes SET published_data = draft_data, last_published_at = CURRENT_TIMESTAMP WHERE id = ?').run(req.params.id);
    res.json({ success: true, message: "Published!" });
});

app.get('/editor/:episodeId', checkAuth, (req, res) => {
    const episode = db.prepare('SELECT * FROM episodes WHERE id = ?').get(req.params.episodeId);
    if (!episode) return res.redirect('/dashboard');
    const project = db.prepare('SELECT * FROM projects WHERE id = ? AND user_id = ?').get(episode.project_id, req.user.id);
    if (!project) return res.redirect('/dashboard');
    const assets = db.prepare('SELECT * FROM assets WHERE project_id = ?').all(project.id);
    
    res.render('editor', { 
        projectJSON: episode.draft_data || null, 
        episodeId: episode.id,
        projectId: project.id,
        assetsJSON: JSON.stringify(assets || []) 
    });
});

app.post('/api/save/:episodeId', checkAuth, (req, res) => {
    const episode = db.prepare('SELECT project_id FROM episodes WHERE id = ?').get(req.params.episodeId);
    const project = db.prepare('SELECT user_id FROM projects WHERE id = ?').get(episode.project_id);
    if(project.user_id !== req.user.id) return res.status(403).send();

    const stmt = db.prepare('UPDATE episodes SET draft_data = ? WHERE id = ?');
    stmt.run(JSON.stringify(req.body), req.params.episodeId);
    res.json({ success: true });
});

app.post('/project/:id/upload', checkAuth, upload.single('file'), async (req, res) => {
    if (!req.file) return res.status(500).send("No file uploaded.");
    try {
        const result = await processFile(req.file);
        const localUrl = '/uploads/' + result.filename;
        let assetType = req.body.type;
        if (result.type === 'video') assetType = 'video';
        if (result.type === 'audio') assetType = 'audio';
        
        const name = req.body.name || req.file.originalname;
        const stmt = db.prepare('INSERT INTO assets (user_id, project_id, name, type, url) VALUES (?, ?, ?, ?, ?)');
        stmt.run(req.user.id, req.params.id, name, assetType, localUrl);

        fs.unlinkSync(req.file.path);
        res.redirect(`/project/${req.params.id}/manage`);
    } catch (err) {
        console.error("Processing failed:", err);
        if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
        res.status(500).send("Error processing file.");
    }
});


// --- USER PROFILE ROUTES ---
app.post('/api/user/update-profile', checkAuth, (req, res) => {
    const newName = req.body.display_name.trim();
    if (!newName) return res.redirect('/dashboard');

    // 1. Update the database
    db.prepare('UPDATE users SET display_name = ? WHERE id = ?').run(newName, req.user.id);
    
    // 2. Force the session to save the changes before redirecting
    req.session.save((err) => {
        if (err) console.error("Session save error:", err);
        res.redirect('/dashboard');
    });
});

const ensureLikedCollection = (userId) => {
    let col = db.prepare('SELECT id FROM collections WHERE user_id = ? AND is_system = 1').get(userId);
    if (!col) {
        const info = db.prepare('INSERT INTO collections (user_id, name, is_system) VALUES (?, ?, 1)').run(userId, 'Liked Series');
        return info.lastInsertRowid;
    }
    return col.id;
};

// Helper: Register View with 12h Cooldown
function registerView(projectId, req) {
    const userId = req.isAuthenticated() ? req.user.id : null;
    
    const viewerHash = crypto.createHash('sha256')
        .update(req.ip + req.get('User-Agent'))
        .digest('hex');

    const existing = db.prepare(`
        SELECT id FROM views
        WHERE project_id = ?
        AND (user_id = ? OR (user_id IS NULL AND viewer_hash = ?))
        AND created_at > datetime('now', '-12 hours')
    `).get(projectId, userId, viewerHash);

    if (!existing) {
        db.prepare(`
            INSERT INTO views (project_id, viewer_hash, user_id)
            VALUES (?, ?, ?)
        `).run(projectId, viewerHash, userId);
        // console.log(`[View] New view counted for Project ${projectId}`);
    } else {
        // console.log(`[View] Cooldown active for Project ${projectId} (No increment)`);
    }
}

// --- COLLECTION ROUTES ---

// 1. List All Collections
app.get('/collections', checkAuth, (req, res) => {
    ensureLikedCollection(req.user.id); // Create default if missing
    const collections = db.prepare('SELECT * FROM collections WHERE user_id = ? ORDER BY is_system DESC, created_at DESC').all(req.user.id);
    res.render('collections', { user: req.user, collections });
});

// 2. Create New Collection
app.post('/collections/create', checkAuth, (req, res) => {
    const name = req.body.name.trim();
    if(name) {
        db.prepare('INSERT INTO collections (user_id, name, is_system) VALUES (?, ?, 0)').run(req.user.id, name);
    }
    res.redirect('/collections');
});

// 3. Delete Collection (Custom ones only)
app.post('/collections/:id/delete', checkAuth, (req, res) => {
    db.prepare('DELETE FROM collections WHERE id = ? AND user_id = ? AND is_system = 0').run(req.params.id, req.user.id);
    res.redirect('/collections');
});

// 4. View Specific Collection
app.get('/collection/:id', checkAuth, (req, res) => {
    const collection = db.prepare('SELECT * FROM collections WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
    if(!collection) return res.redirect('/collections');

    // Fetch projects inside this collection
    const projects = db.prepare(`
        SELECT p.*, u.username, u.display_name 
        FROM collection_items ci
        JOIN projects p ON ci.project_id = p.id
        JOIN users u ON p.user_id = u.id
        WHERE ci.collection_id = ?
        ORDER BY ci.added_at DESC
    `).all(collection.id);

    res.render('collection_view', { user: req.user, collection, projects });
});

// --- LIKE ROUTES ---

// Toggle Like on an Episode
app.post('/api/like/episode/:id', checkAuth, (req, res) => {
    const episodeId = req.params.id;
    const userId = req.user.id;

    // 1. Get Project ID for this episode
    const episode = db.prepare('SELECT project_id FROM episodes WHERE id = ?').get(episodeId);
    if(!episode) return res.status(404).json({error: 'Episode not found'});

    const projectId = episode.project_id;

    // 2. Check if already liked
    const existing = db.prepare('SELECT 1 FROM likes WHERE user_id = ? AND episode_id = ?').get(userId, episodeId);

    if (existing) {
        // UNLIKE logic
        db.prepare('DELETE FROM likes WHERE user_id = ? AND episode_id = ?').run(userId, episodeId);
        
        // Check if user has ANY likes left in this series
        const remaining = db.prepare('SELECT 1 FROM likes WHERE user_id = ? AND project_id = ?').get(userId, projectId);
        
        // If no likes left in this series, remove from "Liked Series" collection
        if (!remaining) {
            const colId = ensureLikedCollection(userId);
            db.prepare('DELETE FROM collection_items WHERE collection_id = ? AND project_id = ?').run(colId, projectId);
        }
        
        res.json({ liked: false });
    } else {
        // LIKE logic
        db.prepare('INSERT INTO likes (user_id, project_id, episode_id) VALUES (?, ?, ?)').run(userId, projectId, episodeId);
        
        // Add to "Liked Series" collection (IGNORE keeps it if already there)
        const colId = ensureLikedCollection(userId);
        db.prepare('INSERT OR IGNORE INTO collection_items (collection_id, project_id) VALUES (?, ?)').run(colId, projectId);
        
        res.json({ liked: true });
    }
});

// --- RATING ROUTES ---

// Rate an Episode (1-5)
app.post('/api/rate/episode/:id', checkAuth, (req, res) => {
    const episodeId = req.params.id;
    const userId = req.user.id;
    const score = parseInt(req.body.score);

    if (!score || score < 1 || score > 5) {
        return res.status(400).json({ error: "Invalid score" });
    }

    // Get Project ID
    const episode = db.prepare('SELECT project_id FROM episodes WHERE id = ?').get(episodeId);
    if (!episode) return res.status(404).json({ error: "Episode not found" });

    // UPSERT Rating (Insert or Update if exists)
    db.prepare(`
        INSERT INTO ratings (user_id, project_id, episode_id, score) 
        VALUES (?, ?, ?, ?)
        ON CONFLICT(user_id, episode_id) DO UPDATE SET score = excluded.score
    `).run(userId, episode.project_id, episodeId, score);

    res.json({ success: true });
});

// --- EPISODE COMMENT ROUTES ---

// Get Comments for a specific Episode
app.get('/api/comments/episode/:id', (req, res) => {
    try {
        const comments = db.prepare(`
            SELECT c.*, u.display_name, u.username,
                   r.score as user_rating,
                   (SELECT 1 FROM likes l WHERE l.user_id = c.user_id AND l.episode_id = c.episode_id LIMIT 1) as user_liked
            FROM comments c
            JOIN users u ON c.user_id = u.id
            LEFT JOIN ratings r ON r.user_id = c.user_id AND r.episode_id = c.episode_id
            WHERE c.episode_id = ?
            ORDER BY c.created_at DESC
        `).all(req.params.id);
        res.json(comments);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Failed to fetch comments" });
    }
});

// Post a Comment to an Episode
app.post('/api/comments/episode/:id', checkAuth, (req, res) => {
    const text = req.body.text.trim();
    if (!text) return res.status(400).json({ error: "Comment cannot be empty" });

    try {
        const episode = db.prepare('SELECT project_id FROM episodes WHERE id = ?').get(req.params.id);
        if (!episode) return res.status(404).json({ error: "Episode not found" });

        db.prepare(`
            INSERT INTO comments (user_id, project_id, episode_id, text)
            VALUES (?, ?, ?, ?)
        `).run(req.user.id, episode.project_id, req.params.id, text);

        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Failed to post comment" });
    }
});

// --- SERIES COMMENT ROUTES ---

// Get Comments for the entire Series (Project-level)
app.get('/api/comments/series/:id', (req, res) => {
    try {
        const comments = db.prepare(`
            SELECT c.*, u.display_name, u.username,
                   (SELECT AVG(score) FROM ratings r WHERE r.user_id = c.user_id AND r.project_id = c.project_id) as user_avg_rating,
                   (SELECT 1 FROM likes l WHERE l.user_id = c.user_id AND l.project_id = c.project_id LIMIT 1) as has_liked
            FROM comments c
            JOIN users u ON c.user_id = u.id
            WHERE c.project_id = ? AND c.episode_id IS NULL
            ORDER BY c.created_at DESC
        `).all(req.params.id);
        res.json(comments);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Failed to fetch series comments" });
    }
});

// Post a Comment to the Series
app.post('/api/comments/series/:id', checkAuth, (req, res) => {
    const text = req.body.text.trim();
    if (!text) return res.status(400).json({ error: "Comment cannot be empty" });

    try {
        db.prepare(`
            INSERT INTO comments (user_id, project_id, episode_id, text)
            VALUES (?, ?, NULL, ?)
        `).run(req.user.id, req.params.id, text);

        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Failed to post series comment" });
    }
});

app.listen(process.env.PORT, () => console.log(`Server running on port ${process.env.PORT}`));