function doGet(e) {
  var page = (e && e.parameter && e.parameter.page) || 'index';

  if (page === 'qa') {
    return HtmlService.createHtmlOutputFromFile('챗봇')
      .setTitle('회계·세무 Wiki Q&A')
      .addMetaTag('viewport', 'width=device-width, initial-scale=1')
      .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
  }

  return HtmlService.createHtmlOutputFromFile('index')
    .setTitle('회계·세무 Wiki')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

// index.html의 챗봇 패널이 iframe 대신 이 함수를 호출해서
// 챗봇 화면(챗봇.html) 안의 <body> 내용만 문자열로 받아 그 자리에 삽입한다.
function getChatbotBodyHtml() {
  var raw = HtmlService.createHtmlOutputFromFile('챗봇').getContent();
  var styles = raw.match(/<style[^>]*>[\s\S]*?<\/style>/gi) || [];
  var bodyMatch = raw.match(/<body[^>]*>([\s\S]*)<\/body>/i);
  var body = bodyMatch ? bodyMatch[1] : raw;
  return styles.join('\n') + body;
}
