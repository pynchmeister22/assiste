const express = require('express');
const multer = require('multer');
const { body, validationResult } = require('express-validator');
const pdfParse = require('pdf-parse');
const db = require('../store/jsonDb');
const { authOrDefaultUser } = require('../middleware/auth');
const { parseResumeWithOpenAI } = require('../services/openaiResumeParse');

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 6 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok =
      file.mimetype === 'application/pdf' ||
      file.mimetype === 'application/x-pdf' ||
      /\.pdf$/i.test(file.originalname || '');
    if (ok) return cb(null, true);
    cb(new Error('Only PDF files are allowed'));
  }
});

function uploadPdfSingle(req, res, next) {
  upload.single('pdf')(req, res, err => {
    if (!err) return next();
    if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ error: 'PDF must be 6MB or smaller' });
    }
    return res.status(400).json({ error: err.message || 'Upload failed' });
  });
}

router.post('/parse-pdf', authOrDefaultUser, uploadPdfSingle, async (req, res) => {
  try {
    if (!req.file?.buffer) {
      return res.status(400).json({ error: 'Missing PDF file (field name must be: pdf)' });
    }
    const pdfData = await pdfParse(req.file.buffer);
    const text = (pdfData && pdfData.text) || '';
    if (!text.trim()) {
      return res.status(422).json({
        error:
          'No text could be extracted from this PDF. It may be a scanned image — use a text-based PDF.'
      });
    }

    // Try OpenAI first; fall back gracefully if key is missing
    if (!process.env.OPENAI_API_KEY) {
      return res.status(503).json({
        error: 'OPENAI_API_KEY is not set on the server. Add it to server/backend/.env or the project root .env.'
      });
    }

    const parsed = await parseResumeWithOpenAI(text, {
      filename: req.file.originalname,
      apiKey: process.env.OPENAI_API_KEY
    });
    res.json(parsed);
  } catch (err) {
    console.error('[RESUMES] parse-pdf:', err);
    const msg = err.message || 'Failed to parse PDF';
    res.status(500).json({ error: msg.length < 300 ? msg : 'Failed to parse PDF with OpenAI' });
  }
});

router.get('/', authOrDefaultUser, async (req, res) => {
  try {
    const resumes = await db.findResumesByUserId(req.user._id);
    res.json(resumes);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch resumes' });
  }
});

router.get('/:id', authOrDefaultUser, async (req, res) => {
  try {
    const resume = await db.findResume(req.params.id, req.user._id);
    if (!resume) return res.status(404).json({ error: 'Resume not found' });
    res.json(resume);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch resume' });
  }
});

router.post(
  '/',
  authOrDefaultUser,
  [body('title').trim().notEmpty().withMessage('Title is required')],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });

    try {
      const {
        title, name, email, phone,
        personal_info, experience, education, skillset, rawText
      } = req.body;

      const resume = await db.createResume({
        userId: req.user._id,
        title, name, email, phone,
        personal_info, experience, education, skillset, rawText
      });

      res.status(201).json(resume);
    } catch (err) {
      console.error('[RESUMES] Create error:', err);
      res.status(500).json({ error: 'Failed to create resume' });
    }
  }
);

router.put('/:id', authOrDefaultUser, async (req, res) => {
  try {
    const fields = ['title', 'name', 'email', 'phone', 'personal_info', 'experience', 'education', 'skillset', 'rawText'];
    const patch = {};
    fields.forEach(f => {
      if (req.body[f] !== undefined) patch[f] = req.body[f];
    });
    const resume = await db.updateResumeById(req.params.id, req.user._id, patch);
    if (!resume) return res.status(404).json({ error: 'Resume not found' });
    res.json(resume);
  } catch (err) {
    res.status(500).json({ error: 'Failed to update resume' });
  }
});

router.delete('/:id', authOrDefaultUser, async (req, res) => {
  try {
    const ok = await db.deleteResume(req.params.id, req.user._id);
    if (!ok) return res.status(404).json({ error: 'Resume not found' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete resume' });
  }
});

module.exports = router;
