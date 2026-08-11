/**
 * 선수금/미수금 거래처 사전선별기 — Apps Script 백엔드
 *
 * 시트 구조 (같은 스프레드시트 안에 아래 3개 탭이 있어야 함):
 *   - 업로드    : ERP10 "거래처별계정잔액" 내보내기를 매달 3행부터 그대로 붙여넣는 탭.
 *                 1~2행은 헤더(원본 그대로 두 줄), A~P열 사용.
 *                 A:No B:거래처코드 C:거래처명 D:사업자번호 E:합계
 *                 F:원화외상매출금 G:미수금-거래처 H:미수금-직원
 *                 I:거래처구분 J:종사업장번호 K:대표자 L:업종명
 *                 M:휴폐업구분 N:금융기관명 O:계좌번호 P:예금주명
 *   - 제외마스터 : 한 번 등록하면 계속 남는 영구 목록. A:거래처코드 B:거래처명 C:사유 D:등록일
 *   - 이력      : "신규 거래처" 판정을 위한 내부용 스냅샷(사람이 직접 건드릴 필요 없음).
 *                 analyzeThisMonth()를 실행할 때마다 그 시점의 거래처코드 목록으로
 *                 덮어쓴다. 즉 "신규"는 정확히는 "바로 지난 실행 시점엔 없던 거래처"라는
 *                 뜻이라, 같은 달에 분석하기를 두 번 누르면 두 번째는 신규가 안 뜬다
 *                 (월 1회 사용하는 워크플로우 기준으로는 문제 없음).
 *
 * 배포 시 반드시 "액세스 권한: 키다리스튜디오(레진) 도메인 사용자만"로 설정할 것 —
 * 외부 공개 방지는 여기 코드가 아니라 배포 설정이 1차 방어선이다.
 */

const SHEET_UPLOAD = '업로드';
const SHEET_EXCLUDE = '제외마스터';
const SHEET_HISTORY = '이력';

const UPLOAD_FIRST_DATA_ROW = 3;
const COL = {
  NO: 1, CODE: 2, NAME: 3, BIZNO: 4, TOTAL: 5,
  AR_KRW: 6, AR_VENDOR: 7, AR_STAFF: 8,
  VENDOR_TYPE: 9, SUB_BIZNO: 10, CEO: 11, INDUSTRY: 12,
  CLOSED_STATUS: 13, BANK: 14, ACCOUNT: 15, HOLDER: 16
};
const NORMAL_STATUS = '정상';

function doGet() {
  return HtmlService.createHtmlOutputFromFile('index')
    .setTitle('선수금/미수금 거래처 사전선별기')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/** 이름으로 시트를 가져오고, 없으면(제외마스터/이력) 헤더만 있는 시트를 새로 만들어준다. */
function getOrCreateSheet_(name) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(name);
  if (sheet) return sheet;

  sheet = ss.insertSheet(name);
  if (name === SHEET_EXCLUDE) {
    sheet.getRange(1, 1, 1, 4).setValues([['거래처코드', '거래처명', '사유', '등록일']]);
    sheet.setFrozenRows(1);
  } else if (name === SHEET_HISTORY) {
    sheet.getRange(1, 1, 1, 2).setValues([['거래처코드', '최근분석일시']]);
    sheet.setFrozenRows(1);
    sheet.hideSheet();
  }
  return sheet;
}

function getUploadSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SHEET_UPLOAD);
  if (!sheet) {
    throw new Error('"' + SHEET_UPLOAD + '" 탭을 찾을 수 없습니다. 탭 이름을 확인해주세요.');
  }
  return sheet;
}

/**
 * 웹앱의 드래그앤드롭 업로드 — 브라우저(SheetJS)에서 엑셀을 읽어 만든 2차원 배열을
 * 그대로 "업로드" 탭에 덮어쓴다. 원본 파일의 1~2행 헤더 구조까지 그대로 옮겨오는 방식이라
 * ERP 내보내기 파일을 열어보지 않고 바로 끌어다 놓아도 된다. 탭이 없으면 새로 만든다.
 * 반영 직후 analyzeThisMonth()까지 실행해서 한 번의 드롭으로 3개 리스트가 바로 뜨게 한다.
 */
function importUploadRows(rows) {
  if (!rows || !rows.length) throw new Error('불러올 데이터가 없습니다.');

  const sheet = getOrCreateSheet_(SHEET_UPLOAD);
  const maxCols = rows.reduce(function (m, r) { return Math.max(m, r.length); }, 1);
  const padded = rows.map(function (r) {
    const row = r.slice(0, maxCols);
    while (row.length < maxCols) row.push('');
    return row;
  });

  sheet.clearContents();
  sheet.getRange(1, 1, padded.length, maxCols).setValues(padded);

  return analyzeThisMonth();
}

/** 업로드 탭 3행부터 끝까지 읽어서, 거래처코드가 있는 행만 레코드로 만든다. */
function readUploadRows_() {
  const sheet = getUploadSheet_();
  const lastRow = sheet.getLastRow();
  if (lastRow < UPLOAD_FIRST_DATA_ROW) return [];

  const numRows = lastRow - UPLOAD_FIRST_DATA_ROW + 1;
  const values = sheet.getRange(UPLOAD_FIRST_DATA_ROW, 1, numRows, COL.HOLDER).getValues();

  const records = [];
  values.forEach(function (row) {
    const code = String(row[COL.CODE - 1] || '').trim();
    if (!code) return; // 빈 행은 건너뜀
    records.push({
      code: code,
      name: String(row[COL.NAME - 1] || '').trim(),
      bizNo: String(row[COL.BIZNO - 1] || '').trim(),
      total: Number(row[COL.TOTAL - 1] || 0),
      arKrw: Number(row[COL.AR_KRW - 1] || 0),
      arVendor: Number(row[COL.AR_VENDOR - 1] || 0),
      arStaff: Number(row[COL.AR_STAFF - 1] || 0),
      ceo: String(row[COL.CEO - 1] || '').trim(),
      closedStatus: String(row[COL.CLOSED_STATUS - 1] || '').trim(),
      bank: String(row[COL.BANK - 1] || '').trim(),
      account: String(row[COL.ACCOUNT - 1] || '').trim(),
      holder: String(row[COL.HOLDER - 1] || '').trim()
    });
  });
  return records;
}

/** 제외마스터 탭 → { 거래처코드: 사유 } 맵. 같은 코드가 여러 번 있으면 마지막 값을 쓴다. */
function readExclusionMap_() {
  const sheet = getOrCreateSheet_(SHEET_EXCLUDE);
  const lastRow = sheet.getLastRow();
  const map = {};
  if (lastRow < 2) return map;

  const values = sheet.getRange(2, 1, lastRow - 1, 3).getValues();
  values.forEach(function (row) {
    const code = String(row[0] || '').trim();
    if (!code) return;
    map[code] = String(row[2] || '').trim();
  });
  return map;
}

/** 이력 탭 → 바로 지난 실행 시점의 거래처코드 Set. */
function readPrevCodeSet_() {
  const sheet = getOrCreateSheet_(SHEET_HISTORY);
  const lastRow = sheet.getLastRow();
  const set = {};
  if (lastRow < 2) return set;

  const values = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
  values.forEach(function (row) {
    const code = String(row[0] || '').trim();
    if (code) set[code] = true;
  });
  return set;
}

/** 이번 실행의 거래처코드 목록으로 이력 탭을 통째로 덮어쓴다(다음 실행의 "신규" 판정 기준이 됨). */
function writeHistorySnapshot_(codes) {
  const sheet = getOrCreateSheet_(SHEET_HISTORY);
  const lastRow = sheet.getLastRow();
  if (lastRow > 1) {
    sheet.getRange(2, 1, lastRow - 1, 2).clearContent();
  }
  if (codes.length === 0) return;

  const now = new Date();
  const rows = codes.map(function (code) { return [code, now]; });
  sheet.getRange(2, 1, rows.length, 2).setValues(rows);
}

/**
 * 메인 분석 함수 — 웹앱의 "이번달 분석하기" 버튼이 호출한다.
 * 반환값: { searchList, suspiciousList, autoExcludedList, generatedAt }
 * 각 리스트 항목: { code, name, total, ceo, closedStatus, isNew, reason? }
 */
function analyzeThisMonth() {
  const records = readUploadRows_();
  const exclusionMap = readExclusionMap_();
  const prevCodes = readPrevCodeSet_();

  const searchList = [];
  const suspiciousList = [];
  const autoExcludedList = [];

  records.forEach(function (r) {
    const isNew = !prevCodes[r.code];
    const base = {
      code: r.code, name: r.name, total: r.total,
      ceo: r.ceo, closedStatus: r.closedStatus, isNew: isNew
    };

    if (exclusionMap.hasOwnProperty(r.code)) {
      autoExcludedList.push(Object.assign({}, base, { reason: exclusionMap[r.code] }));
    } else if (r.closedStatus && r.closedStatus !== NORMAL_STATUS) {
      suspiciousList.push(base);
    } else {
      searchList.push(base);
    }
  });

  writeHistorySnapshot_(records.map(function (r) { return r.code; }));

  return {
    searchList: searchList,
    suspiciousList: suspiciousList,
    autoExcludedList: autoExcludedList,
    generatedAt: new Date().toISOString()
  };
}

/** "제외등록" 버튼 — 같은 코드가 이미 있으면 사유만 갈아끼운다(중복 행 방지). */
function registerExclusion(code, name, reason) {
  code = String(code || '').trim();
  reason = String(reason || '').trim();
  if (!code) throw new Error('거래처코드가 없습니다.');
  if (!reason) throw new Error('제외 사유를 입력해주세요.');

  const sheet = getOrCreateSheet_(SHEET_EXCLUDE);
  const lastRow = sheet.getLastRow();
  const now = new Date();

  if (lastRow >= 2) {
    const codes = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
    for (let i = 0; i < codes.length; i++) {
      if (String(codes[i][0] || '').trim() === code) {
        sheet.getRange(i + 2, 1, 1, 4).setValues([[code, name, reason, now]]);
        return { ok: true };
      }
    }
  }
  sheet.appendRow([code, name, reason, now]);
  return { ok: true };
}

/** "제외마스터 관리" 탭 목록 조회. */
function getExclusionList() {
  const sheet = getOrCreateSheet_(SHEET_EXCLUDE);
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];

  const values = sheet.getRange(2, 1, lastRow - 1, 4).getValues();
  return values
    .filter(function (row) { return String(row[0] || '').trim(); })
    .map(function (row) {
      return {
        code: String(row[0] || '').trim(),
        name: String(row[1] || '').trim(),
        reason: String(row[2] || '').trim(),
        registeredAt: row[3] ? new Date(row[3]).toISOString() : ''
      };
    });
}

/** "제외마스터 관리" 탭의 [삭제] 버튼 — 다음 분석부터 다시 검색대상에 포함된다. */
function deleteExclusion(code) {
  code = String(code || '').trim();
  if (!code) throw new Error('거래처코드가 없습니다.');

  const sheet = getOrCreateSheet_(SHEET_EXCLUDE);
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return { ok: true };

  const codes = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
  for (let i = codes.length - 1; i >= 0; i--) {
    if (String(codes[i][0] || '').trim() === code) {
      sheet.deleteRow(i + 2);
    }
  }
  return { ok: true };
}
