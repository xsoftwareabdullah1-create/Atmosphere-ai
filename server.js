import express from 'express';
import multer from 'multer';
import AdmZip from 'adm-zip';
import dotenv from 'dotenv';
import { Octokit } from '@octokit/rest';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 }
});

const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY;
const OPENROUTER_BASE = 'https://openrouter.ai/api/v1';
const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';

// ---------- FILE UPLOAD (with ZIP extraction) ----------
app.post('/api/upload', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file provided' });

  const isZip =
    req.file.mimetype === 'application/zip' ||
    req.file.mimetype === 'application/x-zip-compressed' ||
    req.file.originalname.toLowerCase().endsWith('.zip');

  try {
    if (isZip) {
      const zip = new AdmZip(req.file.buffer);
      const entries = zip.getEntries().filter(e => !e.isDirectory);
      const uploaded = [];

      for (const entry of entries.slice(0, 40)) {
        const buf = entry.getData();
        if (buf.length === 0) continue;
        if (buf.length > 20 * 1024 * 1024) continue;
        if (!isTextLike(entry.entryName)) continue;

        const fid = await uploadToOpenRouter(buf, entry.entryName, 'text/plain');
        if (fid) uploaded.push({ filename: entry.entryName, fileId: fid });
      }

      return res.json({
        zip: true,
        extracted: uploaded.length,
        files: uploaded
      });
    }

    const fid = await uploadToOpenRouter(req.file.buffer, req.file.originalname, req.file.mimetype);
    if (!fid) return res.status(500).json({ error: 'Upload failed' });
    return res.json({ file_id: fid, filename: req.file.originalname });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

async function uploadToOpenRouter(buffer, filename, mimetype) {
  const form = new FormData();
  const blob = new Blob([buffer], { type: mimetype || 'application/octet-stream' });
  form.append('file', blob, filename);

  const r = await fetch(`${OPENROUTER_BASE}/files`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${OPENROUTER_KEY}` },
    body: form
  });
  if (!r.ok) {
    console.error('OpenRouter upload failed:', await r.text());
    return null;
  }
  const data = await r.json();
  return data.id;
}

function isTextLike(name) {
  const ok = ['.js','.ts','.jsx','.tsx','.py','.java','.go','.rs','.c','.cpp','.h','.hpp',
    '.cs','.rb','.php','.swift','.kt','.scala','.sh','.bash','.sql','.html','.css','.scss',
    '.json','.yaml','.yml','.toml','.xml','.md','.txt','.csv','.env','.gitignore','.dockerfile'];
  const lower = name.toLowerCase();
  return ok.some(ext => lower.endsWith(ext)) || !lower.includes('.');
}

// ---------- CHAT (OpenRouter + shell tool) ----------
app.post('/api/chat', async (req, res) => {
  const { messages, file_ids = [], use_shell = true } = req.body;

  const formatted = messages.map((m, i) => {
    const isLastUser = m.role === 'user' && i === messages.length - 1;
    if (isLastUser && file_ids.length > 0) {
      const content = [{ type: 'text', text: m.content || 'See attached files.' }];
      file_ids.forEach(fid => content.push({ type: 'file', file: { file_id: fid } }));
      return { role: 'user', content };
    }
    return { role: m.role, content: m.content };
  });

  const tools = use_shell
    ? [{ type: 'openrouter:shell', parameters: { engine: 'openrouter' } }]
    : [];

  try {
    const response = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${OPENROUTER_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': BASE_URL,
        'X-Title': 'Atmosphere AI'
      },
      body: JSON.stringify({
        model: 'anthropic/claude-sonnet-4',
        messages: formatted,
        max_tokens: 4096,
        ...(tools.length ? { tools } : {})
      })
    });

    const data = await response.json();
    if (data.error) return res.status(500).json({ error: data.error.message });
    res.json({ content: data.choices?.[0]?.message?.content || 'No response' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------- GITHUB OAUTH ----------
app.get('/auth/github', (req, res) => {
  const redirectUri = `${BASE_URL}/auth/github/callback`;
  res.redirect(
    `https://github.com/login/oauth/authorize?client_id=${process.env.GITHUB_CLIENT_ID}` +
    `&redirect_uri=${redirectUri}&scope=repo`
  );
});

app.get('/auth/github/callback', async (req, res) => {
  const { code } = req.query;
  const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: process.env.GITHUB_CLIENT_ID,
      client_secret: process.env.GITHUB_CLIENT_SECRET,
      code
    })
  });
  const tokenData = await tokenRes.json();
  res.redirect(`/?github_token=${tokenData.access_token || ''}`);
});

// ---------- GITHUB READ/WRITE ----------
app.post('/api/github/read-file', async (req, res) => {
  const { owner, repo, path: filePath, token } = req.body;
  try {
    const octokit = new Octokit({ auth: token });
    const { data } = await octokit.repos.getContent({ owner, repo, path: filePath });
    const content = Buffer.from(data.content, 'base64').toString('utf-8');
    res.json({ content, sha: data.sha });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/github/write-file', async (req, res) => {
  const { owner, repo, path: filePath, content, message, sha, token } = req.body;
  try {
    const octokit = new Octokit({ auth: token });
    const { data } = await octokit.repos.createOrUpdateFileContents({
      owner, repo, path: filePath,
      message: message || 'Update from Atmosphere AI',
      content: Buffer.from(content).toString('base64'),
      ...(sha ? { sha } : {})
    });
    res.json({ success: true, commit: data.commit.sha });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------- START ----------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Atmosphere AI running on ${BASE_URL}`));
