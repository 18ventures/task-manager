const express = require('express');
const cors = require('cors');

const app = express();
app.use(express.json({ limit: '15mb' }));

// Lock this down to your GitHub Pages origin once deployed, e.g.:
// app.use(cors({ origin: 'https://18ventures.github.io' }));
app.use(cors());

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

app.get('/', (req, res) => {
  res.send('Board extraction backend is running.');
});

app.post('/extract-tasks', async (req, res) => {
  try {
    const { image, mediaType } = req.body;
    if (!image) {
      return res.status(400).json({ error: 'Missing image' });
    }
    if (!ANTHROPIC_API_KEY) {
      return res.status(500).json({ error: 'Server missing ANTHROPIC_API_KEY' });
    }

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1000,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mediaType || 'image/jpeg', data: image } },
            {
              type: 'text',
              text: "This is a photo of a handwritten whiteboard or notes. Transcribe only the distinct to-do items / tasks written on it. Ignore doodles, dates, decorations, and anything that isn't an actionable task. Respond with ONLY a JSON array of short strings, one per task, no markdown fences, no other text. If nothing looks like a task, respond with []."
            }
          ]
        }]
      })
    });

    const data = await response.json();
    const textBlock = (data.content || []).find(b => b.type === 'text');
    let tasks = [];

    if (textBlock) {
      const cleaned = textBlock.text.trim()
        .replace(/^```json/i, '')
        .replace(/^```/, '')
        .replace(/```$/, '')
        .trim();
      try {
        const parsed = JSON.parse(cleaned);
        if (Array.isArray(parsed)) {
          tasks = parsed.filter(x => typeof x === 'string' && x.trim().length > 0);
        }
      } catch (e) {
        tasks = [];
      }
    }

    res.json({ tasks });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Extraction failed' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Board backend listening on ${PORT}`));
