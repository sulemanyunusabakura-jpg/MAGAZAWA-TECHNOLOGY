const express = require('express');
const { Pool } = require('pg');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

// 1. INITIALIZE EXPRESS & HTTP SERVER
const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = process.env.PORT || 10000;

// 2. CONFIGURE VIEWS ENGINE & MIDDLEWARE
app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'ejs');

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

app.use(session({
    secret: 'magazawa_secret_key_2026',
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false }
}));

// Ensure uploads folder exists
if (!fs.existsSync('./uploads')) {
    fs.mkdirSync('./uploads');
}

// Multer storage for lecture files
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, 'uploads/'),
    filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname)
});
const upload = multer({ storage });

// 3. DATABASE SETUP WITH SAFE FALLBACK
let isPgConnected = false;
let pool = null;

// Temporary in-memory database for local testing if PG isn't connected
const localMemoryDB = {
    users: [],
    courses: [],
    lecture_notes: []
};

if (process.env.DATABASE_URL) {
    pool = new Pool({
        connectionString: process.env.DATABASE_URL,
        ssl: { rejectUnauthorized: false }
    });

    pool.on('error', (err) => {
        console.error('⚠️ PostgreSQL background error:', err.message);
    });
}

async function initDB() {
    if (!pool) {
        console.log('💡 No DATABASE_URL found. Running in Local Memory Mode.');
        setupLocalAdmin();
        return;
    }

    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS users (
                id SERIAL PRIMARY KEY,
                name VARCHAR(100),
                email VARCHAR(100) UNIQUE NOT NULL,
                password VARCHAR(255) NOT NULL,
                role VARCHAR(20) NOT NULL,
                approved BOOLEAN DEFAULT FALSE
            );
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS courses (
                id SERIAL PRIMARY KEY,
                course_name VARCHAR(100) NOT NULL,
                lecturer_id INT REFERENCES users(id) ON DELETE CASCADE
            );
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS lecture_notes (
                id SERIAL PRIMARY KEY,
                title VARCHAR(150) NOT NULL,
                file_path VARCHAR(255) NOT NULL,
                uploaded_by INT REFERENCES users(id) ON DELETE CASCADE,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        // Seed Default Admin Account
        const adminEmail = 'admin@portal.com';
        const adminCheck = await pool.query('SELECT * FROM users WHERE email = $1', [adminEmail]);
        if (adminCheck.rows.length === 0) {
            const hashedPassword = await bcrypt.hash('suleexpert', 10);
            await pool.query(
                'INSERT INTO users (name, email, password, role, approved) VALUES ($1, $2, $3, $4, $5)',
                ['System Admin', adminEmail, hashedPassword, 'admin', true]
            );
        }

        isPgConnected = true;
        console.log('✅ PostgreSQL connected and tables initialized successfully.');
    } catch (err) {
        console.log('⚠️ PostgreSQL connection failed. Falling back to Local Memory Mode.');
        setupLocalAdmin();
    }
}

async function setupLocalAdmin() {
    const adminEmail = 'admin@portal.com';
    const exists = localMemoryDB.users.find(u => u.email === adminEmail);
    if (!exists) {
        const hashedPassword = await bcrypt.hash('suleexpert', 10);
        localMemoryDB.users.push({
            id: 1,
            name: 'System Admin',
            email: adminEmail,
            password: hashedPassword,
            role: 'admin',
            approved: true
        });
    }
}

// Execute database initialization non-blockingly
initDB();

// 4. AUTHENTICATION MIDDLEWARE
function isAuthenticated(req, res, next) {
    if (req.session.user) return next();
    res.redirect('/login');
}

function hasRole(...roles) {
    return (req, res, next) => {
        if (req.session.user && roles.includes(req.session.user.role)) {
            return next();
        }
        res.status(403).send('Access Denied: Unauthorized Role');
    };
}

// 5. ROUTES

// Landing / Apply Page
app.get('/', (req, res) => res.render('apply'));
app.get('/apply', (req, res) => res.render('apply'));

app.post('/apply', async (req, res) => {
    const { name, email, password, role } = req.body;
    try {
        const hashedPassword = await bcrypt.hash(password, 10);
        const approved = role === 'student';

        if (isPgConnected && pool) {
            await pool.query(
                'INSERT INTO users (name, email, password, role, approved) VALUES ($1, $2, $3, $4, $5)',
                [name, email, hashedPassword, role, approved]
            );
        } else {
            localMemoryDB.users.push({
                id: localMemoryDB.users.length + 1,
                name,
                email,
                password: hashedPassword,
                role,
                approved
            });
        }
        res.send('<h2>Application submitted successfully! <a href="/login">Click here to Login</a></h2>');
    } catch (err) {
        console.error(err);
        res.status(500).send('Error creating user or email already exists.');
    }
});

// Login Pages
app.get('/login', (req, res) => res.render('login'));

app.post('/login', async (req, res) => {
    const { email, password } = req.body;
    try {
        let user = null;

        if (isPgConnected && pool) {
            const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
            if (result.rows.length > 0) user = result.rows[0];
        } else {
            user = localMemoryDB.users.find(u => u.email === email);
        }

        if (!user) return res.send('Invalid email or password.');

        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) return res.send('Invalid email or password.');
        if (!user.approved) return res.send('Your account is awaiting Admin approval.');

        req.session.user = user;

        if (user.role === 'admin') return res.redirect('/admin-dash');
        if (user.role === 'lecturer') return res.redirect('/lecturer-dash');
        return res.redirect('/student-dash');
    } catch (err) {
        console.error(err);
        res.status(500).send('Server Error during login.');
    }
});

// Dashboards
app.get('/admin-dash', isAuthenticated, hasRole('admin'), async (req, res) => {
    let pendingUsers = [];
    let lecturers = [];
    let courses = [];

    if (isPgConnected && pool) {
        const pendingRes = await pool.query('SELECT * FROM users WHERE approved = false');
        const lecturerRes = await pool.query("SELECT * FROM users WHERE role = 'lecturer' AND approved = true");
        const courseRes = await pool.query('SELECT courses.id, courses.course_name, users.name as lecturer_name FROM courses LEFT JOIN users ON courses.lecturer_id = users.id');
        pendingUsers = pendingRes.rows;
        lecturers = lecturerRes.rows;
        courses = courseRes.rows;
    } else {
        pendingUsers = localMemoryDB.users.filter(u => !u.approved);
        lecturers = localMemoryDB.users.filter(u => u.role === 'lecturer' && u.approved);
        courses = localMemoryDB.courses.map(c => {
            const l = localMemoryDB.users.find(u => u.id === c.lecturer_id);
            return { id: c.id, course_name: c.course_name, lecturer_name: l ? l.name : 'Unassigned' };
        });
    }

    res.render('admin-dash', { 
        user: req.session.user, 
        pendingUsers,
        lecturers,
        courses
    });
});

app.get('/lecturer-dash', isAuthenticated, hasRole('lecturer'), async (req, res) => {
    let notes = [];
    if (isPgConnected && pool) {
        const result = await pool.query('SELECT * FROM lecture_notes WHERE uploaded_by = $1', [req.session.user.id]);
        notes = result.rows;
    } else {
        notes = localMemoryDB.lecture_notes.filter(n => n.uploaded_by === req.session.user.id);
    }
    res.render('lecturer-dash', { user: req.session.user, notes });
});

app.get('/student-dash', isAuthenticated, hasRole('student'), async (req, res) => {
    let notes = [];
    if (isPgConnected && pool) {
        const result = await pool.query('SELECT lecture_notes.*, users.name as lecturer_name FROM lecture_notes JOIN users ON lecture_notes.uploaded_by = users.id');
        notes = result.rows;
    } else {
        notes = localMemoryDB.lecture_notes.map(n => {
            const l = localMemoryDB.users.find(u => u.id === n.uploaded_by);
            return { ...n, lecturer_name: l ? l.name : 'Lecturer' };
        });
    }
    res.render('student-dash', { user: req.session.user, notes });
});

// Admin Actions
app.post('/admin/approve/:id', isAuthenticated, hasRole('admin'), async (req, res) => {
    const targetId = parseInt(req.params.id);
    if (isPgConnected && pool) {
        await pool.query('UPDATE users SET approved = true WHERE id = $1', [targetId]);
    } else {
        const u = localMemoryDB.users.find(user => user.id === targetId);
        if (u) u.approved = true;
    }
    res.redirect('/admin-dash');
});

app.post('/admin/assign-course', isAuthenticated, hasRole('admin'), async (req, res) => {
    const { course_name, lecturer_id } = req.body;
    if (isPgConnected && pool) {
        await pool.query('INSERT INTO courses (course_name, lecturer_id) VALUES ($1, $2)', [course_name, lecturer_id]);
    } else {
        localMemoryDB.courses.push({
            id: localMemoryDB.courses.length + 1,
            course_name,
            lecturer_id: parseInt(lecturer_id)
        });
    }
    res.redirect('/admin-dash');
});

// Lecture Upload Action
app.post('/upload-note', isAuthenticated, hasRole('lecturer'), upload.single('note_file'), async (req, res) => {
    const { title } = req.body;
    const filePath = req.file ? '/uploads/' + req.file.filename : '';
    
    if (isPgConnected && pool) {
        await pool.query('INSERT INTO lecture_notes (title, file_path, uploaded_by) VALUES ($1, $2, $3)', [title, filePath, req.session.user.id]);
    } else {
        localMemoryDB.lecture_notes.push({
            id: localMemoryDB.lecture_notes.length + 1,
            title,
            file_path: filePath,
            uploaded_by: req.session.user.id,
            created_at: new Date()
        });
    }
    res.redirect('/lecturer-dash');
});

// Voice / Classroom Room Route
app.get('/classroom', isAuthenticated, (req, res) => {
    res.render('lecture-room', { user: req.session.user });
});

// Logout
app.get('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/login');
});

// 6. REAL-TIME SOCKET.IO
io.on('connection', (socket) => {
    socket.on('join-room', (roomId) => {
        socket.join(roomId);
    });

    socket.on('voice-stream', (data) => {
        socket.broadcast.emit('audio-blob', data);
    });

    socket.on('chat-message', (data) => {
        io.emit('receive-message', data);
    });
});

// 7. START SERVER
server.listen(PORT, () => {
    console.log(`🚀 Magazawa LMS running on port http://localhost:${PORT}`);
});
