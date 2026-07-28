const express = require('express');
const cors = require('cors');
const path = require('path');

// Secrets live in .env (gitignored), never in the client bundle.
// Missing file is fine, the process env may already carry them.
try { process.loadEnvFile(path.join(__dirname, '.env')); } catch (_) {}

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const PORT = 3100;

// ══════════════════════════════════════════════════════════════
// DATA FETCHING
// ══════════════════════════════════════════════════════════════

function extractTweetId(url) {
  const m = url.match(/status\/(\d+)/);
  return m ? m[1] : null;
}

async function fetchOembed(tweetUrl) {
  const resp = await fetch('https://publish.x.com/oembed?url=' + encodeURIComponent(tweetUrl), {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; 0XYAS-Analyzer/1.0)' }
  });
  if (!resp.ok) throw new Error('Oembed returned ' + resp.status);
  return resp.json();
}

async function fetchSyndication(tweetId) {
  try {
    const resp = await fetch('https://cdn.syndication.twimg.com/tweet-result?id=' + tweetId + '&lang=en', {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', 'Referer': 'https://publish.x.com/' }
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    return (data && Object.keys(data).length > 0) ? data : null;
  } catch (e) { return null; }
}

async function fetchFxTwitter(tweetUrl) {
  try {
    const fxUrl = 'https://api.fxtwitter.com/' + tweetUrl.replace(/https?:\/\/(www\.)?(x\.com|twitter\.com)\//, '');
    const resp = await fetch(fxUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!resp.ok) return null;
    const t = (await resp.json()).tweet;
    if (!t) return null;
    return {
      likes: t.likes ?? null, retweets: t.retweets ?? null,
      replies: t.replies ?? null, views: t.views ?? null, quotes: t.quotes ?? null
    };
  } catch (e) { return null; }
}

async function fetchFxTwitterFull(tweetUrl) {
  try {
    const fxUrl = 'https://api.fxtwitter.com/' + tweetUrl.replace(/https?:\/\/(www\.)?(x\.com|twitter\.com)\//, '');
    const resp = await fetch(fxUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!resp.ok) return null;
    return (await resp.json()).tweet || null;
  } catch (e) { return null; }
}

function parseOembedHtml(html) {
  const authorMatch = html.match(/class="[^"]*u-url[^"]*"[^>]*>([^<]+)<\/a>/);
  const handleMatch = html.match(/@(\w+)/);
  const textMatch = html.match(/<p[^>]*>([\s\S]*?)<\/p>/);
  const dateMatch = html.match(/>([\w]+ \d+, \d{4})</);
  let text = '';
  if (textMatch) {
    text = textMatch[1].replace(/<br\s*\/?>/gi, '\n')
      .replace(/<a[^>]*href="([^"]*)"[^>]*>[^<]*<\/a>/gi, '$1')
      .replace(/<[^>]*>/g, '').replace(/&#39;/g, "'").replace(/&amp;/g, '&').trim();
  }
  return {
    displayName: authorMatch ? authorMatch[1].trim() : null,
    handle: handleMatch ? '@' + handleMatch[1] : null,
    text, date: dateMatch ? dateMatch[1] : null
  };
}

// ══════════════════════════════════════════════════════════════
// HELPERS
// ══════════════════════════════════════════════════════════════

function fmtNum(n) {
  if (n == null) return 'N/A';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(n);
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

// ══════════════════════════════════════════════════════════════
// VISIBLE TEXT EXTRACTION, strip URLs, t.co, media, quotes
// ══════════════════════════════════════════════════════════════

function extractVisibleText(text) {
  return text
    .replace(/https?:\/\/t\.co\/\w+/g, '')           // t.co links
    .replace(/https?:\/\/[^\s]+/g, '')                // all URLs
    .replace(/@\w+/g, '')                             // @mentions
    .replace(/\n{3,}/g, '\n\n')                       // excess newlines
    .trim();
}

function countVisibleWords(text) {
  const visible = extractVisibleText(text);
  return visible.split(/\s+/).filter(w => w.length > 0).length;
}

function countVisibleChars(text) {
  return extractVisibleText(text).length;
}

// ══════════════════════════════════════════════════════════════
// CTA CLASSIFICATION, None / Soft / Strong with explanation
// ══════════════════════════════════════════════════════════════

function classifyCtas(text) {
  const patterns = [
    { re: /follow\s+back/i, strength: 'strong', label: 'Follow-back request', explanation: 'Asks for follows in exchange, direct engagement farming' },
    { re: /like\s+and\s+(rt|retweet)|rt\s*&?\s*like|retweet.*follow/i, strength: 'strong', label: 'Like+RT combo', explanation: 'Demands multiple engagement actions, aggressive farming' },
    { re: /follow.*like.*comment|like.*comment.*follow/i, strength: 'strong', label: 'Triple engagement bait', explanation: 'Requests follow+like+comment, maximum farming attempt' },
    { re: /giveaway/i, strength: 'strong', label: 'Giveaway', explanation: 'Giveaway content, typically used to farm engagement' },
    { re: /airdrop.*follow|follow.*airdrop/i, strength: 'strong', label: 'Airdrop+follow', explanation: 'Airdrop promise tied to follows, common scam/bot pattern' },
    { re: /dm\s+(me|for)|message\s+me/i, strength: 'strong', label: 'DM solicitation', explanation: 'Directs users to DM, common in scam funnels' },
    { re: /whitelist|wl\s+spot|guaranteed\s+spot/i, strength: 'strong', label: 'Whitelist/spot promise', explanation: 'Promises guaranteed access, engagement bait' },
    { re: /click\s*(the\s*)?link|link\s+in\s+(bio|thread|comments)/i, strength: 'strong', label: 'Link redirect', explanation: 'Directs to external link, potential phishing or redirect scam' },
    { re: /limited\s+time|act\s+now|last\s+chance|ending\s+soon|hurry/i, strength: 'strong', label: 'Urgency language', explanation: 'Creates artificial urgency, manipulation tactic' },
    { re: /guaranteed|100%\s+profit|risk[- ]free|no\s+loss/i, strength: 'strong', label: 'Unrealistic claims', explanation: 'Promises guaranteed returns, classic scam indicator' },
    { re: /claim\s+now|claim\s+your|claim\s+this/i, strength: 'strong', label: 'Claim CTA', explanation: 'Urges immediate claiming, phishing or scam signal' },
    { re: /sign\s+up|register|join\s+now|open\s*(your)?\s*account/i, strength: 'soft', label: 'Sign-up prompt', explanation: 'Invites registration, promotional but not necessarily malicious' },
    { re: /deposit|send\s+xrp|transfer/i, strength: 'soft', label: 'Deposit/transfer prompt', explanation: 'Moves funds, legitimate in product context but watch for urgency' },
    { re: /check\s+out|look\s+at|see\s+this/i, strength: 'soft', label: 'Soft promotion', explanation: 'Casual recommendation, low-intensity CTA' },
    { re: /subscribe|join\s+my|follow\s+me/i, strength: 'soft', label: 'Self-promotion', explanation: 'Asks for follows/subscribes, common but mild farming' },
    { re: /what\s+do\s+you\s+think|thoughts\?|agree\?/i, strength: 'none', label: 'Discussion prompt', explanation: 'Genuine engagement question, not a farming CTA' },
  ];

  const detected = [];
  patterns.forEach(p => {
    if (p.re.test(text)) {
      detected.push({ label: p.label, strength: p.strength, explanation: p.explanation });
    }
  });

  const strongCount = detected.filter(c => c.strength === 'strong').length;
  const softCount = detected.filter(c => c.strength === 'soft').length;
  let overall = 'none';
  if (strongCount > 0) overall = 'strong';
  else if (softCount > 0) overall = 'soft';

  return { detected, overall, strongCount, softCount, total: detected.length };
}

// ══════════════════════════════════════════════════════════════
// CONTENT QUALITY EVALUATION
// ══════════════════════════════════════════════════════════════

function evaluateContentQuality(text, visibleWords) {
  const checks = [];

  // Originality, is it original or just a RT/quote?
  const isRetweet = /^(RT|QT|cc)\s*[:@]/i.test(text) || /retweeted/i.test(text);
  if (isRetweet) {
    checks.push({ cat: 'Originality', score: 0, max: 10, detail: 'Appears to be a retweet/quote, not original content' });
  } else if (visibleWords > 15) {
    checks.push({ cat: 'Originality', score: 8, max: 10, detail: 'Original substantive content (' + visibleWords + ' visible words)' });
  } else if (visibleWords > 8) {
    checks.push({ cat: 'Originality', score: 5, max: 10, detail: 'Short original content (' + visibleWords + ' words)' });
  } else {
    checks.push({ cat: 'Originality', score: 2, max: 10, detail: 'Very short, limited originality signal' });
  }

  // Clarity, sentence structure, punctuation
  const sentences = text.split(/[.!?]+/).filter(s => s.trim().length > 3);
  const avgSentenceLen = sentences.length > 0 ? visibleWords / sentences.length : 0;
  const hasQuestion = /\?/.test(text);
  const hasExclamation = /!/.test(text);
  if (sentences.length >= 3 && avgSentenceLen > 5 && avgSentenceLen < 30) {
    checks.push({ cat: 'Clarity', score: 8, max: 10, detail: 'Well-structured with ' + sentences.length + ' clear sentences' });
  } else if (sentences.length >= 1) {
    checks.push({ cat: 'Clarity', score: 5, max: 10, detail: sentences.length + ' sentence(s), moderate structure' });
  } else {
    checks.push({ cat: 'Clarity', score: 3, max: 10, detail: 'No clear sentence structure' });
  }

  // Educational value, does it explain something?
  const educationalSignals = /because|since|therefore|however|for example|in other words|means that|this is|the reason|explains|how to|step|guide|tip|learn|understand|important|key|note that/i;
  const hasEducational = educationalSignals.test(text);
  if (hasEducational && visibleWords > 20) {
    checks.push({ cat: 'Educational Value', score: 9, max: 10, detail: 'Contains explanatory language, informative content' });
  } else if (hasEducational) {
    checks.push({ cat: 'Educational Value', score: 6, max: 10, detail: 'Some educational signals but brief' });
  } else if (visibleWords > 30) {
    checks.push({ cat: 'Educational Value', score: 5, max: 10, detail: 'Long-form but no clear educational structure' });
  } else {
    checks.push({ cat: 'Educational Value', score: 2, max: 10, detail: 'No educational signals detected' });
  }

  // Readability, word complexity
  const words = extractVisibleText(text).split(/\s+/).filter(w => w.length > 0);
  const avgWordLen = words.length > 0 ? words.reduce((s, w) => s + w.length, 0) / words.length : 0;
  const longWords = words.filter(w => w.length > 8).length;
  const longWordRatio = words.length > 0 ? longWords / words.length : 0;
  if (avgWordLen > 3 && avgWordLen < 7 && longWordRatio < 0.3) {
    checks.push({ cat: 'Readability', score: 8, max: 10, detail: 'Clear, accessible language (avg ' + avgWordLen.toFixed(1) + ' chars/word)' });
  } else if (avgWordLen <= 7) {
    checks.push({ cat: 'Readability', score: 5, max: 10, detail: 'Moderate readability (avg ' + avgWordLen.toFixed(1) + ' chars/word)' });
  } else {
    checks.push({ cat: 'Readability', score: 3, max: 10, detail: 'Complex language (avg ' + avgWordLen.toFixed(1) + ' chars/word)' });
  }

  // Structure, does it have formatting?
  const hasList = /[-•▪]\s|^\d+[.)]\s/m.test(text);
  const hasNewlines = /\n/.test(text);
  const hasEmoji = /[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F900}-\u{1F9FF}]/u.test(text);
  const structureScore = (hasList ? 3 : 0) + (hasNewlines ? 3 : 0) + (hasEmoji ? 2 : 0) + (sentences.length >= 2 ? 2 : 0);
  checks.push({ cat: 'Structure', score: Math.min(10, structureScore + 2), max: 10, detail: 'Formatting: ' + (hasList ? 'lists ' : '') + (hasNewlines ? 'paragraphs ' : '') + (hasEmoji ? 'emoji ' : '') || 'plain text' });

  return checks;
}

// ══════════════════════════════════════════════════════════════
// LOW-QUALITY PATTERN DETECTION
// ══════════════════════════════════════════════════════════════

function detectLowQualityPatterns(text, ctaResult) {
  const flags = [];

  // Engagement farming
  if (ctaResult.strongCount >= 2) {
    flags.push({ pattern: 'Multi-CTA farming', severity: 'high', detail: ctaResult.strongCount + ' strong CTAs detected, aggressive engagement farming' });
  } else if (ctaResult.strongCount === 1) {
    flags.push({ pattern: 'Single strong CTA', severity: 'medium', detail: 'One strong CTA present: ' + ctaResult.detected.find(c => c.strength === 'strong')?.label });
  }

  // Keyword stuffing
  const hashtags = (text.match(/#/g) || []).length;
  if (hashtags > 8) {
    flags.push({ pattern: 'Hashtag stuffing', severity: 'high', detail: hashtags + ' hashtags, extreme keyword stuffing' });
  } else if (hashtags > 4) {
    flags.push({ pattern: 'Excessive hashtags', severity: 'medium', detail: hashtags + ' hashtags, above normal usage' });
  }

  // Emoji spam
  const emojis = (text.match(/[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F900}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu) || []).length;
  if (emojis > 15) {
    flags.push({ pattern: 'Emoji spam', severity: 'medium', detail: emojis + ' emojis, excessive, low-quality signal' });
  }

  // Shouting (excessive uppercase)
  const letters = (text.match(/[a-zA-Z]/g) || []).length;
  const uppers = (text.match(/[A-Z]/g) || []).length;
  if (letters > 10 && uppers / letters > 0.7) {
    flags.push({ pattern: 'Excessive uppercase', severity: 'medium', detail: Math.round(uppers / letters * 100) + '% uppercase, aggressive tone' });
  }

  // Repetitive template patterns
  const lowerText = text.toLowerCase();
  const templatePatterns = [
    /(?:who|what|when|where|why)\s+(?:else|is|are|has|can|will)/i,
    /(?:did you know|fun fact|pro tip|life hack)/i,
    /(?:tag|mention|share with)\s+(?:a friend|someone)/i,
  ];
  let templateCount = 0;
  templatePatterns.forEach(p => { if (p.test(text)) templateCount++; });
  if (templateCount > 0) {
    flags.push({ pattern: 'Template language', severity: 'low', detail: 'Uses formulaic content patterns' });
  }

  // Scam/fraud indicators
  const scamPatterns = [
    { re: /guaranteed\s+profit|risk[- ]free|100%\s+(?:safe|profit|return)/i, label: 'Guaranteed returns claim' },
    { re: /send\s+\$?\d+.*get\s+\$?\d+/i, label: 'Send-to-receive scam pattern' },
    { re: /seed\s+phrase|private\s+key|mnemonic/i, label: 'Seed phrase fishing' },
    { re: /double\s+(?:your|my)\s+(?:money|xrp|crypto|eth)/i, label: 'Double-your-money scam' },
    { re: /kyc\s+bypass|no\s+kyc/i, label: 'KYC bypass claim' },
  ];
  scamPatterns.forEach(sp => {
    if (sp.re.test(text)) {
      flags.push({ pattern: 'Scam indicator', severity: 'critical', detail: sp.label + ', classic fraud pattern' });
    }
  });

  // Suspicious posting behavior signals
  const links = (text.match(/https?:\/\/[^\s]+/gi) || []).length;
  if (links > 3) {
    flags.push({ pattern: 'Link spam', severity: 'medium', detail: links + ' links in one post, excessive' });
  }

  const urgentWords = (lowerText.match(/limited time|act now|last chance|hurry|ending soon|don't miss/i) || []).length;
  if (urgentWords >= 2) {
    flags.push({ pattern: 'Urgency stacking', severity: 'high', detail: urgentWords + ' urgency phrases, pressure tactic' });
  }

  return flags;
}

// ══════════════════════════════════════════════════════════════
// ENGAGEMENT INTERPRETATION, explain what ratios mean
// ══════════════════════════════════════════════════════════════

function interpretEngagement(eng) {
  if (!eng) return null;
  const { likes, retweets, replies, views, quotes } = eng;
  const interp = [];

  if (views != null && likes != null && views > 100) {
    const engRate = ((likes + (replies || 0) + (retweets || 0)) / views * 100);
    let meaning;
    if (engRate > 25) meaning = 'Unusually high, likely amplified by bots or coordinated accounts';
    else if (engRate > 8) meaning = 'Strong organic engagement, audience actively interacting';
    else if (engRate > 3) meaning = 'Decent engagement, normal for established accounts';
    else if (engRate > 1) meaning = 'Below average, passive audience or low reach';
    else if (engRate > 0.1) meaning = 'Very low engagement relative to views, may indicate botted views';
    else meaning = 'Near-zero engagement, possible ghost traffic';
    interp.push({ metric: 'Engagement Rate', value: engRate.toFixed(2) + '%', meaning });
  }

  if (replies != null && likes != null && likes > 0) {
    const ratio = replies / likes;
    let meaning;
    if (ratio > 5) meaning = 'Extreme, replies vastly exceed likes, suggesting spam replies or heated controversy';
    else if (ratio > 3) meaning = 'Very high, likely spam replies or polarizing content generating heated debate';
    else if (ratio > 1.5) meaning = 'Above average, active discussion, could be genuine debate or mild spam';
    else if (ratio > 0.3) meaning = 'Healthy, real conversations happening alongside likes';
    else if (ratio > 0.05) meaning = 'Low, audience prefers liking over discussing';
    else meaning = 'Very low, passive audience, content consumed but not discussed';
    interp.push({ metric: 'Reply/Like Ratio', value: ratio.toFixed(2) + 'x', meaning });
  }

  if (retweets != null && likes != null && likes > 0) {
    const ratio = retweets / likes;
    let meaning;
    if (ratio > 5) meaning = 'Abnormal, retweets massively exceed likes, strong farming signal';
    else if (ratio > 2) meaning = 'High, content is shared more than appreciated, possible forced virality';
    else if (ratio > 0.5) meaning = 'Balanced, normal sharing pattern';
    else if (ratio > 0.1) meaning = 'Like-heavy, content appreciated but not widely shared';
    else meaning = 'Minimal sharing, consumed but not redistributed';
    interp.push({ metric: 'RT/Like Ratio', value: ratio.toFixed(2) + 'x', meaning });
  }

  if (quotes != null && replies != null && quotes > 0 && replies > 0) {
    const ratio = quotes / replies;
    let meaning;
    if (ratio > 3) meaning = 'Content is quoted far more than replied to, likely controversial or viral-bait';
    else if (ratio > 1) meaning = 'Active quote engagement, sparking broader conversation';
    else meaning = 'Replies dominate, direct conversation preferred over quoting';
    interp.push({ metric: 'Quote/Reply Ratio', value: ratio.toFixed(2) + 'x', meaning });
  }

  if (views != null && likes != null && views > 10000 && likes < 5) {
    interp.push({ metric: 'Ghost Traffic', value: fmtNum(views) + ' views / ' + (likes || 0) + ' likes', meaning: 'High views with near-zero likes, almost certainly botted views' });
  }

  return interp;
}

// ══════════════════════════════════════════════════════════════
// MAIN ANALYSIS ENGINE, transparent weighted scoring
// ══════════════════════════════════════════════════════════════

function analyzePost(text, author, engagement) {
  // ── Extract visible text (strip URLs, mentions, t.co) ──
  const visibleText = extractVisibleText(text);
  const visibleWords = countVisibleWords(text);
  const visibleChars = countVisibleChars(text);

  // ── Counts from raw text ──
  const hashtags = (text.match(/#/g) || []).length;
  const emojis = (text.match(/[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F900}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu) || []).length;
  const rawLinks = (text.match(/https?:\/\/[^\s]+/gi) || []).length;
  const mentions = (text.match(/@\w+/g) || []).length;

  // ── CTA classification ──
  const cta = classifyCtas(text);

  // ── Content quality evaluation ──
  const contentQuality = evaluateContentQuality(text, visibleWords);
  const qualityScore = contentQuality.reduce((s, c) => s + c.score, 0);
  const qualityMax = contentQuality.reduce((s, c) => s + c.max, 0);

  // ── Low-quality pattern detection ──
  const lowQualityPatterns = detectLowQualityPatterns(text, cta);

  // ── Sentiment ──
  const posWords = (visibleText.match(/love|great|amazing|awesome|best|good|happy|excited|beautiful|perfect|incredible|bullish|gem|solid|strong|powerful|innovative|breakthrough|impressive/i) || []).length;
  const negWords = (visibleText.match(/hate|bad|worst|terrible|awful|scam|fake|trash|bearish|rekt|dump|rug|disappointing|broken|fraud|stolen|hack/i) || []).length;
  let sentiment = 'neutral';
  if (posWords > negWords + 1) sentiment = posWords > negWords + 3 ? 'very_positive' : 'positive';
  else if (negWords > posWords + 1) sentiment = negWords > posWords + 3 ? 'very_negative' : 'negative';

  // ════════════════════════════════════════════════════════════
  // WEIGHTED SCORING MODEL
  // Categories: Content Quality (30), Engagement (30), Trust (25), Spam (15)
  // ════════════════════════════════════════════════════════════

  const categories = [];

  // ── CATEGORY 1: Content Quality (max 30) ──
  let cqScore = 0;
  const cqDetails = [];

  // Word count contribution (0-10)
  if (visibleWords <= 3) { cqScore += 0; cqDetails.push('Extremely short (' + visibleWords + ' words), no substance'); }
  else if (visibleWords <= 8) { cqScore += 2; cqDetails.push('Very short (' + visibleWords + ' words), minimal content'); }
  else if (visibleWords <= 15) { cqScore += 4; cqDetails.push('Short post (' + visibleWords + ' words)'); }
  else if (visibleWords <= 30) { cqScore += 7; cqDetails.push('Moderate content (' + visibleWords + ' words)'); }
  else { cqScore += 10; cqDetails.push('Substantial content (' + visibleWords + ' words)'); }

  // Quality evaluation (0-12, from quality checks averaged)
  const qAvg = qualityMax > 0 ? (qualityScore / qualityMax) * 12 : 0;
  cqScore += Math.round(qAvg);
  const topQuality = contentQuality.filter(c => c.score >= 7).map(c => c.cat);
  const weakQuality = contentQuality.filter(c => c.score <= 3).map(c => c.cat);
  if (topQuality.length > 0) cqDetails.push('Strong: ' + topQuality.join(', '));
  if (weakQuality.length > 0) cqDetails.push('Weak: ' + weakQuality.join(', '));

  // Originality bonus (0-5)
  const isRetweet = /^(RT|QT|cc)\s*[:@]/i.test(text);
  if (isRetweet) { cqScore += 0; cqDetails.push('Retweet/quote, not original'); }
  else if (visibleWords > 15 && !/follow|like|rt|retweet|giveaway/i.test(visibleText)) { cqScore += 5; cqDetails.push('Original content'); }
  else if (visibleWords > 8) { cqScore += 3; cqDetails.push('Likely original'); }
  else { cqScore += 1; cqDetails.push('Too short to assess originality'); }

  // Educational value bonus (0-3)
  const eduCheck = contentQuality.find(c => c.cat === 'Educational Value');
  if (eduCheck && eduCheck.score >= 7) { cqScore += 3; cqDetails.push('Informative/educational'); }
  else if (eduCheck && eduCheck.score >= 5) { cqScore += 1; cqDetails.push('Somewhat informative'); }

  cqScore = clamp(cqScore, 0, 30);
  categories.push({ name: 'Content Quality', score: cqScore, max: 30, weight: '30%', details: cqDetails });

  // ── CATEGORY 2: Engagement Authenticity (max 30) ──
  let eaScore = 15; // neutral start
  const eaDetails = [];

  if (engagement) {
    const { likes, retweets, replies, views, quotes } = engagement;

    // Engagement rate (−8 to +8)
    if (views != null && likes != null && views > 100) {
      const engRate = ((likes + (replies || 0) + (retweets || 0)) / views * 100);
      if (engRate > 25) { eaScore -= 8; eaDetails.push('Engagement rate ' + engRate.toFixed(1) + '%, abnormally high, possible amplification'); }
      else if (engRate > 8) { eaScore += 8; eaDetails.push('Engagement rate ' + engRate.toFixed(1) + '%, strong organic interaction'); }
      else if (engRate > 3) { eaScore += 4; eaDetails.push('Engagement rate ' + engRate.toFixed(1) + '%, decent'); }
      else if (engRate < 0.5 && views > 5000) { eaScore -= 5; eaDetails.push('Engagement rate ' + engRate.toFixed(2) + '% with ' + fmtNum(views) + ' views, possible botted views'); }
      else { eaDetails.push('Engagement rate ' + engRate.toFixed(2) + '%, below average'); }
    }

    // Reply quality (−10 to +6)
    if (replies != null && likes != null && likes > 0) {
      const rl = replies / likes;
      if (rl > 5) { eaScore -= 10; eaDetails.push('Reply/like ' + rl.toFixed(1) + 'x, extreme, likely spam replies'); }
      else if (rl > 3) { eaScore -= 7; eaDetails.push('Reply/like ' + rl.toFixed(1) + 'x, high, spam or controversy'); }
      else if (rl > 1.5) { eaScore -= 2; eaDetails.push('Reply/like ' + rl.toFixed(1) + 'x, active discussion'); }
      else if (rl > 0.3) { eaScore += 6; eaDetails.push('Reply/like ' + rl.toFixed(2) + 'x, healthy conversation'); }
      else { eaScore += 1; eaDetails.push('Reply/like ' + rl.toFixed(2) + 'x, passive audience'); }
    }

    // RT farming (−8 to +5)
    if (retweets != null && likes != null && likes > 0) {
      const rt = retweets / likes;
      if (rt > 5) { eaScore -= 8; eaDetails.push('RT/like ' + rt.toFixed(1) + 'x, retweet farming'); }
      else if (rt > 2) { eaScore -= 4; eaDetails.push('RT/like ' + rt.toFixed(1) + 'x, high, possible forced sharing'); }
      else if (rt < 0.3 && likes > 50) { eaScore += 5; eaDetails.push('RT/like ' + rt.toFixed(2) + 'x, organic appreciation'); }
      else { eaDetails.push('RT/like ' + rt.toFixed(2) + 'x, normal pattern'); }
    }

    // Ghost traffic (−8)
    if (views != null && views > 10000 && likes != null && likes < 5) {
      eaScore -= 8; eaDetails.push('Ghost traffic: ' + fmtNum(views) + ' views but near-zero likes');
    }

    // Impossible metrics (−15)
    if (retweets != null && views != null && retweets > views && views > 0) {
      eaScore -= 15; eaDetails.push('Retweets exceed views, impossible, data anomaly');
    }

    // Popularity bonus (0-3)
    if (likes != null && likes > 5000) { eaScore += 3; eaDetails.push('High popularity (' + fmtNum(likes) + ' likes)'); }
    else if (likes != null && likes > 1000) { eaScore += 2; eaDetails.push('Good like count (' + fmtNum(likes) + ')'); }
  } else {
    eaScore = 10;
    eaDetails.push('No engagement data available, cannot assess authenticity');
  }

  eaScore = clamp(eaScore, 0, 30);
  categories.push({ name: 'Engagement Authenticity', score: eaScore, max: 30, weight: '30%', details: eaDetails });

  // ── CATEGORY 3: Trust & Safety (max 25) ──
  let tsScore = 18; // start trusting
  const tsDetails = [];

  // CTA impact
  if (cta.strongCount >= 3) { tsScore -= 12; tsDetails.push(cta.strongCount + ' strong CTAs, aggressive, low trust'); }
  else if (cta.strongCount === 2) { tsScore -= 8; tsDetails.push('2 strong CTAs, concerning pattern'); }
  else if (cta.strongCount === 1) { tsScore -= 4; tsDetails.push('1 strong CTA, monitor context'); }
  else if (cta.softCount > 0) { tsScore -= 1; tsDetails.push(cta.softCount + ' soft CTA(s), mild promotion'); }
  else { tsDetails.push('No CTAs, clean'); }

  // Low-quality patterns
  const criticalPatterns = lowQualityPatterns.filter(p => p.severity === 'critical');
  const highPatterns = lowQualityPatterns.filter(p => p.severity === 'high');
  const medPatterns = lowQualityPatterns.filter(p => p.severity === 'medium');

  if (criticalPatterns.length > 0) {
    tsScore -= 15;
    tsDetails.push('CRITICAL: ' + criticalPatterns.map(p => p.detail).join('; '));
  }
  if (highPatterns.length > 0) {
    tsScore -= 5 * highPatterns.length;
    tsDetails.push(highPatterns.length + ' high-severity pattern(s)');
  }
  if (medPatterns.length > 0) {
    tsScore -= 2 * medPatterns.length;
    tsDetails.push(medPatterns.length + ' medium-severity pattern(s)');
  }

  // Link safety
  if (rawLinks > 3) { tsScore -= 3; tsDetails.push(rawLinks + ' links, excessive'); }
  else if (rawLinks === 1) { tsDetails.push('Single link, normal'); }

  tsScore = clamp(tsScore, 0, 25);
  categories.push({ name: 'Trust & Safety', score: tsScore, max: 25, weight: '25%', details: tsDetails });

  // ── CATEGORY 4: Spam Indicators (max 15, inverted: fewer = better) ──
  let spScore = 15; // start clean
  const spDetails = [];

  if (hashtags > 8) { spScore -= 8; spDetails.push(hashtags + ' hashtags, extreme spam'); }
  else if (hashtags > 4) { spScore -= 4; spDetails.push(hashtags + ' hashtags, excessive'); }
  else if (hashtags > 0 && hashtags <= 3) { spDetails.push(hashtags + ' hashtag(s), moderate'); }
  else { spDetails.push('No hashtags'); }

  if (emojis > 15) { spScore -= 4; spDetails.push(emojis + ' emojis, spam signal'); }
  else if (emojis > 10) { spScore -= 2; spDetails.push(emojis + ' emojis, slightly high'); }

  const upperLetters = (text.match(/[A-Z]/g) || []).length;
  const allLetters = (text.match(/[a-zA-Z]/g) || []).length;
  if (allLetters > 10 && upperLetters / allLetters > 0.7) {
    spScore -= 3; spDetails.push('Excessive uppercase, shouting');
  }

  spScore = clamp(spScore, 0, 15);
  categories.push({ name: 'Spam Indicators', score: spScore, max: 15, weight: '15%', details: spDetails });

  // ════════════════════════════════════════════════════════════
  // FINAL SCORE
  // ════════════════════════════════════════════════════════════

  const totalScore = categories.reduce((s, c) => s + c.score, 0);
  const totalMax = categories.reduce((s, c) => s + c.max, 0);

  let label;
  if (totalScore >= 80) label = 'High quality, genuine, well-crafted content with authentic engagement';
  else if (totalScore >= 65) label = 'Good quality, mostly authentic with minor concerns';
  else if (totalScore >= 50) label = 'Average, some positive signals mixed with concerns';
  else if (totalScore >= 35) label = 'Below average, multiple red flags detected';
  else label = 'Low quality, likely spam, farming, or inauthentic';

  // ── Bounty Verdict ──
  let verdict, verdictReason;
  if (totalScore >= 75 && lowQualityPatterns.filter(p => p.severity === 'critical').length === 0 && cta.strongCount <= 1) {
    verdict = 'Approve';
    verdictReason = 'Content meets quality standards. ' + (cta.strongCount > 0 ? 'Has mild CTA but within acceptable range.' : 'No aggressive CTAs.') + ' Engagement patterns appear organic.';
  } else if (totalScore >= 45 || (totalScore >= 35 && lowQualityPatterns.filter(p => p.severity === 'critical').length === 0)) {
    verdict = 'Manual Review';
    const concerns = [];
    if (cta.strongCount > 1) concerns.push(cta.strongCount + ' strong CTAs');
    if (lowQualityPatterns.length > 0) concerns.push(lowQualityPatterns.length + ' pattern flags');
    if (eaScore < 15) concerns.push('engagement concerns');
    verdictReason = 'Mixed signals detected. ' + (concerns.length > 0 ? 'Review: ' + concerns.join(', ') + '.' : 'Score borderline, human judgment needed.');
  } else {
    verdict = 'Reject';
    const reasons = [];
    if (lowQualityPatterns.filter(p => p.severity === 'critical').length > 0) reasons.push('scam indicators');
    if (cta.strongCount >= 3) reasons.push('aggressive farming');
    if (eaScore < 10) reasons.push('inauthentic engagement');
    if (spScore < 5) reasons.push('spam signals');
    verdictReason = 'Fails quality thresholds. ' + (reasons.length > 0 ? 'Issues: ' + reasons.join(', ') + '.' : 'Multiple critical failures.');
  }

  // ── Executive Summary ──
  const positives = [];
  const negatives = [];
  categories.forEach(c => {
    const ratio = c.score / c.max;
    if (ratio >= 0.7) positives.push(c.name);
    else if (ratio < 0.45) negatives.push(c.name);
  });
  if (visibleWords > 25) positives.push('good length');
  if (cta.strongCount === 0 && lowQualityPatterns.filter(p => p.severity === 'critical').length === 0) positives.push('clean trust signals');
  if (cta.strongCount >= 2) negatives.push('aggressive CTAs');
  if (lowQualityPatterns.filter(p => p.severity === 'critical').length > 0) negatives.push('scam indicators');

  const summaryParts = [];
  if (positives.length > 0) summaryParts.push('Strengths: ' + positives.slice(0, 3).join(', ') + '.');
  if (negatives.length > 0) summaryParts.push('Concerns: ' + negatives.slice(0, 3).join(', ') + '.');
  summaryParts.push('Overall score ' + totalScore + '/100, ' + verdict + '.');
  const executiveSummary = summaryParts.join(' ').slice(0, 300);

  // ── Engagement interpretation ──
  const engInterp = interpretEngagement(engagement);

  return {
    score: totalScore,
    label,
    trafficLight: totalScore >= 65 ? 'green' : totalScore >= 40 ? 'yellow' : 'red',
    categories,
    cta,
    contentQuality,
    lowQualityPatterns,
    engagementInterpretation: engInterp,
    verdict,
    verdictReason,
    executiveSummary,
    signals: {
      visibleWords, visibleChars, hashtagCount: hashtags, emojiCount: emojis,
      linkCount: rawLinks, mentionCount: mentions, sentiment,
      engagement: engagement || {}
    }
  };
}

// ══════════════════════════════════════════════════════════════
// XORA.FINANCE CONTEXTUAL TRUST ANALYSIS
// ══════════════════════════════════════════════════════════════

function analyzeXora(text, authorHandle, url, resolvedUrls) {
  const authorLower = (authorHandle || '').toLowerCase().replace('@', '');
  const isFromXora = authorLower === 'xora_finance';
  const textMentionsXora = /xora|xrp\s*neobank|xora_finance|xora\.finance|#xora/i.test(text);
  const resolvedHasXora = (resolvedUrls || []).some(u => /xora\.finance/i.test(u));
  const isXoraRelated = isFromXora || textMentionsXora || /xora\.finance|xora_finance/i.test(url) || resolvedHasXora;
  if (!isXoraRelated) return null;

  const flags = [];
  const greenFlags = [];
  const trustBreakdown = [];
  let trustScore = 50;

  // ── 1. Account verification ──
  if (isFromXora) {
    trustScore += 25;
    greenFlags.push('Posted from official @xora_finance account');
    trustBreakdown.push({ cat: 'Account', detail: 'Official @xora_finance account', pts: 25 });
  } else if (/xora/i.test(authorLower) && authorLower !== 'xora_finance') {
    trustScore -= 20;
    flags.push('Author @' + authorLower + ' may impersonate official @xora_finance');
    trustBreakdown.push({ cat: 'Account', detail: 'Possible impersonator, name contains "xora" but not official', pts: -20 });
  } else {
    const mentionsOfficial = /@xora_finance/i.test(text);
    if (mentionsOfficial) {
      trustScore += 10;
      greenFlags.push('References official @xora_finance account');
      trustBreakdown.push({ cat: 'Account', detail: 'Mentions @xora_finance but author is third-party', pts: 10 });
    } else {
      trustScore -= 5;
      trustBreakdown.push({ cat: 'Account', detail: 'Third-party post, no @xora_finance mention', pts: -5 });
    }
  }

  // ── 2. Link verification (contextual) ──
  const links = (text.match(/https?:\/\/[^\s]+/gi) || []);
  const allLinks = [...new Set([...links, ...(resolvedUrls || [])])];

  const officialLinks = allLinks.filter(l => /xora\.finance/i.test(l));
  const fakeLinks = allLinks.filter(l =>
    /xorafinance\.com/i.test(l) || /xora-?finance\.(com|net|org|xyz|io)/i.test(l) || /xora\.(?!finance)/i.test(l)
  );
  const referralLinks = allLinks.filter(l => /[?&]ref=|\/ref\/|\/invite\//i.test(l));
  const shortenedLinks = allLinks.filter(l => /bit\.ly|tinyurl/i.test(l));
  const tcoLinks = links.filter(l => /t\.co\//i.test(l));

  if (officialLinks.length > 0) {
    trustScore += 15;
    greenFlags.push('Links to official xora.finance domain');
    trustBreakdown.push({ cat: 'Links', detail: officialLinks.length + ' official link(s) verified', pts: 15 });
  }
  if (fakeLinks.length > 0) {
    trustScore -= 30;
    flags.push('FAKE XORA domain detected: ' + fakeLinks[0]);
    trustBreakdown.push({ cat: 'Links', detail: 'Fake/cloned domain, HIGH scam risk', pts: -30 });
  }
  if (referralLinks.length > 0) {
    trustScore -= 3;
    flags.push('Contains referral tracking link, may incentivize promotion');
    trustBreakdown.push({ cat: 'Links', detail: 'Referral link detected, possible incentivized shilling', pts: -3 });
  }
  if (shortenedLinks.length > 0) {
    trustScore -= 8;
    flags.push('Uses shortened link, destination cannot be verified');
    trustBreakdown.push({ cat: 'Links', detail: 'Shortened URL, unverifiable destination', pts: -8 });
  }
  if (tcoLinks.length > 0 && officialLinks.length === 0 && fakeLinks.length === 0) {
    trustBreakdown.push({ cat: 'Links', detail: 't.co wrapped, destination verified via fxtwitter: ' + (resolvedHasXora ? 'xora.finance' : 'unknown'), pts: 0 });
  }
  if (allLinks.length === 0) {
    greenFlags.push('No external links');
    trustBreakdown.push({ cat: 'Links', detail: 'No external links', pts: 0 });
  }

  // ── 3. CTA analysis (XORA-specific) ──
  const cta = classifyCtas(text);
  if (cta.strongCount >= 2) {
    trustScore -= 15;
    flags.push('Aggressive CTAs: ' + cta.detected.filter(c => c.strength === 'strong').map(c => c.label).join(', '));
    trustBreakdown.push({ cat: 'CTAs', detail: cta.strongCount + ' strong CTAs, aggressive promotion', pts: -15 });
  } else if (cta.strongCount === 1) {
    trustScore -= 5;
    trustBreakdown.push({ cat: 'CTAs', detail: '1 strong CTA: ' + cta.detected.find(c => c.strength === 'strong')?.label, pts: -5 });
  } else if (cta.total === 0) {
    trustScore += 5;
    greenFlags.push('No CTAs, informational post');
    trustBreakdown.push({ cat: 'CTAs', detail: 'No CTAs detected', pts: 5 });
  } else {
    trustBreakdown.push({ cat: 'CTAs', detail: cta.softCount + ' soft CTA(s), promotional but not aggressive', pts: 0 });
  }

  // ── 4. APY/yield claims ──
  const apyMatch = text.match(/(\d+(?:\.\d+)?)\s*%\s*(?:apy|apy\s*value|yield)/i);
  if (apyMatch) {
    const claimed = parseFloat(apyMatch[1]);
    if (claimed > 25) {
      trustScore -= 15;
      flags.push('Claims ' + claimed + '% APY, exceeds official 22% maximum');
      trustBreakdown.push({ cat: 'APY', detail: claimed + '% exceeds official max (22%)', pts: -15 });
    } else if (claimed <= 22) {
      trustScore += 5;
      greenFlags.push('APY claim (' + claimed + '%) within official range');
      trustBreakdown.push({ cat: 'APY', detail: claimed + '% within official range (≤22%)', pts: 5 });
    }
  }

  // ── 5. Scam keywords ──
  const scamKw = [
    { re: /guaranteed\s+profit/i, label: 'Guaranteed profit claim' },
    { re: /risk[\s-]*free/i, label: 'Risk-free claim' },
    { re: /double\s*(your|my)\s*(xrp|crypto)/i, label: 'Double-your-money' },
    { re: /send\s*\d+.*get\s*\d+/i, label: 'Send-to-receive' },
    { re: /seed\s*phrase|private\s*key/i, label: 'Seed phrase fishing' },
    { re: /kyc\s*bypass|no\s+kyc/i, label: 'KYC bypass' },
  ];
  scamKw.forEach(s => {
    if (s.re.test(text)) {
      trustScore -= 15;
      flags.push('Scam keyword: ' + s.label);
      trustBreakdown.push({ cat: 'Scam', detail: s.label, pts: -15 });
    }
  });

  trustScore = clamp(trustScore, 0, 100);

  let trustLabel;
  if (trustScore >= 80) trustLabel = 'Highly trusted, strong official signals';
  else if (trustScore >= 65) trustLabel = 'Likely legitimate, mostly verified';
  else if (trustScore >= 45) trustLabel = 'Mixed signals, verify before acting';
  else trustLabel = 'Untrusted, multiple risk factors';

  return {
    isXoraPost: true, trustScore,
    trafficLight: trustScore >= 65 ? 'green' : trustScore >= 45 ? 'yellow' : 'red',
    trustLabel, flags, greenFlags, trustBreakdown,
    checks: {
      isFromXora, mentionsOfficial: /@xora_finance/i.test(text),
      officialLinks: officialLinks.length, fakeLinks: fakeLinks.length,
      referralLinks: referralLinks.length, shortenedLinks: shortenedLinks.length,
      cta: cta.detected, claimedApy: apyMatch ? parseFloat(apyMatch[1]) : null,
      isImpersonator: /xora/i.test(authorLower) && authorLower !== 'xora_finance',
      linkWrapped: tcoLinks.length > 0 && officialLinks.length === 0
    }
  };
}

// ══════════════════════════════════════════════════════════════
// REPLY FETCHING & ANALYSIS
// ══════════════════════════════════════════════════════════════

function parseRepliesFromHtml(html) {
  const replies = [];
  const parts = html.split('<div class="timeline-item ');
  for (let i = 1; i < parts.length; i++) {
    const item = parts[i];
    const nameM = item.match(/class="fullname"[^>]*>([^<]+)/);
    const handleM = item.match(/class="username"[^>]*>([^<]+)/);
    const contentM = item.match(/class="tweet-content[^"]*"[^>]*>([\s\S]*?)<\/div>/);
    const text = contentM ? contentM[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : '';
    const statMatches = [...item.matchAll(/icon-(comment|retweet|heart|views)"[^>]*><\/span>\s*([^<]*)/g)];
    const stats = {};
    statMatches.forEach(m => {
      const key = m[1] === 'comment' ? 'replies' : m[1] === 'heart' ? 'likes' : m[1];
      const val = m[2].trim().replace(/,/g, '');
      stats[key] = val && !isNaN(val) ? parseInt(val, 10) : null;
    });
    const isReply = item.includes('replying-to');
    const replyToM = item.match(/replying-to.*?href="\/(\w+)"/);
    const linkM = item.match(/href="\/(\w+)\/status\/(\d+)/);
    if (text || nameM) {
      replies.push({
        author: nameM ? nameM[1].trim() : 'Unknown',
        handle: handleM ? handleM[1].trim() : '@unknown',
        text, replies: stats.replies || null, retweets: stats.retweets || null,
        likes: stats.likes || null, views: stats.views || null,
        isReply, replyTo: replyToM ? '@' + replyToM[1] : null,
        tweetId: linkM ? linkM[2] : null, authorIsOP: false
      });
    }
  }
  return replies;
}

function extractCursor(html) {
  const m = html.match(/cursor=([^"#]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

async function fetchRepliesFromXcancel(tweetUrl, maxReplies) {
  maxReplies = maxReplies || 50;
  const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
  const pathPart = tweetUrl.replace(/https?:\/\/(www\.)?(x\.com|twitter\.com)\//, '');
  const baseUrl = 'https://xcancel.com/' + pathPart;
  let allReplies = [], cursor = null, pages = 0;
  const maxPages = 3;

  try {
    console.log('[replies] Fetching page 1...');
    let resp = await fetch(baseUrl, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(12000) });
    if (!resp.ok) throw new Error('xcancel ' + resp.status);
    let html = await resp.text();
    // Check for captcha
    if (html.includes('Verifying your browser') || html.includes('antibot')) {
      throw new Error('xcancel rate-limited (captcha)');
    }
    allReplies = parseRepliesFromHtml(html);
    cursor = extractCursor(html);
    pages++;
    const opMatch = html.match(/data-username="(\w+)"/);
    const opHandle = opMatch ? '@' + opMatch[1].toLowerCase() : null;
    allReplies.forEach(r => { r.authorIsOP = opHandle && r.handle.toLowerCase().replace('@', '') === opHandle.replace('@', ''); });

    while (cursor && allReplies.length < maxReplies && pages < maxPages) {
      pages++;
      await new Promise(r => setTimeout(r, 800));
      resp = await fetch(baseUrl + '?cursor=' + encodeURIComponent(cursor), { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(12000) });
      if (!resp.ok) break;
      html = await resp.text();
      if (html.includes('Verifying your browser') || html.includes('antibot')) break;
      const nr = parseRepliesFromHtml(html);
      nr.forEach(r => { r.authorIsOP = opHandle && r.handle.toLowerCase().replace('@', '') === opHandle.replace('@', ''); });
      allReplies = allReplies.concat(nr);
      cursor = extractCursor(html);
    }
    console.log('[replies] Got ' + allReplies.length + ' items');
    return { replies: allReplies.slice(0, maxReplies), opHandle, error: null };
  } catch (e) {
    console.log('[replies] Error:', e.message);
    return { replies: [], opHandle: null, error: e.message };
  }
}

function analyzeReplyQuality(replies, opHandle) {
  if (!replies || replies.length === 0) {
    return {
      score: null, label: 'Replies unavailable', trafficLight: null,
      breakdown: [], flags: [], greenFlags: [], stats: null, sampleReplies: [],
      unavailableReason: 'Could not load replies. X/Twitter rate-limits third-party scrapers. Reply quality analysis requires fetching actual reply content, which is currently blocked.',
      suggestion: 'Try again later when rate limits reset, or check replies manually on X.'
    };
  }

  const realReplies = replies.filter(r => r.isReply);
  const opReplies = replies.filter(r => r.authorIsOP);
  const uniqueAuthors = new Set(replies.map(r => r.handle.toLowerCase()));

  let score = 50;
  const breakdown = [];
  const flags = [];
  const greenFlags = [];

  // OP engagement
  if (opReplies.length > 0) {
    score += 10; greenFlags.push('OP replied ' + opReplies.length + ' time(s)');
    breakdown.push({ cat: 'OP Engagement', detail: 'Original author engaged ' + opReplies.length + ' time(s), active discussion', pts: 10 });
  } else {
    score -= 3;
    breakdown.push({ cat: 'OP Engagement', detail: 'OP did not reply, one-way broadcast', pts: -3 });
  }

  // Participant diversity
  const ratio = uniqueAuthors.size / Math.max(replies.length, 1);
  if (ratio > 0.7) { score += 8; greenFlags.push(uniqueAuthors.size + ' unique voices'); breakdown.push({ cat: 'Diversity', detail: uniqueAuthors.size + '/' + replies.length + ' unique authors, real community', pts: 8 }); }
  else if (ratio > 0.4) { score += 3; breakdown.push({ cat: 'Diversity', detail: uniqueAuthors.size + '/' + replies.length + ' unique, moderate', pts: 3 }); }
  else { score -= 5; flags.push('Low diversity'); breakdown.push({ cat: 'Diversity', detail: uniqueAuthors.size + '/' + replies.length + ' unique, repetitive', pts: -5 }); }

  // Reply depth
  const substantive = realReplies.filter(r => r.text.split(/\s+/).length > 5);
  const subRatio = realReplies.length > 0 ? substantive.length / realReplies.length : 0;
  if (subRatio > 0.7) { score += 10; greenFlags.push(Math.round(subRatio * 100) + '% substantive replies'); breakdown.push({ cat: 'Reply Depth', detail: Math.round(subRatio * 100) + '% substantive (>5 words)', pts: 10 }); }
  else if (subRatio > 0.4) { score += 3; breakdown.push({ cat: 'Reply Depth', detail: Math.round(subRatio * 100) + '% substantive, mixed', pts: 3 }); }
  else { score -= 5; breakdown.push({ cat: 'Reply Depth', detail: Math.round(subRatio * 100) + '% substantive, mostly shallow', pts: -5 }); }

  // Bot/spam detection
  const texts = realReplies.map(r => r.text.toLowerCase().trim());
  const uniqueTexts = new Set(texts);
  const dupRatio = realReplies.length > 0 ? 1 - (uniqueTexts.size / realReplies.length) : 0;
  if (dupRatio > 0.3) { score -= 15; flags.push('Duplicate replies: ' + Math.round(dupRatio * 100) + '%'); breakdown.push({ cat: 'Bot Detection', detail: Math.round(dupRatio * 100) + '% near-identical, bot spam', pts: -15 }); }

  let spamCount = 0;
  realReplies.forEach(r => { if (/follow\s+back|like\s+and\s+rt|giveaway|dm\s+for|link\s+in\s+bio/i.test(r.text)) spamCount++; });
  if (spamCount > realReplies.length * 0.2) {
    score -= 10; flags.push(Math.round(spamCount / realReplies.length * 100) + '% spam replies');
    breakdown.push({ cat: 'Spam Replies', detail: Math.round(spamCount / realReplies.length * 100) + '% contain farming CTAs', pts: -10 });
  }

  score = clamp(score, 0, 100);
  let label;
  if (score >= 80) label = 'Excellent, genuine community discussion';
  else if (score >= 65) label = 'Good, mostly real conversations';
  else if (score >= 50) label = 'Average, mixed quality';
  else if (score >= 35) label = 'Below average, significant noise';
  else label = 'Poor, likely manipulated';

  return {
    score, label,
    trafficLight: score >= 65 ? 'green' : score >= 40 ? 'yellow' : 'red',
    breakdown, flags, greenFlags,
    stats: {
      totalReplies: replies.length, realReplies: realReplies.length,
      opReplies: opReplies.length, uniqueAuthors: uniqueAuthors.size,
      substantiveReplies: substantive.length, spamReplies: spamCount
    },
    sampleReplies: realReplies.slice(0, 10).map(r => ({
      author: r.author, handle: r.handle, text: r.text.slice(0, 200),
      likes: r.likes, replies: r.replies, isOP: r.authorIsOP
    }))
  };
}

// ══════════════════════════════════════════════════════════════
// API ROUTES
// ══════════════════════════════════════════════════════════════

app.post('/api/analyze', async (req, res) => {
  const { url } = req.body;
  if (!url || !url.match(/(x\.com|twitter\.com)\/\w+\/status\/\d+/)) {
    return res.status(400).json({ error: 'Invalid X/Twitter post URL' });
  }
  const tweetId = extractTweetId(url);
  if (!tweetId) return res.status(400).json({ error: 'Could not extract tweet ID' });

  try {
    console.log('[1/3] Fetching post data...');
    let postInfo = null, engagement = null;

    try {
      const oembed = await fetchOembed(url);
      const parsed = parseOembedHtml(oembed.html || '');
      postInfo = {
        author: parsed.displayName || oembed.author_name || 'Unknown',
        authorHandle: parsed.handle || '@' + (oembed.author_name || 'unknown'),
        text: parsed.text || null, date: parsed.date || null, url, tweetId
      };
    } catch (e) { console.log('  Oembed failed:', e.message); }

    console.log('[2/3] Fetching engagement...');
    const fxData = await fetchFxTwitter(url);
    if (fxData) engagement = fxData;

    // Fill missing from fxtwitter full
    let resolvedUrls = [], cardDescription = '';
    try {
      const fxFull = await fetchFxTwitterFull(url);
      if (fxFull) {
        if (!postInfo || !postInfo.text) {
          postInfo = postInfo || {};
          postInfo.author = postInfo.author || fxFull.author?.name || 'Unknown';
          postInfo.authorHandle = postInfo.authorHandle || '@' + (fxFull.author?.screen_name || 'unknown');
          postInfo.text = postInfo.text || fxFull.text || '';
          postInfo.date = postInfo.date || fxFull.created_at || null;
        }
        if (fxFull.card?.url) resolvedUrls.push(fxFull.card.url);
        if (fxFull.card?.domain) resolvedUrls.push('https://' + fxFull.card.domain);
        if (fxFull.card?.description) cardDescription = fxFull.card.description;
        if (fxFull.urls) fxFull.urls.forEach(u => { if (u.url) resolvedUrls.push(u.url); });
        if (fxFull.text) {
          (fxFull.text.match(/https?:\/\/[^\s]+/gi) || []).forEach(u => resolvedUrls.push(u));
        }
        if (engagement) {
          engagement.likes = engagement.likes ?? fxFull.likes ?? null;
          engagement.retweets = engagement.retweets ?? fxFull.retweets ?? null;
          engagement.replies = engagement.replies ?? fxFull.replies ?? null;
          engagement.views = engagement.views ?? fxFull.views ?? null;
        }
      }
    } catch (e) { /* ignore */ }

    // Syndication fallback
    if (!engagement || Object.values(engagement).every(v => v === null)) {
      const syn = await fetchSyndication(tweetId);
      if (syn) {
        if (!engagement) engagement = {};
        engagement.likes = engagement.likes ?? syn.likes ?? null;
        engagement.retweets = engagement.retweets ?? syn.retweets ?? null;
        engagement.replies = engagement.replies ?? syn.replies ?? null;
        engagement.views = engagement.views ?? syn.views?.count ?? syn.views ?? null;
        engagement.quotes = engagement.quotes ?? syn.quotes ?? null;
      }
    }

    if (!postInfo) return res.status(500).json({ error: 'Could not fetch tweet data.' });
    postInfo.text = postInfo.text || '';
    postInfo.authorHandle = postInfo.authorHandle || '@unknown';

    console.log('[3/3] Analysis complete.');
    const auth = analyzePost(postInfo.text, postInfo.author, engagement);
    const textForXora = postInfo.text + (cardDescription ? ' ' + cardDescription : '');
    const xora = analyzeXora(textForXora, postInfo.authorHandle, url, resolvedUrls);

    res.json({ ok: true, post: postInfo, authenticity: auth, xora, engagement: engagement || {}, source: 'fxtwitter' });
  } catch (err) {
    console.error('Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/replies', async (req, res) => {
  const { url, maxReplies } = req.body;
  if (!url || !url.match(/(x\.com|twitter\.com)\/\w+\/status\/\d+/)) {
    return res.status(400).json({ error: 'Invalid X/Twitter post URL' });
  }
  try {
    console.log('[replies] Starting for:', url);
    const { replies, opHandle, error } = await fetchRepliesFromXcancel(url, maxReplies || 50);
    const analysis = analyzeReplyQuality(replies, opHandle);
    res.json({ ok: true, opHandle, replyCount: replies.length, analysis, error: error || null });
  } catch (err) {
    console.error('[replies] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════
// LLM PROXY
// The API key stays server-side. The prompt is built here too, so this
// endpoint can't be used as an open relay to Gemini.
// ══════════════════════════════════════════════════════════════

const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';

function buildAnalysisPrompt(text, author) {
  return 'Analyze this X/Twitter post for authenticity. Respond ONLY with valid JSON, no markdown.\n' +
    'Post by: ' + author + '\nContent: """' + text + '"""\n\n' +
    'You judge HOW the post is written and how its engagement behaves. You are not\n' +
    'a fact checker of record. Rules about factual claims:\n' +
    '- Use the search tool before saying anything about whether a claim is true.\n' +
    '- If search confirms the claim, do not list it as a red flag.\n' +
    '- If you cannot confirm or refute it, say it is unverified. Never call a claim\n' +
    '  false, fake news, or misinformation on the basis that you have not heard of it.\n' +
    '  Exchange shutdowns, delistings and similar events happen constantly and are\n' +
    '  usually outside your training data.\n' +
    '- Reserve red flags for things visible in the post itself: engagement farming,\n' +
    '  urgency pressure, impersonation, phishing links, unrealistic guaranteed returns.\n\n' +
    'JSON schema:\n' +
    '{"tone":"one word","clickbait_score":0-100,"clickbait_explanation":"string",' +
    '"sentiment":"positive|negative|neutral|mixed","sentiment_detail":"one sentence",' +
    '"reply_quality":{"assessment":"genuine|mixed|likely_fake","explanation":"string"},' +
    '"red_flags":["string"],"green_flags":["string"],' +
    '"summary":"2-3 sentence natural language summary"}';
}

app.post('/api/llm', async (req, res) => {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return res.status(503).json({ error: 'LLM not configured on this server' });

  const text = String((req.body && req.body.text) || '').slice(0, 4000);
  const author = String((req.body && req.body.author) || 'unknown').slice(0, 100);
  if (!text.trim()) return res.status(400).json({ error: 'Missing post text' });

  try {
    const r = await fetch(GEMINI_BASE + '/models/' + GEMINI_MODEL + ':generateContent?key=' + key, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: buildAnalysisPrompt(text, author) }] }],
        // Grounding: without it the model rules on current events from memory
        // alone and calls real shutdowns "false news".
        tools: [{ google_search: {} }],
        // 2.5-flash spends "thinking" tokens from the same budget; 800 was
        // truncating the JSON mid-string
        generationConfig: { temperature: 0.3, maxOutputTokens: 4096 }
      })
    });
    const d = await r.json();
    if (d.error) throw new Error(d.error.message);
    const raw = d.candidates?.[0]?.content?.parts?.[0]?.text || '';
    const parsed = JSON.parse(raw.replace(/^```json\s*/i, '').replace(/```$/i, '').trim());
    res.json({ ok: true, analysis: parsed });
  } catch (err) {
    console.error('[llm] Error:', err.message);
    res.status(502).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════
// COASTY VISUAL ANALYSIS
// Playwright screenshots the post, Coasty vision API analyzes it
// ══════════════════════════════════════════════════════════════

const COASTY_API_KEY = process.env.COASTY_API_KEY;
const COASTY_BASE = 'https://coasty.ai/v1';

const { execSync } = require('child_process');

async function screenshotTweet(url) {
  const cleanUrl = url.replace('http://', 'https://');
  const apiUrl = 'https://image.thum.io/get/width/1280/crop/1200/' + cleanUrl;

  const resp = await fetch(apiUrl, {
    signal: AbortSignal.timeout(30000),
    headers: { 'Accept': 'image/png' }
  });

  if (!resp.ok) {
    throw new Error('Screenshot API error: ' + resp.status);
  }

  const arrayBuf = await resp.arrayBuffer();
  let buf = Buffer.from(arrayBuf);

  // thum.io may return GIF — convert to PNG via ffmpeg
  const header = buf.slice(0, 4).toString('ascii');
  if (header.startsWith('GIF')) {
    const tmpGif = '/tmp/screenshot_' + Date.now() + '.gif';
    const tmpPng = '/tmp/screenshot_' + Date.now() + '.png';
    require('fs').writeFileSync(tmpGif, buf);
    execSync(`ffmpeg -y -i "${tmpGif}" "${tmpPng}" 2>/dev/null`);
    buf = require('fs').readFileSync(tmpPng);
    require('fs').unlinkSync(tmpGif);
    require('fs').unlinkSync(tmpPng);
  }

  return buf;
}

async function analyzeVisual(screenshotBase64) {
  if (!COASTY_API_KEY) {
    throw new Error('Coasty API key not configured');
  }

  const body = JSON.stringify({
    screenshot: screenshotBase64,
    instruction: 'Analyze this X/Twitter post image. In your reasoning: describe what you see in detail, assess whether it looks original or manipulated, note any red flags or green flags, and rate visual authenticity 0-100. When done, click done.',
    screen_width: 1280,
    screen_height: 1200
  });

  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    const resp = await fetch(COASTY_BASE + '/predict', {
      method: 'POST',
      headers: {
        'X-API-Key': COASTY_API_KEY,
        'Content-Type': 'application/json'
      },
      body,
      signal: AbortSignal.timeout(90000)
    });

    if (resp.ok) return resp.json();

    const err = await resp.text();
    const parsed = JSON.parse(err);
    if (parsed.error?.retryable && attempt < 2) {
      console.log('[visual] Coasty', resp.status, 'retryable, attempt', attempt + 1);
      await new Promise(r => setTimeout(r, 2000));
      continue;
    }
    throw new Error('Coasty API error ' + resp.status + ': ' + err);
  }
}

app.post('/api/visual', async (req, res) => {
  const { url } = req.body;
  if (!url || !url.match(/(x\.com|twitter\.com)\/\w+\/status\/\d+/)) {
    return res.status(400).json({ error: 'Invalid X/Twitter post URL' });
  }

  try {
    console.log('[visual] Capturing screenshot for:', url);
    const startTime = Date.now();

    // Step 1: Screenshot
    const screenshotBuffer = await screenshotTweet(url);
    const screenshotBase64 = screenshotBuffer.toString('base64');
    console.log('[visual] Screenshot captured in', Date.now() - startTime, 'ms');

    // Step 2: Send to Coasty
    console.log('[visual] Sending to Coasty vision API...');
    const predictResp = await analyzeVisual(screenshotBase64);
    console.log('[visual] Coasty analysis done in', Date.now() - startTime, 'ms');

    // Step 3: Parse visual analysis from Coasty response
    const rawText = predictResp.reasoning || '';
    const lower = rawText.toLowerCase();

    // Extract Coasty's own authenticity score if mentioned (e.g. "85/100" or "~85")
    let score = null;
    const scoreMatch = rawText.match(/(?:~|approximately|about|around|visual authenticity[:\s]*|authenticity[:\s]*)(\d{1,3})\s*\/?\s*100/i)
      || rawText.match(/(\d{1,3})\s*\/\s*100/i)
      || rawText.match(/score[:\s]*(\d{1,3})/i);
    if (scoreMatch) {
      score = Math.max(0, Math.min(100, parseInt(scoreMatch[1])));
    }

    // Fallback: contextual sentiment analysis (not dumb keyword matching)
    if (score === null) {
      score = 50;
      const posPhrases = ['authentic', 'genuine', 'original content', 'real', 'legitimate', 'verified account', 'consistent with'];
      const negPhrases = ['deceptive', 'misleading', 'fake', 'scam', 'fraud', 'deepfake', 'stolen', 'impersonat'];
      const contextPos = ['intentionally', 'marketing', 'designed', 'composite art', 'professionally made', 'promotional'];
      const contextNeg = ['stock photo', 'watermark', 'no credit', 'unsourced'];

      posPhrases.forEach(p => { if (lower.includes(p)) score += 8; });
      negPhrases.forEach(p => { if (lower.includes(p)) score -= 12; });
      contextPos.forEach(p => { if (lower.includes(p)) score += 3; });
      contextNeg.forEach(p => { if (lower.includes(p)) score -= 8; });
      score = Math.max(0, Math.min(100, score));
    }

    // === Post-processing adjustments ===

    // 1. Image-text alignment boost: if Coasty says image matches/reinforces text
    const alignPhrases = ['matches', 'reinforce', 'consistent with the', 'complements', 'aligns with', 'relates to', 'relevant to', 'depicts', 'shows'];
    let alignCount = 0;
    alignPhrases.forEach(p => { if (lower.includes(p)) alignCount++; });
    if (alignCount >= 2) score += 15;       // strong alignment
    else if (alignCount >= 1) score += 8;   // moderate alignment

    // 2. Future date false positive fix: if Coasty flags "future date" but date is within 3 days of now
    if (lower.includes('future date') || lower.includes('future-dated')) {
      const dateMatch = rawText.match(/(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\w*\s+(\d{1,2}),?\s+(\d{4})/i);
      if (dateMatch) {
        const postDate = new Date(`${dateMatch[0]}`);
        const now = new Date();
        const diffDays = Math.abs(now - postDate) / (1000 * 60 * 60 * 24);
        if (diffDays <= 3) score += 10; // within 3 days = not actually future, reduce penalty
      }
    }

    // 3. Authenticity language boost: Coasty explicitly says "authentic" or "genuine"
    if (lower.includes('looks authentic') || lower.includes('appears authentic') || lower.includes('looks real') || lower.includes('appears genuine')) score += 10;

    // 4. Manipulation context: "composite" or "manipulated" in marketing/design context is OK
    if ((lower.includes('composite') || lower.includes('manipulat')) && (lower.includes('marketing') || lower.includes('promotional') || lower.includes('designed') || lower.includes('composite art'))) {
      score += 10; // reduce penalty for intentional design
    }

    score = Math.max(0, Math.min(100, score));

    const visual = {
      description: rawText || 'Visual analysis completed',
      score,
      credits_used: predictResp.usage?.credits_charged || 0
    };

    res.json({
      ok: true,
      screenshot: screenshotBase64,
      visual,
      coasty_status: predictResp.status,
      credits_used: predictResp.usage?.credits_charged || 0
    });
  } catch (err) {
    console.error('[visual] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/health', (req, res) => res.json({ ok: true }));

// Verify follow: screenshot → Coasty checks if user follows @coastyai
app.post('/api/verify-follow', express.json({ limit: '10mb' }), async (req, res) => {
  const { screenshot } = req.body;
  if (!screenshot) return res.status(400).json({ error: 'No screenshot provided' });

  try {
    console.log('[verify-follow] Checking screenshot...');
    const body = JSON.stringify({
      screenshot,
      instruction: 'Look at this screenshot. Does it show that the user is FOLLOWING the account @coastyai on X/Twitter? Check for: a "Following" button (not "Follow"), or the account page showing "Following" status. The interface may be in Indonesian — "Mengikuti" means Following, "Ikuti" means Follow. Reply ONLY with "YES" if following, or "NO" if not following. Then briefly explain what you see.',
      screen_width: 1280,
      screen_height: 1200
    });

    let predictResp;
    for (let attempt = 0; attempt < 3; attempt++) {
      const resp = await fetch(COASTY_BASE + '/predict', {
        method: 'POST',
        headers: { 'X-API-Key': COASTY_API_KEY, 'Content-Type': 'application/json' },
        body,
        signal: AbortSignal.timeout(90000)
      });
      if (resp.ok) { predictResp = await resp.json(); break; }
      const err = await resp.text();
      const parsed = JSON.parse(err);
      if (parsed.error?.retryable && attempt < 2) {
        await new Promise(r => setTimeout(r, 2000));
        continue;
      }
      throw new Error(parsed.error?.message || 'Coasty API error');
    }

    const reasoning = (predictResp.reasoning || '').toLowerCase();
    // Strict check: must start with "yes" or explicitly confirm following (EN + ID)
    const isVerified = reasoning.startsWith('yes')
      || /^yes[\s.,!]/.test(reasoning)
      || (reasoning.includes('is following') && !reasoning.includes('not following'))
      || (reasoning.includes('are following') && !reasoning.includes('not following'))
      || (reasoning.includes('following the account') && !reasoning.includes('not following'))
      || (reasoning.includes('mengikuti') && !reasoning.includes('tidak mengikuti'))
      || (reasoning.includes('sudah mengikuti') && !reasoning.includes('belum'));

    console.log('[verify-follow] Result:', isVerified);

    res.json({
      ok: true,
      verified: isVerified,
      reasoning: predictResp.reasoning || '',
      credits_used: predictResp.usage?.credits_charged || 0
    });
  } catch (err) {
    console.error('[verify-follow] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log('0XYAS API running on port ' + PORT);
});
