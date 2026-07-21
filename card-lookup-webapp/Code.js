const OWNER_HEADER = '소유자';
const USER_HEADER = '사용자';
const DEPT_HEADER = '부서명';
const DEPT_FALLBACK_HEADER = '관리부서';
const CARD_NUMBER_HEADER = '카드번호';
const CARD_NAME_HEADER = '카드명';
const DATE_HEADER = '승인일';
const MERCHANT_HEADER = '가맹점';
const AMOUNT_HEADER = '승인액';
const STATUS_HEADER = '전표결재상태';
const MEMO_HEADER = '적요';

const MEAL_LIMIT = 12000; // 식대 한도(원). 이 금액을 초과하는 식대 항목을 화면에서 강조 표시함

const OWNER_CACHE_KEY = 'ownerCache_v3';
const OWNER_CACHE_TTL_SEC = 1800; // 30분
const ALL_ROWS_LIMIT = 500;

function doGet() {
  return HtmlService.createTemplateFromFile('Index')
    .evaluate()
    .setTitle('법인카드 사용내역 조회')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

// 이 스크립트가 대상 구글시트에 바인딩되어 있어야 동작합니다.
// (해당 시트에서 확장 프로그램 > Apps Script 로 생성한 프로젝트일 것)
function getSheet_() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheets()[0];
  if (!sheet) {
    throw new Error('스프레드시트에 시트가 없습니다.');
  }
  return sheet;
}

function getHeaderInfo_() {
  const sheet = getSheet_();
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const idx = {};
  [
    OWNER_HEADER, USER_HEADER, DEPT_HEADER, DEPT_FALLBACK_HEADER,
    CARD_NUMBER_HEADER, CARD_NAME_HEADER, DATE_HEADER, MERCHANT_HEADER,
    AMOUNT_HEADER, STATUS_HEADER, MEMO_HEADER
  ].forEach(h => { idx[h] = headers.indexOf(h); });

  if (idx[OWNER_HEADER] === -1) {
    throw new Error(`"${OWNER_HEADER}" 헤더를 찾을 수 없습니다. 시트 첫 행을 확인하세요.`);
  }
  return idx;
}

function val_(row, idx, header) {
  const i = idx[header];
  return i === -1 || i == null ? '' : row[i];
}

// 소유자 열만 캐싱해서 자동완성 조회 시 전체 시트를 다시 읽지 않도록 한다.
function getOwnerColumnCached_() {
  const cache = CacheService.getScriptCache();
  const cached = cache.get(OWNER_CACHE_KEY);
  if (cached) return JSON.parse(cached);

  const idx = getHeaderInfo_();
  const sheet = getSheet_();
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return { owners: [] };

  const numRows = lastRow - 1;
  const ownerVals = sheet.getRange(2, idx[OWNER_HEADER] + 1, numRows, 1).getValues();
  const owners = ownerVals.map(r => String(r[0] || '').trim());

  const payload = { owners };
  try {
    cache.put(OWNER_CACHE_KEY, JSON.stringify(payload), OWNER_CACHE_TTL_SEC);
  } catch (e) {
    // 캐시 용량 초과 등의 이유로 저장 실패해도 조회 자체는 계속 진행
  }
  return payload;
}

// 자동완성용 소유자 목록
function getOwnerList() {
  const { owners } = getOwnerColumnCached_();
  return Array.from(new Set(owners.filter(Boolean))).sort((a, b) => a.localeCompare(b, 'ko'));
}

// 사원명(소유자)으로 거래내역 조회. 이름을 입력하지 않으면 최근 내역을 반환한다.
function searchByOwner(query) {
  const q = String(query || '').trim();
  const idx = getHeaderInfo_();

  if (!q) {
    const all = fetchAllRows_(idx);
    return { rows: all.rows, truncated: all.truncated, totalCount: all.totalCount };
  }

  const { owners } = getOwnerColumnCached_();
  const qLower = q.toLowerCase();

  const exactRows = [];
  const partialRows = [];
  owners.forEach((owner, i) => {
    if (!owner) return;
    if (owner === q) exactRows.push(i + 2);
    else if (owner.toLowerCase().includes(qLower)) partialRows.push(i + 2);
  });

  // 완전히 일치하는 사원이 있으면 그 결과만, 없으면 부분일치 결과를 반환
  const matchedRowNumbers = exactRows.length > 0 ? exactRows : partialRows;
  if (!matchedRowNumbers.length) return { rows: [] };

  return { rows: fetchRows_(matchedRowNumbers, idx) };
}

// 검색어가 없을 때: 전체를 한 번에 보내면 응답이 커져 실패할 수 있으므로
// 시트 하단(최근) N건만 우선 반환하고, 잘렸는지 여부와 전체 건수를 함께 알려준다.
function fetchAllRows_(idx) {
  const sheet = getSheet_();
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return { rows: [], truncated: false, totalCount: 0 };

  const totalCount = lastRow - 1;
  const truncated = totalCount > ALL_ROWS_LIMIT;
  const startRow = truncated ? lastRow - ALL_ROWS_LIMIT + 1 : 2;
  const numRows = lastRow - startRow + 1;
  const numCols = sheet.getLastColumn();

  const rawRows = sheet.getRange(startRow, 1, numRows, numCols).getValues();
  return { rows: rawRows.map(row => toDisplayRow_(row, idx)), truncated, totalCount };
}

// 일치한 행 번호만 모아 필요한 부분만 읽어온다 (연속된 행은 하나의 range로 묶어 호출 횟수 최소화)
function fetchRows_(rowNumbers, idx) {
  const sheet = getSheet_();
  const numCols = sheet.getLastColumn();
  const rows = [];
  groupConsecutive_(rowNumbers).forEach(([start, end]) => {
    sheet.getRange(start, 1, end - start + 1, numCols).getValues().forEach(row => {
      rows.push(toDisplayRow_(row, idx));
    });
  });
  return rows;
}

function groupConsecutive_(rowNumbers) {
  const sorted = rowNumbers.slice().sort((a, b) => a - b);
  const groups = [];
  let start = sorted[0];
  let prev = sorted[0];
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] === prev + 1) {
      prev = sorted[i];
      continue;
    }
    groups.push([start, prev]);
    start = sorted[i];
    prev = sorted[i];
  }
  groups.push([start, prev]);
  return groups;
}

// 시트 원본 행(57열 전체) -> 화면에 필요한 값만 담은 압축 객체로 변환.
// 필요한 값만 골라 보내서 응답 크기를 줄이고, 카드번호는 마스킹해서 전달한다.
function toDisplayRow_(row, idx) {
  const owner = String(val_(row, idx, OWNER_HEADER) || '').trim();
  const user = String(val_(row, idx, USER_HEADER) || '').trim();
  const memo = String(val_(row, idx, MEMO_HEADER) || '');
  const amount = toAmountNumber_(val_(row, idx, AMOUNT_HEADER));
  const dept = val_(row, idx, DEPT_HEADER) || val_(row, idx, DEPT_FALLBACK_HEADER) || '';

  return {
    name: user || owner || '',
    dept: String(dept || ''),
    cardLast4: maskLast4_(val_(row, idx, CARD_NUMBER_HEADER)),
    cardName: String(val_(row, idx, CARD_NAME_HEADER) || ''),
    date: formatDateOnly_(val_(row, idx, DATE_HEADER)),
    merchant: String(val_(row, idx, MERCHANT_HEADER) || ''),
    amount: amount,
    status: String(val_(row, idx, STATUS_HEADER) || ''),
    match: !!(user && owner && user === owner),
    overLimit: /식대/.test(memo) && amount > MEAL_LIMIT
  };
}

function maskLast4_(cardNumber) {
  const digits = String(cardNumber || '').replace(/\D/g, '');
  return digits ? digits.slice(-4) : '';
}

function toAmountNumber_(raw) {
  if (raw instanceof Date) return 0;
  return Number(String(raw == null ? 0 : raw).replace(/[^0-9.-]/g, '')) || 0;
}

function formatDateOnly_(value) {
  if (!(value instanceof Date)) return String(value || '');
  return Utilities.formatDate(value, Session.getScriptTimeZone(), 'yyyy-MM-dd');
}
