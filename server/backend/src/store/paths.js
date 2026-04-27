const path = require('path');

/** All persisted JSON lives under server/backend/data/ */
const DATA_DIR = path.join(__dirname, '../../data');

module.exports = { DATA_DIR };
