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
    return await resp.json();
  } catch (e) {
    console.log('Syndication fetch failed:', e.message);
    return null;
  }
}

// ── Scrape tweet page for engagement via meta tags ───────────
async function scrapeTweetPage(tweetUrl) {
  try {
    const resp = await fetch(tweetUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9'
      },
      redirect: 'follow'
    });
    const html = await resp.text();

    // Extract from og:meta tags
    const likes = extractMetaContent(html, 'twitter162:likes', /\"like_count\":(\d+)/);
    const retweets = extractMetaContent(html, 'twitter162:retweet_count', /\"retweet_count\":(\d+)/);
    const replies = extractMetaContent(html, 'twitter162:reply_count', /\"reply_count\":(\d+)/);
    const views = extractMetaContent(html, 'twitter162:impressions', /\"views_count\":(\d+)/) ||
                  extractMetaContent(html, 'og:description', /(\d[\d,.]*)\s*(views|impressions)/i);
    const quotes = extractMetaContent(html, 'twitter162:quote_count', /\"quote_count\":(\d+)/);

    return {
      likes: parseCount(likes),
      retweets: parseCount(retweets),
      replies: parseCount(replies),
      views: parseCount(views),
      quotes: parseCount(quotes)
    };
  } catch (e) {
    console.log('Scrape failed:', e.message);
    return null;
  }
}

function extractMetaContent(html, attrOrProp, regexFallback) {
  // Try property attribute first
  const propMatch = html.match(new RegExp('(?:property|name)="' + attrOrProp + '"[^>]*content="([^"]*)"'));
  if (propMatch) return propMatch[1];
  // Try regex fallback on full HTML
  if (regexFallback) {
    const m = html.match(regexFallback);
    if (m) return m[1];
  }
  return null;
}

function parseCount(str) {
  if (!str) return null;
  str = str.toString().replace(/[,\s]/g, '');
  if (/k$/i.test(str)) return Math.round(parseFloat(str) * 1000);
  if (/m$/i.test(str)) return Math.round(parseFloat(str) * 1000000);
  if (/b$/i.test(str)) return Math.round(parseFloat(str) * 1000000000);
  const n = parseInt(str, 10);
  return isNaN(n) ? null : n;
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

// ── Authenticity analyzer ───────────────────────────────────
function analyzeFromText(text, author, engagement) {
  let score = 75;
  const flags = [];
  const greenFlags = [];

  // ── Text-based checks ──
  if (/follow\s+back/i.test(text)) { score -= 8; flags.push('Contains "follow back" — potential engagement bait'); }
  if (/like\s+and\s+rt/i.test(text) || /retweet/i.test(text)) { score -= 5; flags.push('Contains retweet request — engagement farming signal'); }
  if (/giveaway/i.test(text)) { score -= 5; flags.push('Giveaway content — often associated with engagement farming'); }
  if (/airdrop/i.test(text) && /follow/i.test(text)) { score -= 8; flags.push('Airdrop + follow combo — common bot pattern'); }
  if (/dm\s+for/i.test(text)) { score -= 3; flags.push('DM solicitation — potential scam signal'); }
  if (/whitelist/i.test(text) || /wl\b/i.test(text)) { score -= 2; flags.push('Whitelist mention — common in engagement bait'); }
  if (/click\s+here|link\s+in\s+bio/i.test(text)) { score -= 3; flags.push('Link redirect language — suspicious'); }
  if (/limited\s+time|act\s+now|last\s+chance/i.test(text)) { score -= 4; flags.push('Urgency language — manipulation tactic'); }
  if (/guaranteed|100%\s+profit|risk[- ]free/i.test(text)) { score -= 6; flags.push('Unrealistic claims — high scam probability'); }

  // Hashtags & emojis
  const hashtags = (text.match(/#/g) || []).length;
  if (hashtags > 5) { score -= 5; flags.push('Excessive hashtags (' + hashtags + ') — spam signal'); }

  const emojis = (text.match(/[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F900}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu) || []).length;
  if (emojis > 10) { score -= 3; flags.push('Excessive emojis (' + emojis + ') — low-quality signal'); }

  // Positive text signals
  if (text.length > 100 && text.split(' ').length > 20) {
    score += 5;
    greenFlags.push('Long-form substantive content');
  }
  if (/#\w+/g.test(text) && hashtags <= 3) {
    score += 2;
    greenFlags.push('Moderate hashtag usage');
  }

  // ── Engagement-based checks ──
  if (engagement) {
    const { likes, retweets, replies, views, quotes } = engagement;

    // Reply spam detection
    if (replies !== null && likes !== null && likes > 0) {
      const replyToLikeRatio = replies / likes;
      if (replyToLikeRatio > 3) {
        score -= 15;
        flags.push('High reply-to-like ratio (' + replyToLikeRatio.toFixed(1) + 'x) — possible reply spam / bot replies');
      } else if (replyToLikeRatio > 1.5) {
        score -= 5;
        flags.push('Elevated reply-to-like ratio (' + replyToLikeRatio.toFixed(1) + 'x) — may indicate spam replies');
      } else {
        greenFlags.push('Healthy reply-to-like ratio');
      }
    }

    // Retweet farming detection
    if (retweets !== null && likes !== null && likes > 0) {
      const rtToLikeRatio = retweets / likes;
      if (rtToLikeRatio > 5) {
        score -= 12;
        flags.push('Very high retweet-to-like ratio (' + rtToLikeRatio.toFixed(1) + 'x) — retweet farming detected');
      } else if (rtToLikeRatio > 2) {
        score -= 5;
        flags.push('High retweet-to-like ratio (' + rtToLikeRatio.toFixed(1) + 'x) — possible RT farming');
      } else if (rtToLikeRatio < 0.5) {
        greenFlags.push('Natural engagement pattern (likes > retweets)');
      }
    }

    // View-to-engagement ratio
    if (views !== null && likes !== null && views > 100) {
      const engagementRate = ((likes + (replies || 0) + (retweets || 0)) / views * 100);
      if (engagementRate > 20) {
        score -= 8;
        flags.push('Abnormally high engagement rate (' + engagementRate.toFixed(1) + '%) — possible bot amplification');
      } else if (engagementRate > 5 && engagementRate < 15) {
        greenFlags.push('Healthy engagement rate (' + engagementRate.toFixed(1) + '%)');
      }
    }

    // Zero engagement on viral-looking content
    if (views !== null && views > 10000 && likes !== null && likes < 10) {
      score -= 10;
      flags.push('High views but near-zero likes — ghost traffic or botted views');
    }

    // Retweet count exceeding views (impossible)
    if (retweets !== null && views !== null && retweets > views && views > 0) {
      score -= 20;
      flags.push('Retweets exceed views — impossible metric, data anomaly or manipulation');
    }

    // High quote count with low original replies
    if (quotes !== null && replies !== null && quotes > replies * 2 && quotes > 20) {
      score -= 5;
      flags.push('High quote-to-reply ratio — content may be controversial or bait');
    }
  }

  score = Math.max(0, Math.min(100, score));

  return {
    score,
    trafficLight: score >= 60 ? 'green' : score >= 30 ? 'yellow' : 'red',
    flags,
    greenFlags,
    signals: {
      textLength: text.length,
      wordCount: text.split(/\s+/).length,
      hashtagCount: hashtags,
      emojiCount: emojis,
      hasCallToAction: /follow|like|rt|retweet|share|subscribe/i.test(text),
      hasLink: /https?:\/\//i.test(text),
      sentiment: detectSentiment(text),
      engagement: engagement || {}
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
    // Step 1: Get oembed data (author, text, date)
    console.log('[1/3] Fetching oembed data...');
    const oembed = await fetchOembed(url);
    const parsed = parseOembedHtml(oembed.html || '');

    const postInfo = {
      author: parsed.displayName || oembed.author_name || 'Unknown',
      authorHandle: parsed.handle || '@' + (oembed.author_name || 'unknown'),
      text: parsed.text || '(could not extract text)',
      date: parsed.date || null,
      url: url,
      tweetId: tweetId
    };

    // Step 2: Fetch engagement via syndication API
    console.log('[2/3] Fetching engagement metrics...');
    let engagement = null;

    const syndication = await fetchSyndication(tweetId);
    if (syndication) {
      engagement = {
        likes: syndication.likes ?? syndication.favorite_count ?? null,
        retweets: syndication.retweets ?? syndication.retweet_count ?? null,
        replies: syndication.replies ?? syndication.reply_count ?? null,
        views: syndication.views?.count ?? syndication.views ?? null,
        quotes: syndication.quotes ?? syndication.quote_count ?? null
      };
      console.log('  Syndication data:', JSON.stringify(engagement));
    }

    // Step 3: Scrape page as fallback for missing metrics
    console.log('[3/3] Scraping tweet page for engagement...');
    const scraped = await scrapeTweetPage(url);
    if (scraped) {
      if (!engagement) engagement = {};
      if (engagement.likes === null || engagement.likes === undefined) engagement.likes = scraped.likes;
      if (engagement.retweets === null || engagement.retweets === undefined) engagement.retweets = scraped.retweets;
      if (engagement.replies === null || engagement.replies === undefined) engagement.replies = scraped.replies;
      if (engagement.views === null || engagement.views === undefined) engagement.views = scraped.views;
      if (engagement.quotes === null || engagement.quotes === undefined) engagement.quotes = scraped.quotes;
      console.log('  Scraped data:', JSON.stringify(scraped));
    }

    // Analyze
    const auth = analyzeFromText(parsed.text || '', postInfo.author, engagement);
    const xora = analyzeXora(parsed.text || '', postInfo.authorHandle, url);

    res.json({
      ok: true,
      post: postInfo,
      authenticity: auth,
      xora: xora,
      engagement: engagement || {},
      source: syndication ? 'syndication+scrape' : 'oembed+scrape'
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
