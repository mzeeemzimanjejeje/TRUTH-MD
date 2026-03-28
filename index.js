// Auto-install dependencies before anything else loads
// Uses only built-in Node modules so it works even with no node_modules
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

if (!fs.existsSync(path.join(__dirname, 'node_modules', 'express'))) {
    console.log('📦 node_modules missing — running npm install...');
    try {
        execSync('npm install', { stdio: 'inherit', cwd: __dirname });
        console.log('✅ Dependencies installed successfully');
    } catch (err) {
        console.error('❌ npm install failed:', err.message);
        process.exit(1);
    }
}

const express = require('express');
const app = express();
__path = process.cwd()
const bodyParser = require("body-parser");
const PORT = process.env.PORT || 8000;
let code = require('./truthx'); 

require('events').EventEmitter.defaultMaxListeners = 500;

process.on('uncaughtException', (err) => {
    console.error('Uncaught Exception:', err.message);
});

process.on('unhandledRejection', (reason) => {
    console.error('Unhandled Rejection:', reason?.message || reason);
});

app.use('/code', code);
app.use('/pair', async (req, res, next) => {
    res.sendFile(__path + '/pair.html')
});
app.use('/', async (req, res, next) => {
    res.sendFile(__path + '/main.html')
});

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

app.listen(PORT, () => {
    console.log(`
Don't Forget To Give Star ‼️


Server running on http://localhost:` + PORT)
});

require('./telegram');

module.exports = app;
