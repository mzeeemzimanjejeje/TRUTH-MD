// ─── Auto-install dependencies ──────────────────────────────────────────────
// Runs BEFORE any external require() so it works even with no node_modules.
// Uses only built-in Node modules (child_process, fs, path).
(function autoInstall() {
    const { execSync } = require('child_process');
    const fs   = require('fs');
    const path = require('path');

    const dir = __dirname;
    const expressPath = path.join(dir, 'node_modules', 'express');

    if (!fs.existsSync(expressPath)) {
        console.log('📦 Installing dependencies — please wait...');

        // Try npm paths used by Pterodactyl containers and standard systems
        const npmCandidates = [
            '/usr/local/bin/npm',
            '/usr/bin/npm',
            'npm'
        ];

        let installed = false;
        for (const npm of npmCandidates) {
            try {
                execSync(`${npm} install`, { stdio: 'inherit', cwd: dir });
                installed = true;
                console.log('✅ Dependencies installed successfully');
                break;
            } catch (e) {
                // try next candidate
            }
        }

        if (!installed) {
            console.error('❌ Could not install dependencies. Run: npm install');
            process.exit(1);
        }
    }
})();
// ────────────────────────────────────────────────────────────────────────────

const express    = require('express');
const app        = express();
__path           = process.cwd();
const bodyParser = require('body-parser');
const PORT       = process.env.PORT || 8000;
let code         = require('./truthx');

require('events').EventEmitter.defaultMaxListeners = 500;

process.on('uncaughtException', (err) => {
    console.error('Uncaught Exception:', err.message);
});

process.on('unhandledRejection', (reason) => {
    console.error('Unhandled Rejection:', reason?.message || reason);
});

app.use('/code', code);
app.use('/pair', async (req, res, next) => {
    res.sendFile(__path + '/pair.html');
});
app.use('/', async (req, res, next) => {
    res.sendFile(__path + '/main.html');
});

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

app.listen(PORT, () => {
    console.log(`
Don't Forget To Give Star ‼️


Server running on http://localhost:` + PORT);
});

require('./telegram');

module.exports = app;
