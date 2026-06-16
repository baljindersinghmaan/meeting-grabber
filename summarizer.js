/* =============================================================================
 * Meet Caption Grabber — Groq cloud summarizer
 *
 * Turns a captured caption array ([{speaker, text}, ...]) into a structured
 * PLAIN-TEXT meeting summary by calling Groq's OpenAI-compatible chat-completions
 * endpoint with the user's free API key.
 *
 * Privacy note: this sends the cleaned transcript to https://api.groq.com.
 * The README says so out loud — surface that fact in any UX you build on top.
 *
 * STRATEGY
 *   - Short transcripts go single-shot (one API call).
 *   - Long transcripts go map-reduce:
 *       map:    summarize each speaker-aligned chunk into flat bullets
 *       reduce: combine those bullets into the final structured plain text
 *   - Chunks split ONLY on speaker turn boundaries so each chunk holds coherent
 *     dialogue.
 *   - Token counts are rough estimates (chars/4). Llama 3.3 70B has 128k input,
 *     so the thresholds below are tuned to fit Groq's free-tier per-minute
 *     token rate limit rather than to fit the model itself.
 *
 * Returns { ok, summary, reason, error } — never throws to the caller. Reasons:
 *   - 'empty'         : no lines passed
 *   - 'no-api-key'    : caller didn't pass apiKey
 *   - 'unauthorized'  : Groq returned 401 (bad key)
 *   - 'rate-limit'    : Groq returned 429
 *   - 'server-error'  : Groq 4xx/5xx other than 401/429
 *   - 'network'       : fetch failed before a response
 *   - 'too-long'      : meeting exceeds our map-reduce cap (very rare)
 *   - 'error'         : anything else
 * ========================================================================== */

(() => {
  if (window.__meetCaptionSummarizer) return;

  const LOG = '[summarizer]';

  const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';
  const DEFAULT_MODEL = 'llama-3.3-70b-versatile';

  /* --- prompts ------------------------------------------------------------ */

  const SYSTEM_PROMPT = [
    'You are a meeting-notes assistant. You write concise, factual summaries',
    'of meeting transcripts in the format "Speaker: text".',
    'Rules:',
    '- Never invent facts not supported by the transcript.',
    '- Silently fix obvious speech-to-text errors and filler.',
    '- Output only the requested content. No preamble, no sign-off.',
    '- PLAIN TEXT only. No markdown (no #, **, _, `, tables). No emoji.',
  ].join('\n');

  // Single-shot: full structured output as plain text.
  const SINGLE_SHOT_PROMPT = [
    'Produce a meeting summary in PLAIN TEXT using EXACTLY these section',
    'headings (UPPERCASE, on their own line, followed by a blank line and',
    'then the content). Separate sections with a blank line. If a section',
    'has no content, write "None identified."',
    '',
    'OVERVIEW',
    '2-4 sentences on what the meeting was about and its outcome.',
    '',
    'PARTICIPANTS',
    'One bullet per distinct speaker. Use "- Name".',
    '',
    'KEY DISCUSSION POINTS',
    'Bulleted main topics, grouped by theme. Use "- " for bullets.',
    '',
    'DECISIONS MADE',
    'One bullet per concrete decision. Use "- ".',
    '',
    'ACTION ITEMS',
    'One bullet per follow-up, formatted as: "- Owner: Action (Due / Timeline)".',
    'If the owner or timing is not clear from the transcript, omit that part',
    'rather than guessing.',
    '',
    'OPEN QUESTIONS / RISKS',
    'Unresolved questions, blockers, or concerns. Use "- ".',
    '',
    'NEXT STEPS',
    'What happens after this meeting. Use "- ".',
    '',
    'NOTABLE QUOTES (optional)',
    'Up to 3 short verbatim quotes attributed as: \'- Name: "quote"\'.',
    'Skip the entire section if nothing stands out.',
    '',
    'Formatting rules:',
    '- Plain text only. No markdown, no asterisks, no backticks, no emoji.',
    '- Use "- " for bullets. Use blank lines between sections.',
  ].join('\n');

  // Map step: flat bullets, no headings. Order-preserving signal extraction.
  const MAP_PROMPT = [
    'Below is one segment of a longer meeting transcript. Extract:',
    '- Topics discussed (one bullet each)',
    '- Decisions made (one bullet each)',
    '- Action items, with owner and any timing stated',
    '- Open questions or blockers raised',
    '- 0-2 short notable quotes, attributed',
    '',
    'Use plain "- " bullets. No section headings. No markdown, no emoji.',
    'No commentary. Skip categories with nothing to report.',
  ].join('\n');

  // Reduce step: takes concatenated map output, produces final structured doc.
  const REDUCE_PROMPT = [
    'Below are bullet-point notes extracted in order from segments of one',
    'meeting. Combine them into one cohesive PLAIN TEXT summary using EXACTLY',
    'these UPPERCASE section headings (each on its own line, blank line before',
    'the content). Deduplicate and merge overlapping items. If a section has',
    'no content, write "None identified."',
    '',
    'OVERVIEW',
    'PARTICIPANTS',
    'KEY DISCUSSION POINTS',
    'DECISIONS MADE',
    'ACTION ITEMS',
    '  (format each line as: "- Owner: Action (Due / Timeline)")',
    'OPEN QUESTIONS / RISKS',
    'NEXT STEPS',
    'NOTABLE QUOTES (optional)',
    '',
    'Formatting rules:',
    '- Plain text only. No markdown, no asterisks, no backticks, no emoji.',
    '- Use "- " for bullets. Use blank lines between sections.',
  ].join('\n');

  /* --- token thresholds --------------------------------------------------- *
   * Llama 3.3 70B has 128k input window. Free-tier per-minute token rate
   * limit is the actual constraint — keep single calls comfortably under it.
   * Tune here if you see rate-limit errors on normal-sized meetings.
   * ------------------------------------------------------------------------ */
  const SINGLE_SHOT_TOKEN_CAP = 25000;  // prompt + transcript ≤ this → single-shot
  const CHUNK_TOKEN_CAP       = 8000;   // each map chunk capped at this
  const REDUCE_INPUT_CAP      = 25000;  // reduce prompt + extracts ≤ this
  const MAX_CHUNKS            = 20;     // hard cap; beyond = too-long fallback

  /* --- helpers ------------------------------------------------------------ */

  // Rough token estimate: ~4 chars per token. Good enough for budgeting.
  function estTokens(text) {
    return Math.ceil(String(text || '').length / 4);
  }

  function serializeLines(lines) {
    return lines.map(l => `${l.speaker}: ${l.text}`).join('\n');
  }

  // Pack lines into chunks each ≤ tokenBudget, splitting ONLY at speaker
  // turn boundaries (never mid-utterance).
  function chunkLines(lines, tokenBudget) {
    const chunks = [];
    let current = [];
    let currentTokens = 0;
    for (const line of lines) {
      const lineText = `${line.speaker}: ${line.text}\n`;
      const lineTokens = estTokens(lineText);
      if (currentTokens + lineTokens > tokenBudget && current.length > 0) {
        chunks.push(current);
        current = [];
        currentTokens = 0;
      }
      current.push(line);
      currentTokens += lineTokens;
    }
    if (current.length) chunks.push(current);
    return chunks;
  }

  // Single call to Groq's chat-completions endpoint. Throws Error with .code
  // set to one of: 'unauthorized' | 'rate-limit' | 'server-error' | 'network'.
  async function callGroq(apiKey, messages) {
    let res;
    try {
      res = await fetch(GROQ_API_URL, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: DEFAULT_MODEL,
          messages,
          temperature: 0.3,
          max_tokens: 4000,
        }),
      });
    } catch (e) {
      const err = new Error('Network error reaching Groq: ' + (e && e.message || e));
      err.code = 'network';
      throw err;
    }

    if (res.status === 401) {
      const err = new Error('Invalid Groq API key (401)');
      err.code = 'unauthorized';
      throw err;
    }
    if (res.status === 429) {
      const err = new Error('Groq rate limit exceeded (429)');
      err.code = 'rate-limit';
      throw err;
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      const err = new Error(`Groq API error ${res.status}: ${body.slice(0, 300)}`);
      err.code = 'server-error';
      throw err;
    }

    const data = await res.json().catch(() => null);
    const content = data && data.choices && data.choices[0]
      && data.choices[0].message && data.choices[0].message.content;
    if (!content) {
      const err = new Error('Groq returned no content');
      err.code = 'server-error';
      throw err;
    }
    return String(content).trim();
  }

  /* --- main entry --------------------------------------------------------- */

  /**
   * Summarize a captured caption array via Groq.
   *
   * @param {Array<{speaker:string,text:string}>} lines
   * @param {object} opts
   * @param {string} opts.apiKey
   * @param {(p:{stage:string,done:number,total:number})=>void} [opts.onProgress]
   * @returns {Promise<{ok:boolean, summary?:string, reason?:string, error?:string}>}
   */
  async function summarize(lines, opts) {
    opts = opts || {};
    const apiKey = (opts.apiKey || '').trim();
    const onProgress = opts.onProgress || (() => {});

    console.log(LOG, `summarize() start: lines=${Array.isArray(lines) ? lines.length : 'n/a'}, hasKey=${!!apiKey}`);

    if (!Array.isArray(lines) || lines.length === 0) {
      console.warn(LOG, 'no lines to summarize');
      return { ok: false, reason: 'empty' };
    }
    if (!apiKey) {
      console.warn(LOG, 'no API key provided');
      return { ok: false, reason: 'no-api-key' };
    }

    const transcript = serializeLines(lines);
    const totalIfSingle = estTokens(SINGLE_SHOT_PROMPT + transcript);
    console.log(LOG, `transcript tokens (with prompt) ~= ${totalIfSingle}; cap=${SINGLE_SHOT_TOKEN_CAP}`);

    try {
      /* -- single-shot path -- */
      if (totalIfSingle <= SINGLE_SHOT_TOKEN_CAP) {
        console.log(LOG, 'taking single-shot path');
        onProgress({ stage: 'summarize', done: 0, total: 1 });
        const summary = await callGroq(apiKey, [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: SINGLE_SHOT_PROMPT + '\n\nTranscript:\n' + transcript },
        ]);
        onProgress({ stage: 'summarize', done: 1, total: 1 });
        console.log(LOG, `single-shot OK: ${summary.length} chars`);
        return { ok: true, summary };
      }

      /* -- map step -- */
      const chunks = chunkLines(lines, CHUNK_TOKEN_CAP);
      console.log(LOG, `taking map-reduce path: ${chunks.length} chunks`);
      if (chunks.length > MAX_CHUNKS) {
        console.warn(LOG, `too many chunks (${chunks.length} > ${MAX_CHUNKS})`);
        return { ok: false, reason: 'too-long' };
      }

      const extracts = [];
      for (let i = 0; i < chunks.length; i++) {
        console.log(LOG, `map ${i + 1}/${chunks.length}…`);
        onProgress({ stage: 'map', done: i, total: chunks.length });
        const chunkText = serializeLines(chunks[i]);
        const extract = await callGroq(apiKey, [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: MAP_PROMPT + '\n\nSegment:\n' + chunkText },
        ]);
        extracts.push(extract);
      }
      onProgress({ stage: 'map', done: chunks.length, total: chunks.length });
      console.log(LOG, `map complete: ${extracts.length} extracts`);

      /* -- reduce step -- */
      const reduceInput = extracts.join('\n\n---\n\n');
      const reduceTokens = estTokens(REDUCE_PROMPT + reduceInput);
      console.log(LOG, `reduce input tokens ~= ${reduceTokens}; cap=${REDUCE_INPUT_CAP}`);

      // With Llama 3.3 70B's 128k context this should never trigger in practice.
      // If it does, the meeting is just past our cap — fall back to too-long.
      if (reduceTokens > REDUCE_INPUT_CAP) {
        console.warn(LOG, `reduce input exceeds cap (${reduceTokens} > ${REDUCE_INPUT_CAP})`);
        return { ok: false, reason: 'too-long' };
      }

      onProgress({ stage: 'reduce', done: 0, total: 1 });
      const summary = await callGroq(apiKey, [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: REDUCE_PROMPT + '\n\nNotes:\n' + reduceInput },
      ]);
      onProgress({ stage: 'reduce', done: 1, total: 1 });
      console.log(LOG, `reduce OK: ${summary.length} chars`);

      return { ok: true, summary };
    } catch (e) {
      console.warn(LOG, 'failed:', e && e.message || e);
      const reason = (e && e.code) || 'error';
      return { ok: false, reason, error: String(e && e.message || e) };
    }
  }

  window.__meetCaptionSummarizer = { summarize };
  console.log('[Meet Caption Grabber] summarizer (Groq) module loaded');
})();
