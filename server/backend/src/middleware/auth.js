const jwt = require('jsonwebtoken');
const db = require('../store/jsonDb');

const attachUser = (req, user, token) => {
  req.user = db.toPublicUser(user);
  req.userRecord = user;
  req.token = token || null;
};

const auth = async (req, res, next) => {
  try {
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'No token provided' });
    }

    const token = header.split(' ')[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    const user = await db.findUserById(decoded.id);
    if (!user || user.isActive === false) {
      return res.status(401).json({ error: 'Token invalid or user inactive' });
    }

    attachUser(req, user, token);
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Token expired' });
    }
    return res.status(401).json({ error: 'Token invalid' });
  }
};

/**
 * Valid JWT → same as `auth`. No / invalid Bearer → default extension user
 * (EXTENSION_DEFAULT_USER, default "moon") so the Chrome extension works without login.
 * Dashboard should keep sending JWT for auditing; anonymous callers get the default user.
 */
const authOrDefaultUser = async (req, res, next) => {
  const header = req.headers.authorization;
  if (header && header.startsWith('Bearer ')) {
    const token = header.split(' ')[1];
    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      const user = await db.findUserById(decoded.id);
      if (!user || user.isActive === false) {
        return res.status(401).json({ error: 'Token invalid or user inactive' });
      }
      attachUser(req, user, token);
      return next();
    } catch (err) {
      if (err.name === 'TokenExpiredError') {
        return res.status(401).json({ error: 'Token expired' });
      }
      return res.status(401).json({ error: 'Token invalid' });
    }
  }

  const defaultName = (process.env.EXTENSION_DEFAULT_USER || 'moon').trim();
  try {
    const user = await db.findUserByName(defaultName);
    if (!user || user.isActive === false) {
      return res.status(401).json({
        error: `Extension default user "${defaultName}" not found or inactive`
      });
    }
    attachUser(req, user, null);
    next();
  } catch (err) {
    console.error('[AUTH] authOrDefaultUser:', err);
    return res.status(500).json({ error: 'Authentication failed' });
  }
};

const adminOnly = (req, res, next) => {
  if (!req.user || !req.user.isAdmin) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
};

module.exports = { auth, authOrDefaultUser, adminOnly };
