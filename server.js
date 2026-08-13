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
  const results = { found: subs.length, sent: 0, failed: [], cleaned: 0 };
  for (const record of subs) {
    let subscription;
    try {
      subscription = typeof record.subscription === 'string' ? JSON.parse(record.subscription) : record.subscription;
    } catch (e) {
      results.failed.push({ id: record.id, error: 'Could not parse stored subscription JSON' });
      continue;
    }
    try {
      await webpush.sendNotification(subscription, JSON.stringify(payload));
      results.sent++;
    } catch (err) {
      if (err.statusCode === 404 || err.statusCode === 410) {
        await deleteSubscription(record.id);
        results.cleaned++;
      } else {
        console.error('Push send failed', err.statusCode, err.body);
        results.failed.push({ id: record.id, statusCode: err.statusCode || null, error: err.body || err.message });
      }
    }
  }
  return results;
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

// Deadline warnings — 2 hours before a 7h task is overdue, 2 days before a 7d task is overdue
const TWO_HOURS_MS = 2 * 60 * 60 * 1000;
const TWO_DAYS_MS = 2 * 24 * 60 * 60 * 1000;

async function checkDeadlineWarnings(){
  if (!POCKETBASE_URL) return { error: 'POCKETBASE_URL not set' };
  const result = { checked: 0, warned: [] };
  try{
    const filter = encodeURIComponent('done=false && warningSent=false && (duration="7h" || duration="7d")');
    const res = await fetch(`${POCKETBASE_URL}/api/collections/task_manager/records?perPage=200&filter=${filter}`);
    const data = await res.json();
    const items = Array.isArray(data.items) ? data.items : [];
    result.checked = items.length;
    const now = Date.now();

    for (const t of items) {
      if (!t.dueAt) continue;
      const remainMs = new Date(t.dueAt).getTime() - now;
      const thresholdMs = t.duration === '7h' ? TWO_HOURS_MS : TWO_DAYS_MS;
      const label = t.duration === '7h' ? '2 hours' : '2 days';

      if (remainMs > 0 && remainMs <= thresholdMs) {
        await sendPushToAll({
          title: 'Board — almost overdue',
          body: `"${t.text}" is ${label} from overdue.`
        });
        result.warned.push({ id: t.id, text: t.text, duration: t.duration });
        try {
          await fetch(`${POCKETBASE_URL}/api/collections/task_manager/records/${t.id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ warningSent: true })
          });
        } catch (e) {
          console.error('Failed to mark warningSent', t.id, e);
        }
      }
    }
  } catch (e) {
    console.error('Deadline warning check failed', e);
    result.error = e.message;
  }
  return result;
}

cron.schedule('*/15 * * * *', checkDeadlineWarnings);

app.get('/test-deadline-check', async (req, res) => {
  const result = await checkDeadlineWarnings();
  res.json(result);
});

// Avoidance nudges — for 7h tasks left overdue, a repeating push every 3 hours it stays that way
async function checkAvoidanceNudges(){
  if (!POCKETBASE_URL) return { error: 'POCKETBASE_URL not set' };
  const result = { checked: 0, nudged: [] };
  try{
    const filter = encodeURIComponent('done=false && duration="7h"');
    const res = await fetch(`${POCKETBASE_URL}/api/collections/task_manager/records?perPage=200&filter=${filter}`);
    const data = await res.json();
    const items = Array.isArray(data.items) ? data.items : [];
    result.checked = items.length;
    const now = Date.now();

    for (const t of items) {
      if (!t.dueAt) continue;
      const overdueMs = now - new Date(t.dueAt).getTime();
      if (overdueMs <= 0) continue; // not overdue yet

      const overdueHours = overdueMs / (60 * 60 * 1000);
      const bracket = Math.floor(overdueHours / 3); // which 3-hour window we're in
      const currentNudgeCount = typeof t.nudgeCount === 'number' ? t.nudgeCount : 0;

      if (bracket >= 1 && currentNudgeCount < bracket) {
        const hoursLabel = Math.floor(overdueHours);
        await sendPushToAll({
          title: 'Board — still avoiding this?',
          body: `"${t.text}" has been overdue for ${hoursLabel}h. It's taking up more headspace than it looks like — worth just doing it, or dropping it on purpose.`
        });
        result.nudged.push({ id: t.id, text: t.text, overdueHours: hoursLabel });
        try {
          await fetch(`${POCKETBASE_URL}/api/collections/task_manager/records/${t.id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ nudgeCount: bracket })
          });
        } catch (e) {
          console.error('Failed to update nudgeCount', t.id, e);
        }
      }
    }
  } catch (e) {
    console.error('Avoidance nudge check failed', e);
    result.error = e.message;
  }
  return result;
}

cron.schedule('*/15 * * * *', checkAvoidanceNudges);

app.get('/test-avoidance-check', async (req, res) => {
  const result = await checkAvoidanceNudges();
  res.json(result);
});

app.get('/', (req, res) => {
  res.send('Board extraction backend is running.');
});

app.get('/test-push', async (req, res) => {
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
    return res.status(500).json({ error: 'VAPID_PUBLIC_KEY or VAPID_PRIVATE_KEY not set on the server.' });
  }
  if (!POCKETBASE_URL) {
    return res.status(500).json({ error: 'POCKETBASE_URL not set on the server.' });
  }
  const results = await sendPushToAll({
    title: 'Board — test push',
    body: 'If you can see this, push notifications are working.'
  });
  res.json(results);
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
