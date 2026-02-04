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
    const stmt = db.prepare('INSERT OR REPLACE INTO users (id, username) VALUES (?, ?)');
    stmt.run(profile.id, profile.username);
    return done(null, profile);
}));

// --- 4. CONVERSION LOGIC ---
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

// --- 5. EXPRESS CONFIG ---
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

function checkAuth(req, res, next) {
    if (req.isAuthenticated()) return next();
    res.redirect('/login');
}

// --- 6. ROUTES ---

// Auth
app.get('/login', (req, res) => res.render('login'));
app.get('/auth/discord', passport.authenticate('discord'));
app.get('/auth/discord/callback', passport.authenticate('discord', { failureRedirect: '/login' }), 
    (req, res) => res.redirect('/dashboard'));
app.get('/logout', (req, res) => { req.logout(() => res.redirect('/')); });

// 1. LANDING PAGE
app.get('/', (req, res) => {
    const projects = db.prepare(`SELECT p.*, u.username FROM projects p JOIN users u ON p.user_id = u.id WHERE p.is_published = 1 ORDER BY p.created_at DESC`).all();
    res.render('landing', { projects, user: req.user });
});

// 2. PUBLIC SERIES PAGE
app.get('/series/:id', (req, res) => {
    const project = db.prepare('SELECT p.*, u.username FROM projects p JOIN users u ON p.user_id = u.id WHERE p.id = ?').get(req.params.id);
    if (!project || (!project.is_published && (!req.user || req.user.id !== project.user_id))) return res.status(404).send("Project not found or private.");
    const episodes = db.prepare('SELECT id, title, episode_number FROM episodes WHERE project_id = ? AND published_data IS NOT NULL ORDER BY episode_number ASC').all(project.id);
    res.render('series_public', { project, episodes, user: req.user });
});

// 3. PUBLIC PLAYER
app.get('/play/:episodeId', (req, res) => {
    const episode = db.prepare('SELECT * FROM episodes WHERE id = ?').get(req.params.episodeId);
    if (!episode || !episode.published_data) return res.status(404).send("Episode not found or not published.");
    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(episode.project_id);
    const assets = db.prepare('SELECT * FROM assets WHERE project_id = ?').all(project.id);
    res.render('player', {
        episodeJSON: episode.published_data,
        assetsJSON: JSON.stringify(assets),
        title: `${project.title} - ${episode.title}`
    });
});

// 4. DASHBOARD
app.get('/dashboard', checkAuth, (req, res) => {
    const projects = db.prepare('SELECT * FROM projects WHERE user_id = ? ORDER BY created_at DESC').all(req.user.id);
    res.render('dashboard', { user: req.user, projects });
});

app.post('/project/create', checkAuth, (req, res) => {
    const stmt = db.prepare('INSERT INTO projects (user_id, title, description) VALUES (?, ?, ?)');
    stmt.run(req.user.id, req.body.title, req.body.description || '');
    res.redirect('/dashboard');
});

// 5. PROJECT MANAGE (Combined Assets & Episodes)
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

// 6. EPISODE ACTIONS
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
    res.json({ success: true, message: "Episode Published!" });
});

// 7. EDITOR (EPISODE MODE)
// Note: We route based on Episode ID now, not Project ID
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

// SAVE (EPISODE DATA)
app.post('/api/save/:episodeId', checkAuth, (req, res) => {
    const episode = db.prepare('SELECT project_id FROM episodes WHERE id = ?').get(req.params.episodeId);
    if(!episode) return res.status(404).send();
    // Verify ownership
    const project = db.prepare('SELECT user_id FROM projects WHERE id = ?').get(episode.project_id);
    if(project.user_id !== req.user.id) return res.status(403).send();

    const stmt = db.prepare('UPDATE episodes SET draft_data = ? WHERE id = ?');
    stmt.run(JSON.stringify(req.body), req.params.episodeId);
    res.json({ success: true });
});

// 8. ASSET UPLOAD
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