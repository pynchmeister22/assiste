const express = require('express');
const jwt = require('jsonwebtoken');
const db = require('../store/jsonDb');
const { authOrDefaultUser } = require('../middleware/auth');
const { USERNAME, PASSWORD } = require('../config/staticAuth');

const router = express.Router();

const signToken = (userId) =>
  jwt.sign({ id: userId }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '7d'
  });

router.post('/login', async (req, res) => {
  try {
    const name = (req.body?.name || '').trim();
    const password = req.body?.password || '';

    if (name !== USERNAME || password !== PASSWORD) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    await db.getUsers();
    let user = await db.findUserByName(USERNAME);
    if (!user) {
      return res.status(500).json({ error: 'Default user missing' });
    }
    if (user.isActive === false) {
      await db.updateUserById(user._id, { isActive: true });
      user = await db.findUserByName(USERNAME);
    }

    const token = signToken(user._id);
    res.json({ token, user: db.toPublicUser(user) });
  } catch (err) {
    console.error('[AUTH] Login error:', err);
    res.status(500).json({ error: 'Login failed' });
  }
});

router.get('/user', authOrDefaultUser, async (req, res) => {
  res.json(req.user);
});

module.exports = router;
