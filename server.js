const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = 3100;

// ── Oembed fetch ─────────────────────────────────────────────
async function fetchOembed(tweetUrl) {
  const endpoint = 'https://publish.x.com/oembed?url=' + encodeURIComponent(tweetUrl);
  const resp = await fetch(endpoint, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; 0XYAS-Analyzer/1.0)' }
  });
  if (!resp.ok) throw new Error('Oembed returned ' + resp.status);
  return resp.json();
}

// ── Parse oembed HTML ────────────────────────────────────────
function parseOembedHtml(html) {
  const authorMatch = html.match(/class="[^"]*u-url[^"]*"[^>]*>([^<]+)<\/a>/);
  const displayName = authorMatch ? authorMatch[1].trim() : null;

  const handleMatch = html.match(/@(\w+)/);
  const handle = handleMatch ? '@' + handleMatch[1] : null;

  const textMatch = html.match(/<p[^>]*>([\s\S]*?)<\/p>/);
  let text = '';
  if (textMatch) {
    text = textMatch[1]
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<a[^>]*href="([^"]*)"[^>]*>[^<]*<\/a>/gi, '$1')
      .replace(/<[^>]*>/g, '')
      .replace(/&#39;/g, "'")
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .trim();
  }

  const dateMatch = html.match(/>([\w]+ \d+, \d{4})</);
  const date = dateMatch ? dateMatch[1] : null;

  return { displayName, handle, text, date };
}

// ── Authenticity analyzer (text-based heuristics) ────────────
function analyzeFromText(text, author) {
  let score = 75;
  const flags = [];

  // Check for suspicious patterns in text
  if (/follow\s+back/i.test(text)) { score -= 8; flags.push('Contains "follow back" — potential engagement bait'); }
  if (/like\s+and\s+rt/i.test(text) || /retweet/i.test(text)) { score -= 5; flags.push('Contains retweet request — engagement farming signal'); }
  if (/giveaway/i.test(text)) { score -= 5; flags.push('Giveaway content — often associated with engagement farming'); }
  if (/airdrop/i.test(text) && /follow/i.test(text)) { score -= 8; flags.push('Airdrop + follow combo — common bot pattern'); }
  if (/dm\s+for/i.test(text)) { score -= 3; flags.push('DM solicitation — potential scam signal'); }
  if (/whitelist/i.test(text) || /wl\b/i.test(text)) { score -= 2; flags.push('Whitelist mention — common in engagement bait'); }

  // Check for excessive hashtags
  const hashtags = (text.match(/#/g) || []).length;
  if (hashtags > 5) { score -= 5; flags.push('Excessive hashtags (' + hashtags + ') — spam signal'); }

  // Check for excessive emojis
  const emojis = (text.match(/[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F900}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu) || []).length;
  if (emojis > 10) { score -= 3; flags.push('Excessive emojis (' + emojis + ') — low-quality signal'); }

  // Positive signals
  if (text.length > 100 && text.split(' ').length > 20) { score += 5; } // long-form content
  if (/#\w+/g.test(text) && hashtags <= 3) { score += 2; } // moderate hashtag use

  score = Math.max(0, Math.min(100, score));

  return {
    score,
    trafficLight: score >= 60 ? 'green' : score >= 30 ? 'yellow' : 'red',
    flags,
    signals: {
      textLength: text.length,
      wordCount: text.split(/\s+/).length,
      hashtagCount: hashtags,
      emojiCount: emojis,
      hasCallToAction: /follow|like|rt|retweet|share|subscribe/i.test(text),
      hasLink: /https?:\/\//i.test(text),
      sentiment: detectSentiment(text)
    }
  };
}

function detectSentiment(text) {
  const positive = /love|great|amazing|awesome|best|good|happy|excited|beautiful|perfect|incredible|insane/i;
  const negative = /hate|bad|worst|terrible|awful|ugly|boring|scam|fake|trash/i;
  const pos = (text.match(positive) || []).length;
  const neg = (text.match(negative) || []).length;
  if (pos > neg + 2) return 'very_positive';
  if (pos > neg) return 'positive';
  if (neg > pos + 2) return 'very_negative';
  if (neg > pos) return 'negative';
  return 'neutral';
}

// ── API ──────────────────────────────────────────────────────
app.post('/api/analyze', async (req, res) => {
  const { url } = req.body;

  if (!url || !url.match(/(x\.com|twitter\.com)\/\w+\/status\/\d+/)) {
    return res.status(400).json({ error: 'Invalid X/Twitter post URL' });
  }

  try {
    const oembed = await fetchOembed(url);
    const parsed = parseOembedHtml(oembed.html || '');

    const postInfo = {
      author: parsed.displayName || oembed.author_name || 'Unknown',
      authorHandle: parsed.handle || '@' + (oembed.author_name || 'unknown'),
      text: parsed.text || '(could not extract text)',
      date: parsed.date || null,
      url: url
    };

    const auth = analyzeFromText(parsed.text || '', postInfo.author);

    res.json({
      ok: true,
      post: postInfo,
      authenticity: auth,
      source: 'oembed'
    });

  } catch (err) {
    console.error('Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/health', (req, res) => res.json({ ok: true }));

app.listen(PORT, '0.0.0.0', () => {
  console.log('0XYAS API running on port ' + PORT);
});
