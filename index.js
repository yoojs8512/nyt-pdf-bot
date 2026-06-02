const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const FormData = require('form-data');
const express = require('express');

const token = process.env.TELEGRAM_BOT_TOKEN;
const openaiApiKey = process.env.OPENAI_API_KEY;
const targetChannelId = '@newsnewsitit';

if (!token || !openaiApiKey) {
  console.error('환경 변수가 설정되지 않았습니다.');
  process.exit(1);
}

const bot = new TelegramBot(token, { polling: true });

const app = express();
const port = process.env.PORT || 3000;
app.get('/', (req, res) => res.send('NYT PDF Bot is running on Railway!'));
app.listen(port, () => console.log('Web server listening on port ' + port));

console.log('Bot is running...');

bot.on('document', async (msg) => {
  const chatId = msg.chat.id;
  const fileId = msg.document.file_id;
  const fileName = msg.document.file_name || 'NYT_번역.pdf';

  if (!fileName.toLowerCase().endsWith('.pdf')) {
    bot.sendMessage(chatId, 'PDF 파일만 지원합니다.');
    return;
  }

  bot.sendMessage(chatId, '📥 수신 완료! 번역 중입니다... (수 분 소요될 수 있습니다.)');

  try {
    // 1. 파일 다운로드
    const fileLink = await bot.getFileLink(fileId);
    const response = await axios({ method: 'GET', url: fileLink, responseType: 'stream' });
    const tempFilePath = path.join(__dirname, fileName);
    const writer = fs.createWriteStream(tempFilePath);
    response.data.pipe(writer);
    await new Promise((resolve, reject) => {
      writer.on('finish', resolve);
      writer.on('error', reject);
    });

    // 2. OpenAI에 파일 업로드
    const form = new FormData();
    form.append('file', fs.createReadStream(tempFilePath));
    form.append('purpose', 'user_data');
    const uploadRes = await axios.post('https://api.openai.com/v1/files', form, {
      headers: {
        ...form.getHeaders(),
        'Authorization': 'Bearer ' + openaiApiKey
      }
    });
    const uploadData = uploadRes.data;
    fs.unlinkSync(tempFilePath);

    // 3. 번역 요청
    const responseRes = await axios.post('https://api.openai.com/v1/responses', {
      model: 'gpt-4o',
      instructions: '당신은 언어 변환 전문 시스템입니다. 입력된 영어 텍스트를 한국어로 변환하는 것이 유일한 임무입니다.',
      input: [{
        role: 'user',
        content: [
          { type: 'input_file', file_id: uploadData.id },
          { type: 'input_text', text: '위 문서는 뉴욕타임스 뉴스레터 PDF입니다. 아래 규칙에 따라 한국어로 번역하십시오.\n1. 뉴스 본문 내용만 번역하십시오.\n2. "광고", "AD", 페이지 번호, 타임스탬프(예: 2:08, 6분 전), 저작권 표시, 구독 유도 문구, 사진 크레딧(예: Photo by..., for The New York Times)은 모두 제외하십시오.\n3. 원문의 단락 구분과 줄바꿈을 반드시 그대로 유지하십시오.\n4. 제목과 소제목은 <b>제목</b> 형식으로 HTML 볼드 태그를 사용하십시오.\n5. 그 외 마크다운 기호(**, # 등)는 사용하지 마십시오.\n6. 맺음말이나 부가 설명 없이 번역된 본문만 출력하십시오.' }
        ]
      }]
    }, {
      headers: {
        'Authorization': 'Bearer ' + openaiApiKey,
        'Content-Type': 'application/json'
      },
      timeout: 0
    });

    const responseData = responseRes.data;

    // 4. OpenAI 파일 삭제
    axios.delete('https://api.openai.com/v1/files/' + uploadData.id, {
      headers: { 'Authorization': 'Bearer ' + openaiApiKey }
    }).catch(e => console.error('파일 삭제 실패:', e.message));

    // 5. 결과 추출
    const output = responseData.output && responseData.output.find(item => item.type === 'message');
    if (!output || !output.content || !output.content[0]) {
      throw new Error('번역 결과가 없습니다. 상태: ' + responseData.status);
    }

    const translation = output.content[0].text;

    // 6. 채널에 전송 (3800자 청크, HTML 파싱 모드)
    const fullMessage = '<b>' + fileName.replace('.pdf', '') + '</b>\n\n' + translation;
    const chunkSize = 3800;
    for (let i = 0; i < fullMessage.length; i += chunkSize) {
      await bot.sendMessage(targetChannelId, fullMessage.substring(i, i + chunkSize), { parse_mode: 'HTML' });
      await new Promise(r => setTimeout(r, 500));
    }

    // 7. 완료 알림
    await bot.sendMessage(chatId, '✅ 번역 완료! 채널에 게시되었습니다.');

  } catch (error) {
    console.error(error);
    const errorMsg = error.response ? JSON.stringify(error.response.data) : error.message;
    bot.sendMessage(chatId, '❌ 오류: ' + errorMsg);
  }
});
