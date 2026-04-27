const express = require('express');
const db = require('../store/jsonDb');
const { authOrDefaultUser } = require('../middleware/auth');

const router = express.Router();

async function shapeSessionListItem(s) {
  const { transcripts: _t, ...rest } = s;
  return {
    ...rest,
    resumeId: await db.resumeMini(s.resumeId)
  };
}

async function shapeSessionDetail(s) {
  const resumeId = await db.resumeMini(s.resumeId);
  return { ...s, resumeId: resumeId || s.resumeId };
}

router.post('/', authOrDefaultUser, async (req, res) => {
  try {
    const {
      interviewId, transcripts, resumeId,
      jobDescription, additionalInfo, startedAt, title
    } = req.body;

    if (!interviewId) {
      return res.status(400).json({ error: 'interviewId is required' });
    }

    const started = startedAt
      ? (typeof startedAt === 'number' ? new Date(startedAt).toISOString() : startedAt)
      : new Date().toISOString();

    const doc = await db.upsertChat({
      userId: req.user._id,
      interviewId,
      data: {
        title: title || 'Interview',
        resumeId: resumeId || null,
        jobDescription: jobDescription || '',
        additionalInfo: additionalInfo || '',
        transcripts: transcripts || { interviewer: [], user: [], all: [] },
        startedAt: started
      }
    });

    res.json({ success: true, _id: doc._id });
  } catch (err) {
    console.error('[CHATHISTORY] Save error:', err);
    res.status(500).json({ error: 'Failed to save chat history' });
  }
});

router.get('/', authOrDefaultUser, async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(50, parseInt(req.query.limit, 10) || 20);
    const skip = (page - 1) * limit;

    const all = await db.findChatsByUser(req.user._id);
    const total = all.length;
    const slice = all.slice(skip, skip + limit);
    const sessions = await Promise.all(slice.map(shapeSessionListItem));

    res.json({ sessions, total, page, pages: Math.ceil(total / limit) || 1 });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch chat history' });
  }
});

router.get('/stats/summary', authOrDefaultUser, async (req, res) => {
  try {
    const all = await db.findChatsByUser(req.user._id);
    const total = all.length;
    const last = all[0] || null;
    const lastSession = last
      ? { title: last.title, startedAt: last.startedAt }
      : null;
    res.json({ total, lastSession });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

router.get('/:id', authOrDefaultUser, async (req, res) => {
  try {
    const session = await db.findChatById(req.params.id, req.user._id);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    res.json(await shapeSessionDetail(session));
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch session' });
  }
});

router.delete('/:id', authOrDefaultUser, async (req, res) => {
  try {
    const ok = await db.deleteChat(req.params.id, req.user._id);
    if (!ok) return res.status(404).json({ error: 'Session not found' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete session' });
  }
});

module.exports = router;
