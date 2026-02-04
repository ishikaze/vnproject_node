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
passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((obj, done) => done(null, obj));

passport.use(new DiscordStrategy({
    clientID: process.env.DISCORD_CLIENT_ID,
    clientSecret: process.env.DISCORD_CLIENT_SECRET,
    callbackURL: process.env.DISCORD_CALLBACK_URL,
    scope: ['identify']
}, (accessToken, refreshToken, profile, done) => {
    
    // Check Admin Status based on .env
    const isAdmin = ADMIN_IDS.includes(profile.id) ? 1 : 0;

    // Upsert User
    const stmt = db.prepare(`
        INSERT INTO users (id, username, is_admin) 
        VALUES (@id, @username, @is_admin)
        ON CONFLICT(id) DO UPDATE SET 
        username=@username, 
        is_admin=@is_admin
    `);
    
    stmt.run({
        id: profile.id, 
        username: profile.username,
        is_admin: isAdmin
    });

    // Retrieve full user object (including is_banned)
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
    const projects = db.prepare("SELECT p.*, u.username FROM projects p JOIN users u ON p.user_id = u.id ORDER BY p.created_at DESC").all();
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
    const projects = db.prepare(`SELECT p.*, u.username FROM projects p JOIN users u ON p.user_id = u.id WHERE p.is_published = 1 ORDER BY p.created_at DESC`).all();
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
    const project = db.prepare('SELECT p.*, u.username FROM projects p JOIN users u ON p.user_id = u.id WHERE p.id = ?').get(req.params.id);
    if (!project || (!project.is_published && (!req.user || req.user.id !== project.user_id))) return res.status(404).send("Project not found.");
    const episodes = db.prepare('SELECT id, title, episode_number FROM episodes WHERE project_id = ? AND published_data IS NOT NULL ORDER BY episode_number ASC').all(project.id);
    res.render('series_public', { project, episodes, user: req.user });
});

app.get('/play/:episodeId', (req, res) => {
    const episode = db.prepare('SELECT * FROM episodes WHERE id = ?').get(req.params.episodeId);
    if (!episode || !episode.published_data) return res.status(404).send("Episode not found.");
    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(episode.project_id);
    const assets = db.prepare('SELECT * FROM assets WHERE project_id = ?').all(project.id);

    res.render('player', {
        episodeJSON: episode.published_data,
        assetsJSON: JSON.stringify(assets),
        title: `${project.title} - ${episode.title}`,
        projectId: project.id
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

app.listen(process.env.PORT, () => console.log(`Server running on port ${process.env.PORT}`));