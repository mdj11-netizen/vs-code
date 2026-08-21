/**
 * ===== 부서별 담당자 확인하기 (담당 업무 안내 시스템 병합) =====
 *
 * 원래 별도 Apps Script 프로젝트("담당 업무 안내 시스템")였던 기능을 이 프로젝트 안으로
 * 그대로 옮겨온 것. iframe으로 그 웹앱을 띄우면 구글이 X-Frame-Options로 막아서(연결 거부),
 * 서버 로직(스프레드시트 읽기)만 이 프로젝트로 복사해 오고, 화면은 index.html의 모달 안에
 * google.script.run으로 데이터만 받아 그리는 방식으로 바꿨다.
 *
 * 조직도/업무분장표 스프레드시트 자체는 원래 프로젝트와 동일한 것을 그대로 읽는다.
 * 시트 구조가 바뀌면 아래 STAFF_* 설정값만 맞춰주면 된다.
 */

var STAFF_SPREADSHEET_ID = '1CjrdgzfioQ-ehmUVdQ-L2ZhT2d6CKMqvBkVIJMGT76E';
var STAFF_SHEET_NAME = '시트1';
var STAFF_WORK_SHEET_NAME = '시트2';

// 헤더(사업부문/본부/부/팀...)가 있는 실제 행 번호.
var STAFF_HEADER_ROW = 4;
var STAFF_CACHE_TTL_SECONDS = 21600; // 6시간. 시트를 바꾸면 staffRefreshCache()를 한 번 실행하세요.

var STAFF_REQUIRED_COLUMNS = ['사업부문', '본부', '부', '팀', '법인카드', '키다리 담당자', '레진 담당자', '비고'];
var STAFF_GUIDE_LINK_COLUMN = '안내문 링크';

// 업무분장표(STAFF_WORK_SHEET_NAME)에서 화면에 노출할 구분(A열)만 걸러낸다. 빈 배열이면 전체 노출.
var STAFF_WORK_CATEGORY_FILTER = ['퇴사자서류', '예술인고용보험'];

// 업무분장표는 1행에 법인명, 2행에 담당자/부재·대리 구분이 있는 2단 헤더라 컬럼 위치(0-based)를 그대로 쓴다.
var STAFF_WORK_DATA_START_ROW = 2;
var STAFF_WORK_COL_CATEGORY = 0; // A: 구분
var STAFF_WORK_COL_TASK = 1;     // B: 업무명
var STAFF_WORK_ENTITIES = [
  { key: '카다리스튜디오', col: 3 },
  { key: '레진KR', col: 5 },
  { key: '레진JP', col: 7 },
  { key: '레진US', col: 8 },
  { key: '델리툰', col: 9 }
];

var STAFF_PERSON_TITLES = {
  '유지수': '팀장',
  '고수희': '매니저',
  '김민정': '매니저',
  '박찬민': '매니저',
  '최은아': '매니저',
  '오민지': '매니저',
  '송선아': '매니저'
};

// 조직도/업무분장표에 나오더라도 화면에는 표시하지 않는 이름.
var STAFF_EXCLUDED_PEOPLE = ['남우영'];

var _staffSpreadsheetCache_ = {};
function staffGetSpreadsheet_(id) {
  if (!_staffSpreadsheetCache_[id]) {
    _staffSpreadsheetCache_[id] = SpreadsheetApp.openById(id);
  }
  return _staffSpreadsheetCache_[id];
}

function staffGetSheetAndColumnMap_() {
  var sheet = staffGetSpreadsheet_(STAFF_SPREADSHEET_ID).getSheetByName(STAFF_SHEET_NAME);
  if (!sheet) {
    throw new Error('시트를 찾을 수 없습니다: ' + STAFF_SHEET_NAME);
  }
  var header = sheet.getRange(STAFF_HEADER_ROW, 1, 1, sheet.getLastColumn()).getValues()[0];
  var map = {};
  header.forEach(function(name, idx) {
    var key = (name || '').toString().trim();
    if (key && !(key in map)) map[key] = idx;
  });
  STAFF_REQUIRED_COLUMNS.forEach(function(name) {
    if (!(name in map)) {
      throw new Error('시트 헤더에서 "' + name + '" 컬럼을 찾을 수 없습니다. 헤더 이름을 확인하세요.');
    }
  });
  return { sheet: sheet, col: map };
}

// "김민정(B) / 오민지"처럼 슬래시로 묶인 셀을 개별 이름 배열로 쪼갠다. "-"는 담당자 없음.
function staffSplitNames_(str) {
  var text = (str || '').toString().trim();
  if (!text || text === '-') return [];
  return text.split('/')
    .map(function(s) { return s.trim().replace(/\s*\([^)]*\)\s*$/, ''); })
    .filter(function(s) { return s && s !== '-' && STAFF_EXCLUDED_PEOPLE.indexOf(s) === -1; });
}

// 병합 셀 때문에 빈 칸으로 읽히는 사업부문/본부/부/팀을 위 값으로 채워 내려가며 조직도 행을 만든다.
function staffBuildRows_() {
  var ctx = staffGetSheetAndColumnMap_();
  var data = ctx.sheet.getDataRange().getValues();
  var col = ctx.col;
  var hasGuideLink = (STAFF_GUIDE_LINK_COLUMN in col);

  var rows = [];
  var lastDivision = '', lastHq = '', lastDept = '', lastTeam = '';

  for (var r = STAFF_HEADER_ROW; r < data.length; r++) {
    var row = data[r];
    var divisionRaw = (row[col['사업부문']] || '').toString().trim();
    var hqRaw = (row[col['본부']] || '').toString().trim();
    var deptRaw = (row[col['부']] || '').toString().trim();
    var teamRaw = (row[col['팀']] || '').toString().trim();

    var division;
    if (divisionRaw) { division = divisionRaw; lastHq = ''; lastDept = ''; lastTeam = ''; }
    else division = lastDivision;
    lastDivision = division;

    var hq;
    if (hqRaw) { hq = hqRaw; lastDept = ''; lastTeam = ''; }
    else hq = lastHq;
    lastHq = hq;

    var dept;
    if (deptRaw) { dept = deptRaw; lastTeam = ''; }
    else dept = lastDept;
    lastDept = dept;

    var team = teamRaw || lastTeam;
    lastTeam = team;

    if (!division && !hq && !dept && !team) continue;

    var cardManager = (row[col['법인카드']] || '').toString().trim();
    var kidari = (row[col['키다리 담당자']] || '').toString().trim();
    var lezhin = (row[col['레진 담당자']] || '').toString().trim();
    var note = (row[col['비고']] || '').toString().trim();
    var guideLink = hasGuideLink ? (row[col[STAFF_GUIDE_LINK_COLUMN]] || '').toString().trim() : '';

    var label = team || dept || hq || division;
    var breadcrumbParts = [];
    [division, hq, dept, team].forEach(function(v) {
      if (v && v !== breadcrumbParts[breadcrumbParts.length - 1]) breadcrumbParts.push(v);
    });

    rows.push({
      division: division, hq: hq, dept: dept, team: team,
      label: label, breadcrumb: breadcrumbParts.join(' > '),
      cardManager: cardManager, kidari: kidari, lezhin: lezhin,
      note: note, guideLink: guideLink
    });
  }

  return rows;
}

// 업무분장표를 읽어 업무(구분/업무명)마다 법인별 담당자를 뽑아낸다.
function staffBuildWorkAssignments_() {
  var sheet = staffGetSpreadsheet_(STAFF_SPREADSHEET_ID).getSheetByName(STAFF_WORK_SHEET_NAME);
  if (!sheet) {
    throw new Error('업무분장표 시트를 찾을 수 없습니다: ' + STAFF_WORK_SHEET_NAME);
  }
  var data = sheet.getDataRange().getValues();

  var list = [];
  var lastCategory = '';

  for (var r = STAFF_WORK_DATA_START_ROW; r < data.length; r++) {
    var row = data[r];
    var categoryRaw = (row[STAFF_WORK_COL_CATEGORY] || '').toString().trim();
    var category = categoryRaw || lastCategory;
    lastCategory = category;

    var task = (row[STAFF_WORK_COL_TASK] || '').toString().trim();
    if (!task) continue;

    if (STAFF_WORK_CATEGORY_FILTER.length && STAFF_WORK_CATEGORY_FILTER.indexOf(category) === -1) continue;

    var assignees = {};
    STAFF_WORK_ENTITIES.forEach(function(entity) {
      var names = staffSplitNames_(row[entity.col]);
      if (names.length) assignees[entity.key] = names;
    });

    list.push({ category: category, task: task, assignees: assignees });
  }

  return list;
}

// 조직도(팀 담당자)와 업무분장표(업무별·법인별 담당자)를 합쳐 사람별로 정리한다.
function staffBuildPeople_(orgRows, workAssignments) {
  var people = {};

  function ensure(name) {
    if (!people[name]) people[name] = { tasks: {}, cardTeams: {}, kidariTeams: {}, lezhinTeams: {} };
    return people[name];
  }

  orgRows.forEach(function(r) {
    staffSplitNames_(r.cardManager).forEach(function(name) { ensure(name).cardTeams[r.label] = true; });
    staffSplitNames_(r.kidari).forEach(function(name) { ensure(name).kidariTeams[r.label] = true; });
    staffSplitNames_(r.lezhin).forEach(function(name) { ensure(name).lezhinTeams[r.label] = true; });
  });

  workAssignments.forEach(function(w) {
    Object.keys(w.assignees).forEach(function(entityKey) {
      w.assignees[entityKey].forEach(function(name) {
        var p = ensure(name);
        if (!p.tasks[w.category]) p.tasks[w.category] = {};
        if (!p.tasks[w.category][w.task]) p.tasks[w.category][w.task] = {};
        p.tasks[w.category][w.task][entityKey] = true;
      });
    });
  });

  function toSortedArray(obj) {
    var arr = Object.keys(obj);
    arr.sort(function(a, b) { return a.localeCompare(b, 'ko'); });
    return arr;
  }

  var list = Object.keys(people).map(function(name) {
    var p = people[name];
    var taskCount = 0;
    var categories = toSortedArray(p.tasks);
    var taskGroups = categories.map(function(category) {
      var taskNames = toSortedArray(p.tasks[category]);
      var tasks = taskNames.map(function(taskName) {
        taskCount++;
        return { task: taskName, entities: toSortedArray(p.tasks[category][taskName]) };
      });
      return { category: category, tasks: tasks };
    });

    return {
      name: name,
      title: STAFF_PERSON_TITLES[name] || '',
      taskGroups: taskGroups,
      taskCount: taskCount,
      cardTeams: toSortedArray(p.cardTeams),
      kidariTeams: toSortedArray(p.kidariTeams),
      lezhinTeams: toSortedArray(p.lezhinTeams)
    };
  });

  list.sort(function(a, b) {
    var totalA = a.taskCount + a.cardTeams.length + a.kidariTeams.length + a.lezhinTeams.length;
    var totalB = b.taskCount + b.cardTeams.length + b.kidariTeams.length + b.lezhinTeams.length;
    if (totalB !== totalA) return totalB - totalA;
    return a.name.localeCompare(b.name, 'ko');
  });

  return list;
}

/**
 * 화면(index.html의 모달)이 열릴 때 딱 한 번 호출된다. 이후 검색은 브라우저에서 받아둔
 * 데이터로 즉시 처리하고 서버를 다시 부르지 않는다.
 */
function getStaffDirectoryData() {
  var CACHE_KEY = 'staffDirectoryData_v1';
  var cache = CacheService.getScriptCache();
  var cached = cache.get(CACHE_KEY);
  if (cached) return JSON.parse(cached);

  var rows = staffBuildRows_();

  var workAssignments = [];
  var workError = '';
  try {
    workAssignments = staffBuildWorkAssignments_();
  } catch (e) {
    workError = e.message;
  }

  var people = staffBuildPeople_(rows, workAssignments);
  var payload = { rows: rows, people: people, tasks: workAssignments, workError: workError };
  cache.put(CACHE_KEY, JSON.stringify(payload), STAFF_CACHE_TTL_SECONDS);
  return payload;
}

/**
 * 조직도/업무분장표 스프레드시트를 수정한 뒤 Apps Script 편집기에서 이 함수를 한 번 실행하면
 * 캐시가 즉시 갱신된다. 안 하면 최대 6시간 뒤에 자동 반영된다.
 */
function staffRefreshCache() {
  CacheService.getScriptCache().remove('staffDirectoryData_v1');
  getStaffDirectoryData();
}

// index.html의 "부서별 담당자 확인하기" 모달이 이 함수를 호출해서
// 직원안내.html 안의 <style>+<body> 내용만 문자열로 받아 그 자리에 삽입한다.
function getStaffDirectoryBodyHtml() {
  var raw = HtmlService.createHtmlOutputFromFile('직원안내').getContent();
  var styles = raw.match(/<style[^>]*>[\s\S]*?<\/style>/gi) || [];
  var bodyMatch = raw.match(/<body[^>]*>([\s\S]*)<\/body>/i);
  var body = bodyMatch ? bodyMatch[1] : raw;
  return styles.join('\n') + body;
}
