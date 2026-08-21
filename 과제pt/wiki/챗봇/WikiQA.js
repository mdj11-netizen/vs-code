/**
 * ===== 위키 기반 Q&A (Claude API 연동) =====
 *
 * 무엇을 하는 코드인가
 *  - 사용자 질문을 받으면, 프로젝트 안 위키 HTML 파일(index.html)에서
 *    관련 있어 보이는 항목만 몇 개 뽑아 그 "발췌"만 Claude API에 보내 답을 만든다.
 *  - 위키에 없는 내용은 지어내지 않도록, 시스템 프롬프트와 발췌 범위로 강하게 제한한다.
 *
 * 기존 위키 코드(Code.gs, Images.gs, index.html)는 전혀 건드리지 않는다.
 * 이 파일만 프로젝트에 추가하면 된다.
 */

// ───────────────────────────────────────────────────────────
// 1. 설정값 — 나중에 고칠 일이 있으면 여기만 보면 된다
// ───────────────────────────────────────────────────────────

// 위키 원문이 들어있는 프로젝트 내 HTML 파일 이름들.
// 여러 파일을 합쳐서 검색하고 싶으면 배열에 이름을 추가하면 된다.
// (예: WIKI_FILE_NAMES = ['index', 'index2'])
var WIKI_FILE_NAMES = ['index'];

// 항목 하나를 Claude에게 보낼 때, 그 항목에서 잘라서 보낼 최대 글자 수.
// 항목이 이보다 길면 앞부분만 잘라서 보낸다. 너무 작으면 내용이 부족해지고,
// 너무 크면 API 호출 비용/속도가 늘어난다.
// (1200자였을 때는 카드가 여러 개인 긴 문서에서 뒷부분 카드 — 예: "해외사업자와의 거래"
// 문서 뒤쪽의 "적격증빙" 목록 — 가 통째로 잘려서, 실제로는 위키에 있는 내용인데도
// Claude가 못 보고 "위키에 없는 내용입니다"라고 답하는 문제가 있었다. 문서 대부분이
// 다 들어갈 만큼 넉넉하게 올렸다.)
var MAX_CHARS_PER_ITEM = 6000;

// 질문과 관련 있다고 판단해 Claude에게 넘길 항목의 최대 개수.
var MAX_RELEVANT_ITEMS = 4;

// 이 개수보다 적더라도, 점수가 0보다 큰 항목이 있으면 최소 몇 개까지는 보낼지.
var MIN_RELEVANT_ITEMS = 3;

// Claude API 설정
var CLAUDE_API_URL = 'https://api.anthropic.com/v1/messages';
var CLAUDE_MODEL = 'claude-opus-5';
var CLAUDE_MAX_TOKENS = 4000;
var CLAUDE_ANTHROPIC_VERSION = '2023-06-01';

// 스크립트 속성(Project Settings > Script Properties)에 이 이름으로 API 키를 등록해야 한다.
// 절대 이 코드 파일 안에 실제 키 값을 적지 않는다.
var API_KEY_PROPERTY_NAME = 'ANTHROPIC_API_KEY';


// ───────────────────────────────────────────────────────────
// 2. 위키 읽기 & 캐시
//    (같은 실행 안에서는 파일을 한 번만 읽고, 이후에는 메모리에 저장해둔 것을 재사용한다)
// ───────────────────────────────────────────────────────────

// 이번 실행(함수 호출 1회) 동안만 유지되는 캐시. 실행이 끝나면 사라진다.
var _wikiItemsCache = null;

/**
 * 위키 파일들을 읽어서 "항목 배열"로 만들어 반환한다.
 * 항목 하나는 { source: 파일이름, title: 제목, text: 태그를 뺀 순수 텍스트 } 형태.
 *
 * index.html은 정적인 문서가 아니라, <script> 안의
 *   const DOCS = { '키': { title:'...', crumb:[...], chips:[...], body:`...` }, ... }
 * 라는 JS 객체 안에 실제 매뉴얼 항목들이 들어있는 구조다(문서 51개 안팎).
 * 그래서 "제목 태그 기준으로 항목을 쪼갠다"는 것은, HTML의 <h1>~<h3>이 아니라
 * 이 DOCS 객체 안의 각 항목(하나의 title)을 기준으로 자른다는 뜻이다.
 * 만약 이런 DOCS 구조를 찾지 못하면(=제목 태그가 없는 파일이면), 파일 전체를 통째로
 * 항목 하나로 취급한다.
 */
function getWikiItems_() {
  if (_wikiItemsCache) return _wikiItemsCache; // 이미 읽었으면 다시 읽지 않는다

  var items = [];

  for (var i = 0; i < WIKI_FILE_NAMES.length; i++) {
    var fileName = WIKI_FILE_NAMES[i];
    var raw = HtmlService.createHtmlOutputFromFile(fileName).getContent();

    var docsItems = extractDocsItems_(raw, fileName);

    if (docsItems.length > 0) {
      items = items.concat(docsItems);
    } else {
      // DOCS 구조를 못 찾은 파일 → 파일 전체를 항목 하나로 처리
      items.push({
        source: fileName,
        title: fileName,
        text: stripHtml_(raw)
      });
    }
  }

  _wikiItemsCache = items;
  return items;
}

/**
 * index.html 원문(raw)에서 `const DOCS = { ... };` 객체를 찾아,
 * 그 안의 각 '키': { title:'...', body:`...` } 항목을 하나씩 잘라낸다.
 * DOCS를 못 찾으면 빈 배열을 반환한다.
 *
 * 주의: 이 함수는 JS를 실제로 실행(eval)하지 않는다. Apps Script(V8 런타임)에서
 * <script> 안의 JS를 안전하게 실행할 방법이 없기 때문에, 문자열 패턴 매칭으로
 * "title:'...'"과 "body:`...`" 부분만 정규식/괄호 카운팅으로 뽑아낸다.
 */
function extractDocsItems_(raw, fileName) {
  var startMarker = 'const DOCS = {';
  var startIdx = raw.indexOf(startMarker);
  if (startIdx === -1) return [];

  // DOCS 객체 전체를 괄호 짝을 세어가며 끝까지 잘라낸다 (중간에 문자열 안 { } 는 무시).
  var docsBody = extractBalancedBraces_(raw, startIdx + startMarker.length - 1);
  if (!docsBody) return [];

  var items = [];

  // 각 항목은 '키': { ... } 형태로 시작한다. 이 시작 지점들을 순서대로 찾는다.
  var keyPattern = /'([^']+)'\s*:\s*\{/g;
  var match;
  var keyStarts = [];
  while ((match = keyPattern.exec(docsBody)) !== null) {
    keyStarts.push({ key: match[1], braceIdx: keyPattern.lastIndex - 1 });
  }

  for (var k = 0; k < keyStarts.length; k++) {
    var key = keyStarts[k].key;
    var entryBody = extractBalancedBraces_(docsBody, keyStarts[k].braceIdx);
    if (!entryBody) continue;

    // title:'...' 추출 (작은따옴표 안에 \' 이스케이프가 있을 수 있음)
    var titleMatch = entryBody.match(/title\s*:\s*'((?:[^'\\]|\\.)*)'/);
    var title = titleMatch ? titleMatch[1].replace(/\\'/g, "'") : key;

    // body:`...` 추출 (백틱 문자열, 안에 ${...} 템플릿 표현식이 섞여 있을 수 있음)
    var bodyText = extractTemplateLiteralAfter_(entryBody, 'body');

    // 헬퍼 함수 호출(moneyDiagram([...]), exampleBlock([...]) 등) 인자 안의
    // title/sub 같은 사람이 읽는 텍스트도 최대한 살리기 위해, 템플릿 안의
    // ${...} 표현식을 걷어내지 않고 그대로 stripHtml_로 넘긴다 — 태그만 지우면
    // {id:'x', title:'매출', sub:'...'} 같은 부분은 순수 텍스트로 남는다.
    var fullSourceText = (title + '\n' + (bodyText || ''));
    var text = stripHtml_(fullSourceText);

    items.push({
      source: fileName,
      title: title,
      key: key,
      text: text
    });
  }

  return items;
}

/**
 * str[openBraceIdx]가 '{' 라고 가정하고, 그 짝이 되는 '}' 까지의 내용을
 * (중괄호 포함) 잘라서 반환한다. 문자열 리터럴(' " `) 안의 중괄호는 세지 않는다.
 * 짝을 못 찾으면 null을 반환한다.
 */
function extractBalancedBraces_(str, openBraceIdx) {
  var depth = 0;
  var inString = null; // 현재 어떤 따옴표 안에 있는지 (' " ` 중 하나, 아니면 null)

  for (var i = openBraceIdx; i < str.length; i++) {
    var ch = str.charAt(i);
    var prev = i > 0 ? str.charAt(i - 1) : '';

    if (inString) {
      if (ch === inString && prev !== '\\') {
        inString = null;
      }
      continue;
    }

    if (ch === "'" || ch === '"' || ch === '`') {
      inString = ch;
      continue;
    }

    if (ch === '{') depth++;
    if (ch === '}') {
      depth--;
      if (depth === 0) {
        return str.substring(openBraceIdx, i + 1);
      }
    }
  }
  return null; // 짝을 못 찾음 (문법이 예상과 다름)
}

/**
 * entryBody 안에서 "fieldName:`...`" 형태의 백틱 템플릿 리터럴을 찾아
 * 그 안쪽 내용(백틱 제외)을 반환한다. 없으면 null.
 */
function extractTemplateLiteralAfter_(entryBody, fieldName) {
  var re = new RegExp(fieldName + '\\s*:\\s*`');
  var m = re.exec(entryBody);
  if (!m) return null;

  var start = m.index + m[0].length; // 여는 백틱 다음 위치
  var i = start;
  while (i < entryBody.length) {
    var ch = entryBody.charAt(i);
    var prev = i > 0 ? entryBody.charAt(i - 1) : '';
    if (ch === '`' && prev !== '\\') {
      return entryBody.substring(start, i);
    }
    i++;
  }
  return entryBody.substring(start); // 닫는 백틱을 못 찾으면 끝까지
}

/**
 * HTML 태그와 주요 문자 참조(&nbsp; 등)를 지워서 글만 남긴다.
 * 완벽한 HTML 파서는 아니지만, 위키 본문에서 사람이 읽는 텍스트를
 * 뽑아내는 용도로는 충분하다.
 */
function stripHtml_(html) {
  if (!html) return '';
  var text = html;

  // <script>, <style> 내용은 통째로 제거 (안에 JS 코드가 섞여 노이즈가 됨)
  text = text.replace(/<script[\s\S]*?<\/script>/gi, ' ');
  text = text.replace(/<style[\s\S]*?<\/style>/gi, ' ');

  // 태그 제거
  text = text.replace(/<[^>]+>/g, ' ');

  // 자주 쓰이는 문자 참조 치환
  text = text.replace(/&nbsp;/g, ' ')
             .replace(/&amp;/g, '&')
             .replace(/&lt;/g, '<')
             .replace(/&gt;/g, '>')
             .replace(/&quot;/g, '"')
             .replace(/&#39;/g, "'")
             .replace(/&middot;/g, '·');

  // 백슬래시 이스케이프(\n, \' 등) 정리
  text = text.replace(/\\n/g, '\n').replace(/\\'/g, "'");

  // 공백 여러 개 → 한 칸, 줄바꿈은 유지하되 앞뒤 공백 정리
  text = text.split('\n').map(function (line) {
    return line.replace(/[ \t]+/g, ' ').trim();
  }).join('\n');
  text = text.replace(/\n{3,}/g, '\n\n').trim();

  return text;
}


// ───────────────────────────────────────────────────────────
// 3. 질문과 관련된 항목 고르기 (키워드 점수 매기기)
// ───────────────────────────────────────────────────────────

// 한국어 조사 때문에 "지출결의서를"처럼 붙어서 검색이 빗나가는 문제를 처리하기 위한 목록.
// 낱말 끝에 이 조사들이 붙어 있으면 떼어내고 원형에 가깝게 만든다.
// (완벽한 형태소 분석기는 아니고, 흔한 조사만 잘라내는 간단한 규칙이다)
var KOREAN_PARTICLES_ = [
  '으로서', '로서', '으로써', '로써', '에서', '이라서', '라서', '에게',
  '까지', '부터', '보다', '이랑', '랑', '이나', '나', '만',
  '으로', '로', '에는', '에도', '에', '와', '과', '을', '를',
  '이', '가', '은', '는', '의', '도'
];

/**
 * 낱말 끝의 흔한 한국어 조사를 제거한다.
 * 예: '지출결의서를' -> '지출결의서', '거래처와' -> '거래처'
 * 원형 추정이 애매한 짧은 낱말은 건드리지 않는다(2글자 이하는 그대로 둠).
 */
function stripKoreanParticle_(word) {
  if (!word || word.length <= 2) return word;

  for (var i = 0; i < KOREAN_PARTICLES_.length; i++) {
    var p = KOREAN_PARTICLES_[i];
    if (word.length - p.length >= 2 && word.slice(-p.length) === p) {
      return word.slice(0, word.length - p.length);
    }
  }
  return word;
}

/**
 * 질문 문장에서 검색에 쓸 낱말들을 뽑아낸다.
 * - 공백/구두점 기준으로 나누고
 * - 2글자 미만은 버리고
 * - 조사를 떼어낸다
 */
function extractKeywords_(question) {
  var rawWords = question
    .replace(/[.,!?"'()\[\]{}~·]/g, ' ')
    .split(/\s+/)
    .filter(function (w) { return w.length >= 2; });

  var keywords = [];
  var seen = {};
  for (var i = 0; i < rawWords.length; i++) {
    var stripped = stripKoreanParticle_(rawWords[i]);
    if (stripped.length >= 2 && !seen[stripped]) {
      seen[stripped] = true;
      keywords.push(stripped);
    }
  }
  return keywords;
}

/**
 * 항목 하나(item)가 keywords와 얼마나 관련 있는지 점수를 매긴다.
 * - 본문에 낱말이 나오면 +1점 (여러 번 나오면 그만큼 더)
 * - 제목에 낱말이 나오면 가중치를 더 줘서 +5점 추가
 */
function scoreItem_(item, keywords) {
  var score = 0;
  var titleLower = (item.title || '').toLowerCase();
  var textLower = (item.text || '').toLowerCase();

  for (var i = 0; i < keywords.length; i++) {
    var kw = keywords[i].toLowerCase();
    if (!kw) continue;

    // 제목에 포함되면 가중치 부여
    if (titleLower.indexOf(kw) !== -1) {
      score += 5;
    }

    // 본문에서 몇 번 나오는지 센다
    var count = countOccurrences_(textLower, kw);
    score += count;
  }
  return score;
}

function countOccurrences_(haystack, needle) {
  if (!needle) return 0;
  var count = 0;
  var idx = 0;
  while (true) {
    idx = haystack.indexOf(needle, idx);
    if (idx === -1) break;
    count++;
    idx += needle.length;
  }
  return count;
}

/**
 * 질문(question)과 관련된 위키 항목들을 점수 순으로 골라 반환한다.
 * 관련 항목이 하나도 없으면 빈 배열을 반환한다.
 */
function findRelevantItems_(question) {
  var keywords = extractKeywords_(question);
  var items = getWikiItems_();

  var scored = items.map(function (item) {
    return { item: item, score: scoreItem_(item, keywords) };
  });

  scored = scored.filter(function (s) { return s.score > 0; });
  scored.sort(function (a, b) { return b.score - a.score; });

  var picked = scored.slice(0, MAX_RELEVANT_ITEMS);

  // 점수가 있는 항목이 MIN_RELEVANT_ITEMS보다 적어도, 있는 만큼만 준다
  // (억지로 관련 없는 항목까지 채우지 않는다 — 8번 요구사항: 없으면 없다고 답해야 하므로)
  return picked.map(function (s) { return s.item; });
}


// ───────────────────────────────────────────────────────────
// 4. Claude API 호출
// ───────────────────────────────────────────────────────────

/**
 * 관련 항목들을 Claude에게 보낼 "자료" 문자열로 조립한다.
 * 항목마다 MAX_CHARS_PER_ITEM 글자로 잘라서, 문서 이름과 항목 제목을 명시한다.
 */
function buildContextText_(items) {
  var parts = [];
  for (var i = 0; i < items.length; i++) {
    var it = items[i];
    var body = it.text.length > MAX_CHARS_PER_ITEM
      ? it.text.substring(0, MAX_CHARS_PER_ITEM) + ' …(이하 생략)'
      : it.text;

    parts.push(
      '[문서: ' + it.source + ' / 항목: ' + it.title + ']\n' + body
    );
  }
  return parts.join('\n\n---\n\n');
}

/**
 * 시스템 프롬프트. 여기서 "위키에 있는 내용만 답하라"는 규칙을 강하게 건다.
 */
function buildSystemPrompt_() {
  return [
    '당신은 사내 회계·세무 위키의 내용만 근거로 질문에 답하는 도우미입니다.',
    '',
    '규칙:',
    '1) 아래 [제공 자료]에 실제로 적혀 있는 내용만 근거로 답하십시오.',
    '2) 제공 자료로 답할 수 없는 질문이면, 답변 첫 줄에 정확히 "위키에 없는 내용입니다." 라고 쓰고,',
    '   이어서 회계팀 확인이 필요하다고 안내한 뒤 답변을 끝내십시오. 그 외 다른 내용을 덧붙이지 마십시오.',
    '3) 일반적인 회계·세무 지식이나 추측으로 자료의 빈 부분을 채우지 마십시오.',
    '   자료에 없는 금액, 기한, 법 조문을 만들어내지 마십시오.',
    '4) 자료로 답할 수 있는 경우, 답변은 반드시 아래 형식의 세 줄로만 작성하십시오(각 항목은 한 줄 또는 짧은 문단):',
    '   결론: (질문에 대한 직접적인 답)',
    '   근거: (제공 자료 중 어떤 내용에 근거했는지)',
    '   출처: (문서 이름과 항목 제목)',
    '5) 근거로 삼은 자료 본문에 "초안", "확인 필요", "미확정" 같은 표시가 있으면,',
    '   출처 줄 맨 뒤에 "(※확정 전 정보이니 참고만 하시고 회계팀에 다시 확인하십시오)" 라고 경고를 덧붙이십시오.'
  ].join('\n');
}

/**
 * Claude API를 호출해서 answer 텍스트를 반환한다.
 * 실패/거부 시에는 그 사유를 설명하는 문자열을 반환한다(예외를 던지지 않음 —
 * 이 함수를 그대로 최종 사용자 응답으로 써도 되게 하기 위함).
 */
function callClaude_(question, contextText) {
  var apiKey = PropertiesService.getScriptProperties().getProperty(API_KEY_PROPERTY_NAME);
  if (!apiKey) {
    // 12번 요구사항: 키가 없으면 무엇을 등록해야 하는지 알려주는 오류
    throw new Error(
      '스크립트 속성에 "' + API_KEY_PROPERTY_NAME + '" 값이 등록되어 있지 않습니다. ' +
      'Apps Script 편집기 > 프로젝트 설정(⚙) > 스크립트 속성에서 ' +
      '"' + API_KEY_PROPERTY_NAME + '" 이름으로 Claude API 키를 등록한 뒤 다시 시도하세요.'
    );
  }

  var userMessage =
    '[제공 자료]\n' + contextText + '\n\n' +
    '[질문]\n' + question;

  var payload = {
    model: CLAUDE_MODEL,
    max_tokens: CLAUDE_MAX_TOKENS,
    system: buildSystemPrompt_(),
    messages: [
      { role: 'user', content: userMessage }
    ],
    output_config: { effort: 'medium' }
  };

  var options = {
    method: 'post',
    contentType: 'application/json',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': CLAUDE_ANTHROPIC_VERSION
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true // 오류 응답이어도 예외를 던지지 않고 내용을 읽을 수 있게 함
  };

  var response = UrlFetchApp.fetch(CLAUDE_API_URL, options);
  var responseCode = response.getResponseCode();
  var responseText = response.getContentText();

  if (responseCode < 200 || responseCode >= 300) {
    throw new Error('Claude API 호출 실패 (코드 ' + responseCode + '): ' + responseText);
  }

  var data = JSON.parse(responseText);

  // 15번 요구사항: stop_reason이 refusal이면 처리되지 않았다는 안내
  if (data.stop_reason === 'refusal') {
    return '요청이 처리되지 않았습니다(모델이 답변을 거부했습니다). 질문을 조금 바꿔 다시 시도해 주세요.';
  }

  // 14번 요구사항: content[0].text로 바로 꺼내지 말고, type이 'text'인 조각만 골라 이어붙인다
  var textParts = [];
  var content = data.content || [];
  for (var i = 0; i < content.length; i++) {
    if (content[i].type === 'text' && typeof content[i].text === 'string') {
      textParts.push(content[i].text);
    }
  }

  return textParts.join('\n');
}


// ───────────────────────────────────────────────────────────
// 5. 최종 진입점 — 화면(HTML)이나 다른 코드에서 이 함수를 호출하면 된다
// ───────────────────────────────────────────────────────────

/**
 * 질문 하나를 받아서 최종 답변 문자열을 반환한다.
 * (google.script.run.askWiki(question) 형태로 index.html의 JS에서 호출 가능)
 */
function askWiki(question) {
  if (!question || !question.trim()) {
    return { answer: '질문을 입력해 주세요.', sources: [] };
  }

  var relevantItems = findRelevantItems_(question);

  // 8번 요구사항: 관련 항목이 하나도 없으면 API를 부르지 않는다
  if (relevantItems.length === 0) {
    return {
      answer: '위키에서 찾지 못했습니다. 질문과 관련된 내용이 위키 문서에 없는 것 같습니다. 회계팀에 직접 확인해 주세요.',
      sources: []
    };
  }

  var contextText = buildContextText_(relevantItems);
  var answer = callClaude_(question, contextText);

  // 답변 속 "출처: ..." 줄에서 실제로 언급된 항목 제목을 찾아,
  // 화면에서 클릭하면 해당 문서로 바로 이동할 수 있도록 key(DOCS 키)를 함께 내려준다.
  var sources = relevantItems
    .filter(function (it) { return answer.indexOf(it.title) !== -1; })
    .map(function (it) { return { title: it.title, key: it.key }; });

  return { answer: answer, sources: sources };
}


// ───────────────────────────────────────────────────────────
// 6. 테스트용 함수 — Apps Script 편집기에서 함수 선택 후 "실행"으로 직접 확인
// ───────────────────────────────────────────────────────────

/**
 * [테스트 1] 위키 읽기가 잘 되는지 확인한다.
 * 실행 후 로그(보기 > 로그, 또는 Ctrl+Enter)에서 항목 개수와 앞부분 미리보기를 확인하면 된다.
 */
function test_위키읽기확인() {
  // 캐시를 무시하고 새로 읽고 싶으면 아래 줄의 주석을 해제하세요.
  // _wikiItemsCache = null;

  var items = getWikiItems_();
  Logger.log('총 항목 개수: ' + items.length);

  var previewCount = Math.min(5, items.length);
  for (var i = 0; i < previewCount; i++) {
    var it = items[i];
    Logger.log(
      '--- [' + i + '] source=' + it.source + ' / title=' + it.title + ' ---\n' +
      it.text.substring(0, 200) + (it.text.length > 200 ? ' …' : '')
    );
  }

  if (items.length === 0) {
    Logger.log('경고: 항목을 하나도 찾지 못했습니다. WIKI_FILE_NAMES 설정과 index.html 구조를 확인하세요.');
  }
}

/**
 * [테스트 2] 질문 하나를 넣어서 실제로 답변이 어떻게 나오는지 확인한다.
 * 아래 question 값을 원하는 질문으로 바꿔서 실행해 보세요.
 * (실행 전에 스크립트 속성에 ANTHROPIC_API_KEY가 등록되어 있어야 합니다)
 */
function test_질문답변확인() {
  var question = '지출결의서를 작성할 때 주의할 점이 뭐야?';
  var answer = askWiki(question);
  Logger.log('[질문] ' + question);
  Logger.log('[답변]\n' + answer);
}

/**
 * [테스트 3] 관련 항목 찾기(점수 매기기)만 따로 확인하고 싶을 때 사용.
 * API를 호출하지 않으므로 비용 없이 검색 로직만 점검할 수 있다.
 */
function test_관련항목찾기확인() {
  var question = '지출결의서를 작성할 때 주의할 점이 뭐야?';
  var keywords = extractKeywords_(question);
  Logger.log('추출된 키워드: ' + JSON.stringify(keywords));

  var items = findRelevantItems_(question);
  Logger.log('선택된 관련 항목 수: ' + items.length);
  for (var i = 0; i < items.length; i++) {
    Logger.log(' - ' + items[i].source + ' / ' + items[i].title);
  }
}
