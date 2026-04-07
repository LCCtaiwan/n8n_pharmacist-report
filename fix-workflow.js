#!/usr/bin/env node
// fix-workflow.js
// Transforms workflow.json → workflow-fixed.json
// Changes:
//   1. Remove all RSS fetch nodes, Merge, Parse, RemoveDuplicates, SplitInBatches
//   2. Add PubMed Fetch code node (16 queries: 4 journals × 4 types)
//   3. Rewrite 整理分類 & 建立 Prompt (build unified prompt, ISO week, stats)
//   4. Update Gemini node (maxOutputTokens 16384)
//   5. Add 準備審稿 Prompt code node
//   6. Add AI 審稿 chainLlm node + Claude lmChat sub-node
//   7. Simplify 準備文件內容
//   8. Rewire all connections (linear, no loop)

'use strict';
const fs = require('fs');
const { randomUUID } = require('crypto');

// ── Load original ──────────────────────────────────────────────────
const workflow = JSON.parse(fs.readFileSync('workflow.json', 'utf8'));

// ── Node IDs to keep from original ────────────────────────────────
const KEEP = new Set([
  '4923bc0a-2434-4d79-80fd-6786fd02dc56', // 每週一 08:00
  '929b443d-8716-4af2-b677-6ff2f03a614b', // 整理分類 & 建立 Prompt
  '38e1f91a-2596-4585-b31d-1163236a636b', // AI 撰寫新聞稿 (chainLlm)
  'e6d2949c-dad9-49fc-b2bd-f8196ff4e97f', // Google Gemini Chat Model
  'ab3a04f2-efc4-4f85-8b3f-998802c1ba7a', // 準備文件內容
  '4cd0beda-b901-4885-83fb-e50d4f917c40', // 建立 Google Doc
  'fc356d47-1220-43c5-9517-363daa041511', // 寫入文件內容
  'c2b9fb3e-6908-4138-9e1a-a3296d12272d', // 錯誤捕捉
]);

// New node IDs
const ID_PUBMED   = randomUUID();
const ID_PREP_REV = randomUUID();
const ID_CLAUDE_CHAIN = randomUUID();
const ID_CLAUDE_MODEL = randomUUID();

// ── Code strings ───────────────────────────────────────────────────

const PUBMED_FETCH_CODE = `
// ── PubMed Fetch ──
// Runs 16 queries: 4 journals × 4 article types
// Rate-limited, PMID-deduplicated, returns one item per article

const BASE = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/';
const TOOL_NAME = 'PharmJournalNewsletter';
const EMAIL = $env.PUBMED_EMAIL || 'noreply@example.com';
const API_KEY = $env.PUBMED_API_KEY || '';
const DELAY_MS = API_KEY ? 150 : 400;

const JOURNALS = [
  { name: 'NEJM',   issn: '0028-4793' },
  { name: 'Lancet', issn: '0140-6736' },
  { name: 'JAMA',   issn: '0098-7484' },
  { name: 'BMJ',    issn: '0959-8138' },
];

const TYPES = [
  { code: 'RCT', label: 'RCT',              retmax: 5,
    filter: 'randomized controlled trial[pt]' },
  { code: 'MA',  label: 'Meta-analysis',     retmax: 5,
    filter: 'meta-analysis[pt]' },
  { code: 'SR',  label: 'Systematic Review', retmax: 5,
    filter: 'systematic review[pt]' },
  { code: 'OA',  label: 'Original Article',  retmax: 3,
    filter: 'journal article[pt] NOT (randomized controlled trial[pt] OR systematic review[pt] OR meta-analysis[pt] OR review[pt] OR letter[pt] OR editorial[pt] OR comment[pt])' },
];

// Date range: today − 7 days
const now = new Date();
const cutoff = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
const fmtDate = d =>
  d.getFullYear() + '/' +
  String(d.getMonth() + 1).padStart(2, '0') + '/' +
  String(d.getDate()).padStart(2, '0');
const dateRange = fmtDate(cutoff) + ':' + fmtDate(now) + '[dp]';

const sleep = ms => new Promise(r => setTimeout(r, ms));

function commonParams() {
  const p = { db: 'pubmed', tool: TOOL_NAME, email: EMAIL };
  if (API_KEY) p.api_key = API_KEY;
  return p;
}

async function eSearch(issn, typeFilter, retmax) {
  const term = issn + '[ta] AND ' + dateRange + ' AND ' + typeFilter;
  const params = Object.assign({}, commonParams(), {
    term, usehistory: 'y', retmax: String(retmax), retmode: 'json',
  });
  const qs = new URLSearchParams(params).toString();
  const resp = await fetch(BASE + 'esearch.fcgi?' + qs);
  if (!resp.ok) return [];
  const data = await resp.json();
  return (data && data.esearchresult && data.esearchresult.idlist) || [];
}

async function eFetch(ids) {
  if (!ids.length) return '';
  const params = Object.assign({}, commonParams(), {
    id: ids.join(','), rettype: 'abstract', retmode: 'xml',
  });
  const qs = new URLSearchParams(params).toString();
  const resp = await fetch(BASE + 'efetch.fcgi?' + qs);
  if (!resp.ok) return '';
  return await resp.text();
}

const MONTH_MAP = { Jan:1,Feb:2,Mar:3,Apr:4,May:5,Jun:6,Jul:7,Aug:8,Sep:9,Oct:10,Nov:11,Dec:12 };

function parseArticles(xml, journal, typeCode, typeLabel) {
  const articles = [];
  const artRx = /<PubmedArticle>([\s\S]*?)<\\/PubmedArticle>/g;
  let m;
  while ((m = artRx.exec(xml)) !== null) {
    const block = m[1];

    const getTag = tag => {
      const r = new RegExp('<' + tag + '(?:[^>]*)>([\\s\\S]*?)<\\/' + tag + '>', 'i');
      const x = r.exec(block);
      return x ? x[1].replace(/<[^>]+>/g, '').trim() : '';
    };

    const pmid = getTag('PMID');
    if (!pmid) continue;

    // Title
    const title = getTag('ArticleTitle').replace(/\\.$/, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
    if (!title) continue;

    // First author (LastName + first initial)
    const authorBlock = (/<AuthorList[^>]*>([\\s\\S]*?)<\\/AuthorList>/.exec(block) || ['', ''])[1];
    const auM = /<Author[^>]*>[\\s\\S]*?<LastName>([^<]+)<\\/LastName>(?:[\\s\\S]*?<ForeName>([^<]+)<\\/ForeName>)?/.exec(authorBlock);
    const firstAuthor = auM
      ? (auM[1] + (auM[2] ? ' ' + auM[2].charAt(0) : ''))
      : '';

    // Abstract: prefer structured sections
    const absBlock = (/<Abstract>([\\s\\S]*?)<\\/Abstract>/.exec(block) || ['', ''])[1];
    let abstract = '';
    if (absBlock) {
      const sections = [...absBlock.matchAll(/<AbstractText(?:[^>]*Label="([^"]*)")?[^>]*>([\\s\\S]*?)<\\/AbstractText>/g)];
      if (sections.length) {
        abstract = sections.map(s =>
          (s[1] ? s[1] + ': ' : '') + s[2].replace(/<[^>]+>/g, '').trim()
        ).join('\\n');
      } else {
        abstract = absBlock.replace(/<[^>]+>/g, '').trim();
      }
    }

    // DOI
    const doiM = /<ArticleId IdType="doi">([^<]+)<\\/ArticleId>/i.exec(block);
    const doi = doiM ? 'https://doi.org/' + doiM[1].trim() : '';

    // PubDate
    const pdBlock = (/<PubDate>([\\s\\S]*?)<\\/PubDate>/.exec(block) || ['', ''])[1];
    const year  = (/<Year>(\\d+)<\\/Year>/.exec(pdBlock) || ['', ''])[1];
    const rawMo = (/<Month>([^<]+)<\\/Month>/.exec(pdBlock) || ['', '01'])[1];
    const day   = (/<Day>(\\d+)<\\/Day>/.exec(pdBlock) || ['', '01'])[1];
    const moNum = /^\\d+$/.test(rawMo)
      ? rawMo.padStart(2, '0')
      : String(MONTH_MAP[rawMo] || 1).padStart(2, '0');
    const pubDate = year ? year + '-' + moNum + '-' + day.padStart(2, '0') : '';

    articles.push({ pmid, journal, articleType: typeCode, articleTypeLabel: typeLabel,
                    title, firstAuthor, abstract, doi, pubDate });
  }
  return articles;
}

// ── Main ──
const seen = new Set();
const allArticles = [];

for (const journal of JOURNALS) {
  for (const type of TYPES) {
    await sleep(DELAY_MS);
    let ids;
    try {
      ids = await eSearch(journal.issn, type.filter, type.retmax);
    } catch (e) {
      ids = [];
    }
    const newIds = ids.filter(id => !seen.has(id));
    newIds.forEach(id => seen.add(id));
    if (newIds.length > 0) {
      await sleep(DELAY_MS);
      let xml = '';
      try { xml = await eFetch(newIds); } catch (_) {}
      if (xml) {
        const parsed = parseArticles(xml, journal.name, type.code, type.label);
        allArticles.push(...parsed);
      }
    }
  }
}

return allArticles.map(a => ({ json: a }));
`.trim();

// ─────────────────────────────────────────────────────────────────
const CLASSIFY_CODE = `
// ── 整理分類 & 建立 Prompt ──
const JOURNAL_ORDER = ['NEJM', 'Lancet', 'JAMA', 'BMJ'];
const TYPE_ORDER    = ['RCT', 'MA', 'SR', 'OA'];
const TYPE_DISPLAY  = { RCT: 'RCT', MA: 'Meta-analysis', SR: 'Systematic Review', OA: 'Original Article' };

const items = $input.all().map(i => i.json);

// Stats
const stats = { RCT: 0, MA: 0, SR: 0, OA: 0 };
for (const a of items) {
  if (stats[a.articleType] !== undefined) stats[a.articleType]++;
}

// Group & sort
const grouped = {};
for (const j of JOURNAL_ORDER) {
  grouped[j] = {};
  for (const t of TYPE_ORDER) grouped[j][t] = [];
}
for (const a of items) {
  if (grouped[a.journal] && grouped[a.journal][a.articleType] !== undefined) {
    grouped[a.journal][a.articleType].push(a);
  }
}
for (const j of JOURNAL_ORDER) {
  for (const t of TYPE_ORDER) {
    grouped[j][t].sort((a, b) => new Date(b.pubDate || 0) - new Date(a.pubDate || 0));
  }
}

// ISO week number
function getISOWeek(d) {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  return Math.ceil((((date - yearStart) / 86400000) + 1) / 7);
}

const now       = new Date();
const weekNum   = String(getISOWeek(now)).padStart(2, '0');
const year      = now.getFullYear();
const timestamp = now.toLocaleString('zh-TW', {
  timeZone: 'Asia/Taipei',
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hour12: false,
});
const docTitle = '【藥師文獻週報】' + year + ' 第' + weekNum + '週';

// Format each article for AI prompt
const fmtArticle = a =>
  'PMID: ' + a.pmid + '\\n' +
  'Journal: ' + a.journal + '\\n' +
  'Type: ' + (TYPE_DISPLAY[a.articleType] || a.articleType) + '\\n' +
  'Title: ' + a.title + '\\n' +
  'Author: ' + (a.firstAuthor || 'N/A') + '\\n' +
  'DOI: ' + (a.doi || 'N/A') + '\\n' +
  'PubDate: ' + (a.pubDate || 'N/A') + '\\n' +
  'Abstract:\\n' + (a.abstract || '(no abstract available)');

// Build ordered article data block
let articleData = '';
for (const j of JOURNAL_ORDER) {
  const journalArticles = TYPE_ORDER.flatMap(t => grouped[j][t]);
  if (!journalArticles.length) continue;
  articleData += '\\n=== ' + j + ' ===\\n';
  for (const t of TYPE_ORDER) {
    if (!grouped[j][t].length) continue;
    articleData += '\\n-- ' + TYPE_DISPLAY[t] + ' --\\n\\n';
    for (const a of grouped[j][t]) {
      articleData += fmtArticle(a) + '\\n\\n---\\n\\n';
    }
  }
}

const totalCount = items.length;
const sep = '══════════════════════════════════════';

const prompt =
'You are a clinical pharmacist editor writing a weekly digest in Traditional Chinese.\\n\\n' +
'TITLE RULE (critical):\\n' +
'The ▶ title line MUST use the ORIGINAL ENGLISH TITLE exactly as provided — no translation whatsoever.\\n' +
'The 背景/方法/結果/結論 sections are written in Traditional Chinese (繁體中文).\\n' +
'Drug names / trial names / gene names / biomarkers must stay in English even within Chinese sentences.\\n\\n' +
'OUTPUT FORMAT (follow exactly, no deviation):\\n\\n' +
'【藥師文獻週報】' + year + ' 第' + weekNum + '週\\n' +
'NEJM / Lancet / JAMA / BMJ 精選\\n' +
'產製時間：' + timestamp + '\\n\\n' +
sep + '\\n' +
'本週收錄：' + totalCount + ' 篇\\n' +
'RCT：' + stats.RCT + ' 篇｜Meta-analysis：' + stats.MA + ' 篇｜系統性回顧：' + stats.SR + ' 篇｜原著論文：' + stats.OA + ' 篇\\n' +
sep + '\\n\\n' +
'For each journal that has articles, in the order NEJM → Lancet → JAMA → BMJ:\\n\\n' +
'【JOURNAL_NAME】\\n' +
'──────────────────────────────────────\\n\\n' +
'For each article within the journal, in the order RCT → Meta-analysis → Systematic Review → Original Article, then by pub_date newest first:\\n\\n' +
'▶ [Original English title — copy exactly from article data, NEVER translate]\\n' +
'  類型：[RCT / Meta-analysis / Systematic Review / Original Article]｜作者：[LastName] et al.\\n' +
'  DOI：[doi from article data, or （詳見原文） if N/A]\\n\\n' +
'  背景：[≤2 sentences in Chinese: clinical problem or research question]\\n' +
'  方法：[≤2 sentences in Chinese: study design, N, intervention vs comparator, follow-up]\\n' +
'  結果：[≤2 sentences in Chinese: primary endpoint result + key stat (HR/RR/OR, 95%CI, p-value)]\\n' +
'  結論：[exactly 1 sentence in Chinese: clinical implication for pharmacists]\\n\\n' +
'[blank line between articles]\\n\\n' +
'RULES:\\n' +
'- NO MARKDOWN (no **, *, # characters)\\n' +
'- Use （詳見原文） for any field where information is not available in the abstract\\n' +
'- End the entire document with: 【本週精選完畢】\\n\\n' +
'== ARTICLES ==\\n' + articleData;

return [{ json: { prompt, docTitle, totalCount, stats, timestamp, year, weekNum } }];
`.trim();

// ─────────────────────────────────────────────────────────────────
const PREP_REVIEW_CODE = `
// ── 準備審稿 Prompt ──
// Receives Gemini draft ($json.text), builds full review prompt for Claude

const draft = $json.text || '';
const meta  = $('整理分類 & 建立 Prompt').first().json;

const reviewPrompt =
'You are a senior clinical pharmacist editor reviewing a newsletter draft.\\n' +
'RULE: Fix errors only — do not rewrite correct content.\\n\\n' +
'CHECK IN ORDER:\\n' +
'1. HEADER: must begin with 【藥師文獻週報】, then NEJM/Lancet/JAMA/BMJ 精選 line,\\n' +
'   then 產製時間, then ══ block containing 本週收錄 and per-type counts.\\n' +
'2. JOURNAL ORDER: must appear as NEJM → Lancet → JAMA → BMJ.\\n' +
'   Each journal uses 【JOURNAL】 header followed by ─── separator line.\\n' +
'3. TYPE ORDER within each journal: RCT → Meta-analysis → Systematic Review → Original Article.\\n' +
'4. TITLE: the ▶ line must show the ORIGINAL ENGLISH TITLE verbatim.\\n' +
'   If any Chinese text appears on the ▶ line, restore the English title from context.\\n' +
'   Wrong: ▶ 司美格魯肽治療保留射血分數心衰竭\\n' +
'   Right:  ▶ Semaglutide in Heart Failure with Preserved Ejection Fraction\\n' +
'5. ARTICLE FIELDS: each article must have:\\n' +
'   - 類型/作者/DOI line (second line, indented)\\n' +
'   - 背景, 方法, 結果, 結論 fields (indented, each on own line)\\n' +
'   - 背景/方法/結果: max 2 sentences each\\n' +
'   - 結論: exactly 1 sentence\\n' +
'   - Any missing field → （詳見原文）\\n' +
'6. DOI: must be a real URL (https://doi.org/...) from the article, not a placeholder.\\n' +
'7. DRUG NAMES: drug names, trial names, gene names must stay in English within Chinese text.\\n' +
'8. MARKDOWN: remove any **, *, # characters if present.\\n' +
'9. COUNTS: verify that RCT/MA/SR/OA counts in the ══ block match articles in the body.\\n' +
'10. FOOTER: the document must end with 【本週精選完畢】.\\n\\n' +
'Return ONLY the corrected newsletter text. No explanations, no commentary.\\n\\n' +
'DRAFT:\\n' + draft;

return [{ json: { reviewPrompt, docTitle: meta.docTitle } }];
`.trim();

// ─────────────────────────────────────────────────────────────────
const PREPARE_DOC_CODE = `
// ── 準備文件內容 ──
const digestText = $json.text || '';
const meta = $('準備審稿 Prompt').first().json;
return [{ json: { digestText, docTitle: meta.docTitle } }];
`.trim();

// ── Mutate kept nodes ──────────────────────────────────────────────
const kept = workflow.nodes.filter(n => KEEP.has(n.id));

const byId = Object.fromEntries(kept.map(n => [n.id, n]));

// 每週一 08:00
byId['4923bc0a-2434-4d79-80fd-6786fd02dc56'].position = [11840, 2864];

// 整理分類 & 建立 Prompt
Object.assign(byId['929b443d-8716-4af2-b677-6ff2f03a614b'], {
  position: [12480, 2864],
  parameters: { jsCode: CLASSIFY_CODE },
});

// AI 撰寫新聞稿 — keep promptType:define, text from $json.prompt
Object.assign(byId['38e1f91a-2596-4585-b31d-1163236a636b'], {
  position: [12800, 2864],
  parameters: { promptType: 'define', text: '={{ $json.prompt }}' },
});

// Google Gemini Chat Model — increase output tokens
Object.assign(byId['e6d2949c-dad9-49fc-b2bd-f8196ff4e97f'], {
  position: [12800, 3072],
  parameters: { options: { maxOutputTokens: 16384, temperature: 0.3 } },
});

// 準備文件內容
Object.assign(byId['ab3a04f2-efc4-4f85-8b3f-998802c1ba7a'], {
  position: [13760, 2864],
  parameters: { jsCode: PREPARE_DOC_CODE },
});

// 建立 Google Doc
byId['4cd0beda-b901-4885-83fb-e50d4f917c40'].position = [14080, 2864];

// 寫入文件內容
byId['fc356d47-1220-43c5-9517-363daa041511'].position = [14400, 2864];

// 錯誤捕捉
byId['c2b9fb3e-6908-4138-9e1a-a3296d12272d'].position = [13440, 3264];

// ── New nodes ──────────────────────────────────────────────────────
const pubmedFetchNode = {
  id: ID_PUBMED,
  name: 'PubMed Fetch',
  type: 'n8n-nodes-base.code',
  typeVersion: 2,
  position: [12160, 2864],
  parameters: {
    mode: 'runOnceForAllItems',
    jsCode: PUBMED_FETCH_CODE,
  },
};

const prepReviewNode = {
  id: ID_PREP_REV,
  name: '準備審稿 Prompt',
  type: 'n8n-nodes-base.code',
  typeVersion: 2,
  position: [13120, 2864],
  parameters: {
    mode: 'runOnceForAllItems',
    jsCode: PREP_REVIEW_CODE,
  },
};

const claudeChainNode = {
  id: ID_CLAUDE_CHAIN,
  name: 'AI 審稿 (Claude)',
  type: '@n8n/n8n-nodes-langchain.chainLlm',
  typeVersion: 1.4,
  position: [13440, 2864],
  parameters: {
    promptType: 'define',
    text: '={{ $json.reviewPrompt }}',
  },
};

const claudeModelNode = {
  id: ID_CLAUDE_MODEL,
  name: 'Claude Sonnet (審稿)',
  type: '@n8n/n8n-nodes-langchain.lmChatAnthropic',
  typeVersion: 1.3,
  position: [13440, 3072],
  parameters: {
    model: 'claude-sonnet-4-5-20251001',
    options: {
      maxTokensToSample: 16384,
      temperature: 0.1,
    },
  },
  credentials: {
    anthropicApi: {
      id: '',
      name: 'Anthropic account',
    },
  },
};

// ── Assemble final node list ───────────────────────────────────────
workflow.nodes = [
  ...kept,
  pubmedFetchNode,
  prepReviewNode,
  claudeChainNode,
  claudeModelNode,
];

// ── Rewrite connections ────────────────────────────────────────────
workflow.connections = {
  '每週一 08:00': {
    main: [[{ node: 'PubMed Fetch', type: 'main', index: 0 }]],
  },
  'PubMed Fetch': {
    main: [[{ node: '整理分類 & 建立 Prompt', type: 'main', index: 0 }]],
  },
  '整理分類 & 建立 Prompt': {
    main: [[{ node: 'AI 撰寫新聞稿', type: 'main', index: 0 }]],
  },
  'AI 撰寫新聞稿': {
    main: [[{ node: '準備審稿 Prompt', type: 'main', index: 0 }]],
  },
  '準備審稿 Prompt': {
    main: [[{ node: 'AI 審稿 (Claude)', type: 'main', index: 0 }]],
  },
  'AI 審稿 (Claude)': {
    main: [[{ node: '準備文件內容', type: 'main', index: 0 }]],
  },
  '準備文件內容': {
    main: [[{ node: '建立 Google Doc', type: 'main', index: 0 }]],
  },
  '建立 Google Doc': {
    main: [[{ node: '寫入文件內容', type: 'main', index: 0 }]],
  },
  'Google Gemini Chat Model': {
    ai_languageModel: [[{ node: 'AI 撰寫新聞稿', type: 'ai_languageModel', index: 0 }]],
  },
  'Claude Sonnet (審稿)': {
    ai_languageModel: [[{ node: 'AI 審稿 (Claude)', type: 'ai_languageModel', index: 0 }]],
  },
};

// ── Metadata ───────────────────────────────────────────────────────
workflow.name = '醫藥新知電子新聞稿 (PubMed + Dual-Agent)';
delete workflow.versionId; // will be assigned by n8n on import

// ── Write output ───────────────────────────────────────────────────
fs.writeFileSync('workflow-fixed.json', JSON.stringify(workflow, null, 2), 'utf8');
console.log('✅  workflow-fixed.json written.');
console.log('    Nodes:', workflow.nodes.length);
console.log('    Connections:', Object.keys(workflow.connections).length, 'source nodes');
