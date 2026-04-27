const express = require('express');
const { body, validationResult } = require('express-validator');
const db = require('../store/jsonDb');
const { auth, authOrDefaultUser, adminOnly } = require('../middleware/auth');

const router = express.Router();

router.get('/api-keys', authOrDefaultUser, async (req, res) => {
  try {
    const u = await db.findUserById(req.user._id);
    res.json({ openaiApiKey: u?.openaiApiKey || null });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch API keys' });
  }
});

router.get('/', auth, adminOnly, async (req, res) => {
  try {
    const users = await db.getUsers();
    res.json(users.map(u => db.toPublicUser(u)));
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

router.post(
  '/',
  auth,
  adminOnly,
  [
    body('name').trim().notEmpty().isLength({ min: 2, max: 50 }),
    body('password').isLength({ min: 6 }),
    body('email').optional().isEmail().normalizeEmail(),
    body('isAdmin').optional().isBoolean()
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });

    try {
      const { name, password, email, isAdmin, openaiApiKey } = req.body;
      const user = await db.createUser({
        name,
        password,
        email,
        isAdmin: !!isAdmin,
        openaiApiKey
      });
      res.status(201).json(db.toPublicUser(user));
    } catch (err) {
      if (err.message === 'DUPLICATE') return res.status(409).json({ error: 'Username already taken' });
      res.status(500).json({ error: 'Failed to create user' });
    }
  }
);

router.patch('/:id', auth, adminOnly, async (req, res) => {
  try {
    const { email, isAdmin, isActive, openaiApiKey } = req.body;
    const patch = {};
    if (email !== undefined) patch.email = email;
    if (isAdmin !== undefined) patch.isAdmin = isAdmin;
    if (isActive !== undefined) patch.isActive = isActive;
    if (openaiApiKey !== undefined) patch.openaiApiKey = openaiApiKey;

    const user = await db.updateUserById(req.params.id, patch);
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json(db.toPublicUser(user));
  } catch (err) {
    res.status(500).json({ error: 'Failed to update user' });
  }
});

router.delete('/:id', auth, adminOnly, async (req, res) => {
  try {
    if (req.params.id === String(req.user._id)) {
      return res.status(400).json({ error: 'Cannot deactivate your own account' });
    }
    await db.updateUserById(req.params.id, { isActive: false });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to deactivate user' });
  }
});

module.exports = router;
