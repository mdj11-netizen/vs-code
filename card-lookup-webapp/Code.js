const OWNER_HEADER = '소유자';

function doGet() {
  return HtmlService.createTemplateFromFile('Index')
    .evaluate()
    .setTitle('법인카드 사용내역 조회')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

// 이 스크립트가 대상 구글시트에 바인딩되어 있어야 동작합니다.
// (해당 시트에서 확장 프로그램 > Apps Script 로 생성한 프로젝트일 것)
// 탭 이름과 무관하게 첫 번째 시트를 사용합니다.
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
  const ownerCol = headers.indexOf(OWNER_HEADER);
  if (ownerCol === -1) {
    throw new Error(`"${OWNER_HEADER}" 헤더를 찾을 수 없습니다. 시트 첫 행을 확인하세요.`);
  }
  return { headers, ownerCol };
}

// 자동완성용 소유자 목록
function getOwnerList() {
  const { ownerCol } = getHeaderInfo_();
  const sheet = getSheet_();
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];

  const values = sheet.getRange(2, ownerCol + 1, lastRow - 1, 1).getValues();
  const names = new Set();
  values.forEach(row => {
    const name = String(row[0] || '').trim();
    if (name) names.add(name);
  });
  return Array.from(names).sort((a, b) => a.localeCompare(b, 'ko'));
}

// 사원명(소유자)으로 거래내역 조회
function searchByOwner(query) {
  const q = String(query || '').trim();
  if (!q) return { headers: [], rows: [] };

  const { headers, ownerCol } = getHeaderInfo_();
  const sheet = getSheet_();
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return { headers, rows: [] };

  const data = sheet.getRange(2, 1, lastRow - 1, headers.length).getValues();
  const qLower = q.toLowerCase();

  const exact = [];
  const partial = [];
  data.forEach(row => {
    const owner = String(row[ownerCol] || '').trim();
    if (!owner) return;
    if (owner === q) {
      exact.push(row);
    } else if (owner.toLowerCase().includes(qLower)) {
      partial.push(row);
    }
  });

  // 완전히 일치하는 사원이 있으면 그 결과만, 없으면 부분일치 결과를 반환
  const matched = exact.length > 0 ? exact : partial;
  const rows = matched.map(row => row.map(formatCell_));
  return { headers, rows };
}

function formatCell_(value) {
  if (value instanceof Date) {
    return Utilities.formatDate(value, Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm');
  }
  return value;
}
