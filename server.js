const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

// Serve frontend
app.use(express.static(path.join(__dirname, 'public')));

const PORT = 3100;

// ── Extract tweet ID from URL ─────────────────────────────────
function extractTweetId(url) {
  const m = url.match(/status\/(\d+)/);
  return m ? m[1] : null;
}

// ── Oembed fetch ─────────────────────────────────────────────
async function fetchOembed(tweetUrl) {
  const endpoint = 'https://publish.x.com/oembed?url=' + encodeURIComponent(tweetUrl);
  const resp = await fetch(endpoint, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; 0XYAS-Analyzer/1.0)' }
  });
  if (!resp.ok) throw new Error('Oembed returned ' + resp.status);
  return resp.json();
}

// ── Syndication API fetch (engagement metrics) ──────────────
async function fetchSyndication(tweetId) {
  try {
    const resp = await fetch('https://cdn.syndication.twimg.com/tweet-result?id=' + tweetId + '&lang=en', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Referer': 'https://publish.x.com/'
      }
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    if (!data || Object.keys(data).length === 0) return null;
    return data;
  } catch (e) {
    console.log('Syndication fetch failed:', e.message);
    return null;
  }
}

// ── fxtwitter API fetch (engagement metrics) ─────────────────
async function fetchFxTwitter(tweetUrl) {
  try {
    const fxUrl = 'https://api.fxtwitter.com/' + tweetUrl.replace(/https?:\/\/(www\.)?(x\.com|twitter\.com)\//, '');
    const resp = await fetch(fxUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    const t = data.tweet;
    if (!t) return null;
    return {
      likes: t.likes ?? t.favorite_count ?? null,
      retweets: t.retweets ?? t.retweet_count ?? null,
      replies: t.replies ?? t.reply_count ?? null,
      views: t.views ?? null,
      quotes: t.quotes ?? t.quote_count ?? null
    };
  } catch (e) {
    console.log('fxtwitter fetch failed:', e.message);
    return null;
  }
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

// ── Helpers ──────────────────────────────────────────────────
function fmtNum(n) {
  if (n === null || n === undefined) return 'N/A';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(n);
}

function detectSentiment(text) {
  const positive = /love|great|amazing|awesome|best|good|happy|excited|beautiful|perfect|incredible|insane|bullish|moon|gem/i;
  const negative = /hate|bad|worst|terrible|awful|ugly|boring|scam|fake|trash|bearish|rekt|dump|rug/i;
  const pos = (text.match(positive) || []).length;
  const neg = (text.match(negative) || []).length;
  if (pos > neg + 2) return 'very_positive';
  if (pos > neg) return 'positive';
  if (neg > pos + 2) return 'very_negative';
  if (neg > pos) return 'negative';
  return 'neutral';
}

// ── Authenticity analyzer (honest, varied scoring) ───────────
function analyzeFromText(text, author, engagement) {
  const breakdown = [];
  let score = 50; // start neutral — earn or lose points

  // ────────── 1. CONTENT DEPTH ──
  const words = text.split(/\s+/).filter(w => w.length > 0);
  const wc = words.length;
  const tl = text.length;

  if (wc <= 3) {
    score -= 15;
    breakdown.push({ cat: 'Content Depth', detail: 'Extremely short post (' + wc + ' words) — adds no value', pts: -15 });
  } else if (wc <= 8) {
    score -= 8;
    breakdown.push({ cat: 'Content Depth', detail: 'Very short post (' + wc + ' words) — minimal substance', pts: -8 });
  } else if (wc <= 15) {
    score -= 2;
    breakdown.push({ cat: 'Content Depth', detail: 'Short post (' + wc + ' words) — limited depth', pts: -2 });
  } else if (wc >= 40) {
    score += 12;
    breakdown.push({ cat: 'Content Depth', detail: 'Long-form substantive content (' + wc + ' words)', pts: 12 });
  } else if (wc >= 25) {
    score += 7;
    breakdown.push({ cat: 'Content Depth', detail: 'Good length content (' + wc + ' words)', pts: 7 });
  } else {
    score += 2;
    breakdown.push({ cat: 'Content Depth', detail: 'Moderate length (' + wc + ' words)', pts: 2 });
  }

  // ────────── 2. ORIGINALITY ──
  if (/^(RT|QT|cc)\s*[:@]/i.test(text) || /retweeted/i.test(text)) {
    score -= 8;
    breakdown.push({ cat: 'Originality', detail: 'Appears to be a retweet/quote — not original content', pts: -8 });
  } else if (wc > 10 && !/follow|like|rt|retweet|giveaway|airdrop/i.test(text)) {
    score += 5;
    breakdown.push({ cat: 'Originality', detail: 'Original content, no engagement farming language', pts: 5 });
  } else {
    breakdown.push({ cat: 'Originality', detail: 'Cannot determine originality', pts: 0 });
  }

  // ────────── 3. RED FLAGS (text patterns) ──
  let redFlagPts = 0;
  const redFlagDetails = [];
  if (/follow\s+back/i.test(text)) { redFlagPts -= 8; redFlagDetails.push('"follow back" — engagement bait'); }
  if (/like\s+and\s+rt/i.test(text) || /retweet/i.test(text)) { redFlagPts -= 5; redFlagDetails.push('retweet request — farming'); }
  if (/giveaway/i.test(text)) { redFlagPts -= 5; redFlagDetails.push('giveaway — farming signal'); }
  if (/airdrop/i.test(text) && /follow/i.test(text)) { redFlagPts -= 8; redFlagDetails.push('airdrop + follow combo — bot pattern'); }
  if (/dm\s+for/i.test(text)) { redFlagPts -= 3; redFlagDetails.push('DM solicitation — potential scam'); }
  if (/click\s+here|link\s+in\s+bio/i.test(text)) { redFlagPts -= 3; redFlagDetails.push('link redirect language — suspicious'); }
  if (/limited\s+time|act\s+now|last\s+chance/i.test(text)) { redFlagPts -= 4; redFlagDetails.push('urgency language — manipulation'); }
  if (/guaranteed|100%\s+profit|risk[- ]free/i.test(text)) { redFlagPts -= 6; redFlagDetails.push('unrealistic claims — scam signal'); }
  if (/whitelist|wl\b/i.test(text)) { redFlagPts -= 2; redFlagDetails.push('whitelist mention — bait'); }
  score += redFlagPts;
  if (redFlagDetails.length > 0) {
    breakdown.push({ cat: 'Red Flags', detail: redFlagDetails.join('; '), pts: redFlagPts });
  }

  // ────────── 4. SPAM SIGNALS ──
  const hashtags = (text.match(/#/g) || []).length;
  const emojis = (text.match(/[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F900}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu) || []).length;
  const links = text.match(/https?:\/\/[^\s]+/gi) || [];
  const upperChars = (text.match(/[A-Z]/g) || []).length;
  const letterChars = (text.match(/[a-zA-Z]/g) || []).length;
  const upperRatio = letterChars > 10 ? upperChars / letterChars : 0;

  let spamPts = 0;
  const spamDetails = [];
  if (hashtags > 10) { spamPts -= 10; spamDetails.push('extreme hashtag spam (' + hashtags + ')'); }
  else if (hashtags > 5) { spamPts -= 5; spamDetails.push('excessive hashtags (' + hashtags + ')'); }
  else if (hashtags > 0 && hashtags <= 3) { spamPts += 2; }
  if (emojis > 15) { spamPts -= 5; spamDetails.push('extreme emoji spam (' + emojis + ')'); }
  else if (emojis > 10) { spamPts -= 3; spamDetails.push('excessive emojis (' + emojis + ')'); }
  if (links.length > 3) { spamPts -= 5; spamDetails.push('multiple links (' + links.length + ')'); }
  if (upperRatio > 0.7 && letterChars > 10) { spamPts -= 5; spamDetails.push('excessive uppercase (' + Math.round(upperRatio * 100) + '%)'); }
  score += spamPts;
  if (spamDetails.length > 0) {
    breakdown.push({ cat: 'Spam Signals', detail: spamDetails.join('; '), pts: spamPts });
  }

  // ────────── 5. ENGAGEMENT QUALITY ──
  if (engagement) {
    const { likes, retweets, replies, views, quotes } = engagement;

    // 5a. Engagement rate (real people interacting vs passive views)
    if (views !== null && likes !== null && views > 100) {
      const engRate = ((likes + (replies || 0) + (retweets || 0)) / views * 100);
      if (engRate > 25) {
        score -= 10;
        breakdown.push({ cat: 'Engagement Rate', detail: 'Abnormally high (' + engRate.toFixed(1) + '%) — possible bot amplification', pts: -10 });
      } else if (engRate > 8) {
        score += 8;
        breakdown.push({ cat: 'Engagement Rate', detail: 'Strong engagement (' + engRate.toFixed(1) + '%) — real audience interacting', pts: 8 });
      } else if (engRate > 3) {
        score += 4;
        breakdown.push({ cat: 'Engagement Rate', detail: 'Decent engagement (' + engRate.toFixed(1) + '%)', pts: 4 });
      } else if (engRate < 0.5 && views > 5000) {
        score -= 5;
        breakdown.push({ cat: 'Engagement Rate', detail: 'Very low (' + engRate.toFixed(2) + '%) with high views — possible botted views', pts: -5 });
      } else {
        breakdown.push({ cat: 'Engagement Rate', detail: 'Below average (' + engRate.toFixed(2) + '%)', pts: 0 });
      }
    }

    // 5b. Reply quality — are replies meaningful discussions or spam?
    if (replies !== null && likes !== null && likes > 0) {
      const rlRatio = replies / likes;
      if (rlRatio > 5) {
        score -= 18;
        breakdown.push({ cat: 'Reply Quality', detail: 'Extreme reply/like ratio (' + rlRatio.toFixed(1) + 'x) — likely spam replies or controversial bait', pts: -18 });
      } else if (rlRatio > 3) {
        score -= 12;
        breakdown.push({ cat: 'Reply Quality', detail: 'High reply/like ratio (' + rlRatio.toFixed(1) + 'x) — possible spam or heated argument', pts: -12 });
      } else if (rlRatio > 1.5) {
        score -= 4;
        breakdown.push({ cat: 'Reply Quality', detail: 'Above-average replies (' + rlRatio.toFixed(1) + 'x) — active discussion', pts: -4 });
      } else if (rlRatio > 0.3) {
        score += 6;
        breakdown.push({ cat: 'Reply Quality', detail: 'Healthy discussion ratio (' + rlRatio.toFixed(2) + 'x) — real conversations', pts: 6 });
      } else {
        score += 2;
        breakdown.push({ cat: 'Reply Quality', detail: 'Low reply ratio (' + rlRatio.toFixed(2) + 'x) — passive audience', pts: 2 });
      }
    }

    // 5c. Retweet farming vs organic sharing
    if (retweets !== null && likes !== null && likes > 0) {
      const rtRatio = retweets / likes;
      if (rtRatio > 5) {
        score -= 15;
        breakdown.push({ cat: 'RT Pattern', detail: 'Extreme RT/like ratio (' + rtRatio.toFixed(1) + 'x) — retweet farming detected', pts: -15 });
      } else if (rtRatio > 2) {
        score -= 6;
        breakdown.push({ cat: 'RT Pattern', detail: 'High RT/like ratio (' + rtRatio.toFixed(1) + 'x) — possible forced sharing', pts: -6 });
      } else if (rtRatio < 0.3 && likes > 50) {
        score += 6;
        breakdown.push({ cat: 'RT Pattern', detail: 'Likes dominate RTs (' + rtRatio.toFixed(2) + 'x) — organic appreciation', pts: 6 });
      } else {
        breakdown.push({ cat: 'RT Pattern', detail: 'Normal RT pattern (' + rtRatio.toFixed(2) + 'x)', pts: 0 });
      }
    }

    // 5d. Quote engagement — discussion quality
    if (quotes !== null && replies !== null && quotes > 0 && replies > 0) {
      const qRatio = quotes / replies;
      if (qRatio > 3 && quotes > 30) {
        score -= 5;
        breakdown.push({ cat: 'Discussion Quality', detail: 'High quote/reply ratio (' + qRatio.toFixed(1) + 'x) — people quote instead of discuss', pts: -5 });
      } else if (qRatio > 1 && quotes > 20) {
        score += 3;
        breakdown.push({ cat: 'Discussion Quality', detail: 'Active quoting (' + qRatio.toFixed(1) + 'x) — content sparking conversation', pts: 3 });
      }
    }

    // 5e. Ghost traffic / impossible metrics
    if (views !== null && views > 10000 && likes !== null && likes < 5) {
      score -= 15;
      breakdown.push({ cat: 'Traffic Legitimacy', detail: 'High views (' + fmtNum(views) + ') but near-zero likes — ghost traffic likely', pts: -15 });
    }
    if (retweets !== null && views !== null && retweets > views && views > 0) {
      score -= 25;
      breakdown.push({ cat: 'Traffic Legitimacy', detail: 'Retweets exceed views — impossible metric, data anomaly', pts: -25 });
    }

    // 5f. Raw numbers context
    if (likes !== null && likes > 5000) {
      score += 5;
      breakdown.push({ cat: 'Popularity', detail: 'High like count (' + fmtNum(likes) + ') — broad appeal', pts: 5 });
    } else if (likes !== null && likes > 1000) {
      score += 3;
      breakdown.push({ cat: 'Popularity', detail: 'Good like count (' + fmtNum(likes) + ')', pts: 3 });
    }

    // 5g. Replies with no likes = possibly botted replies
    if (replies !== null && likes !== null && replies > 50 && likes < 10) {
      score -= 10;
      breakdown.push({ cat: 'Reply Authenticity', detail: 'Many replies (' + fmtNum(replies) + ') but few likes (' + fmtNum(likes) + ') — possible bot replies', pts: -10 });
    }
  } else {
    breakdown.push({ cat: 'Engagement', detail: 'No engagement data available — limited analysis', pts: 0 });
  }

  // Clamp
  score = Math.max(0, Math.min(100, score));

  // Determine label
  let label;
  if (score >= 80) label = 'High quality — genuine content with real engagement';
  else if (score >= 65) label = 'Good quality — mostly authentic';
  else if (score >= 50) label = 'Average — some concerns detected';
  else if (score >= 35) label = 'Below average — multiple red flags';
  else label = 'Low quality — likely spam, farming, or inauthentic';

  return {
    score,
    label,
    trafficLight: score >= 65 ? 'green' : score >= 40 ? 'yellow' : 'red',
    breakdown,
    flags: breakdown.filter(b => b.pts < 0).map(b => b.detail),
    greenFlags: breakdown.filter(b => b.pts > 0).map(b => b.detail),
    signals: {
      textLength: tl,
      wordCount: wc,
      hashtagCount: hashtags,
      emojiCount: emojis,
      linkCount: links.length,
      hasCallToAction: /follow|like|rt|retweet|share|subscribe/i.test(text),
      sentiment: detectSentiment(text),
      engagement: engagement || {}
    }
  };
}

// ── XORA.FINANCE SPECIFIC ANALYSIS ──────────────────────────
function analyzeXora(text, authorHandle, url) {
  // Only runs if post is about XORA
  const isXoraRelated = /xora|xrp\s*neobank|xora_finance|xora\.finance/i.test(text) ||
                        /xora\.finance/i.test(url);
  if (!isXoraRelated) return null;

  const officialHandle = 'xora_finance';
  const officialDomain = 'xora.finance';
  const flags = [];
  const greenFlags = [];
  const checks = {};
  let trustScore = 50; // neutral start

  // ── 1. Official account mention ──
  const mentionsOfficial = /@xora_finance/i.test(text) || /xora_finance/i.test(text);
  checks.mentionsOfficial = mentionsOfficial;
  if (mentionsOfficial) {
    greenFlags.push('Mentions official @xora_finance account');
    trustScore += 15;
  } else {
    flags.push('Does NOT mention @xora_finance — could be impersonator');
    trustScore -= 10;
  }

  // ── 2. Link analysis ──
  const links = text.match(/https?:\/\/[^\s]+/gi) || [];
  checks.links = links;
  checks.linkCount = links.length;

  const hasOfficialLink = links.some(l => /xora\.finance/i.test(l));
  const hasFakeLink = links.some(l =>
    /xorafinance\.com/i.test(l) ||
    /xora-?finance\.(com|net|org|xyz|io)/i.test(l) ||
    /xora\.(?!finance)/i.test(l)
  );
  const hasScamLink = links.some(l =>
    /bit\.ly|tinyurl|t\.co/i.test(l) && !l.includes('t.co/') // shortened but not X native
  );

  checks.hasOfficialLink = hasOfficialLink;
  checks.hasFakeLink = hasFakeLink;

  if (hasOfficialLink) {
    greenFlags.push('Links to official xora.finance domain');
    trustScore += 15;
  }
  if (hasFakeLink) {
    flags.push('Contains FAKE XORA domain — HIGH scam risk');
    trustScore -= 30;
  }
  if (hasScamLink) {
    flags.push('Uses shortened/suspicious link — verify destination');
    trustScore -= 10;
  }
  if (links.length === 0) {
    greenFlags.push('No external links — lower phishing risk');
  }

  // ── 3. CTA (Call to Action) analysis ──
  const ctaPatterns = [
    { re: /sign\s*up|register|join|open\s*(your)?\s*account/i, label: 'Sign-up CTA' },
    { re: /deposit|send\s*xrp|transfer/i, label: 'Deposit CTA' },
    { re: /click\s*(the\s*)?link|link\s*in\s*(bio|thread|comments)/i, label: 'Link redirect CTA' },
    { re: /dm\s*(me|for)|message\s*me/i, label: 'DM solicitation' },
    { re: /limited\s*time|hurry|act\s*now|last\s*chance|ending\s*soon/i, label: 'Urgency CTA' },
    { re: /follow.*like.*rt|like.*retweet.*follow|rt\s*&?\s*follow/i, label: 'Engagement bait CTA' },
    { re: /whitelist|wl\s*spot|guaranteed\s*spot/i, label: 'Whitelist CTA' },
    { re: /claim|claim\s*now|claim\s*your/i, label: 'Claim CTA' },
  ];

  const detectedCtas = [];
  ctaPatterns.forEach(p => {
    if (p.re.test(text)) {
      detectedCtas.push(p.label);
    }
  });
  checks.ctas = detectedCtas;

  // High-risk CTAs
  const highRiskCtas = ['Link redirect CTA', 'DM solicitation', 'Urgency CTA', 'Claim CTA'];
  const hasHighRiskCta = detectedCtas.some(c => highRiskCtas.includes(c));
  if (hasHighRiskCta) {
    flags.push('High-risk CTA detected: ' + detectedCtas.filter(c => highRiskCtas.includes(c)).join(', '));
    trustScore -= 15;
  }
  if (detectedCtas.length > 2) {
    flags.push('Multiple CTAs (' + detectedCtas.length + ') — aggressive promotion pattern');
    trustScore -= 5;
  }
  if (detectedCtas.length === 0) {
    greenFlags.push('No aggressive CTAs detected');
    trustScore += 5;
  }

  // ── 4. Hashtag analysis ──
  const xoraHashtags = (text.match(/#xora|#xorafinance|#xrpl|#xrp\s*neobank|#xora\s*finance/gi) || []);
  const spammyHashtags = (text.match(/#crypto|#defi|#airdrop|#giveaway|#whitelist|#freemoney|#passive\s*income/gi) || []);
  checks.xoraHashtags = xoraHashtags;
  checks.spammyHashtags = spammyHashtags;

  if (xoraHashtags.length > 0) {
    greenFlags.push('Uses relevant XORA/XRP hashtags');
    trustScore += 5;
  }
  if (spammyHashtags.length > 2) {
    flags.push('Spammy hashtag cluster: ' + spammyHashtags.slice(0, 3).join(', '));
    trustScore -= 10;
  }

  // ── 5. APY / yield claims ──
  const apyMatch = text.match(/(\d+(?:\.\d+)?)\s*%\s*(?:apy|apy\s*value|yield)/i);
  checks.claimedApy = apyMatch ? parseFloat(apyMatch[1]) : null;
  if (apyMatch) {
    const claimed = parseFloat(apyMatch[1]);
    if (claimed > 25) {
      flags.push('Claims ' + claimed + '% APY — exceeds official 22% maximum');
      trustScore -= 15;
    } else if (claimed <= 22) {
      greenFlags.push('APY claim (' + claimed + '%) within official range');
      trustScore += 5;
    }
  }

  // ── 6. Impersonation check ──
  const authorLower = (authorHandle || '').toLowerCase().replace('@', '');
  const isImpersonator = /xora/i.test(authorLower) && authorLower !== officialHandle;
  checks.isImpersonator = isImpersonator;
  if (isImpersonator) {
    flags.push('Author @' + authorLower + ' may impersonate official @' + officialHandle);
    trustScore -= 20;
  }

  // ── 7. Scam keyword check ──
  const scamPatterns = [
    /guaranteed\s*profit/i,
    /risk[\s-]*free/i,
    /double\s*(your|my)\s*(xrp|crypto)/i,
    /send\s*\d+.*get\s*\d+/i,
    /seed\s*phrase|private\s*key|mnemonic/i,
    /pre[\s-]*order.*card/i,
    /kyc\s*bypass|no\s*kyc/i,
  ];
  scamPatterns.forEach(p => {
    if (p.test(text)) {
      flags.push('Scam keyword pattern: ' + p.source.slice(0, 30) + '...');
      trustScore -= 15;
    }
  });

  // Clamp trust score
  trustScore = Math.max(0, Math.min(100, trustScore));

  return {
    isXoraPost: true,
    trustScore,
    trafficLight: trustScore >= 65 ? 'green' : trustScore >= 40 ? 'yellow' : 'red',
    checks,
    flags,
    greenFlags,
    summary: generateXoraSummary(checks, flags, greenFlags, trustScore)
  };
}

function generateXoraSummary(checks, flags, greenFlags, score) {
  const parts = [];
  if (checks.mentionsOfficial) {
    parts.push('Post references the official @xora_finance account');
  } else {
    parts.push('Post does NOT reference @xora_finance — proceed with caution');
  }
  if (checks.hasOfficialLink) parts.push('Contains verified xora.finance link');
  if (checks.hasFakeLink) parts.push('⚠ Contains a fake/cloned XORA domain');
  if (checks.ctas.length > 0) parts.push('CTAs detected: ' + checks.ctas.join(', '));
  if (checks.claimedApy) {
    if (checks.claimedApy > 22) parts.push('APY claim exceeds official maximum');
    else parts.push('APY claim within official range');
  }
  if (checks.isImpersonator) parts.push('Author may be impersonating XORA');
  return parts.join('. ') + '. Trust score: ' + score + '/100.';
}

// ── Reply fetcher (xcancel.com scraping) ──────────────────────
function parseRepliesFromHtml(html) {
  const replies = [];
  // Split by timeline-item
  const parts = html.split('<div class="timeline-item ');
  for (let i = 1; i < parts.length; i++) {
    const item = parts[i];
    // Author
    const nameM = item.match(/class="fullname"[^>]*>([^<]+)/);
    const handleM = item.match(/class="username"[^>]*>([^<]+)/);
    // Content
    const contentM = item.match(/class="tweet-content[^"]*"[^>]*>([\s\S]*?)<\/div>/);
    const text = contentM ? contentM[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : '';
    // Stats
    const statMatches = [...item.matchAll(/icon-(comment|retweet|heart|views)"[^>]*><\/span>\s*([^<]*)/g)];
    const stats = {};
    statMatches.forEach(m => {
      const key = m[1] === 'comment' ? 'replies' : m[1] === 'heart' ? 'likes' : m[1];
      const val = m[2].trim().replace(/,/g, '');
      stats[key] = val && !isNaN(val) ? parseInt(val, 10) : null;
    });
    // Is this a reply?
    const isReply = item.includes('replying-to');
    const replyToM = item.match(/replying-to.*?href="\/(\w+)"/);
    // Tweet link (for ID)
    const linkM = item.match(/href="\/(\w+)\/status\/(\d+)/);

    if (text || nameM) {
      replies.push({
        author: nameM ? nameM[1].trim() : 'Unknown',
        handle: handleM ? handleM[1].trim() : '@unknown',
        text: text,
        replies: stats.replies || null,
        retweets: stats.retweets || null,
        likes: stats.likes || null,
        views: stats.views || null,
        isReply: isReply,
        replyTo: replyToM ? '@' + replyToM[1] : null,
        tweetId: linkM ? linkM[2] : null,
        authorIsOP: false // will be set later
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

  let allReplies = [];
  let cursor = null;
  let pages = 0;
  const maxPages = 3; // limit pagination

  try {
    // First page
    console.log('[replies] Fetching page 1 from xcancel...');
    let resp = await fetch(baseUrl, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(12000) });
    if (!resp.ok) throw new Error('xcancel returned ' + resp.status);
    let html = await resp.text();
    allReplies = parseRepliesFromHtml(html);
    cursor = extractCursor(html);
    pages++;

    // Get author handle from first post on page to identify OP
    const opMatch = html.match(/data-username="(\w+)"/);
    const opHandle = opMatch ? '@' + opMatch[1].toLowerCase() : null;
    allReplies.forEach(r => {
      r.authorIsOP = opHandle && r.handle.toLowerCase().replace('@', '') === opHandle.replace('@', '');
    });

    // Paginate
    while (cursor && allReplies.length < maxReplies && pages < maxPages) {
      pages++;
      console.log('[replies] Fetching page ' + pages + '...');
      await new Promise(r => setTimeout(r, 800)); // rate limit
      const pageUrl = baseUrl + '?cursor=' + encodeURIComponent(cursor);
      resp = await fetch(pageUrl, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(12000) });
      if (!resp.ok) break;
      html = await resp.text();
      const newReplies = parseRepliesFromHtml(html);
      newReplies.forEach(r => {
        r.authorIsOP = opHandle && r.handle.toLowerCase().replace('@', '') === opHandle.replace('@', '');
      });
      allReplies = allReplies.concat(newReplies);
      cursor = extractCursor(html);
    }

    console.log('[replies] Got ' + allReplies.length + ' items across ' + pages + ' pages');
    return { replies: allReplies.slice(0, maxReplies), opHandle };
  } catch (e) {
    console.log('[replies] Error:', e.message);
    return { replies: [], opHandle: null, error: e.message };
  }
}

function analyzeReplyQuality(replies, opHandle) {
  if (!replies || replies.length === 0) {
    return { score: null, detail: 'No replies fetched', replies: [], summary: 'Could not load replies for analysis.' };
  }

  const realReplies = replies.filter(r => r.isReply);
  const originalPosts = replies.filter(r => !r.isReply);
  const opReplies = replies.filter(r => r.authorIsOP);
  const uniqueAuthors = new Set(replies.map(r => r.handle.toLowerCase()));

  let score = 50;
  const breakdown = [];
  const flags = [];
  const greenFlags = [];

  // 1. OP engagement — did the original poster reply?
  if (opReplies.length > 0) {
    score += 10;
    greenFlags.push('OP engaged in discussion (' + opReplies.length + ' replies)');
    breakdown.push({ cat: 'OP Engagement', detail: 'Original author replied ' + opReplies.length + ' time(s) — active discussion', pts: 10 });
  } else {
    score -= 3;
    breakdown.push({ cat: 'OP Engagement', detail: 'OP did not reply — one-way broadcast', pts: -3 });
  }

  // 2. Unique participants — real discussion or same people?
  const participantRatio = uniqueAuthors.size / Math.max(replies.length, 1);
  if (participantRatio > 0.7) {
    score += 8;
    greenFlags.push('Diverse participants (' + uniqueAuthors.size + ' unique authors in ' + replies.length + ' posts)');
    breakdown.push({ cat: 'Participant Diversity', detail: uniqueAuthors.size + ' unique voices in ' + replies.length + ' posts — real community discussion', pts: 8 });
  } else if (participantRatio > 0.4) {
    score += 3;
    breakdown.push({ cat: 'Participant Diversity', detail: uniqueAuthors.size + ' unique authors in ' + replies.length + ' posts — moderate diversity', pts: 3 });
  } else {
    score -= 5;
    flags.push('Low participant diversity — same people replying repeatedly');
    breakdown.push({ cat: 'Participant Diversity', detail: 'Only ' + uniqueAuthors.size + ' unique authors in ' + replies.length + ' posts — repetitive', pts: -5 });
  }

  // 3. Reply content quality — are replies substantive or empty?
  const substantiveReplies = realReplies.filter(r => r.text.split(/\s+/).length > 5);
  const emptyReplies = realReplies.filter(r => r.text.length < 10);
  const subRatio = realReplies.length > 0 ? substantiveReplies.length / realReplies.length : 0;

  if (subRatio > 0.7) {
    score += 10;
    greenFlags.push('High-quality replies (' + Math.round(subRatio * 100) + '% substantive)');
    breakdown.push({ cat: 'Reply Depth', detail: Math.round(subRatio * 100) + '% of replies have real substance (>5 words)', pts: 10 });
  } else if (subRatio > 0.4) {
    score += 3;
    breakdown.push({ cat: 'Reply Depth', detail: Math.round(subRatio * 100) + '% substantive replies — mixed quality', pts: 3 });
  } else {
    score -= 5;
    flags.push('Most replies are low-effort (<5 words)');
    breakdown.push({ cat: 'Reply Depth', detail: 'Only ' + Math.round(subRatio * 100) + '% substantive — most replies are empty/shallow', pts: -5 });
  }

  // 4. Engagement spread — do some replies get likes (real discussion)?
  const repliedWithLikes = realReplies.filter(r => r.likes !== null && r.likes > 5);
  if (repliedWithLikes.length > realReplies.length * 0.3 && realReplies.length > 3) {
    score += 7;
    greenFlags.push('Multiple replies have engagement — real conversations happening');
    breakdown.push({ cat: 'Reply Engagement', detail: repliedWithLikes.length + '/' + realReplies.length + ' replies have >5 likes — active threads', pts: 7 });
  } else if (repliedWithLikes.length > 1) {
    breakdown.push({ cat: 'Reply Engagement', detail: repliedWithLikes.length + ' replies with >5 likes — some engagement', pts: 0 });
  } else {
    score -= 3;
    breakdown.push({ cat: 'Reply Engagement', detail: 'Replies have near-zero engagement — possible bot/fake replies', pts: -3 });
  }

  // 5. Bot patterns — identical or near-identical replies
  const texts = realReplies.map(r => r.text.toLowerCase().trim());
  const uniqueTexts = new Set(texts);
  const duplicateRatio = realReplies.length > 0 ? 1 - (uniqueTexts.size / realReplies.length) : 0;
  if (duplicateRatio > 0.3) {
    score -= 15;
    flags.push('High duplicate reply content (' + Math.round(duplicateRatio * 100) + '% similar) — bot/spam pattern');
    breakdown.push({ cat: 'Duplicate Detection', detail: Math.round(duplicateRatio * 100) + '% of replies are near-identical — likely bot spam', pts: -15 });
  } else if (duplicateRatio > 0.1) {
    score -= 5;
    flags.push('Some duplicate replies detected (' + Math.round(duplicateRatio * 100) + '%)');
    breakdown.push({ cat: 'Duplicate Detection', detail: Math.round(duplicateRatio * 100) + '% similar replies — mild concern', pts: -5 });
  }

  // 6. Spam/CTA in replies
  let spamReplyCount = 0;
  realReplies.forEach(r => {
    if (/follow\s+back|like\s+and\s+rt|giveaway|dm\s+for|check\s+my|link\s+in\s+bio/i.test(r.text)) {
      spamReplyCount++;
    }
  });
  const spamRatio = realReplies.length > 0 ? spamReplyCount / realReplies.length : 0;
  if (spamRatio > 0.2) {
    score -= 10;
    flags.push('Spam replies detected (' + Math.round(spamRatio * 100) + '% contain CTAs/farming)');
    breakdown.push({ cat: 'Spam Replies', detail: Math.round(spamRatio * 100) + '% of replies contain engagement bait/spam', pts: -10 });
  }

  // 7. Follower weight — check if repliers look like real accounts (via views)
  // High views on replies = real people seeing them
  const totalReplyViews = realReplies.reduce((sum, r) => sum + (r.views || 0), 0);
  const avgReplyViews = realReplies.length > 0 ? totalReplyViews / realReplies.length : 0;
  if (avgReplyViews > 10000) {
    score += 5;
    greenFlags.push('Replies have significant visibility (' + fmtNum(Math.round(avgReplyViews)) + ' avg views)');
    breakdown.push({ cat: 'Reply Visibility', detail: 'Average ' + fmtNum(Math.round(avgReplyViews)) + ' views per reply — real audience', pts: 5 });
  }

  score = Math.max(0, Math.min(100, score));

  let label;
  if (score >= 80) label = 'Excellent discussion quality — genuine community engagement';
  else if (score >= 65) label = 'Good discussion — mostly real conversations';
  else if (score >= 50) label = 'Average discussion — some noise mixed in';
  else if (score >= 35) label = 'Below average — significant spam/bot activity in replies';
  else label = 'Poor discussion quality — likely manipulated';

  return {
    score,
    label,
    trafficLight: score >= 65 ? 'green' : score >= 40 ? 'yellow' : 'red',
    breakdown,
    flags,
    greenFlags,
    stats: {
      totalReplies: replies.length,
      realReplies: realReplies.length,
      originalPosts: originalPosts.length,
      opReplies: opReplies.length,
      uniqueAuthors: uniqueAuthors.size,
      substantiveReplies: substantiveReplies.length,
      emptyReplies: emptyReplies.length,
      spamReplies: spamReplyCount
    },
    sampleReplies: realReplies.slice(0, 10).map(r => ({
      author: r.author,
      handle: r.handle,
      text: r.text.slice(0, 200),
      likes: r.likes,
      replies: r.replies,
      isOP: r.authorIsOP
    }))
  };
}

// ── API ──────────────────────────────────────────────────────
app.post('/api/analyze', async (req, res) => {
  const { url } = req.body;

  if (!url || !url.match(/(x\.com|twitter\.com)\/\w+\/status\/\d+/)) {
    return res.status(400).json({ error: 'Invalid X/Twitter post URL' });
  }

  const tweetId = extractTweetId(url);
  if (!tweetId) {
    return res.status(400).json({ error: 'Could not extract tweet ID from URL' });
  }

  try {
    // Step 1: Get post data — try oembed first, fxtwitter as fallback
    console.log('[1/3] Fetching post data...');
    let postInfo = null;
    let engagement = null;

    // Try oembed first
    try {
      const oembed = await fetchOembed(url);
      const parsed = parseOembedHtml(oembed.html || '');
      postInfo = {
        author: parsed.displayName || oembed.author_name || 'Unknown',
        authorHandle: parsed.handle || '@' + (oembed.author_name || 'unknown'),
        text: parsed.text || null,
        date: parsed.date || null,
        url: url,
        tweetId: tweetId
      };
    } catch (e) {
      console.log('  Oembed failed:', e.message);
    }

    // fxtwitter for engagement + fill missing post info
    console.log('[2/3] Fetching engagement via fxtwitter...');
    const fxData = await fetchFxTwitter(url);
    if (fxData) {
      engagement = fxData;
      console.log('  fxtwitter data:', JSON.stringify(engagement));
    }

    // If oembed failed, try to get post info from fxtwitter's full tweet data
    if (!postInfo || !postInfo.text || postInfo.text === '(could not extract text)') {
      try {
        const fxFullUrl = 'https://api.fxtwitter.com/' + url.replace(/https?:\/\/(www\.)?(x\.com|twitter\.com)\//, '');
        const fxResp = await fetch(fxFullUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        if (fxResp.ok) {
          const fxFull = await fxResp.json();
          const t = fxFull.tweet;
          if (t) {
            postInfo = postInfo || {};
            postInfo.author = postInfo.author || t.author?.name || 'Unknown';
            postInfo.authorHandle = postInfo.authorHandle || '@' + (t.author?.screen_name || 'unknown');
            postInfo.text = postInfo.text || t.text || '(could not extract text)';
            postInfo.date = postInfo.date || t.created_at || null;
            if (engagement) {
              engagement.likes = engagement.likes ?? t.likes ?? null;
              engagement.retweets = engagement.retweets ?? t.retweets ?? null;
              engagement.replies = engagement.replies ?? t.replies ?? null;
              engagement.views = engagement.views ?? t.views ?? null;
            }
            console.log('  fxtwitter full tweet data used for post info');
          }
        }
      } catch (e) {
        console.log('  fxtwitter full fetch failed:', e.message);
      }
    }

    if (!postInfo) {
      return res.status(500).json({ error: 'Could not fetch tweet data. The tweet may be deleted or private.' });
    }

    // Ensure required fields
    postInfo.text = postInfo.text || '(could not extract text)';
    postInfo.authorHandle = postInfo.authorHandle || '@unknown';

    // Fallback: syndication API for missing engagement
    if (!engagement || Object.values(engagement).every(v => v === null)) {
      const syndication = await fetchSyndication(tweetId);
      if (syndication) {
        if (!engagement) engagement = {};
        engagement.likes = engagement.likes ?? syndication.likes ?? syndication.favorite_count ?? null;
        engagement.retweets = engagement.retweets ?? syndication.retweets ?? syndication.retweet_count ?? null;
        engagement.replies = engagement.replies ?? syndication.replies ?? syndication.reply_count ?? null;
        engagement.views = engagement.views ?? syndication.views?.count ?? syndication.views ?? null;
        engagement.quotes = engagement.quotes ?? syndication.quotes ?? syndication.quote_count ?? null;
        console.log('  Syndication fallback:', JSON.stringify(engagement));
      }
    }

    console.log('[3/3] Analysis complete.');

    // Analyze
    const auth = analyzeFromText(postInfo.text, postInfo.author, engagement);
    const xora = analyzeXora(postInfo.text, postInfo.authorHandle, url);

    res.json({
      ok: true,
      post: postInfo,
      authenticity: auth,
      xora: xora,
      engagement: engagement || {},
      source: 'fxtwitter'
    });

  } catch (err) {
    console.error('Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Replies endpoint ────────────────────────────────────────
app.post('/api/replies', async (req, res) => {
  const { url, maxReplies } = req.body;

  if (!url || !url.match(/(x\.com|twitter\.com)\/\w+\/status\/\d+/)) {
    return res.status(400).json({ error: 'Invalid X/Twitter post URL' });
  }

  try {
    console.log('[replies] Starting reply fetch for:', url);
    const { replies, opHandle, error } = await fetchRepliesFromXcancel(url, maxReplies || 50);
    const analysis = analyzeReplyQuality(replies, opHandle);

    res.json({
      ok: true,
      opHandle,
      replyCount: replies.length,
      analysis,
      error: error || null
    });
  } catch (err) {
    console.error('[replies] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/health', (req, res) => res.json({ ok: true }));

app.listen(PORT, '0.0.0.0', () => {
  console.log('0XYAS API running on port ' + PORT);
});
