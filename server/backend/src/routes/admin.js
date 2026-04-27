const express = require('express');
const { body, validationResult } = require('express-validator');
const db = require('../store/jsonDb');
const { auth, adminOnly } = require('../middleware/auth');

const router = express.Router();

router.use(auth, adminOnly);

router.get('/stats', async (req, res) => {
  try {
    const users = await db.getUsers();
    const resumes = await db.getResumes();
    const chats = await db.getChats();

    const usersTotal = users.length;
    const usersActive = users.filter(u => u.isActive !== false).length;
    const admins = users.filter(u => u.isAdmin).length;
    const resumesTotal = resumes.length;
    const interviewsTotal = chats.length;

    const recentUsers = [...users]
      .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))
      .slice(0, 5)
      .map(u => ({
        _id: u._id,
        name: u.name,
        email: u.email,
        isAdmin: !!u.isAdmin,
        isActive: u.isActive !== false,
        createdAt: u.createdAt
      }));

    const recentInterviews = [...chats]
      .sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt))
      .slice(0, 5)
      .map(c => ({
        _id: c._id,
        title: c.title,
        startedAt: c.startedAt,
        userId: { name: (users.find(u => u._id === c.userId) || {}).name }
      }));

    res.json({
      usersTotal,
      usersActive,
      admins,
      resumesTotal,
      interviewsTotal,
      recentUsers,
      recentInterviews
    });
  } catch (err) {
    console.error('[ADMIN] stats error:', err);
    res.status(500).json({ error: 'Failed to load stats' });
  }
});

router.get('/users', async (req, res) => {
  try {
    const users = await db.getUsers();
    res.json(users.map(u => db.toPublicUser(u)));
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

router.post(
  '/users',
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

router.patch('/users/:id', async (req, res) => {
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

router.post(
  '/users/:id/reset-password',
  [body('password').isLength({ min: 6 }).withMessage('Password must be at least 6 characters')],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });

    try {
      const user = await db.updateUserById(req.params.id, { password: req.body.password });
      if (!user) return res.status(404).json({ error: 'User not found' });
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: 'Failed to reset password' });
    }
  }
);

router.delete('/users/:id', async (req, res) => {
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

async function shapeAdminInterviewListItem(s) {
  const { transcripts: _t, ...rest } = s;
  return {
    ...rest,
    userId: await db.userMini(s.userId),
    resumeId: await db.resumeMini(s.resumeId)
  };
}

router.get('/interviews', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(50, parseInt(req.query.limit, 10) || 20);
    const skip = (page - 1) * limit;

    let all = await db.getChats();
    if (req.query.userId && db.isValidId(req.query.userId)) {
      all = all.filter(c => c.userId === req.query.userId);
    }
    all.sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt));
    const total = all.length;
    const slice = all.slice(skip, skip + limit);
    const sessions = await Promise.all(slice.map(shapeAdminInterviewListItem));

    res.json({ sessions, total, page, pages: Math.ceil(total / limit) || 1 });
  } catch (err) {
    console.error('[ADMIN] interviews list:', err);
    res.status(500).json({ error: 'Failed to fetch interviews' });
  }
});

router.get('/interviews/:id', async (req, res) => {
  try {
    if (!db.isValidId(req.params.id)) {
      return res.status(400).json({ error: 'Invalid id' });
    }
    const session = await db.findChatByIdAdmin(req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    res.json({
      ...session,
      userId: await db.userMini(session.userId),
      resumeId: (await db.resumeMini(session.resumeId)) || session.resumeId
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch session' });
  }
});

router.delete('/interviews/:id', async (req, res) => {
  try {
    const ok = await db.deleteChatAdmin(req.params.id);
    if (!ok) return res.status(404).json({ error: 'Session not found' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete session' });
  }
});

router.get('/resumes', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(50, parseInt(req.query.limit, 10) || 20);
    const skip = (page - 1) * limit;

    let all = await db.getResumes();
    if (req.query.userId && db.isValidId(req.query.userId)) {
      all = all.filter(r => r.userId === req.query.userId);
    }
    all.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
    const total = all.length;
    const slice = all.slice(skip, skip + limit);
    const resumes = await Promise.all(
      slice.map(async r => ({
        ...r,
        userId: await db.userMini(r.userId)
      }))
    );

    res.json({ resumes, total, page, pages: Math.ceil(total / limit) || 1 });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch resumes' });
  }
});

router.get('/resumes/:id', async (req, res) => {
  try {
    if (!db.isValidId(req.params.id)) {
      return res.status(400).json({ error: 'Invalid id' });
    }
    const resume = await db.findResume(req.params.id, null);
    if (!resume) return res.status(404).json({ error: 'Resume not found' });
    res.json({
      ...resume,
      userId: await db.userMini(resume.userId)
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch resume' });
  }
});

router.delete('/resumes/:id', async (req, res) => {
  try {
    const ok = await db.deleteResumeAdmin(req.params.id);
    if (!ok) return res.status(404).json({ error: 'Resume not found' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete resume' });
  }
});

module.exports = router;
