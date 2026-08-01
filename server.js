const express = require('express');
const cors = require('cors');
const webpush = require('web-push');
const cron = require('node-cron');

const app = express();
app.use(express.json({ limit: '15mb' }));

// Lock this down to your GitHub Pages origin once deployed, e.g.:
// app.use(cors({ origin: 'https://18ventures.github.io' }));
app.use(cors());

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const POCKETBASE_URL = process.env.POCKETBASE_URL; // e.g. https://pocketbase-production-2a23.up.railway.app
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;

if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails('mailto:board-app@example.com', VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
}

async function getSubscriptions() {
  if (!POCKETBASE_URL) return [];
  try {
    const res = await fetch(`${POCKETBASE_URL}/api/collections/push_subscriptions/records?perPage=200`);
    const data = await res.json();
    return Array.isArray(data.items) ? data.items : [];
  } catch (e) {
    console.error('Failed to fetch subscriptions', e);
    return [];
  }
}

async function deleteSubscription(recordId) {
  if (!POCKETBASE_URL) return;
  try {
    await fetch(`${POCKETBASE_URL}/api/collections/push_subscriptions/records/${recordId}`, { method: 'DELETE' });
  } catch (e) {
    console.error('Failed to delete stale subscription', e);
  }
}

async function sendPushToAll(payload) {
  const subs = await getSubscriptions();
  for (const record of subs) {
    let subscription;
    try {
      subscription = typeof record.subscription === 'string' ? JSON.parse(record.subscription) : record.subscription;
    } catch (e) {
      continue;
    }
    try {
      await webpush.sendNotification(subscription, JSON.stringify(payload));
    } catch (err) {
      // 404/410 means the browser unsubscribed or the subscription expired — clean it up.
      if (err.statusCode === 404 || err.statusCode === 410) {
        await deleteSubscription(record.id);
      } else {
        console.error('Push send failed', err.statusCode, err.body);
      }
    }
  }
}

// 11pm daily check-in
cron.schedule('0 23 * * *', () => {
  sendPushToAll({
    title: 'Board — 11pm check-in',
    body: "Anything you've actually finished today that's still open on the board?"
  });
}, { timezone: 'Europe/London' });

// Weekly aspirations review — Sunday 6pm
cron.schedule('0 18 * * 0', () => {
  sendPushToAll({
    title: 'Board — weekly check-in',
    body: 'What do you want true by next Sunday? Worth a look at your Aspirations tab.'
  });
}, { timezone: 'Europe/London' });

app.get('/', (req, res) => {
  res.send('Board extraction backend is running.');
});

app.get('/test-push', async (req, res) => {
  await sendPushToAll({
    title: 'Board — test push',
    body: 'If you can see this, push notifications are working.'
  });
  res.send('Test push sent (check your device).');
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
